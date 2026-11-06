use std::env;
use std::ffi::CString;
use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use nix::pty::{forkpty, ForkptyResult, Winsize};
use nix::sys::signal::Signal;
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};

// ───── Protocol commands ─────

const CMD_STATE: u8 = 0x02;
const CMD_DATA_OUT: u8 = 0x03;
const CMD_DATA_IN: u8 = 0x04;
const CMD_RESIZE: u8 = 0x05;
const CMD_DUMP_REQ: u8 = 0x06;
const CMD_DUMP_RESP: u8 = 0x07;
const CMD_EXIT: u8 = 0x08;
const CMD_KILL: u8 = 0x09;
const CMD_PING: u8 = 0x0A;
const CMD_PONG: u8 = 0x0B;
// Controller lease. A server that speaks these announces itself before it can
// drive the PTY; one that does not is treated as a legacy client and promoted
// on arrival, which is how the old unconditional-eviction behaviour is kept.
const CMD_ACQUIRE: u8 = 0x0C;
const CMD_ACQUIRED: u8 = 0x0D;
const CMD_DENIED: u8 = 0x0E;
const CMD_EVICTED: u8 = 0x0F;
// Offset-addressed replay. DUMP_REQ still returns the whole ring for servers
// that predate this; DUMP_SINCE lets a server that already holds a checkpoint
// ask only for what came after it.
const CMD_DUMP_SINCE: u8 = 0x10;
const CMD_REPLAY: u8 = 0x11;
// The stream skipped [from, to): the client fell so far behind that the journal
// no longer holds those bytes. payload: [u64 from][u64 to]. Servers that do not
// know it ignore it (unknown frames are dropped), exactly as they would never
// have received the bytes anyway.
const CMD_GAP: u8 = 0x12;

/// Capabilities announced in STATE. A server checks these instead of guessing.
///  journal  — output is kept in an on-disk journal and streamed by cursor:
///             a slow server never stalls the PTY, and DATA_OUT never duplicates
///             what DUMP_*/REPLAY already returned.
///  gap      — CMD_GAP frames may arrive.
const CAPS: &str = r#"["journal","gap"]"#;

/// Bytes queued for the client before the streamer stops pulling from the
/// journal. The PTY keeps draining into the journal regardless.
const OUT_HIGH_WATER: usize = 256 * 1024;
/// One DATA_OUT frame carries at most this much.
const STREAM_CHUNK: usize = 64 * 1024;
/// PTY bytes read per loop turn before input and control frames get a turn.
const PTY_READ_BUDGET: usize = 256 * 1024;
/// Input waiting for the PTY beyond this is dropped (the child is not reading).
const MAX_PENDING_INPUT: usize = 4 * 1024 * 1024;
/// A full DUMP_REQ reply is capped to the newest this-many bytes, as before the
/// journal grew past the old 1MB ring.
const DUMP_REQ_MAX: u64 = 1 << 20;
/// After promotion, start streaming anyway if the server never asks for a dump.
const STREAM_START_GRACE: Duration = Duration::from_millis(2000);

/// How long a freshly accepted connection may stay unclaimed before we assume
/// it is a legacy server and promote it.
const LEASE_CLAIM_TIMEOUT: Duration = Duration::from_millis(1500);

// ───── Lexical anchors ─────
//
// The ring truncates at arbitrary bytes. When the server asks for a range that
// fell out (gap), the surviving tail can begin mid-UTF-8 or mid-escape — an
// OSC payload cut open swallows everything until a terminator and the damage
// spreads across rows. A suffix scan cannot fix this: bytes inside an OSC look
// like plaintext, and only something that watched the stream from byte 0 knows
// the lexer state. The holder is that something. It tracks a small UTF-8 +
// ECMA-48 lexer and records "ground" offsets on a coarse grid; gap replies
// start at the first ground offset still inside the ring, and if none exists
// the tail is withheld rather than served as a fake continuation.

#[derive(Clone, Copy, PartialEq)]
enum LexState {
    Ground,
    Esc,
    EscInter,
    Csi,
    StringBody,
    StringEsc,
    Utf8(u8),
}

const ANCHOR_GRAIN: u64 = 4096;
const ANCHOR_CAP: usize = 512; // 512 × 4KB = 2MB of coverage, double the ring

struct AnchorTracker {
    state: LexState,
    anchors: std::collections::VecDeque<u64>,
    last_anchor: u64,
}

impl AnchorTracker {
    fn new() -> Self {
        let mut anchors = std::collections::VecDeque::new();
        anchors.push_back(0); // byte 0 is ground by definition
        AnchorTracker { state: LexState::Ground, anchors, last_anchor: 0 }
    }

    fn step(state: LexState, b: u8) -> LexState {
        use LexState::*;
        match state {
            Utf8(n) => {
                if (0x80..=0xBF).contains(&b) {
                    if n <= 1 { Ground } else { Utf8(n - 1) }
                } else {
                    // Broken continuation: reprocess this byte from ground.
                    Self::step(Ground, b)
                }
            }
            Ground => match b {
                0x1b => Esc,
                0xC2..=0xDF => Utf8(1),
                0xE0..=0xEF => Utf8(2),
                0xF0..=0xF4 => Utf8(3),
                _ => Ground, // C0, ASCII, stray continuation — all self-contained
            },
            Esc => match b {
                b'[' => Csi,
                b']' | b'P' | b'X' | b'^' | b'_' => StringBody, // OSC/DCS/SOS/PM/APC
                0x20..=0x2F => EscInter,
                _ => Ground, // two-byte escape (ESC c, ESC 7, …)
            },
            EscInter => match b {
                0x20..=0x2F => EscInter,
                _ => Ground, // final byte of e.g. ESC ( B
            },
            Csi => match b {
                0x40..=0x7E => Ground, // final byte
                0x1b => Esc,           // aborted sequence
                _ => Csi,              // params / intermediates
            },
            StringBody => match b {
                0x07 => Ground, // BEL terminator (xterm OSC)
                0x1b => StringEsc,
                _ => StringBody,
            },
            StringEsc => match b {
                b'\\' => Ground,     // ST
                _ => StringBody,       // ESC that wasn't ST — still inside the string
            },
        }
    }

