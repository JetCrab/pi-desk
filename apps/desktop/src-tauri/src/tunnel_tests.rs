use super::*;
use pi_desk_tunnel_common::worker::{
    TunnelForwardSnapshot, TunnelPublicationSnapshot, TunnelWorkerSnapshot,
};

pub(crate) fn test_config() -> TunnelConnectionConfig {
    TunnelConnectionConfig {
        control_server_url: "http://127.0.0.1:9".into(),
        control_key: "ab".repeat(32),
        provider_secret_key: "cd".repeat(32),
        publications: vec![TunnelPublication {
            local_port: 5432,
            public_port: Some(41001),
            enabled: true,
        }],
        forwards: vec![TunnelForward {
            provider_id: "ef".repeat(32),
            remote_port: 5432,
            local_port: 15432,
            enabled: true,
        }],
        ..Default::default()
    }
}

pub(crate) fn stopped_owner(config: &TunnelConnectionConfig) -> DesktopTunnel {
    let mut owner = DesktopTunnel::default();
    owner.reconcile(config, None).unwrap();
    owner.worker.as_ref().unwrap().stop();
    owner
}

fn failed_snapshot() -> TunnelWorkerSnapshot {
    TunnelWorkerSnapshot {
        provider_id: None,
        mode: TunnelMode::Auto,
        publications: vec![TunnelPublicationSnapshot {
            local_port: 5432,
            public_port: Some(41001),
            phase: TunnelPhase::Failed,
            detail: "发布清理失败".into(),
            public_addr: Some("old.example.test:41001".into()),
        }],
        forwards: vec![TunnelForwardSnapshot {
            provider_id: "ef".repeat(32),
            remote_port: 5432,
            local_port: 15432,
            phase: TunnelPhase::Failed,
            detail: "映射清理失败".into(),
            path: TunnelPath::Direct,
        }],
        connections: vec![],
    }
}

#[test]
fn captures_first_connection_for_later_ports_and_mode_changes() {
    let mut owner = DesktopTunnel::default();
    let mut config = TunnelConnectionConfig {
        control_server_url: "http://127.0.0.1:9".into(),
        control_key: "ab".repeat(32),
        provider_secret_key: "cd".repeat(32),
        ..Default::default()
    };
    owner.reconcile(&config, None).unwrap();
    assert!(owner.captured.is_none());
    config.forwards.push(TunnelForward {
        provider_id: "ef".repeat(32),
        remote_port: 5432,
        local_port: 15432,
        enabled: true,
    });
    owner.reconcile(&config, None).unwrap();
    assert!(!owner.snapshot(&config).restart_required);
    config.control_server_url = "http://127.0.0.1:10".into();
    config.control_key = "ef".repeat(32);
    config.mode = TunnelMode::RelayOnly;
    config.forwards.push(TunnelForward {
        provider_id: "ef".repeat(32),
        remote_port: 6379,
        local_port: 16379,
        enabled: true,
    });
    owner.reconcile(&config, None).unwrap();
    assert!(owner.snapshot(&config).restart_required);
    let captured = owner.captured.as_ref().unwrap();
    assert_eq!(captured.control_server_url, "http://127.0.0.1:9");
    assert_eq!(captured.control_key, [0xab; 32]);
    config.control_server_url = captured.control_server_url.clone();
    config.control_key = "ab".repeat(32);
    assert!(!owner.snapshot(&config).restart_required);
    owner.take_worker().unwrap().shutdown().unwrap();
}

#[test]
fn rejected_retries_and_stops_preserve_accepted_owner_records() {
    let config = test_config();
    let mut owner = stopped_owner(&config);
    for retry in [TunnelRetry::Publication(5432), TunnelRetry::Forward(15432)] {
        assert!(owner.reconcile(&config, Some(retry)).is_err());
        assert_eq!(owner.publications.get(&5432), Some(&config.publications[0]));
        assert_eq!(owner.forwards.get(&15432), Some(&config.forwards[0]));
    }
    let mut deleted = config.clone();
    deleted.publications.clear();
    deleted.forwards.clear();
    assert!(owner.reconcile(&deleted, None).is_err());
    let snapshot = owner.snapshot(&deleted);
    assert_eq!(snapshot.publications[0].config.local_port, 5432);
    assert_eq!(snapshot.forwards[0].config.local_port, 15432);
    owner.take_worker().unwrap().shutdown().unwrap();
}

