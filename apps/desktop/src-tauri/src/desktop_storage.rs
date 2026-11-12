use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(not(test))]
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const VAULT_AAD: &str = "pi-desk-desktop/storage/v1";
const CONTROL_REF: &str = "desktop-secret://control-key";
const PROVIDER_REF: &str = "desktop-secret://provider-identity";
pub(crate) const CONFIG_NAME: &str = "desktop.json";
pub(crate) const MAX_BYTES: usize = 1024 * 1024;

pub(crate) fn agent_dir() -> Result<PathBuf, String> {
    resolve_agent_dir(
        std::env::var_os("PI_CODING_AGENT_DIR").map(PathBuf::from),
        std::env::var_os("PI_DESK_DESKTOP_DATA_DIR").map(PathBuf::from),
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from),
    )
}

fn resolve_agent_dir(
    explicit: Option<PathBuf>,
    isolated: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if isolated.as_ref().is_some_and(|root| !root.is_absolute()) {
        return Err("PI_DESK_DESKTOP_DATA_DIR 必须是绝对路径".into());
    }
    if let Some(path) = explicit {
        if !path.is_absolute() {
            return Err("PI_CODING_AGENT_DIR 必须是绝对路径".into());
        }
        if isolated.is_some() {
            let home_agent = home.as_ref().map(|home| home.join(".pi/agent"));
            if home_agent.is_some_and(|home| {
                let home = fs::canonicalize(&home).unwrap_or(home);
                let candidate = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
                candidate.starts_with(home)
            }) {
                return Err("隔离模式不能使用真实用户 AgentDir，请显式指定测试 AgentDir".into());
            }
        }
        return Ok(path);
    }
    if let Some(root) = isolated {
        return Ok(root.join("environment/pi-agent"));
    }
    home.map(|home| home.join(".pi/agent"))
        .ok_or_else(|| "无法确定 Pi AgentDir".into())
}

pub(crate) fn config_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("config").join(CONFIG_NAME))
}

// CLI 只接受宿主绑定的 Owner，不接受导入内容或额外参数指定文件位置。
pub(crate) fn bound_path() -> Result<PathBuf, String> {
    let bound = std::env::var_os("PI_DESK_DESKTOP_CONFIG")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("环境命令需要 PI_DESK_DESKTOP_CONFIG 绝对路径")?;
    let expected = config_path()?;
    if bound != expected {
        return Err("PI_DESK_DESKTOP_CONFIG 必须绑定当前 AgentDir/config/desktop.json".into());
    }
    Ok(bound)
}

pub(crate) fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取桌面存储失败：{error}")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_BYTES as u64
    {
        return Err("桌面存储必须是大小受限的普通文件".into());
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("读取桌面存储失败：{error}"))
}

pub(crate) fn read_value(path: &Path) -> Result<Option<Value>, String> {
    read_optional(path)?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(|_| "桌面存储 JSON 格式无效".into()))
        .transpose()
}

pub(crate) fn lock(path: &Path) -> Result<File, String> {
    let parent = path.parent().ok_or("桌面配置目录无效")?;
    fs::create_dir_all(parent).map_err(|error| format!("创建桌面配置目录失败：{error}"))?;
    let path = path.with_extension("lock");
    if fs::symlink_metadata(&path)
        .is_ok_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err("桌面配置锁必须是普通文件".into());
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("打开桌面配置锁失败：{error}"))?;
    file.try_lock_exclusive()
        .map_err(|error| format!("桌面配置正在被其他操作使用：{error}"))?;
    // 原子替换在崩溃时可能留下临时文件，后续操作回收超过一天的残留。
    for entry in
        fs::read_dir(parent).map_err(|error| format!("检查桌面存储临时文件失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("检查桌面临时文件失败：{error}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".desktop-") && name.ends_with(".tmp") {
            let metadata = entry
                .metadata()
                .map_err(|error| format!("检查桌面临时文件失败：{error}"))?;
            if metadata.is_file()
                && metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.elapsed().ok())
                    .is_some_and(|age| age.as_secs() >= 86400)
            {
                fs::remove_file(entry.path())
                    .map_err(|error| format!("清理桌面临时文件失败：{error}"))?;
            }
        }
    }
    Ok(file)
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_BYTES {
        return Err("桌面存储内容过大".into());
    }
    read_optional(path)?;
    let parent = path.parent().ok_or("桌面存储目录无效")?;
    fs::create_dir_all(parent).map_err(|error| format!("创建桌面存储目录失败：{error}"))?;
    let random = pi_desk_tunnel_common::protocol::random_hex::<12>()
        .map_err(|_| "无法生成桌面存储临时文件名")?;
    let temporary = parent.join(format!(".desktop-{random}.tmp"));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("创建桌面临时文件失败：{error}"))?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("写入桌面存储失败：{error}"))?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| format!("原子替换桌面存储失败：{error}"))?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("同步桌面存储目录失败：{error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub(crate) fn write_value(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "生成桌面存储失败")?;
    atomic_write(path, &bytes)
}

