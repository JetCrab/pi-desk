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
fn current_publications_and_sensitive_fields_roundtrip_without_touching_other_files() {
    let directory = directory("current-config");
    let path = directory.join("desktop.json");
    let source = directory.join("config.json");
    fs::write(&source, b"unread old source").unwrap();
    let config: DesktopConfig = serde_json::from_value(serde_json::json!({
        "targets":[{"url":"https://example.test/bookmark"}],
        "tunnel":{"controlServerUrl":"http://control.example:7001","controlKey":"ab".repeat(32),"providerSecretKey":"cd".repeat(32),"publications":[{"localPort":30333,"publicPort":41001,"enabled":true}]}
    })).unwrap();
    save(&path, &config).unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        saved["tunnel"]["controlKey"],
        "desktop-secret://control-key"
    );
    assert_eq!(load(&path).unwrap().tunnel.control_key, "ab".repeat(32));
    assert_eq!(
        load(&path).unwrap().tunnel.publications,
        config.tunnel.publications
    );
    assert_eq!(fs::read(source).unwrap(), b"unread old source");
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn refuses_invalid_current_documents_without_rewriting() {
    let directory = directory("invalid-current-config");
    let path = directory.join("desktop.json");
    for content in [
        r#"{"targets":[{"url":"https://same.test"},{"url":"https://same.test/"}]}"#,
        r#"{"targets":[],"tunnel":{"controlKey":"desktop-secret://control-key"}}"#,
        "{broken",
    ] {
        fs::write(&path, content).unwrap();
        assert!(load(&path).is_err());
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
