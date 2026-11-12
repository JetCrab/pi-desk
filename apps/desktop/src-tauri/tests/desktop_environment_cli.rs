use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const OPERATION_ID: &str = "08f9fa62-4508-4e1e-b70f-292b2a06fdad";
const OTHER_OPERATION_ID: &str = "724dfe7c-4810-4e91-a744-edb767c44bf7";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/run/desktop-environment-cli")
            .join(format!("native-cli-{}-{nonce}", std::process::id()));
        fs::create_dir_all(directory.join("agent/config")).unwrap();
        fs::write(directory.join("key"), [0x29; 32]).unwrap();
        Self(directory)
    }
    fn owner(&self) -> PathBuf {
        self.0.join("agent/config/desktop.json")
    }
    fn run(&self, arguments: &[&str], input: Option<&Value>, key: Option<&Path>) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_pi-desk-desktop"));
        command
            .args(arguments)
            .env("PI_DESK_DESKTOP_DATA_DIR", &self.0)
            .env("PI_CODING_AGENT_DIR", self.0.join("agent"))
            .env("PI_DESK_DESKTOP_CONFIG", self.owner())
            .env_remove("PI_CODING_AGENT_SESSION_DIR")
            .env_remove("PI_DESK_SECRET_KEY_FILE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(key) = key {
            command.env("PI_DESK_SECRET_KEY_FILE", key);
        }
        let mut child = command.spawn().unwrap();
        if let Some(input) = input {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(&serde_json::to_vec(input).unwrap())
                .unwrap();
        } else {
            drop(child.stdin.take());
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if child.try_wait().unwrap().is_some() {
                return child.wait_with_output().unwrap();
            }
            if Instant::now() >= deadline {
                #[cfg(windows)]
                {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .output();
                }
                let _ = child.kill();
                let _ = child.wait();
                panic!("原生环境CLI超时，已终止测试进程树");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn stages_sealed_document_for_offline_copy_and_owned_cleanup_without_touching_old_sources() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let sources = ["config.json", "runtime.json", "environment.json"];
    for name in sources {
        fs::write(
            fixture.0.join(name),
            format!("old source remains unread: {name}"),
        )
        .unwrap();
    }
    assert!(!owner.exists());
    let input = json!({
        "operationId": OPERATION_ID,
        "environment": {
            "version":1,"sourcePlatform":"windows",
            "config":{"targets":[],"tunnel":{"controlServerUrl":"http://example.test:7001","controlKey":"ab".repeat(32),"providerSecretKey":"cd".repeat(32)}},
            "preferences":{"hideOnStartup":true,"hideOnOpen":false,"showOnClose":true,"autoStart":{}}
        }
    });
    let key = fixture.0.join("key");
    let staged = fixture.run(&["--environment-stage"], Some(&input), Some(&key));
    assert!(
        staged.status.success(),
        "{}",
        String::from_utf8_lossy(&staged.stderr)
    );
    assert!(!owner.exists(), "stage 不能创建或覆盖活跃 Owner");
    let pending = owner.with_file_name("desktop-environment.pending.json");
    let request: Value = serde_json::from_slice(&fs::read(&pending).unwrap()).unwrap();
    assert_eq!(request["operationId"], OPERATION_ID);
    let sealed = &request["environment"];
    assert!(sealed.get("desktopVault").is_some());
    assert_eq!(
        sealed["tunnel"]["controlKey"],
        "desktop-secret://control-key"
    );
    assert_eq!(
        sealed["tunnel"]["providerSecretKey"],
        "desktop-secret://provider-identity"
    );
    assert!(!sealed.to_string().contains(&"ab".repeat(32)));
    assert!(!sealed.to_string().contains(&"cd".repeat(32)));
    fs::write(&owner, serde_json::to_vec(sealed).unwrap()).unwrap();
    let copied = fs::read(&owner).unwrap();
    let cancelled = fixture.run(
        &["--environment-cancel"],
        Some(&json!({"operationId":OPERATION_ID})),
        None,
    );
    assert!(cancelled.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&cancelled.stdout).unwrap(),
        json!({"cancelled":true})
    );
    assert!(!pending.exists());
    assert_eq!(fs::read(&owner).unwrap(), copied);
    let exported = fixture.run(&["--environment-export"], None, Some(&key));
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stderr)
    );
    let exported: Value = serde_json::from_slice(&exported.stdout).unwrap();
    assert_eq!(
        exported["config"]["tunnel"]["providerSecretKey"],
        "cd".repeat(32)
    );
    assert_eq!(exported["preferences"]["hideOnStartup"], true);
    for name in sources {
        assert_eq!(
            fs::read_to_string(fixture.0.join(name)).unwrap(),
            format!("old source remains unread: {name}")
        );
    }
    assert!(!fixture.0.join("logs").exists());
    assert!(!fixture.0.join("environment").exists());
}