    /// Feed bytes that begin at absolute stream offset `start`.
    fn feed(&mut self, data: &[u8], start: u64) {
        for (i, &b) in data.iter().enumerate() {
            self.state = Self::step(self.state, b);
            if self.state == LexState::Ground {
                let boundary = start + i as u64 + 1;
                if boundary - self.last_anchor >= ANCHOR_GRAIN {
                    if self.anchors.len() >= ANCHOR_CAP {
                        self.anchors.pop_front();
                    }
                    self.anchors.push_back(boundary);
                    self.last_anchor = boundary;
                }
            }
        }
    }

    fn prune_below(&mut self, base: u64) {
        while let Some(&front) = self.anchors.front() {
            if front >= base { break; }
            self.anchors.pop_front();
        }
    }

    /// First ground offset at or after `base`, if any survives.
    fn first_at_or_after(&self, base: u64) -> Option<u64> {
        self.anchors.iter().find(|&&a| a >= base).copied()
    }
}

// ───── Ring buffer / journal ─────
//
// The last `cap` bytes of the PTY stream, addressed by absolute offset. The
// memory backend is the original 1MB ring (tests, --journal-size 0). The file
// backend keeps the bytes in a file under the runtime dir: page cache holds the
// hot tail and the kernel can drop clean pages under pressure without swapping,
// so a 16MB journal per session costs disk, not RAM.

enum Backend {
    Mem(Vec<u8>),
    File(fs::File),
}

struct Ring {
    backend: Backend,
    cap: usize,
    len: usize,
    /// Total bytes ever pushed. The ring holds the last `len` of them, so the
    /// first byte still available sits at `written - len`.
    written: u64,
}

impl Ring {
    fn new(capacity: usize) -> Self {
        Ring { backend: Backend::Mem(vec![0u8; capacity]), cap: capacity, len: 0, written: 0 }
    }

    fn file(path: &std::path::Path, capacity: usize) -> io::Result<Self> {
        let f = fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(path)?;
        Ok(Ring { backend: Backend::File(f), cap: capacity, len: 0, written: 0 })
    }

    fn write_at(&mut self, pos: usize, data: &[u8]) {
        match &mut self.backend {
            Backend::Mem(buf) => buf[pos..pos + data.len()].copy_from_slice(data),
            Backend::File(f) => {
                use std::os::unix::fs::FileExt;
                let _ = f.write_all_at(data, pos as u64);
            }
        }
    }

    fn read_at(&self, pos: usize, out: &mut [u8]) {
        match &self.backend {
            Backend::Mem(buf) => out.copy_from_slice(&buf[pos..pos + out.len()]),
            Backend::File(f) => {
                use std::os::unix::fs::FileExt;
                let _ = f.read_exact_at(out, pos as u64);
            }
        }
    }

    fn push(&mut self, data: &[u8]) {
        let cap = self.cap;
        let data = if data.len() > cap {
            self.written += (data.len() - cap) as u64;
            &data[data.len() - cap..]
        } else { data };
        let wp = (self.written % cap as u64) as usize;
        let first = (cap - wp).min(data.len());
        self.write_at(wp, &data[..first]);
        if first < data.len() { self.write_at(0, &data[first..]); }
        self.written += data.len() as u64;
        self.len = (self.len + data.len()).min(cap);
    }

    /// Absolute offset of the oldest byte still in the ring.
    fn base_offset(&self) -> u64 { self.written - self.len as u64 }

    /// Up to `max` bytes starting at absolute `offset` (which must be within
    /// [base, written]).
    fn read_range(&self, offset: u64, max: usize) -> Vec<u8> {
        let base = self.base_offset();
        let offset = offset.max(base);
        if offset >= self.written { return Vec::new(); }
        let n = ((self.written - offset) as usize).min(max);
        let mut out = vec![0u8; n];
        let cap = self.cap;
        let rp = (offset % cap as u64) as usize;
        let first = (cap - rp).min(n);
        self.read_at(rp, &mut out[..first]);
        if first < n { self.read_at(0, &mut out[first..]); }
        out
    }

    /// Bytes from `offset` onward. Returns `(data, gap)` — gap is true when the
    /// requested point has already been overwritten, in which case the caller
    /// gets everything still held and must treat the result as incomplete
    /// rather than as a continuation.
    fn since(&self, offset: u64) -> (Vec<u8>, bool) {
        let base = self.base_offset();
        if offset <= base { return (self.dump(), offset < base); }
        if offset >= self.written { return (Vec::new(), false); }
        (self.read_range(offset, usize::MAX), false)
    }

    fn dump(&self) -> Vec<u8> {
        self.read_range(self.base_offset(), usize::MAX)
    }
}

// ───── Frame I/O ─────
// Wire: [4B len LE][1B cmd][payload...]  (len = 1 + payload.len())

struct FrameReader {
    buf: Vec<u8>,
    len: usize,
}

impl FrameReader {
    fn new() -> Self { FrameReader { buf: vec![0u8; 65536], len: 0 } }

    fn feed(&mut self, data: &[u8]) {
        if self.len + data.len() > self.buf.len() {
            self.buf.resize((self.len + data.len()).next_power_of_two(), 0);
        }
        self.buf[self.len..self.len + data.len()].copy_from_slice(data);
        self.len += data.len();
    }

    /// Put a decoded frame back at the head of the buffer.
    ///
    /// Used when a connection turns out to be a legacy server: the frame that
    /// revealed it must still be processed once the connection is promoted.
    fn push_back(&mut self, cmd: u8, payload: &[u8]) {
        let flen = (1 + payload.len()) as u32;
        let mut framed = Vec::with_capacity(4 + flen as usize);
        framed.extend_from_slice(&flen.to_le_bytes());
        framed.push(cmd);
        framed.extend_from_slice(payload);
        let total = framed.len() + self.len;
        if total > self.buf.len() { self.buf.resize(total.next_power_of_two(), 0); }
        self.buf.copy_within(0..self.len, framed.len());
        self.buf[..framed.len()].copy_from_slice(&framed);
        self.len = total;
    }

    fn next_frame(&mut self) -> Option<(u8, Vec<u8>)> {
        if self.len < 5 { return None; }
        let flen = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        if flen == 0 || self.len < 4 + flen { return None; }
        let cmd = self.buf[4];
        let payload = self.buf[5..4 + flen].to_vec();
        let consumed = 4 + flen;
        self.buf.copy_within(consumed..self.len, 0);
        self.len -= consumed;
        Some((cmd, payload))
    }
}

