#[cfg(windows)]
use crate::{logging, runtime::ShellState};
#[cfg(windows)]
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use tauri::Manager;
use tauri::WebviewWindow;

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Action {
    Attach,
    Detach,
    State,
    Drag,
    Minimize,
    ToggleMaximize,
    Close,
}

#[cfg(windows)]
impl Action {
    fn name(self) -> &'static str {
        match self {
            Self::Attach => "attach",
            Self::Detach => "detach",
            Self::State => "state",
            Self::Drag => "drag",
            Self::Minimize => "minimize",
            Self::ToggleMaximize => "toggle-maximize",
            Self::Close => "close",
        }
    }
}

#[cfg(windows)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    action: Action,
}

#[cfg(windows)]
#[derive(Serialize)]
struct WindowState {
    maximized: bool,
}

pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(windows)]
    let builder = builder.register_asynchronous_uri_scheme_protocol(
        "pi-desk-window",
        |context, request, responder| {
            let app = context.app_handle().clone();
            let label = context.webview_label().to_string();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(handle(&app, &label, request));
            });
        },
    );
    builder
}

#[cfg(windows)]
fn handle(
    app: &tauri::AppHandle,
    label: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let expected = crate::windows::window_origin(app, label);
    let origin = request
        .headers()
        .get("Origin")
        .and_then(|value| value.to_str().ok())
        .filter(|source| {
            expected
                .as_ref()
                .is_some_and(|expected| same_origin(source, expected))
        });
    let (Some(window), Some(origin)) = (app.get_webview_window(label), origin) else {
        return response(403, None, serde_json::json!("窗口来源不受信任"));
    };
    if request.uri().path() != "/" {
        return response(400, Some(origin), serde_json::json!("窗口操作地址无效"));
    }
    if request.method() == tauri::http::Method::OPTIONS {
        return response(204, Some(origin), serde_json::Value::Null);
    }
    if request.method() != tauri::http::Method::POST {
        return response(400, Some(origin), serde_json::json!("窗口操作仅支持 POST"));
    }
    let Ok(Request { action }) = serde_json::from_slice::<Request>(request.body()) else {
        return response(400, Some(origin), serde_json::json!("窗口操作参数无效"));
    };
    match perform(&window, action) {
        Ok(state) => response(200, Some(origin), serde_json::json!(state)),
        Err(error) => {
            failed(&window, action.name(), &error);
            response(500, Some(origin), serde_json::json!(error.to_string()))
        }
    }
}

#[cfg(windows)]
fn response(
    status: u16,
    origin: Option<&str>,
    body: serde_json::Value,
) -> tauri::http::Response<Vec<u8>> {
    let mut response = tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "application/json");
    if let Some(origin) = origin {
        response = response.header("Access-Control-Allow-Origin", origin);
    }
    let body = if status == 204 {
        response = response
            .header("Access-Control-Allow-Methods", "POST")
            .header("Access-Control-Allow-Headers", "Content-Type");
        Vec::new()
    } else {
        serde_json::to_vec(&body).expect("无法序列化窗口操作响应")
    };
    response.body(body).expect("无法构建窗口操作响应")
}

#[cfg(windows)]
fn same_origin(source: &str, expected: &url::Origin) -> bool {
    url::Url::parse(source).is_ok_and(|url| &url.origin() == expected)
}

#[cfg(windows)]
fn failed(window: &WebviewWindow, action: &str, error: &dyn std::fmt::Display) {
    let state = window.app_handle().state::<ShellState>();
    logging::write(
        &state.log_path,
        "window-chrome-failed",
        &format!("label={} action={action} error={error}", window.label()),
    );
}

#[cfg(windows)]
fn perform(window: &WebviewWindow, action: Action) -> tauri::Result<WindowState> {
    match action {
        Action::Attach => set_decorations(window, false)?,
        Action::Detach => set_decorations(window, true)?,
        Action::State => {}
        Action::Drag => window.start_dragging()?,
        Action::Minimize => window.minimize()?,
        Action::ToggleMaximize => {
            if window.is_maximized()? {
                window.unmaximize()?;
            } else {
                window.maximize()?;
            }
        }
        Action::Close => {
            // 临时预览可在 CloseRequested 后销毁，不能再查询窗口状态。
            let maximized = window.is_maximized()?;
            window.close()?;
            return Ok(WindowState { maximized });
        }
    }
    Ok(WindowState {
        maximized: window.is_maximized()?,
    })
}

#[cfg(windows)]
fn set_decorations(window: &WebviewWindow, decorated: bool) -> tauri::Result<()> {
    if window.is_decorated()? != decorated {
        window.set_decorations(decorated)?;
    }
    Ok(())
}

pub fn restore(window: &WebviewWindow, reason: &str) {
    #[cfg(windows)]
    if let Err(error) = set_decorations(window, true) {
        let state = window.app_handle().state::<ShellState>();
        logging::write(
            &state.log_path,
            "window-chrome-failed",
            &format!(
                "label={} action=restore reason={reason} error={error}",
                window.label()
            ),
        );
    }
    #[cfg(not(windows))]
    let _ = (window, reason);
}

#[cfg(all(test, windows))]
mod tests {
    use super::{response, same_origin, Request};
    use serde_json::json;

    #[test]
    fn requests_only_accept_supported_actions_without_other_targets() {
        for action in [
            "attach",
            "detach",
            "state",
            "drag",
            "minimize",
            "toggle-maximize",
            "close",
        ] {
            assert!(serde_json::from_value::<Request>(json!({"action":action})).is_ok());
        }
        for value in [
            json!({"action":"destroy"}),
            json!({"action":"close","label":"control"}),
            json!({"action":"state","origin":"http://trusted.test"}),
            json!({}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
    }

    #[test]
    fn origins_match_scheme_host_and_port_not_page_path() {
        let origin = url::Url::parse("https://example.test:8443/")
            .unwrap()
            .origin();
        assert!(same_origin(
            "https://example.test:8443/project-preview?cwd=test",
            &origin
        ));
        for source in [
            "https://example.test/",
            "http://example.test:8443/",
            "https://other.test:8443/",
            "null",
            "invalid",
        ] {
            assert!(!same_origin(source, &origin));
        }
    }

    #[test]
    fn protocol_responses_only_allow_the_verified_origin() {
        let denied = response(403, None, json!("窗口来源不受信任"));
        assert!(!denied.headers().contains_key("Access-Control-Allow-Origin"));
        let preflight = response(204, Some("http://127.0.0.1:30333"), serde_json::Value::Null);
        assert_eq!(
            preflight.headers()["Access-Control-Allow-Origin"],
            "http://127.0.0.1:30333"
        );
        assert_eq!(preflight.headers()["Access-Control-Allow-Methods"], "POST");
        assert_eq!(
            preflight.headers()["Access-Control-Allow-Headers"],
            "Content-Type"
        );
        assert!(preflight.body().is_empty());
    }

    #[test]
    fn browser_windows_have_no_tauri_command_or_remote_permissions() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(capability["permissions"], json!([]));
        assert!(capability.get("remote").is_none());
    }
}
