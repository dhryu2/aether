//! Aether 메뉴 막대 관리 앱. 창과 Dock 아이콘 없이 서버 자식 프로세스를 감시한다.
mod admin;
mod login_item;
mod supervisor;
mod text;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use supervisor::{config_dir, core_dir, Cmd, State, Supervisor};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_plugin_notification::NotificationExt;
use text::{tr, Action};

#[derive(Clone)]
struct Items {
    status: MenuItem<tauri::Wry>,
    open: MenuItem<tauri::Wry>,
    serve: CheckMenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
    toggle: MenuItem<tauri::Wry>,
}

impl Items {
    /// 메뉴 항목 조작은 tauri가 메인 스레드로 넘겨 주므로 어느 스레드에서 불러도 된다.
    fn apply(&self, tray: &tauri::tray::TrayIcon, state: State, serving: bool) {
        let m = text::menu_model(state, serving);
        let _ = self.status.set_text(m.status);
        let _ = self.open.set_enabled(m.open);
        let _ = self.serve.set_enabled(m.serve);
        let _ = self.restart.set_enabled(m.restart);
        let _ = self.toggle.set_text(if m.start { tr("서버 시작", "Start Server") } else { tr("서버 중지…", "Stop Server…") });
        let warn = matches!(state, State::Stopped | State::Error);
        let png: &[u8] = if warn { include_bytes!("../icons/tray-warn.png") } else { include_bytes!("../icons/tray-ok.png") };
        if let Ok(img) = Image::from_bytes(png) {
            let _ = tray.set_icon(Some(img));
            let _ = tray.set_icon_as_template(true);
        }
    }
}

fn open(target: &str) {
    let _ = std::process::Command::new("/usr/bin/open").arg(target).spawn();
}

// 미확인: 널리 쓰이는 값이나 이 맥에서 열어 보지 않았다.
const URL_FULL_DISK: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
const URL_SCREEN_REC: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

fn port_of(s: State) -> Option<u16> {
    match s {
        State::Running(p) | State::Setup(p) => Some(p),
        _ => None,
    }
}

/// 서버가 실행 중이면 세션 수를 물어 확인 창을 띄운다. 진행해도 되면 true.
/// 메인 스레드 밖에서만 부른다(blocking_show).
fn confirm(app: &AppHandle, sup: &Supervisor, a: Action) -> bool {
    let (state, token) = sup.info();
    // 첫 설정 서버에는 관리 API도 세션도 없다. 실행 중일 때만 묻는다.
    let State::Running(port) = state else { return true };
    let sessions = admin::running_sessions(port, &token).ok();
    if sessions == Some(0) {
        return true;
    }
    let (title, body, ok, cancel) = text::confirm(a, sessions);
    app.dialog().message(body).title(title).buttons(MessageDialogButtons::OkCancelCustom(ok, cancel)).blocking_show()
}

/// 설정 폴더 config.json의 dataDir 아래 logs. 없으면 <설정 폴더>/data/logs, 그 폴더도 없으면 설정 폴더.
fn log_dir() -> std::path::PathBuf {
    let cfg = config_dir();
    let data = std::fs::read_to_string(cfg.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["dataDir"].as_str().map(str::to_owned))
        .map(|d| match d.strip_prefix("~/") {
            Some(rest) => std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(rest),
            None => d.into(),
        })
        .unwrap_or_else(|| cfg.join("data"));
    let logs = data.join("logs");
    if logs.is_dir() { logs } else { cfg }
}

