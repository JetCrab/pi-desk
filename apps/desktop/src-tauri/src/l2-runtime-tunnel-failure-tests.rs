use super::*;
use crate::tunnel::tests::{stopped_owner, test_config};

#[test]
fn rejected_delete_edit_disable_and_retry_restore_persisted_configuration() {
    type Operation = fn(&ShellState) -> Result<(), String>;
    let operations: [(&str, Operation); 10] = [
        ("delete-publication", |state| {
            delete_tunnel_publication(state, 5432)
        }),
        ("rename-publication", |state| {
            apply_tunnel_publication(
                state,
                Some(5432),
                TunnelPublication {
                    local_port: 5433,
                    ..test_config().publications[0].clone()
                },
            )
        }),
        ("change-public-port", |state| {
            apply_tunnel_publication(
                state,
                Some(5432),
                TunnelPublication {
                    public_port: Some(41002),
                    ..test_config().publications[0].clone()
                },
            )
        }),
        ("disable-publication", |state| {
            set_tunnel_publication_enabled(state, 5432, false)
        }),
        ("retry-publication", |state| {
            set_tunnel_publication_enabled(state, 5432, true)
        }),
        ("delete-forward", |state| {
            delete_tunnel_forward(state, 15432)
        }),
        ("rename-forward", |state| {
            apply_tunnel_forward(
                state,
                Some(15432),
                TunnelForward {
                    local_port: 15433,
                    ..test_config().forwards[0].clone()
                },
            )
        }),
        ("change-target", |state| {
            apply_tunnel_forward(
                state,
                Some(15432),
                TunnelForward {
                    provider_id: "ab".repeat(32),
                    remote_port: 6379,
                    ..test_config().forwards[0].clone()
                },
            )
        }),
        ("disable-forward", |state| {
            set_tunnel_forward_enabled(state, 15432, false)
        }),
        ("retry-forward", |state| {
            set_tunnel_forward_enabled(state, 15432, true)
        }),
    ];
    for (name, operation) in operations {
        let (directory, state) = fixture(name);
        let mut config = state.config().unwrap();
        config.tunnel = test_config();
        save_config(&state, config.clone()).unwrap();
        *state.tunnel.lock().unwrap() = stopped_owner(&config.tunnel);
        let before = fs::read(&state.config_path).unwrap();
        let error = operation(&state).unwrap_err();
        assert!(error.contains("已恢复原配置"), "{name}: {error}");
        assert_eq!(fs::read(&state.config_path).unwrap(), before, "{name}");
        let current = state.config().unwrap();
        assert_eq!(
            current.tunnel.publications, config.tunnel.publications,
            "{name}"
        );
        assert_eq!(current.tunnel.forwards, config.tunnel.forwards, "{name}");
        let snapshot = control_state(&state).unwrap().tunnel;
        assert!(
            snapshot
                .publications
                .iter()
                .any(|row| row.config.local_port == 5432),
            "{name}"
        );
        assert!(
            snapshot
                .forwards
                .iter()
                .any(|row| row.config.local_port == 15432),
            "{name}"
        );
        assert!(snapshot.error.is_some(), "{name}");
        let worker = state.tunnel.lock().unwrap().take_worker().unwrap();
        worker.shutdown().unwrap();
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn accepted_ports_not_in_rolled_back_config_remain_visible_and_manageable() {
    let (directory, state) = fixture("partial-acceptance");
    let mut config = state.config().unwrap();
    config.tunnel = test_config();
    save_config(&state, config.clone()).unwrap();
    let mut accepted = config.tunnel.clone();
    accepted.publications.push(TunnelPublication {
        local_port: 6432,
        public_port: None,
        enabled: true,
    });
    accepted.forwards.push(TunnelForward {
        local_port: 16432,
        remote_port: 6379,
        ..accepted.forwards[0].clone()
    });
    *state.tunnel.lock().unwrap() = stopped_owner(&accepted);
    let before = fs::read(&state.config_path).unwrap();
    let snapshot = control_state(&state).unwrap().tunnel;
    assert!(snapshot
        .publications
        .iter()
        .any(|row| row.config.local_port == 6432));
    assert!(snapshot
        .forwards
        .iter()
        .any(|row| row.config.local_port == 16432));
    for result in [
        delete_tunnel_publication(&state, 6432),
        set_tunnel_publication_enabled(&state, 6432, false),
        delete_tunnel_forward(&state, 16432),
        set_tunnel_forward_enabled(&state, 16432, false),
        apply_tunnel_publication(
            &state,
            Some(6432),
            TunnelPublication {
                local_port: 6433,
                public_port: None,
                enabled: true,
            },
        ),
        apply_tunnel_forward(
            &state,
            Some(16432),
            TunnelForward {
                local_port: 16433,
                remote_port: 6379,
                ..accepted.forwards[0].clone()
            },
        ),
    ] {
        let error = result.unwrap_err();
        assert!(
            error.contains("命令提交失败") && !error.contains("不存在"),
            "{error}"
        );
    }
    assert_eq!(fs::read(&state.config_path).unwrap(), before);
    let snapshot = control_state(&state).unwrap().tunnel;
    assert!(snapshot
        .publications
        .iter()
        .any(|row| row.config.local_port == 6432));
    assert!(snapshot
        .forwards
        .iter()
        .any(|row| row.config.local_port == 16432));
    let worker = state.tunnel.lock().unwrap().take_worker().unwrap();
    worker.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}