#[test]
fn disabled_and_reconfigured_failed_rows_remain_visible_without_old_address_or_path() {
    let owner = DesktopTunnel::default();
    for enabled in [false, true] {
        let mut config = test_config();
        config.publications[0].enabled = enabled;
        config.forwards[0].enabled = enabled;
        let snapshot = owner.project_snapshot(&config, Some(failed_snapshot()));
        assert_eq!(snapshot.publications[0].phase, TunnelPhase::Failed);
        assert_eq!(snapshot.publications[0].detail, "发布清理失败");
        assert_eq!(snapshot.forwards[0].phase, TunnelPhase::Failed);
        assert_eq!(snapshot.forwards[0].detail, "映射清理失败");
        assert!(snapshot.publications[0].public_addr.is_none());
        assert_eq!(snapshot.forwards[0].path, TunnelPath::Unknown);
        config.publications[0].public_port = Some(41002);
        config.forwards[0].provider_id = "ab".repeat(32);
        config.forwards[0].remote_port = 6379;
        let snapshot = owner.project_snapshot(&config, Some(failed_snapshot()));
        assert_eq!(snapshot.publications[0].phase, TunnelPhase::Failed);
        assert!(
            snapshot.publications[0].detail.contains("41001")
                && snapshot.publications[0].detail.contains("发布清理失败")
        );
        assert_eq!(snapshot.forwards[0].phase, TunnelPhase::Failed);
        assert!(
            snapshot.forwards[0].detail.contains("5432")
                && snapshot.forwards[0].detail.contains("映射清理失败")
        );
        assert!(snapshot.publications[0].public_addr.is_none());
        assert_eq!(snapshot.forwards[0].path, TunnelPath::Unknown);
    }
}

#[test]
fn cleanup_failure_explains_the_desktop_restart_action() {
    let owner = DesktopTunnel::default();
    let mut config = test_config();
    for changed in [false, true] {
        if changed {
            config.publications[0].public_port = None;
            config.forwards[0].remote_port = 6379;
        }
        let mut worker = failed_snapshot();
        for detail in [
            &mut worker.publications[0].detail,
            &mut worker.forwards[0].detail,
        ] {
            *detail = "旧项清理失败，尚未确认完成：测试原因。需重建隧道后台后重试。".into();
        }
        let snapshot = owner.project_snapshot(&config, Some(worker));
        for detail in [
            &snapshot.publications[0].detail,
            &snapshot.forwards[0].detail,
        ] {
            assert!(detail.contains("测试原因") && detail.contains("退出并重启应用后重试"));
            assert!(!detail.contains("重建隧道后台"));
        }
    }
}

#[test]
fn worker_only_cleanup_failures_keep_disabled_management_rows() {
    let owner = DesktopTunnel::default();
    let snapshot =
        owner.project_snapshot(&TunnelConnectionConfig::default(), Some(failed_snapshot()));
    assert_eq!(snapshot.publications[0].config.local_port, 5432);
    assert!(!snapshot.publications[0].config.enabled);
    assert_eq!(snapshot.publications[0].phase, TunnelPhase::Failed);
    assert_eq!(snapshot.publications[0].detail, "发布清理失败");
    assert_eq!(snapshot.forwards[0].config.local_port, 15432);
    assert!(!snapshot.forwards[0].config.enabled);
    assert_eq!(snapshot.forwards[0].phase, TunnelPhase::Failed);
}

#[test]
fn rejected_stop_is_not_projected_as_stopping_before_worker_snapshot_arrives() {
    let config = test_config();
    let mut owner = DesktopTunnel {
        error: Some("隧道命令队列已满，请稍后重试".into()),
        ..Default::default()
    };
    owner
        .publications
        .insert(5432, config.publications[0].clone());
    owner.forwards.insert(15432, config.forwards[0].clone());
    let mut disabled = config;
    disabled.publications[0].enabled = false;
    disabled.forwards[0].enabled = false;
    let snapshot = owner.project_snapshot(&disabled, None);
    assert_eq!(snapshot.publications[0].phase, TunnelPhase::Failed);
    assert!(snapshot.publications[0].detail.contains("队列已满"));
    assert_eq!(snapshot.forwards[0].phase, TunnelPhase::Failed);
    assert!(snapshot.forwards[0].detail.contains("队列已满"));
}
