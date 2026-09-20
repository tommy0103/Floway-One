//! Owns signed-update staging, the controlled install sequence, and update state.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::bundle_contract::{RuntimeBundle, resolve_runtime_bundle};
use crate::print_error_chain;
use crate::runtime_status::FailureReport;
use crate::update_channel::{
    UPDATE_CHANNEL_FILE_NAME, UPDATE_DIRECTORY_NAME, UPDATE_ENDPOINTS_ENV, UPDATE_PUBKEY_ENV,
    UPDATE_RECOVERY_POINT_FILE_NAME, UpdateChannel, UpdaterAuthority, load_update_channel,
    previous_release_page_url, resolve_updater_authority,
};
use crate::update_signature::verify_staged_artifact;
use crate::update_state::{
    DesktopUpdateState, MarkHealthyOutcome, StagedUpdate, UPDATE_STATE_FILE_NAME, UpdateFailure,
    UpdateFailurePhase,
};
use crate::{DESKTOP_RUNTIME_CONTRACT_ENV, NODE_SIDECAR_NAME};

pub const DESKTOP_UPDATE_EVENT_PREFIX: &str = "FLOWAY_DESKTOP_UPDATE ";
pub const INSTALL_STAGED_UPDATE_ARGUMENT: &str = "--install-staged-update";
// These strings mirror UPDATE_RECOVERY_POINT_EVENT_PREFIX,
// CREATE_UPDATE_RECOVERY_POINT_ARGUMENT, and DESKTOP_DATA_ROOT_ENV in
// apps/platform-node/src/update-recovery-point.ts and run-node-entry.ts.
const SIDECAR_RECOVERY_POINT_EVENT_PREFIX: &str = "FLOWAY_UPDATE_RECOVERY_POINT ";
const SIDECAR_RECOVERY_POINT_ARGUMENT: &str = "--create-update-recovery-point";
const DESKTOP_DATA_ROOT_ENV: &str = "FLOWAY_DESKTOP_DATA_DIR";

const MAXIMUM_UPDATE_EVENT_BYTES: usize = 4 * 1024;
const MAXIMUM_CHILD_OUTPUT_BYTES: usize = 64 * 1024;
const RECOVERY_POINT_TIMEOUT: Duration = Duration::from_secs(180);
const UPDATE_MANIFEST_TIMEOUT: Duration = Duration::from_secs(120);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

#[derive(Debug)]
pub struct UpdatePhaseError {
    message: &'static str,
    phase: UpdateFailurePhase,
    source: Box<dyn Error + 'static>,
    version: Option<String>,
}

impl UpdatePhaseError {
    fn new(
        phase: UpdateFailurePhase,
        message: &'static str,
        source: impl Into<Box<dyn Error + 'static>>,
        version: Option<String>,
    ) -> Self {
        Self {
            message,
            phase,
            source: source.into(),
            version,
        }
    }

    pub fn report(&self) -> (UpdateFailurePhase, Vec<String>, Option<String>) {
        let mut chain = vec![self.to_string()];
        let mut source = self.source();
        while let Some(cause) = source {
            chain.push(cause.to_string());
            source = cause.source();
        }
        (self.phase, chain, self.version.clone())
    }
}

impl Display for UpdatePhaseError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for UpdatePhaseError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.source.as_ref())
    }
}

#[derive(Clone, Debug)]
struct UpdatePaths {
    channel_file: PathBuf,
    directory: PathBuf,
    recovery_point: PathBuf,
    state_file: PathBuf,
}

impl UpdatePaths {
    fn new(data_root: &Path) -> Self {
        let directory = data_root.join(UPDATE_DIRECTORY_NAME);
        Self {
            channel_file: data_root.join(UPDATE_CHANNEL_FILE_NAME),
            recovery_point: directory.join(UPDATE_RECOVERY_POINT_FILE_NAME),
            directory,
            state_file: data_root.join(UPDATE_STATE_FILE_NAME),
        }
    }

