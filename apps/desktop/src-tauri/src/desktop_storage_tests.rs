use super::*;
use serde_json::json;

#[test]
fn existing_ciphertext_never_replaces_missing_master_key_and_new_keys_require_persistence() {
    use std::cell::RefCell;
    let stored = RefCell::new(None::<String>);
    assert!(key_from_store(
        true,
        || Err(keyring::Error::NoEntry),
        |value| {
            *stored.borrow_mut() = Some(value.into());
            Ok(())
        }
    )
    .unwrap_err()
    .contains("主密钥丢失"));
    assert!(stored.borrow().is_none());
    let key = key_from_store(
        false,
        || stored.borrow().clone().ok_or(keyring::Error::NoEntry),
        |value| {
            *stored.borrow_mut() = Some(value.into());
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(
        key_from_store(
            true,
            || Ok(stored.borrow().clone().unwrap()),
            |_| panic!("不应覆盖已有主密钥")
        )
        .unwrap(),
        key
    );
    assert!(
        key_from_store(false, || Err(keyring::Error::NoEntry), |_| Ok(())).is_err(),
        "不持久的store不能假装保存成功"
    );
}

#[test]
fn isolated_agent_directory_never_defaults_to_or_accepts_real_home_agent() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let home = root.join("fixture-home");
    let isolated = root.join("fixture-isolated");
    assert_eq!(
        resolve_agent_dir(None, None, Some(home.clone())).unwrap(),
        home.join(".pi/agent")
    );
    assert_eq!(
        resolve_agent_dir(None, Some(isolated.clone()), Some(home.clone())).unwrap(),
        isolated.join("environment/pi-agent")
    );
    let explicit = root.join("fixture-explicit-agent");
    assert_eq!(
        resolve_agent_dir(
            Some(explicit.clone()),
            Some(isolated.clone()),
            Some(home.clone())
        )
        .unwrap(),
        explicit
    );
    assert!(
        resolve_agent_dir(Some(home.join(".pi/agent")), Some(isolated), Some(home))
            .unwrap_err()
            .contains("真实用户 AgentDir")
    );
    assert!(resolve_agent_dir(Some(PathBuf::from("relative-agent")), None, None).is_err());
}

#[test]
fn wrapped_pending_vault_must_authenticate_before_new_secrets_are_saved() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../temp/tests/desktop-storage")
        .join(format!("wrapped-pending-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let owner = directory.join("desktop.json");
    let original = json!({"targets":[],"tunnel":{}});
    write_value(&owner, &original).unwrap();
    let pending_path = owner.with_file_name("desktop-environment.pending.json");
    let encrypted = encrypt_with_key(
        json!({"targets":[],"tunnel":{"controlKey":"pending-test-secret"}}),
        [7; 32],
    )
    .unwrap();
    let pending =
        json!({"operationId":"08f9fa62-4508-4e1e-b70f-292b2a06fdad","environment":encrypted});
    write_value(&pending_path, &pending).unwrap();
    assert!(encrypt(
        &owner,
        json!({"targets":[],"tunnel":{"controlKey":"new-test-secret"}})
    )
    .unwrap_err()
    .contains("认证失败"));
    assert_eq!(read_value(&owner).unwrap().unwrap(), original);
    assert_eq!(read_value(&pending_path).unwrap().unwrap(), pending);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn desktop_vault_roundtrip_rejects_wrong_key_and_tampering() {
    let value = json!({"targets":[], "tunnel":{"controlKey":"test-control-secret","providerSecretKey":"test-provider-secret"}});
    let encrypted = encrypt_with_key(value.clone(), [7; 32]).unwrap();
    let text = encrypted.to_string();
    assert!(!text.contains("test-control-secret"));
    assert!(!text.contains("test-provider-secret"));
    assert_eq!(encrypted["tunnel"]["controlKey"], CONTROL_REF);
    let vault = encrypted["desktopVault"].clone();
    for reference in [
        "test-control-secret",
        "secret://08f9fa62-4508-4e1e-b70f-292b2a06fdad",
        "desktop-secret://unknown",
    ] {
        let mut invalid = encrypted.clone();
        invalid["tunnel"]["controlKey"] = json!(reference);
        assert!(decrypt_with_key(&mut invalid, vault.clone(), [7; 32]).is_err());
    }
    let mut unsupported = encrypted.clone();
    let mut unsupported_vault = vault.clone();
    unsupported_vault["version"] = json!(2);
    assert!(decrypt_with_key(&mut unsupported, unsupported_vault, [7; 32]).is_err());
    let mut wrong = encrypted.clone();
    assert!(decrypt_with_key(&mut wrong, vault.clone(), [8; 32]).is_err());
    let mut restored = encrypted.clone();
    decrypt_with_key(&mut restored, vault, [7; 32]).unwrap();
    assert_eq!(restored, value);
    let mut tampered = encrypted;
    tampered["desktopVault"]["ciphertext"][25] = json!(0);
    let vault = tampered["desktopVault"].clone();
    assert!(decrypt_with_key(&mut tampered, vault, [7; 32]).is_err());
}
