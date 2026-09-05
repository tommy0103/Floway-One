use std::error::Error;
use std::ffi::OsString;
use std::fmt::{Display, Formatter};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

const DESKTOP_BUNDLE_SCHEMA_VERSION: u64 = 2;
pub(crate) const DESKTOP_COMPATIBILITY_VERSION: u64 = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeCompatibility {
    pub contract_digest: String,
    pub protocol_version: u64,
    pub release_version: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeBundle {
    pub compatibility: RuntimeCompatibility,
    pub contract: PathBuf,
    pub dashboard_assets: Vec<PathBuf>,
    pub dashboard_index: PathBuf,
    pub dashboard_routes: PathBuf,
    pub entry: PathBuf,
    pub migration_files: Vec<PathBuf>,
    pub migrations: PathBuf,
    pub root: PathBuf,
}

impl RuntimeBundle {
    pub fn sidecar_arguments(&self) -> Vec<OsString> {
        vec![
            self.entry.as_os_str().to_owned(),
            OsString::from("--profile=personal"),
        ]
    }
}

#[derive(Debug)]
pub struct BundleResourceError {
    path: PathBuf,
    source: io::Error,
}

impl BundleResourceError {
    fn new(path: PathBuf, source: io::Error) -> Self {
        Self { path, source }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Display for BundleResourceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Floway desktop runtime resource is unavailable at {}",
            self.path.display()
        )
    }
}

impl Error for BundleResourceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.source)
    }
}

fn require_file(path: PathBuf) -> Result<PathBuf, BundleResourceError> {
    let metadata =
        fs::metadata(&path).map_err(|source| BundleResourceError::new(path.clone(), source))?;
    if !metadata.is_file() {
        return Err(BundleResourceError::new(
            path,
            io::Error::new(io::ErrorKind::InvalidData, "the path is not a file"),
        ));
    }
    Ok(path)
}

fn invalid_contract(path: &Path, message: impl Into<String>) -> BundleResourceError {
    BundleResourceError::new(
        path.to_path_buf(),
        io::Error::new(io::ErrorKind::InvalidData, message.into()),
    )
}

struct ValidatedBundleContract {
    compatibility: RuntimeCompatibility,
    dashboard_assets: Vec<PathBuf>,
    migration_files: Vec<PathBuf>,
}

fn validate_file_contract(
    contract_path: &Path,
    entries: &[serde_json::Value],
    root: &Path,
    label: &str,
) -> Result<Vec<PathBuf>, BundleResourceError> {
    if entries.is_empty() {
        return Err(invalid_contract(
            contract_path,
            format!("the {label} contract is empty"),
        ));
    }
    let mut previous = None;
    let mut resolved = Vec::with_capacity(entries.len());
    for entry in entries {
        let relative = entry
            .get("path")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| invalid_contract(contract_path, format!("a {label} path is missing")))?;
        if relative.is_empty()
            || Path::new(relative)
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            || previous.is_some_and(|prior: &str| prior >= relative)
        {
            return Err(invalid_contract(
                contract_path,
                format!("the {label} path is unsafe, duplicated, or unsorted: {relative}"),
            ));
        }
        previous = Some(relative);
        let expected_hash = entry
            .get("sha256")
            .and_then(serde_json::Value::as_str)
            .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| {
                invalid_contract(
                    contract_path,
                    format!("the {label} digest is invalid for {relative}"),
                )
            })?;
        let path = require_file(root.join(relative))?;
        let contents =
            fs::read(&path).map_err(|source| BundleResourceError::new(path.clone(), source))?;
        let actual_hash = format!("{:x}", Sha256::digest(contents));
        if actual_hash != expected_hash.to_ascii_lowercase() {
            return Err(invalid_contract(
                contract_path,
                format!("the {label} digest is stale for {relative}"),
            ));
        }
        resolved.push(path);
    }
    Ok(resolved)
}

