use crate::desktop_storage;
use pi_desk_tunnel_common::runtime::{provider_id, TunnelMode};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use url::Url;

const MAX_CONFIG_BYTES: u64 = crate::desktop_storage::MAX_BYTES as u64;
const MAX_URL_LENGTH: usize = 2048;
const MAX_COMMAND_LENGTH: usize = 8192;
const DEFAULT_LOCAL_URL: &str = "http://127.0.0.1:30333";
#[cfg(windows)]
const DEFAULT_COMMAND: &str =
    "node_modules\\.bin\\pi-desk.cmd start -H 127.0.0.1 -p {port} --no-open";
#[cfg(not(windows))]
const DEFAULT_COMMAND: &str = "node_modules/.bin/pi-desk start -H 127.0.0.1 -p {port} --no-open";
const DEFAULT_PACKAGE: &str = "@jetcrab/pi-desk";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub targets: Vec<TargetConfig>,
    #[serde(default)]
    pub tunnel: TunnelConnectionConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetConfig {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<ServerConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub start_command: String,
    pub ready_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<PackageConfig>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePolicy {
    None,
    #[default]
    Check,
    Update,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseChannel {
    #[default]
    Stable,
    Dev,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageConfig {
    pub name: String,
    // 仅供 npm 操作注入统一源，不属于持久配置。
    #[serde(skip)]
    pub registry: Option<String>,
    #[serde(default)]
    pub startup_update: UpdatePolicy,
    #[serde(default = "default_periodic_update")]
    pub periodic_update: UpdatePolicy,
    #[serde(default)]
    pub channel: ReleaseChannel,
}

fn default_periodic_update() -> UpdatePolicy {
    UpdatePolicy::None
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TunnelPublication {
    pub local_port: u16,
    pub public_port: Option<u16>,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TunnelForward {
    pub provider_id: String,
    pub remote_port: u16,
    pub local_port: u16,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConnectionConfig {
    #[serde(default)]
    pub control_server_url: String,
    #[serde(default)]
    pub control_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub provider_secret_key: String,
    #[serde(default)]
    pub publications: Vec<TunnelPublication>,
    #[serde(default)]
    pub forwards: Vec<TunnelForward>,
    #[serde(default)]
    pub mode: TunnelMode,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            targets: vec![TargetConfig {
                url: DEFAULT_LOCAL_URL.to_string(),
                server: Some(default_server_config()),
            }],
            tunnel: TunnelConnectionConfig::default(),
        }
    }
}

pub fn default_server_config() -> ServerConfig {
    ServerConfig {
        start_command: DEFAULT_COMMAND.to_string(),
        ready_path: "/api/health".to_string(),
        package: Some(PackageConfig {
            name: DEFAULT_PACKAGE.to_string(),
            registry: None,
            startup_update: UpdatePolicy::Check,
            periodic_update: UpdatePolicy::None,
            channel: ReleaseChannel::Stable,
        }),
    }
}

impl DesktopConfig {
    pub fn target(&self, url: &str) -> Option<&TargetConfig> {
        self.targets.iter().find(|target| target.url == url)
    }
}

pub fn normalize(config: DesktopConfig) -> Result<DesktopConfig, String> {
    let mut targets = Vec::with_capacity(config.targets.len());
    let mut urls = HashSet::new();
    let mut server_ports = HashSet::new();
    for target in config.targets {
        let target = normalize_target(target)?;
        if !urls.insert(target.url.clone()) {
            return Err(format!("网页地址重复：{}", target.url));
        }
        if target.server.is_some() {
            let port = target_port(&target.url)?;
            if !server_ports.insert(port) {
                return Err(format!("多个本机服务不能使用同一个端口：{port}"));
            }
        }
        targets.push(target);
    }

    Ok(DesktopConfig {
        targets,
        tunnel: normalize_tunnel(config.tunnel)?,
    })
}

pub fn normalize_target(config: TargetConfig) -> Result<TargetConfig, String> {
    let url = normalize_target_url(&config.url)?;
    let parsed = Url::parse(&url).map_err(|_| "网页地址无效".to_string())?;
    let server = match config.server {
        Some(server) => {
            if parsed.scheme() != "http" {
                return Err("托管本机服务的网址必须使用 http://".to_string());
            }
            Some(normalize_server(server)?)
        }
        None => None,
    };
    Ok(TargetConfig { url, server })
}

pub fn normalize_target_url(value: &str) -> Result<String, String> {
    normalize_web_url(value)
}

pub fn normalize_server(config: ServerConfig) -> Result<ServerConfig, String> {
    let start_command = config.start_command.trim().to_string();
    if start_command.is_empty() {
        return Err("启动命令不能为空".to_string());
    }
    if start_command.len() > MAX_COMMAND_LENGTH {
        return Err("启动命令过长".to_string());
    }
    if start_command.contains('\0') {
        return Err("启动命令包含无效字符".to_string());
    }
    let ready_path = config.ready_path.trim().to_string();
    if !ready_path.starts_with('/') || ready_path.contains('\n') || ready_path.contains('\r') {
        return Err("就绪路径必须以 / 开头".to_string());
    }

    let package = match config.package {
        Some(package) => Some(normalize_package(package)?),
        None => None,
    };
    if start_command.contains("{package}") && package.is_none() {
        return Err("启动命令使用了 {package}，请配置 npm 包".to_string());
    }
    Ok(ServerConfig {
        start_command,
        ready_path,
        package,
    })
}

pub fn target_port(url: &str) -> Result<u16, String> {
    Url::parse(url)
        .map_err(|_| "网页地址无效".to_string())?
        .port_or_known_default()
        .ok_or_else(|| "网页地址缺少端口".to_string())
}

pub fn normalize_tunnel(
    mut config: TunnelConnectionConfig,
) -> Result<TunnelConnectionConfig, String> {
    let shared = pi_desk_tunnel_common::config::normalize_tunnel_config(
        pi_desk_tunnel_common::config::TunnelConfig {
            control_server_url: config.control_server_url,
            control_key: config.control_key,
        },
    )?;
    config.control_server_url = shared.control_server_url;
    config.control_key = shared.control_key;
    if !config.provider_secret_key.is_empty() {
        provider_id(&config.provider_secret_key)?;
    }
    let mut local_ports = HashSet::new();
    let mut public_ports = HashSet::new();
    for publication in &config.publications {
        if publication.local_port == 0 || publication.public_port == Some(0) {
            return Err("发布端口必须在 1 到 65535 之间".into());
        }
        if !local_ports.insert(publication.local_port) {
            return Err(format!("本机发布端口重复：{}", publication.local_port));
        }
        if let Some(port) = publication.public_port {
            if !public_ports.insert(port) {
                return Err(format!("公网端口重复：{port}"));
            }
        }
    }
    local_ports.clear();
    for forward in &mut config.forwards {
        forward.provider_id = forward.provider_id.trim().to_ascii_lowercase();
        if forward.provider_id.len() != 64
            || !forward
                .provider_id
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
        {
            return Err("提供端标识必须是64位十六进制公钥".into());
        }
        if forward.remote_port == 0 || forward.local_port == 0 {
            return Err("映射端口必须在 1 到 65535 之间".into());
        }
        if !local_ports.insert(forward.local_port) {
            return Err(format!("本地映射端口重复：{}", forward.local_port));
        }
    }
    Ok(config)
}

fn normalize_package(config: PackageConfig) -> Result<PackageConfig, String> {
    let name = config.name.trim().to_string();
    if name.is_empty() || name.len() > 256 || !is_package_name(&name) {
        return Err("npm 包名无效".to_string());
    }

    Ok(PackageConfig {
        name,
        registry: None,
        startup_update: config.startup_update,
        periodic_update: config.periodic_update,
        channel: config.channel,
    })
}

fn is_package_name(value: &str) -> bool {
    value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '@' | '/' | '-' | '_' | '.')
    })
}

fn normalize_web_url(raw_value: &str) -> Result<String, String> {
    let raw_url = raw_value.trim();
    if raw_url.is_empty() {
        return Err("网页地址不能为空".to_string());
    }
    if raw_url.len() > MAX_URL_LENGTH {
        return Err("网页地址过长".to_string());
    }

    let url = Url::parse(raw_url).map_err(|_| "网页地址不是有效 URL".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("网页地址必须使用 http:// 或 https://".to_string());
    }
    if url.host_str().is_none() {
        return Err("网页地址必须包含主机名".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("网页地址不能包含账号或密码".to_string());
    }
    Ok(url.to_string())
}

pub fn load(path: &Path) -> Result<DesktopConfig, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return normalize(DesktopConfig::default());
        }
        Err(error) => return Err(format!("读取桌面配置失败：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("桌面配置必须是普通文件".to_string());
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err("桌面配置文件过大".to_string());
    }

    let content = fs::read_to_string(path).map_err(|error| format!("读取桌面配置失败：{error}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| format!("桌面配置格式无效：{error}"))?;
    decode_value(desktop_storage::decrypt(path, value)?)
}

pub(crate) fn initialize(path: &Path) -> Result<(), String> {
    let _lock = desktop_storage::lock(path)?;
    if desktop_storage::read_value(path)?.is_none() {
        let mut value = serde_json::to_value(normalize(DesktopConfig::default())?)
            .map_err(|_| "生成默认桌面配置失败")?;
        value["preferences"] =
            serde_json::to_value(crate::desktop_environment::Preferences::default())
                .map_err(|_| "生成默认桌面偏好失败")?;
        desktop_storage::write_value(path, &value)?;
    }
    Ok(())
}

pub(crate) fn decode_value(value: serde_json::Value) -> Result<DesktopConfig, String> {
    let config = serde_json::from_value(value).map_err(|_| "桌面配置格式无效")?;
    normalize(config)
}

pub fn save(path: &Path, config: &DesktopConfig) -> Result<(), String> {
    let config = normalize(config.clone())?;
    let _lock = desktop_storage::lock(path)?;
    let mut value = desktop_storage::read_value(path)?
        .map(|value| {
            let plain = desktop_storage::decrypt(path, value)?;
            decode_value(plain.clone())?;
            Ok::<_, String>(plain)
        })
        .transpose()?
        .unwrap_or_else(|| serde_json::json!({}));
    let normalized = serde_json::to_value(&config).map_err(|_| "生成桌面配置失败")?;
    value["targets"] = normalized["targets"].clone();
    value["tunnel"] = normalized["tunnel"].clone();
    let encrypted = desktop_storage::encrypt(path, value)?;
    desktop_storage::write_value(path, &encrypted)
}

#[cfg(test)]
#[path = "config_tunnel_tests.rs"]
mod tunnel_tests;

#[cfg(test)]
#[path = "config_update_tests.rs"]
mod update_tests;

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        default_server_config, load, normalize, normalize_target_url, save, DesktopConfig,
        PackageConfig, ReleaseChannel, ServerConfig, TargetConfig, TunnelConnectionConfig,
        UpdatePolicy,
    };

    #[test]
    fn ignores_old_registry_without_losing_server_settings() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-source")
            .join(format!(
                "registry-migration-{}-{suffix}",
                std::process::id()
            ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.json");
        for registry in [
            serde_json::json!("https://registry.npm.taobao.org"),
            serde_json::json!(42),
            serde_json::Value::Null,
        ] {
            let original = DesktopConfig::default();
            let mut value = serde_json::to_value(&original).unwrap();
            value["targets"][0]["server"]["package"]["registry"] = registry;
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            let loaded = load(&path).unwrap();
            let server = loaded.targets[0].server.as_ref().unwrap();
            assert!(server.package.as_ref().unwrap().registry.is_none());
            assert_eq!(
                server.start_command,
                original.targets[0].server.as_ref().unwrap().start_command
            );
            assert_eq!(loaded.targets[0].url, "http://127.0.0.1:30333/");
            save(&path, &loaded).unwrap();
            let saved: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert!(saved["targets"][0]["server"]["package"]
                .get("registry")
                .is_none());
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn normalizes_equivalent_urls_to_one_identity() {
        assert_eq!(
            normalize_target_url("HTTPS://EXAMPLE.COM:443"),
            Ok("https://example.com/".to_string())
        );
    }

    #[test]
    fn rejects_duplicate_normalized_urls() {
        let config = DesktopConfig {
            targets: vec![
                TargetConfig {
                    url: "https://example.com".to_string(),
                    server: None,
                },
                TargetConfig {
                    url: "https://EXAMPLE.com:443/".to_string(),
                    server: None,
                },
            ],
            tunnel: TunnelConnectionConfig::default(),
        };

        assert!(normalize(config).is_err());
    }

    #[test]
    fn rejects_duplicate_server_ports() {
        let server_targets = DesktopConfig {
            targets: vec![
                TargetConfig {
                    url: "http://localhost:30333/a".to_string(),
                    server: Some(default_server_config()),
                },
                TargetConfig {
                    url: "http://127.0.0.1:30333/b".to_string(),
                    server: Some(default_server_config()),
                },
            ],
            tunnel: TunnelConnectionConfig::default(),
        };
        assert!(normalize(server_targets).is_err());
    }

    #[test]
    fn desktop_target_validation_does_not_own_shared_tunnel_credentials() {
        let config = DesktopConfig {
            targets: vec![],
            tunnel: TunnelConnectionConfig {
                publications: vec![super::TunnelPublication {
                    local_port: 5432,
                    public_port: None,
                    enabled: true,
                }],
                ..Default::default()
            },
        };

        assert!(normalize(config).is_ok());
    }

    #[test]
    fn preserves_configured_start_command() {
        let command = "npm run serve -- --port 30333";
        let config = normalize(DesktopConfig {
            targets: vec![TargetConfig {
                url: "http://127.0.0.1:30333".to_string(),
                server: Some(ServerConfig {
                    start_command: command.to_string(),
                    ready_path: "/api/health".to_string(),
                    package: default_server_config().package,
                }),
            }],
            tunnel: TunnelConnectionConfig::default(),
        })
        .expect("配置的启动命令应可保留");

        assert_eq!(
            config.targets[0].server.as_ref().unwrap().start_command,
            command
        );
    }

    #[test]
    fn rejects_documents_without_current_targets_without_rewriting_them() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-config")
            .join(format!(
                "ignored-legacy-config-{}-{suffix}",
                std::process::id()
            ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.json");
        for content in [
            r#"{"visit":{"url":"https://example.com"},"server":{"url":"http://127.0.0.1:30334","startCommand":"pnpm start -p {port}","readyPath":"/health","package":{"name":"example-service","autoUpdateOnStart":true,"periodicUpdateCheck":true}},"tunnel":{"enabled":true,"publicPort":40001,"controlServerUrl":"https://example.com/tunnel"}}"#,
            r#"{"visit":null,"server":false,"tunnel":"ignored"}"#,
        ] {
            fs::write(&path, content).unwrap();
            assert!(load(&path).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), content);
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn preserves_configured_package_and_command_on_load() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-config")
            .join(format!("current-package-{}-{suffix}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.json");
        fs::write(
            &path,
            r#"{"targets":[{"url":"http://127.0.0.1:30333","server":{"startCommand":"node_modules\\.bin\\pi-super.cmd start -H 127.0.0.1 -p {port} --no-open","readyPath":"/api/health","package":{"name":"@jetcrab/pi-super","startupUpdate":"none","periodicUpdate":"none","channel":"stable"}}}],"tunnel":{}}"#,
        )
        .unwrap();

        let loaded = load(&path).expect("配置的服务应可加载");
        let server = loaded.targets[0].server.as_ref().unwrap();
        assert_eq!(
            server.start_command,
            "node_modules\\.bin\\pi-super.cmd start -H 127.0.0.1 -p {port} --no-open"
        );
        assert_eq!(server.package.as_ref().unwrap().name, "@jetcrab/pi-super");
        save(&path, &loaded).expect("保存时应保留用户配置的服务");
        let rewritten = fs::read_to_string(&path).unwrap();
        assert!(rewritten.contains("@jetcrab/pi-super"));
        assert!(rewritten.contains("pi-super.cmd"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn defaults_both_package_update_options_to_disabled() {
        let package = default_server_config().package.unwrap();

        assert_ne!(package.startup_update, UpdatePolicy::Update);
        assert_eq!(package.periodic_update, UpdatePolicy::None);
    }

    #[test]
    fn keeps_periodic_update_settings_per_target() {
        let config = normalize(DesktopConfig {
            targets: vec![TargetConfig {
                url: "http://127.0.0.1:30333".to_string(),
                server: Some(ServerConfig {
                    start_command: "pnpm dlx {package} start -p {port}".to_string(),
                    ready_path: "/api/health".to_string(),
                    package: Some(PackageConfig {
                        name: "@jetcrab/pi-desk".to_string(),
                        registry: None,
                        startup_update: UpdatePolicy::None,
                        periodic_update: UpdatePolicy::Update,
                        channel: ReleaseChannel::Stable,
                    }),
                }),
            }],
            tunnel: TunnelConnectionConfig::default(),
        })
        .unwrap();

        let package = config.targets[0]
            .server
            .as_ref()
            .and_then(|server| server.package.as_ref())
            .unwrap();
        assert_eq!(package.startup_update, UpdatePolicy::None);
        assert_eq!(package.periodic_update, UpdatePolicy::Update);
    }
}