fn write_frame(stream: &mut UnixStream, cmd: u8, payload: &[u8]) -> io::Result<()> {
    let flen = (1 + payload.len()) as u32;
    let mut hdr = [0u8; 5];
    hdr[0..4].copy_from_slice(&flen.to_le_bytes());
    hdr[4] = cmd;
    stream.write_all(&hdr)?;
    if !payload.is_empty() { stream.write_all(payload)?; }
    Ok(())
}

/// Build DATA_OUT payload: [4B seq LE][raw bytes]
fn data_out_payload(seq: u32, data: &[u8]) -> Vec<u8> {
    let mut p = Vec::with_capacity(4 + data.len());
    p.extend_from_slice(&seq.to_le_bytes());
    p.extend_from_slice(data);
    p
}

// ───── Controller connection ─────
//
// Everything sent to the controller goes through `out` and is written
// nonblocking. PTY output is not pushed here as it is read: the controller has a
// cursor into the journal and the loop pulls from it while `out` is short. A
// server that stops reading (event-loop stall, SIGSTOP, memory pressure) leaves
// the cursor behind; the PTY keeps draining into the journal, and the program in
// the pane never blocks on its own output. Measured before this change: a server
// paused for 5s stopped the pane's program at 0 lines (2026-11-06).

struct Client {
    stream: UnixStream,
    out: Vec<u8>,
    out_pos: usize,
    /// Next stream offset to send as DATA_OUT. None until the controller asked
    /// for its catch-up (DUMP_*) or the grace period ran out.
    cursor: Option<u64>,
    promote_offset: u64,
    promoted_at: Instant,
    /// EXIT waits until the output before it has been streamed.
    pending_exit: Option<[u8; 4]>,
}

impl Client {
    fn new(stream: UnixStream, written: u64) -> Self {
        let _ = stream.set_nonblocking(true);
        Client { stream, out: Vec::new(), out_pos: 0, cursor: None, promote_offset: written, promoted_at: Instant::now(), pending_exit: None }
    }

    fn queued(&self) -> usize { self.out.len() - self.out_pos }

    fn send(&mut self, cmd: u8, payload: &[u8]) {
        let flen = (1 + payload.len()) as u32;
        self.out.extend_from_slice(&flen.to_le_bytes());
        self.out.push(cmd);
        self.out.extend_from_slice(payload);
    }

    /// Write what the socket takes now. Err means the connection is gone.
    fn flush(&mut self) -> io::Result<()> {
        while self.out_pos < self.out.len() {
            match self.stream.write(&self.out[self.out_pos..]) {
                Ok(0) => return Err(io::Error::new(ErrorKind::WriteZero, "closed")),
                Ok(n) => self.out_pos += n,
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        if self.out_pos == self.out.len() {
            self.out.clear();
            self.out_pos = 0;
        } else if self.out_pos > (1 << 20) {
            self.out.drain(..self.out_pos);
            self.out_pos = 0;
        }
        Ok(())
    }
}

/// Pull journal bytes behind the cursor into the client's queue as DATA_OUT,
/// up to OUT_HIGH_WATER. If the cursor fell out of the journal, say so with
/// CMD_GAP and resume at the first lexically safe offset.
fn stream_to(c: &mut Client, ring: &Ring, tracker: &AnchorTracker, seq: &mut u32, id: u32) {
    let Some(mut cursor) = c.cursor else { return };
    let base = ring.base_offset();
    if cursor < base {
        let resume = match tracker.first_at_or_after(base) {
            Some(safe) if safe <= ring.written => safe,
            _ => ring.written,
        };
        let mut p = Vec::with_capacity(16);
        p.extend_from_slice(&cursor.to_le_bytes());
        p.extend_from_slice(&resume.to_le_bytes());
        c.send(CMD_GAP, &p);
        log(id, &format!("stream gap from={} to={} (controller behind by more than the journal)", cursor, resume));
        cursor = resume;
    }
    while c.queued() < OUT_HIGH_WATER && cursor < ring.written {
        let data = ring.read_range(cursor, STREAM_CHUNK);
        if data.is_empty() { break; }
        cursor += data.len() as u64;
        let payload = data_out_payload(*seq, &data);
        c.send(CMD_DATA_OUT, &payload);
        *seq = seq.wrapping_add(1);
    }
    c.cursor = Some(cursor);
}

// ───── Config ─────

struct Config {
    id: u32,
    cmd: Vec<String>,
    cols: u16,
    rows: u16,
    runtime_dir: PathBuf,
    ring_size: usize,
    /// On-disk journal size. 0 keeps the in-memory ring of `ring_size`.
    journal_size: usize,
    cwd: Option<String>,
    /// Socket path handed down by the server — the single source of truth,
    /// unique per holder incarnation so a stale socket from a dead session
    /// with a recycled id can never intercept a fresh connect.
    socket_override: Option<PathBuf>,
}

fn parse_args() -> Config {
    let args: Vec<String> = env::args().collect();
    let mut id = 0u32;
    let mut cols = 80u16;
    let mut rows = 24u16;
    let mut runtime_dir = PathBuf::from("/tmp/ttym");
    let mut ring_size: usize = 1 << 20; // 1MB
    let mut journal_size: usize = 16 << 20; // 16MB on disk
    let mut cwd: Option<String> = None;
    let mut socket_override: Option<PathBuf> = None;
    let mut cmd = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--id" => { i += 1; id = args[i].parse().expect("--id"); }
            "--cols" => { i += 1; cols = args[i].parse().expect("--cols"); }
            "--rows" => { i += 1; rows = args[i].parse().expect("--rows"); }
            "--runtime-dir" => { i += 1; runtime_dir = PathBuf::from(&args[i]); }
            "--ring-size" => { i += 1; ring_size = args[i].parse().expect("--ring-size"); }
            "--journal-size" => { i += 1; journal_size = args[i].parse().expect("--journal-size"); }
            "--cwd" => { i += 1; cwd = Some(args[i].clone()); }
            "--socket" => { i += 1; socket_override = Some(PathBuf::from(&args[i])); }
            "--" => { cmd = args[i + 1..].to_vec(); break; }
            other => { eprintln!("unknown arg: {other}"); process::exit(1); }
        }
        i += 1;
    }
    if cmd.is_empty() {
        cmd = vec![env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())];
    }
    Config { id, cmd, cols, rows, runtime_dir, ring_size, journal_size, cwd, socket_override }
}

