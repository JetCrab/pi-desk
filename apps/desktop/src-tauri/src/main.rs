#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod desktop_tunnel_cli;
mod environment;
mod environment_arch;
mod environment_dialog;
#[path = "l4-environment-download.rs"]
mod environment_download;
mod environment_install;
#[path = "l4-environment-installer.rs"]
mod environment_installer;
#[path = "l4-environment-source.rs"]
mod environment_source;
mod logging;
mod packages;
mod process;
mod runtime;
mod service_port;
#[cfg(test)]
mod test_support;
mod tunnel;
mod windows;

use runtime::ShellState;
use std::error::Error;
use tauri::menu::{MenuBuilder, MenuEvent, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, Window};

const EXIT_FOR_UPDATE_ARG: &str = "--exit-for-update";

fn main() {
    let exit_for_update = std::env::args().any(|argument| argument == EXIT_FOR_UPDATE_ARG);
    if let Some(code) = desktop_tunnel_cli::run_if_requested() {
        std::process::exit(code);
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, arguments, _| {
            if arguments
                .iter()
                .any(|argument| argument == EXIT_FOR_UPDATE_ARG)
            {
                if let Some(state) = app.try_state::<ShellState>() {
                    logging::write(
                        &state.log_path,
                        "desktop-update-exit-request",
                        "安装器请求正常退出桌面程序",
                    );
                }
                app.exit(0);
            } else {
                if let Some(state) = app.try_state::<ShellState>() {
                    logging::write(
                        &state.log_path,
                        "desktop-existing-instance",
                        &format!(
                            "version={} pid={}",
                            app.package_info().version,
                            std::process::id()
                        ),
                    );
                }
                let _ = runtime::open_control_window(app);
            }
        }))
        .invoke_handler(tauri::generate_handler![
            get_control_state,
            get_environment_download_source,
            get_target_settings,
            apply_target_command,
            delete_target_command,
            get_tunnel_connection,
            apply_tunnel_connection_command,
            open_target_command,
            start_server_command,
            stop_server_command,
            restart_server_command,
            check_package_update_command,
            update_package_command,
            cancel_package_update_command,
            check_environment_command,
            prepare_environment_command,
            cancel_environment_command,
            select_environment_command,
            open_install_help_command,
            start_tunnel_command,
            stop_tunnel_command
        ])
        .setup(move |app| {
            if exit_for_update {
                // 没有已运行实例时只退出，不创建窗口或启动本机服务。
                app.handle().exit(0);
                Ok(())
            } else {
                setup(app)
            }
        })
        .on_menu_event(handle_menu_event)
        .build(tauri::generate_context!())
        .expect("无法构建 Pi Desk");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } => {
            if app_handle.try_state::<ShellState>().is_some() {
                runtime::shutdown(app_handle);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            let _ = runtime::open_control_window(app_handle);
        }
        _ => {}
    });
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn Error>> {
    let isolated_root = std::env::var_os("PI_DESK_DESKTOP_DATA_DIR").map(std::path::PathBuf::from);
    let config_root = isolated_root
        .clone()
        .unwrap_or(app.path().app_config_dir()?);
    let config_path = config_root.join("config.json");
    let runtime_path = config_root.join("runtime.json");
    let log_root = match isolated_root {
        Some(root) => root.join("logs"),
        None => app.path().app_log_dir()?,
    };
    let log_path = log_root.join("desktop.log");
    logging::write(
        &log_path,
        "desktop-start",
        &format!(
            "version={} pid={} executable={:?} config={}",
            app.package_info().version,
            std::process::id(),
            std::env::current_exe(),
            config_path.display()
        ),
    );
    let loaded = match config::load(&config_path) {
        Ok(loaded) => loaded,
        Err(error) => {
            logging::write(&log_path, "config-error", &error);
            return Err(error.into());
        }
    };
    if loaded.needs_rewrite {
        config::save(&config_path, &loaded.config)?;
    }
    let runtime_info = runtime::load_runtime_info(&runtime_path, &loaded.config);
    app.manage(ShellState::new(
        loaded.config,
        runtime_info,
        config_path,
        runtime_path,
        log_path,
    ));
    #[cfg(target_os = "macos")]
    app.set_menu(tauri::menu::Menu::default(app.handle())?)?;
    build_tray(app)?;
    runtime::open_control_window(app.handle())?;
    runtime::check_environment(app.handle(), true)?;
    runtime::start_tunnels_if_enabled(app.handle())?;
    runtime::start_update_monitor(app.handle())?;
    Ok(())
}

