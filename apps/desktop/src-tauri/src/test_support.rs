use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

static NPM_ENVIRONMENT_LOCK: Mutex<()> = Mutex::new(());

pub(crate) struct NpmEnvironment {
    previous_cache: Option<OsString>,
    previous_user_config: Option<OsString>,
    _lock: MutexGuard<'static, ()>,
}

impl NpmEnvironment {
    pub(crate) fn new(directory: &Path) -> Self {
        let lock = NPM_ENVIRONMENT_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cache = directory.join("npm-cache");
        let user_config = directory.join(".npmrc");
        fs::create_dir_all(&cache).unwrap();
        fs::write(&user_config, "").unwrap();
        let previous_cache = std::env::var_os("NPM_CONFIG_CACHE");
        let previous_user_config = std::env::var_os("NPM_CONFIG_USERCONFIG");
        std::env::set_var("NPM_CONFIG_CACHE", cache);
        std::env::set_var("NPM_CONFIG_USERCONFIG", user_config);
        Self {
            previous_cache,
            previous_user_config,
            _lock: lock,
        }
    }
}

impl Drop for NpmEnvironment {
    fn drop(&mut self) {
        match self.previous_cache.take() {
            Some(value) => std::env::set_var("NPM_CONFIG_CACHE", value),
            None => std::env::remove_var("NPM_CONFIG_CACHE"),
        }
        match self.previous_user_config.take() {
            Some(value) => std::env::set_var("NPM_CONFIG_USERCONFIG", value),
            None => std::env::remove_var("NPM_CONFIG_USERCONFIG"),
        }
    }
}
