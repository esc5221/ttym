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

// ───── Ring buffer ─────

struct Ring {
    buf: Vec<u8>,
    start: usize,
    len: usize,
}

impl Ring {
    fn new(capacity: usize) -> Self {
        Ring { buf: vec![0u8; capacity], start: 0, len: 0 }
    }

    fn push(&mut self, data: &[u8]) {
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
}

fn parse_args() -> Config {
    let args: Vec<String> = env::args().collect();
    let mut id = 0u32;
    let mut cols = 80u16;
    let mut rows = 24u16;
    let mut runtime_dir = PathBuf::from("/tmp/ttym");
    let mut ring_size: usize = 1 << 20; // 1MB
    let mut cmd = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--id" => { i += 1; id = args[i].parse().expect("--id"); }
            "--cols" => { i += 1; cols = args[i].parse().expect("--cols"); }
            "--rows" => { i += 1; rows = args[i].parse().expect("--rows"); }
            "--runtime-dir" => { i += 1; runtime_dir = PathBuf::from(&args[i]); }
            "--ring-size" => { i += 1; ring_size = args[i].parse().expect("--ring-size"); }
            "--" => { cmd = args[i + 1..].to_vec(); break; }
            other => { eprintln!("unknown arg: {other}"); process::exit(1); }
        }
        i += 1;
    }
    if cmd.is_empty() {
        cmd = vec![env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())];
    }
    Config { id, cmd, cols, rows, runtime_dir, ring_size }
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
    let listener = UnixListener::bind(&socket_path).expect("bind");
    listener.set_nonblocking(true).unwrap();
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600));
    }

    // ── Manifest ──
    let created_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
    let manifest = format!(
        concat!(
            r#"{{"id":{},"pid":{},"childPid":{},"cmd":"#,
            r#"{},"cols":{},"rows":{},"socket":"{}","createdAt":{}}}"#
        ),
        config.id, process::id(), child_pid.as_raw(),
        format_cmd_json(&config.cmd), config.cols, config.rows,
        socket_path.display(), created_at,
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
    let mut pty_alive = true;
    let mut exit_code: Option<i32> = None;
    let mut linger_deadline: Option<Instant> = None;
    let mut read_buf = vec![0u8; 65536];

    // Keep master OwnedFd alive
    let _master_keep: OwnedFd = master;

    // ── Event loop ──
    loop {
        // Linger check
        if let Some(deadline) = linger_deadline {
            if Instant::now() >= deadline { break; }
        }

        // Build pollfds
        let listener_fd = listener.as_raw_fd();
        let client_fd = client.as_ref().map(|c| c.as_raw_fd()).unwrap_or(-1);
        let mut fds = [
            libc::pollfd { fd: master_fd, events: if pty_alive { libc::POLLIN } else { 0 }, revents: 0 },
            libc::pollfd { fd: listener_fd, events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: client_fd, events: if client_fd >= 0 { libc::POLLIN } else { 0 }, revents: 0 },
        ];
        let nfds: libc::nfds_t = if client_fd >= 0 { 3 } else { 2 };

        let timeout_ms = match linger_deadline {
            Some(deadline) => deadline.checked_duration_since(Instant::now())
                .map(|d| d.as_millis().min(5000) as i32)
                .unwrap_or(0),
            None => 5000,
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
                        if write_frame(c, CMD_DATA_OUT, &payload).is_err() {
                            log(config.id, "client write err, dropping");
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

        // ── Listener: accept ──
        if fds[1].revents & libc::POLLIN != 0 {
            if let Ok((stream, _)) = listener.accept() {
                log(config.id, "client connected");
                stream.set_nonblocking(true).ok();

                // Send STATE to new client
                let state = format!(
                    concat!(
                        r#"{{"id":{},"pid":{},"childPid":{},"cmd":"#,
                        r#"{},"cols":{},"rows":{},"createdAt":{},"nextSeq":{},"alive":{}}}"#
                    ),
                    config.id, process::id(), child_pid.as_raw(),
                    format_cmd_json(&config.cmd), cols, rows,
                    created_at, seq, pty_alive,
                );
                let mut new_stream = stream;
                let _ = write_frame(&mut new_stream, CMD_STATE, state.as_bytes());
                if !pty_alive {
                    let code = exit_code.unwrap_or(-1).to_le_bytes();
                    let _ = write_frame(&mut new_stream, CMD_EXIT, &code);
                }

                // Replace old client
                client = Some(new_stream);
                reader = FrameReader::new();
            }
        }

        // ── Client: read frames ──
        if nfds == 3 && fds[2].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
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
                        unsafe { libc::write(master_fd, payload.as_ptr() as *const _, payload.len()); }
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
    let parts: Vec<String> = cmd.iter().map(|s| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))).collect();
    format!("[{}]", parts.join(","))
}