pub(crate) fn update_fields(path: &Path, fields: Value) -> Result<(), String> {
    fn merge(current: &mut Value, fields: Value) {
        match (current, fields) {
            (Value::Object(current), Value::Object(fields)) => {
                for (field, value) in fields {
                    merge(current.entry(field).or_insert(Value::Null), value);
                }
            }
            (current, value) => *current = value,
        }
    }
    let mut value = read_value(path)?.unwrap_or_else(|| serde_json::json!({}));
    if !value.is_object() || !fields.is_object() {
        return Err("桌面本机状态及其更新必须是对象".into());
    }
    merge(&mut value, fields);
    write_value(path, &value)
}

fn storage_key(path: &Path, encrypted_exists: bool) -> Result<[u8; 32], String> {
    #[cfg(test)]
    {
        let _ = (path, encrypted_exists);
        return Ok([0x45; 32]);
    }
    #[cfg(not(test))]
    {
        if let Some(file) = std::env::var_os("PI_DESK_SECRET_KEY_FILE") {
            let bytes = read_optional(Path::new(&file))?.ok_or("桌面外部密钥文件不存在")?;
            return bytes
                .try_into()
                .map_err(|_| "桌面外部密钥必须是原始 32 字节".into());
        }
        if std::env::var_os("PI_DESK_DESKTOP_DATA_DIR").is_some() {
            return Err("隔离模式需要 PI_DESK_SECRET_KEY_FILE，不访问系统钥匙串".into());
        }
        let canonical = fs::canonicalize(path.parent().ok_or("桌面配置目录无效")?)
            .map_err(|error| format!("定位桌面钥匙串失败：{error}"))?;
        let account = format!(
            "{:x}",
            Sha256::digest(canonical.to_string_lossy().as_bytes())
        );
        let entry = keyring::Entry::new("com.jetcrab.pi-desk.desktop.storage.v1", &account)
            .map_err(|error| format!("创建桌面系统钥匙串入口失败：{error}"))?;
        key_from_store(
            encrypted_exists,
            || entry.get_password(),
            |value| entry.set_password(value),
        )
    }
}

