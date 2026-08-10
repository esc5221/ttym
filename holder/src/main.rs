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

/// How long a freshly accepted connection may stay unclaimed before we assume
/// it is a legacy server and promote it.
const LEASE_CLAIM_TIMEOUT: Duration = Duration::from_millis(1500);

// ───── Ring buffer ─────

struct Ring {
    buf: Vec<u8>,
    start: usize,
    len: usize,
    /// Total bytes ever pushed. The ring holds the last `len` of them, so the
    /// first byte still available sits at `written - len`.
    written: u64,
}

impl Ring {
    fn new(capacity: usize) -> Self {
        Ring { buf: vec![0u8; capacity], start: 0, len: 0, written: 0 }
    }

    fn push(&mut self, data: &[u8]) {
        self.written += data.len() as u64;
        let cap = self.buf.len();
        if data.len() >= cap {
            let off = data.len() - cap;
            self.buf.copy_from_slice(&data[off..]);
            self.start = 0;
            self.len = cap;
            return;
        }
        let wp = (self.start + self.len) % cap;
        let first = cap - wp;
        if data.len() <= first {
            self.buf[wp..wp + data.len()].copy_from_slice(data);
        } else {
            self.buf[wp..wp + first].copy_from_slice(&data[..first]);
            self.buf[..data.len() - first].copy_from_slice(&data[first..]);
        }
        self.len += data.len();
        if self.len > cap {
            self.start = (self.start + self.len - cap) % cap;
            self.len = cap;
        }
    }

    /// Absolute offset of the oldest byte still in the ring.
    fn base_offset(&self) -> u64 { self.written - self.len as u64 }

    /// Bytes from `offset` onward. Returns `(data, gap)` — gap is true when the
    /// requested point has already been overwritten, in which case the caller
    /// gets everything still held and must treat the result as incomplete
    /// rather than as a continuation.
    fn since(&self, offset: u64) -> (Vec<u8>, bool) {
        let base = self.base_offset();
        if offset <= base { return (self.dump(), offset < base); }
        if offset >= self.written { return (Vec::new(), false); }
        let skip = (offset - base) as usize;
        let all = self.dump();
        (all[skip..].to_vec(), false)
    }

