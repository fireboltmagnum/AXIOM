// Filesystem bridge for the IDE surface. Opens a folder the user picks and serves
// file contents to the CodeMirror editor. Mirrors the old electron/ide.ts contract
// ({ root, name, tree } / file text) so the React side is unchanged.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct IdeState(pub Mutex<Option<PathBuf>>);

#[derive(Serialize)]
pub struct TreeNode {
    name: String,
    path: String,
    dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<TreeNode>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderResult {
    root: String,
    name: String,
    tree: Vec<TreeNode>,
}

// Directories never worth walking — version-control internals, dependency
// caches, build output, language toolchain caches. Skipping these is what keeps
// opening a real project responsive (a single node_modules or .venv can hold
// hundreds of thousands of files).
const SKIP: &[&str] = &[
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "dist-electron",
    "release",
    ".next",
    ".nuxt",
    "build",
    "out",
    ".cache",
    ".turbo",
    ".parcel-cache",
    "target",
    ".gradle",
    ".idea",
    ".vscode",
    "vendor",
    "Pods",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    "coverage",
    ".axiom",
    ".DS_Store",
];

fn is_skipped(name: &str) -> bool {
    if SKIP.contains(&name) {
        return true;
    }
    // Hidden files/dirs are hidden, with a couple of useful exceptions.
    name.starts_with('.') && name != ".gitignore" && name != ".env.example"
}

/// List the immediate children of a single directory (one level, no recursion).
/// The tree is built lazily — directories are returned with `children: None` and
/// the front-end fetches their contents on expand. This keeps `open folder` O(one
/// directory) instead of walking the entire repo on the IPC thread, which is what
/// caused the UI to freeze on large projects.
fn list_dir(dir: &Path) -> Vec<TreeNode> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let mut nodes: Vec<TreeNode> = Vec::new();
    for entry in entries.flatten() {
        // Hard cap per directory so a pathological folder (e.g. a generated
        // dir with 100k files) can't stall rendering.
        if nodes.len() >= 5000 {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_skipped(&name) {
            continue;
        }
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        nodes.push(TreeNode {
            name,
            path: path.to_string_lossy().to_string(),
            dir: is_dir,
            // Lazily populated: directories report no children until expanded.
            children: None,
        });
    }
    nodes.sort_by(|a, b| match (a.dir, b.dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    nodes
}

#[tauri::command]
pub async fn ide_open_folder(
    app: AppHandle,
    state: State<'_, IdeState>,
) -> Result<Option<FolderResult>, String> {
    // The native folder picker is modal and blocking; running it (and the
    // subsequent directory walk) directly on the command thread stalls the
    // webview event loop and freezes the whole UI. Do all blocking work on a
    // dedicated thread and only touch shared state once it returns.
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Option<(PathBuf, FolderResult)>, String> {
        let Some(picked) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let path: PathBuf = picked
            .into_path()
            .map_err(|_| "selected folder is not a local filesystem path".to_string())?
            .canonicalize()
            .map_err(|e| format!("could not open selected folder: {e}"))?;
        let root = path.to_string_lossy().to_string();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root.clone());
        let tree = list_dir(&path);
        Ok(Some((path, FolderResult { root, name, tree })))
    })
    .await
    .map_err(|e| format!("folder open task failed: {e}"))??;

    let Some((path, folder)) = result else {
        return Ok(None);
    };
    *state.0.lock().map_err(|e| e.to_string())? = Some(path);
    Ok(Some(folder))
}

#[tauri::command]
pub async fn ide_open_path(
    state: State<'_, IdeState>,
    path: String,
) -> Result<Option<FolderResult>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(PathBuf, FolderResult), String> {
        let path = PathBuf::from(&path)
            .canonicalize()
            .map_err(|e| format!("could not open workspace {path}: {e}"))?;
        if !path.is_dir() {
            return Err("workspace path is not a directory".to_string());
        }
        let root = path.to_string_lossy().to_string();
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| root.clone());
        let tree = list_dir(&path);
        Ok((path, FolderResult { root, name, tree }))
    })
    .await
    .map_err(|e| format!("workspace open task failed: {e}"))??;
    *state.0.lock().map_err(|e| e.to_string())? = Some(result.0);
    Ok(Some(result.1))
}

/// List the children of a directory inside the open workspace. Called by the
/// front-end when the user expands a folder in the tree (lazy loading).
#[tauri::command]
pub async fn ide_list_dir(state: State<'_, IdeState>, path: String) -> Result<Vec<TreeNode>, String> {
    let root = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "open a folder before listing directories".to_string())?;
    // Walk off the command thread so expanding a large directory never blocks
    // the UI event loop.
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TreeNode>, String> {
        let dir = PathBuf::from(&path)
            .canonicalize()
            .map_err(|e| format!("could not resolve {path}: {e}"))?;
        if !dir.starts_with(&root) {
            return Err("directory is outside the selected workspace".to_string());
        }
        if !dir.is_dir() {
            return Err("selected path is not a directory".to_string());
        }
        Ok(list_dir(&dir))
    })
    .await
    .map_err(|e| format!("list dir task failed: {e}"))?
}

fn validated_file(root: &Path, path: &str) -> Result<PathBuf, String> {
    let file = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("could not resolve {path}: {e}"))?;
    if !file.starts_with(root) {
        return Err("file is outside the selected workspace".to_string());
    }
    if !file.is_file() {
        return Err("selected path is not a file".to_string());
    }
    Ok(file)
}

fn selected_file(state: &State<IdeState>, path: &str) -> Result<PathBuf, String> {
    let root = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "open a folder before accessing files".to_string())?;
    validated_file(&root, path)
}

#[tauri::command]
pub fn ide_read_file(state: State<IdeState>, path: String) -> Result<String, String> {
    let file = selected_file(&state, &path)?;
    fs::read_to_string(&file).map_err(|e| format!("could not read {}: {e}", file.display()))
}

#[tauri::command]
pub fn ide_write_file(state: State<IdeState>, path: String, content: String) -> Result<(), String> {
    let file = selected_file(&state, &path)?;
    fs::write(&file, content).map_err(|e| format!("could not write {}: {e}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::validated_file;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn workspace_boundary_accepts_inside_and_rejects_outside() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let base = std::env::temp_dir().join(format!("axiom-ide-test-{nonce}"));
        let root = base.join("workspace");
        let outside = base.join("outside.txt");
        let inside = root.join("inside.txt");
        fs::create_dir_all(&root).expect("workspace should be created");
        fs::write(&inside, "inside").expect("inside file should be written");
        fs::write(&outside, "outside").expect("outside file should be written");
        let canonical_root = root.canonicalize().expect("workspace should resolve");

        assert_eq!(
            validated_file(&canonical_root, inside.to_str().expect("utf-8 path"))
                .expect("inside file should pass"),
            inside.canonicalize().expect("inside file should resolve")
        );
        assert!(validated_file(&canonical_root, outside.to_str().expect("utf-8 path")).is_err());

        fs::remove_dir_all(base).expect("test directory should be removed");
    }
}
