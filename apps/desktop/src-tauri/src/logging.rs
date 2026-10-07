use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

const FILE_LIMIT: u64 = 10 * 1024 * 1024;
const BACKUPS: usize = 4;
const CHUNK_LIMIT: usize = 16 * 1024;
static WRITER: OnceLock<Mutex<()>> = OnceLock::new();
static REPORTED_ERROR: AtomicBool = AtomicBool::new(false);

pub fn write(path: &Path, stage: &str, detail: &str) {
    let prefix = format!("[{}] [{}] ", chrono::Utc::now().to_rfc3339(), label(stage));
    append_chunks(path, prefix.as_bytes(), detail.as_bytes());
}

pub fn write_output(path: &Path, context: &str, stream: &str, chunk: &[u8]) {
    if chunk.is_empty() {
        return;
    }
    let prefix = format!(
        "[{}] [{}] [{}] ",
        chrono::Utc::now().to_rfc3339(),
        label(context),
        label(stream)
    );
    append_chunks(path, prefix.as_bytes(), chunk);
}

fn label(value: &str) -> String {
    value
        .chars()
        .take(32768)
        .map(|character| match character {
            '\n' | '\r' => ' ',
            _ => character,
        })
        .collect()
}

fn append_chunks(path: &Path, prefix: &[u8], bytes: &[u8]) {
    let _guard = WRITER
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let text = std::str::from_utf8(bytes).ok();
    let mut offset = 0;
    loop {
        let mut end = (offset + CHUNK_LIMIT).min(bytes.len());
        if let Some(text) = text {
            while !text.is_char_boundary(end) {
                end -= 1;
            }
        }
        let part = &bytes[offset..end];
        if let Err(error) = append(path, prefix, part) {
            if !REPORTED_ERROR.swap(true, Ordering::Relaxed) {
                eprintln!("桌面日志写入失败（{}）：{error}", path.display());
            }
            return;
        }
        if end == bytes.len() {
            break;
        }
        offset = end;
    }
}

fn append(path: &Path, prefix: &[u8], part: &[u8]) -> io::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    let length = match fs::metadata(path) {
        Ok(value) => value.len(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error),
    };
    if length + (prefix.len() + part.len() + 1) as u64 > FILE_LIMIT {
        rotate(path)?;
    }
    let mut file = OpenOptions::new().append(true).create(true).open(path)?;
    file.write_all(prefix)?;
    file.write_all(part)?;
    file.write_all(b"\n")
}

fn rotate(path: &Path) -> io::Result<()> {
    let Some(name) = path.file_name() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "日志文件名无效",
        ));
    };
    let backup = |number| path.with_file_name(format!("{}.{}", name.to_string_lossy(), number));
    if backup(BACKUPS).exists() {
        fs::remove_file(backup(BACKUPS))?;
    }
    for index in (1..BACKUPS).rev() {
        if backup(index).exists() {
            fs::rename(backup(index), backup(index + 1))?;
        }
    }
    if path.exists() {
        fs::rename(path, backup(1))?;
    }
    for index in 1..=BACKUPS {
        let file = backup(index);
        if fs::metadata(&file)
            .map(|metadata| metadata.len() > FILE_LIMIT)
            .unwrap_or(false)
        {
            // 旧版本可能留下无限增长的日志；升级后只保留其有界尾部。
            let mut source = OpenOptions::new().read(true).write(true).open(&file)?;
            source.seek(SeekFrom::End(-(FILE_LIMIT as i64)))?;
            let mut tail = Vec::with_capacity(FILE_LIMIT as usize);
            source.read_to_end(&mut tail)?;
            source.seek(SeekFrom::Start(0))?;
            source.write_all(&tail)?;
            source.set_len(tail.len() as u64)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{write, BACKUPS, FILE_LIMIT};
    use std::fs::{self, OpenOptions};
    use std::io::{Seek, SeekFrom, Write};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-react/react-lifecycle-tests")
            .join(format!("log-rotation-{}-{suffix}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn write_oversized(path: &Path, tail: &str) {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .open(path)
            .unwrap();
        file.set_len(FILE_LIMIT + 64).unwrap();
        file.seek(SeekFrom::End(-(tail.len() as i64))).unwrap();
        file.write_all(tail.as_bytes()).unwrap();
    }

    #[test]
    fn rotation_bounds_both_log_groups_and_migrates_oversized_backups() {
        let directory = test_directory();
        for name in ["desktop.log", "server.log"] {
            let path = directory.join(name);
            let active_tail = format!("{name}-active-old-tail-marker");
            write_oversized(&path, &active_tail);
            for index in 1..=BACKUPS {
                write_oversized(
                    &path.with_file_name(format!("{name}.{index}")),
                    &format!("{name}-backup-{index}-old-tail-marker"),
                );
            }

            write(&path, "rotation-test", "new entry");

            let mut total = fs::metadata(&path).unwrap().len();
            for index in 1..=BACKUPS {
                let backup = path.with_file_name(format!("{name}.{index}"));
                let size = fs::metadata(&backup).unwrap().len();
                assert!(size <= FILE_LIMIT);
                total += size;
            }
            assert!(total <= FILE_LIMIT * (BACKUPS as u64 + 1));
            assert!(fs::read_to_string(path.with_file_name(format!("{name}.1")))
                .unwrap()
                .contains(&active_tail));
            assert!(fs::read_to_string(path.with_file_name(format!("{name}.3")))
                .unwrap()
                .contains(&format!("{name}-backup-2-old-tail-marker")));
        }

        fs::remove_dir_all(directory).unwrap();
    }
}
