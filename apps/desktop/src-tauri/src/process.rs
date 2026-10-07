use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::logging;

const TAIL_LIMIT: usize = 64 * 1024;
pub(crate) type ProcessEnvironment = Vec<(OsString, OsString)>;

pub struct ManagedProcess {
    child: Child,
    #[cfg(windows)]
    job: windows_job::Job,
    #[cfg(unix)]
    process_group: Option<i32>,
    stdout: Option<JoinHandle<io::Result<Vec<u8>>>>,
    stderr: Option<JoinHandle<io::Result<Vec<u8>>>>,
    log_path: PathBuf,
    context: String,
    output: (Vec<u8>, Vec<u8>),
}

impl ManagedProcess {
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let result = self.child.try_wait()?;
        if let Some(status) = &result {
            self.stop_tree()?;
            self.finish_readers()?;
            logging::write(
                &self.log_path,
                "process-exit",
                &format!("{} exit={status}", self.context),
            );
        }
        Ok(result)
    }

    pub(crate) fn failure_detail(&self) -> String {
        [decode_output(&self.output.0), decode_output(&self.output.1)]
            .join("\n")
            .chars()
            .rev()
            .take(4000)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>()
            .trim()
            .to_string()
    }

    fn stop_tree(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        {
            self.job.terminate()?;
        }
        #[cfg(unix)]
        if let Some(group) = self.process_group {
            // 仅向 spawn 时创建的独立进程组发信号，不按端口或进程名结束用户服务。
            if unsafe { libc::killpg(group, libc::SIGKILL) } == -1 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
            }
            self.process_group = None;
        }
        Ok(())
    }

    fn finish_readers(&mut self) -> io::Result<(Vec<u8>, Vec<u8>)> {
        let stdout = join_reader(self.stdout.take());
        let stderr = join_reader(self.stderr.take());
        if !stdout.as_ref().is_ok_and(Vec::is_empty) || !stderr.as_ref().is_ok_and(Vec::is_empty) {
            self.output = (stdout?, stderr?);
        }
        Ok(self.output.clone())
    }
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        if let Err(error) = self.stop_tree() {
            logging::write(
                &self.log_path,
                "process-drop-error",
                &format!("{} {error}", self.context),
            );
            return;
        }
        let _ = self.child.wait();
        if let Err(error) = self.finish_readers() {
            logging::write(
                &self.log_path,
                "process-read-error",
                &format!("{} {error}", self.context),
            );
        }
    }
}

#[cfg(test)]
pub fn spawn_foreground(
    command: &str,
    working_directory: Option<&Path>,
    log_path: &Path,
) -> Result<ManagedProcess, String> {
    spawn(command, working_directory, log_path, &[])
}

pub(crate) fn spawn_with_environment(
    command: &str,
    working_directory: Option<&Path>,
    log_path: &Path,
    environment: &[(OsString, OsString)],
) -> Result<ManagedProcess, String> {
    spawn(command, working_directory, log_path, environment)
}

pub fn stop_child(child: &mut ManagedProcess) -> Result<(), String> {
    child
        .stop_tree()
        .map_err(|error| format!("结束进程树失败：{error}"))?;
    let status = child
        .child
        .wait()
        .map_err(|error| format!("等待命令进程退出失败：{error}"))?;
    let result = child.finish_readers();
    logging::write(
        &child.log_path,
        "process-stop",
        &format!("{} exit={status}", child.context),
    );
    result
        .map(|_| ())
        .map_err(|error| format!("读取命令输出失败：{error}"))
}

