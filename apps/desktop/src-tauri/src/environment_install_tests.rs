use super::{parallel, prepare_components};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[test]
fn node_install_and_pi_finish_while_git_is_still_downloading() {
    let (git_started, wait_git) = mpsc::channel();
    let (pi_finished, wait_pi) = mpsc::channel();
    let node_ready = AtomicBool::new(false);
    let installed_node = &node_ready;
    prepare_components(
        &|| false,
        move |_| {
            wait_git.recv_timeout(Duration::from_secs(2)).unwrap();
            installed_node.store(true, Ordering::Release);
            Ok(())
        },
        move |_| {
            git_started.send(()).unwrap();
            wait_pi.recv_timeout(Duration::from_secs(2)).unwrap();
            Ok(())
        },
        |_| {
            assert!(
                node_ready.load(Ordering::Acquire),
                "Pi 必须等待 Node.js 安装完成"
            );
            pi_finished.send(()).unwrap();
            Ok(())
        },
        |_| Ok(()),
    )
    .unwrap();
}

#[test]
fn git_installs_without_waiting_for_node_download() {
    let (node_started, wait_node) = mpsc::channel();
    let (git_installed, wait_git) = mpsc::channel();
    prepare_components(
        &|| false,
        move |_| {
            node_started.send(()).unwrap();
            wait_git.recv_timeout(Duration::from_secs(2)).unwrap();
            Ok(())
        },
        move |_| {
            wait_node.recv_timeout(Duration::from_secs(2)).unwrap();
            git_installed.send(()).unwrap();
            Ok(())
        },
        |_| Ok(()),
        |_| Ok(()),
    )
    .unwrap();
}

#[test]
fn pi_and_service_install_in_parallel_after_node_is_ready() {
    let node_ready = AtomicBool::new(false);
    let ready = &node_ready;
    let (pi_started, wait_pi) = mpsc::channel();
    let (service_started, wait_service) = mpsc::channel();
    prepare_components(
        &|| false,
        |_| {
            node_ready.store(true, Ordering::Release);
            Ok(())
        },
        |_| Ok(()),
        move |_| {
            assert!(ready.load(Ordering::Acquire));
            pi_started.send(()).unwrap();
            wait_service
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| "Pi Desk 必须与 Pi 并行安装".to_string())?;
            Ok(())
        },
        move |_| {
            assert!(ready.load(Ordering::Acquire));
            service_started.send(()).unwrap();
            wait_pi
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| "Pi 必须与 Pi Desk 并行安装".to_string())?;
            Ok(())
        },
    )
    .unwrap();
}

#[test]
fn service_failure_cancels_pi_and_waits_for_it_to_exit() {
    let (pi_started, wait_pi) = mpsc::channel();
    let pi_finished = AtomicBool::new(false);
    let result = prepare_components(
        &|| false,
        |_| Ok(()),
        |_| Ok(()),
        |stopped| {
            pi_started.send(()).unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while !stopped() {
                assert!(Instant::now() < deadline, "服务安装失败必须取消 Pi 安装");
                std::thread::yield_now();
            }
            pi_finished.store(true, Ordering::Release);
            Err("操作已取消".into())
        },
        move |_| {
            wait_pi.recv_timeout(Duration::from_secs(2)).unwrap();
            Err("服务安装失败".into())
        },
    );
    assert_eq!(result.unwrap_err(), "服务安装失败");
    assert!(pi_finished.load(Ordering::Acquire));
}

#[test]
fn failed_or_cancelled_node_preparation_never_starts_npm() {
    for failed in [true, false] {
        let cancelled = AtomicBool::new(false);
        let pi_started = AtomicBool::new(false);
        let service_started = AtomicBool::new(false);
        let result = prepare_components(
            &|| cancelled.load(Ordering::Acquire),
            |_| {
                if failed {
                    Err("Node.js 安装失败".into())
                } else {
                    cancelled.store(true, Ordering::Release);
                    Ok(())
                }
            },
            |_| Ok(()),
            |_| {
                pi_started.store(true, Ordering::Release);
                Ok(())
            },
            |_| {
                service_started.store(true, Ordering::Release);
                Ok(())
            },
        );
        assert_eq!(
            result.unwrap_err(),
            if failed {
                "Node.js 安装失败"
            } else {
                "操作已取消"
            }
        );
        assert!(!pi_started.load(Ordering::Acquire));
        assert!(!service_started.load(Ordering::Acquire));
    }
}

#[test]
fn independent_preparation_tasks_run_without_waiting_for_each_other() {
    let (first_started, wait_first) = mpsc::channel();
    let (second_started, wait_second) = mpsc::channel();
    let result = parallel(
        &|| false,
        move |_| {
            first_started.send(()).unwrap();
            wait_second
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| "第二个任务没有并行启动".to_string())?;
            Ok("Node.js 与 Pi")
        },
        move |_| {
            wait_first
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| "第一个任务没有并行启动".to_string())?;
            second_started.send(()).unwrap();
            Ok("Git Bash")
        },
    );
    assert_eq!(result.unwrap(), ("Node.js 与 Pi", "Git Bash"));
}

#[test]
fn either_failure_stops_the_other_task_and_preserves_the_original_error() {
    for fail_first in [true, false] {
        let finished = AtomicBool::new(false);
        let (active, wait_active) = mpsc::channel();
        let working = |stopped: &(dyn Fn() -> bool + Sync)| -> Result<(), String> {
            active.send(()).unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while !stopped() {
                assert!(Instant::now() < deadline, "失败必须取消另一项准备任务");
                std::thread::yield_now();
            }
            finished.store(true, Ordering::Release);
            Err("操作已取消".into())
        };
        let failing = move |_: &(dyn Fn() -> bool + Sync)| -> Result<(), String> {
            wait_active.recv_timeout(Duration::from_secs(2)).unwrap();
            Err("官方下载校验失败".into())
        };
        let result = if fail_first {
            parallel(&|| false, failing, working)
        } else {
            parallel(&|| false, working, failing)
        };
        assert_eq!(result.unwrap_err(), "官方下载校验失败");
        assert!(
            finished.load(Ordering::Acquire),
            "返回前必须等待全部任务退出"
        );
    }
}

#[test]
fn cancellation_is_shared_by_all_preparation_tasks() {
    let cancel = AtomicBool::new(false);
    let first_finished = AtomicBool::new(false);
    let cancel_ref = &cancel;
    let (active, wait_active) = mpsc::channel();
    let result = parallel(
        &|| cancel.load(Ordering::Acquire),
        |stopped| -> Result<(), String> {
            active.send(()).unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while !stopped() {
                assert!(Instant::now() < deadline, "取消必须传递给全部准备任务");
                std::thread::yield_now();
            }
            first_finished.store(true, Ordering::Release);
            Err("操作已取消".into())
        },
        move |stopped| -> Result<(), String> {
            wait_active.recv_timeout(Duration::from_secs(2)).unwrap();
            cancel_ref.store(true, Ordering::Release);
            assert!(stopped());
            Err("操作已取消".into())
        },
    );
    assert!(result.unwrap_err().contains("取消"));
    assert!(first_finished.load(Ordering::Acquire));
}
