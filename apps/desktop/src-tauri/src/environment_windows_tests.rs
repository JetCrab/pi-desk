use super::{ensure_path_at, read_paths_at, RegistryKey};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use windows_sys::Win32::System::Registry::{
    RegDeleteTreeW, HKEY_CURRENT_USER, REG_EXPAND_SZ, REG_SZ,
};

struct Fixture(String);
impl Fixture {
    fn new() -> Self {
        Self(format!(
            "Software\\PiDeskNativePathTest-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    fn key(&self, name: &str) -> RegistryKey {
        RegistryKey::create(HKEY_CURRENT_USER, &format!("{}\\{}", self.0, name)).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let path: Vec<u16> = self.0.encode_utf16().chain(Some(0)).collect();
        let result = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, path.as_ptr()) };
        if !std::thread::panicking() {
            assert_eq!(result, 0, "测试注册表键必须释放");
        }
    }
}

#[test]
fn native_path_registration_preserves_raw_entries_kind_and_real_user_path() {
    let fixture = Fixture::new();
    let real = RegistryKey::open(HKEY_CURRENT_USER, "Environment").unwrap();
    let before = real.as_ref().map(|key| key.read_path().unwrap());
    let directory = Path::new(r"C:\开发者's tools\");
    for (index, (existing, machine, expected, kind)) in [
        (
            Some(r"C:\existing;%UNRELATED%"),
            "",
            r"C:\existing;%UNRELATED%;C:\开发者's tools\",
            REG_EXPAND_SZ,
        ),
        (
            Some(r"C:\existing"),
            r"C:\开发者's tools",
            r"C:\existing",
            REG_EXPAND_SZ,
        ),
        (
            Some(r"C:\开发者'S TOOLS"),
            "",
            r"C:\开发者'S TOOLS",
            REG_EXPAND_SZ,
        ),
        (Some(""), "", r"C:\开发者's tools\", REG_EXPAND_SZ),
        (None, "", r"C:\开发者's tools\", REG_EXPAND_SZ),
        (
            Some(r"C:\existing;"),
            "",
            r"C:\existing;C:\开发者's tools\",
            REG_SZ,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let key = fixture.key(&format!("case-{index}"));
        if let Some(value) = existing {
            key.set_path(value, kind).unwrap();
        }
        ensure_path_at(&key, machine, directory).unwrap();
        assert_eq!(key.read_path().unwrap(), Some((expected.to_string(), kind)));
        ensure_path_at(&key, machine, directory).unwrap();
        assert_eq!(
            key.read_path().unwrap(),
            Some((expected.to_string(), kind)),
            "重复登记不能重复追加"
        );
    }
    assert_eq!(
        real.as_ref().map(|key| key.read_path().unwrap()),
        before,
        "不能改动真实用户 PATH"
    );
}

#[test]
fn native_path_reads_expand_variables_without_rewriting_registry() {
    let fixture = Fixture::new();
    let machine = fixture.key("machine");
    let user = fixture.key("user");
    machine
        .set_path(r"%SystemRoot%\System32", REG_EXPAND_SZ)
        .unwrap();
    user.set_path(r"C:\自用程序;C:\another", REG_SZ).unwrap();
    let values = read_paths_at(Some(&machine), Some(&user)).unwrap();
    let windows = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap());
    assert!(values.contains(&windows.join("System32")));
    assert!(values.contains(&std::path::PathBuf::from(r"C:\自用程序")));
    assert!(values.contains(&std::path::PathBuf::from(r"C:\another")));
    assert_eq!(
        machine.read_path().unwrap(),
        Some((r"%SystemRoot%\System32".into(), REG_EXPAND_SZ))
    );
    ensure_path_at(&machine, "", &windows.join("System32")).unwrap();
    assert_eq!(
        machine.read_path().unwrap(),
        Some((r"%SystemRoot%\System32".into(), REG_EXPAND_SZ)),
        "已有环境变量路径不能被展开后重写"
    );
}