// ───── Helpers ─────

fn set_nonblocking(fd: RawFd) {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
}

fn log(id: u32, msg: &str) {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    eprintln!("[holder s={id} t={ts}] {msg}");
}

fn flush_pending_input(master_fd: RawFd, pending_input: &mut Vec<u8>) -> io::Result<()> {
    while !pending_input.is_empty() {
        let wn = unsafe { libc::write(master_fd, pending_input.as_ptr() as *const _, pending_input.len()) };
        if wn > 0 {
            let written = wn as usize;
            if written >= pending_input.len() {
                pending_input.clear();
            } else {
                pending_input.copy_within(written.., 0);
                pending_input.truncate(pending_input.len() - written);
            }
            continue;
        }

        if wn == 0 {
            break;
        }

        let err = io::Error::last_os_error();
        if err.kind() == ErrorKind::WouldBlock {
            return Ok(());
        }
        return Err(err);
    }

    Ok(())
}

// ───── Main ─────

fn main() {
    let config = parse_args();
    fs::create_dir_all(&config.runtime_dir).expect("mkdir runtime_dir");

    let socket_path = config.socket_override.clone()
        .unwrap_or_else(|| socket_path_for(&config.runtime_dir, config.id));
    if let Some(dir) = socket_path.parent() {
        fs::create_dir_all(dir).expect("create socket namespace");
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            if let Some(user_root) = dir.parent() {
                let _ = fs::set_permissions(user_root, fs::Permissions::from_mode(0o700));
            }
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
    }
    // Validate in BYTES (sockaddr_un limit is bytes, not chars) and fail
    // with words, not a panic backtrace.
    if socket_path.as_os_str().len() > 100 {
        eprintln!("ttym-holder: socket path exceeds sockaddr_un limit: {}", socket_path.display());
        process::exit(1);
    }
    let manifest_path = config.runtime_dir.join(format!("session-{}.json", config.id));
    let _ = fs::remove_file(&socket_path); // clean stale

    // ── forkpty ──
    let winsize = Winsize {
        ws_col: config.cols, ws_row: config.rows,
        ws_xpixel: 0, ws_ypixel: 0,
    };

    // Bind BEFORE forkpty: a bind failure must not leave an orphaned PTY
    // child behind. The listener is CLOEXEC (std default), so the child
    // does not inherit it.
    let mut listener = UnixListener::bind(&socket_path).expect("bind");
    listener.set_nonblocking(true).unwrap();
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600));
    }

    let result = unsafe { forkpty(Some(&winsize), None) }.expect("forkpty");
    let (master, child_pid) = match result {
        ForkptyResult::Child => {
            unsafe { libc::setenv(
                b"TERM\0".as_ptr() as *const _,
                b"xterm-256color\0".as_ptr() as *const _,
                1,
            ); }
            // Inject session ID so child processes (e.g. Claude Code hooks) can identify this ttym session
            {
                let val = std::ffi::CString::new(config.id.to_string()).unwrap();
                unsafe { libc::setenv(
                    b"TTYM_SESSION_ID\0".as_ptr() as *const _,
                    val.as_ptr() as *const _,
                    1,
                ); }
            }
            // Clean inherited env vars that prevent nesting (e.g. Claude Code sets CLAUDECODE=1)
            for key in &[
                "NO_COLOR",
                "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
                "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            ] {
                let ckey = CString::new(*key).unwrap();
                unsafe { libc::unsetenv(ckey.as_ptr()); }
            }
            unsafe {
                libc::setenv(b"CLICOLOR\0".as_ptr() as *const _, b"1\0".as_ptr() as *const _, 0);
                libc::setenv(b"CLICOLOR_FORCE\0".as_ptr() as *const _, b"1\0".as_ptr() as *const _, 0);
                libc::setenv(b"FORCE_COLOR\0".as_ptr() as *const _, b"1\0".as_ptr() as *const _, 0);
                libc::setenv(b"COLORTERM\0".as_ptr() as *const _, b"truecolor\0".as_ptr() as *const _, 0);
            }
            // Change working directory if --cwd was specified
            if let Some(ref cwd) = config.cwd {
                let c_cwd = CString::new(cwd.as_str()).unwrap();
                unsafe { libc::chdir(c_cwd.as_ptr()); }
            }
            let c_cmd = CString::new(config.cmd[0].as_str()).unwrap();
            let c_args: Vec<CString> = config.cmd.iter()
                .map(|a| CString::new(a.as_str()).unwrap()).collect();
            nix::unistd::execvp(&c_cmd, &c_args).expect("execvp");
            unreachable!();
        }
        ForkptyResult::Parent { child, master } => (master, child),
    };

    let master_fd = master.as_raw_fd();
    set_nonblocking(master_fd);

    // ── Manifest ──
    let created_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
    // Identifies this holder incarnation. A checkpoint taken against a
    // different generation belongs to a different PTY and must not be replayed.
    let generation = format!("{}-{}", process::id(), created_at);
    let manifest = format!(
        concat!(
            r#"{{"id":{},"pid":{},"childPid":{},"cmd":"#,
            r#"{},"cols":{},"rows":{},"socket":"{}","createdAt":{},"generation":"{}"}}"#
        ),
        config.id, process::id(), child_pid.as_raw(),
        format_cmd_json(&config.cmd), config.cols, config.rows,
        socket_path.display(), created_at, generation,
    );
    fs::write(&manifest_path, &manifest).expect("write manifest");
    log(config.id, &format!("started pid={} child={} sock={}", process::id(), child_pid, socket_path.display()));

    // ── State ──
    // Journals of earlier holders with this id belong to dead PTYs.
    if let Ok(entries) = fs::read_dir(&config.runtime_dir) {
        let prefix = format!("journal-{}-", config.id);
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) { let _ = fs::remove_file(e.path()); }
        }
    }
    let journal_path = config.runtime_dir.join(format!("journal-{}-{}.bin", config.id, generation));
    let mut ring = if config.journal_size > 0 {
        match Ring::file(&journal_path, config.journal_size) {
            Ok(r) => r,
            Err(e) => {
                log(config.id, &format!("journal open failed ({}), using memory ring", e));
                Ring::new(config.ring_size)
            }
        }
    } else {
        Ring::new(config.ring_size)
    };
    let mut tracker = AnchorTracker::new();
    let mut seq: u32 = 1;
    let mut cols = config.cols;
    let mut rows = config.rows;
    let mut client: Option<Client> = None;
    let mut reader = FrameReader::new();
    // Accepted but not yet the controller: it has been sent STATE and we are
    // waiting to see whether it claims the lease.
    let mut pending: Option<(UnixStream, Instant)> = None;
    let mut pending_reader = FrameReader::new();
    let mut lease_generation: u64 = 0;
    let mut pty_alive = true;
    let mut exit_code: Option<i32> = None;
    let mut linger_deadline: Option<Instant> = None;
    let mut read_buf = vec![0u8; 65536];
    let mut pending_input = Vec::new();
    let mut last_socket_check = Instant::now();

    // Keep master OwnedFd alive
    let _master_keep: OwnedFd = master;

    // ── Event loop ──
    loop {
        // Linger check
        if let Some(deadline) = linger_deadline {
            if Instant::now() >= deadline { break; }
        }

        // Socket presence check.
        //
        // Another holder starting with the same id unlinks this path (see the
        // "clean stale" remove_file above), and so does anything else that
        // sweeps the runtime dir. The listener fd stays valid but nothing can
        // reach it by path, so the server's recover() gets ENOENT, deletes the
        // manifest, and this holder becomes unreachable forever while its PTY
        // and child keep running. Rebind instead of stranding the session.
        if pty_alive && last_socket_check.elapsed() >= Duration::from_secs(5) {
            last_socket_check = Instant::now();
            if !socket_path.exists() {
                match UnixListener::bind(&socket_path) {
                    Ok(fresh) => {
                        let _ = fresh.set_nonblocking(true);
                        #[cfg(unix)] {
                            use std::os::unix::fs::PermissionsExt;
                            let _ = fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600));
                        }
                        // Keep the current client: an established connection
                        // survives its path being unlinked, so dropping it here
                        // would break a server that is still attached.
                        listener = fresh;
                        let _ = fs::write(&manifest_path, &manifest);
                        log(config.id, "socket vanished, rebound and rewrote manifest");
                    }
                    Err(e) => log(config.id, &format!("socket vanished, rebind failed: {}", e)),
                }
            }
        }

        // Build pollfds. Slots are fixed; an absent client or pending
        // connection is passed as fd -1, which poll ignores.
        let listener_fd = listener.as_raw_fd();
        let client_fd = client.as_ref().map(|c| c.stream.as_raw_fd()).unwrap_or(-1);
        let client_wants_write = client.as_ref().map(|c| {
            c.queued() > 0 || c.cursor.map(|cur| cur < ring.written).unwrap_or(false)
        }).unwrap_or(false);
        let pending_fd = pending.as_ref().map(|(c, _)| c.as_raw_fd()).unwrap_or(-1);
        let mut fds = [
            libc::pollfd {
                fd: master_fd,
                events: if pty_alive {
                    libc::POLLIN | if pending_input.is_empty() { 0 } else { libc::POLLOUT }
                } else { 0 },
                revents: 0,
            },
            libc::pollfd { fd: listener_fd, events: libc::POLLIN, revents: 0 },
            libc::pollfd {
                fd: client_fd,
                events: if client_fd >= 0 {
                    libc::POLLIN | if client_wants_write { libc::POLLOUT } else { 0 }
                } else { 0 },
                revents: 0,
            },
            libc::pollfd { fd: pending_fd, events: if pending_fd >= 0 { libc::POLLIN } else { 0 }, revents: 0 },
        ];
        let nfds: libc::nfds_t = 4;

        let timeout_ms = match linger_deadline {
            Some(deadline) => deadline.checked_duration_since(Instant::now())
                .map(|d| d.as_millis().min(5000) as i32)
                .unwrap_or(0),
            // A parked connection needs the loop to wake up for its claim deadline.
            None => if pending.is_some() || client.as_ref().map(|c| c.cursor.is_none()).unwrap_or(false) { 200 } else { 5000 },
        };

        let n = unsafe { libc::poll(fds.as_mut_ptr(), nfds, timeout_ms) };
        if n < 0 {
            if io::Error::last_os_error().kind() == ErrorKind::Interrupted { continue; }
            break;
        }

        // ── Master fd: drain all available data ──
        if fds[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 && pty_alive {
            let mut budget = PTY_READ_BUDGET;
            while budget > 0 {
                let rn = unsafe { libc::read(master_fd, read_buf.as_mut_ptr() as *mut _, read_buf.len()) };
                if rn > 0 {
                    let data = &read_buf[..rn as usize];
                    budget = budget.saturating_sub(data.len());
                    let start = ring.written;
                    ring.push(data);
                    tracker.feed(data, start);
                    tracker.prune_below(ring.base_offset());
                } else if rn == 0 {
                    pty_exit(&mut pty_alive, &mut exit_code, &mut linger_deadline, child_pid, config.id, &mut client);
                    break;
                } else {
                    let err = io::Error::last_os_error();
                    if err.kind() == ErrorKind::WouldBlock {
                        // POLLHUP with no data = EOF
                        if fds[0].revents & libc::POLLHUP != 0 {
                            pty_exit(&mut pty_alive, &mut exit_code, &mut linger_deadline, child_pid, config.id, &mut client);
                        }
                        break;
                    }
                    pty_exit(&mut pty_alive, &mut exit_code, &mut linger_deadline, child_pid, config.id, &mut client);
                    break;
                }
            }
        }

        if pty_alive && !pending_input.is_empty() && fds[0].revents & libc::POLLOUT != 0 {
            if let Err(err) = flush_pending_input(master_fd, &mut pending_input) {
                log(config.id, &format!("pty input flush err kind={:?}", err.kind()));
            }
        }

        // ── Listener: accept ──
        if fds[1].revents & libc::POLLIN != 0 {
            if let Ok((stream, _)) = listener.accept() {
                log(config.id, "client connected");
                let _ = stream.set_nonblocking(false);

                // Send STATE to new client
                // "lease" tells a server it may claim the controller role. A
                // server that does not know the field simply ignores it and is
                // promoted on the claim timeout, exactly as before.
                let state = format!(
                    concat!(
                        r#"{{"id":{},"pid":{},"childPid":{},"cmd":"#,
                        r#"{},"cols":{},"rows":{},"createdAt":{},"nextSeq":{},"alive":{},"#,
                        r#""lease":true,"held":{},"generation":"{}","#,
                        r#""baseOffset":{},"nextOffset":{},"caps":{}}}"#
                    ),
                    config.id, process::id(), child_pid.as_raw(),
                    format_cmd_json(&config.cmd), cols, rows,
                    created_at, seq, pty_alive, client.is_some(),
                    generation, ring.base_offset(), ring.written, CAPS,
                );
                let mut new_stream = stream;
                let _ = write_frame(&mut new_stream, CMD_STATE, state.as_bytes());
                if !pty_alive {
                    let code = exit_code.unwrap_or(-1).to_le_bytes();
                    let _ = write_frame(&mut new_stream, CMD_EXIT, &code);
                }

                // Do not promote yet. A lease-aware server sends ACQUIRE next;
                // anything else is legacy and gets promoted below.
                pending = Some((new_stream, Instant::now()));
                pending_reader = FrameReader::new();
            }
        }

        // ── Pending connection: lease claim ──
        //
        // Until this resolves the connection cannot write to the PTY. A
        // lease-aware server sends ACQUIRE; anything else (or silence past the
        // deadline) is a legacy server and gets promoted unconditionally, which
        // is the behaviour every existing server relies on.
        if pending_fd >= 0 {
            let mut resolve: Option<bool> = None; // Some(true) = promote, Some(false) = reject
            let mut hangup = false;

            if fds[3].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                if let Some((ref mut c, _)) = pending {
                    let mut tmp = [0u8; 8192];
                    match c.read(&mut tmp) {
                        Ok(0) => hangup = true,
                        Ok(n) => pending_reader.feed(&tmp[..n]),
                        Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                        Err(_) => hangup = true,
                    }
                }

                while resolve.is_none() && !hangup {
                    let Some((cmd, payload)) = pending_reader.next_frame() else { break };
                    if cmd == CMD_ACQUIRE {
                        let body = String::from_utf8_lossy(&payload);
                        let takeover = body.contains("\"takeover\":true");
                        if client.is_some() && !takeover {
                            log(config.id, "lease claim denied: controller already held");
                            if let Some((ref mut c, _)) = pending {
                                let _ = write_frame(c, CMD_DENIED, b"{\"reason\":\"held\"}");
                            }
                            resolve = Some(false);
                        } else {
                            lease_generation += 1;
                            if let Some((ref mut c, _)) = pending {
                                let msg = format!("{{\"generation\":{}}}", lease_generation);
                                let _ = write_frame(c, CMD_ACQUIRED, msg.as_bytes());
                            }
                            // Tell the outgoing controller it lost the lease so it
                            // can report that instead of guessing the PTY died.
                            if let Some(mut old) = client.take() {
                                log(config.id, "controller evicted by takeover");
                                old.send(CMD_EVICTED, b"");
                                let _ = old.flush();
                            }
                            resolve = Some(true);
                        }
                    } else {
                        // A legacy server started talking without claiming.
                        log(config.id, "legacy client (no lease claim), promoting");
                        pending_reader.push_back(cmd, &payload);
                        resolve = Some(true);
                    }
                }
            }

            // Silence past the deadline means legacy too.
            if resolve.is_none() && !hangup {
                if let Some((_, since)) = pending.as_ref() {
                    if since.elapsed() >= LEASE_CLAIM_TIMEOUT {
                        log(config.id, "lease claim timed out, promoting as legacy");
                        resolve = Some(true);
                    }
                }
            }

            match (hangup, resolve) {
                (true, _) | (_, Some(false)) => {
                    pending = None;
                    pending_reader = FrameReader::new();
                }
                (_, Some(true)) => {
                    if let Some((stream, _)) = pending.take() {
                        client = Some(Client::new(stream, ring.written));
                        // Carry over anything already buffered from this
                        // connection so a legacy server's first frame is not lost.
                        reader = std::mem::replace(&mut pending_reader, FrameReader::new());
                        log(config.id, "controller acquired");
                    }
                }
                _ => {}
            }
        }

        // ── Client: read frames ──
        if client_fd >= 0 && fds[2].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
            let mut disconnected = false;
            if let Some(ref mut c) = client {
                let mut tmp = [0u8; 65536];
                match c.stream.read(&mut tmp) {
                    Ok(0) => { disconnected = true; }
                    Ok(n) => {
                        reader.feed(&tmp[..n]);
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                    Err(_) => { disconnected = true; }
                }
            }
            if disconnected {
                log(config.id, "client disconnected");
                client = None;
                reader = FrameReader::new();
            }
        }

        // Process buffered frames
        let mut frames = Vec::new();
        while let Some(f) = reader.next_frame() { frames.push(f); }

        for (cmd, payload) in frames {
            match cmd {
                CMD_DATA_IN => {
                    if pty_alive {
                        if pending_input.len() + payload.len() > MAX_PENDING_INPUT {
                            log(config.id, &format!("pty not reading input: dropping {} bytes", payload.len()));
                            continue;
                        }
                        pending_input.extend_from_slice(&payload);
                        if let Err(err) = flush_pending_input(master_fd, &mut pending_input) {
                            log(config.id, &format!("pty input write err kind={:?}", err.kind()));
                        }
                    }
                }
                CMD_RESIZE => {
                    if payload.len() >= 4 && pty_alive {
                        let nc = u16::from_le_bytes([payload[0], payload[1]]);
                        let nr = u16::from_le_bytes([payload[2], payload[3]]);
                        if nc > 0 && nr > 0 {
                            cols = nc;
                            rows = nr;
                            let ws = Winsize { ws_col: nc, ws_row: nr, ws_xpixel: 0, ws_ypixel: 0 };
                            unsafe { libc::ioctl(master_fd, libc::TIOCSWINSZ as _, &ws); }
                        }
                    }
                }
                CMD_DUMP_REQ => {
                    // A full dump from an overflowed ring has the same
                    // arbitrary-cut head as a gap replay — trim to the first
                    // safe offset. A never-overflowed ring starts at byte 0,
                    // which is ground by definition.
                    let from = ring.base_offset().max(ring.written.saturating_sub(DUMP_REQ_MAX));
                    let data = if from > 0 {
                        match tracker.first_at_or_after(from) {
                            Some(safe) if safe < ring.written => ring.since(safe).0,
                            _ => Vec::new(),
                        }
                    } else {
                        ring.dump()
                    };
                    if let Some(ref mut c) = client {
                        c.send(CMD_DUMP_RESP, &data);
                        // The dump covers everything up to now; live output continues from here.
                        c.cursor = Some(ring.written);
                    }
                }
                CMD_DUMP_SINCE => {
                    // payload: u64 LE offset the server has already applied.
                    // reply:   [u64 base][u64 end][u8 gap][bytes]
                    //
                    // gap=1 means the requested point fell out of the ring, so
                    // what follows is not a continuation of the server's state
                    // and it has to say so rather than paint a broken screen.
                    let want = if payload.len() >= 8 {
                        u64::from_le_bytes(payload[..8].try_into().unwrap())
                    } else { 0 };
                    let (mut data, gap) = ring.since(want);
                    let mut base = ring.base_offset();
                    if gap {
                        // The surviving tail must start at a lexically safe
                        // offset — otherwise it is not a screen, it is noise
                        // that can corrupt rows far past the cut.
                        match tracker.first_at_or_after(base) {
                            Some(safe) if safe < ring.written => {
                                let (safe_data, _) = ring.since(safe);
                                data = safe_data;
                                base = safe;
                            }
                            _ => {
                                // No ground offset survives in the ring (e.g.
                                // one giant string sequence). Withholding the
                                // tail is honest; serving it is fabrication.
                                data = Vec::new();
                                base = ring.written;
                            }
                        }
                    }
                    let mut resp = Vec::with_capacity(17 + data.len());
                    resp.extend_from_slice(&base.to_le_bytes());
                    resp.extend_from_slice(&ring.written.to_le_bytes());
                    resp.push(if gap { 1 } else { 0 });
                    resp.extend_from_slice(&data);
                    if let Some(ref mut c) = client {
                        c.send(CMD_REPLAY, &resp);
                        c.cursor = Some(ring.written);
                    }
                    log(config.id, &format!(
                        "replay since={} base={} end={} gap={} bytes={}",
                        want, ring.base_offset(), ring.written, gap, data.len()));
                }
                CMD_KILL => {
                    if pty_alive {
                        let _ = nix::sys::signal::kill(child_pid, Signal::SIGHUP);
                        std::thread::sleep(Duration::from_millis(100));
                        let _ = nix::sys::signal::kill(child_pid, Signal::SIGKILL);
                    }
                }
                CMD_PING => {
                    if let Some(ref mut c) = client {
                        c.send(CMD_PONG, &[]);
                    }
                }
                _ => {}
            }
        }

        // ── Controller: stream journal behind the cursor, then write what the socket takes ──
        let mut drop_client = false;
        if let Some(ref mut c) = client {
            if c.cursor.is_none() && c.promoted_at.elapsed() >= STREAM_START_GRACE {
                // A server that never asks for a catch-up still gets everything since promotion.
                c.cursor = Some(c.promote_offset);
            }
            stream_to(c, &ring, &tracker, &mut seq, config.id);
            if c.pending_exit.is_some() && c.cursor.map(|cur| cur >= ring.written).unwrap_or(false) {
                let code = c.pending_exit.take().unwrap();
                c.send(CMD_EXIT, &code);
            }
            if let Err(err) = c.flush() {
                log(config.id, &format!("client write err kind={:?}, dropping", err.kind()));
                drop_client = true;
            }
        }
        if drop_client {
            client = None;
            reader = FrameReader::new();
        }

        // Periodic child check
        if pty_alive {
            match waitpid(child_pid, Some(WaitPidFlag::WNOHANG)) {
                Ok(WaitStatus::Exited(_, code)) => {
                    pty_alive = false;
                    exit_code = Some(code);
                    log(config.id, &format!("child exited (waitpid) code={code}"));
                    if let Some(ref mut c) = client {
                        if c.cursor.is_none() { c.cursor = Some(c.promote_offset); }
                        c.pending_exit = Some(code.to_le_bytes());
                    }
                    linger_deadline = Some(Instant::now() + Duration::from_secs(30));
                }
                Ok(WaitStatus::Signaled(_, sig, _)) => {
                    pty_alive = false;
                    let code = 128 + sig as i32;
                    exit_code = Some(code);
                    log(config.id, &format!("child signaled sig={sig}"));
                    if let Some(ref mut c) = client {
                        if c.cursor.is_none() { c.cursor = Some(c.promote_offset); }
                        c.pending_exit = Some(code.to_le_bytes());
                    }
                    linger_deadline = Some(Instant::now() + Duration::from_secs(30));
                }
                _ => {}
            }
        }
    }

    // Cleanup
    let _ = fs::remove_file(&journal_path);
    let _ = fs::remove_file(&socket_path);
    let _ = fs::remove_file(&manifest_path);
    let _ = fs::remove_file(&socket_path);
    log(config.id, "exiting");
}