    fn dump(&self) -> Vec<u8> {
        if self.len == 0 { return Vec::new(); }
        let cap = self.buf.len();
        let mut out = Vec::with_capacity(self.len);
        if self.start + self.len <= cap {
            out.extend_from_slice(&self.buf[self.start..self.start + self.len]);
        } else {
            out.extend_from_slice(&self.buf[self.start..cap]);
            out.extend_from_slice(&self.buf[..self.start + self.len - cap]);
        }
        out
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

// ───── Config ─────

struct Config {
    id: u32,
    cmd: Vec<String>,
    cols: u16,
    rows: u16,
    runtime_dir: PathBuf,
    ring_size: usize,
    cwd: Option<String>,
}

fn parse_args() -> Config {
    let args: Vec<String> = env::args().collect();
    let mut id = 0u32;
    let mut cols = 80u16;
    let mut rows = 24u16;
    let mut runtime_dir = PathBuf::from("/tmp/ttym");
    let mut ring_size: usize = 1 << 20; // 1MB
    let mut cwd: Option<String> = None;
    let mut cmd = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--id" => { i += 1; id = args[i].parse().expect("--id"); }
            "--cols" => { i += 1; cols = args[i].parse().expect("--cols"); }
            "--rows" => { i += 1; rows = args[i].parse().expect("--rows"); }
            "--runtime-dir" => { i += 1; runtime_dir = PathBuf::from(&args[i]); }
            "--ring-size" => { i += 1; ring_size = args[i].parse().expect("--ring-size"); }
            "--cwd" => { i += 1; cwd = Some(args[i].clone()); }
            "--" => { cmd = args[i + 1..].to_vec(); break; }
            other => { eprintln!("unknown arg: {other}"); process::exit(1); }
        }
        i += 1;
    }
    if cmd.is_empty() {
        cmd = vec![env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())];
    }
    Config { id, cmd, cols, rows, runtime_dir, ring_size, cwd }
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

    let socket_path = config.runtime_dir.join(format!("session-{}.sock", config.id));
    let manifest_path = config.runtime_dir.join(format!("session-{}.json", config.id));
    let _ = fs::remove_file(&socket_path); // clean stale

    // ── forkpty ──
    let winsize = Winsize {
        ws_col: config.cols, ws_row: config.rows,
        ws_xpixel: 0, ws_ypixel: 0,
    };

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

    // ── Unix listener ──
    let mut listener = UnixListener::bind(&socket_path).expect("bind");
    listener.set_nonblocking(true).unwrap();
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600));
    }

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
    let mut ring = Ring::new(config.ring_size);
    let mut seq: u32 = 1;
    let mut cols = config.cols;
    let mut rows = config.rows;
    let mut client: Option<UnixStream> = None;
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
        let client_fd = client.as_ref().map(|c| c.as_raw_fd()).unwrap_or(-1);
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
            libc::pollfd { fd: client_fd, events: if client_fd >= 0 { libc::POLLIN } else { 0 }, revents: 0 },
            libc::pollfd { fd: pending_fd, events: if pending_fd >= 0 { libc::POLLIN } else { 0 }, revents: 0 },
        ];
        let nfds: libc::nfds_t = 4;

        let timeout_ms = match linger_deadline {
            Some(deadline) => deadline.checked_duration_since(Instant::now())
                .map(|d| d.as_millis().min(5000) as i32)
                .unwrap_or(0),
            // A parked connection needs the loop to wake up for its claim deadline.
            None => if pending.is_some() { 200 } else { 5000 },
        };

        let n = unsafe { libc::poll(fds.as_mut_ptr(), nfds, timeout_ms) };
        if n < 0 {
            if io::Error::last_os_error().kind() == ErrorKind::Interrupted { continue; }
            break;
        }

        // ── Master fd: drain all available data ──
        if fds[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 && pty_alive {
            loop {
                let rn = unsafe { libc::read(master_fd, read_buf.as_mut_ptr() as *mut _, read_buf.len()) };
                if rn > 0 {
                    let data = &read_buf[..rn as usize];
                    ring.push(data);
                    if let Some(ref mut c) = client {
                        let payload = data_out_payload(seq, data);
                        if let Err(err) = write_frame(c, CMD_DATA_OUT, &payload) {
                            log(config.id, &format!("client write err kind={:?}, dropping", err.kind()));
                            client = None;
                            reader = FrameReader::new();
                        }
                    }
                    seq += 1;
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
                        r#""baseOffset":{},"nextOffset":{}}}"#
                    ),
                    config.id, process::id(), child_pid.as_raw(),
                    format_cmd_json(&config.cmd), cols, rows,
                    created_at, seq, pty_alive, client.is_some(),
                    generation, ring.base_offset(), ring.written,
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
                                let _ = write_frame(&mut old, CMD_EVICTED, b"");
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
                        client = Some(stream);
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
                match c.read(&mut tmp) {
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
                            unsafe { libc::ioctl(master_fd, libc::TIOCSWINSZ as libc::c_ulong, &ws); }
                        }
                    }
                }
                CMD_DUMP_REQ => {
                    let data = ring.dump();
                    if let Some(ref mut c) = client {
                        let _ = write_frame(c, CMD_DUMP_RESP, &data);
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
                    let (data, gap) = ring.since(want);
                    let mut resp = Vec::with_capacity(17 + data.len());
                    resp.extend_from_slice(&ring.base_offset().to_le_bytes());
                    resp.extend_from_slice(&ring.written.to_le_bytes());
                    resp.push(if gap { 1 } else { 0 });
                    resp.extend_from_slice(&data);
                    if let Some(ref mut c) = client {
                        let _ = write_frame(c, CMD_REPLAY, &resp);
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
                        let _ = write_frame(c, CMD_PONG, &[]);
                    }
                }
                _ => {}
            }
        }

        // Periodic child check
        if pty_alive {
            match waitpid(child_pid, Some(WaitPidFlag::WNOHANG)) {
                Ok(WaitStatus::Exited(_, code)) => {
                    pty_alive = false;
                    exit_code = Some(code);
                    log(config.id, &format!("child exited (waitpid) code={code}"));
                    if let Some(ref mut c) = client {
                        let _ = write_frame(c, CMD_EXIT, &code.to_le_bytes());
                    }
                    linger_deadline = Some(Instant::now() + Duration::from_secs(30));
                }
                Ok(WaitStatus::Signaled(_, sig, _)) => {
                    pty_alive = false;
                    let code = 128 + sig as i32;
                    exit_code = Some(code);
                    log(config.id, &format!("child signaled sig={sig}"));
                    if let Some(ref mut c) = client {
                        let _ = write_frame(c, CMD_EXIT, &code.to_le_bytes());
                    }
                    linger_deadline = Some(Instant::now() + Duration::from_secs(30));
                }
                _ => {}
            }
        }
    }

    // Cleanup
    let _ = fs::remove_file(&socket_path);
    let _ = fs::remove_file(&manifest_path);
    log(config.id, "exiting");
}

fn pty_exit(
    pty_alive: &mut bool,
    exit_code: &mut Option<i32>,
    linger: &mut Option<Instant>,
    child: nix::unistd::Pid,
    id: u32,
    client: &mut Option<UnixStream>,
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
        let code = exit_code.unwrap_or(-1).to_le_bytes();
        let _ = write_frame(c, CMD_EXIT, &code);
    }
    *linger = Some(Instant::now() + Duration::from_secs(30));
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
