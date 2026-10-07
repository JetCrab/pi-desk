use crate::environment::EnvironmentState;
use crate::logging;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use reqwest::{Client, Response, StatusCode};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Duration;

const MAX_SIZE: u64 = 256 * 1024 * 1024;
const PARALLEL_THRESHOLD: u64 = 1024 * 1024;
const RETRY_DELAYS: [u64; 5] = [1, 2, 4, 8, 8];

pub(crate) fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| format!("初始化下载失败：{error}"))
}

pub(crate) fn download(
    state: &EnvironmentState,
    client: &Client,
    url: &str,
    destination: &Path,
    expected_size: Option<u64>,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<String, String> {
    logging::write(
        log,
        "environment-download-start",
        &format!("开始下载：url={url} file={}", destination.display()),
    );
    let mut created = false;
    let result = (|| {
        check_cancelled(cancelled).map_err(Failure::message)?;
        validate_size(expected_size, expected_size).map_err(Failure::message)?;
        state.progress(destination, 0, expected_size);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("初始化下载运行时失败：{error}"))?;
        let download = Download {
            state,
            client,
            url,
            destination,
            expected_size,
            cancelled,
            log,
            received: Cell::new(0),
        };
        // 所有分段都由此运行时内的 futures 持有，退出后不留下后台下载任务。
        runtime.block_on(download.run(&mut created))
    })();
    if let Err(error) = &result {
        logging::write(
            log,
            "environment-download-failed",
            &format!("下载失败：{error}"),
        );
        if created {
            if let Err(cleanup) = fs::remove_file(destination) {
                if cleanup.kind() != std::io::ErrorKind::NotFound {
                    logging::write(
                        log,
                        "environment-download-cleanup-failed",
                        &format!("清理未完成下载失败：{cleanup}"),
                    );
                }
            }
        }
    }
    result
}

struct Download<'a> {
    state: &'a EnvironmentState,
    client: &'a Client,
    url: &'a str,
    destination: &'a Path,
    expected_size: Option<u64>,
    cancelled: &'a dyn Fn() -> bool,
    log: &'a Path,
    received: Cell<u64>,
}