fn pty_exit(
    pty_alive: &mut bool,
    exit_code: &mut Option<i32>,
    linger: &mut Option<Instant>,
    child: nix::unistd::Pid,
    id: u32,
    client: &mut Option<Client>,
) {
    if !*pty_alive { return; }
    *pty_alive = false;
    *exit_code = match waitpid(child, Some(WaitPidFlag::WNOHANG)) {
        Ok(WaitStatus::Exited(_, c)) => Some(c),
        Ok(WaitStatus::Signaled(_, s, _)) => Some(128 + s as i32),
        _ => Some(-1),
    };
    log(id, &format!("PTY exited code={:?}", exit_code));
    if let Some(ref mut c) = client {
        // EXIT goes after the output still behind the cursor; the main loop's
        // streamer flushes the rest before the frame is reached.
        if c.cursor.is_none() { c.cursor = Some(c.promote_offset); }
        let code = exit_code.unwrap_or(-1).to_le_bytes();
        c.pending_exit = Some(code);
    }
    *linger = Some(Instant::now() + Duration::from_secs(30));
}

/// FNV-1a 64 over the runtime-dir string AS RECEIVED from the server.
/// Deliberately not canonicalized: Rust's canonicalize resolves symlinks
/// (/var → /private/var on macOS) and Node's resolve() does not — hashing the
/// exchanged string is the only representation both sides share.
/// The TS twin lives in packages/server/src/session.ts (holderSocketPath).
fn fnv1a64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Sockets live in a short, deterministic namespace of their own —
/// /tmp/ttym-<uid>/<hash>/session-<id>.sock — because sockaddr_un caps the
/// path at ~104 bytes and a deep TTYM_RUNTIME_DIR used to panic the bind.
/// Manifests and checkpoints stay in the runtime dir; only the transport
/// path moves.
fn socket_path_for(runtime_dir: &std::path::Path, id: u32) -> PathBuf {
    let uid = unsafe { libc::getuid() };
    let hash = fnv1a64(&runtime_dir.display().to_string());
    PathBuf::from(format!("/tmp/ttym-{}/{:016x}/session-{}.sock", uid, hash, id))
}

