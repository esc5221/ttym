use serde::Serialize;
use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerBootstrap {
    port: u16,
    running: bool,
    bin_path: String,
}

fn check_server(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) else {
        return false;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));

    if stream
        .write_all(b"GET /api/sessions HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }

    let mut buf = [0_u8; 16];
    match stream.read(&mut buf) {
        Ok(read) if read > 0 => buf[..read].starts_with(b"HTTP/1.1 200") || buf[..read].starts_with(b"HTTP/1.0 200"),
        _ => false,
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(".."))
}

fn candidate_bins(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut bins = Vec::new();
    if let Ok(env_bin) = env::var("TTYM_NATIVE_SERVER_BIN") {
        bins.push(PathBuf::from(env_bin));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        bins.push(resource_dir.join("dist").join("ttym"));
        bins.push(resource_dir.join("ttym"));
    }

    let root = repo_root();
    if root.exists() {
        bins.push(root.join("dist").join("ttym"));
    }

    bins.push(PathBuf::from("ttym"));
    bins
}

fn resolve_bin(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    candidate_bins(app)
        .into_iter()
        .find(|path| path.exists() || path == Path::new("ttym"))
        .ok_or_else(|| {
            "could not locate `ttym` launcher; set TTYM_NATIVE_SERVER_BIN, install `ttym` on PATH, or provide bundled `dist/ttym` resources"
                .to_string()
        })
}

#[tauri::command]
fn ensure_local_server(app: tauri::AppHandle, port: Option<u16>) -> Result<ServerBootstrap, String> {
    let port = port.unwrap_or(7690);
    if check_server(port) {
        return Ok(ServerBootstrap {
            port,
            running: true,
            bin_path: "already-running".to_string(),
        });
    }

    let bin = resolve_bin(&app)?;
    let mut cmd = Command::new(&bin);
    cmd.arg("start").arg("--port").arg(port.to_string());

    // The launcher already detaches the actual daemon. Keep this command quiet.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    let status = cmd.status().map_err(|err| format!("failed to start `{}`: {err}", bin.display()))?;

    if !status.success() && !check_server(port) {
        return Err(format!("`{}` exited with status {status}", bin.display()));
    }

    Ok(ServerBootstrap {
        port,
        running: true,
        bin_path: bin.display().to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ensure_local_server])
        .run(tauri::generate_context!())
        .expect("error while running ttym-native");
}
