use crate::{logging, runtime::ShellState};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, UserAttentionType, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

// 只复用官方插件的 Rust 状态；其默认 JS 会覆写所有网页的 Notification，
// 且另行注册 IPC。网页能力仅由下方限定当前窗口的提醒桥接提供。
struct NativeNotification(tauri::plugin::TauriPlugin<tauri::Wry>);

impl tauri::plugin::Plugin<tauri::Wry> for NativeNotification {
    fn name(&self) -> &'static str {
        "notification"
    }

    fn initialize(
        &mut self,
        app: &AppHandle,
        config: Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.0.initialize(app, config)
    }
}

#[cfg(target_os = "macos")]
#[path = "l4-reminder-macos.rs"]
mod macos;

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Request {
    Permission { request: bool },
    Notify { title: String, body: String },
    Attention {},
    Clear {},
}

pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let builder = builder.plugin(NativeNotification(tauri_plugin_notification::init()));
    #[cfg(windows)]
    let builder = builder.register_asynchronous_uri_scheme_protocol(
        "pi-desk-reminder",
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

pub fn script(origin: &url::Origin) -> String {
    include_str!("reminder.js")
        .replace(
            "__PLATFORM__",
            if cfg!(windows) { "windows" } else { "macos" },
        )
        .replace(
            "__ORIGIN__",
            &serde_json::to_string(&origin.ascii_serialization()).unwrap(),
        )
}

pub fn install(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    macos::install(window)?;
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

pub(crate) fn trusted_window(
    app: &AppHandle,
    label: &str,
    source: &str,
    expected: &url::Origin,
) -> Result<WebviewWindow, String> {
    let source = url::Url::parse(source).map_err(|_| "提醒来源无效")?;
    if &source.origin() != expected {
        return Err("提醒来源不受信任".into());
    }
    let window = app.get_webview_window(label).ok_or("工作台窗口已释放")?;
    if &window.url().map_err(|error| error.to_string())?.origin() != expected {
        return Err("工作台窗口已经导航到其他来源".into());
    }
    Ok(window)
}

pub(crate) fn perform(window: &WebviewWindow, request: Request) -> Result<Value, String> {
    let result = (|| -> Result<Value, String> {
        match request {
            Request::Permission { request } => {
                // 官方插件的桌面权限表示 API 可用，不读取系统的横幅/勿扰设置。
                let notification = window.app_handle().notification();
                let permission = if request {
                    notification.request_permission()
                } else {
                    notification.permission_state()
                }
                .map_err(|error| error.to_string())?;
                return Ok(json!(match permission {
                    tauri_plugin_notification::PermissionState::Granted => "granted",
                    tauri_plugin_notification::PermissionState::Denied => "denied",
                    _ => "default",
                }));
            }
            Request::Notify { title, body } => {
                // 不设置 sound：notify-rust 的 Windows 实现显式使用 silent=true，
                // macOS 不设置 soundName；不请求常驻提醒，收起行为由系统决定。
                window
                    .app_handle()
                    .notification()
                    .builder()
                    .title(title)
                    .body(body)
                    .show()
                    .map_err(|error| error.to_string())?;
            }
            Request::Attention {} => window
                .request_user_attention(Some(UserAttentionType::Informational))
                .map_err(|error| error.to_string())?,
            Request::Clear {} => window
                .request_user_attention(None)
                .map_err(|error| error.to_string())?,
        }
        Ok(Value::Null)
    })();
    if let Err(error) = &result {
        failed(window.app_handle(), window.label(), error);
    }
    result
}

pub fn clear(window: &WebviewWindow) {
    if let Err(error) = window.request_user_attention(None) {
        failed(window.app_handle(), window.label(), &error.to_string());
    }
}

fn failed(app: &AppHandle, label: &str, error: &str) {
    let state = app.state::<ShellState>();
    logging::write(
        &state.log_path,
        "reminder-failed",
        &format!("label={label} error={error}"),
    );
}

#[cfg(windows)]
fn handle(
    app: &AppHandle,
    label: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let origin = request
        .headers()
        .get("Origin")
        .and_then(|value| value.to_str().ok());
    let window = crate::windows::reminder_origin(app, label)
        .ok_or_else(|| "只有工作台窗口可以发送提醒".to_string())
        .and_then(|expected| {
            origin
                .ok_or_else(|| "提醒缺少来源".to_string())
                .and_then(|source| trusted_window(app, label, source, &expected))
        });
    let window = match window {
        Ok(window) => window,
        Err(error) => return response(403, None, json!(error)),
    };
    if request.uri().path() != "/" || request.uri().query().is_some() {
        return response(400, origin, json!("提醒操作地址无效"));
    }
    if request.method() == tauri::http::Method::OPTIONS {
        return response(204, origin, Value::Null);
    }
    if request.method() != tauri::http::Method::POST {
        return response(405, origin, json!("提醒仅支持 POST"));
    }
    let Ok(action) = serde_json::from_slice::<Request>(request.body()) else {
        return response(400, origin, json!("提醒参数无效"));
    };
    match perform(&window, action) {
        Ok(value) => response(200, origin, value),
        Err(error) => response(500, origin, json!(error)),
    }
}

#[cfg(windows)]
fn response(status: u16, origin: Option<&str>, body: Value) -> tauri::http::Response<Vec<u8>> {
    let mut response = tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .header("Cache-Control", "no-store");
    if let Some(origin) = origin {
        response = response.header("Access-Control-Allow-Origin", origin);
    }
    let body = if status == 204 {
        response = response
            .header("Access-Control-Allow-Methods", "POST")
            .header("Access-Control-Allow-Headers", "Content-Type");
        Vec::new()
    } else {
        serde_json::to_vec(&body).expect("无法序列化提醒响应")
    };
    response.body(body).expect("无法构建提醒响应")
}

#[cfg(test)]
mod tests {
    use super::Request;
    use serde_json::json;

    #[test]
    fn accepts_only_the_current_window_reminder_contract() {
        for input in [
            json!({"action":"permission","request":false}),
            json!({"action":"notify","title":"完成","body":"会话"}),
            json!({"action":"attention"}),
            json!({"action":"clear"}),
        ] {
            assert!(serde_json::from_value::<Request>(input).is_ok());
        }
        for input in [
            json!({"action":"get_control_state"}),
            json!({"action":"attention","label":"control"}),
            json!({"action":"notify","title":"完成","body":"会话","url":"https://example.test"}),
            json!({"action":"permission","request":"true"}),
            json!({"action":"permission"}),
        ] {
            assert!(serde_json::from_value::<Request>(input).is_err());
        }
    }
}
