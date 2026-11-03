//! Aether 데스크톱 껍데기 — 창·트레이·단축키·알림만. HTTP 서버·DB·모델 없음.

mod start_url;

use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use start_url::{choose_start_raw, prepare_start_url};

fn smoke_line(line: &str) {
    println!("{line}");
    let _ = io::stdout().flush();
}
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

static SMOKE: AtomicBool = AtomicBool::new(false);
static NOTIFY_FROM_WEB: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Default)]
struct SmokeFlags {
    rooms: bool,
}

fn desktop_shortcut() -> Shortcut {
    #[cfg(windows)]
    {
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyA)
    }
    #[cfg(not(windows))]
    {
        Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyA)
    }
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("server_url"))
}

#[tauri::command]
fn show_desktop_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    NOTIFY_FROM_WEB.store(true, Ordering::SeqCst);
    if SMOKE.load(Ordering::SeqCst) {
        return Ok(());
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn smoke_report_rooms(n: u32, flags: tauri::State<'_, Arc<Mutex<SmokeFlags>>>) -> Result<(), String> {
    if n >= 1 {
        if let Ok(mut f) = flags.lock() {
            f.rooms = true;
        }
    }
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

fn inject_room_watcher(window: &WebviewWindow) {
    let _ = window.eval(
        r#"
(() => {
  try { document.hasFocus = () => false; } catch (e) {}
  const tick = () => {
    try {
      const n = document.querySelectorAll('[data-room-id]').length;
      const hasTauri = !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
      document.title = 'Aether|rooms=' + n + '|tauri=' + (hasTauri ? '1' : '0');
      if (n >= 1 && hasTauri) {
        window.__TAURI__.core.invoke('smoke_report_rooms', { n: n });
      }
    } catch (e) {}
    setTimeout(tick, 250);
  };
  setTimeout(tick, 200);
})();
"#,
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let smoke = std::env::var("AETHER_DESKTOP_SMOKE").ok().as_deref() == Some("1");
    SMOKE.store(smoke, Ordering::SeqCst);
    let flags = Arc::new(Mutex::new(SmokeFlags::default()));
    let flags_setup = flags.clone();

    // 트레이·단축키가 같은 보이기/숨기기 핸들러를 쓰도록 보관(스모크가 그 핸들러를 실행)
    let show_handler: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>> = Arc::new(Mutex::new(None));
    let hide_handler: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>> = Arc::new(Mutex::new(None));
    let shortcut_handler: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>> = Arc::new(Mutex::new(None));

    let show_for_tray = show_handler.clone();
    let hide_for_tray = hide_handler.clone();
    let sc_for_plugin = shortcut_handler.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |_app, shortcut, event| {
                    let want = desktop_shortcut();
                    if *shortcut == want && event.state() == ShortcutState::Pressed {
                        if let Ok(guard) = sc_for_plugin.lock() {
                            if let Some(cb) = guard.as_ref() {
                                cb();
                            }
                        }
                    }
                })
                .build(),
        )
        .manage(flags.clone())
        .invoke_handler(tauri::generate_handler![
            show_desktop_notification,
            smoke_report_rooms
        ])
        .setup(move |app| {
            let env_url = std::env::var("AETHER_DESKTOP_URL").ok();
            let file_url = config_path(&app.handle()).and_then(|p| std::fs::read_to_string(p).ok());
            let raw = choose_start_raw(env_url.as_deref(), file_url.as_deref());
            let start = match prepare_start_url(&raw) {
                Ok(u) => u,
                Err(_) => {
                    eprintln!("start url rejected: {raw}");
                    std::process::exit(1);
                }
            };
            if smoke && start.contains("8787") {
                eprintln!("SMOKE_FAIL: 8787 forbidden");
                std::process::exit(1);
            }

            let parsed: tauri::Url = match start.parse() {
                Ok(u) => u,
                Err(_) => {
                    eprintln!("start url parse failed: {start}");
                    std::process::exit(1);
                }
            };
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("Aether")
                .inner_size(1280.0, 800.0)
                .resizable(true)
                .build()?;

            smoke_line(&format!("START_URL={start}"));
            // 릴리스 앱은 stdout 없이 origin을 회수한다. 쓰기 실패해도 창은 연다.
            if let Ok(dir) = app.path().app_config_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let _ = std::fs::write(dir.join("last_start_url"), format!("{start}\n"));
            }

            if smoke {
                smoke_line("SMOKE_WINDOW");
                let _ = window.hide();
            }

            inject_room_watcher(&window);

            let app_show = app.handle().clone();
            let show_fn: Arc<dyn Fn() + Send + Sync> = Arc::new(move || show_main(&app_show));
            let app_hide = app.handle().clone();
            let hide_fn: Arc<dyn Fn() + Send + Sync> = Arc::new(move || hide_main(&app_hide));
            let app_sc = app.handle().clone();
            let sc_fn: Arc<dyn Fn() + Send + Sync> = Arc::new(move || show_main(&app_sc));

            *show_handler.lock().unwrap() = Some(show_fn.clone());
            *hide_handler.lock().unwrap() = Some(hide_fn.clone());
            *shortcut_handler.lock().unwrap() = Some(sc_fn);

            let show_item = MenuItem::with_id(app, "show", "열기", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "숨기기", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

            let app_tray = app.handle().clone();
            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Aether")
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Ok(guard) = show_for_tray.lock() {
                                if let Some(cb) = guard.as_ref() {
                                    cb();
                                    return;
                                }
                            }
                            show_main(app);
                        }
                        "hide" => {
                            if let Ok(guard) = hide_for_tray.lock() {
                                if let Some(cb) = guard.as_ref() {
                                    cb();
                                    return;
                                }
                            }
                            hide_main(app);
                        }
                        "quit" => app_tray.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;

            let _ = app.global_shortcut().unregister(desktop_shortcut());
            if let Err(e) = app.global_shortcut().register(desktop_shortcut()) {
                eprintln!("shortcut register skipped: {e}");
            }

            let w2 = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = w2.hide();
                }
            });

            if smoke {
                let app_smoke = app.handle().clone();
                let flags_smoke = flags_setup.clone();
                let show_smoke = show_handler.clone();
                let hide_smoke = hide_handler.clone();
                let sc_smoke = shortcut_handler.clone();
                let win_smoke = window.clone();
                std::thread::spawn(move || {
                    let deadline = Instant::now() + Duration::from_secs(80);
                    loop {
                        if Instant::now() > deadline {
                            let title = win_smoke.title().unwrap_or_default();
                            eprintln!("SMOKE_FAIL: rooms timeout title={title}");
                            let _ = io::stderr().flush();
                            app_smoke.exit(1);
                            return;
                        }
                        // 페이지 로드 레이스 대비 주기적으로 watcher 재주입
                        inject_room_watcher(&win_smoke);
                        if let Ok(title) = win_smoke.title() {
                            if title.contains("rooms=") {
                                if let Some(rest) = title.split("rooms=").nth(1) {
                                    let n: u32 = rest
                                        .split('|')
                                        .next()
                                        .and_then(|s| s.parse().ok())
                                        .unwrap_or(0);
                                    if n >= 1 {
                                        if let Ok(mut f) = flags_smoke.lock() {
                                            f.rooms = true;
                                        }
                                    }
                                }
                            }
                        }
                        if flags_smoke.lock().map(|f| f.rooms).unwrap_or(false) {
                            let title = win_smoke.title().unwrap_or_default();
                            smoke_line("SMOKE_ROOMS");
                            eprintln!("SMOKE_DEBUG title={title}");
                            let _ = io::stderr().flush();
                            let _ = win_smoke.hide();
                            // React notify 구독이 hasFocus로 스킵하지 않게, 그리고 스트림을 한 번 더 연다
                            let _ = win_smoke.eval(
                                r#"
(() => {
  try { document.hasFocus = () => false; } catch (e) {}
  if (!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)) {
    document.title = (document.title || '') + '|noinvoke';
    return;
  }
  fetch('/api/notify/stream', { credentials: 'same-origin' }).then((res) => {
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) return;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        const lines = part.split('\n').filter((l) => l.startsWith('data:'));
        if (!lines.length) continue;
        try {
          const data = JSON.parse(lines.map((l) => l.slice(5).trimStart()).join('\n'));
          if (data && data.title) {
            window.__TAURI__.core.invoke('show_desktop_notification', {
              title: data.title,
              body: data.body || '',
            });
          }
        } catch (e) {}
      }
      return pump();
    });
    return pump();
  }).catch(() => {});
})();
"#,
                            );
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    loop {
                        if Instant::now() > deadline {
                            let title = win_smoke.title().unwrap_or_default();
                            eprintln!("SMOKE_FAIL: notify timeout title={title}");
                            let _ = io::stderr().flush();
                            app_smoke.exit(1);
                            return;
                        }
                        if NOTIFY_FROM_WEB.load(Ordering::SeqCst) {
                            smoke_line("SMOKE_NOTIFY");
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    if let Ok(guard) = show_smoke.lock() {
                        if let Some(cb) = guard.as_ref() {
                            cb();
                        }
                    }
                    if let Ok(guard) = hide_smoke.lock() {
                        if let Some(cb) = guard.as_ref() {
                            cb();
                        }
                    }
                    smoke_line("SMOKE_TRAY");
                    if let Ok(guard) = sc_smoke.lock() {
                        if let Some(cb) = guard.as_ref() {
                            cb();
                        }
                    }
                    smoke_line("SMOKE_SHORTCUT");
                    smoke_line("SMOKE_OK");
                    app_smoke.exit(0);
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Aether desktop failed to start");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            // 트레이 앱: 창 숨김만으로 프로세스 종료하지 않는다. app.exit(code)만 통과.
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}

#[cfg(test)]
mod shortcut_tests {
    use super::*;

    #[test]
    fn desktop_shortcut_matches_platform() {
        let got = desktop_shortcut();
        #[cfg(windows)]
        assert!(got.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyA));
        #[cfg(not(windows))]
        assert!(got.matches(Modifiers::SUPER | Modifiers::SHIFT, Code::KeyA));
    }
}
