use crate::config::{self, DesktopConfig};
use crate::desktop_storage as storage;
use crate::environment_source::DownloadSource;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

const PENDING: &str = "desktop-environment.pending.json";
const JOURNAL: &str = "desktop-environment.transaction.json";

fn enabled() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Preferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide_on_startup: Option<bool>,
    #[serde(default = "enabled")]
    pub hide_on_open: bool,
    #[serde(default = "enabled")]
    pub show_on_close: bool,
    #[serde(default)]
    pub auto_start: BTreeMap<String, bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download: Option<DownloadSource>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            hide_on_startup: None,
            hide_on_open: true,
            show_on_close: true,
            auto_start: BTreeMap::new(),
            download: None,
        }
    }
}

impl Preferences {
    fn validated(mut self) -> Result<Self, String> {
        if let Some(source) = self.download.take() {
            self.download = Some(source.validated()?);
        }
        let mut normalized = BTreeMap::new();
        for (url, enabled) in self.auto_start {
            let url = config::normalize_target_url(&url)?;
            if normalized.insert(url, enabled).is_some() {
                return Err("自动启动偏好存在重复网址".into());
            }
        }
        self.auto_start = normalized;
        Ok(self)
    }
}

pub(crate) fn preferences(value: &Value) -> Result<Preferences, String> {
    value
        .get("preferences")
        .map(|value| {
            serde_json::from_value::<Preferences>(value.clone())
                .map_err(|_| "桌面偏好格式无效".to_string())
        })
        .transpose()?
        .unwrap_or_default()
        .validated()
}

pub(crate) fn load_preferences(path: &Path) -> Result<Preferences, String> {
    let Some(value) = storage::read_value(path)? else {
        return Ok(Preferences::default());
    };
    let plain = storage::decrypt(path, value)?;
    config::decode_value(plain.clone())?;
    preferences(&plain)
}

pub(crate) fn update_preferences(
    path: &Path,
    change: impl FnOnce(&mut Preferences),
) -> Result<(), String> {
    let _lock = storage::lock(path)?;
    let mut value = storage::read_value(path)?.unwrap_or(
        serde_json::to_value(DesktopConfig::default()).map_err(|_| "生成桌面默认配置失败")?,
    );
    // 即使只修改偏好，也不绕过已有凭据的认证。
    config::decode_value(storage::decrypt(path, value.clone())?)?;
    let mut prefs = preferences(&value)?;
    change(&mut prefs);
    value["preferences"] =
        serde_json::to_value(prefs.validated()?).map_err(|_| "生成桌面偏好失败")?;
    storage::write_value(path, &value)
}

