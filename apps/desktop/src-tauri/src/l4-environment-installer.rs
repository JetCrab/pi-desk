use std::path::Path;

pub(crate) fn run(
    program: &Path,
    arguments: &[&str],
    elevated: bool,
    log: &Path,
    cancelled: &dyn Fn() -> bool,
    on_cancel_wait: &dyn Fn(),
) -> Result<u32, String> {
    if cancelled() {
        return Err("操作已取消".into());
    }
    if std::env::var_os("PI_DESK_DESKTOP_DATA_DIR").is_some() {
        return Err("隔离模式禁止执行真实系统安装".into());
    }
    #[cfg(windows)]
    {
        windows::run(program, arguments, elevated, log, cancelled, on_cancel_wait)
    }
    #[cfg(not(windows))]
    {
        let _ = (program, arguments, elevated, log, on_cancel_wait);
        Err("当前系统不支持 Windows 官方安装器".into())
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::OsStr;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;
    use std::thread;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{
        ERROR_CANCELLED, STILL_ACTIVE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    use crate::logging;

    const POLL_MS: u32 = 200;

    pub(super) fn run(
        program: &Path,
        arguments: &[&str],
        elevated: bool,
        log: &Path,
        cancelled: &dyn Fn() -> bool,
        on_cancel_wait: &dyn Fn(),
    ) -> Result<u32, String> {
        let file = wide(program.as_os_str())?;
        let parameters = arguments
            .iter()
            .map(|argument| quote_argument(argument))
            .collect::<Vec<_>>()
            .join(" ");
        let parameters_wide = wide(OsStr::new(&parameters))?;
        let verb = wide(OsStr::new(if elevated { "runas" } else { "open" }))?;
        let mut info = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
            lpVerb: verb.as_ptr(),
            lpFile: file.as_ptr(),
            lpParameters: parameters_wide.as_ptr(),
            nShow: SW_SHOWNORMAL,
            ..Default::default()
        };
        if cancelled() {
            return Err("操作已取消".into());
        }
        logging::write(
            log,
            "installer-start",
            &format!(
                "开始启动官方安装器：{}，参数={parameters}，请求管理员权限={elevated}",
                program.display()
            ),
        );
        // UTF-16 缓冲区在同步 Shell 调用完成前保持有效，不使用会终止进程树的通用底座。
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            let error = std::io::Error::last_os_error();
            let message = if error.raw_os_error() == Some(ERROR_CANCELLED as i32) {
                "管理员授权被取消（Windows 错误 1223）".to_string()
            } else {
                format!("启动官方安装器失败：{error}")
            };
            logging::write(log, "installer-start-error", &message);
            return Err(message);
        }
        if info.hProcess.is_null() {
            // 直接启动 EXE 必须返回进程句柄；无法跟踪时不得声称安装已完成。
            let message = "官方安装器未返回进程句柄，无法确认安装状态";
            logging::write(log, "installer-start-error", message);
            return Err(message.into());
        }
        let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess) };
        wait(&process, log, cancelled, on_cancel_wait)
    }

    fn wait(
        process: &OwnedHandle,
        log: &Path,
        cancelled: &dyn Fn() -> bool,
        on_cancel_wait: &dyn Fn(),
    ) -> Result<u32, String> {
        let mut cancel_requested = false;
        let mut wait_error = None;
        let exit_code = loop {
            if !cancel_requested && cancelled() {
                cancel_requested = true;
                logging::write(
                    log,
                    "installer-cancel-wait",
                    "操作已取消，等待当前安装器完成，不强制终止安装进程",
                );
                on_cancel_wait();
            }
            let status = unsafe { WaitForSingleObject(process.as_raw_handle(), POLL_MS) };
            if status == WAIT_TIMEOUT {
                continue;
            }
            if status != WAIT_OBJECT_0 && wait_error.is_none() {
                let message = if status == WAIT_FAILED {
                    format!("等待官方安装器失败：{}", std::io::Error::last_os_error())
                } else {
                    format!("等待官方安装器返回异常状态：{status}")
                };
                logging::write(
                    log,
                    "installer-wait-error",
                    &format!("{message}；继续保留进程句柄并确认退出"),
                );
                wait_error = Some(message);
            }
            let mut code = 0;
            if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) } != 0 {
                // 等待成功时 259 也是合法退出码；等待失败时它只能表示尚未确认退出。
                if status == WAIT_OBJECT_0 || code != STILL_ACTIVE as u32 {
                    break code;
                }
            } else if status == WAIT_OBJECT_0 {
                let message = format!(
                    "读取官方安装器退出码失败：{}",
                    std::io::Error::last_os_error()
                );
                logging::write(log, "installer-exit", "官方安装器已退出，但无法读取退出码");
                logging::write(log, "installer-wait-error", &message);
                return Err(if cancel_requested {
                    "操作已取消".into()
                } else {
                    message
                });
            }
            // 等待 API 失败不意味着进程已退出；确认前不返回、不释放句柄、不忙轮询。
            thread::sleep(Duration::from_millis(POLL_MS as u64));
        };
        logging::write(
            log,
            "installer-exit",
            &format!("官方安装器已退出，退出码={exit_code}"),
        );
        if cancel_requested {
            Err("操作已取消".into())
        } else if let Some(message) = wait_error {
            Err(message)
        } else {
            Ok(exit_code)
        }
    }

    fn wide(value: &OsStr) -> Result<Vec<u16>, String> {
        let mut buffer: Vec<u16> = value.encode_wide().collect();
        if buffer.contains(&0) {
            return Err("安装器路径或参数包含空字符".into());
        }
        buffer.push(0);
        Ok(buffer)
    }

    fn quote_argument(argument: &str) -> String {
        if !argument.is_empty()
            && !argument
                .chars()
                .any(|character| character.is_whitespace() || character == '"')
        {
            return argument.into();
        }
        let mut quoted = String::from("\"");
        let mut backslashes = 0;
        for character in argument.chars() {
            if character == '\\' {
                backslashes += 1;
                continue;
            }
            let count = if character == '"' {
                backslashes * 2 + 1
            } else {
                backslashes
            };
            quoted.extend(std::iter::repeat_n('\\', count));
            quoted.push(character);
            backslashes = 0;
        }
        quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
        quoted.push('"');
        quoted
    }

    #[cfg(test)]
    mod tests {
        use super::quote_argument;

        #[test]
        fn installer_switches_remain_unquoted_while_paths_are_protected() {
            for switch in ["/i", "/passive", "/norestart", "/L*V", "/VERYSILENT"] {
                assert_eq!(quote_argument(switch), switch);
            }
            assert_eq!(
                quote_argument("C:\\中文 path\\node.msi"),
                "\"C:\\中文 path\\node.msi\""
            );
            assert_eq!(
                quote_argument("/LOG=C:\\中文 path\\git.log"),
                "\"/LOG=C:\\中文 path\\git.log\""
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_start_never_launches_a_program() {
        let error = run(
            Path::new("must-not-run.exe"),
            &[],
            true,
            Path::new("must-not-write.log"),
            &|| true,
            &|| panic!("未启动时不应等待安装器"),
        )
        .unwrap_err();
        assert_eq!(error, "操作已取消");
    }

    #[cfg(windows)]
    mod native {
        use super::*;
        use crate::process;
        use std::fs;
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::{Duration, SystemTime, UNIX_EPOCH};

        struct TestDirectory(PathBuf);

        impl TestDirectory {
            fn new(name: &str) -> Self {
                let suffix = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../temp/tests/desktop-installers")
                    .join(format!("{name}-{}-{suffix}", std::process::id()));
                fs::create_dir_all(&root).unwrap();
                Self(root)
            }

            fn node(&self) -> PathBuf {
                let output = process::run_capture(
                    "node -p \"process.execPath\"",
                    None,
                    Duration::from_secs(10),
                    &self.0.join("desktop.log"),
                    &|| false,
                )
                .unwrap();
                assert!(output.status.success());
                PathBuf::from(process::decode_output(&output.stdout).trim())
            }
        }

        impl Drop for TestDirectory {
            fn drop(&mut self) {
                fs::remove_dir_all(&self.0).unwrap();
            }
        }

        #[test]
        fn shell_launch_preserves_arguments_and_returns_the_actual_exit_code() {
            let directory = TestDirectory::new("arguments-中文");
            let result = directory.0.join("arguments.json");
            let script = directory.0.join("echo arguments.js");
            fs::write(&script, format!(
                "require('node:fs').writeFileSync({}, JSON.stringify(process.argv.slice(2))); process.exit(7);",
                serde_json::to_string(&result.to_string_lossy()).unwrap(),
            )).unwrap();
            let arguments = [
                "",
                "参数 with spaces",
                "single'quote",
                "double\"quote",
                "/i",
                "/passive",
                "/LOG=C:\\中文 path\\git.log",
                "C:\\中文 path\\",
            ];
            let script_path = script.to_string_lossy();
            let mut actual_arguments = vec![script_path.as_ref()];
            actual_arguments.extend(arguments);
            let code = windows::run(
                &directory.node(),
                &actual_arguments,
                false,
                &directory.0.join("desktop.log"),
                &|| false,
                &|| panic!("不应取消"),
            )
            .unwrap();
            assert_eq!(code, 7);
            let actual: Vec<String> = serde_json::from_slice(&fs::read(result).unwrap()).unwrap();
            assert_eq!(actual, arguments);
        }

        #[test]
        fn cancellation_waits_for_the_started_program_before_returning() {
            let directory = TestDirectory::new("cancel-wait");
            let marker = directory.0.join("status.txt");
            let script = directory.0.join("installation.js");
            fs::write(&script, format!(
                "const fs=require('node:fs'); const marker={}; fs.writeFileSync(marker,'started'); setTimeout(()=>fs.writeFileSync(marker,'complete'),700);",
                serde_json::to_string(&marker.to_string_lossy()).unwrap(),
            )).unwrap();
            let notices = AtomicUsize::new(0);
            let error = windows::run(
                &directory.node(),
                &[&script.to_string_lossy()],
                false,
                &directory.0.join("desktop.log"),
                &|| marker.exists(),
                &|| {
                    notices.fetch_add(1, Ordering::Relaxed);
                },
            )
            .unwrap_err();
            assert_eq!(error, "操作已取消");
            assert_eq!(notices.load(Ordering::Relaxed), 1);
            assert_eq!(fs::read_to_string(marker).unwrap(), "complete");
        }
    }
}
