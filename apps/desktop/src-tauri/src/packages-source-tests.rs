use super::*;
use crate::config::UpdatePolicy;
use std::sync::atomic::{AtomicBool, Ordering};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-source/npm-fallback")
            .join(format!("{}-{suffix}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn npm(&self, global: &str) -> String {
        let script = self.0.join("npm-fixture.cjs");
        fs::write(&script, format!(r#"
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
const home = __dirname;
fs.appendFileSync(path.join(home,'calls.jsonl'), JSON.stringify(args)+'\n');
if(args[0]==='config') {{ console.log(args.includes('registry') ? {global:?} : 'undefined'); process.exit(0); }}
const index = args.indexOf('--registry'); const registry = args[index+1];
if(!registry || !args.includes('--replace-registry-host=never')) throw Error('没有明确固定下载源');
if(args[0]==='view') {{
 if(registry.includes('mirror.example')){{ console.error('npm error code ETARGET'); process.exit(1); }}
 console.log(JSON.stringify('1.2.3-dev')); process.exit(0);
}}
if(args[0]==='install') {{
 if(!args.includes('@jetcrab/fixture@1.2.3-dev'))throw Error('重试不能改变目标版本');
 if(registry.includes('mirror.example')){{fs.writeFileSync('package-lock.json','stale');fs.mkdirSync('node_modules',{{recursive:true}});console.error('npm error code ETARGET');process.exit(1);}}
 if(fs.existsSync('package-lock.json')||fs.existsSync('node_modules'))throw Error('未清理失败候选');
 fs.mkdirSync('node_modules/@jetcrab/fixture',{{recursive:true}});fs.writeFileSync('node_modules/@jetcrab/fixture/package.json',JSON.stringify({{version:'1.2.3-dev'}}));process.exit(0);
}}
throw Error('未预期npm命令');
"#)).unwrap();
        format!("node {}", quote(&script.to_string_lossy()))
    }
    fn package(&self, registry: &str) -> PackageConfig {
        PackageConfig {
            name: "@jetcrab/fixture".into(),
            registry: Some(registry.into()),
            startup_update: UpdatePolicy::None,
            periodic_update: UpdatePolicy::None,
            channel: ReleaseChannel::Dev,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn fallback_uses_configured_official_then_global_without_duplicates() {
    let f = Fixture::new();
    for (configured, global, expected) in [
        (
            "https://mirror.example/",
            "https://mirror.example",
            vec!["https://mirror.example/", "https://registry.npmjs.org/"],
        ),
        (
            "https://REGISTRY.npmjs.org:443/",
            "https://mirror.example/",
            vec!["https://registry.npmjs.org/", "https://mirror.example/"],
        ),
        (
            "https://custom.example/npm/",
            "https://mirror.example",
            vec![
                "https://custom.example/npm/",
                "https://registry.npmjs.org/",
                "https://mirror.example/",
            ],
        ),
        (
            "https://registry.npmjs.org",
            "https://registry.npmjs.org/",
            vec!["https://registry.npmjs.org/"],
        ),
    ] {
        let npm = f.npm(global);
        let mut tried = Vec::new();
        let result: Result<(), String> = with_registry_fallback(
            &f.package(configured),
            &f.0.join("desktop.log"),
            &|| false,
            &npm,
            &[],
            |source| {
                tried.push(url::Url::parse(source).unwrap().to_string());
                Err("npm error code ETARGET".into())
            },
        );
        assert!(result.is_err());
        assert_eq!(tried, expected);
    }
}

#[test]
fn fallback_stops_after_success_cancel_or_local_failure() {
    let f = Fixture::new();
    let npm = f.npm("https://last.example");
    let package = f.package("https://mirror.example");
    let cancel = AtomicBool::new(false);
    let mut tries = 0;
    let result = with_registry_fallback(&package, &f.0.join("log"), &|| false, &npm, &[], |_| {
        tries += 1;
        Ok("ready")
    });
    assert_eq!(result.unwrap(), "ready");
    assert_eq!(tries, 1);
    assert!(
        !f.0.join("calls.jsonl").exists(),
        "首选成功时不探测本机全局配置"
    );
    tries = 0;
    let result: Result<(), String> = with_registry_fallback(
        &package,
        &f.0.join("log"),
        &|| cancel.load(Ordering::SeqCst),
        &npm,
        &[],
        |_| {
            tries += 1;
            cancel.store(true, Ordering::SeqCst);
            Err("npm error code ETARGET".into())
        },
    );
    assert!(result.unwrap_err().contains("取消"));
    assert_eq!(tries, 1);
    for error in [
        "npm error code EPERM",
        "npm error code ENOSPC",
        "npm error code EACCES",
        "npm error code EINTEGRITY",
    ] {
        tries = 0;
        let result: Result<(), String> =
            with_registry_fallback(&package, &f.0.join("log"), &|| false, &npm, &[], |_| {
                tries += 1;
                Err(error.into())
            });
        assert!(result.unwrap_err().contains(error));
        assert_eq!(tries, 1);
    }
}

#[test]
fn real_npm_installs_from_fallback_registry_when_mirror_lacks_version() {
    let f = Fixture::new();
    let _npm_environment = crate::test_support::NpmEnvironment::new(&f.0);
    let log = f.0.join("real-npm.log");
    let old = tests::pack_fixture(&f.0, "1.2.2", None, None, &log);
    let wanted = tests::pack_fixture(&f.0, "1.2.3", None, None, &log);
    let mirror = tests::LocalRegistry::new(vec![old]);
    let official = tests::LocalRegistry::new(vec![wanted]);
    let node = run(
        "node -p process.execPath",
        None,
        Duration::from_secs(10),
        &log,
        &|| false,
    )
    .unwrap();
    let npm = crate::environment::npm_cli(Path::new(&node)).unwrap();
    let proxy = f.0.join("npm-local-proxy.cjs");
    fs::write(&proxy, format!(r#"
const cp = require('node:child_process');
const args = process.argv.slice(2);
const mapped = args.map(arg => arg === 'https://registry.npmjs.org/' ? {registry} : arg);
const result = cp.spawnSync(process.execPath, [{npm}, ...mapped], {{ stdio: 'inherit', env: process.env }});
if(result.error) throw result.error;
process.exit(result.status ?? 1);
"#, registry = serde_json::to_string(&official.address).unwrap(), npm = serde_json::to_string(&npm.to_string_lossy()).unwrap())).unwrap();
    let package = PackageConfig {
        name: tests::PACKAGE_NAME.into(),
        registry: Some(mirror.address.clone()),
        startup_update: UpdatePolicy::None,
        periodic_update: UpdatePolicy::None,
        channel: ReleaseChannel::Stable,
    };
    let installed = install_with_environment(
        &f.0.join("packages"),
        &package,
        "1.2.3",
        &log,
        &|| false,
        &format!("{} {}", quote(&node), quote(&proxy.to_string_lossy())),
        &[],
    )
    .unwrap();
    let actual: serde_json::Value = serde_json::from_slice(
        &fs::read(
            installed
                .join("node_modules")
                .join(tests::PACKAGE_NAME)
                .join("package.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(actual["version"], "1.2.3");
    let locked: serde_json::Value =
        serde_json::from_slice(&fs::read(installed.join("package-lock.json")).unwrap()).unwrap();
    assert!(
        locked["packages"][format!("node_modules/{}", tests::PACKAGE_NAME)]["resolved"]
            .as_str()
            .unwrap()
            .starts_with(&official.address)
    );
    assert!(fs::read_to_string(&log).unwrap().contains("ETARGET"));
}

#[test]
fn cleanup_warning_does_not_hide_registry_download_failure() {
    let f = Fixture::new();
    let mut tried = 0;
    let result = with_registry_fallback(
        &f.package("https://mirror.example"),
        &f.0.join("log"),
        &|| false,
        &f.npm("https://third.example"),
        &[],
        |_| {
            tried += 1;
            if tried == 1 {
                Err("npm warn cleanup EPERM failed to remove candidate\nnpm error code E404".into())
            } else {
                Ok(())
            }
        },
    );
    assert!(result.is_ok());
    assert_eq!(tried, 2);
}

#[test]
fn query_and_install_retry_the_same_version_and_remove_stale_candidate_files() {
    let f = Fixture::new();
    let npm = f.npm("https://third.example");
    let package = f.package("https://mirror.example");
    let log = f.0.join("desktop.log");
    assert_eq!(
        query_version_with_environment(&package, &log, &|| false, &npm, &[]).unwrap(),
        "1.2.3-dev"
    );
    let installed = install_with_environment(
        &f.0.join("packages"),
        &package,
        "1.2.3-dev",
        &log,
        &|| false,
        &npm,
        &[],
    )
    .unwrap();
    let saved: serde_json::Value = serde_json::from_slice(
        &fs::read(installed.join("node_modules/@jetcrab/fixture/package.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(saved["version"], "1.2.3-dev");
    let calls = fs::read_to_string(f.0.join("calls.jsonl")).unwrap();
    let records: Vec<Vec<String>> = calls
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records.iter().filter(|args| args[0] == "view").count(), 2);
    assert_eq!(
        records.iter().filter(|args| args[0] == "install").count(),
        2
    );
    assert!(
        !records.iter().any(|args| args[0] == "config"),
        "第二源已成功不该继续访问全局源"
    );
}