#[cfg(test)]
pub fn run_capture(
    command: &str,
    working_directory: Option<&Path>,
    timeout: Duration,
    log_path: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Output, String> {
    run_capture_with_environment(
        command,
        working_directory,
        timeout,
        log_path,
        cancelled,
        &[],
    )
}

pub(crate) fn run_capture_with_environment(
    command: &str,
    working_directory: Option<&Path>,
    timeout: Duration,
    log_path: &Path,
    cancelled: &dyn Fn() -> bool,
    environment: &[(OsString, OsString)],
) -> Result<Output, String> {
    if cancelled() {
        return Err("命令已取消".into());
    }
    let process = spawn(command, working_directory, log_path, environment)?;
    capture_process(process, timeout, log_path, cancelled)
}

pub(crate) fn run_program(
    program: &Path,
    arguments: &[&str],
    working_directory: Option<&Path>,
    timeout: Duration,
    log_path: &Path,
    cancelled: &dyn Fn() -> bool,
    environment: &[(OsString, OsString)],
) -> Result<Output, String> {
    if cancelled() {
        return Err("命令已取消".into());
    }
    let mut command = Command::new(program);
    command.args(arguments);
    let description = format!("{} {:?}", program.display(), arguments);
    let process = spawn_command(
        command,
        &description,
        working_directory,
        log_path,
        environment,
    )?;
    capture_process(process, timeout, log_path, cancelled)
}

fn capture_process(
    mut process: ManagedProcess,
    timeout: Duration,
    log_path: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Output, String> {
    let started = Instant::now();
    loop {
        match process.child.try_wait() {
            Ok(Some(status)) => {
                process
                    .stop_tree()
                    .map_err(|error| format!("清理命令进程树失败：{error}"))?;
                let (stdout, stderr) = process.finish_readers().map_err(|error| {
                    logging::write(
                        log_path,
                        "capture-error",
                        &format!(
                            "{} elapsed_ms={} exit={status} {error}",
                            process.context,
                            started.elapsed().as_millis()
                        ),
                    );
                    format!("读取命令输出失败：{error}")
                })?;
                logging::write(
                    log_path,
                    "capture-end",
                    &format!(
                        "{} elapsed_ms={} exit={status}",
                        process.context,
                        started.elapsed().as_millis()
                    ),
                );
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Err(error) => {
                logging::write(
                    log_path,
                    "capture-error",
                    &format!("{} {error}", process.context),
                );
                return Err(format!("检查命令状态失败：{error}"));
            }
            Ok(None) => {}
        }
        let is_cancelled = cancelled();
        if is_cancelled || started.elapsed() >= timeout {
            let reason = if is_cancelled {
                "已取消"
            } else {
                "执行超时"
            };
            logging::write(
                log_path,
                "capture-stop",
                &format!(
                    "{} elapsed_ms={} reason={reason}",
                    process.context,
                    started.elapsed().as_millis()
                ),
            );
            stop_child(&mut process)?;
            return Err(format!("命令{reason}"));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn spawn(
    command: &str,
    working_directory: Option<&Path>,
    log_path: &Path,
    environment: &[(OsString, OsString)],
) -> Result<ManagedProcess, String> {
    spawn_command(
        shell_command(command),
        command,
        working_directory,
        log_path,
        environment,
    )
}

fn spawn_command(
    mut process: Command,
    command: &str,
    working_directory: Option<&Path>,
    log_path: &Path,
    environment: &[(OsString, OsString)],
) -> Result<ManagedProcess, String> {
    process.envs(environment.iter().cloned());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process
            .creation_flags(0x08000000 | windows_sys::Win32::System::Threading::CREATE_SUSPENDED);
    }
    process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(directory) = working_directory {
        process.current_dir(directory);
    }
    let child = process.spawn().map_err(|error| {
        logging::write(
            log_path,
            "process-spawn-error",
            &format!(
                "cwd={} {error}",
                working_directory
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "<current>".to_string())
            ),
        );
        format!("启动命令失败：{error}")
    })?;
    let context = format!(
        "pid={} command={} cwd={}",
        child.id(),
        command,
        working_directory
            .map(|directory| directory.display().to_string())
            .unwrap_or_else(|| std::env::current_dir()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| "<unknown>".to_string()))
    );
    logging::write(log_path, "process-start", &context);
    #[cfg(windows)]
    let job = match windows_job::Job::attach_and_resume(&child) {
        Ok(job) => job,
        Err(error) => {
            logging::write(log_path, "process-job-error", &format!("{context} {error}"));
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("创建命令进程树失败：{error}"));
        }
    };
    #[cfg(unix)]
    let process_group = Some(child.id() as i32);
    let mut managed = ManagedProcess {
        child,
        #[cfg(unix)]
        process_group,
        #[cfg(windows)]
        job,
        stdout: None,
        stderr: None,
        log_path: log_path.to_path_buf(),
        context,
        output: (Vec::new(), Vec::new()),
    };
    let stdout = managed.child.stdout.take().expect("stdout 已配置为 pipe");
    let stderr = managed.child.stderr.take().expect("stderr 已配置为 pipe");
    managed.stdout = Some(
        start_reader(
            stdout,
            managed.log_path.clone(),
            managed.context.clone(),
            "stdout",
            true,
        )
        .map_err(|error| format!("启动 stdout 读取线程失败：{error}"))?,
    );
    managed.stderr = Some(
        start_reader(
            stderr,
            managed.log_path.clone(),
            managed.context.clone(),
            "stderr",
            true,
        )
        .map_err(|error| format!("启动 stderr 读取线程失败：{error}"))?,
    );
    Ok(managed)
}

fn start_reader(
    mut reader: impl Read + Send + 'static,
    log_path: PathBuf,
    context: String,
    stream: &'static str,
    capture: bool,
) -> io::Result<JoinHandle<io::Result<Vec<u8>>>> {
    thread::Builder::new()
        .name(format!("desktop-{stream}"))
        .spawn(move || {
            let mut tail = Vec::new();
            let mut buffer = [0u8; 8192];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        logging::write_output(
                            &log_path,
                            &context,
                            stream,
                            decode_output(&pending).as_bytes(),
                        );
                        return Ok(tail);
                    }
                    Ok(length) => {
                        pending.extend_from_slice(&buffer[..length]);
                        let split = pending
                            .iter()
                            .rposition(|byte| *byte == b'\n')
                            .map(|index| index + 1)
                            .or_else(|| {
                                (pending.len() >= TAIL_LIMIT)
                                    .then(|| output_prefix_length(&pending))
                            });
                        if let Some(split) = split {
                            logging::write_output(
                                &log_path,
                                &context,
                                stream,
                                decode_output(&pending[..split]).as_bytes(),
                            );
                            pending.drain(..split);
                        }
                        if capture {
                            let chunk = &buffer[..length];
                            let excess = tail.len() + chunk.len();
                            if excess > TAIL_LIMIT {
                                tail.drain(..excess - TAIL_LIMIT);
                            }
                            tail.extend_from_slice(chunk);
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        logging::write(
                            &log_path,
                            "process-read-error",
                            &format!("{context} stream={stream} {error}"),
                        );
                        return Err(error);
                    }
                }
            }
        })
}

