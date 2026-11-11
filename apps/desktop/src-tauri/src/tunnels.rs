use crate::{logging, runtime::ShellState};
use pi_desk_tunnel_common::config::{normalize_tunnel_config, require_ready, TunnelConfig};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

#[path = "l4-tunnel-mappings.rs"]
pub(crate) mod mappings;
use mappings::{Mappings, Owner};

#[cfg(target_os = "macos")]
#[path = "l4-tunnels-macos.rs"]
mod macos;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Request {
    Status {},
    #[serde(rename_all = "camelCase")]
    Open {
        id: String,
        control_server_url: String,
        provider_id: String,
        remote_port: u16,
    },
    Get {
        id: String,
    },
    Close {
        id: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Message {
    Invoke { document: String, request: Request },
    Release { document: String },
}

pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(windows)]
    let builder = builder.register_asynchronous_uri_scheme_protocol(
        "pi-desk-tunnels",
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

pub fn install(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    macos::install(window)?;
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

pub fn script(origin: &url::Origin, document: Option<&str>) -> String {
    include_str!("tunnels.js")
        .replace(
            "__PLATFORM__",
            if cfg!(windows) { "windows" } else { "macos" },
        )
        .replace(
            "__ORIGIN__",
            &serde_json::to_string(&origin.ascii_serialization()).unwrap(),
        )
        .replace("__DOCUMENT__", &serde_json::to_string(&document).unwrap())
}

pub fn inject(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let app = window.app_handle();
        let origin = crate::windows::workspace_origin(app, window.label())
            .ok_or("只有有效工作台可以安装映射桥接")?;
        if window.url().map_err(|error| error.to_string())?.origin() != origin {
            return Err("工作台窗口已经导航到其他来源".into());
        }
        let document = app.state::<Mappings>().document(window.label())?;
        window
            .eval(script(&origin, Some(&document)))
            .map_err(|error| format!("注入插件映射桥接失败：{error}"))?;
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = window;
    Ok(())
}

pub fn invalidate(app: &AppHandle, label: &str) {
    if let Some(mappings) = app.try_state::<Mappings>() {
        mappings.invalidate(label);
    }
}

pub(crate) fn trusted_window(
    app: &AppHandle,
    label: &str,
    source: &str,
) -> Result<WebviewWindow, String> {
    let expected =
        crate::windows::workspace_origin(app, label).ok_or("只有有效工作台可以调用插件映射")?;
    let source = url::Url::parse(source).map_err(|_| "插件映射来源无效")?;
    if source.origin() != expected {
        return Err("插件映射来源不受信任".into());
    }
    let window = app.get_webview_window(label).ok_or("工作台窗口已释放")?;
    if window.url().map_err(|error| error.to_string())?.origin() != expected {
        return Err("工作台窗口已经导航到其他来源".into());
    }
    Ok(window)
}

fn connection(app: &AppHandle) -> Result<TunnelConfig, String> {
    let config = app.state::<ShellState>().config()?.tunnel;
    let config = normalize_tunnel_config(TunnelConfig {
        control_server_url: config.control_server_url,
        control_key: config.control_key,
    })?;
    require_ready(&config)?;
    Ok(config)
}

fn mapping_id(value: String) -> Result<String, String> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err("映射标识必须是 UUID".into());
    }
    Ok(value.to_ascii_lowercase())
}

pub(crate) fn perform(window: &WebviewWindow, message: Message) -> Result<Value, String> {
    let app = window.app_handle();
    let mappings = app.state::<Mappings>();
    let (document, request) = match message {
        Message::Release { document } => {
            mappings.release(&Owner {
                label: window.label().into(),
                document,
            })?;
            return Ok(Value::Null);
        }
        Message::Invoke { document, request } => (document, request),
    };
    let owner = Owner {
        label: window.label().into(),
        document,
    };
    mappings.validate(&owner)?;
    match request {
        Request::Status {} => match connection(app) {
            Ok(_) => Ok(json!({ "ready": true, "error": null })),
            Err(error) => Ok(json!({ "ready": false, "error": error })),
        },
        Request::Open {
            id,
            control_server_url,
            provider_id,
            remote_port,
        } => {
            let id = mapping_id(id)?;
            if remote_port == 0 {
                return Err("远端端口必须是 1 到 65535 的有效端口".into());
            }
            pi_desk_tunnel_common::protocol::parse_key_hex(&provider_id)
                .map_err(|_| "提供端标识必须是64位十六进制公钥")?;
            let config = connection(app)?;
            let target = normalize_tunnel_config(TunnelConfig {
                control_server_url,
                control_key: String::new(),
            })?;
            if target.control_server_url != config.control_server_url {
                return Err("目标控制服务与本机隧道配置不一致".into());
            }
            let key = require_ready(&config)?;
            let snapshot = mappings.open(
                owner,
                id,
                mappings::worker_config(config.control_server_url, key),
                provider_id,
                remote_port,
            )?;
            serde_json::to_value(snapshot).map_err(|_| "无法序列化映射快照".into())
        }
        Request::Get { id } => serde_json::to_value(mappings.get(owner, mapping_id(id)?)?)
            .map_err(|_| "无法序列化映射快照".into()),
        Request::Close { id } => {
            mappings.close(owner, mapping_id(id)?)?;
            Ok(Value::Null)
        }
    }
}

pub(crate) fn failed(app: &AppHandle, label: &str, error: &str) {
    logging::write(
        &app.state::<ShellState>().log_path,
        "plugin-tunnels",
        &format!("插件映射请求失败：窗口={label} 原因={error}"),
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
    let window = origin
        .ok_or_else(|| "插件映射缺少来源".to_string())
        .and_then(|source| trusted_window(app, label, source));
    let window = match window {
        Ok(window) => window,
        Err(error) => return response(403, None, json!(error)),
    };
    if request.uri().path() != "/" || request.uri().query().is_some() {
        return response(400, origin, json!("插件映射操作地址无效"));
    }
    if request.method() == tauri::http::Method::OPTIONS {
        return response(204, origin, Value::Null);
    }
    if request.method() != tauri::http::Method::POST {
        return response(405, origin, json!("插件映射仅支持 POST"));
    }
    if request.body().len() > 4096 {
        return response(400, origin, json!("插件映射参数超过大小限制"));
    }
    let Ok(message) = serde_json::from_slice::<Message>(request.body()) else {
        return response(400, origin, json!("插件映射参数无效"));
    };
    match perform(&window, message) {
        Ok(value) => response(200, origin, value),
        Err(error) => {
            failed(app, label, &error);
            response(400, origin, json!(error))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_accepts_only_document_scoped_mapping_operations() {
        let id = "11111111-1111-4111-8111-111111111111";
        for request in [
            json!({"action":"status"}),
            json!({"action":"open","id":id,"controlServerUrl":"http://tunnel.example.test:7001","providerId":"ab".repeat(32),"remotePort":43191}),
            json!({"action":"get","id":id}),
            json!({"action":"close","id":id}),
        ] {
            assert!(serde_json::from_value::<Message>(
                json!({"kind":"invoke","document":"current-document","request":request})
            )
            .is_ok());
        }
        for request in [
            json!({"action":"get_control_state"}),
            json!({"action":"status","controlKey":"not-accepted"}),
            json!({"action":"close","id":id,"label":"other-window"}),
            json!({"action":"open","id":id,"providerId":"ab".repeat(32),"remotePort":43191,"localHost":"0.0.0.0"}),
        ] {
            assert!(serde_json::from_value::<Request>(request).is_err());
        }
        assert!(serde_json::from_value::<Message>(
            json!({"kind":"invoke","request":{"action":"status"}})
        )
        .is_err());
        assert!(mapping_id(id.into()).is_ok());
        assert!(mapping_id("foreign-port".into()).is_err());
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
        serde_json::to_vec(&body).expect("无法序列化插件映射响应")
    };
    response.body(body).expect("无法构建插件映射响应")
}
