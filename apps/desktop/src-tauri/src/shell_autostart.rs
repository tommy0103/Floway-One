//! Owns the desktop login-item registration. macOS loads per-user
//! LaunchAgents from `~/Library/LaunchAgents` at login, and `launchctl
//! bootstrap` makes a registration effective immediately so its acceptance is
//! observable instead of assumed.
//! https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
//! https://keith.github.io/xcode-man-pages/launchd.plist.5.html
//! https://keith.github.io/xcode-man-pages/launchctl.1.html

use std::error::Error;
use std::ffi::OsString;
use std::fmt::{Display, Formatter};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug)]
pub struct LaunchctlFailure {
    args: Vec<OsString>,
    status: String,
    stderr: String,
}

impl LaunchctlFailure {
    fn is_not_loaded(&self) -> bool {
        // `launchctl bootout` on an unloaded service reports
        // "Boot-out failed: 3: No such process".
        // https://keith.github.io/xcode-man-pages/launchctl.1.html
        self.stderr.contains("No such process")
    }

    pub(crate) fn for_test(args: &[OsString], status: &str, stderr: &str) -> Self {
        Self {
            args: args.to_vec(),
            status: status.to_owned(),
            stderr: stderr.to_owned(),
        }
    }
}

impl Display for LaunchctlFailure {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        let args = self
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        write!(
            formatter,
            "launchctl {args} exited with {}: {}",
            self.status,
            self.stderr.trim()
        )
    }
}

impl Error for LaunchctlFailure {}

#[derive(Debug)]
pub struct ShellAutostartError {
    message: &'static str,
    source: Box<dyn Error>,
}

impl Display for ShellAutostartError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for ShellAutostartError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.source.as_ref())
    }
}

impl ShellAutostartError {
    fn wrap(message: &'static str) -> impl FnOnce(io::Error) -> Self {
        move |source| Self {
            message,
            source: Box::new(source),
        }
    }

    fn launchctl(message: &'static str, source: LaunchctlFailure) -> Self {
        Self {
            message,
            source: Box::new(source),
        }
    }
}

fn run_launchctl(args: &[OsString]) -> Result<(), LaunchctlFailure> {
    let output = Command::new("/usr/bin/launchctl")
        .args(args)
        .output()
        .map_err(|source| LaunchctlFailure {
            args: args.to_vec(),
            status: "a spawn failure".to_owned(),
            stderr: source.to_string(),
        })?;
    if output.status.success() {
        return Ok(());
    }
    Err(LaunchctlFailure {
        args: args.to_vec(),
        status: output.status.to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn escape_plist_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn render_plist(label: &str, program_arguments: &[OsString]) -> String {
    let arguments = program_arguments
        .iter()
        .map(|argument| {
            format!(
                "    <string>{}</string>\n",
                escape_plist_text(&argument.to_string_lossy())
            )
        })
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>{}</string>\n  <key>ProgramArguments</key>\n  <array>\n{arguments}  </array>\n  <key>RunAtLoad</key>\n  <true/>\n</dict>\n</plist>\n",
        escape_plist_text(label)
    )
}

pub struct ShellAutostart {
    label: String,
    launch_agents_dir: PathBuf,
    launchctl_domain: String,
    program_arguments: Vec<OsString>,
}

impl ShellAutostart {
    pub fn new(
        label: String,
        launch_agents_dir: PathBuf,
        launchctl_domain: String,
        program_arguments: Vec<OsString>,
    ) -> Self {
        Self {
            label,
            launch_agents_dir,
            launchctl_domain,
            program_arguments,
        }
    }

    pub fn plist_path(&self) -> PathBuf {
        self.launch_agents_dir.join(format!("{}.plist", self.label))
    }

    pub fn is_enabled(&self) -> bool {
        self.plist_path().is_file()
    }

    pub fn enable(&self) -> Result<(), ShellAutostartError> {
        self.enable_with(run_launchctl)
    }

    pub fn disable(&self) -> Result<(), ShellAutostartError> {
        self.disable_with(run_launchctl)
    }

    fn bootout_target(&self) -> OsString {
        OsString::from(format!("{}/{}", self.launchctl_domain, self.label))
    }

    fn bootout(
        &self,
        run: &dyn Fn(&[OsString]) -> Result<(), LaunchctlFailure>,
    ) -> Result<(), ShellAutostartError> {
        match run(&[OsString::from("bootout"), self.bootout_target()]) {
            Ok(()) => Ok(()),
            Err(failure) if failure.is_not_loaded() => Ok(()),
            Err(failure) => Err(ShellAutostartError::launchctl(
                "Floway could not unload its previous login item",
                failure,
            )),
        }
    }

    pub(crate) fn enable_with(
        &self,
        run: impl Fn(&[OsString]) -> Result<(), LaunchctlFailure>,
    ) -> Result<(), ShellAutostartError> {
        fs::create_dir_all(&self.launch_agents_dir).map_err(ShellAutostartError::wrap(
            "Floway could not create its login item directory",
        ))?;
        let plist_path = self.plist_path();
        let staging_path = self
            .launch_agents_dir
            .join(format!(".{}.plist.tmp", self.label));
        fs::write(
            &staging_path,
            render_plist(&self.label, &self.program_arguments),
        )
        .and_then(|()| fs::rename(&staging_path, &plist_path))
        .map_err(ShellAutostartError::wrap(
            "Floway could not write its login item",
        ))?;
        self.bootout(&run)?;
        if let Err(failure) = run(&[
            OsString::from("bootstrap"),
            OsString::from(&self.launchctl_domain),
            plist_path.as_os_str().to_owned(),
        ]) {
            let removal = fs::remove_file(&plist_path);
            let error =
                ShellAutostartError::launchctl("Floway could not register its login item", failure);
            return match removal {
                Ok(()) => Err(error),
                Err(source) => Err(ShellAutostartError {
                    message: "Floway could not register its login item or roll back its registration file",
                    source: Box::new(io::Error::new(
                        source.kind(),
                        format!("{error}; rollback failed: {source}"),
                    )),
                }),
            };
        }
        Ok(())
    }

    pub(crate) fn disable_with(
        &self,
        run: impl Fn(&[OsString]) -> Result<(), LaunchctlFailure>,
    ) -> Result<(), ShellAutostartError> {
        let bootout = self.bootout(&run);
        match fs::remove_file(self.plist_path()) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(ShellAutostartError::wrap(
                    "Floway could not remove its login item",
                )(source));
            }
        }
        bootout
    }
}

pub fn login_item_program_arguments(executable: &Path, data_root: &Path) -> Vec<OsString> {
    vec![
        executable.as_os_str().to_owned(),
        OsString::from("--data-dir"),
        data_root.as_os_str().to_owned(),
    ]
}

pub fn launch_agents_dir(home: &Path) -> PathBuf {
    home.join("Library").join("LaunchAgents")
}

pub fn launchctl_domain(uid: u32) -> String {
    format!("gui/{uid}")
}
