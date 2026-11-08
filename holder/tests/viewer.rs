// Direct viewers (CMD_VIEW): a viewer that stops reading must not stall the PTY
// or the other viewer, and a viewer never takes the lease from the controller.
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

const CMD_STATE: u8 = 0x02;
const CMD_DATA_OUT: u8 = 0x03;
const CMD_DATA_IN: u8 = 0x04;
const CMD_ACQUIRE: u8 = 0x0C;
const CMD_ACQUIRED: u8 = 0x0D;
const CMD_VIEW: u8 = 0x13;

struct Holder { child: Child, dir: std::path::PathBuf, sock: std::path::PathBuf }
impl Drop for Holder {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); let _ = std::fs::remove_dir_all(&self.dir); let _ = std::fs::remove_file(&self.sock); }
}

fn start(tag: &str, script: &str) -> Holder {
    let dir = std::env::temp_dir().join(format!("ttym-viewer-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let sock = std::path::PathBuf::from(format!("/tmp/ttymv-{}-{}.sock", tag, std::process::id()));
    let child = Command::new(env!("CARGO_BIN_EXE_ttym-holder"))
        .args(["--id", "7", "--cols", "80", "--rows", "24", "--runtime-dir"]).arg(&dir)
        .arg("--socket").arg(&sock)
        .args(["--", "/bin/sh", "-c", script])
        .stderr(std::process::Stdio::null())
        .spawn().unwrap();
    let t = Instant::now();
    while !sock.exists() { assert!(t.elapsed() < Duration::from_secs(5), "socket"); std::thread::sleep(Duration::from_millis(20)); }
    Holder { child, dir, sock }
}

fn send(s: &mut UnixStream, cmd: u8, payload: &[u8]) {
    let mut f = ((1 + payload.len()) as u32).to_le_bytes().to_vec();
    f.push(cmd);
    f.extend_from_slice(payload);
    s.write_all(&f).unwrap();
}

fn read_frame(s: &mut UnixStream) -> Option<(u8, Vec<u8>)> {
    let mut hdr = [0u8; 4];
    s.read_exact(&mut hdr).ok()?;
    let len = u32::from_le_bytes(hdr) as usize;
    let mut body = vec![0u8; len];
    s.read_exact(&mut body).ok()?;
    Some((body[0], body[1..].to_vec()))
}

fn connect(h: &Holder) -> (UnixStream, String) {
    let mut s = UnixStream::connect(&h.sock).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let (cmd, state) = read_frame(&mut s).unwrap();
    assert_eq!(cmd, CMD_STATE);
    (s, String::from_utf8_lossy(&state).into_owned())
}

/// Read DATA_OUT until `needle` shows up; returns everything read.
fn read_until(s: &mut UnixStream, needle: &str, limit: Duration) -> String {
    let t = Instant::now();
    let mut out = Vec::new();
    while t.elapsed() < limit {
        let Some((cmd, p)) = read_frame(s) else { break };
        if cmd == CMD_DATA_OUT && p.len() >= 4 { out.extend_from_slice(&p[4..]); }
        if String::from_utf8_lossy(&out).contains(needle) { break; }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[test]
fn state_announces_viewer_cap() {
    let h = start("cap", "sleep 5");
    let (_s, state) = connect(&h);
    assert!(state.contains("\"viewer\""), "{state}");
}

#[test]
fn a_stalled_viewer_blocks_neither_the_pty_nor_another_viewer() {
    // 20000 lines ≈ 300KB: more than a stalled socket buffer + OUT_HIGH_WATER.
    let h = start("stall", "i=0; while [ $i -lt 20000 ]; do echo \"line $i xxxxxxxxxxxxxxxxxxxxxxxxxx\"; i=$((i+1)); done; echo DONE; sleep 10");
    let (mut stalled, _) = connect(&h);
    send(&mut stalled, CMD_VIEW, &0u64.to_le_bytes());
    let (cmd, _) = read_frame(&mut stalled).unwrap();
    assert_eq!(cmd, CMD_ACQUIRED);
    // `stalled` is never read again.
    let (mut live, _) = connect(&h);
    send(&mut live, CMD_VIEW, &(8u64 << 20).to_le_bytes()); // from as far back as the journal holds
    let (cmd, _) = read_frame(&mut live).unwrap();
    assert_eq!(cmd, CMD_ACQUIRED);
    let got = read_until(&mut live, "DONE", Duration::from_secs(15));
    assert!(got.contains("DONE"), "the program finished despite a stalled viewer (got {} bytes)", got.len());
    assert!(got.contains("line 19999"));
    drop(stalled);
}

#[test]
fn a_viewer_does_not_take_the_lease_and_can_type() {
    let h = start("lease", "stty -echo; read x; echo \"GOT:$x\"; sleep 5");
    // controller first
    let (mut ctl, _) = connect(&h);
    send(&mut ctl, CMD_ACQUIRE, b"{}");
    let (cmd, _) = read_frame(&mut ctl).unwrap();
    assert_eq!(cmd, CMD_ACQUIRED);
    // then a viewer: the controller is not evicted
    let (mut v, state) = connect(&h);
    assert!(state.contains("\"held\":true"));
    send(&mut v, CMD_VIEW, &0u64.to_le_bytes());
    let (cmd, ack) = read_frame(&mut v).unwrap();
    assert_eq!(cmd, CMD_ACQUIRED);
    assert!(String::from_utf8_lossy(&ack).contains("viewer"));
    std::thread::sleep(Duration::from_millis(200));
    send(&mut v, CMD_DATA_IN, b"hello\n");
    let seen_by_viewer = read_until(&mut v, "GOT:hello", Duration::from_secs(5));
    assert!(seen_by_viewer.contains("GOT:hello"));
    // the controller still streams the same output (it was never evicted)
    let seen_by_ctl = read_until(&mut ctl, "GOT:hello", Duration::from_secs(5));
    assert!(seen_by_ctl.contains("GOT:hello"), "controller kept the lease");
}
