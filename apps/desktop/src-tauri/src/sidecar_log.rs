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
        let required = prefix.len().saturating_add(bytes.len()) as u64;
        let current = fs::metadata(&self.path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if current.saturating_add(required) > self.max_bytes {
            self.rotate()?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(prefix.as_bytes())?;
        file.write_all(bytes)?;
        if !bytes.ends_with(b"\n") {
            file.write_all(b"\n")?;
        }
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
