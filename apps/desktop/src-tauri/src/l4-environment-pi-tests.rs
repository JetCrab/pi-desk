use super::{installation, matching_installation};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-pi-update")
            .join(format!(
                "package-identity-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn package(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir_all(&path).unwrap();
        fs::write(
            path.join("package.json"),
            r#"{"name":"@earendil-works/pi-coding-agent","version":"1.1.0"}"#,
        )
        .unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
}

#[test]
fn pi_update_requires_the_same_physical_global_installation() {
    let fixture = Fixture::new();
    let global = fixture.package("global");
    let manual = fixture.package("manual");
    let selected = fs::canonicalize(&global).unwrap();
    assert_eq!(
        matching_installation(&selected, &global).unwrap().version,
        "1.1.0"
    );
    assert!(matching_installation(&manual, &global)
        .err()
        .unwrap()
        .contains("不属于"));
    fs::create_dir(global.join(".git")).unwrap();
    assert!(installation(&global).err().unwrap().contains("源码"));
}

#[cfg(any(windows, unix))]
#[test]
fn pi_update_rejects_npm_link_even_when_selected_path_is_resolved() {
    let fixture = Fixture::new();
    let source = fixture.package("source");
    let link = fixture.0.join("linked");
    create_link(&source, &link);
    assert!(matching_installation(&source, &link)
        .err()
        .unwrap()
        .contains("链接"));
    assert!(installation(&link).err().unwrap().contains("链接"));
}

#[test]
fn pi_update_npm_commands_target_only_the_selected_package_and_confirmed_version() {
    use crate::environment::{Component, EnvironmentState, PI_PACKAGE};
    use crate::environment_source::DownloadSource;
    use std::process::Command;
    let fixture = Fixture::new();
    let bin = fixture.0.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let node_output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(node_output.status.success());
    let actual_node = String::from_utf8(node_output.stdout)
        .unwrap()
        .trim()
        .to_string();
    let node = bin.join(if cfg!(windows) { "node.exe" } else { "node" });
    #[cfg(windows)]
    fs::copy(&actual_node, &node).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&actual_node, &node).unwrap();
    let modules = fixture.0.join("global/node_modules");
    let global = modules.join(PI_PACKAGE);
    fs::create_dir_all(&global).unwrap();
    let manifest =
        serde_json::json!({ "name": PI_PACKAGE, "version": "1.1.0", "bin": {"pi": "cli.cjs"} });
    fs::write(
        global.join("package.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    fs::write(
        global.join("cli.cjs"),
        "console.log(require('./package.json').version)",
    )
    .unwrap();
    let proxy = bin.join("npm-fixture.cjs");
    fs::write(&proxy, format!(r#"
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),root={root},global=path.join(root,'@earendil-works/pi-coding-agent');
fs.appendFileSync(path.join(__dirname,'calls.jsonl'),JSON.stringify(args)+'\n');
if(args[0]==='--version')console.log('10.0.0');
else if(args[0]==='root' && args[1]==='-g')console.log(root);
else if(args[0]==='view')console.log(JSON.stringify('1.2.0'));
else if(args[0]==='install'){{
 if(fs.existsSync(path.join(__dirname,'fail-install'))){{console.error('npm error code EPERM');process.exit(1)}}
 const file=path.join(global,'package.json'),manifest=JSON.parse(fs.readFileSync(file));
 manifest.version='1.2.0';fs.writeFileSync(file,JSON.stringify(manifest));
}}else throw Error('未声明的npm fixture命令：'+args);
"#, root=serde_json::to_string(&fs::canonicalize(&modules).unwrap().to_string_lossy()).unwrap())).unwrap();
    #[cfg(windows)]
    fs::write(
        bin.join("npm.cmd"),
        format!(
            "@echo off\r\n\"{}\" \"{}\" %*\r\n",
            actual_node,
            fs::canonicalize(&proxy)
                .unwrap()
                .to_string_lossy()
                .trim_start_matches(r"\\?\")
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let npm = bin.join("npm");
        fs::write(
            &npm,
            format!(
                "#!/bin/sh\nexec {} {} \"$@\"\n",
                crate::packages::quote(&actual_node),
                crate::packages::quote(&fs::canonicalize(&proxy).unwrap().to_string_lossy())
            ),
        )
        .unwrap();
        fs::set_permissions(npm, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let state = EnvironmentState::new(
        fixture.0.join("environment"),
        fixture.0.join("environment.json"),
    );
    let log = fixture.0.join("desktop.log");
    fs::create_dir_all(&state.root).unwrap();
    state
        .use_installed(Component::Node, &node, &|| false, &log)
        .unwrap();
    state
        .use_installed(Component::Pi, &global, &|| false, &log)
        .unwrap();
    let source = DownloadSource::Custom("https://pi-fixture.invalid/npm/".into());
    assert_eq!(
        super::update_target(&state, &|| false, &log)
            .unwrap()
            .version,
        "1.1.0"
    );
    assert_eq!(
        super::query_version(&state, &source, &|| false, &log).unwrap(),
        "1.2.0"
    );
    assert_eq!(
        installation(&global).unwrap().version,
        "1.1.0",
        "检查不能安装"
    );
    super::install_version(&state, &state.root, &source, "1.2.0", &|| false, &log).unwrap();
    assert_eq!(installation(&global).unwrap().version, "1.2.0");
    assert_eq!(
        state
            .snapshot()
            .components
            .into_iter()
            .find(|item| item.name == Component::Pi)
            .unwrap()
            .version
            .as_deref(),
        Some("1.2.0")
    );
    let calls = fs::read_to_string(bin.join("calls.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Vec<String>>(line).unwrap())
        .collect::<Vec<_>>();
    let installs = calls
        .iter()
        .filter(|args| args[0] == "install")
        .collect::<Vec<_>>();
    assert_eq!(installs.len(), 1);
    for argument in [
        "-g",
        "--ignore-scripts",
        "--replace-registry-host=never",
        "--@earendil-works:registry=https://pi-fixture.invalid/npm/",
        "@earendil-works/pi-coding-agent@1.2.0",
    ] {
        assert!(
            installs[0].iter().any(|arg| arg == argument),
            "安装缺少必要参数：{argument}"
        );
    }
    assert!(
        !fixture.0.join("environment.json").exists(),
        "更新不得改写用户选择"
    );
    fs::write(bin.join("fail-install"), "").unwrap();
    let error =
        super::install_version(&state, &state.root, &source, "1.3.0", &|| false, &log).unwrap_err();
    assert!(error.contains("EPERM"));
    assert_eq!(
        installation(&global).unwrap().version,
        "1.2.0",
        "安装失败不得伪报新版本"
    );
    let before = fs::read(bin.join("calls.jsonl")).unwrap();
    assert!(
        super::install_version(&state, &state.root, &source, "1.3.0-dev", &|| false, &log).is_err()
    );
    assert!(super::install_version(&state, &state.root, &source, "1.3.0", &|| true, &log).is_err());
    assert_eq!(
        fs::read(bin.join("calls.jsonl")).unwrap(),
        before,
        "预发布与取消不得执行安装命令"
    );
}

#[cfg(windows)]
fn create_link(source: &Path, link: &Path) {
    use std::process::Command;
    let target = fs::canonicalize(source).unwrap();
    let link = fs::canonicalize(link.parent().unwrap())
        .unwrap()
        .join(link.file_name().unwrap());
    let output = Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(link.to_string_lossy().trim_start_matches(r"\\?\"))
        .arg(target.to_string_lossy().trim_start_matches(r"\\?\"))
        .output()
        .unwrap();
    assert!(output.status.success(), "无法创建测试junction：{output:?}");
}
#[cfg(unix)]
fn create_link(source: &Path, link: &Path) {
    std::os::unix::fs::symlink(fs::canonicalize(source).unwrap(), link).unwrap();
}