fn key_from_store(
    encrypted_exists: bool,
    get: impl Fn() -> Result<String, keyring::Error>,
    put: impl Fn(&str) -> Result<(), keyring::Error>,
) -> Result<[u8; 32], String> {
    match get() {
        Ok(value) => pi_desk_tunnel_common::protocol::parse_key_hex(&value)
            .map_err(|_| "桌面系统钥匙串主密钥无效".into()),
        Err(keyring::Error::NoEntry) if !encrypted_exists => {
            let value = pi_desk_tunnel_common::protocol::random_hex::<32>()
                .map_err(|_| "生成桌面存储主密钥失败")?;
            put(&value).map_err(|error| format!("保存桌面系统钥匙串失败：{error}"))?;
            let verified = get().map_err(|error| format!("验证桌面系统钥匙串失败：{error}"))?;
            if value != verified {
                return Err("桌面系统钥匙串主密钥验证失败".into());
            }
            pi_desk_tunnel_common::protocol::parse_key_hex(&value)
                .map_err(|_| "桌面主密钥无效".into())
        }
        Err(keyring::Error::NoEntry) => {
            Err("桌面密文已存在但系统主密钥丢失，拒绝生成替代密钥".into())
        }
        Err(error) => Err(format!("桌面系统钥匙串不可用：{error}")),
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Vault {
    version: u8,
    ciphertext: Vec<u8>,
}

pub(crate) fn decrypt(path: &Path, mut value: Value) -> Result<Value, String> {
    if let Some(vault) = value.get("desktopVault").cloned() {
        let key = storage_key(path, true)?;
        decrypt_with_key(&mut value, vault, key)?;
    } else {
        for field in ["controlKey", "providerSecretKey"] {
            if value["tunnel"][field]
                .as_str()
                .is_some_and(|secret| !secret.is_empty())
            {
                return Err("桌面磁盘凭据必须使用 desktopVault 和最新凭据引用".into());
            }
        }
    }
    Ok(value)
}

fn decrypt_with_key(value: &mut Value, vault: Value, key: [u8; 32]) -> Result<(), String> {
    let vault: Vault = serde_json::from_value(vault).map_err(|_| "桌面保险库格式无效")?;
    if vault.version != 1 {
        return Err("不支持的桌面保险库版本".into());
    }
    let plain = pi_desk_tunnel_common::protocol::CryptoContext::new(key)
        .decrypt(VAULT_AAD, &vault.ciphertext)
        .map_err(|_| "桌面保险库认证失败，配置未修改")?;
    let secrets: Value = serde_json::from_slice(&plain).map_err(|_| "桌面保险库内容无效")?;
    for (field, reference) in [
        ("controlKey", CONTROL_REF),
        ("providerSecretKey", PROVIDER_REF),
    ] {
        if value["tunnel"][field].as_str() == Some(reference) {
            let secret = secrets[field].as_str().ok_or("桌面保险库缺少凭据")?;
            value["tunnel"][field] = Value::String(secret.into());
        } else if value["tunnel"][field]
            .as_str()
            .is_some_and(|value| !value.is_empty())
        {
            return Err("桌面保险库凭据引用无效".into());
        }
    }
    value
        .as_object_mut()
        .ok_or("桌面配置必须是对象")?
        .remove("desktopVault");
    Ok(())
}

pub(crate) fn encrypt(path: &Path, mut value: Value) -> Result<Value, String> {
    let has_secrets = ["controlKey", "providerSecretKey"].iter().any(|field| {
        value["tunnel"][field]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    });
    // 已有任何密文时必须先解锁；不能用新密钥覆盖旧保险库或待恢复请求。
    let mut encrypted_exists = false;
    let mut reusable_vault = None;
    for file in [
        path.to_path_buf(),
        path.with_file_name("desktop-environment.pending.json"),
    ] {
        if let Some(stored) = read_value(&file)? {
            let stored = if file == path {
                stored
            } else {
                stored
                    .get("environment")
                    .cloned()
                    .ok_or("桌面待恢复请求缺少配置")?
            };
            let plain = decrypt(path, stored.clone())?;
            if stored.get("desktopVault").is_some() {
                encrypted_exists = true;
                if file == path
                    && ["controlKey", "providerSecretKey"]
                        .iter()
                        .all(|field| plain["tunnel"][field] == value["tunnel"][field])
                {
                    reusable_vault = stored.get("desktopVault").cloned();
                }
            }
        }
    }
    if !has_secrets {
        return Ok(value);
    }
    if let Some(vault) = reusable_vault {
        for (field, reference) in [
            ("controlKey", CONTROL_REF),
            ("providerSecretKey", PROVIDER_REF),
        ] {
            if value["tunnel"][field]
                .as_str()
                .is_some_and(|secret| !secret.is_empty())
            {
                value["tunnel"][field] = Value::String(reference.into());
            }
        }
        value["desktopVault"] = vault;
        return Ok(value);
    }
    let key = storage_key(path, encrypted_exists)?;
    encrypt_with_key(value, key)
}

fn encrypt_with_key(mut value: Value, key: [u8; 32]) -> Result<Value, String> {
    let mut secrets = serde_json::Map::new();
    for (field, reference) in [
        ("controlKey", CONTROL_REF),
        ("providerSecretKey", PROVIDER_REF),
    ] {
        if let Some(secret) = value["tunnel"][field]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            if secret.starts_with("desktop-secret://") {
                return Err("不能把桌面凭据引用作为明文秘密保存".into());
            }
            secrets.insert(field.into(), Value::String(secret.into()));
            value["tunnel"][field] = Value::String(reference.into());
        }
    }
    let ciphertext = pi_desk_tunnel_common::protocol::CryptoContext::new(key)
        .encrypt(
            VAULT_AAD,
            &serde_json::to_vec(&secrets).map_err(|_| "生成桌面凭据失败")?,
        )
        .map_err(|_| "加密桌面凭据失败")?;
    value["desktopVault"] = serde_json::to_value(Vault {
        version: 1,
        ciphertext,
    })
    .map_err(|_| "生成桌面保险库失败")?;
    Ok(value)
}

#[cfg(test)]
#[path = "desktop_storage_tests.rs"]
mod tests;
