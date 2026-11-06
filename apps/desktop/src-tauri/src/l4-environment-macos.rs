#[cfg(target_os = "macos")]
use crate::environment::{Component, EnvironmentState};
#[cfg(target_os = "macos")]
use crate::{logging, packages, process};
#[cfg(target_os = "macos")]
use std::{path::Path, thread, time::Duration};

#[cfg(target_os = "macos")]
fn tools_installed(
    state: &EnvironmentState,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<bool, String> {
    let output = process::run_program(
        Path::new("/usr/bin/xcode-select"),
        &["-p"],
        None,
        Duration::from_secs(10),
        log,
        cancelled,
        &state.child_environment(),
    )?;
    Ok(output.status.success())
}

#[cfg(target_os = "macos")]
pub(crate) fn prepare_system_tools(
    state: &EnvironmentState,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<(), String> {
    if std::env::var_os("PI_DESK_DESKTOP_DATA_DIR").is_some() {
        return Err("隔离模式禁止安装真实系统工具".into());
    }
    if !tools_installed(state, cancelled, log)? {
        state.set_component_step(Component::Bash, "正在打开 macOS 系统工具安装窗口");
        let output = process::run_program(
            Path::new("/usr/bin/xcode-select"),
            &["--install"],
            None,
            Duration::from_secs(15),
            log,
            cancelled,
            &state.child_environment(),
        )?;
        logging::write(
            log,
            "environment-command-line-tools",
            &format!(
                "exit={} stdout={} stderr={}",
                output.status,
                process::decode_output(&output.stdout).trim(),
                process::decode_output(&output.stderr).trim(),
            ),
        );
        if !output.status.success() {
            return Err(format!(
                "无法打开 macOS 系统工具安装窗口：{}",
                packages::command_failure(&output)
            ));
        }
        // xcode-select 成功只表示系统已接受请求；保留准备任务，不能当作安装完成或失败。
        state.set_component_step(
            Component::Bash,
            "正在等待系统工具安装。请在 macOS 弹窗中安装“命令行开发者工具”，完成后会自动继续准备 Pi Desk。",
        );
        wait_for_tools(
            cancelled,
            || tools_installed(state, cancelled, log),
            || {
                // 仅检测系统工具，不遍历用户目录；取消准备不会关闭系统安装器。
                for _ in 0..50 {
                    if cancelled() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            },
        )?;
    }
    state.check_components(&[Component::Bash], cancelled, log)?;
    if state.component_path(Component::Bash).is_none() {
        let detail = state
            .snapshot()
            .components
            .into_iter()
            .find(|component| component.name == Component::Bash)
            .and_then(|component| component.detail)
            .unwrap_or_else(|| "未找到可用的 Git 和 Bash".into());
        return Err(format!("系统工具已安装，但 Git 和 Bash 尚不可用：{detail}"));
    }
    Ok(())
}

fn wait_for_tools(
    cancelled: &dyn Fn() -> bool,
    mut ready: impl FnMut() -> Result<bool, String>,
    mut pause: impl FnMut(),
) -> Result<(), String> {
    loop {
        if cancelled() {
            return Err("操作已取消".into());
        }
        if ready()? {
            return if cancelled() {
                Err("操作已取消".into())
            } else {
                Ok(())
            };
        }
        pause();
    }
}

#[cfg(test)]
mod tests {
    use super::wait_for_tools;
    use std::cell::Cell;

    #[test]
    fn installation_waits_normally_and_continues_when_ready() {
        let checks = Cell::new(0);
        let pauses = Cell::new(0);
        let result = wait_for_tools(
            &|| false,
            || {
                checks.set(checks.get() + 1);
                Ok(checks.get() == 3)
            },
            || pauses.set(pauses.get() + 1),
        );
        assert!(result.is_ok());
        assert_eq!(checks.get(), 3);
        assert_eq!(pauses.get(), 2);
    }

    #[test]
    fn already_ready_does_not_wait() {
        assert!(wait_for_tools(&|| false, || Ok(true), || panic!("不得等待")).is_ok());
    }

    #[test]
    fn cancellation_does_not_continue_preparation() {
        let cancelled = Cell::new(false);
        let result = wait_for_tools(&|| cancelled.get(), || Ok(false), || cancelled.set(true));
        assert_eq!(result.unwrap_err(), "操作已取消");
    }

    #[test]
    fn cancelled_before_check_does_not_probe_system() {
        let result = wait_for_tools(&|| true, || panic!("不得检测"), || panic!("不得等待"));
        assert_eq!(result.unwrap_err(), "操作已取消");
    }

    #[test]
    fn genuine_probe_failure_is_preserved() {
        let result = wait_for_tools(
            &|| false,
            || Err("启动检测命令失败".into()),
            || panic!("不得重试真实错误"),
        );
        assert_eq!(result.unwrap_err(), "启动检测命令失败");
    }
}
