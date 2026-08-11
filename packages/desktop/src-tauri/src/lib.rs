//! ttym desktop — a native shell around the served web UI.
//!
//! The webview loads http://127.0.0.1:{port} — the exact app the browser
//! gets, so every UI change lands here with zero porting. What stays native
//! is only what a browser cannot do: boot the daemon, own real windows and
//! menus, and mark the page as native via an injected `__TTYM_NATIVE__` so
//! the web chrome makes room for the traffic lights.

use serde::Serialize;
use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerBootstrap {
    port: u16,
    running: bool,
    bin_path: String,
}

/// TTYM_PORT picks the server instance — the same contract sessions get from
/// the server itself. Defaults to production's 7690; a dev shell runs
/// `TTYM_PORT=7691 tauri dev` to attach to the dev instance instead.
fn target_port() -> u16 {
    env::var("TTYM_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(7690)
}

fn check_server(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) else {
        return false;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));

    if stream
        .write_all(b"GET /api/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
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
        .join("..")
        .canonicalize()
        .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join(".."))
}

fn candidate_bins(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut bins = Vec::new();
    if let Ok(env_bin) = env::var("TTYM_NATIVE_SERVER_BIN") {
        bins.push(PathBuf::from(env_bin));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        // Tauri encodes a `../../../dist` resource path as `_up_/_up_/_up_/dist`
        // inside Resources — measured on the shipped bundle, not guessed.
        bins.push(resource_dir.join("_up_").join("_up_").join("_up_").join("dist").join("ttym"));
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

/// Called by the launcher page: make sure a server answers on the target
/// port, then hand the port back so the page can navigate to it.
#[tauri::command]
fn bootstrap(app: tauri::AppHandle) -> Result<ServerBootstrap, String> {
    let port = target_port();
    if check_server(port) {
        return Ok(ServerBootstrap { port, running: true, bin_path: "already-running".to_string() });
    }

    let bin = resolve_bin(&app)?;
    let mut cmd = Command::new(&bin);
    cmd.arg("start").arg("--port").arg(port.to_string());
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    let status = cmd
        .status()
        .map_err(|err| format!("failed to start `{}`: {err}", bin.display()))?;

    // The daemon detaches; poll briefly until it answers.
    for _ in 0..40 {
        if check_server(port) {
            return Ok(ServerBootstrap { port, running: true, bin_path: bin.display().to_string() });
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    Err(format!("`{}` exited with status {status} and the server never came up", bin.display()))
}

fn open_window(app: &tauri::AppHandle) -> Result<String, String> {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_millis();
    let label = if app.get_webview_window("main").is_none() {
        "main".to_string()
    } else {
        format!("main-{suffix}")
    };

    tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title("ttym")
        .inner_size(1480.0, 920.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // Logical, not Physical — a physical 14 halves to 7pt on retina and
        // floats the lights above the strip. 15pt centers them in the 42pt bar.
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 15.0))
        // 내장 폴리필(20% 스텝, 20~1000%)은 너무 성기다 — 웹 앱이 ⌘+/−/0을
        // 직접 받아 5% 스텝으로 set_webview_zoom을 호출한다.
        .zoom_hotkeys_enabled(false)
        .initialization_script(
            // Every page in this webview — launcher and served UI alike —
            // sees the native marker. Pure data, no IPC surface exposed to
            // the remote origin. The label lets the page tell windows apart.
            &format!(
                "window.__TTYM_NATIVE__ = {{ shell: 'tauri', platform: 'macos', label: '{label}' }};"
            ),
        )
        .build()
        .map_err(|err| format!("failed to open window: {err}"))?;

    Ok(label)
}

#[tauri::command]
fn new_window(app: tauri::AppHandle) -> Result<String, String> {
    open_window(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![bootstrap, new_window])
        .setup(|app| {
            let handle = app.handle();

            // A real menu: Edit is what makes ⌘C/⌘V work inside the webview
            // on macOS, and File carries the one native verb the web cannot.
            let new_window_item = MenuItemBuilder::with_id("new-window", "New Window")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let reload_item = MenuItemBuilder::with_id("reload", "Reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "ttym")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .separator()
                .quit()
                .build()?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_window_item)
                .item(&reload_item)
                .separator()
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .separator()
                .fullscreen()
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
                .build()?;
            app.set_menu(menu)?;

            let menu_handle = handle.clone();
            app.on_menu_event(move |_app, event| {
                if event.id() == "new-window" {
                    let _ = open_window(&menu_handle);
                } else if event.id() == "reload" {
                    for (_, window) in menu_handle.webview_windows() {
                        if window.is_focused().unwrap_or(false) {
                            let _ = window.eval("location.reload()");
                        }
                    }
                }
            });

            open_window(handle)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ttym");
}