fn join_reader(reader: Option<JoinHandle<io::Result<Vec<u8>>>>) -> io::Result<Vec<u8>> {
    match reader {
        Some(reader) => reader
            .join()
            .map_err(|_| io::Error::other("输出读取线程崩溃"))?,
        None => Ok(Vec::new()),
    }
}

fn output_prefix_length(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => return bytes.len(),
        Err(error) if error.error_len().is_none() => return error.valid_up_to(),
        Err(_) => {}
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Globalization::{GetOEMCP, IsDBCSLeadByteEx};
        let mut index = 0;
        while index < bytes.len() {
            let width = if IsDBCSLeadByteEx(GetOEMCP(), bytes[index]) != 0 {
                2
            } else {
                1
            };
            if index + width > bytes.len() {
                return index;
            }
            index += width;
        }
    }
    bytes.len()
}

pub(crate) fn decode_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Globalization::{GetOEMCP, MultiByteToWideChar};
        let length = MultiByteToWideChar(
            GetOEMCP(),
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        );
        if length > 0 {
            let mut wide = vec![0u16; length as usize];
            MultiByteToWideChar(
                GetOEMCP(),
                0,
                bytes.as_ptr(),
                bytes.len() as i32,
                wide.as_mut_ptr(),
                length,
            );
            return String::from_utf16_lossy(&wide);
        }
    }
    String::from_utf8_lossy(bytes).to_string()
}

fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    let process = {
        let mut process = Command::new("cmd.exe");
        use std::os::windows::process::CommandExt;
        process.args(["/D", "/S", "/C"]);
        if command.starts_with('"') {
            process.raw_arg(format!("\"{command}\""));
        } else {
            process.raw_arg(command);
        }
        process
            .creation_flags(0x08000000 | windows_sys::Win32::System::Threading::CREATE_SUSPENDED);
        process
    };
    #[cfg(not(windows))]
    let process = {
        let mut process = Command::new("/bin/sh");
        process.args(["-c", command]);
        process
    };
    process
}

#[cfg(windows)]
mod windows_job {
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::process::Child;
    use std::thread;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    pub(super) struct Job {
        handle: OwnedHandle,
    }
    impl Job {
        pub(super) fn attach_and_resume(child: &Child) -> io::Result<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Self {
                    handle: OwnedHandle::from_raw_handle(handle),
                };
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                    || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
                if snapshot == INVALID_HANDLE_VALUE {
                    return Err(io::Error::last_os_error());
                }
                let snapshot = OwnedHandle::from_raw_handle(snapshot);
                let mut entry: THREADENTRY32 = zeroed();
                entry.dwSize = size_of::<THREADENTRY32>() as u32;
                if Thread32First(snapshot.as_raw_handle(), &mut entry) == 0 {
                    return Err(io::Error::last_os_error());
                }
                loop {
                    if entry.th32OwnerProcessID == child.id() {
                        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                        if thread.is_null() {
                            return Err(io::Error::last_os_error());
                        }
                        let thread = OwnedHandle::from_raw_handle(thread);
                        if ResumeThread(thread.as_raw_handle()) == u32::MAX {
                            return Err(io::Error::last_os_error());
                        }
                        return Ok(job);
                    }
                    if Thread32Next(snapshot.as_raw_handle(), &mut entry) == 0 {
                        return Err(io::Error::new(io::ErrorKind::NotFound, "未找到命令主线程"));
                    }
                }
            }
        }

        pub(super) fn terminate(&self) -> io::Result<()> {
            if unsafe { TerminateJobObject(self.handle.as_raw_handle(), 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            // TerminateJobObject 只发出终止请求，启动器退出不代表所有后代已退出。
            let started = Instant::now();
            loop {
                let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
                if unsafe {
                    QueryInformationJobObject(
                        self.handle.as_raw_handle(),
                        JobObjectBasicAccountingInformation,
                        &mut accounting as *mut _ as _,
                        size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                        std::ptr::null_mut(),
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                if accounting.ActiveProcesses == 0 {
                    return Ok(());
                }
                if started.elapsed() >= Duration::from_secs(5) {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!(
                            "等待托管进程树退出超时，仍有 {} 个进程",
                            accounting.ActiveProcesses
                        ),
                    ));
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{run_capture, TAIL_LIMIT};
    #[cfg(windows)]
    use super::{spawn_foreground, stop_child};
    use std::fs;
    use std::path::{Path, PathBuf};
    #[cfg(not(windows))]
    use std::process::Command;
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    fn test_directory(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-react/react-lifecycle-tests")
            .join(format!("{name}-{}-{suffix}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn write_node_script(directory: &Path, name: &str, source: &str) -> PathBuf {
        let path = directory.join(format!("{name}.js"));
        fs::write(&path, source).unwrap();
        path
    }

    fn node_file_command(path: &Path) -> String {
        format!("node \"{}\"", path.display())
    }

    fn wait_for_process_exit(pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while process_is_running(pid) {
            assert!(Instant::now() < deadline, "进程 {pid} 仍在运行");
            thread::sleep(Duration::from_millis(25));
        }
    }

    #[cfg(windows)]
    fn process_is_running(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return false;
        }
        let mut exit_code = 0;
        let queried = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
        unsafe { CloseHandle(handle) };
        assert!(queried, "读取进程 {pid} 状态失败");
        exit_code == STILL_ACTIVE as u32
    }

    #[cfg(not(windows))]
    fn process_is_running(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success())
    }

    fn pid_from(path: &Path) -> u32 {
        fs::read_to_string(path).unwrap().trim().parse().unwrap()
    }

    #[test]
    fn drains_both_large_output_pipes_and_keeps_bounded_tails() {
        let directory = test_directory("process-output-tails");
        let log = directory.join("server.log");
        let script = write_node_script(
            &directory,
            "large-output",
            "process.stdout.write('O'.repeat(2 * 1024 * 1024));process.stderr.write('E'.repeat(2 * 1024 * 1024));",
        );
        let output = run_capture(
            &node_file_command(&script),
            None,
            Duration::from_secs(30),
            &log,
            &|| false,
        )
        .unwrap();

        assert!(output.status.success());
        assert_eq!(output.stdout.len(), TAIL_LIMIT);
        assert_eq!(output.stderr.len(), TAIL_LIMIT);
        assert!(output.stdout.iter().all(|byte| *byte == b'O'));
        assert!(output.stderr.iter().all(|byte| *byte == b'E'));
        let logged = fs::read_to_string(&log).unwrap();
        assert!(logged.contains("[stdout]"));
        assert!(logged.contains("[stderr]"));

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn timeout_kills_the_command_and_joins_output_readers() {
        let directory = test_directory("process-timeout");
        let log = directory.join("desktop.log");
        let pid_path = directory.join("pid.txt");
        let source = "const fs=require('node:fs');fs.writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},1000);";
        let script = write_node_script(&directory, "long-running", source);
        let command = format!("node \"{}\"", script.file_name().unwrap().to_string_lossy());
        let error = run_capture(
            &command,
            Some(&directory),
            Duration::from_secs(5),
            &log,
            &|| false,
        )
        .unwrap_err();

        assert!(error.contains("超时"));
        wait_for_process_exit(pid_from(&pid_path));
        assert!(fs::read_to_string(&log)
            .unwrap()
            .contains("reason=执行超时"));

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancellation_kills_the_command_and_joins_output_readers() {
        let directory = test_directory("process-cancellation");
        let log = directory.join("desktop.log");
        let pid_path = directory.join("pid.txt");
        let source = "const fs=require('node:fs');fs.writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},1000);";
        let script = write_node_script(&directory, "long-running", source);
        let command = format!("node \"{}\"", script.file_name().unwrap().to_string_lossy());
        let started = Instant::now();
        let error = run_capture(
            &command,
            Some(&directory),
            Duration::from_secs(10),
            &log,
            &|| pid_path.exists() && started.elapsed() >= Duration::from_millis(300),
        )
        .unwrap_err();

        assert!(error.contains("已取消"));
        wait_for_process_exit(pid_from(&pid_path));
        assert!(fs::read_to_string(&log).unwrap().contains("reason=已取消"));

        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn command_line_quotes_reach_cmd_without_rust_reescaping() {
        let directory = test_directory("process-node-expression");
        let output = run_capture(
            "node -p \"1 + 1\"",
            None,
            Duration::from_secs(10),
            &directory.join("desktop.log"),
            &|| false,
        )
        .unwrap();

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "2");

        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn command_line_preserves_quoted_path_arguments_and_working_directory() {
        let directory = test_directory("process-command spaces");
        let working_directory = directory.join("working directory");
        fs::create_dir_all(&working_directory).unwrap();
        let script = working_directory.join("echo arguments.js");
        fs::write(
            &script,
            "process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));",
        )
        .unwrap();
        let command = format!("node \"{}\" \"argument with spaces\"", script.display());
        let output = run_capture(
            &command,
            Some(&working_directory),
            Duration::from_secs(10),
            &directory.join("desktop.log"),
            &|| false,
        )
        .unwrap();
        assert!(output.status.success());
        let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["args"], serde_json::json!(["argument with spaces"]));
        assert_eq!(
            PathBuf::from(result["cwd"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            working_directory.canonicalize().unwrap()
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn stopped_tree_and_port_gate_allow_immediate_rebind() {
        use std::net::TcpListener;

        let directory = test_directory("process-listener-tree");
        let ready = directory.join("ready.json");
        let leaf = write_node_script(
            &directory,
            "listener",
            &format!(
                r#"
const net = require('node:net');
const fs = require('node:fs');
const server = net.createServer(socket => socket.end());
server.listen(0, '127.0.0.1', () => {{
  fs.writeFileSync({}, JSON.stringify({{
    port: server.address().port,
    pids: [Number(process.env.FIXTURE_PARENT_PID), process.ppid, process.pid]
  }}));
}});
"#,
                serde_json::to_string(&ready.to_string_lossy()).unwrap()
            ),
        );
        let bridge = write_node_script(
            &directory,
            "bridge",
            &format!(
                "require('node:child_process').spawn(process.execPath,[{}],{{stdio:'ignore'}});",
                serde_json::to_string(&leaf.to_string_lossy()).unwrap()
            ),
        );
        let parent = write_node_script(
            &directory,
            "parent",
            &format!(
                r#"
process.env.FIXTURE_PARENT_PID = String(process.pid);
require('node:child_process').spawn(process.execPath, [{}], {{stdio: 'ignore'}});
"#,
                serde_json::to_string(&bridge.to_string_lossy()).unwrap()
            ),
        );
        for _ in 0..10 {
            let mut process = spawn_foreground(
                &node_file_command(&parent),
                Some(&directory),
                &directory.join("server.log"),
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !ready.exists() {
                assert!(Instant::now() < deadline, "子服务没有进入监听状态");
                thread::sleep(Duration::from_millis(20));
            }
            let state: serde_json::Value =
                serde_json::from_slice(&fs::read(&ready).unwrap()).unwrap();
            let port = state["port"].as_u64().unwrap() as u16;
            stop_child(&mut process).unwrap();
            for value in state["pids"].as_array().unwrap() {
                let pid = value.as_u64().unwrap() as u32;
                assert!(
                    !process_is_running(pid),
                    "停止已返回，但子进程 {pid} 仍存活"
                );
            }
            crate::service_port::wait_until_free(
                port,
                Duration::from_secs(5),
                &directory.join("desktop.log"),
            )
            .unwrap();
            let listener = TcpListener::bind(("127.0.0.1", port))
                .expect("停止与端口释放检查已返回，但端口不可复用");
            drop(listener);
            fs::remove_file(&ready).unwrap();
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn parent_exit_terminates_descendants_before_capture_returns() {
        let directory = test_directory("process-parent-exit");
        let log = directory.join("server.log");
        let marker = directory.join("late-child-write.txt");
        let parent_pid = directory.join("parent-pid.txt");
        let child_pid = directory.join("child-pid.txt");
        let child_source = format!(
            "setTimeout(()=>require('node:fs').writeFileSync({},'late'),5000)",
            serde_json::to_string(&marker.to_string_lossy()).unwrap()
        );
        let source = format!(
            "const {{spawn}}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',{}],{{stdio:'ignore'}});fs.writeFileSync({},String(process.pid));fs.writeFileSync({},String(child.pid));child.unref();process.stdout.write('parent-finished');",
            serde_json::to_string(&child_source).unwrap(),
            serde_json::to_string(&parent_pid.to_string_lossy()).unwrap(),
            serde_json::to_string(&child_pid.to_string_lossy()).unwrap()
        );
        let script = write_node_script(&directory, "spawn-descendant", &source);
        let output = run_capture(
            &node_file_command(&script),
            None,
            Duration::from_secs(10),
            &log,
            &|| false,
        )
        .unwrap();

        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("parent-finished"));
        wait_for_process_exit(pid_from(&parent_pid));
        wait_for_process_exit(pid_from(&child_pid));
        assert!(!marker.exists());

        fs::remove_dir_all(directory).unwrap();
    }
}
