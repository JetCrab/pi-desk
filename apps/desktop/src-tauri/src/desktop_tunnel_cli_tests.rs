use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn desktop_tunnel_cli_stats_are_opt_in_and_reject_duplicates() {
    let base = args(&[
        "--tunnel-client",
        "--local",
        "127.0.0.1:6233",
        "--public-port",
        "11001",
    ]);
    assert!(matches!(
        parse_request(&base),
        Ok(Request::Client { stats: false, .. })
    ));
    let mut stats = base;
    stats.push("--stats".into());
    assert!(matches!(
        parse_request(&stats),
        Ok(Request::Client { stats: true, .. })
    ));
    stats.push("--stats".into());
    assert!(parse_request(&stats).is_err());
    assert!(parse_request(&args(&["--tunnel-info", "--stats"])).is_err());
    assert!(parse_request(&args(&["--tunnel-client", "--client", "legacy"])).is_err());
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn desktop_tunnel_cli_accepts_only_loopback_and_nonzero_ports() {
    assert!(parse_request(&args(&["--tunnel-info"])).is_ok());
    assert!(parse_request(&args(&[
        "--tunnel-client",
        "--local",
        "127.0.0.1:6233",
        "--public-port",
        "11001"
    ]))
    .is_ok());
    assert!(parse_request(&args(&[
        "--tunnel-client",
        "--local",
        "[::1]:6233",
        "--public-port",
        "11001"
    ]))
    .is_ok());
    assert!(parse_request(&args(&[
        "--tunnel-client",
        "--local",
        "0.0.0.0:6233",
        "--public-port",
        "11001"
    ]))
    .is_err());
    assert!(parse_request(&args(&[
        "--tunnel-client",
        "--local",
        "127.0.0.1:6233",
        "--public-port",
        "0"
    ]))
    .is_err());
    assert!(parse_request(&args(&["--tunnel-client", "--local", "127.0.0.1:6233"])).is_err());
    assert!(parse_request(&args(&["--tunnel-info", "--config", "anything"])).is_err());
}

#[test]
fn desktop_tunnel_info_reads_only_server_address() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../temp/tests/desktop-tunnel-capability")
        .join(format!("config-info-{}-{suffix}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("config.json");
    let config: crate::config::DesktopConfig =
        serde_json::from_value(serde_json::json!({"targets":[],"tunnel": {
            "controlServerUrl":"http://tunnel.example:7001",
            "controlKey":"ab".repeat(32),
            "providerSecretKey":"cd".repeat(32),
            "publications": [{"localPort": 6233,"publicPort":null,"enabled":true}]
        }}))
        .unwrap();
    crate::config::save(&path, &config).unwrap();
    let original = std::fs::read(&path).unwrap();
    assert_eq!(
        inspect_config(&path).unwrap(),
        Some("http://tunnel.example:7001".into())
    );
    assert_eq!(read_config(&path).unwrap().control_key, "ab".repeat(32));
    assert_eq!(std::fs::read(&path).unwrap(), original);
    std::fs::write(&path, r#"{"targets":[],"tunnel":{}}"#).unwrap();
    assert_eq!(inspect_config(&path).unwrap(), None);
    std::fs::remove_dir_all(directory).unwrap();
}
