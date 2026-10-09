use std::path::{Path, PathBuf};
use std::ptr;
use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ,
    REG_OPTION_NON_VOLATILE, REG_SZ,
};

const MACHINE_ENVIRONMENT: &str =
    "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

// 此 Kernel32 API 不需要启动外部进程，也不要求增加 windows-sys feature。
#[link(name = "kernel32")]
extern "system" {
    fn ExpandEnvironmentStringsW(source: *const u16, destination: *mut u16, size: u32) -> u32;
}

struct RegistryKey(HKEY);

impl RegistryKey {
    fn create(root: HKEY, path: &str) -> Result<Self, String> {
        let path = wide(path);
        let mut key = ptr::null_mut();
        let result = unsafe {
            RegCreateKeyExW(
                root,
                path.as_ptr(),
                0,
                ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                ptr::null(),
                &mut key,
                ptr::null_mut(),
            )
        };
        if result != ERROR_SUCCESS {
            return Err(registry_error("创建环境注册表键失败", result));
        }
        Ok(Self(key))
    }

    fn open(root: HKEY, path: &str) -> Result<Option<Self>, String> {
        let path = wide(path);
        let mut key = ptr::null_mut();
        let result = unsafe { RegOpenKeyExW(root, path.as_ptr(), 0, KEY_QUERY_VALUE, &mut key) };
        match result {
            ERROR_SUCCESS => Ok(Some(Self(key))),
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(None),
            _ => Err(registry_error("打开环境注册表键失败", result)),
        }
    }

    fn read_path(&self) -> Result<Option<(String, u32)>, String> {
        let name = wide("Path");
        loop {
            let mut kind = 0;
            let mut bytes = 0;
            let result = unsafe {
                RegQueryValueExW(
                    self.0,
                    name.as_ptr(),
                    ptr::null(),
                    &mut kind,
                    ptr::null_mut(),
                    &mut bytes,
                )
            };
            if result == ERROR_FILE_NOT_FOUND {
                return Ok(None);
            }
            if result != ERROR_SUCCESS {
                return Err(registry_error("读取注册表 PATH 大小失败", result));
            }
            let mut value = vec![0u16; (bytes as usize).div_ceil(2) + 1];
            bytes = (value.len() * 2) as u32;
            let result = unsafe {
                RegQueryValueExW(
                    self.0,
                    name.as_ptr(),
                    ptr::null(),
                    &mut kind,
                    value.as_mut_ptr().cast(),
                    &mut bytes,
                )
            };
            if result == ERROR_MORE_DATA {
                continue;
            }
            if result == ERROR_FILE_NOT_FOUND {
                return Ok(None);
            }
            if result != ERROR_SUCCESS {
                return Err(registry_error("读取注册表 PATH 失败", result));
            }
            if !matches!(kind, REG_SZ | REG_EXPAND_SZ) {
                return Err(format!("注册表 PATH 类型不受支持：{kind}"));
            }
            value.truncate(bytes as usize / 2);
            while value.last() == Some(&0) {
                value.pop();
            }
            let value = String::from_utf16(&value)
                .map_err(|error| format!("注册表 PATH 编码无效：{error}"))?;
            return Ok(Some((value, kind)));
        }
    }

    fn set_path(&self, value: &str, kind: u32) -> Result<(), String> {
        let name = wide("Path");
        let value = wide(value);
        let result = unsafe {
            RegSetValueExW(
                self.0,
                name.as_ptr(),
                0,
                kind,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            )
        };
        if result != ERROR_SUCCESS {
            return Err(registry_error("保存用户 PATH 失败", result));
        }
        Ok(())
    }
}

impl Drop for RegistryKey {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn registry_error(action: &str, code: u32) -> String {
    format!(
        "{action}：{}",
        std::io::Error::from_raw_os_error(code as i32)
    )
}

fn expand_path(value: &str, kind: u32) -> Result<String, String> {
    if kind != REG_EXPAND_SZ {
        return Ok(value.to_string());
    }
    let source = wide(value);
    let mut size = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), ptr::null_mut(), 0) };
    loop {
        if size == 0 {
            return Err(format!(
                "展开注册表 PATH 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        let mut expanded = vec![0u16; size as usize];
        let written =
            unsafe { ExpandEnvironmentStringsW(source.as_ptr(), expanded.as_mut_ptr(), size) };
        if written > size {
            size = written;
            continue;
        }
        if written == 0 {
            return Err(format!(
                "展开注册表 PATH 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        return String::from_utf16(&expanded[..written as usize - 1])
            .map_err(|error| format!("展开注册表 PATH 编码无效：{error}"));
    }
}

fn expanded_path_at(key: Option<&RegistryKey>) -> Result<String, String> {
    match key.map(RegistryKey::read_path).transpose()?.flatten() {
        Some((value, kind)) => expand_path(&value, kind),
        None => Ok(String::new()),
    }
}

fn read_paths_at(
    machine: Option<&RegistryKey>,
    user: Option<&RegistryKey>,
) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for key in [machine, user].into_iter().flatten() {
        let value = expanded_path_at(Some(key))?;
        if !value.is_empty() {
            paths.extend(std::env::split_paths(&value));
        }
    }
    Ok(paths)
}

fn ensure_path_at(user: &RegistryKey, machine_path: &str, directory: &Path) -> Result<(), String> {
    let directory = directory.to_str().ok_or("登记用户 PATH 的目录编码无效")?;
    let (value, kind) = user.read_path()?.unwrap_or((String::new(), REG_EXPAND_SZ));
    let expanded = expand_path(&value, kind)?;
    let normalized = directory.trim_end_matches('\\').to_lowercase();
    if [machine_path, expanded.as_str()]
        .into_iter()
        .flat_map(std::env::split_paths)
        .any(|path| path.to_string_lossy().trim_end_matches('\\').to_lowercase() == normalized)
    {
        return Ok(());
    }
    let next = if value.is_empty() {
        directory.to_string()
    } else {
        format!("{};{directory}", value.trim_end_matches(';'))
    };
    user.set_path(&next, kind)
}

pub(super) fn read_paths() -> Result<Vec<PathBuf>, String> {
    let machine = RegistryKey::open(HKEY_LOCAL_MACHINE, MACHINE_ENVIRONMENT)?;
    let user = RegistryKey::open(HKEY_CURRENT_USER, "Environment")?;
    read_paths_at(machine.as_ref(), user.as_ref())
}

pub(super) fn ensure_user_path(directory: &Path) -> Result<(), String> {
    let machine = RegistryKey::open(HKEY_LOCAL_MACHINE, MACHINE_ENVIRONMENT)?;
    let machine_path = expanded_path_at(machine.as_ref())?;
    let user = RegistryKey::create(HKEY_CURRENT_USER, "Environment")?;
    ensure_path_at(&user, &machine_path, directory)
}

#[cfg(test)]
#[path = "environment_windows_tests.rs"]
mod tests;