#[test]
fn native_cancel_only_removes_owned_pending_and_preserves_transaction_evidence() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let original = br#"{"targets":[],"tunnel":{}}"#;
    fs::write(&owner, original).unwrap();
    let input = json!({
        "operationId":OPERATION_ID,
        "environment": {
            "version":1,"sourcePlatform":"windows",
            "config":{"targets":[],"tunnel":{"controlServerUrl":"http://example.test:7001","controlKey":"ab".repeat(32)}},
            "preferences":{"hideOnOpen":true,"showOnClose":true,"autoStart":{}}
        }
    });
    let key = fixture.0.join("key");
    assert!(fixture
        .run(&["--environment-stage"], Some(&input), Some(&key))
        .status
        .success());
    let pending = owner.with_file_name("desktop-environment.pending.json");
    let bytes = fs::read(&pending).unwrap();
    let foreign = fixture.run(
        &["--environment-cancel"],
        Some(&json!({"operationId":OTHER_OPERATION_ID})),
        None,
    );
    assert!(!foreign.status.success());
    assert!(foreign.stdout.is_empty());
    assert!(String::from_utf8_lossy(&foreign.stderr).contains("不匹配"));
    assert_eq!(fs::read(&pending).unwrap(), bytes);
    let journal = owner.with_file_name("desktop-environment.transaction.json");
    fs::write(&journal, b"{}").unwrap();
    let blocked = fixture.run(
        &["--environment-cancel"],
        Some(&json!({"operationId":OPERATION_ID})),
        None,
    );
    assert!(!blocked.status.success());
    assert!(blocked.stdout.is_empty());
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("恢复事务"));
    assert_eq!(fs::read(&journal).unwrap(), b"{}");
    assert_eq!(fs::read(&pending).unwrap(), bytes);
    assert_eq!(fs::read(&owner).unwrap(), original);
    fs::remove_file(&journal).unwrap();
    let cancelled = fixture.run(
        &["--environment-cancel"],
        Some(&json!({"operationId":OPERATION_ID})),
        None,
    );
    assert!(
        cancelled.status.success(),
        "{}",
        String::from_utf8_lossy(&cancelled.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&cancelled.stdout).unwrap(),
        json!({"cancelled":true})
    );
    assert!(!pending.exists());
    assert_eq!(fs::read(&owner).unwrap(), original);
    let absent = fixture.run(
        &["--environment-cancel"],
        Some(&json!({"operationId":OPERATION_ID})),
        None,
    );
    assert!(absent.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&absent.stdout).unwrap(),
        json!({"cancelled":false})
    );
    let invalid = fixture.run(
        &["--environment-cancel"],
        Some(&json!({"operationId":"not-a-uuid"})),
        None,
    );
    assert!(!invalid.status.success());
    assert!(invalid.stdout.is_empty());
    let legacy_input = fixture.run(
        &["--environment-stage"],
        Some(&input["environment"]),
        Some(&key),
    );
    assert!(!legacy_input.status.success());
    assert!(!pending.exists());
    assert!(!fixture.0.join("logs").exists());
    assert!(!fixture.0.join("environment").exists());
}