impl Download<'_> {
    async fn run(&self, created: &mut bool) -> Result<String, String> {
        let probe = self.probe().await?;
        check_cancelled(self.cancelled).map_err(Failure::message)?;
        let file =
            File::create(self.destination).map_err(|error| format!("创建下载文件失败：{error}"))?;
        *created = true;
        match probe {
            Probe::Range(total) => {
                let connections = if total >= PARALLEL_THRESHOLD { 10 } else { 1 };
                logging::write(
                    self.log,
                    "environment-download-mode",
                    &format!("分段下载：大小={total} 字节，连接数={connections}"),
                );
                file.set_len(total)
                    .map_err(|error| format!("设置下载文件大小失败：{error}"))?;
                self.state.progress(self.destination, 0, Some(total));
                if connections == 10 {
                    let part = total / 10;
                    tokio::try_join!(
                        self.segment(0, part, total),
                        self.segment(part, part * 2, total),
                        self.segment(part * 2, part * 3, total),
                        self.segment(part * 3, part * 4, total),
                        self.segment(part * 4, part * 5, total),
                        self.segment(part * 5, part * 6, total),
                        self.segment(part * 6, part * 7, total),
                        self.segment(part * 7, part * 8, total),
                        self.segment(part * 8, part * 9, total),
                        self.segment(part * 9, total, total),
                    )?;
                } else {
                    self.segment(0, total, total).await?;
                }
            }
            Probe::Single(response, total, retries) => {
                logging::write(
                    self.log,
                    "environment-download-mode",
                    &format!("单连接下载：大小={total:?} 字节"),
                );
                self.single(response, total, retries).await?;
            }
        }
        check_cancelled(self.cancelled).map_err(Failure::message)?;
        file.sync_all()
            .map_err(|error| format!("保存下载文件失败：{error}"))?;
        drop(file);
        let hash = hash_file(self.destination, self.cancelled)?;
        // 无 Content-Length 的文件完成后已有确定大小，不再阻碍其他文件的百分比。
        self.state.progress(
            self.destination,
            self.received.get(),
            Some(self.received.get()),
        );
        Ok(hash)
    }

    async fn request(&self, range: Option<(u64, u64)>) -> Result<Response, Failure> {
        let mut request = self
            .client
            .get(self.url)
            .header(ACCEPT_ENCODING, "identity");
        if let Some((start, end)) = range {
            request = request.header(RANGE, format!("bytes={start}-{}", end - 1));
        }
        let response = cancellable(request.send(), self.cancelled)
            .await?
            .map_err(network_failure)?;
        let status = response.status();
        if status == StatusCode::REQUEST_TIMEOUT
            || status == StatusCode::TOO_MANY_REQUESTS
            || status.is_server_error()
        {
            return Err(Failure::Retry(format!("服务器暂时不可用（HTTP {status}）")));
        }
        if status != StatusCode::OK && status != StatusCode::PARTIAL_CONTENT {
            return Err(Failure::Fatal(format!(
                "下载服务器拒绝请求（HTTP {status}）"
            )));
        }
        Ok(response)
    }

    async fn probe(&self) -> Result<Probe, String> {
        let mut retries = 0;
        loop {
            let result = async {
                let mut response = self.request(Some((0, 1))).await?;
                ensure_identity(&response)?;
                if response.status() == StatusCode::OK {
                    let total = self.single_total(&response, self.expected_size)?;
                    return Ok(Probe::Single(response, total, retries));
                }
                let total = content_range(&response)?.total;
                validate_size(Some(total), self.expected_size)?;
                validate_range(&response, 0, 1, total)?;
                let mut received = 0;
                while let Some(chunk) = cancellable(response.chunk(), self.cancelled)
                    .await?
                    .map_err(network_failure)?
                {
                    received += chunk.len() as u64;
                    if received > 1 {
                        return Err(Failure::Fatal("Range 探测响应超过请求范围".into()));
                    }
                }
                if received != 1 {
                    return Err(Failure::Retry("Range 探测响应提前结束".into()));
                }
                Ok(Probe::Range(total))
            }
            .await;
            match result {
                Ok(probe) => return Ok(probe),
                Err(error) => self.retry(error, &mut retries, 0).await?,
            }
        }
    }

    async fn segment(&self, start: u64, end: u64, total: u64) -> Result<(), String> {
        // 每个分段独立打开文件，避免 Windows 文件句柄共享 seek 游标。
        let mut file = OpenOptions::new()
            .write(true)
            .open(self.destination)
            .map_err(|error| format!("打开下载分段失败：{error}"))?;
        file.seek(SeekFrom::Start(start))
            .map_err(|error| format!("定位下载分段失败：{error}"))?;
        let mut offset = start;
        let mut retries = 0;
        loop {
            let result = async {
                let mut response = self.request(Some((offset, end))).await?;
                validate_range(&response, offset, end, total)?;
                self.stream(
                    &mut response,
                    &mut file,
                    &mut offset,
                    Some(end),
                    Some(total),
                )
                .await
            }
            .await;
            match result {
                Ok(()) => return Ok(()),
                // 字节已全部写入但响应未正常结束时，没有可续传的剩余范围。
                Err(Failure::Retry(reason)) if offset == end => {
                    return Err(format!("分段响应未正常结束：{reason}"));
                }
                Err(error) => self.retry(error, &mut retries, offset).await?,
            }
        }
    }

    async fn single(
        &self,
        response: Response,
        mut total: Option<u64>,
        mut retries: usize,
    ) -> Result<(), String> {
        let mut initial = Some(response);
        loop {
            let result = async {
                let mut response = match initial.take() {
                    Some(response) => response,
                    None => self.request(None).await?,
                };
                total = self.single_total(&response, total)?;
                let mut file = File::create(self.destination)
                    .map_err(|error| Failure::Fatal(format!("重置下载文件失败：{error}")))?;
                self.received.set(0);
                self.state.progress(self.destination, 0, total);
                let mut offset = 0;
                self.stream(&mut response, &mut file, &mut offset, total, total)
                    .await
            }
            .await;
            match result {
                Ok(()) => return Ok(()),
                Err(error) => {
                    self.retry(error, &mut retries, 0).await?;
                }
            }
        }
    }

    fn single_total(
        &self,
        response: &Response,
        known: Option<u64>,
    ) -> Result<Option<u64>, Failure> {
        if response.status() != StatusCode::OK || response.headers().contains_key(CONTENT_RANGE) {
            return Err(Failure::Fatal("服务器未返回完整文件响应".into()));
        }
        ensure_identity(response)?;
        let length = content_length(response)?;
        validate_size(length, self.expected_size)?;
        if let (Some(length), Some(known)) = (length, known) {
            if length != known {
                return Err(Failure::Fatal("下载服务器返回的文件大小发生变化".into()));
            }
        }
        Ok(length.or(known).or(self.expected_size))
    }

    async fn stream(
        &self,
        response: &mut Response,
        file: &mut File,
        offset: &mut u64,
        end: Option<u64>,
        total: Option<u64>,
    ) -> Result<(), Failure> {
        while let Some(chunk) = cancellable(response.chunk(), self.cancelled)
            .await?
            .map_err(network_failure)?
        {
            check_cancelled(self.cancelled)?;
            let next = *offset + chunk.len() as u64;
            if next > MAX_SIZE || end.is_some_and(|end| next > end) {
                return Err(Failure::Fatal(
                    "下载数据超过预期大小或请求范围（最大 256 MiB）".into(),
                ));
            }
            file.write_all(&chunk)
                .map_err(|error| Failure::Fatal(format!("写入下载文件失败：{error}")))?;
            *offset = next;
            self.received.set(self.received.get() + chunk.len() as u64);
            self.state
                .progress(self.destination, self.received.get(), total);
        }
        if end.is_some_and(|end| *offset != end) {
            return Err(Failure::Retry("下载响应提前结束，文件尚未完整".into()));
        }
        Ok(())
    }

    async fn retry(&self, error: Failure, retries: &mut usize, offset: u64) -> Result<(), String> {
        let reason = match error {
            Failure::Fatal(reason) => return Err(reason),
            Failure::Retry(reason) => reason,
        };
        let Some(delay) = RETRY_DELAYS.get(*retries) else {
            return Err(format!("下载重试次数已用尽：{reason}"));
        };
        *retries += 1;
        logging::write(
            self.log,
            "environment-download-retry",
            &format!(
                "下载重试：次数={}，偏移={offset}，等待={delay} 秒，原因={reason}",
                *retries
            ),
        );
        cancellable(
            tokio::time::sleep(Duration::from_secs(*delay)),
            self.cancelled,
        )
        .await
        .map_err(Failure::message)
    }
}