    fn staged_artifact(&self, staged: &StagedUpdate) -> PathBuf {
        self.directory.join(&staged.artifact_file)
    }
}

pub struct DesktopUpdateController {
    app_root: Option<PathBuf>,
    data_root: Option<PathBuf>,
    installing: Mutex<bool>,
    paths: Option<UpdatePaths>,
    state: Mutex<DesktopUpdateState>,
}

fn packaged_app_root() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    executable
        .ancestors()
        .find(|ancestor| {
            ancestor
                .extension()
                .is_some_and(|extension| extension == "app")
        })
        .map(Path::to_path_buf)
}

fn load_or_quarantine_state(paths: &UpdatePaths) -> DesktopUpdateState {
    match DesktopUpdateState::load(&paths.state_file) {
        Ok(state) => state,
        Err(error) => {
            let quarantined = paths
                .state_file
                .with_extension(format!("corrupt-{}", unix_time()));
            if let Err(rename_error) = fs::rename(&paths.state_file, &quarantined) {
                print_error_chain(&rename_error);
            }
            eprintln!(
                "Floway update state was quarantined at {} after a load failure",
                quarantined.display()
            );
            print_error_chain(&error);
            DesktopUpdateState::default()
        }
    }
}

fn emit_update_diagnostic(value: &Value) {
    match serde_json::to_string(value) {
        Ok(encoded) if encoded.len() <= MAXIMUM_UPDATE_EVENT_BYTES => {
            eprintln!("{DESKTOP_UPDATE_EVENT_PREFIX}{encoded}");
        }
        Ok(_) => print_error_chain(&io::Error::new(
            io::ErrorKind::InvalidData,
            "Floway update diagnostic exceeded its byte bound",
        )),
        Err(error) => print_error_chain(&error),
    }
}

impl DesktopUpdateController {
    pub fn new(data_root: Option<PathBuf>) -> Arc<Self> {
        let paths = data_root
            .as_ref()
            .filter(|root| !root.as_os_str().is_empty())
            .map(|root| UpdatePaths::new(root));
        let state = paths
            .as_ref()
            .map_or_else(DesktopUpdateState::default, load_or_quarantine_state);
        Arc::new(Self {
            app_root: packaged_app_root(),
            data_root,
            installing: Mutex::new(false),
            paths,
            state: Mutex::new(state),
        })
    }

    fn state(&self) -> DesktopUpdateState {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    // Every read-modify-write-persist cycle runs under this one mutex, so
    // concurrent savers can neither interleave records nor race the shared
    // pid-named temporary file behind the state's atomic-replace contract.
    fn mutate_state<T>(
        &self,
        mutate: impl FnOnce(&mut DesktopUpdateState) -> T,
    ) -> Result<T, io::Error> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let result = mutate(&mut state);
        if let Some(paths) = &self.paths {
            state.save(&paths.state_file).map_err(io::Error::other)?;
        }
        Ok(result)
    }

    fn channel(&self) -> UpdateChannel {
        let Some(paths) = &self.paths else {
            return UpdateChannel::Stable;
        };
        let (channel, diagnostic) = load_update_channel(&paths.channel_file);
        if let Some(error) = diagnostic {
            print_error_chain(&error);
        }
        channel
    }

    fn record_failure(
        &self,
        phase: UpdateFailurePhase,
        chain: Vec<String>,
        version: Option<String>,
    ) {
        if let Err(error) = self.mutate_state(|state| {
            state.record_failure(UpdateFailure {
                at: unix_time(),
                chain: chain.clone(),
                phase,
                version: version.clone(),
            });
        }) {
            print_error_chain(&error);
        }
        emit_update_diagnostic(&json!({
            "chain": chain,
            "phase": "error",
            "updatePhase": phase.as_str(),
            "version": version,
        }));
    }