#[test]
fn native_cli_uses_only_bound_config_and_keyfile_without_starting_gui_or_node() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let original = br#"{"targets":[],"tunnel":{}}"#;
    fs::write(&owner, original).unwrap();
    let portable = json!({
        "version":1,"sourcePlatform":"windows",
        "config":{"targets":[],"tunnel":{"controlServerUrl":"http://example.test:7001","controlKey":"ab".repeat(32),"providerSecretKey":"cd".repeat(32)}},
        "preferences":{"hideOnStartup":true,"hideOnOpen":false,"showOnClose":true,"autoStart":{},"download":{"mode":"domestic"}}
    });
    let input = json!({"operationId":OPERATION_ID, "environment":portable});
    let key = fixture.0.join("key");
    let staged = fixture.run(&["--environment-stage"], Some(&input), Some(&key));
    assert!(
        staged.status.success(),
        "{}",
        String::from_utf8_lossy(&staged.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&staged.stdout).unwrap(),
        json!({"restartRequired":true,"operationId":OPERATION_ID})
    );
    assert_eq!(fs::read(&owner).unwrap(), original);
    let pending = owner.with_file_name("desktop-environment.pending.json");
    let bytes = fs::read(&pending).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains(&"ab".repeat(32)));
    assert!(!String::from_utf8_lossy(&bytes).contains(&"cd".repeat(32)));
    assert!(!fixture
        .run(&["--environment-stage"], Some(&input), Some(&key))
        .status
        .success());
    assert_eq!(fs::read(&pending).unwrap(), bytes);
    // 启动 apply 的真实文件事务由单元测试覆盖；此处将已加密 fixture 设为活跃 Owner，验证生产 CLI 的解锁边界。
    let staged: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(staged["operationId"], OPERATION_ID);
    fs::write(&owner, serde_json::to_vec(&staged["environment"]).unwrap()).unwrap();
    fs::remove_file(&pending).unwrap();
    let cancelled = fixture.run(
        &["--environment-cancel"],
        Some(&json!({"operationId":OPERATION_ID})),
        None,
    );
    assert!(cancelled.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&cancelled.stdout).unwrap(),
        json!({"cancelled":false})
    );
    let exported = fixture.run(&["--environment-export"], None, Some(&key));
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stderr)
    );
    let exported: Value = serde_json::from_slice(&exported.stdout).unwrap();
    assert_eq!(exported["config"]["tunnel"]["controlKey"], "ab".repeat(32));
    assert_eq!(
        exported["config"]["tunnel"]["providerSecretKey"],
        "cd".repeat(32)
    );
    assert_eq!(exported["preferences"]["download"]["mode"], "domestic");
    assert!(!exported.to_string().contains(OPERATION_ID));
    assert!(!fs::read_to_string(&owner).unwrap().contains(OPERATION_ID));
    assert!(!fixture.0.join("logs").exists());
    assert!(!fixture.0.join("environment").exists());
    assert!(!fixture
        .run(
            &["--environment-export", "--config", "arbitrary.json"],
            None,
            Some(&key)
        )
        .status
        .success());
    let before = fs::read(&owner).unwrap();
    fs::write(&key, [0x30; 32]).unwrap();
    let wrong = fixture.run(&["--environment-export"], None, Some(&key));
    assert!(!wrong.status.success());
    assert!(wrong.stdout.is_empty());
    assert!(String::from_utf8_lossy(&wrong.stderr).contains("认证失败"));
    assert_eq!(fs::read(&owner).unwrap(), before);
    let missing = fixture.run(&["--environment-export"], None, None);
    assert!(!missing.status.success());
    assert!(missing.stdout.is_empty());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("隔离模式需要"));
    assert_eq!(fs::read(&owner).unwrap(), before);
}