fn format_cmd_json(cmd: &[String]) -> String {
    // Full JSON string escaping. The backslash-and-quote-only version let a
    // control character in argv (a newline in an `sh -lc` script is enough)
    // write an unparseable manifest — the session then failed to create AND
    // failed to recover, since both paths read this file back as JSON.
    let parts: Vec<String> = cmd
        .iter()
        .map(|s| {
            let mut out = String::with_capacity(s.len() + 2);
            out.push('"');
            for ch in s.chars() {
                match ch {
                    '\\' => out.push_str("\\\\"),
                    '"' => out.push_str("\\\""),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
            out.push('"');
            out
        })
        .collect();
    format!("[{}]", parts.join(","))
}

#[cfg(test)]
mod tests {
    use super::format_cmd_json;
    use super::{AnchorTracker, Ring};


    #[test]
    fn anchors_skip_mid_osc() {
        let mut t = AnchorTracker::new();
        // 8KB 평문 → OSC 열고 8KB payload(미종결) — payload 안엔 앵커가 없어야 한다.
        let plain = vec![b'x'; 8192];
        t.feed(&plain, 0);
        let mut osc = b"\x1b]8;;http://e".to_vec();
        osc.extend(vec![b'p'; 8192]);
        t.feed(&osc, 8192);
        let last = *t.anchors.back().unwrap();
        assert!(last <= 8192, "anchor {} inside unterminated OSC", last);
        // 종결(BEL) 후 평문이 흐르면 다시 기록된다.
        let mut tail = vec![0x07u8];
        tail.extend(vec![b'y'; 8192]);
        t.feed(&tail, 8192 + osc.len() as u64);
        assert!(*t.anchors.back().unwrap() > 8192);
    }

    #[test]
    fn anchors_skip_mid_utf8() {
        let mut t = AnchorTracker::new();
        // 경계 직전 바이트가 한글 리딩바이트로 끝나게: 4095 ASCII + 3바이트 문자
        let mut data = vec![b'a'; ANCHOR_GRAIN_TEST - 1];
        data.extend_from_slice("한".as_bytes()); // E1.. 3바이트
        t.feed(&data, 0);
        for &a in &t.anchors {
            // 문자 중간(4096, 4097)엔 앵커가 없어야 한다
            assert!(a != ANCHOR_GRAIN_TEST as u64 && a != ANCHOR_GRAIN_TEST as u64 + 1);
        }
    }

    const ANCHOR_GRAIN_TEST: usize = 4096;

    #[test]
    fn no_anchor_in_ring_means_none() {
        let mut t = AnchorTracker::new();
        let mut ring = Ring::new(1024);
        // 4KB짜리 미종결 OSC가 ring(1KB)을 완전히 덮으면 안전 오프셋이 없다.
        let mut osc = b"\x1b]0;".to_vec();
        osc.extend(vec![b'q'; 4096]);
        let start = ring.written;
        ring.push(&osc);
        t.feed(&osc, start);
        t.prune_below(ring.base_offset());
        assert_eq!(t.first_at_or_after(ring.base_offset()), None);
    }

    #[test]
    fn file_journal_matches_memory_ring_across_wraps() {
        let dir = std::env::temp_dir().join(format!("ttym-holder-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut mem = Ring::new(1000);
        let mut file = Ring::file(&dir.join("j.bin"), 1000).unwrap();
        let mut all = Vec::new();
        for i in 0..400u32 {
            let chunk: Vec<u8> = (0..(i % 37 + 1)).map(|k| (i * 7 + k) as u8).collect();
            mem.push(&chunk);
            file.push(&chunk);
            all.extend_from_slice(&chunk);
            assert_eq!(mem.written, file.written);
            assert_eq!(mem.base_offset(), file.base_offset());
            assert_eq!(mem.dump(), file.dump());
            let base = file.base_offset() as usize;
            assert_eq!(file.dump(), all[base..].to_vec());
        }
        // a push larger than the capacity keeps only its tail
        let big: Vec<u8> = (0..2500u32).map(|k| k as u8).collect();
        file.push(&big);
        all.extend_from_slice(&big);
        assert_eq!(file.dump(), all[all.len() - 1000..].to_vec());
        assert_eq!(file.read_range(file.written - 10, 4), all[all.len() - 10..all.len() - 6].to_vec());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fnv1a64_matches_known_vector() {
        // TS 쌍둥이(session.ts holderSocketPath)와 같은 값을 내야 한다.
        assert_eq!(super::fnv1a64(""), 0xcbf29ce484222325);
        assert_eq!(super::fnv1a64("a"), 0xaf63dc4c8601ec8c);
        assert_eq!(super::fnv1a64("/Users/x/.ttym/run"), super::fnv1a64("/Users/x/.ttym/run"));
    }

    #[test]
    fn cmd_json_escapes_control_characters() {
        let cmd = vec![
            "a\nb".to_string(),
            "t\tr\r".to_string(),
            "q\"s\\".to_string(),
            "\u{1}".to_string(),
        ];
        let json = format_cmd_json(&cmd);
        assert_eq!(json, r#"["a\nb","t\tr\r","q\"s\\","\u0001"]"#);
    }
}