enum Probe {
    Range(u64),
    Single(Response, Option<u64>, usize),
}

#[derive(Debug)]
enum Failure {
    Fatal(String),
    Retry(String),
}

impl Failure {
    fn message(self) -> String {
        match self {
            Self::Fatal(message) | Self::Retry(message) => message,
        }
    }
}

fn network_failure(error: reqwest::Error) -> Failure {
    // 响应头到达前断连属于 Request；chunk 读取错误也可能属于 Decode，均非内容解析错误。
    let retryable = error.is_connect()
        || error.is_request()
        || error.is_timeout()
        || error.is_body()
        || error.is_decode();
    let message = format!("下载网络请求失败：{error}");
    if retryable {
        Failure::Retry(message)
    } else {
        Failure::Fatal(message)
    }
}

fn check_cancelled(cancelled: &dyn Fn() -> bool) -> Result<(), Failure> {
    if cancelled() {
        Err(Failure::Fatal("操作已取消".into()))
    } else {
        Ok(())
    }
}

async fn cancellable<T>(
    future: impl Future<Output = T>,
    cancelled: &dyn Fn() -> bool,
) -> Result<T, Failure> {
    check_cancelled(cancelled)?;
    tokio::select! {
        biased;
        _ = wait_cancelled(cancelled) => Err(Failure::Fatal("操作已取消".into())),
        result = future => Ok(result),
    }
}