fn main() {
    let serving = Arc::new(AtomicBool::new(false));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let h = app.handle();
            let items = Items {
                status: MenuItem::with_id(h, "status", tr("시작 중…", "Starting…"), false, None::<&str>)?,
                open: MenuItem::with_id(h, "open", tr("웹 화면 열기", "Open Web UI"), false, None::<&str>)?,
                serve: CheckMenuItem::with_id(h, "serve", tr("웹 화면 제공", "Serve Web UI"), false, false, None::<&str>)?,
                restart: MenuItem::with_id(h, "restart", tr("서버 재시작…", "Restart Server…"), false, None::<&str>)?,
                toggle: MenuItem::with_id(h, "toggle", tr("서버 중지…", "Stop Server…"), true, None::<&str>)?,
            };
            let update = MenuItem::with_id(h, "update", tr("업데이트 적용…", "Apply Update…"), true, None::<&str>)?;
            let logs = MenuItem::with_id(h, "logs", tr("로그 폴더 열기", "Open Logs Folder"), true, None::<&str>)?;
            let perms = MenuItem::with_id(h, "perms", tr("권한 설정…", "Permissions…"), true, None::<&str>)?;
            let quit = MenuItem::with_id(h, "quit", tr("Aether 종료…", "Quit Aether…"), true, None::<&str>)?;
            let sep = || PredefinedMenuItem::separator(h);
            let menu = Menu::with_items(h, &[
                &items.status, &sep()?, &items.open, &items.serve, &sep()?,
                &items.restart, &items.toggle, &update, &sep()?, &logs, &perms, &sep()?, &quit,
            ])?;
            let tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Aether")
                .icon(Image::from_bytes(include_bytes!("../icons/tray-ok.png"))?)
                .icon_as_template(true)
                .build(h)?;

            // 감시 스레드는 on_change를 만들 때 아직 없는 Supervisor가 필요 없다. 상태만 받는다.
            let (it, tr2, sv, hh) = (items.clone(), tray.clone(), serving.clone(), h.clone());
            let sup_cell: Arc<std::sync::OnceLock<Supervisor>> = Arc::new(std::sync::OnceLock::new());
            let cell = sup_cell.clone();
            let notify = hh.clone();
            let on_change = move |s: State| {
                if s == State::Error {
                    let (title, body) = text::server_down();
                    let _ = notify.notification().builder().title(title).body(body).show();
                }
                it.apply(&tr2, s, sv.load(Ordering::Relaxed));
                if let (State::Running(port), Some(sup)) = (s, cell.get()) {
                    // 실행 중에 들어갈 때 현재 제공 여부를 읽어 체크를 맞춘다
                    let (it, tr2, sv, sup) = (it.clone(), tr2.clone(), sv.clone(), sup.clone());
                    std::thread::spawn(move || {
                        if let Ok(list) = admin::get_screens(port, &sup.info().1) {
                            let on = list.iter().any(|s| s["prefix"] == "/");
                            sv.store(on, Ordering::Relaxed);
                            let _ = it.serve.set_checked(on);
                            it.apply(&tr2, State::Running(port), on);
                        }
                    });
                }
            };
            let app_quit = hh.clone();
            let sup = supervisor::start(on_change, move || app_quit.exit(0));
            let _ = sup_cell.set(sup.clone());

            let (items, sv) = (items.clone(), serving.clone());
            let h2 = h.clone();
            app.on_menu_event(move |_, ev| {
                let (app, sup, items, sv) = (h2.clone(), sup.clone(), items.clone(), sv.clone());
                let id = ev.id().as_ref().to_owned();
                // 확인 창과 관리 호출이 메뉴(메인 스레드)를 막지 않게 따로 돌린다
                std::thread::spawn(move || {
                    let (state, token) = sup.info();
                    match id.as_str() {
                        "open" => {
                            if let Some(p) = port_of(state) {
                                open(&format!("http://127.0.0.1:{p}/"));
                            }
                        }
                        "serve" => {
                            // 눌린 항목은 muda가 이미 토글했으므로 지금 값이 원하는 값이다
                            let Some(port) = port_of(state) else { return };
                            let want = items.serve.is_checked().unwrap_or(false);
                            let dir = format!("{}/web/dist", core_dir().display());
                            let list = if want { vec![serde_json::json!({"prefix": "/", "dir": dir})] } else { vec![] };
                            if admin::put_screens(port, &token, list).is_ok() {
                                sv.store(want, Ordering::Relaxed);
                                let _ = items.open.set_enabled(want || matches!(state, State::Setup(_)));
                            } else {
                                let _ = items.serve.set_checked(!want);
                            }
                        }
                        "restart" => {
                            if confirm(&app, &sup, Action::Restart) {
                                sup.send(Cmd::Restart);
                            }
                        }
                        "update" => {
                            if !config_dir().join("update/Aether.app").is_dir() {
                                let (title, body) = text::no_update();
                                app.dialog().message(body).title(title).blocking_show();
                            } else if confirm(&app, &sup, Action::Update) {
                                // 교체 스크립트는 새 세션으로 떨어져 나가 앱이 종료돼도 끝까지 돈다
                                let script = std::env::current_exe().unwrap_or_default().with_file_name("../Resources/apply-update.sh");
                                if std::process::Command::new("/bin/bash").arg(script).arg("--detach").env("AETHER_APP_BASE", config_dir()).spawn().is_err() {
                                    let (title, body) = text::update_failed();
                                    app.dialog().message(body).title(title).blocking_show();
                                }
                            }
                        }
                        "toggle" => match state {
                            State::Stopped | State::Error => sup.send(Cmd::Start),
                            _ => {
                                if confirm(&app, &sup, Action::Stop) {
                                    sup.send(Cmd::Stop);
                                }
                            }
                        },
                        "logs" => open(&log_dir().to_string_lossy()),
                        "perms" => {
                            let (title, body, disk, screen, close) = text::permissions();
                            let r = app.dialog().message(body).title(title)
                                .buttons(MessageDialogButtons::YesNoCancelCustom(disk.into(), screen.into(), close.into()))
                                .blocking_show_with_result();
                            if let MessageDialogResult::Custom(l) = r {
                                if l == disk { open(URL_FULL_DISK) } else if l == screen { open(URL_SCREEN_REC) }
                            }
                        }
                        "quit" => {
                            if confirm(&app, &sup, Action::Quit) {
                                sup.send(Cmd::Quit);
                            }
                        }
                        _ => {}
                    }
                });
            });

            login_item::register_once();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("앱을 만들지 못했습니다");
    // 창이 없어도 앱은 계속 돈다. 종료는 메뉴의 종료(app.exit)만 쓴다.
    app.run(|_, ev| {
        if let RunEvent::ExitRequested { api, code: None, .. } = ev {
            api.prevent_exit();
        }
    });
}
