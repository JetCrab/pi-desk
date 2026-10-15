use super::{
    checked_environment, launch_service, set_phase, stop_active_child, write_shell_log,
    ServerPhase, ShellState,
};
use crate::config::ServerConfig;
use crate::environment::Component;
use crate::{environment_pi, packages};
use std::path::PathBuf;
use std::sync::atomic::Ordering;

struct PausedService {
    url: String,
    version: Option<String>,
    directory: Option<PathBuf>,
    server: ServerConfig,
}

pub(super) fn check(state: &ShellState, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    let installed = environment_pi::update_target(&state.environment, cancelled, &state.log_path)?;
    let source = state.environment.package_source(&state.log_path);
    let version =
        environment_pi::query_version(&state.environment, &source, cancelled, &state.log_path)?;
    state.environment.set_pi_update(
        if packages::is_newer(Some(&version), Some(&installed.version)) {
            "available"
        } else {
            "current"
        },
        Some(version),
        None,
    );
    Ok(())
}

pub(super) fn update(
    state: &ShellState,
    version: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let installed = environment_pi::update_target(&state.environment, cancelled, &state.log_path)?;
    if !packages::is_newer(Some(version), Some(&installed.version)) {
        state
            .environment
            .set_pi_update("current", Some(version.into()), None);
        return Ok(());
    }
    let source = state.environment.package_source(&state.log_path);
    write_shell_log(
        state,
        "pi-update-start",
        &format!(
            "Pi {} -> {version} path={}",
            installed.version,
            installed.directory.display()
        ),
    );
    state
        .environment
        .set_phase("installing", "正在暂停本机服务", None);
    let mut paused = Vec::new();
    let installation = pause_services(state, &mut paused, cancelled).and_then(|()| {
        environment_pi::install_version(
            &state.environment,
            &state.environment.root,
            &source,
            version,
            cancelled,
            &state.log_path,
        )
    });
    // 取消 npm 不代表包已回滚；恢复必须读取真实安装，并且不能被本次取消跳过。
    let closing = || state.closing.load(Ordering::Acquire);
    if closing() {
        return Err("桌面程序正在退出，Pi 更新已停止；未恢复本机服务".into());
    }
    state
        .environment
        .set_phase("installing", "正在校验 Pi 与本机服务", None);
    let verified = checked_environment(state, &closing).and_then(|()| {
        if let Some(path) = state.environment.component_path(Component::Pi) {
            let expected = std::fs::canonicalize(&installed.directory)
                .map_err(|error| format!("原 Pi 安装不可用，未恢复服务：{error}"))?;
            let actual = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
            if actual != expected {
                return Err(
                    "检测到了另一份 Pi，未切换安装来源；请修复原安装或明确选择后再启动".into(),
                );
            }
            Ok(())
        } else {
            Err(state
                .environment
                .snapshot()
                .components
                .into_iter()
                .find(|item| item.name == Component::Pi)
                .and_then(|item| item.detail)
                .unwrap_or_else(|| "Pi 更新后不可用，请重新安装或选择兼容版本".into()))
        }
    });
    let mut failures = Vec::new();
    if let Err(error) = installation {
        failures.push(error);
    }
    match verified {
        Ok(()) => {
            state
                .environment
                .set_phase("installing", "正在恢复原先运行的本机服务", None);
            failures.extend(restore_services(state, paused, &closing));
            let servers = state
                .config()?
                .targets
                .into_iter()
                .filter_map(|target| target.server)
                .collect::<Vec<_>>();
            state.environment.finish_check(&servers);
        }
        Err(error) => {
            let detail = format!("Pi 校验未通过，本次暂停的服务未恢复：{error}");
            state
                .environment
                .set_phase("failed", "Pi 校验未通过", Some(detail.clone()));
            failures.push(detail);
        }
    }
    state.environment.cleanup_cache(&state.log_path);
    if !failures.is_empty() {
        return Err(failures.join("\n"));
    }
    state
        .environment
        .set_pi_update("current", Some(version.into()), None);
    write_shell_log(
        state,
        "pi-update-complete",
        &format!("Pi {version} 更新及服务恢复完成"),
    );
    Ok(())
}

fn pause_services(
    state: &ShellState,
    paused: &mut Vec<PausedService>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let mut running = state
        .target_runtimes
        .lock()
        .map_err(|_| "运行状态不可用")?
        .iter()
        .filter_map(|(url, runtime)| {
            runtime.child.as_ref().map(|child| PausedService {
                url: url.clone(),
                version: child.version.clone(),
                directory: child.directory.clone(),
                server: child.server.clone(),
            })
        })
        .collect::<Vec<_>>();
    running.sort_by(|left, right| left.url.cmp(&right.url));
    for service in running {
        if cancelled() {
            return Err("Pi 更新已取消".into());
        }
        stop_active_child(state, &service.url)?;
        set_phase(state, &service.url, ServerPhase::Stopped);
        paused.push(service);
    }
    Ok(())
}

fn restore_services(
    state: &ShellState,
    paused: Vec<PausedService>,
    closing: &dyn Fn() -> bool,
) -> Vec<String> {
    let mut failures = Vec::new();
    for service in paused {
        if closing() {
            failures.push("桌面程序正在退出，已停止恢复本机服务".into());
            break;
        }
        let result = (|| -> Result<(), String> {
            if state.environment.needs_setup(&service.server) {
                return Err("运行环境尚未就绪，请重新检测或修复后启动".into());
            }
            if let Some(directory) = &service.directory {
                state.environment.verify_service(
                    &service.server,
                    directory,
                    closing,
                    &state.log_path,
                )?;
            }
            set_phase(
                state,
                &service.url,
                ServerPhase::Starting("正在恢复原服务".into()),
            );
            launch_service(
                state,
                &service.url,
                &service.server,
                service.version,
                service.directory,
                closing,
            )
            .map_err(|error| error.to_string())
        })();
        if let Err(error) = result {
            let detail = format!("恢复 {} 失败：{error}", service.url);
            set_phase(state, &service.url, ServerPhase::Failed(detail.clone()));
            write_shell_log(state, "pi-update-restore-failed", &detail);
            failures.push(detail);
        }
    }
    failures
}

#[cfg(test)]
#[path = "l2-runtime-pi-update-tests.rs"]
mod tests;