    pub fn status_snapshot(&self) -> Value {
        let state = self.state();
        let previous_version = state
            .pending
            .as_ref()
            .map(|pending| pending.previous_version.clone())
            .or_else(|| {
                state
                    .failure
                    .as_ref()
                    .and_then(|_| state.last_healthy_version.clone())
            });
        json!({
            "channel": self.channel().as_str(),
            "failure": state.failure.as_ref().map(|failure| json!({
                "chain": failure.chain,
                "phase": failure.phase.as_str(),
                "version": failure.version,
            })),
            "pendingVersion": state.pending.as_ref().map(|pending| pending.version.clone()),
            "previousDownloadUrl": previous_version.as_ref().map(|version| previous_release_page_url(version)),
            "previousVersion": previous_version,
            "recoveryPointAvailable": self
                .paths
                .as_ref()
                .is_some_and(|paths| paths.recovery_point.is_file()),
            "stagedVersion": state.staged.as_ref().map(|staged| staged.version.clone()),
        })
    }

    pub fn staged_version(&self) -> Option<String> {
        self.state().staged.map(|staged| staged.version)
    }

    pub fn tray_state(&self) -> (Option<String>, bool) {
        let state = self.state();
        (
            state.staged.map(|staged| staged.version),
            state.failure.is_some(),
        )
    }

    fn updater_authority(
        &self,
        app: &AppHandle,
        channel: UpdateChannel,
    ) -> Result<Option<UpdaterAuthority>, Box<dyn Error>> {
        let configured_pubkey = app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|config| config.get("pubkey"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        resolve_updater_authority(
            channel,
            std::env::var(UPDATE_ENDPOINTS_ENV).ok().as_deref(),
            std::env::var(UPDATE_PUBKEY_ENV).ok().as_deref(),
            configured_pubkey.as_deref(),
        )
        .map_err(Into::into)
    }

    fn remove_staged_artifacts(&self, keep: Option<&str>) {
        let Some(paths) = &self.paths else {
            return;
        };
        let Ok(entries) = fs::read_dir(&paths.directory) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let stale = name.to_str().is_some_and(|name| {
                name.starts_with("staged-")
                    && name.ends_with(".bin")
                    && keep.is_none_or(|keep| name != keep)
            });
            if stale && let Err(error) = fs::remove_file(entry.path()) {
                print_error_chain(&error);
            }
        }
    }

    pub fn after_runtime_ready(
        self: &Arc<Self>,
        app: &AppHandle,
        on_state_changed: impl Fn() + Send + 'static,
    ) {
        let outcome = self
            .mutate_state(|state| state.mark_healthy(env!("CARGO_PKG_VERSION")))
            .unwrap_or_else(|error| {
                print_error_chain(&error);
                MarkHealthyOutcome::NoPendingUpdate
            });
        match outcome {
            MarkHealthyOutcome::MarkedHealthy => {
                self.remove_staged_artifacts(None);
                emit_update_diagnostic(&json!({
                    "phase": "healthy",
                    "version": env!("CARGO_PKG_VERSION"),
                }));
            }
            MarkHealthyOutcome::PendingVersionMismatch => {
                let version = self.state().pending.map(|pending| pending.version);
                self.record_failure(
                    UpdateFailurePhase::Health,
                    vec![format!(
                        "Floway update expected version {} but {} is running",
                        version.clone().unwrap_or_default(),
                        env!("CARGO_PKG_VERSION")
                    )],
                    version,
                );
            }
            MarkHealthyOutcome::NoPendingUpdate => {}
        }
        self.spawn_background_check(app, on_state_changed);
    }

    pub fn after_runtime_failure(&self, report: &FailureReport) {
        let Some(pending) = self.state().pending else {
            return;
        };
        self.record_failure(
            UpdateFailurePhase::Health,
            report.chain.clone(),
            Some(pending.version),
        );
    }

