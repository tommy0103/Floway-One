use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const DEFAULT_MAX_BYTES: u64 = 1024 * 1024;
const DEFAULT_RETAINED_FILES: usize = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SidecarStream {
    Stderr,
    Stdout,
}

impl SidecarStream {
    fn label(self) -> &'static str {
        match self {
            Self::Stderr => "stderr",
            Self::Stdout => "stdout",
        }
    }
}

pub struct BoundedSidecarLog {
    path: PathBuf,
    max_bytes: u64,
    retained_files: usize,
}

impl BoundedSidecarLog {
    pub fn open(logs_dir: &Path) -> io::Result<Self> {
        Self::with_limits(logs_dir, DEFAULT_MAX_BYTES, DEFAULT_RETAINED_FILES)
    }

    fn with_limits(logs_dir: &Path, max_bytes: u64, retained_files: usize) -> io::Result<Self> {
        fs::create_dir_all(logs_dir)?;
        Ok(Self {
            path: logs_dir.join("floway.sidecar.log"),
            max_bytes,
            retained_files,
        })
    }

    pub fn append(&mut self, stream: SidecarStream, bytes: &[u8]) -> io::Result<()> {
        let prefix = format!("[{}] ", stream.label());
        let mut record =
            Vec::with_capacity(prefix.len().saturating_add(bytes.len()).saturating_add(1));
        record.extend_from_slice(prefix.as_bytes());
        let text = String::from_utf8_lossy(bytes);
        let newline_bytes = usize::from(!text.ends_with('\n'));
        let maximum_record_bytes = usize::try_from(self.max_bytes).unwrap_or(usize::MAX);
        let available = maximum_record_bytes
            .saturating_sub(record.len())
            .saturating_sub(newline_bytes);
        let mut boundary = text.len().min(available);
        while !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        record.extend_from_slice(text[..boundary].as_bytes());
        if newline_bytes == 1 && record.len() < maximum_record_bytes {
            record.push(b'\n');
        }
        record.truncate(maximum_record_bytes);

        let required = record.len() as u64;
        let current = fs::metadata(&self.path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if current > 0 && current.saturating_add(required) > self.max_bytes {
            self.rotate()?;
        }
        if record.is_empty() {
            return Ok(());
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(&record)?;
        file.flush()
    }

    fn rotate(&self) -> io::Result<()> {
        if self.retained_files == 0 {
            if self.path.exists() {
                fs::remove_file(&self.path)?;
            }
            return Ok(());
        }
        let oldest = self.rotated_path(self.retained_files);
        if oldest.exists() {
            fs::remove_file(oldest)?;
        }
        for index in (1..self.retained_files).rev() {
            let source = self.rotated_path(index);
            if source.exists() {
                fs::rename(source, self.rotated_path(index + 1))?;
            }
        }
        if self.path.exists() {
            fs::rename(&self.path, self.rotated_path(1))?;
        }
        Ok(())
    }

    fn rotated_path(&self, index: usize) -> PathBuf {
        self.path.with_extension(format!("log.{index}"))
    }
}

#[cfg(test)]
impl BoundedSidecarLog {
    pub(crate) fn open_for_test(
        logs_dir: &Path,
        max_bytes: u64,
        retained_files: usize,
    ) -> io::Result<Self> {
        Self::with_limits(logs_dir, max_bytes, retained_files)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}
