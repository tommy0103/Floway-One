use std::ffi::OsString;
use std::io;
use std::path::PathBuf;

#[derive(Debug, Eq, PartialEq)]
pub struct DesktopPaths {
    root: PathBuf,
}

impl DesktopPaths {
    pub fn from_args(
        platform_data_dir: PathBuf,
        args: impl IntoIterator<Item = OsString>,
    ) -> io::Result<Self> {
        let mut args = args.into_iter().skip(1);
        let mut configured_root = None;
        while let Some(argument) = args.next() {
            if argument != "--data-dir" {
                continue;
            }
            if configured_root.is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Floway desktop accepts --data-dir only once",
                ));
            }
            let root = args.next().map(PathBuf::from).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Floway desktop --data-dir requires an absolute path",
                )
            })?;
            if !root.is_absolute() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Floway desktop --data-dir requires an absolute path",
                ));
            }
            configured_root = Some(root);
        }
        Ok(Self {
            root: configured_root.unwrap_or_else(|| platform_data_dir.join("Floway One")),
        })
    }

    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }
}
