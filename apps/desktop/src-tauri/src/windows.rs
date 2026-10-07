use crate::{logging, runtime::ShellState};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use url::Url;

struct BrowserWindow {
    label: String,
    invalid: Arc<AtomicBool>,
}

pub struct WindowRegistry {
    labels: Mutex<HashMap<String, BrowserWindow>>,
    sequence: AtomicU64,
    data_directory: PathBuf,
}

impl WindowRegistry {
    pub fn new(data_directory: PathBuf) -> Self {
        Self {
            labels: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
            data_directory,
        }
    }
}

pub fn open_control(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("control") {
        return show(&window);
    }
    let window = WebviewWindowBuilder::new(app, "control", WebviewUrl::App("index.html".into()))
        .title("Pi Desk")
        .inner_size(960.0, 720.0)
        .min_inner_size(720.0, 560.0)
        .on_page_load(|window, payload| {
            let state = window.app_handle().state::<ShellState>();
            logging::write(
                &state.log_path,
                "control-page-load",
                &format!("event={:?} url={}", payload.event(), payload.url()),
            );
        })
        .build()
        .map_err(|error| format!("打开控制中心失败：{error}"))?;
    let hidden = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hidden.hide();
        }
    });
    show(&window)
}

fn show(window: &WebviewWindow) -> Result<(), String> {
    let state = window.app_handle().state::<ShellState>();
    logging::write(
        &state.log_path,
        "window-show",
        &format!("label={} source=user", window.label()),
    );
    window
        .unminimize()
        .map_err(|error| format!("恢复窗口失败：{error}"))?;
    window
        .show()
        .map_err(|error| format!("显示窗口失败：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("聚焦窗口失败：{error}"))
}

pub fn open_browser(app: &AppHandle, value: &str) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let registry = &state.windows;
    let url = Url::parse(value).map_err(|_| "网页地址无效".to_string())?;
    // 同一网址串行创建窗口；已有窗口只显示，不触发页面重载。
    let mut labels = registry
        .labels
        .lock()
        .map_err(|_| "窗口状态不可用".to_string())?;
    if let Some((window, invalid)) = labels.get(value).and_then(|registered| {
        app.get_webview_window(&registered.label)
            .map(|window| (window, registered.invalid.load(Ordering::Acquire)))
    }) {
        if !invalid {
            return show(&window);
        }
        labels.remove(value);
        drop(labels);
        logging::write(
            &state.log_path,
            "browser-recreate",
            &format!("label={} url={value}", window.label()),
        );
        window
            .destroy()
            .map_err(|error| format!("释放失效网页窗口失败：{error}"))?;
        return open_browser(app, value);
    }
    let label = format!(
        "browser-{}",
        registry.sequence.fetch_add(1, Ordering::Relaxed)
    );
    let origin = url.origin();
    let navigate_app = app.clone();
    let popup_app = app.clone();
    let popup_label = label.clone();
    let invalid = Arc::new(AtomicBool::new(false));
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.clone()))
        .title(format!("Pi Desk · {}", url.host_str().unwrap_or("网页")))
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .on_navigation(move |next| {
            if next.origin() == origin {
                return true;
            }
            if !matches!(next.scheme(), "http" | "https") {
                return false;
            }
            !open_external(&navigate_app, next, "navigation")
        })
        .on_new_window(move |next, _| {
            let state = popup_app.state::<ShellState>();
            let supported = matches!(next.scheme(), "http" | "https");
            logging::write(
                &state.log_path,
                "browser-new-window-request",
                &format!("label={popup_label} url={next} supported={supported}"),
            );
            if !supported {
                return NewWindowResponse::Deny;
            }
            if open_external(&popup_app, &next, "new-window") {
                NewWindowResponse::Deny
            } else {
                NewWindowResponse::Allow
            }
        })
        .on_page_load(|window, payload| {
            let state = window.app_handle().state::<ShellState>();
            logging::write(
                &state.log_path,
                "browser-page-load",
                &format!(
                    "label={} event={:?} url={}",
                    window.label(),
                    payload.event(),
                    payload.url()
                ),
            );
        });
    #[cfg(not(target_os = "macos"))]
    let builder = builder.data_directory(registry.data_directory.clone());
    let window = builder
        .build()
        .map_err(|error| format!("创建网页窗口失败：{error}"))?;
    #[cfg(windows)]
    watch_process(&window, invalid.clone())?;
    labels.insert(
        value.to_string(),
        BrowserWindow {
            label: label.clone(),
            invalid,
        },
    );
    drop(labels);
    let app_for_close = app.clone();
    let target = value.to_string();
    let hidden = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hidden.hide();
        }
        if matches!(event, WindowEvent::Destroyed) {
            let state = app_for_close.state::<ShellState>();
            if let Ok(mut labels) = state.windows.labels.lock() {
                if labels.get(&target).map(|registered| &registered.label) == Some(&label) {
                    labels.remove(&target);
                }
            }
            logging::write(
                &state.log_path,
                "browser-destroyed",
                &format!("label={label} url={target}"),
            );
        }
    });
    show(&window)
}

pub fn remove(app: &AppHandle, url: &str) {
    let state = app.state::<ShellState>();
    let label = state
        .windows
        .labels
        .lock()
        .ok()
        .and_then(|mut labels| labels.remove(url));
    if let Some(window) = label.and_then(|registered| app.get_webview_window(&registered.label)) {
        let _ = window.destroy();
    }
}

#[cfg(windows)]
fn watch_process(window: &WebviewWindow, invalid: Arc<AtomicBool>) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    };
    use webview2_com::ProcessFailedEventHandler;

    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window
        .with_webview(move |platform| {
            let result = unsafe {
                platform.controller().CoreWebView2().and_then(|webview| {
                    let event_app = app.clone();
                    let event_label = label.clone();
                    let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
                        args.ProcessFailedKind(&mut kind)?;
                        let requires_recreation = matches!(
                            kind,
                            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
                                | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                        );
                        if requires_recreation {
                            invalid.store(true, Ordering::Release);
                        }
                        let state = event_app.state::<ShellState>();
                        logging::write(
                            &state.log_path,
                            "browser-process-failed",
                            &format!(
                                "label={event_label} kind={} requires_recreation={requires_recreation}",
                                kind.0
                            ),
                        );
                        Ok(())
                    }));
                    let mut token = 0;
                    webview.add_ProcessFailed(&handler, &mut token)
                })
            };
            if let Err(error) = result {
                let state = app.state::<ShellState>();
                logging::write(
                    &state.log_path,
                    "browser-process-watch-failed",
                    &format!("label={label} error={error}"),
                );
            }
        })
        .map_err(|error| format!("监听网页进程失败：{error}"))
}

fn open_external(app: &AppHandle, url: &Url, source: &str) -> bool {
    let state = app.state::<ShellState>();
    match webbrowser::open(url.as_str()) {
        Ok(()) => {
            logging::write(
                &state.log_path,
                "browser-external-open",
                &format!("source={source} url={url}"),
            );
            true
        }
        Err(error) => {
            logging::write(
                &state.log_path,
                "browser-external-open-failed",
                &format!("source={source} url={url} error={error}"),
            );
            false
        }
    }
}
