use std::io;
use std::net::TcpListener;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use crate::logging;

/// 进程退出后，系统仍可能短暂保留套接字；不以 TCP 拒绝连接代替可绑定检查。
pub fn wait_until_free(port: u16, timeout: Duration, log_path: &Path) -> Result<(), String> {
    let started = Instant::now();
    let mut waiting = false;
    loop {
        let error = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => {
                drop(listener);
                if waiting {
                    logging::write(
                        log_path,
                        "service-port-released",
                        &format!("port={port} elapsed_ms={}", started.elapsed().as_millis()),
                    );
                }
                return Ok(());
            }
            Err(error) => error,
        };
        let expired = started.elapsed() >= timeout
            || !matches!(
                error.kind(),
                io::ErrorKind::AddrInUse | io::ErrorKind::PermissionDenied
            );
        if !waiting || expired {
            let detail = format!(
                "端口 {port} 暂不可用（{}），未停止占用进程：{error}",
                listener_description(port)
            );
            logging::write(
                log_path,
                if expired {
                    "service-port-unavailable"
                } else {
                    "service-port-wait"
                },
                &format!(
                    "port={port} elapsed_ms={} detail={detail}",
                    started.elapsed().as_millis()
                ),
            );
            if expired {
                return Err(detail);
            }
            waiting = true;
        }
        thread::sleep(Duration::from_millis(20).min(timeout.saturating_sub(started.elapsed())));
    }
}

#[cfg(not(windows))]
fn listener_description(port: u16) -> String {
    match std::process::Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
    {
        Ok(output) => {
            let pids = String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.parse::<u32>().ok())
                .map(|pid| pid.to_string())
                .collect::<Vec<_>>();
            if pids.is_empty() {
                "未取得监听进程 PID".into()
            } else {
                format!("同端口监听进程 PID：{}", pids.join(", "))
            }
        }
        Err(error) => format!("监听进程 PID 查询失败：{error}"),
    }
}

#[cfg(windows)]
fn listener_description(port: u16) -> String {
    match listening_pids(port) {
        Ok(pids) if pids.is_empty() => "未取得监听进程 PID".into(),
        Ok(pids) => format!(
            "同端口监听进程 PID：{}",
            pids.iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Err(error) => format!("监听进程 PID 查询失败：{error}"),
    }
}

#[cfg(windows)]
fn tcp_table(family: u16) -> io::Result<Vec<u32>> {
    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER,
    };

    let mut size = 0;
    // 表头和行需要 DWORD 对齐，不能用只有字节对齐保证的缓冲区。
    let mut buffer = Vec::<u32>::new();
    loop {
        let pointer = if buffer.is_empty() {
            std::ptr::null_mut()
        } else {
            buffer.as_mut_ptr().cast()
        };
        let result = unsafe {
            GetExtendedTcpTable(
                pointer,
                &mut size,
                0,
                u32::from(family),
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        match result {
            NO_ERROR => return Ok(buffer),
            ERROR_INSUFFICIENT_BUFFER => {
                buffer.resize((size as usize).div_ceil(size_of::<u32>()), 0)
            }
            _ => return Err(io::Error::from_raw_os_error(result as i32)),
        }
    }
}

#[cfg(windows)]
fn listening_pids(port: u16) -> io::Result<Vec<u32>> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID,
        MIB_TCPTABLE_OWNER_PID,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    let mut pids = Vec::new();
    for family in [AF_INET, AF_INET6] {
        let buffer = tcp_table(family)?;
        let count = buffer[0] as usize;
        if family == AF_INET {
            let rows = unsafe {
                std::slice::from_raw_parts(
                    buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(std::mem::offset_of!(MIB_TCPTABLE_OWNER_PID, table))
                        .cast::<MIB_TCPROW_OWNER_PID>(),
                    count,
                )
            };
            pids.extend(
                rows.iter()
                    .filter(|row| u16::from_be(row.dwLocalPort as u16) == port)
                    .map(|row| row.dwOwningPid),
            );
        } else {
            let rows = unsafe {
                std::slice::from_raw_parts(
                    buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(std::mem::offset_of!(MIB_TCP6TABLE_OWNER_PID, table))
                        .cast::<MIB_TCP6ROW_OWNER_PID>(),
                    count,
                )
            };
            pids.extend(
                rows.iter()
                    .filter(|row| u16::from_be(row.dwLocalPort as u16) == port)
                    .map(|row| row.dwOwningPid),
            );
        }
    }
    pids.sort_unstable();
    pids.dedup();
    Ok(pids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::net::TcpStream;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-react/react-lifecycle-tests")
            .join(format!("service-port-{}-{suffix}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn waits_for_delayed_port_release_before_allowing_rebind() {
        let directory = test_directory();
        let log = directory.join("desktop.log");
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker_log = log.clone();
        let worker =
            thread::spawn(move || wait_until_free(port, Duration::from_secs(3), &worker_log));
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut observed_wait = false;
        while Instant::now() < deadline {
            if fs::read_to_string(&log)
                .unwrap_or_default()
                .contains("[service-port-wait]")
            {
                observed_wait = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        drop(listener);
        let result = worker.join().unwrap();
        assert!(observed_wait, "端口仍被占用时必须进入等待，而不是立即报错");
        result.unwrap();
        let rebound = TcpListener::bind(("127.0.0.1", port)).unwrap();
        drop(rebound);
        assert!(fs::read_to_string(&log)
            .unwrap()
            .contains("[service-port-released]"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn refuses_occupied_port_without_stopping_its_listener() {
        let directory = test_directory();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        for timeout in [Duration::ZERO, Duration::from_millis(100)] {
            let error = wait_until_free(port, timeout, &directory.join("desktop.log")).unwrap_err();
            assert!(error.contains("未停止占用进程"));
            #[cfg(windows)]
            assert!(
                error.contains(&format!("PID：{}", std::process::id())),
                "{error}"
            );
            drop(TcpStream::connect(("127.0.0.1", port)).unwrap());
        }
        drop(listener);
        wait_until_free(port, Duration::from_secs(3), &directory.join("desktop.log")).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn reports_ipv6_listener_pid() {
        let listener = TcpListener::bind(("::1", 0)).unwrap();
        assert!(listening_pids(listener.local_addr().unwrap().port())
            .unwrap()
            .contains(&std::process::id()));
    }
}
