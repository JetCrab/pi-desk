use std::process::Command;

#[test]
fn server_rejects_invalid_configuration_before_listening() {
    let key = "07".repeat(32);
    for (control_key, relay_token, bind, message) in [
        (
            "short",
            "test-relay-token",
            "invalid-bind",
            "PI_DESK_TUNNEL_SERVER_KEY",
        ),
        (key.as_str(), "", "invalid-bind", "中继准入 token 不能为空"),
        (
            key.as_str(),
            "test-relay-token",
            "127.0.0.1:0",
            "端口必须大于 0",
        ),
        (
            key.as_str(),
            "test-relay-token",
            "127.0.0.1:65536",
            "端口无效",
        ),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_pi-desk-tunnel-server"))
            .env("PI_DESK_TUNNEL_SERVER_KEY", control_key)
            .env("PI_DESK_TUNNEL_IROH_RELAY_TOKEN", relay_token)
            .env("PI_DESK_TUNNEL_BIND", bind)
            .output()
            .expect("应运行隔离配置校验进程");
        assert!(!output.status.success());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains(message), "应报告 {message}，实际：{error}");
    }
}
