use super::parallel;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

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