fn validate_owner(path: &Path, value: Value) -> Result<(), String> {
    let plain = storage::decrypt(path, value)?;
    if plain.get("targets").is_none() {
        return Err("桌面 Owner 缺少 targets，拒绝载入不完整配置".into());
    }
    config::decode_value(plain.clone())?;
    preferences(&plain)?;
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Portable {
    pub version: u8,
    pub source_platform: String,
    pub config: DesktopConfig,
    pub preferences: Preferences,
}

fn adapt_commands(config: &mut DesktopConfig) -> Vec<String> {
    let mut warnings = Vec::new();
    const WINDOWS: &str = "node_modules\\.bin\\pi-desk.cmd start -H 127.0.0.1 -p {port} --no-open";
    const UNIX: &str = "node_modules/.bin/pi-desk start -H 127.0.0.1 -p {port} --no-open";
    for target in &mut config.targets {
        if let Some(server) = &mut target.server {
            if matches!(server.start_command.as_str(), WINDOWS | UNIX) {
                server.start_command = config::default_server_config().start_command;
            } else {
                warnings.push(format!(
                    "目标 {} 使用自定义启动命令，已原样保留，不能自动跨平台转换",
                    target.url
                ));
            }
        }
    }
    warnings
}

pub(crate) fn export(path: &Path) -> Result<Portable, String> {
    let _lock = storage::lock(path)?;
    if storage::read_optional(&path.with_file_name(JOURNAL))?.is_some() {
        return Err("存在未完成的桌面恢复事务，请先重启桌面完成恢复".into());
    }
    let value = storage::read_value(path)?.ok_or("绑定的桌面配置不存在")?;
    let mut config = config::decode_value(storage::decrypt(path, value.clone())?)?;
    for warning in adapt_commands(&mut config) {
        eprintln!("[pi-desk-desktop] {warning}");
    }
    Ok(Portable {
        version: 1,
        source_platform: std::env::consts::OS.into(),
        config,
        preferences: preferences(&value)?,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StageInput {
    operation_id: String,
    environment: Portable,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelInput {
    operation_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    operation_id: String,
    environment: Value,
}

fn validate_operation_id(value: &str) -> Result<(), String> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err("operationId 必须是标准连字符格式的 UUID".into());
    }
    Ok(())
}

fn read_pending(path: &Path) -> Result<Option<Pending>, String> {
    storage::read_value(&path.with_file_name(PENDING))?
        .map(|value| {
            let pending: Pending =
                serde_json::from_value(value).map_err(|_| "桌面待恢复请求格式无效")?;
            validate_operation_id(&pending.operation_id)?;
            Ok(pending)
        })
        .transpose()
}

pub(crate) fn stage(path: &Path, operation_id: &str, mut portable: Portable) -> Result<(), String> {
    validate_operation_id(operation_id)?;
    let _lock = storage::lock(path)?;
    let pending = path.with_file_name(PENDING);
    if storage::read_optional(&pending)?.is_some()
        || storage::read_optional(&path.with_file_name(JOURNAL))?.is_some()
    {
        return Err("已有桌面待恢复请求或未完成事务，拒绝重复暂存".into());
    }
    if portable.version != 1
        || !matches!(
            portable.source_platform.as_str(),
            "windows" | "linux" | "macos"
        )
    {
        return Err("不支持的桌面环境包版本或源平台".into());
    }
    portable.config = config::normalize(portable.config)?;
    portable.preferences = portable.preferences.validated()?;
    for warning in adapt_commands(&mut portable.config) {
        eprintln!("[pi-desk-desktop] {warning}");
    }
    let mut value = serde_json::to_value(&portable.config).map_err(|_| "生成待恢复桌面配置失败")?;
    value["preferences"] =
        serde_json::to_value(portable.preferences).map_err(|_| "生成待恢复桌面偏好失败")?;
    let value = storage::encrypt(path, value)?;
    validate_owner(path, value.clone())?;
    let request = Pending {
        operation_id: operation_id.into(),
        environment: value,
    };
    storage::write_value(
        &pending,
        &serde_json::to_value(request).map_err(|_| "生成桌面待恢复请求失败")?,
    )?;
    if let Err(error) = (|| {
        let saved = read_pending(path)?.ok_or("待恢复桌面请求缺失")?;
        if saved.operation_id != operation_id {
            return Err("待恢复桌面请求归属验证失败".into());
        }
        validate_owner(path, saved.environment)
    })() {
        let _ = fs::remove_file(&pending);
        return Err(error);
    }
    Ok(())
}

pub(crate) fn cancel(path: &Path, operation_id: &str) -> Result<bool, String> {
    validate_operation_id(operation_id)?;
    let _lock = storage::lock(path)?;
    if storage::read_optional(&path.with_file_name(JOURNAL))?.is_some() {
        return Err("存在桌面恢复事务，拒绝取消，请先由桌面启动恢复事务".into());
    }
    let Some(pending) = read_pending(path)? else {
        return Ok(false);
    };
    if !pending.operation_id.eq_ignore_ascii_case(operation_id) {
        return Err("operationId 与桌面待恢复请求不匹配，已保留原请求".into());
    }
    remove_if_present(&path.with_file_name(PENDING))?;
    Ok(true)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Transaction {
    committed: bool,
    previous: Option<Vec<u8>>,
}

fn restore(path: &Path, previous: Option<&[u8]>) -> Result<(), String> {
    match previous {
        Some(bytes) => storage::atomic_write(path, bytes),
        None => {
            if storage::read_optional(path)?.is_some() {
                fs::remove_file(path).map_err(|error| format!("回滚桌面配置失败：{error}"))?;
            }
            Ok(())
        }
    }
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    if storage::read_optional(path)?.is_some() {
        fs::remove_file(path).map_err(|error| format!("清理桌面恢复事务失败：{error}"))?;
    }
    Ok(())
}

pub(crate) fn apply_pending(path: &Path) -> Result<(), String> {
    apply_pending_with(path, || Ok(()))
}

fn apply_pending_with(
    path: &Path,
    after_write: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _lock = storage::lock(path)?;
    let journal = path.with_file_name(JOURNAL);
    let pending = path.with_file_name(PENDING);
    if let Some(bytes) = storage::read_optional(&journal)? {
        let transaction: Transaction =
            serde_json::from_slice(&bytes).map_err(|_| "桌面恢复事务损坏，拒绝载入配置")?;
        if transaction.committed {
            validate_owner(
                path,
                storage::read_value(path)?.ok_or("已提交的桌面恢复配置缺失")?,
            )?;
            remove_if_present(&pending)?;
            remove_if_present(&journal)?;
            return Ok(());
        }
        restore(path, transaction.previous.as_deref())?;
        remove_if_present(&journal)?;
    }
    let Some(request) = read_pending(path)? else {
        return Ok(());
    };
    let next = request.environment;
    validate_owner(path, next.clone())?;
    let mut transaction = Transaction {
        committed: false,
        previous: storage::read_optional(path)?,
    };
    if let Some(bytes) = &transaction.previous {
        let previous = serde_json::from_slice(bytes).map_err(|_| "当前桌面配置损坏，拒绝恢复")?;
        validate_owner(path, previous)?;
    }
    storage::atomic_write(
        &journal,
        &serde_json::to_vec(&transaction).map_err(|_| "生成桌面恢复事务失败")?,
    )?;
    let result = (|| {
        storage::write_value(path, &next)?;
        after_write()?;
        validate_owner(
            path,
            storage::read_value(path)?.ok_or("恢复后的桌面配置缺失")?,
        )?;
        transaction.committed = true;
        storage::atomic_write(
            &journal,
            &serde_json::to_vec(&transaction).map_err(|_| "生成桌面恢复提交失败")?,
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        restore(path, transaction.previous.as_deref())
            .map_err(|rollback| format!("{error}；回滚失败：{rollback}，保留事务现场并停止启动"))?;
        remove_if_present(&journal)?;
        return Err(error);
    }
    remove_if_present(&pending)?;
    remove_if_present(&journal)
}

pub(crate) fn run_if_requested() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--environment-export" | "--environment-stage" | "--environment-cancel"
        )
    }) {
        return None;
    }
    let result = (|| -> Result<Value, String> {
        let path = storage::bound_path()?;
        match args.as_slice() {
            [argument] if argument == "--environment-export" => {
                serde_json::to_value(export(&path)?).map_err(|_| "生成桌面可移植配置失败".into())
            }
            [argument]
                if matches!(
                    argument.as_str(),
                    "--environment-stage" | "--environment-cancel"
                ) =>
            {
                let mut bytes = Vec::new();
                io::stdin()
                    .lock()
                    .take(storage::MAX_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| format!("读取桌面环境输入失败：{error}"))?;
                if bytes.len() > storage::MAX_BYTES {
                    return Err("桌面环境输入过大".into());
                }
                if argument == "--environment-stage" {
                    let input: StageInput =
                        serde_json::from_slice(&bytes).map_err(|_| "桌面暂存输入格式无效")?;
                    stage(&path, &input.operation_id, input.environment)?;
                    Ok(json!({"restartRequired": true, "operationId": input.operation_id}))
                } else {
                    let input: CancelInput =
                        serde_json::from_slice(&bytes).map_err(|_| "桌面取消输入格式无效")?;
                    Ok(json!({"cancelled": cancel(&path, &input.operation_id)?}))
                }
            }
            _ => Err("环境命令不接受额外参数".into()),
        }
    })();
    Some(match result {
        Ok(value) => {
            let mut stdout = io::stdout().lock();
            if serde_json::to_writer(&mut stdout, &value).is_ok()
                && stdout
                    .write_all(b"\n")
                    .and_then(|()| stdout.flush())
                    .is_ok()
            {
                0
            } else {
                1
            }
        }
        Err(error) => {
            eprintln!("[pi-desk-desktop] 环境命令失败：{error}");
            1
        }
    })
}

#[cfg(test)]
#[path = "desktop_environment_tests.rs"]
mod tests;
