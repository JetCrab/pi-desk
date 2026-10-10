use crate::{
    config::{PackageConfig, ReleaseChannel},
    logging, process,
};
use semver::Version;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::{Duration, Instant};

const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const OFFICIAL_REGISTRY: &str = "https://registry.npmjs.org/";

#[cfg(test)]
#[path = "packages-source-tests.rs"]
mod source_tests;

pub(crate) fn quote(value: &str) -> String {
    #[cfg(windows)]
    {
        format!("\"{}\"", value.replace('"', ""))
    }
    #[cfg(not(windows))]
    {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
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

fn package_scope(name: &str) -> Option<&str> {
    if name.starts_with('@') {
        name.split_once('/').map(|(scope, _)| scope)
    } else {
        None
    }
}

pub(crate) fn registry_arguments(name: &str, source: &str) -> String {
    let mut arguments = format!(
        " --registry {} --replace-registry-host=never",
        quote(source)
    );
    if let Some(scope) = package_scope(name) {
        arguments.push_str(&format!(
            " {}",
            quote(&format!("--{scope}:registry={source}"))
        ));
    }
    arguments
}

#[cfg(test)]
fn registry_argument(package: &PackageConfig) -> String {
    registry_arguments(
        &package.name,
        package.registry.as_deref().unwrap_or(OFFICIAL_REGISTRY),
    )
}

fn normalize_registry(source: &str) -> Result<String, String> {
    let mut url = url::Url::parse(source.trim()).map_err(|_| "npm 下载源地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("npm 下载源须为不含凭据、查询参数或片段的 HTTP(S) 地址".into());
    }
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url.to_string())
}

fn registry_failure(error: &str) -> bool {
    let codes = error
        .lines()
        .filter_map(|line| {
            let (_, detail) = line.split_once("npm ")?;
            let mut words = detail.split_whitespace();
            if !matches!(words.next()?, "error" | "ERR!") || words.next()? != "code" {
                return None;
            }
            words.next()
        })
        .collect::<Vec<_>>();
    !codes.is_empty()
        && codes.iter().all(|code| {
            matches!(
                *code,
                "ETARGET"
                    | "E404"
                    | "E401"
                    | "E403"
                    | "E429"
                    | "E500"
                    | "E502"
                    | "E503"
                    | "E504"
                    | "ETIMEDOUT"
                    | "ECONNRESET"
                    | "ECONNREFUSED"
                    | "ENOTFOUND"
                    | "EAI_AGAIN"
                    | "ESOCKETTIMEDOUT"
                    | "ENETUNREACH"
                    | "EHOSTUNREACH"
            )
        })
}

fn local_registry(
    package: &PackageConfig,
    log: &Path,
    cancelled: &dyn Fn() -> bool,
    npm: &str,
    environment: &[(OsString, OsString)],
) -> Result<String, String> {
    // 进程模块会记录 stdout；只允许有效源地址进入日志，不输出 URL 内的凭据。
    let filter = "let text='';process.stdin.on('data',data=>text+=data);process.stdin.on('end',()=>{const value=text.trim();if(!value||value==='undefined'||value==='null'){console.log('undefined');return;}try{const url=new URL(value);url.username='';url.password='';url.search='';url.hash='';console.log(url.href);}catch{process.exitCode=1;}});";
    let read = |key: &str| {
        run_with_environment(
            &format!(
                "{npm} config get {} --global --loglevel=silent | node -e {}",
                quote(key),
                quote(filter)
            ),
            None,
            QUERY_TIMEOUT,
            log,
            cancelled,
            environment,
        )
    };
    if let Some(scope) = package_scope(&package.name) {
        let source = read(&format!("{scope}:registry"))?;
        if !source.is_empty() && source != "undefined" && source != "null" {
            return normalize_registry(&source);
        }
    }
    normalize_registry(&read("registry")?)
}

pub(crate) fn with_registry_fallback<T>(
    package: &PackageConfig,
    log: &Path,
    cancelled: &dyn Fn() -> bool,
    npm: &str,
    environment: &[(OsString, OsString)],
    mut operation: impl FnMut(&str) -> Result<T, String>,
) -> Result<T, String> {
    if cancelled() {
        return Err("操作已取消".into());
    }
    let selected = normalize_registry(package.registry.as_deref().unwrap_or(OFFICIAL_REGISTRY))?;
    let mut sources = vec![selected];
    if sources[0] != OFFICIAL_REGISTRY {
        sources.push(OFFICIAL_REGISTRY.into());
    }
    let mut failures = Vec::new();
    let mut index = 0;
    let mut checked_local = false;
    loop {
        if cancelled() {
            return Err("操作已取消".into());
        }
        if index == sources.len() {
            if checked_local {
                break;
            }
            checked_local = true;
            match local_registry(package, log, cancelled, npm, environment) {
                Ok(source) if !sources.contains(&source) => sources.push(source),
                Ok(_) => break,
                Err(error) => {
                    if cancelled() || error.contains("取消") {
                        return Err("操作已取消".into());
                    }
                    logging::write(
                        log,
                        "package-registry-config-failed",
                        &format!("读取本机 npm 下载源失败：{error}"),
                    );
                    failures.push(format!("本机 npm 下载源读取失败：{error}"));
                    break;
                }
            }
        }
        if cancelled() {
            return Err("操作已取消".into());
        }
        let source = &sources[index];
        logging::write(
            log,
            "package-registry-attempt",
            &format!("尝试 npm 下载源 package={} source={source}", package.name),
        );
        let result = operation(source);
        if cancelled() {
            return Err("操作已取消".into());
        }
        match result {
            Ok(value) => return Ok(value),
            Err(error) => {
                if error.contains("取消") {
                    return Err(error);
                }
                let retry = registry_failure(&error);
                logging::write(
                    log,
                    "package-registry-failed",
                    &format!("npm 下载源失败 source={source} 可切源={retry}"),
                );
                failures.push(format!("{source}：{error}"));
                if !retry {
                    break;
                }
            }
        }
        index += 1;
    }
    Err(format!(
        "npm 操作失败，已尝试下载源：\n{}",
        failures.join("\n")
    ))
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
    let started = Instant::now();
    logging::write(
        log,
        "package-query-start",
        &format!(
            "正在查询 npm 包版本 package={} channel={:?}",
            package.name, package.channel
        ),
    );
    let result = with_registry_fallback(package, log, cancelled, npm, environment, |source| {
        let tag = match package.channel {
            ReleaseChannel::Stable => "latest",
            ReleaseChannel::Dev => "dev",
        };
        let output = run_with_environment(
            &format!(
                "{npm} view {} version --json{}",
                quote(&format!("{}@{tag}", package.name)),
                registry_arguments(&package.name, source)
            ),
            None,
            QUERY_TIMEOUT,
            log,
            cancelled,
            environment,
        )?;
        let version: String =
            serde_json::from_str(&output).map_err(|error| format!("npm 版本响应无效：{error}"))?;
        channel_version(package, &version)?;
        Ok(version)
    });
    logging::write(
        log,
        "package-query-end",
        &format!(
            "npm 版本查询 package={} success={} elapsed_ms={}",
            package.name,
            result.is_ok(),
            started.elapsed().as_millis()
        ),
    );
    result
}

fn channel_version(package: &PackageConfig, version: &str) -> Result<Version, String> {
    let parsed = Version::parse(version).map_err(|_| "npm 返回的版本号无效".to_string())?;
    if package.channel == ReleaseChannel::Stable && !parsed.pre.is_empty() {
        return Err(format!(
            "稳定通道不接受预发布版本 {version}，请等待正式版本或检查下载源"
        ));
    }
    Ok(parsed)
}

pub fn should_select_version(
    package: &PackageConfig,
    next: Option<&str>,
    current: Option<&str>,
) -> bool {
    let Some(next) = next else {
        return false;
    };
    if channel_version(package, next).is_err() {
        return false;
    }
    if current.is_some_and(|current| channel_version(package, current).is_err()) {
        return true;
    }
    is_newer(Some(next), current)
}

pub fn version_directory(base: &Path, package: &PackageConfig, version: &str) -> PathBuf {
    base.join("versions")
        .join(package.name.replace('@', "").replace('/', "+"))
        .join(version)
}

pub fn installed_directory(base: &Path, package: &PackageConfig, version: &str) -> Option<PathBuf> {
    channel_version(package, version).ok()?;
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
    let started = Instant::now();
    channel_version(package, version)?;
    if let Some(directory) = installed_directory(base, package, version) {
        logging::write(
            log,
            "package-reused",
            &format!(
                "复用已安装 npm 包 package={} version={version} directory={} elapsed_ms={}",
                package.name,
                directory.display(),
                started.elapsed().as_millis()
            ),
        );
        return Ok(directory);
    }
    let directory = version_directory(base, package, version);
    logging::write(
        log,
        "package-install-start",
        &format!("正在安装 npm 包 package={} version={version}", package.name),
    );
    let result = with_registry_fallback(package, log, cancelled, npm, environment, |source| {
        if directory.exists() {
            fs::remove_dir_all(&directory)
                .map_err(|error| format!("清理未完成的候选包失败：{error}"))?;
        }
        fs::create_dir_all(&directory).map_err(|error| format!("创建候选包目录失败：{error}"))?;
        fs::write(directory.join("package.json"), "{\"private\":true}\n")
            .map_err(|error| format!("创建候选包清单失败：{error}"))?;
        run_with_environment(
            &format!(
                "{npm} install --omit=dev --save-exact --no-audit --no-fund --progress=false {}{}",
                quote(&format!("{}@{version}", package.name)),
                registry_arguments(&package.name, source)
            ),
            Some(&directory),
            INSTALL_TIMEOUT,
            log,
            cancelled,
            environment,
        )?;
        Ok(directory.clone())
    });
    logging::write(
        log,
        "package-install-end",
        &format!(
            "npm 包安装 package={} version={version} success={} elapsed_ms={}",
            package.name,
            result.is_ok(),
            started.elapsed().as_millis()
        ),
    );
    if result.is_err() && directory.exists() {
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
    use crate::config::{PackageConfig, ReleaseChannel, UpdatePolicy};
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
            startup_update: UpdatePolicy::None,
            periodic_update: UpdatePolicy::None,
            channel: ReleaseChannel::Stable,
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
            Self::with_tags(tarballs, None)
        }

        fn with_tags(tarballs: Vec<FixtureTarball>, tags: Option<serde_json::Value>) -> Self {
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
                "dist-tags": tags.unwrap_or_else(|| serde_json::json!({"latest":latest})),
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
            startup_update: UpdatePolicy::None,
            periodic_update: UpdatePolicy::None,
            channel: ReleaseChannel::Stable,
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
    fn configured_channel_queries_the_correct_npm_tag() {
        let directory = test_directory("npm-release-channels");
        let _npm_environment = crate::test_support::NpmEnvironment::new(&directory);
        let log = directory.join("desktop.log");
        let stable = pack_fixture(&directory, "1.2.3", None, None, &log);
        let development = pack_fixture(&directory, "2.0.0-dev.9", None, None, &log);
        let registry = LocalRegistry::with_tags(
            vec![stable, development],
            Some(serde_json::json!({
                "latest":"1.2.3", "dev":"2.0.0-dev.9"
            })),
        );
        let mut package = crate::config::default_server_config().package.unwrap();
        package.name = PACKAGE_NAME.into();
        package.registry = Some(registry.address.clone());
        assert_eq!(query_version(&package, &log, &|| false).unwrap(), "1.2.3");
        package.channel = ReleaseChannel::Dev;
        assert_eq!(
            query_version(&package, &log, &|| false).unwrap(),
            "2.0.0-dev.9"
        );
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
            startup_update: UpdatePolicy::None,
            periodic_update: UpdatePolicy::None,
            channel: ReleaseChannel::Stable,
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
            startup_update: UpdatePolicy::None,
            periodic_update: UpdatePolicy::None,
            channel: ReleaseChannel::Stable,
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