fn build_tray(app: &mut tauri::App) -> Result<(), Box<dyn Error>> {
    let control = MenuItemBuilder::with_id("control", "打开控制中心").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出应用").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&control, &quit]).build()?;
    let icon = app.default_window_icon().cloned();
    let mut tray = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .tooltip(if cfg!(target_os = "macos") {
            "Pi Desk"
        } else {
            "Pi Desk（右键打开菜单）"
        })
        .on_tray_icon_event(|tray, event| {
            if !cfg!(target_os = "macos")
                && matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                )
            {
                let _ = runtime::open_control_window(tray.app_handle());
            }
        });
    if let Some(icon) = icon {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    if let Err(error) = handle_tray_event(app, event.id().as_ref()) {
        eprintln!("[pi-desk-desktop] stage=tray-action-error error={error}");
        let _ = runtime::open_control_window(app);
    }
}

fn handle_tray_event(app: &AppHandle, id: &str) -> Result<(), String> {
    match id {
        "control" => runtime::open_control_window(app),
        "quit" => {
            app.exit(0);
            Ok(())
        }
        _ => Ok(()),
    }
}

fn ensure_control(window: &Window) -> Result<(), String> {
    if window.label() == "control" {
        Ok(())
    } else {
        Err("只有控制中心可以执行此操作".to_string())
    }
}

#[tauri::command]
fn get_control_state(
    window: Window,
    state: State<'_, ShellState>,
) -> Result<runtime::ControlState, String> {
    ensure_control(&window)?;
    runtime::control_state(state.inner())
}

#[tauri::command]
async fn get_environment_download_source(
    app: AppHandle,
    window: Window,
) -> Result<environment_source::DownloadSource, String> {
    ensure_control(&window)?;
    let state = app.state::<ShellState>();
    Ok(state
        .environment
        .download_source(&environment_source::lookup_url(), &state.log_path)
        .await)
}

#[tauri::command]
fn get_target_settings(
    window: Window,
    state: State<'_, ShellState>,
    url: Option<String>,
) -> Result<runtime::TargetSettings, String> {
    ensure_control(&window)?;
    runtime::target_settings(state.inner(), url.as_deref())
}

async fn run_command(
    app: AppHandle,
    window: Window,
    name: &'static str,
    operation: impl FnOnce(&AppHandle) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    ensure_control(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ShellState>();
        logging::write(&state.log_path, "command-start", name);
        let result = operation(&app);
        logging::write(
            &state.log_path,
            "command-end",
            &format!("command={name} result={result:?}"),
        );
        result
    })
    .await
    .map_err(|error| format!("桌面操作异常：{error}"))?
}

#[tauri::command]
async fn apply_target_command(
    app: AppHandle,
    window: Window,
    original_url: Option<String>,
    value: serde_json::Value,
) -> Result<(), String> {
    run_command(app, window, "apply-target", move |app| {
        runtime::apply_target(app, original_url.as_deref(), value)
    })
    .await
}

#[tauri::command]
async fn delete_target_command(app: AppHandle, window: Window, url: String) -> Result<(), String> {
    run_command(app, window, "delete-target", move |app| {
        runtime::delete_target(app, &url)
    })
    .await
}

#[tauri::command]
fn get_tunnel_connection(
    window: Window,
    state: State<'_, ShellState>,
) -> Result<runtime::TunnelConnectionInput, String> {
    ensure_control(&window)?;
    runtime::tunnel_connection(state.inner())
}

