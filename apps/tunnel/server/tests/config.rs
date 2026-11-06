use std::process::Command;

#[test]
fn server_rejects_invalid_relay_quic_env_ports_before_binding() {
    for port in ["0", "65536", "-1", "abc", "", " 20012"] {
        let output = Command::new(env!("CARGO_BIN_EXE_pi-desk-tunnel-server"))
            .env("PI_DESK_TUNNEL_SERVER_KEY", "07".repeat(32))
            .env("PI_DESK_TUNNEL_IROH_RELAY_URL", "http://127.0.0.1:9")
            .env("PI_DESK_TUNNEL_IROH_RELAY_TOKEN", "test-relay-token")
            .env("PI_DESK_TUNNEL_IROH_RELAY_QUIC_PORT", port)
            // 若端口校验回归，后续无效监听配置仍让进程退出，避免测试启动常驻服务。
            .env("PI_DESK_TUNNEL_BIND", "invalid-config-test-bind")
            .output()
            .expect("应运行隔离配置校验进程");
        assert!(!output.status.success(), "非法端口 {port:?} 不应被接纳");
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(
            error.contains("PI_DESK_TUNNEL_IROH_RELAY_QUIC_PORT") && error.contains("1–65535"),
            "非法端口 {port:?} 应明确报告环境变量与范围，实际：{error}"
        );
    }
}
