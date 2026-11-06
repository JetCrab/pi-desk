use super::*;

#[path = "l2-runtime-tunnel-failure-tests.rs"]
mod failure_tests;
use crate::config::{TunnelForward, TunnelPublication};
use std::time::{SystemTime, UNIX_EPOCH};

fn fixture(name: &str) -> (PathBuf, ShellState) {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../temp/run/desktop-tunnel/iroh-integration-20261103")
        .join(format!("{name}-{}-{suffix}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let state = ShellState::new(
        DesktopConfig {
            targets: vec![],
            tunnel: Default::default(),
        },
        RuntimeInfo::default(),
        directory.join("config.json"),
        directory.join("runtime.json"),
        directory.join("logs/desktop.log"),
    );
    (directory, state)
}

#[test]
fn port_commands_keep_tcp_configuration_independent_and_snapshot_secret_free() {
    let (directory, state) = fixture("port-commands");
    apply_tunnel_connection(&state, serde_json::json!({"controlServerUrl": "http://127.0.0.1:9", "controlKey": "ab".repeat(32)})).unwrap();
    apply_tunnel_publication(
        &state,
        None,
        TunnelPublication {
            local_port: 5432,
            public_port: None,
            enabled: false,
        },
    )
    .unwrap();
    apply_tunnel_forward(
        &state,
        None,
        TunnelForward {
            provider_id: "cd".repeat(32),
            remote_port: 5432,
            local_port: 15432,
            enabled: false,
        },
    )
    .unwrap();
    let before = fs::read(&state.config_path).unwrap();
    assert!(apply_tunnel_publication(
        &state,
        None,
        TunnelPublication {
            local_port: 5432,
            public_port: Some(41000),
            enabled: false
        }
    )
    .is_err());
    assert_eq!(fs::read(&state.config_path).unwrap(), before);
    let snapshot = control_state(&state).unwrap();
    assert!(snapshot.targets.is_empty());
    assert_eq!(
        snapshot.tunnel.publications[0].phase,
        pi_desk_tunnel_common::worker::TunnelPhase::Stopped
    );
    let serialized = serde_json::to_string(&snapshot).unwrap();
    assert!(
        !serialized.contains("controlKey")
            && !serialized.contains("providerSecretKey")
            && !serialized.contains("token")
    );
    delete_tunnel_publication(&state, 5432).unwrap();
    assert_eq!(state.config().unwrap().tunnel.forwards.len(), 1);
    delete_tunnel_forward(&state, 15432).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn first_saved_connection_starts_without_node_and_provider_identity_survives_reload() {
    let (directory, state) = fixture("first-connection");
    apply_tunnel_connection(&state, serde_json::json!({"controlServerUrl": "http://127.0.0.1:9", "controlKey": "ab".repeat(32)})).unwrap();
    apply_tunnel_forward(
        &state,
        None,
        TunnelForward {
            provider_id: "cd".repeat(32),
            remote_port: 5432,
            local_port: 15432,
            enabled: true,
        },
    )
    .unwrap();
    let config = config::load(&state.config_path).unwrap();
    assert_eq!(config.tunnel.provider_secret_key.len(), 64);
    let identity = control_state(&state).unwrap().tunnel.provider_id.unwrap();
    let worker = state.tunnel.lock().unwrap().take_worker().unwrap();
    worker.shutdown().unwrap();
    let restored = ShellState::new(
        config,
        RuntimeInfo::default(),
        state.config_path.clone(),
        state.runtime_path.clone(),
        state.log_path.clone(),
    );
    assert_eq!(
        control_state(&restored)
            .unwrap()
            .tunnel
            .provider_id
            .as_deref(),
        Some(identity.as_str())
    );
    assert_eq!(
        config::load(&state.config_path)
            .unwrap()
            .tunnel
            .provider_secret_key,
        state.config().unwrap().tunnel.provider_secret_key
    );
    fs::remove_dir_all(directory).unwrap();
}
