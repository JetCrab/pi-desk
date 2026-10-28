use crate::{logging, runtime::ShellState};
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};

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

#[derive(Serialize)]
struct WindowState {
    maximized: bool,
}

fn allows_window(label: &str) -> bool {
    label == "control" || label.starts_with("browser-")
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let builder =
        tauri::plugin::Builder::new("window-chrome").invoke_handler(tauri::generate_handler![
            #![plugin(window_chrome)]
            bridge
        ]);
    #[cfg(windows)]
    let builder = builder.js_init_script(include_str!("window-chrome.js"));
    builder.build()
}

#[tauri::command]
async fn bridge(window: WebviewWindow, action: Action) -> Result<WindowState, String> {
    if !matches!(action, Action::State) {
        let state = window.app_handle().state::<ShellState>();
        logging::write(
            &state.log_path,
            "window-chrome-start",
            &format!("label={} action={}", window.label(), action.name()),
        );
    }
    let result = if !allows_window(window.label()) {
        Err("此窗口不支持标题栏操作".to_string())
    } else {
        #[cfg(windows)]
        {
            perform(&window, action).map_err(|error| error.to_string())
        }
        #[cfg(not(windows))]
        {
            Err("标题栏操作仅支持 Windows".to_string())
        }
    };
    if let Err(error) = &result {
        let state = window.app_handle().state::<ShellState>();
        logging::write(
            &state.log_path,
            "window-chrome-failed",
            &format!(
                "label={} action={} error={error}",
                window.label(),
                action.name()
            ),
        );
    } else if !matches!(action, Action::State) {
        let state = window.app_handle().state::<ShellState>();
        logging::write(
            &state.log_path,
            "window-chrome-end",
            &format!("label={} action={}", window.label(), action.name()),
        );
    }
    result
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

#[cfg(test)]
mod tests {
    use super::{allows_window, Action};
    use serde_json::{json, Value};

    #[test]
    fn bridge_only_accepts_supported_actions() {
        for action in [
            "attach",
            "detach",
            "state",
            "drag",
            "minimize",
            "toggle-maximize",
            "close",
        ] {
            let parsed: Action = serde_json::from_value(json!(action)).unwrap();
            assert_eq!(parsed.name(), action);
        }
        for action in [json!("maximize"), json!("destroy"), json!(""), json!(null)] {
            assert!(serde_json::from_value::<Action>(action).is_err());
        }
    }

    #[test]
    fn bridge_rejects_unrelated_windows() {
        assert!(allows_window("control"));
        assert!(allows_window("browser-1"));
        assert!(allows_window("browser-preview-2"));
        assert!(!allows_window("main"));
        assert!(!allows_window("control-1"));
        assert!(!allows_window("other-browser-1"));
    }

    #[test]
    fn remote_pages_only_receive_the_current_window_bridge() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(capability["windows"], json!(["browser-*"]));
        assert_eq!(capability["local"], false);
        assert_eq!(
            capability["remote"]["urls"],
            json!(["http://*:*", "https://*:*"])
        );
        assert_eq!(
            capability["permissions"],
            json!(["window-chrome:allow-bridge"])
        );
    }

    #[test]
    fn remote_bridge_covers_http_ports_but_not_local_resources() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let patterns: Vec<tauri::utils::acl::RemoteUrlPattern> = capability["remote"]["urls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().parse().unwrap())
            .collect();
        for url in [
            "http://127.0.0.1:30333/",
            "http://localhost:54321/login",
            "https://example.com/",
            "https://example.com:8443/project-preview?cwd=sample",
        ] {
            assert!(
                patterns
                    .iter()
                    .any(|pattern| pattern.test(&url.parse().unwrap())),
                "{url}"
            );
        }
        for url in ["file:///test.html", "tauri://localhost/"] {
            assert!(
                !patterns
                    .iter()
                    .any(|pattern| pattern.test(&url.parse().unwrap())),
                "{url}"
            );
        }
    }

    #[test]
    fn control_capability_remains_local() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/control.json")).unwrap();
        assert_eq!(capability["windows"], json!(["control"]));
        assert!(capability.get("remote").is_none());
        assert_ne!(capability["local"], false);
        assert_eq!(
            capability["permissions"],
            json!(["core:default", "window-chrome:allow-bridge"])
        );
    }
}