fn collect_migration_files(root: &Path) -> Result<Vec<PathBuf>, BundleResourceError> {
    let entries = fs::read_dir(root)
        .map_err(|source| BundleResourceError::new(root.to_path_buf(), source))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| BundleResourceError::new(root.to_path_buf(), source))?;
        let file_type = entry
            .file_type()
            .map_err(|source| BundleResourceError::new(entry.path(), source))?;
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "sql") && file_type.is_symlink() {
            return Err(BundleResourceError::new(
                path,
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "migration paths cannot be symbolic links",
                ),
            ));
        }
        if file_type.is_file() && path.extension().is_some_and(|extension| extension == "sql") {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

fn expected_node_contract() -> Option<(&'static str, &'static str)> {
    match std::env::consts::ARCH {
        "aarch64" => Some(("arm64", "aarch64-apple-darwin")),
        "x86_64" => Some(("x64", "x86_64-apple-darwin")),
        _ => None,
    }
}

fn validate_contract(
    contract_path: &Path,
    runtime_root: &Path,
) -> Result<ValidatedBundleContract, BundleResourceError> {
    let source = fs::read_to_string(contract_path)
        .map_err(|source| BundleResourceError::new(contract_path.to_path_buf(), source))?;
    let contract: serde_json::Value = serde_json::from_str(&source).map_err(|source| {
        BundleResourceError::new(
            contract_path.to_path_buf(),
            io::Error::new(io::ErrorKind::InvalidData, source),
        )
    })?;
    if contract
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(DESKTOP_BUNDLE_SCHEMA_VERSION)
    {
        return Err(invalid_contract(
            contract_path,
            "the desktop bundle schema version is not supported",
        ));
    }
    let compatibility = contract
        .get("compatibility")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            invalid_contract(
                contract_path,
                "the desktop compatibility contract is missing",
            )
        })?;
    let protocol_version = compatibility
        .get("protocolVersion")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            invalid_contract(
                contract_path,
                "the desktop compatibility protocol is missing",
            )
        })?;
    let release_version = compatibility
        .get("releaseVersion")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            let segments = value.split('.').collect::<Vec<_>>();
            segments.len() == 3
                && segments.iter().all(|segment| {
                    !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit())
                })
        })
        .ok_or_else(|| invalid_contract(contract_path, "the desktop release version is invalid"))?;
    if protocol_version != DESKTOP_COMPATIBILITY_VERSION
        || release_version != env!("CARGO_PKG_VERSION")
    {
        return Err(invalid_contract(
            contract_path,
            format!(
                "the desktop compatibility contract requires protocol {protocol_version} release {release_version}; this shell requires protocol {DESKTOP_COMPATIBILITY_VERSION} release {}",
                env!("CARGO_PKG_VERSION")
            ),
        ));
    }
    let node = contract
        .get("node")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| invalid_contract(contract_path, "the Node contract is missing"))?;
    let (expected_architecture, expected_target) = expected_node_contract().ok_or_else(|| {
        invalid_contract(
            contract_path,
            format!(
                "the desktop host architecture {} is unsupported",
                std::env::consts::ARCH
            ),
        )
    })?;
    let version_is_exact = node
        .get("version")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| {
            let segments = value.split('.').collect::<Vec<_>>();
            segments.len() == 3
                && segments.iter().all(|segment| {
                    !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit())
                })
        });
    if node.get("architecture").and_then(serde_json::Value::as_str) != Some(expected_architecture)
        || node.get("platform").and_then(serde_json::Value::as_str) != Some("darwin")
        || node.get("targetTriple").and_then(serde_json::Value::as_str) != Some(expected_target)
        || !version_is_exact
    {
        return Err(invalid_contract(
            contract_path,
            "the Node contract does not match this installed desktop artifact",
        ));
    }

    let dashboard_entries = contract
        .get("dashboard")
        .and_then(|dashboard| dashboard.get("assets"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            invalid_contract(contract_path, "the Dashboard asset contract is missing")
        })?;
    let dashboard_root = runtime_root.join("apps/web/dist/client");
    let dashboard_assets = validate_file_contract(
        contract_path,
        dashboard_entries,
        &dashboard_root,
        "Dashboard asset",
    )?;
    for required in ["index.html", "dashboard-routes.json"] {
        if !dashboard_assets
            .iter()
            .any(|path| path == &dashboard_root.join(required))
        {
            return Err(invalid_contract(
                contract_path,
                format!("the Dashboard asset contract omits {required}"),
            ));
        }
    }

    let migration_entries = contract
        .get("migrations")
        .and_then(|migrations| migrations.get("files"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| invalid_contract(contract_path, "the migration file contract is missing"))?;
    let migrations_root =
        runtime_root.join("apps/platform-node/node_modules/@floway-dev/gateway/migrations");
    let migration_files = validate_file_contract(
        contract_path,
        migration_entries,
        &migrations_root,
        "migration file",
    )?;
    if migration_files != collect_migration_files(&migrations_root)? {
        return Err(invalid_contract(
            contract_path,
            "the installed migration inventory differs from the owning bundle contract",
        ));
    }
    Ok(ValidatedBundleContract {
        compatibility: RuntimeCompatibility {
            contract_digest: format!("{:x}", Sha256::digest(source.as_bytes())),
            protocol_version,
            release_version: release_version.to_owned(),
        },
        dashboard_assets,
        migration_files,
    })
}

pub fn resolve_runtime_bundle(resource_dir: &Path) -> Result<RuntimeBundle, BundleResourceError> {
    let root = resource_dir.join("runtime");
    let platform_node = root.join("apps/platform-node");
    let contract = require_file(resource_dir.join("desktop-bundle-contract.json"))?;
    let validated = validate_contract(&contract, &root)?;
    let migrations = platform_node.join("node_modules/@floway-dev/gateway/migrations");
    Ok(RuntimeBundle {
        compatibility: validated.compatibility,
        contract,
        dashboard_assets: validated.dashboard_assets,
        dashboard_index: require_file(root.join("apps/web/dist/client/index.html"))?,
        dashboard_routes: require_file(root.join("apps/web/dist/client/dashboard-routes.json"))?,
        entry: require_file(platform_node.join("entry.js"))?,
        migration_files: validated.migration_files,
        migrations,
        root,
    })
}