async fn wait_cancelled(cancelled: &dyn Fn() -> bool) {
    while !cancelled() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn validate_size(actual: Option<u64>, expected: Option<u64>) -> Result<(), Failure> {
    if actual.is_some_and(|size| size > MAX_SIZE) || expected.is_some_and(|size| size > MAX_SIZE) {
        return Err(Failure::Fatal("下载文件超过 256 MiB 上限".into()));
    }
    if let (Some(actual), Some(expected)) = (actual, expected) {
        if actual != expected {
            return Err(Failure::Fatal(
                "官方下载文件大小与已验证版本不一致，已停止安装".into(),
            ));
        }
    }
    Ok(())
}

fn ensure_identity(response: &Response) -> Result<(), Failure> {
    for encoding in response.headers().get_all(CONTENT_ENCODING) {
        if !encoding
            .to_str()
            .is_ok_and(|value| value.trim().eq_ignore_ascii_case("identity"))
        {
            return Err(Failure::Fatal("下载服务器返回了不支持的内容编码".into()));
        }
    }
    Ok(())
}

fn content_length(response: &Response) -> Result<Option<u64>, Failure> {
    response
        .headers()
        .get(CONTENT_LENGTH)
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(parse_number)
                .ok_or_else(|| Failure::Fatal("下载服务器返回了无效的 Content-Length".into()))
        })
        .transpose()
}

#[derive(Debug, PartialEq, Eq)]
struct ContentRange {
    start: u64,
    end_inclusive: u64,
    total: u64,
}

fn parse_number(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn parse_content_range(value: &str) -> Result<ContentRange, Failure> {
    let parsed = (|| {
        let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
        let (start, end) = range.split_once('-')?;
        let range = ContentRange {
            start: parse_number(start)?,
            end_inclusive: parse_number(end)?,
            total: parse_number(total)?,
        };
        (range.start <= range.end_inclusive && range.end_inclusive < range.total).then_some(range)
    })();
    parsed.ok_or_else(|| Failure::Fatal("下载服务器返回了无效的 Content-Range".into()))
}

fn content_range(response: &Response) -> Result<ContentRange, Failure> {
    let mut values = response.headers().get_all(CONTENT_RANGE).iter();
    let value = values
        .next()
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| Failure::Fatal("下载服务器缺少有效的 Content-Range".into()))?;
    if values.next().is_some() {
        return Err(Failure::Fatal(
            "下载服务器返回了重复的 Content-Range".into(),
        ));
    }
    parse_content_range(value)
}

fn validate_range(response: &Response, start: u64, end: u64, total: u64) -> Result<(), Failure> {
    if response.status() != StatusCode::PARTIAL_CONTENT {
        return Err(Failure::Fatal("下载服务器未返回分段响应".into()));
    }
    ensure_identity(response)?;
    let range = content_range(response)?;
    if range.start != start || range.end_inclusive != end - 1 || range.total != total {
        return Err(Failure::Fatal("下载服务器返回的分段范围不匹配".into()));
    }
    if content_length(response)?.is_some_and(|length| length != end - start) {
        return Err(Failure::Fatal("下载服务器返回的分段长度不匹配".into()));
    }
    Ok(())
}

fn hash_file(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("读取下载文件失败：{error}"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        check_cancelled(cancelled).map_err(Failure::message)?;
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("计算下载文件 SHA256 失败：{error}"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    check_cancelled(cancelled).map_err(Failure::message)?;
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
#[path = "l4-environment-download-tests.rs"]
mod tests;
