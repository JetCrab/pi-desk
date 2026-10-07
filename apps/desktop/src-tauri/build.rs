use serde_json::Value;
use std::{env, fs, path::Path};

fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    let config: Value =
        serde_json::from_str(&fs::read_to_string("tauri.conf.json").expect("无法读取桌面构建配置"))
            .expect("桌面构建配置不是有效 JSON");
    let overrides: Value = env::var("TAURI_CONFIG")
        .map(|value| serde_json::from_str(&value).expect("桌面构建覆盖配置不是有效 JSON"))
        .unwrap_or(Value::Null);
    let frontend = overrides
        .pointer("/build/frontendDist")
        .or_else(|| config.pointer("/build/frontendDist"))
        .and_then(Value::as_str)
        .expect("桌面 frontendDist 必须是相对资源目录");
    // Windows 盘符会先被 Tauri 解析为 URL，导致资源不嵌入程序。
    assert!(
        !frontend.is_empty()
            && !frontend.contains(':')
            && !frontend.starts_with(['/', '\\'])
            && Path::new(frontend).is_relative(),
        "桌面 frontendDist 必须是相对资源目录，不能使用 URL 或绝对路径：{frontend}"
    );
    for name in ["index.html", "l1-desktop-main.js", "l4-desktop-ui.css"] {
        let file = Path::new(frontend).join(name);
        assert!(
            file.is_file(),
            "桌面页面资源缺失：{}，请先构建前端",
            file.display()
        );
    }
    tauri_build::build()
}