#[tauri::command]
async fn apply_tunnel_connection_command(
    app: AppHandle,
    window: Window,
    value: serde_json::Value,
) -> Result<(), String> {
    run_command(app, window, "apply-tunnel", move |app| {
        runtime::apply_tunnel_connection(app.state::<ShellState>().inner(), value)
    })
    .await
}

#[tauri::command]
async fn open_target_command(app: AppHandle, window: Window, url: String) -> Result<(), String> {
    run_command(app, window, "open-target", move |app| {
        runtime::open_target(app, &url)
    })
    .await
}

#[tauri::command]
async fn start_server_command(app: AppHandle, window: Window, url: String) -> Result<(), String> {
    run_command(app, window, "start-server", move |app| {
        runtime::start_server(app, &url, true)
    })
    .await
}

#[tauri::command]
async fn stop_server_command(app: AppHandle, window: Window, url: String) -> Result<(), String> {
    run_command(app, window, "stop-server", move |app| {
        runtime::stop_server(app, &url)
    })
    .await
}

#[tauri::command]
async fn restart_server_command(app: AppHandle, window: Window, url: String) -> Result<(), String> {
    run_command(app, window, "restart-server", move |app| {
        runtime::restart_server(app, &url)
    })
    .await
}

#[tauri::command]
async fn check_package_update_command(
    app: AppHandle,
    window: Window,
    url: String,
) -> Result<(), String> {
    run_command(app, window, "check-update", move |app| {
        runtime::check_package_update(app, &url)
    })
    .await
}

#[tauri::command]
async fn update_package_command(app: AppHandle, window: Window, url: String) -> Result<(), String> {
    run_command(app, window, "update-package", move |app| {
        runtime::update_package(app, &url)
    })
    .await
}

#[tauri::command]
async fn cancel_package_update_command(
    app: AppHandle,
    window: Window,
    url: String,
) -> Result<(), String> {
    run_command(app, window, "cancel-update", move |app| {
        runtime::cancel_package_update(app, &url)
    })
    .await
}

#[tauri::command]
async fn check_environment_command(app: AppHandle, window: Window) -> Result<(), String> {
    run_command(app, window, "check-environment", |app| {
        runtime::check_environment(app, false)
    })
    .await
}

#[tauri::command]
async fn prepare_environment_command(
    app: AppHandle,
    window: Window,
    url: String,
    download_source: environment_source::DownloadSource,
) -> Result<(), String> {
    run_command(app, window, "prepare-environment", move |app| {
        runtime::prepare_environment(app, &url, download_source)
    })
    .await
}

#[tauri::command]
async fn cancel_environment_command(app: AppHandle, window: Window) -> Result<(), String> {
    run_command(
        app,
        window,
        "cancel-environment",
        runtime::cancel_environment,
    )
    .await
}

#[tauri::command]
async fn select_environment_command(
    app: AppHandle,
    window: Window,
    component: environment::Component,
    archive: bool,
) -> Result<(), String> {
    run_command(app, window, "select-environment", move |app| {
        runtime::select_environment(app, component, archive)
    })
    .await
}

#[tauri::command]
async fn open_install_help_command(
    app: AppHandle,
    window: Window,
    component: environment::Component,
) -> Result<(), String> {
    run_command(app, window, "open-install-help", move |_| {
        runtime::open_install_help(component)
    })
    .await
}

#[tauri::command]
async fn start_tunnel_command(app: AppHandle, window: Window, url: String) -> Result<(), String> {
    run_command(app, window, "start-tunnel", move |app| {
        runtime::start_tunnel(app, &url, true)
    })
    .await
}

#[tauri::command]
async fn stop_tunnel_command(app: AppHandle, window: Window, url: String) -> Result<(), String> {
    run_command(app, window, "stop-tunnel", move |app| {
        runtime::stop_tunnel(app, &url)
    })
    .await
}
