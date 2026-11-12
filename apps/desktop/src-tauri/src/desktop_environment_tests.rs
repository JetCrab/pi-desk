use super::*;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const OPERATION_ID: &str = "08f9fa62-4508-4e1e-b70f-292b2a06fdad";
const OTHER_OPERATION_ID: &str = "724dfe7c-4810-4e91-a744-edb767c44bf7";

struct Directory(PathBuf);
impl Directory {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-environment")
            .join(format!("{label}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn owner(&self) -> PathBuf {
        self.0.join("agent/config/desktop.json")
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn configured() -> DesktopConfig {
    let mut config = DesktopConfig::default();
    config.tunnel.control_server_url = "http://example.test:7001".into();
    config.tunnel.control_key = "ab".repeat(32);
    config.tunnel.provider_secret_key = "cd".repeat(32);
    config::normalize(config).unwrap()
}
fn portable() -> Portable {
    Portable {
        version: 1,
        source_platform: "windows".into(),
        config: configured(),
        preferences: Preferences {
            hide_on_startup: Some(true),
            download: Some(DownloadSource::Domestic),
            ..Default::default()
        },
    }
}

#[test]
fn latest_config_initializes_and_saves_without_reading_or_changing_old_sources() {
    let directory = Directory::new("latest-owner");
    let owner = directory.owner();
    let sources = ["config.json", "runtime.json", "environment.json"];
    for name in sources {
        fs::write(directory.0.join(name), format!("unread old source: {name}")).unwrap();
    }
    apply_pending(&owner).unwrap();
    config::initialize(&owner).unwrap();
    let initial = fs::read(&owner).unwrap();
    config::initialize(&owner).unwrap();
    assert_eq!(fs::read(&owner).unwrap(), initial);
    assert_eq!(config::load(&owner).unwrap().targets.len(), 1);
    assert_eq!(load_preferences(&owner).unwrap().hide_on_startup, None);
    config::save(&owner, &configured()).unwrap();
    assert_eq!(
        config::load(&owner).unwrap().tunnel.provider_secret_key,
        "cd".repeat(32)
    );
    for name in sources {
        assert_eq!(
            fs::read_to_string(directory.0.join(name)).unwrap(),
            format!("unread old source: {name}")
        );
    }
}

#[test]
fn current_document_plaintext_is_rejected_without_rewriting_it() {
    let directory = Directory::new("reject-plaintext-document");
    let owner = directory.owner();
    storage::write_value(&owner, &serde_json::to_value(configured()).unwrap()).unwrap();
    let original = fs::read(&owner).unwrap();
    assert!(config::load(&owner).is_err());
    assert!(config::save(&owner, &configured()).is_err());
    assert_eq!(fs::read(&owner).unwrap(), original);
}

#[test]
fn portable_excludes_local_state_and_keeps_provider_identity_and_custom_commands() {
    let directory = Directory::new("portable-projection");
    let owner = directory.owner();
    let mut config = configured();
    config.targets[0].server.as_mut().unwrap().start_command = "custom-shell --serve".into();
    config::save(&owner, &config).unwrap();
    storage::write_value(
        &directory.0.join("runtime.json"),
        &json!({"lastOpenedUrl":"http://local/","lastVersion":"9.9.9"}),
    )
    .unwrap();
    storage::write_value(
        &directory.0.join("environment.json"),
        &json!({"node":"C:/node.exe","pi":"C:/pi","bash":"C:/bash.exe"}),
    )
    .unwrap();
    let exported = export(&owner).unwrap();
    assert_eq!(
        exported.config.tunnel.provider_secret_key,
        config.tunnel.provider_secret_key
    );
    assert_eq!(
        exported.config.targets[0]
            .server
            .as_ref()
            .unwrap()
            .start_command,
        "custom-shell --serve"
    );
    let value = serde_json::to_value(exported).unwrap();
    assert_eq!(value["version"], 1);
    for excluded in [
        "lastOpenedUrl",
        "lastVersion",
        "C:/node.exe",
        "C:/pi",
        "C:/bash.exe",
        "desktopVault",
        "desktop-secret://",
    ] {
        assert!(!value.to_string().contains(excluded));
    }
}

#[test]
fn stage_keeps_active_owner_and_rejects_duplicate_then_startup_applies_and_cleans() {
    let directory = Directory::new("stage-apply");
    let owner = directory.owner();
    config::save(&owner, &DesktopConfig::default()).unwrap();
    let active = fs::read(&owner).unwrap();
    let mut request = portable();
    request.source_platform = if cfg!(windows) { "linux" } else { "windows" }.into();
    request.config.targets[0]
        .server
        .as_mut()
        .unwrap()
        .start_command = if cfg!(windows) {
        "node_modules/.bin/pi-desk start -H 127.0.0.1 -p {port} --no-open"
    } else {
        "node_modules\\.bin\\pi-desk.cmd start -H 127.0.0.1 -p {port} --no-open"
    }
    .into();
    stage(&owner, OPERATION_ID, request).unwrap();
    assert_eq!(fs::read(&owner).unwrap(), active);
    let pending = fs::read(owner.with_file_name(PENDING)).unwrap();
    assert!(!String::from_utf8_lossy(&pending).contains(&"cd".repeat(32)));
    assert!(stage(&owner, OPERATION_ID, portable()).is_err());
    assert_eq!(fs::read(owner.with_file_name(PENDING)).unwrap(), pending);
    apply_pending(&owner).unwrap();
    let loaded = config::load(&owner).unwrap();
    assert_eq!(loaded.tunnel.provider_secret_key, "cd".repeat(32));
    assert_eq!(
        load_preferences(&owner).unwrap().hide_on_startup,
        Some(true)
    );
    assert_eq!(
        loaded.targets[0].server.as_ref().unwrap().start_command,
        config::default_server_config().start_command
    );
    assert!(!owner.with_file_name(PENDING).exists());
    assert!(!owner.with_file_name(JOURNAL).exists());
    assert!(!fs::read_to_string(&owner).unwrap().contains(OPERATION_ID));
    assert!(!cancel(&owner, OPERATION_ID).unwrap());
}

#[test]
fn failed_startup_apply_rolls_back_exact_bytes_and_keeps_stage_for_retry() {
    let directory = Directory::new("apply-rollback");
    let owner = directory.owner();
    config::save(&owner, &DesktopConfig::default()).unwrap();
    let active = fs::read(&owner).unwrap();
    stage(&owner, OPERATION_ID, portable()).unwrap();
    assert!(apply_pending_with(&owner, || Err("模拟写入后的验证失败".into())).is_err());
    assert_eq!(fs::read(&owner).unwrap(), active);
    assert!(owner.with_file_name(PENDING).exists());
    apply_pending(&owner).unwrap();
    assert_eq!(
        config::load(&owner).unwrap().tunnel.control_key,
        "ab".repeat(32)
    );
}

#[test]
fn committed_transaction_only_finishes_cleanup_without_rolling_back() {
    let directory = Directory::new("committed-recovery");
    let owner = directory.owner();
    config::save(&owner, &DesktopConfig::default()).unwrap();
    let previous = fs::read(&owner).unwrap();
    stage(&owner, OPERATION_ID, portable()).unwrap();
    let committed = read_pending(&owner).unwrap().unwrap().environment;
    storage::write_value(&owner, &committed).unwrap();
    let active = fs::read(&owner).unwrap();
    storage::atomic_write(
        &owner.with_file_name(JOURNAL),
        &serde_json::to_vec(&Transaction {
            committed: true,
            previous: Some(previous),
        })
        .unwrap(),
    )
    .unwrap();
    apply_pending(&owner).unwrap();
    assert_eq!(fs::read(&owner).unwrap(), active);
    assert!(!owner.with_file_name(PENDING).exists());
    assert!(!owner.with_file_name(JOURNAL).exists());
}

#[test]
fn interrupted_transaction_is_recovered_before_invalid_stage_is_loaded() {
    let directory = Directory::new("crash-recovery");
    let owner = directory.owner();
    config::save(&owner, &DesktopConfig::default()).unwrap();
    let active = fs::read(&owner).unwrap();
    storage::atomic_write(
        &owner.with_file_name(JOURNAL),
        &serde_json::to_vec(&Transaction {
            committed: false,
            previous: Some(active.clone()),
        })
        .unwrap(),
    )
    .unwrap();
    storage::write_value(&owner, &json!({"broken":"half update"})).unwrap();
    storage::write_value(
        &owner.with_file_name(PENDING),
        &json!({"operationId":OPERATION_ID,"environment":{"targets":"invalid"}}),
    )
    .unwrap();
    assert!(apply_pending(&owner).is_err());
    assert_eq!(fs::read(&owner).unwrap(), active);
    assert!(owner.with_file_name(PENDING).exists());
}

#[test]
fn matching_cancel_removes_only_pending_and_leaves_active_owner_unchanged() {
    let directory = Directory::new("matching-cancel");
    let owner = directory.owner();
    config::save(&owner, &DesktopConfig::default()).unwrap();
    let active = fs::read(&owner).unwrap();
    assert!(!cancel(&owner, OPERATION_ID).unwrap());
    stage(&owner, OPERATION_ID, portable()).unwrap();
    assert_eq!(
        read_pending(&owner).unwrap().unwrap().operation_id,
        OPERATION_ID
    );
    assert!(cancel(&owner, OPERATION_ID).unwrap());
    assert!(!owner.with_file_name(PENDING).exists());
    assert_eq!(fs::read(&owner).unwrap(), active);
    assert!(!cancel(&owner, OPERATION_ID).unwrap());
    stage(&owner, OTHER_OPERATION_ID, portable()).unwrap();
    assert!(cancel(&owner, OTHER_OPERATION_ID).unwrap());
}

#[test]
fn different_operation_cannot_cancel_another_pending() {
    let directory = Directory::new("foreign-cancel");
    let owner = directory.owner();
    config::save(&owner, &DesktopConfig::default()).unwrap();
    stage(&owner, OPERATION_ID, portable()).unwrap();
    let pending = fs::read(owner.with_file_name(PENDING)).unwrap();
    let active = fs::read(&owner).unwrap();
    assert!(cancel(&owner, OTHER_OPERATION_ID)
        .unwrap_err()
        .contains("不匹配"));
    assert_eq!(fs::read(owner.with_file_name(PENDING)).unwrap(), pending);
    assert_eq!(fs::read(&owner).unwrap(), active);
}

#[test]
fn cancel_refuses_live_apply_lock_and_any_transaction_without_changing_records() {
    let directory = Directory::new("transaction-cancel");
    let owner = directory.owner();
    config::save(&owner, &DesktopConfig::default()).unwrap();
    stage(&owner, OPERATION_ID, portable()).unwrap();
    let pending = fs::read(owner.with_file_name(PENDING)).unwrap();
    let active = fs::read(&owner).unwrap();
    assert!(apply_pending_with(&owner, || {
        assert!(cancel(&owner, OPERATION_ID)
            .unwrap_err()
            .contains("其他操作使用"));
        Err("模拟正在apply时失败".into())
    })
    .is_err());
    assert_eq!(fs::read(owner.with_file_name(PENDING)).unwrap(), pending);
    assert_eq!(fs::read(&owner).unwrap(), active);
    let journal = owner.with_file_name(JOURNAL);
    for committed in [false, true] {
        let bytes = serde_json::to_vec(&Transaction {
            committed,
            previous: Some(active.clone()),
        })
        .unwrap();
        storage::atomic_write(&journal, &bytes).unwrap();
        assert!(cancel(&owner, OPERATION_ID)
            .unwrap_err()
            .contains("恢复事务"));
        assert_eq!(fs::read(&journal).unwrap(), bytes);
        assert_eq!(fs::read(owner.with_file_name(PENDING)).unwrap(), pending);
        assert_eq!(fs::read(&owner).unwrap(), active);
        assert!(stage(&owner, OTHER_OPERATION_ID, portable()).is_err());
    }
    fs::remove_file(owner.with_file_name(PENDING)).unwrap();
    assert!(
        cancel(&owner, OPERATION_ID).is_err(),
        "没有pending时仍不能删除事务现场"
    );
    assert!(journal.exists());
}

#[test]
fn malformed_operation_ids_are_rejected_without_creating_pending() {
    let directory = Directory::new("invalid-operation-id");
    let owner = directory.owner();
    config::save(&owner, &DesktopConfig::default()).unwrap();
    let active = fs::read(&owner).unwrap();
    for id in [
        "",
        "not-a-uuid",
        "08f9fa6245084e1eb70f292b2a06fdad",
        "08f9fa62-4508-4e1e-b70f-292b2a06fdaz",
    ] {
        assert!(stage(&owner, id, portable()).is_err());
        assert!(cancel(&owner, id).is_err());
    }
    assert!(!owner.with_file_name(PENDING).exists());
    assert_eq!(fs::read(&owner).unwrap(), active);
}

#[test]
fn invalid_stage_does_not_create_request_or_modify_owner() {
    let directory = Directory::new("stage-validation");
    let owner = directory.owner();
    config::save(&owner, &configured()).unwrap();
    let active = fs::read(&owner).unwrap();
    let mut request = portable();
    request.version = 2;
    assert!(stage(&owner, OPERATION_ID, request).is_err());
    assert_eq!(fs::read(&owner).unwrap(), active);
    assert!(!owner.with_file_name(PENDING).exists());
}