    pub fn spawn_background_check(
        self: &Arc<Self>,
        app: &AppHandle,
        on_state_changed: impl Fn() + Send + 'static,
    ) {
        // Update staging only exists for the packaged application; development
        // runs of the shell leave every file they run from untouched.
        if self.app_root.is_none() || self.paths.is_none() {
            return;
        }
        if *self
            .installing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
        {
            return;
        }
        let controller = Arc::clone(self);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            controller.check_and_stage(&app).await;
            on_state_changed();
        });
    }

    async fn check_and_stage(&self, app: &AppHandle) {
        if let Err(error) = self.check_and_stage_inner(app).await {
            let (phase, chain, version) = error.report();
            self.record_failure(phase, chain, version);
        }
    }

    async fn check_and_stage_inner(&self, app: &AppHandle) -> Result<(), UpdatePhaseError> {
        let channel = self.channel();
        let Some(authority) = self.updater_authority(app, channel).map_err(|source| {
            UpdatePhaseError::new(
                UpdateFailurePhase::Check,
                "Floway could not resolve its updater authority",
                source,
                None,
            )
        })?
        else {
            // This build carries no updater authority, so it never checks.
            return Ok(());
        };
        emit_update_diagnostic(&json!({
            "channel": channel.as_str(),
            "phase": "check",
        }));
        let updater = app
            .updater_builder()
            .endpoints(authority.endpoints.clone())
            .map_err(|source| {
                UpdatePhaseError::new(
                    UpdateFailurePhase::Check,
                    "Floway could not configure its updater endpoints",
                    source,
                    None,
                )
            })?
            .pubkey(authority.pubkey)
            .timeout(UPDATE_DOWNLOAD_TIMEOUT)
            .build()
            .map_err(|source| {
                UpdatePhaseError::new(
                    UpdateFailurePhase::Check,
                    "Floway could not build its updater",
                    source,
                    None,
                )
            })?;
        let Some(update) = updater.check().await.map_err(|source| {
            UpdatePhaseError::new(
                UpdateFailurePhase::Check,
                "Floway could not check for application updates",
                source,
                None,
            )
        })?
        else {
            emit_update_diagnostic(&json!({
                "channel": channel.as_str(),
                "phase": "no-update",
            }));
            return Ok(());
        };
        let version = update.version.clone();
        let bytes = update
            .download(|_received, _total| {}, || {})
            .await
            .map_err(|source| {
                let phase = match &source {
                    tauri_plugin_updater::Error::Minisign(_)
                    | tauri_plugin_updater::Error::SignatureUtf8(_)
                    | tauri_plugin_updater::Error::SignedVersionMismatch { .. }
                    | tauri_plugin_updater::Error::MissingSignedVersion
                    | tauri_plugin_updater::Error::Base64(_) => UpdateFailurePhase::Signature,
                    _ => UpdateFailurePhase::Download,
                };
                UpdatePhaseError::new(
                    phase,
                    "Floway could not download and authenticate an application update",
                    source,
                    Some(version.clone()),
                )
            })?;
        if *self
            .installing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
        {
            return Ok(());
        }
        self.stage_artifact(&update, bytes)
    }

    fn stage_artifact(
        &self,
        update: &tauri_plugin_updater::Update,
        bytes: Vec<u8>,
    ) -> Result<(), UpdatePhaseError> {
        let version = update.version.clone();
        let artifact_file = format!("staged-{version}.bin");
        let staged = StagedUpdate {
            artifact_bytes: bytes.len() as u64,
            artifact_file: artifact_file.clone(),
            download_url: update.download_url.to_string(),
            notes: update.body.clone(),
            signature: update.signature.clone(),
            staged_at: unix_time(),
            version: version.clone(),
        };
        let persist = (|| -> Result<(), io::Error> {
            let Some(paths) = &self.paths else {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "Floway has no update directory for its staged artifact",
                ));
            };
            fs::create_dir_all(&paths.directory)?;
            let temporary = paths
                .directory
                .join(format!(".{artifact_file}.{}.tmp", std::process::id()));
            fs::write(&temporary, &bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
            }
            fs::rename(&temporary, paths.directory.join(&artifact_file))?;
            Ok(())
        })();
        persist.map_err(|source| {
            UpdatePhaseError::new(
                UpdateFailurePhase::Download,
                "Floway could not stage an authenticated application update",
                source,
                Some(version.clone()),
            )
        })?;
        self.remove_staged_artifacts(Some(&artifact_file));
        self.mutate_state(|state| state.record_staged(staged))
            .map_err(|source| {
                UpdatePhaseError::new(
                    UpdateFailurePhase::Download,
                    "Floway could not record its staged application update",
                    source,
                    Some(version.clone()),
                )
            })?;
        emit_update_diagnostic(&json!({
            "phase": "staged",
            "version": version,
        }));
        Ok(())
    }

    fn claim_install(&self) -> Option<StagedUpdate> {
        let mut installing = self
            .installing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *installing {
            return None;
        }
        let staged = self.state().staged?;
        *installing = true;
        Some(staged)
    }

    fn release_install(&self) {
        *self
            .installing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
    }

    // The controlled install sequence: after the packaged runtime has stopped,
    // create the device-protected recovery point, re-verify that the published
    // manifest still announces the staged artifact, swap the application
    // bundle, and only then mark the update pending a health check.
    pub fn install_staged_update(
        &self,
        app: &AppHandle,
        bundle: &RuntimeBundle,
    ) -> Result<(), UpdatePhaseError> {
        let Some(staged) = self.claim_install() else {
            return Ok(());
        };
        let result = self.install_staged_update_inner(app, bundle, &staged);
        self.release_install();
        if let Err(error) = &result {
            let (phase, chain, version) = error.report();
            self.record_failure(phase, chain, version);
        }
        result
    }

    fn install_staged_update_inner(
        &self,
        app: &AppHandle,
        bundle: &RuntimeBundle,
        staged: &StagedUpdate,
    ) -> Result<(), UpdatePhaseError> {
        let version = staged.version.clone();
        emit_update_diagnostic(&json!({
            "phase": "installing",
            "version": version,
        }));
        let channel = self.channel();
        let authority = self
            .updater_authority(app, channel)
            .map_err(|source| {
                UpdatePhaseError::new(
                    UpdateFailurePhase::Check,
                    "Floway could not resolve its updater authority",
                    source,
                    Some(version.clone()),
                )
            })?
            .ok_or_else(|| {
                UpdatePhaseError::new(
                    UpdateFailurePhase::Check,
                    "Floway staged an application update without updater authority",
                    io::Error::new(
                        io::ErrorKind::NotFound,
                        "the updater authority that staged this update is no longer configured",
                    ),
                    Some(version.clone()),
                )
            })?;
        let artifact = self
            .paths
            .as_ref()
            .map(|paths| paths.staged_artifact(staged))
            .ok_or_else(|| {
                UpdatePhaseError::new(
                    UpdateFailurePhase::Install,
                    "Floway could not read its staged application update",
                    io::Error::new(
                        io::ErrorKind::NotFound,
                        "Floway has no update directory for its staged artifact",
                    ),
                    Some(version.clone()),
                )
            })?;
        let bytes = fs::read(artifact).map_err(|source| {
            UpdatePhaseError::new(
                UpdateFailurePhase::Install,
                "Floway could not read its staged application update",
                source,
                Some(version.clone()),
            )
        })?;
        // The Tauri updater authenticates artifact bytes inside
        // Update::download but Update::install performs no signature check, so
        // the staged bytes read back from the application data directory are
        // re-authenticated against the manifest signature before the swap.
        // https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.12.0/plugins/updater/src/updater.rs#L680
        // https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.12.0/plugins/updater/src/updater.rs#L757
        verify_staged_artifact(&bytes, &staged.signature, &authority.pubkey).map_err(|source| {
            UpdatePhaseError::new(
                UpdateFailurePhase::Signature,
                "Floway staged application update artifact failed re-authentication",
                source,
                Some(version.clone()),
            )
        })?;
        let recovery_point = self.create_recovery_point(bundle).map_err(|source| {
            UpdatePhaseError::new(
                UpdateFailurePhase::RecoveryPoint,
                "Floway could not create its pre-update database recovery point",
                source,
                Some(version.clone()),
            )
        })?;
        emit_update_diagnostic(&json!({
            "bytes": recovery_point.bytes,
            "path": recovery_point.path,
            "phase": "recovery-point",
            "sha256": recovery_point.sha256,
        }));
        let update =
            tauri::async_runtime::block_on(self.verify_staged_update(app, staged, &authority))?;
        let (pending, consumed) = self
            .mutate_state(|state| state.begin_install(env!("CARGO_PKG_VERSION"), unix_time()))
            .map_err(|source| {
                UpdatePhaseError::new(
                    UpdateFailurePhase::Install,
                    "Floway could not record its pending application update",
                    source,
                    Some(version.clone()),
                )
            })?
            .map_err(|source| {
                UpdatePhaseError::new(
                    UpdateFailurePhase::Install,
                    "Floway lost its staged update before installation",
                    source,
                    Some(version.clone()),
                )
            })?;
        if let Err(source) = update.install(&bytes) {
            // If the bundle survived the failed swap, restore the staged state
            // so a later attempt can retry; otherwise keep the pending record
            // as the operator's recovery evidence and stop here.
            if self.app_root.as_ref().is_some_and(|root| root.exists())
                && let Err(error) = self.mutate_state(|state| {
                    state.pending = None;
                    state.staged = Some(consumed);
                })
            {
                print_error_chain(&error);
            }
            return Err(UpdatePhaseError::new(
                UpdateFailurePhase::Install,
                "Floway could not install its staged application update",
                source,
                Some(version),
            ));
        }
        emit_update_diagnostic(&json!({
            "phase": "installed",
            "previousVersion": pending.previous_version,
            "version": pending.version,
        }));
        Ok(())
    }

    async fn verify_staged_update(
        &self,
        app: &AppHandle,
        staged: &StagedUpdate,
        authority: &UpdaterAuthority,
    ) -> Result<tauri_plugin_updater::Update, UpdatePhaseError> {
        let version = staged.version.clone();
        let updater = app
            .updater_builder()
            .endpoints(authority.endpoints.clone())
            .map_err(|source| {
                UpdatePhaseError::new(
                    UpdateFailurePhase::Check,
                    "Floway could not configure its updater endpoints",
                    source,
                    Some(version.clone()),
                )
            })?
            .pubkey(authority.pubkey.clone())
            .timeout(UPDATE_MANIFEST_TIMEOUT)
            .build()
            .map_err(|source| {
                UpdatePhaseError::new(
                    UpdateFailurePhase::Check,
                    "Floway could not build its updater",
                    source,
                    Some(version.clone()),
                )
            })?;
        let update = updater.check().await.map_err(|source| {
            UpdatePhaseError::new(
                UpdateFailurePhase::Check,
                "Floway could not re-verify its staged application update",
                source,
                Some(version.clone()),
            )
        })?;
        let Some(update) = update else {
            return Err(UpdatePhaseError::new(
                UpdateFailurePhase::Check,
                "Floway staged application update is no longer published",
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("the update endpoint announces no update for version {version}"),
                ),
                Some(version),
            ));
        };
        if update.version != staged.version || update.signature != staged.signature {
            return Err(UpdatePhaseError::new(
                UpdateFailurePhase::Signature,
                "Floway staged application update no longer matches the published manifest",
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "the published update manifest changed after the update was staged",
                ),
                Some(version),
            ));
        }
        Ok(update)
    }

    fn create_recovery_point(
        &self,
        bundle: &RuntimeBundle,
    ) -> Result<RecoveryPointEvidence, Box<dyn Error>> {
        let (Some(data_root), Some(paths)) = (&self.data_root, &self.paths) else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Floway has no application data root for its recovery point",
            )
            .into());
        };
        let executable = std::env::current_exe()?;
        let node = executable
            .parent()
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "Floway executable has no parent directory",
                )
            })?
            .join(NODE_SIDECAR_NAME);
        let mut child = Command::new(node)
            .arg(&bundle.entry)
            .arg("--profile=personal")
            .arg(SIDECAR_RECOVERY_POINT_ARGUMENT)
            .current_dir(&bundle.root)
            .env(DESKTOP_RUNTIME_CONTRACT_ENV, &bundle.contract)
            .env(DESKTOP_DATA_ROOT_ENV, data_root)
            .env("FLOWAY_PROFILE", "personal")
            .env("NODE_ENV", "production")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|source| {
                io::Error::new(
                    source.kind(),
                    format!("Floway could not start its recovery point child: {source}"),
                )
            })?;
        // The sidecar lifecycle channel treats stdin EOF as a forced owner
        // termination, so the write half stays open in this shell for the
        // child's whole lifetime — the same contract the process supervisor
        // keeps for the packaged runtime. Dropping it after the child exits
        // mirrors the reap-on-shell-death path.
        let _child_stdin = child.stdin.take();
        let stdout = child.stdout.take().map(|mut pipe| {
            thread::spawn(move || {
                let mut captured = Vec::new();
                let _ = pipe
                    .by_ref()
                    .take(MAXIMUM_CHILD_OUTPUT_BYTES as u64)
                    .read_to_end(&mut captured);
                captured
            })
        });
        let stderr = child.stderr.take().map(|mut pipe| {
            thread::spawn(move || {
                let mut captured = Vec::new();
                let _ = pipe
                    .by_ref()
                    .take(MAXIMUM_CHILD_OUTPUT_BYTES as u64)
                    .read_to_end(&mut captured);
                captured
            })
        });
        let deadline = Instant::now() + RECOVERY_POINT_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!(
                            "Floway recovery point child did not finish within {} seconds",
                            RECOVERY_POINT_TIMEOUT.as_secs()
                        ),
                    )
                    .into());
                }
                Err(source) => return Err(source.into()),
            }
        };
        let stdout = stdout
            .map(|reader| reader.join().unwrap_or_default())
            .unwrap_or_default();
        let stderr = stderr
            .map(|reader| reader.join().unwrap_or_default())
            .unwrap_or_default();
        let stdout = String::from_utf8_lossy(&stdout);
        let stderr = String::from_utf8_lossy(&stderr);
        if !status.success() {
            return Err(io::Error::other(format!(
                "Floway recovery point child exited with {status}: {}",
                stderr.trim()
            ))
            .into());
        }
        let Some(line) = stdout
            .lines()
            .find(|line| line.starts_with(SIDECAR_RECOVERY_POINT_EVENT_PREFIX))
        else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "Floway recovery point child emitted no recovery point evidence: {}",
                    stderr.trim()
                ),
            )
            .into());
        };
        let evidence: Value =
            serde_json::from_str(line.trim_start_matches(SIDECAR_RECOVERY_POINT_EVENT_PREFIX))?;
        let path = evidence
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "the recovery point evidence has no path",
                )
            })?;
        if path != paths.recovery_point.to_string_lossy() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "the recovery point evidence path {path} does not match the owning update directory {}",
                    paths.recovery_point.display()
                ),
            )
            .into());
        }
        Ok(RecoveryPointEvidence {
            bytes: evidence.get("bytes").and_then(Value::as_u64).unwrap_or(0),
            path: path.to_owned(),
            sha256: evidence
                .get("sha256")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
    }
}

struct RecoveryPointEvidence {
    bytes: u64,
    path: String,
    sha256: String,
}

pub fn resolve_install_bundle(app: &AppHandle) -> Result<RuntimeBundle, Box<dyn Error>> {
    let resource_dir = app.path().resource_dir()?;
    resolve_runtime_bundle(&resource_dir).map_err(Into::into)
}
