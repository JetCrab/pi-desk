use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use url::Url;

const MAX_CONFIG_BYTES: u64 = 256 * 1024;
const MAX_URL_LENGTH: usize = 2048;
const MAX_COMMAND_LENGTH: usize = 8192;
const DEFAULT_LOCAL_URL: &str = "http://127.0.0.1:30333";
const DEFAULT_COMMAND: &str =
    "node_modules\\.bin\\pi-desk.cmd start -H 127.0.0.1 -p {port} --no-open";
const DEFAULT_PACKAGE: &str = "@jetcrab/pi-desk";
const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub targets: Vec<TargetConfig>,
    #[serde(default)]
    pub tunnel: TunnelConnectionConfig,
}

pub struct LoadedDesktopConfig {
    pub config: DesktopConfig,
    pub needs_rewrite: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetConfig {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<ServerConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel: Option<TargetTunnelConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub start_command: String,
    pub ready_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<PackageConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageConfig {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry: Option<String>,
    #[serde(default, alias = "autoUpdate")]
    pub auto_update_on_start: bool,
    #[serde(default)]
    pub periodic_update_check: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetTunnelConfig {
    #[serde(default)]
    pub enabled: bool,
    pub public_port: u16,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConnectionConfig {
    #[serde(default)]
    pub control_server_url: String,
    #[serde(default)]
    pub control_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub device_id: String,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            targets: vec![TargetConfig {
                url: DEFAULT_LOCAL_URL.to_string(),
                server: Some(default_server_config()),
                tunnel: None,
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
            registry: Some(DEFAULT_REGISTRY.to_string()),
            auto_update_on_start: false,
            periodic_update_check: false,
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
    let mut public_ports = HashSet::new();

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
        if let Some(target_tunnel) = target.tunnel.as_ref() {
            if !public_ports.insert(target_tunnel.public_port) {
                return Err(format!(
                    "多个网址不能使用同一个公网端口：{}",
                    target_tunnel.public_port
                ));
            }
        }
        targets.push(target);
    }

    Ok(DesktopConfig {
        targets,
        tunnel: config.tunnel,
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
    let tunnel = config.tunnel.map(normalize_target_tunnel).transpose()?;
    Ok(TargetConfig {
        url,
        server,
        tunnel,
    })
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

fn normalize_target_tunnel(config: TargetTunnelConfig) -> Result<TargetTunnelConfig, String> {
    if config.public_port == 0 {
        return Err("公网端口必须在 1 到 65535 之间".to_string());
    }
    Ok(config)
}

fn normalize_package(config: PackageConfig) -> Result<PackageConfig, String> {
    let name = config.name.trim().to_string();
    if name.is_empty() || name.len() > 256 || !is_package_name(&name) {
        return Err("npm 包名无效".to_string());
    }

    let registry = match config.registry {
        Some(registry) if !registry.trim().is_empty() => {
            let value = normalize_web_url(&registry)?;
            Some(value.trim_end_matches('/').to_string())
        }
        _ => None,
    };
    Ok(PackageConfig {
        name,
        registry,
        auto_update_on_start: config.auto_update_on_start,
        periodic_update_check: config.periodic_update_check,
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

pub fn load(path: &Path) -> Result<LoadedDesktopConfig, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(LoadedDesktopConfig {
                config: normalize(DesktopConfig::default())?,
                needs_rewrite: false,
            })
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
    if value.get("targets").is_some() {
        let config: DesktopConfig =
            serde_json::from_value(value).map_err(|error| format!("桌面配置格式无效：{error}"))?;
        return Ok(LoadedDesktopConfig {
            config: normalize(config)?,
            needs_rewrite: false,
        });
    }

    let legacy: LegacyDesktopConfig =
        serde_json::from_value(value).map_err(|error| format!("旧桌面配置格式无效：{error}"))?;
    Ok(LoadedDesktopConfig {
        config: migrate_legacy(legacy)?,
        needs_rewrite: true,
    })
}

pub fn save(path: &Path, config: &DesktopConfig) -> Result<(), String> {
    let config = normalize(config.clone())?;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("桌面配置必须是普通文件".to_string());
        }
    }

    let parent = path
        .parent()
        .ok_or_else(|| "桌面配置目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建桌面配置目录失败：{error}"))?;
    let content = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("生成桌面配置失败：{error}"))?;
    if content.len() as u64 > MAX_CONFIG_BYTES {
        return Err("桌面配置内容过大".to_string());
    }
    let temporary = temporary_path(path);
    fs::write(&temporary, format!("{content}\n"))
        .map_err(|error| format!("写入桌面配置失败：{error}"))?;

    let result: Result<(), String> = match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            if !path.exists() {
                Err(format!("保存桌面配置失败：{rename_error}"))
            } else {
                fs::remove_file(path)
                    .and_then(|()| fs::rename(&temporary, path))
                    .map_err(|error| format!("替换桌面配置失败：{error}"))
            }
        }
    };
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDesktopConfig {
    visit: LegacyVisitConfig,
    server: LegacyServerConfig,
    #[serde(default)]
    tunnel: LegacyTunnelConfig,
}

#[derive(Deserialize)]
struct LegacyVisitConfig {
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyServerConfig {
    url: String,
    start_command: String,
    ready_path: String,
    #[serde(default)]
    package: Option<PackageConfig>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTunnelConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    control_server_url: String,
    #[serde(default)]
    control_key: String,
    #[serde(default)]
    public_port: u16,
    #[serde(default)]
    device_id: String,
}

fn migrate_legacy(legacy: LegacyDesktopConfig) -> Result<DesktopConfig, String> {
    let visit_url = normalize_target_url(&legacy.visit.url)?;
    let server_url = normalize_target_url(&legacy.server.url)?;
    if Url::parse(&server_url)
        .map_err(|_| "本机服务地址无效".to_string())?
        .scheme()
        != "http"
    {
        return Err("托管本机服务的网址必须使用 http://".to_string());
    }

    let server = ServerConfig {
        start_command: legacy.server.start_command,
        ready_path: legacy.server.ready_path,
        package: legacy.server.package,
    };
    let target_tunnel = (legacy.tunnel.public_port != 0).then_some(TargetTunnelConfig {
        enabled: legacy.tunnel.enabled,
        public_port: legacy.tunnel.public_port,
    });
    let mut targets = vec![TargetConfig {
        url: visit_url.clone(),
        server: None,
        tunnel: None,
    }];
    if visit_url == server_url {
        targets[0].server = Some(server);
        targets[0].tunnel = target_tunnel;
    } else {
        targets.push(TargetConfig {
            url: server_url,
            server: Some(server),
            tunnel: target_tunnel,
        });
    }

    let tunnel = TunnelConnectionConfig {
        control_server_url: legacy.tunnel.control_server_url,
        control_key: legacy.tunnel.control_key,
        device_id: legacy.tunnel.device_id,
    };
    normalize(DesktopConfig { targets, tunnel })
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("config.json");
    path.with_file_name(format!("{name}.{}.tmp", std::process::id()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        default_server_config, load, migrate_legacy, normalize, normalize_target_url, save,
        DesktopConfig, LegacyDesktopConfig, PackageConfig, ServerConfig, TargetConfig,
        TargetTunnelConfig, TunnelConnectionConfig,
    };

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
                    tunnel: None,
                },
                TargetConfig {
                    url: "https://EXAMPLE.com:443/".to_string(),
                    server: None,
                    tunnel: None,
                },
            ],
            tunnel: TunnelConnectionConfig::default(),
        };

        assert!(normalize(config).is_err());
    }

    #[test]
    fn rejects_duplicate_server_and_public_ports() {
        let server_targets = DesktopConfig {
            targets: vec![
                TargetConfig {
                    url: "http://localhost:30333/a".to_string(),
                    server: Some(default_server_config()),
                    tunnel: None,
                },
                TargetConfig {
                    url: "http://127.0.0.1:30333/b".to_string(),
                    server: Some(default_server_config()),
                    tunnel: None,
                },
            ],
            tunnel: TunnelConnectionConfig::default(),
        };
        assert!(normalize(server_targets).is_err());

        let tunnel_targets = DesktopConfig {
            targets: vec![
                TargetConfig {
                    url: "http://127.0.0.1:30333".to_string(),
                    server: None,
                    tunnel: Some(TargetTunnelConfig {
                        enabled: false,
                        public_port: 40001,
                    }),
                },
                TargetConfig {
                    url: "http://127.0.0.1:30334".to_string(),
                    server: None,
                    tunnel: Some(TargetTunnelConfig {
                        enabled: false,
                        public_port: 40001,
                    }),
                },
            ],
            tunnel: TunnelConnectionConfig::default(),
        };
        assert!(normalize(tunnel_targets).is_err());
    }

    #[test]
    fn desktop_target_validation_does_not_own_shared_tunnel_credentials() {
        let config = DesktopConfig {
            targets: vec![TargetConfig {
                url: "http://127.0.0.1:30333".to_string(),
                server: None,
                tunnel: Some(TargetTunnelConfig {
                    enabled: true,
                    public_port: 40001,
                }),
            }],
            tunnel: TunnelConnectionConfig::default(),
        };

        assert!(normalize(config).is_ok());
    }

    #[test]
    fn migrates_legacy_visit_and_server_into_url_targets() {
        let legacy: LegacyDesktopConfig = serde_json::from_str(
            r#"{"visit":{"url":"http://127.0.0.1:30333"},"server":{"url":"http://127.0.0.1:30333","startCommand":"pnpm dlx {package} start -p {port}","readyPath":"/api/health","package":{"name":"@jetcrab/pi-desk","autoUpdate":false}},"tunnel":{"enabled":false,"publicPort":40001}}"#,
        )
        .expect("旧配置应可读取");
        let config = migrate_legacy(legacy).expect("旧配置应迁移");

        assert_eq!(config.targets.len(), 1);
        assert!(config.targets[0].server.is_some());
        assert_eq!(
            config.targets[0].tunnel.as_ref().unwrap().public_port,
            40001
        );
        let package = config.targets[0]
            .server
            .as_ref()
            .and_then(|server| server.package.as_ref())
            .unwrap();
        assert!(!package.auto_update_on_start);
        assert!(!package.periodic_update_check);
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
                tunnel: None,
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
    fn load_marks_legacy_config_for_rewrite() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "jetcrab-desktop-config-test-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.json");
        fs::write(
            &path,
            r#"{"visit":{"url":"https://example.com"},"server":{"url":"http://127.0.0.1:30333","startCommand":"pnpm start -p {port}","readyPath":"/api/health"}}"#,
        )
        .unwrap();

        let loaded = load(&path).expect("旧配置文件应可迁移");
        assert!(loaded.needs_rewrite);
        save(&path, &loaded.config).expect("迁移完成后应重写桌面配置");
        let rewritten = fs::read_to_string(&path).unwrap();

        assert_eq!(loaded.config.targets.len(), 2);
        assert!(rewritten.contains("\"targets\""));
        assert!(!rewritten.contains("\"visit\""));
        assert!(serde_json::from_str::<serde_json::Value>(&rewritten)
            .unwrap()
            .get("tunnel")
            .is_some());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn preserves_configured_package_and_command_on_load() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "jetcrab-desktop-legacy-config-test-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.json");
        fs::write(
            &path,
            r#"{"targets":[{"url":"http://127.0.0.1:30333","server":{"startCommand":"node_modules\\.bin\\pi-super.cmd start -H 127.0.0.1 -p {port} --no-open","readyPath":"/api/health","package":{"name":"@jetcrab/pi-super","registry":"https://registry.example.com","autoUpdateOnStart":true,"periodicUpdateCheck":false}}}],"tunnel":{}}"#,
        )
        .unwrap();

        let loaded = load(&path).expect("配置的服务应可加载");
        assert!(!loaded.needs_rewrite);
        let server = loaded.config.targets[0].server.as_ref().unwrap();
        assert_eq!(
            server.start_command,
            "node_modules\\.bin\\pi-super.cmd start -H 127.0.0.1 -p {port} --no-open"
        );
        assert_eq!(
            server.package.as_ref().unwrap().name,
            "@jetcrab/pi-super"
        );
        save(&path, &loaded.config).expect("保存时应保留用户配置的服务");
        let rewritten = fs::read_to_string(&path).unwrap();
        assert!(rewritten.contains("@jetcrab/pi-super"));
        assert!(rewritten.contains("pi-super.cmd"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn defaults_both_package_update_options_to_disabled() {
        let package = default_server_config().package.unwrap();

        assert!(!package.auto_update_on_start);
        assert!(!package.periodic_update_check);
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
                        auto_update_on_start: false,
                        periodic_update_check: true,
                    }),
                }),
                tunnel: None,
            }],
            tunnel: TunnelConnectionConfig::default(),
        })
        .unwrap();

        let package = config.targets[0]
            .server
            .as_ref()
            .and_then(|server| server.package.as_ref())
            .unwrap();
        assert!(!package.auto_update_on_start);
        assert!(package.periodic_update_check);
    }
}
