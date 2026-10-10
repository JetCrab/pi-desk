use crate::logging;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

const IP_LOOKUP_URL: &str = "https://ipwho.is/?fields=success,country_code";
const IP_LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "mode", content = "registry", rename_all = "lowercase")]
pub(crate) enum DownloadSource {
    #[default]
    Official,
    Domestic,
    Custom(String),
}

impl DownloadSource {
    pub(crate) fn validated(self) -> Result<Self, String> {
        if let Self::Custom(value) = self {
            let value = value.trim();
            if value.len() > 2048 {
                return Err("下载源地址过长".into());
            }
            let url = url::Url::parse(value).map_err(|_| "请输入有效的下载源地址")?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("下载源必须是 HTTP/HTTPS 地址，不能包含账号、密码或查询参数".into());
            }
            return Ok(Self::Custom(url.to_string()));
        }
        Ok(self)
    }

    pub(crate) fn node_base(&self) -> &'static str {
        match self {
            Self::Official | Self::Custom(_) => "https://nodejs.org/dist/",
            Self::Domestic => "https://npmmirror.com/mirrors/node/",
        }
    }

    pub(crate) fn npm_registry(&self) -> &str {
        match self {
            Self::Official => "https://registry.npmjs.org",
            Self::Domestic => "https://mirrors.cloud.tencent.com/npm",
            Self::Custom(registry) => registry,
        }
    }

    pub(crate) fn git_url(&self, official_url: &str) -> String {
        match self {
            Self::Official | Self::Custom(_) => official_url.into(),
            Self::Domestic => official_url.replace(
                "https://github.com/git-for-windows/git/releases/download/",
                "https://registry.npmmirror.com/-/binary/git-for-windows/",
            ),
        }
    }
}

pub(crate) fn lookup_url() -> String {
    // 仅供隔离验收使用本地 IP 查询 fixture，不进入桌面配置或 IPC。
    if std::env::var_os("PI_DESK_DESKTOP_DATA_DIR").is_some() {
        if let Ok(url) = std::env::var("PI_DESK_DESKTOP_IP_LOOKUP_URL") {
            return url;
        }
    }
    IP_LOOKUP_URL.into()
}

pub(crate) async fn recommend(url: &str, log: &Path) -> DownloadSource {
    #[derive(Deserialize)]
    struct Country {
        success: bool,
        country_code: Option<String>,
    }
    let result = async {
        let client = reqwest::Client::builder()
            .connect_timeout(IP_LOOKUP_TIMEOUT)
            .timeout(IP_LOOKUP_TIMEOUT)
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;
        let text = response.text().await.map_err(|error| error.to_string())?;
        let country: Country = serde_json::from_str(&text).map_err(|error| error.to_string())?;
        if !country.success
            || country
                .country_code
                .as_ref()
                .is_none_or(|code| code.len() != 2)
        {
            return Err("IP 查询未返回国家代码".to_string());
        }
        Ok(if country.country_code.as_deref() == Some("CN") {
            DownloadSource::Domestic
        } else {
            DownloadSource::Official
        })
    }
    .await;
    match result {
        Ok(source) => {
            logging::write(
                log,
                "environment-source-recommendation",
                &format!("IP 默认推荐：{source:?}"),
            );
            source
        }
        Err(error) => {
            logging::write(
                log,
                "environment-source-recommendation-failed",
                &format!("IP 查询失败，默认使用官方源：{error}"),
            );
            DownloadSource::Official
        }
    }
}

#[cfg(test)]
#[path = "l4-environment-source-tests.rs"]
mod tests;
