use crate::{config::PackageConfig, logging, process};
use semver::Version;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;

const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', ""))
}

#[cfg(test)]
fn run(
    command: &str,
    directory: Option<&Path>,
    timeout: Duration,
    log: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<String, String> {
    run_with_environment(command, directory, timeout, log, cancelled, &[])
}

fn run_with_environment(
    command: &str,
    directory: Option<&Path>,
    timeout: Duration,
    log: &Path,
    cancelled: &dyn Fn() -> bool,
    environment: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Result<String, String> {
    let output = process::run_capture_with_environment(
        command,
        directory,
        timeout,
        log,
        cancelled,
        environment,
    )?;
    if !output.status.success() {
        return Err(command_failure(&output));
    }
    Ok(process::decode_output(&output.stdout).trim().to_string())
}

pub(crate) fn command_failure(output: &Output) -> String {
    let stdout = process::decode_output(&output.stdout).trim().to_string();
    let stderr = process::decode_output(&output.stderr).trim().to_string();
    let detail = [stdout, stderr]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let tail: String = detail
        .chars()
        .rev()
        .take(4000)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!(
        "命令失败（退出码 {}）：{}",
        output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "未知".into()),
        tail
    )
}

fn registry_argument(package: &PackageConfig) -> String {
    package
        .registry
        .as_ref()
        .map(|registry| format!(" --registry {}", quote(registry)))
        .unwrap_or_default()
}

#[cfg(test)]
pub fn query_version(
    package: &PackageConfig,
    log: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<String, String> {
    query_version_with_environment(package, log, cancelled, "npm", &[])
}

pub(crate) fn query_version_with_environment(
    package: &PackageConfig,
    log: &Path,
    cancelled: &dyn Fn() -> bool,
    npm: &str,
    environment: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Result<String, String> {
    let output = run_with_environment(
        &format!(
            "{npm} view {} version --json{}",
            quote(&format!("{}@latest", package.name)),
            registry_argument(package)
        ),
        None,
        QUERY_TIMEOUT,
        log,
        cancelled,
        environment,
    )?;
    let version: String =
        serde_json::from_str(&output).map_err(|error| format!("npm 版本响应无效：{error}"))?;
    let parsed = Version::parse(&version).map_err(|_| "npm 返回的版本号无效")?;
    if !parsed.pre.is_empty() {
        return Err(format!(
            "npm latest 指向预发布版本 {version}，请等待正式版本或检查下载源"
        ));
    }
    Ok(version)
}

pub fn version_directory(base: &Path, package: &PackageConfig, version: &str) -> PathBuf {
    base.join("versions")
        .join(package.name.replace('@', "").replace('/', "+"))
        .join(version)
}

pub fn installed_directory(base: &Path, package: &PackageConfig, version: &str) -> Option<PathBuf> {
    let directory = version_directory(base, package, version);
    directory
        .join("node_modules")
        .join(&package.name)
        .is_dir()
        .then_some(directory)
}

pub fn previous_installed_directory(
    base: &Path,
    package: &PackageConfig,
    version: &str,
) -> Option<(String, PathBuf)> {
    let current = Version::parse(version).ok()?;
    let directory = version_directory(base, package, version);
    fs::read_dir(directory.parent()?)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let version = entry.file_name().to_str()?.to_string();
            let parsed = Version::parse(&version).ok()?;
            if !parsed.cmp_precedence(&current).is_lt() {
                return None;
            }
            let directory = installed_directory(base, package, &version)?;
            Some((parsed, version, directory))
        })
        .max_by(|left, right| left.0.cmp_precedence(&right.0))
        .map(|(_, version, directory)| (version, directory))
}

#[cfg(test)]
pub fn install(
    base: &Path,
    package: &PackageConfig,
    version: &str,
    log: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<PathBuf, String> {
    install_with_environment(base, package, version, log, cancelled, "npm", &[])
}

pub(crate) fn install_with_environment(
    base: &Path,
    package: &PackageConfig,
    version: &str,
    log: &Path,
    cancelled: &dyn Fn() -> bool,
    npm: &str,
    environment: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Result<PathBuf, String> {
    if cancelled() {
        return Err("操作已取消".into());
    }
    if let Some(directory) = installed_directory(base, package, version) {
        logging::write(
            log,
            "package-reused",
            &format!("version={version} directory={}", directory.display()),
        );
        return Ok(directory);
    }
    let directory = version_directory(base, package, version);
    if directory.exists() {
        fs::remove_dir_all(&directory)
            .map_err(|error| format!("清理未完成的候选包失败：{error}"))?;
    }
    fs::create_dir_all(&directory).map_err(|error| format!("创建候选包目录失败：{error}"))?;
    fs::write(directory.join("package.json"), "{\"private\":true}\n")
        .map_err(|error| format!("创建候选包清单失败：{error}"))?;
    let result = run_with_environment(
        &format!(
            "{npm} install --omit=dev --save-exact --no-audit --no-fund --progress=false {}{}",
            quote(&format!("{}@{version}", package.name)),
            registry_argument(package)
        ),
        Some(&directory),
        INSTALL_TIMEOUT,
        log,
        cancelled,
        environment,
    )
    .and_then(|_| {
        if cancelled() {
            Err("操作已取消".into())
        } else {
            Ok(directory.clone())
        }
    });
    if result.is_err() {
        if let Err(error) = fs::remove_dir_all(&directory) {
            logging::write(
                log,
                "package-cleanup-failed",
                &format!("directory={} error={error}", directory.display()),
            );
        }
    }
    result
}

pub fn cleanup(base: &Path, package: &PackageConfig, keep: &[&str], log: &Path) {
    let directory = base
        .join("versions")
        .join(package.name.replace('@', "").replace('/', "+"));
    let Ok(entries) = fs::read_dir(&directory) else {
        return;
    };
    for entry in entries.flatten() {
        let version = entry.file_name().to_string_lossy().into_owned();
        if keep.contains(&version.as_str()) || Version::parse(&version).is_err() {
            continue;
        }
        if entry
            .file_type()
            .map(|kind| kind.is_dir() && !kind.is_symlink())
            .unwrap_or(false)
        {
            if let Err(error) = fs::remove_dir_all(entry.path()) {
                logging::write(
                    log,
                    "package-cleanup-failed",
                    &format!("version={version} error={error}"),
                );
            }
        }
    }
}

pub fn is_newer(next: Option<&str>, current: Option<&str>) -> bool {
    let Some(next) = next.and_then(|value| Version::parse(value).ok()) else {
        return false;
    };
    let Some(current) = current.and_then(|value| Version::parse(value).ok()) else {
        return true;
    };
    next.cmp_precedence(&current).is_gt()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::{
        install, installed_directory, is_newer, previous_installed_directory, query_version, run,
        version_directory,
    };
    use crate::config::PackageConfig;
    use std::collections::HashMap;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    pub(crate) const PACKAGE_NAME: &str = "desktop-install-fixture";

    fn test_directory(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-react/react-lifecycle-tests")
            .join(format!("{name}-{}-{suffix}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn write_ready_installation(directory: &Path, name: &str, version: &str) {
        let root = directory.join("node_modules").join(name);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("package.json"),
            serde_json::json!({ "name": name, "version": version }).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn compares_versions_without_downgrading_and_recognises_prereleases() {
        assert!(is_newer(Some("1.2.3-beta.2"), Some("1.2.3-beta.1")));
        assert!(is_newer(Some("1.2.4+build.1"), Some("1.2.3")));
        assert!(!is_newer(Some("1.2.3+build.2"), Some("1.2.3+build.1")));
        assert!(is_newer(Some("0.1.66"), Some("0.1.65")));
        assert!(!is_newer(Some("0.1.65"), Some("0.1.66")));
        assert!(!is_newer(Some("0.1.66"), Some("0.1.66")));
        assert!(is_newer(Some("1.2.3"), Some("1.2.3-beta")));
    }

    #[test]
    fn reuses_only_versioned_installations_without_legacy_hard_links() {
        let directory = test_directory("package-ready");
        let legacy = directory.join("legacy");
        write_ready_installation(&legacy, PACKAGE_NAME, "1.2.3");
        let package = PackageConfig {
            name: PACKAGE_NAME.into(),
            registry: None,
            auto_update_on_start: false,
            periodic_update_check: false,
        };

        let versioned = version_directory(&directory, &package, "1.2.3");
        write_ready_installation(&versioned, PACKAGE_NAME, "9.9.9");
        assert_eq!(
            installed_directory(&directory, &package, "1.2.3"),
            Some(versioned.clone())
        );
        assert_eq!(installed_directory(&directory, &package, "1.2.4"), None);
        assert_eq!(
            installed_directory(&directory.join("legacy-base"), &package, "1.2.3"),
            None
        );
        assert_eq!(installed_directory(&legacy, &package, "1.2.3"), None);
        fs::write(
            versioned
                .join("node_modules")
                .join(PACKAGE_NAME)
                .join("package.json"),
            "{broken json",
        )
        .unwrap();
        assert_eq!(
            installed_directory(&directory, &package, "1.2.3"),
            Some(versioned.clone())
        );
        assert_eq!(
            previous_installed_directory(&directory, &package, "2.0.0"),
            Some(("1.2.3".into(), versioned))
        );
        assert_eq!(
            previous_installed_directory(&directory, &package, "1.2.3"),
            None
        );

        fs::remove_dir_all(directory).unwrap();
    }

    pub(crate) struct FixtureTarball {
        filename: String,
        bytes: Vec<u8>,
        shasum: String,
        integrity: String,
    }

    pub(crate) fn pack_fixture(
        directory: &Path,
        version: &str,
        entry: Option<&str>,
        preflight: Option<&str>,
        log: &Path,
    ) -> FixtureTarball {
        let package = directory.join(format!("fixture-{version}"));
        fs::create_dir_all(package.join("bin")).unwrap();
        fs::write(
            package.join("package.json"),
            serde_json::json!({
                "name": PACKAGE_NAME,
                "version": version,
                "bin": { "fixture-service": "service.cjs" }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            package.join("service.cjs"),
            entry.unwrap_or("#!/usr/bin/env node\n"),
        )
        .unwrap();
        if let Some(preflight) = preflight {
            fs::write(package.join("bin/pi-desk-preflight.js"), preflight).unwrap();
        }
        let output = run(
            "npm pack --json",
            Some(&package),
            Duration::from_secs(60),
            log,
            &|| false,
        )
        .expect("npm pack 应生成本地测试制品");
        let packed: serde_json::Value = serde_json::from_str(&output).unwrap();
        let packed = packed.as_array().unwrap().first().unwrap();
        let filename = packed["filename"].as_str().unwrap().to_string();
        FixtureTarball {
            bytes: fs::read(package.join(&filename)).unwrap(),
            filename,
            shasum: packed["shasum"].as_str().unwrap().to_string(),
            integrity: packed["integrity"].as_str().unwrap().to_string(),
        }
    }

    pub(crate) struct LocalRegistry {
        pub(crate) address: String,
        stopping: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }

    impl LocalRegistry {
        pub(crate) fn new(tarballs: Vec<FixtureTarball>) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = format!("http://{}", listener.local_addr().unwrap());
            let mut versions = serde_json::Map::new();
            let mut files = HashMap::new();
            for tarball in tarballs {
                let version = tarball
                    .filename
                    .strip_prefix(&format!("{PACKAGE_NAME}-"))
                    .and_then(|name| name.strip_suffix(".tgz"))
                    .unwrap()
                    .to_string();
                versions.insert(
                    version.clone(),
                    serde_json::json!({
                        "name": PACKAGE_NAME,
                        "version": version,
                        "bin": { "fixture-service": "service.cjs" },
                        "dist": {
                            "tarball": format!("{address}/{PACKAGE_NAME}/-/{}", tarball.filename),
                            "shasum": tarball.shasum,
                            "integrity": tarball.integrity
                        }
                    }),
                );
                files.insert(
                    format!("/{PACKAGE_NAME}/-/{}", tarball.filename),
                    tarball.bytes,
                );
            }
            let latest = versions.keys().max().unwrap().clone();
            let metadata = serde_json::to_vec(&serde_json::json!({
                "name": PACKAGE_NAME,
                "dist-tags": { "latest": latest },
                "versions": versions
            }))
            .unwrap();
            let stopping = Arc::new(AtomicBool::new(false));
            let worker_stopping = stopping.clone();
            let worker = thread::spawn(move || {
                while !worker_stopping.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            stream.set_nonblocking(false).unwrap();
                            serve_request(stream, &metadata, &files);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                address,
                stopping,
                worker: Some(worker),
            }
        }
    }

    impl Drop for LocalRegistry {
        fn drop(&mut self) {
            self.stopping.store(true, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    fn serve_request(mut stream: TcpStream, metadata: &[u8], files: &HashMap<String, Vec<u8>>) {
        let mut request = Vec::new();
        let mut buffer = [0; 1024];
        while !request.windows(4).any(|part| part == b"\r\n\r\n") {
            let Ok(length) = stream.read(&mut buffer) else {
                return;
            };
            if length == 0 {
                return;
            }
            request.extend_from_slice(&buffer[..length]);
        }
        let request_text = String::from_utf8_lossy(&request);
        let path = request_text
            .split_whitespace()
            .nth(1)
            .unwrap_or("/")
            .split('?')
            .next()
            .unwrap_or("/");
        let body = files.get(path).map(Vec::as_slice).or_else(|| {
            path.starts_with(&format!("/{PACKAGE_NAME}"))
                .then_some(metadata)
        });
        let (status, content_type, body) = body.map_or(
            ("404 Not Found", "application/json", b"{}".as_slice()),
            |body| {
                let content_type = if path.ends_with(".tgz") {
                    "application/octet-stream"
                } else {
                    "application/json"
                };
                ("200 OK", content_type, body)
            },
        );
        let header = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(body);
    }

    #[test]
    fn npm_install_accepts_generic_layout_ignores_service_probes_and_cleans_failed_install() {
        let directory = test_directory("npm-local-registry");
        let _npm_environment = crate::test_support::NpmEnvironment::new(&directory);
        let log = directory.join("logs/desktop.log");
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        let complete = pack_fixture(
            &directory,
            "1.2.3",
            Some("#!/usr/bin/env node\n"),
            Some("console.log('fixture-preflight-ready');"),
            &log,
        );
        let incomplete = pack_fixture(&directory, "1.2.4", None, None, &log);
        let unhealthy = pack_fixture(
            &directory,
            "1.2.5",
            Some("#!/usr/bin/env node\n"),
            Some("console.error('fixture-preflight-failed'); process.exit(9);"),
            &log,
        );
        let registry = LocalRegistry::new(vec![complete, incomplete, unhealthy]);
        let package = PackageConfig {
            name: PACKAGE_NAME.into(),
            registry: Some(registry.address.clone()),
            auto_update_on_start: false,
            periodic_update_check: false,
        };
        let cancelled = || false;
        let base = directory.join("packages");
        write_ready_installation(&base, PACKAGE_NAME, "1.2.3");

        assert_eq!(query_version(&package, &log, &cancelled).unwrap(), "1.2.5");
        let installed = install(&base, &package, "1.2.3", &log, &cancelled).unwrap();
        assert_eq!(installed, version_directory(&base, &package, "1.2.3"));
        let entry = installed
            .join("node_modules")
            .join(PACKAGE_NAME)
            .join("service.cjs");
        assert_eq!(fs::read_to_string(&entry).unwrap(), "#!/usr/bin/env node\n");
        fs::write(&entry, "existing-service-content").unwrap();
        assert_eq!(
            install(&base, &package, "1.2.3", &log, &cancelled).unwrap(),
            installed
        );
        assert_eq!(
            fs::read_to_string(&entry).unwrap(),
            "existing-service-content"
        );

        for version in ["1.2.4", "1.2.5"] {
            let candidate = install(&base, &package, version, &log, &cancelled).unwrap();
            assert_eq!(candidate, version_directory(&base, &package, version));
        }
        let log_content = fs::read_to_string(&log).unwrap();
        assert!(!log_content.contains("fixture-preflight-ready"));
        assert!(!log_content.contains("fixture-preflight-failed"));

        let error = install(&base, &package, "9.9.9", &log, &cancelled).unwrap_err();
        assert!(error.contains("命令失败"), "{error}");
        assert!(!version_directory(&base, &package, "9.9.9").exists());
        assert!(installed.exists());

        drop(registry);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn latest_tag_must_resolve_to_a_stable_version() {
        let directory = test_directory("npm-stable-version");
        let _npm_environment = crate::test_support::NpmEnvironment::new(&directory);
        let log = directory.join("desktop.log");
        let release = pack_fixture(&directory, "1.2.3", None, None, &log);
        let prerelease = pack_fixture(&directory, "2.0.0-beta.1", None, None, &log);
        let registry = LocalRegistry::new(vec![release, prerelease]);
        let package = PackageConfig {
            name: PACKAGE_NAME.into(),
            registry: Some(registry.address.clone()),
            auto_update_on_start: false,
            periodic_update_check: false,
        };
        let error = query_version(&package, &log, &|| false).unwrap_err();
        assert!(error.contains("预发布版本 2.0.0-beta.1"), "{error}");
        drop(registry);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn configured_registry_applies_to_dependencies_without_changing_user_config() {
        let directory = test_directory("scoped-registry");
        let _npm_environment = crate::test_support::NpmEnvironment::new(&directory);
        let log = directory.join("desktop.log");
        let package = PackageConfig {
            name: "@desktop-private/fixture".into(),
            registry: Some("http://127.0.0.1:12345".into()),
            auto_update_on_start: false,
            periodic_update_check: false,
        };
        let arguments = super::registry_argument(&package);
        let original = run(
            "npm config get registry",
            None,
            Duration::from_secs(15),
            &log,
            &|| false,
        )
        .unwrap();
        let configured = run(
            &format!("npm config get registry{arguments}"),
            None,
            Duration::from_secs(15),
            &log,
            &|| false,
        )
        .unwrap();
        assert_eq!(configured.trim_end_matches('/'), "http://127.0.0.1:12345");
        let unchanged = run(
            "npm config get registry",
            None,
            Duration::from_secs(15),
            &log,
            &|| false,
        )
        .unwrap();
        assert_eq!(unchanged, original);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stdout_only_nonzero_command_error_is_recorded() {
        let directory = test_directory("stdout-command-error");
        let log = directory.join("desktop.log");
        let script = directory.join("stdout-error.js");
        fs::write(
            &script,
            "process.stdout.write('stdout-only-error-marker');process.exit(7);",
        )
        .unwrap();
        let error = run(
            &format!("node {}", script.display()),
            None,
            Duration::from_secs(10),
            &log,
            &|| false,
        )
        .unwrap_err();

        assert!(error.contains("stdout-only-error-marker"));
        assert!(fs::read_to_string(&log)
            .unwrap()
            .contains("stdout-only-error-marker"));

        fs::remove_dir_all(directory).unwrap();
    }
}
