use super::{load, normalize, save, DesktopConfig, TunnelForward, TunnelPublication};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn directory(name: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../temp/run/desktop-tunnel/iroh-integration-20261103")
        .join(format!("{name}-{}-{suffix}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn migrates_legacy_publications_and_removes_url_tunnel_and_device_id() {
    let directory = directory("config-migration");
    let path = directory.join("config.json");
    fs::write(&path, serde_json::to_vec(&serde_json::json!({
        "targets": [
            {"url": "http://127.0.0.1:30333/a", "tunnel": {"publicPort": 41001, "enabled": true}},
            {"url": "http://localhost:30333/b", "tunnel": {"publicPort": 41001, "enabled": true}},
            {"url": "https://localhost/", "tunnel": {"publicPort": 41002, "enabled": false}},
            {"url": "https://example.test/bookmark"}
        ],
        "tunnel": {"deviceId": "old-device", "controlServerUrl": "http://control.example:7001", "controlKey": "ab".repeat(32)}
    })).unwrap()).unwrap();
    let config = load(&path).unwrap();
    assert_eq!(config.targets.len(), 4);
    assert_eq!(
        config.tunnel.publications,
        vec![
            TunnelPublication {
                local_port: 30333,
                public_port: Some(41001),
                enabled: true
            },
            TunnelPublication {
                local_port: 443,
                public_port: Some(41002),
                enabled: false
            },
        ]
    );
    save(&path, &config).unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert!(saved["targets"]
        .as_array()
        .unwrap()
        .iter()
        .all(|target| target.get("tunnel").is_none()));
    assert!(saved["tunnel"].get("deviceId").is_none());
    assert_eq!(saved["tunnel"]["controlKey"], "ab".repeat(32));
    assert_eq!(
        load(&path).unwrap().tunnel.publications,
        config.tunnel.publications
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn refuses_conflicting_migration_and_corrupt_files_without_rewriting() {
    let directory = directory("migration-conflict");
    let path = directory.join("config.json");
    for content in [
        r#"{"targets":[{"url":"http://localhost:30333/a","tunnel":{"publicPort":41001,"enabled":true}},{"url":"http://localhost:30333/b","tunnel":{"publicPort":41002,"enabled":true}}]}"#,
        r#"{"targets":[{"url":"http://localhost:30333/a","tunnel":{"publicPort":41001,"enabled":true}}],"tunnel":{"publications":[{"localPort":30333,"publicPort":41001,"enabled":false}]}}"#,
        "{broken",
    ] {
        fs::write(&path, content).unwrap();
        let error = load(&path).unwrap_err();
        if content != "{broken" {
            assert!(
                error.contains("迁移冲突") && error.contains("30333"),
                "{error}"
            );
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn persists_tcp_only_configuration_and_rejects_duplicate_fixed_ports() {
    let directory = directory("tcp-config");
    let path = directory.join("config.json");
    let mut config = DesktopConfig {
        targets: vec![],
        tunnel: Default::default(),
    };
    config.tunnel.publications.push(TunnelPublication {
        local_port: 5432,
        public_port: None,
        enabled: false,
    });
    config.tunnel.forwards.push(TunnelForward {
        provider_id: "cd".repeat(32),
        remote_port: 5432,
        local_port: 15432,
        enabled: false,
    });
    save(&path, &config).unwrap();
    let loaded = load(&path).unwrap();
    assert!(loaded.targets.is_empty());
    assert_eq!(loaded.tunnel.publications, config.tunnel.publications);
    assert_eq!(loaded.tunnel.forwards, config.tunnel.forwards);
    config
        .tunnel
        .forwards
        .push(config.tunnel.forwards[0].clone());
    assert!(normalize(config).unwrap_err().contains("本地映射端口重复"));
    let mut config = loaded.clone();
    config
        .tunnel
        .publications
        .push(config.tunnel.publications[0].clone());
    assert!(normalize(config).unwrap_err().contains("本机发布端口重复"));
    let mut config = loaded;
    config.tunnel.publications.extend([
        TunnelPublication {
            local_port: 6379,
            public_port: Some(41000),
            enabled: false,
        },
        TunnelPublication {
            local_port: 5433,
            public_port: Some(41000),
            enabled: false,
        },
    ]);
    assert!(normalize(config).unwrap_err().contains("公网端口重复"));
    fs::remove_dir_all(directory).unwrap();
}
