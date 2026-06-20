// AXIOM Desktop — Tauri (Rust) backend. A single self-contained app: the React UI
// (Chat · Space · Dashboard · IDE) runs in the system webview, the REAL AXIOM agent
// runs as a child process driven over RPC, and Gemini (for Space) is called directly
// from the webview. No external terminal, no background server.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod codex_oauth;
mod gemini;
mod gemini_oauth;
mod ide;
mod lsp;

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use serde::Serialize;

/// Resolve the user's home directory cross-platform. On Windows `HOME` is unset
/// (it's `USERPROFILE`), so relying on `HOME` alone broke the agent dir, the env
/// file, and Codex/Gemini OAuth ("error: couldn't find home"). Check both.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    /// Working directory the agent operates in (AXIOM_CWD, else the launch dir).
    cwd: String,
    platform: String,
    agent_model: String,
    space_model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardTask {
    text: String,
    status: String,
    session_id: String,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AxiomDataSummary {
    sessions: u64,
    reflections: u64,
    skills: u64,
    memories: u64,
    knowledge: u64,
    document_indexes: u64,
    code_graphs: u64,
    flow_graphs: u64,
    understandings: u64,
    todos: u64,
    failure_fingerprints: u64,
    context_ledger_files: u64,
    stored_bytes: u64,
    active_tasks: Vec<DashboardTask>,
}

fn count_files(root: &std::path::Path) -> (u64, u64) {
    let Ok(entries) = fs::read_dir(root) else {
        return (0, 0);
    };
    let mut count = 0;
    let mut bytes = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            let (child_count, child_bytes) = count_files(&path);
            count += child_count;
            bytes += child_bytes;
        } else if kind.is_file() {
            count += 1;
            bytes += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        }
    }
    (count, bytes)
}

fn count_store(agent_dir: &std::path::Path, name: &str, total_bytes: &mut u64) -> u64 {
    let (count, bytes) = count_files(&agent_dir.join(name));
    *total_bytes += bytes;
    count
}

fn load_active_tasks(agent_dir: &std::path::Path) -> Vec<DashboardTask> {
    let mut tasks = Vec::new();
    let Ok(entries) = fs::read_dir(agent_dir.join("todos")) else {
        return tasks;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let session_id = value.get("sessionId").and_then(|item| item.as_str()).unwrap_or("");
        let updated_at = value.get("updatedAt").and_then(|item| item.as_str()).unwrap_or("");
        let Some(items) = value.get("items").and_then(|item| item.as_array()) else {
            continue;
        };
        for item in items {
            let status = item.get("status").and_then(|value| value.as_str()).unwrap_or("pending");
            if matches!(status, "complete" | "skipped") {
                continue;
            }
            let Some(task_text) = item.get("text").and_then(|value| value.as_str()) else {
                continue;
            };
            tasks.push(DashboardTask {
                text: task_text.to_string(),
                status: status.to_string(),
                session_id: session_id.to_string(),
                updated_at: updated_at.to_string(),
            });
        }
    }
    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    tasks.truncate(50);
    tasks
}

#[tauri::command]
fn axiom_data_summary() -> AxiomDataSummary {
    let agent_dir = home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".axiom/agent");
    let mut stored_bytes = 0;
    let sessions = count_store(&agent_dir, "sessions", &mut stored_bytes);
    let reflections = count_store(&agent_dir, "reflections", &mut stored_bytes);
    let skills = count_store(&agent_dir, "skills", &mut stored_bytes);
    let memories = count_store(&agent_dir, "memory", &mut stored_bytes);
    let knowledge = count_store(&agent_dir, "knowledge", &mut stored_bytes);
    let document_indexes = count_store(&agent_dir, "sparse-tree-grep/docs", &mut stored_bytes);
    let code_graphs = count_store(&agent_dir, "code-graphs", &mut stored_bytes);
    let flow_graphs = count_store(&agent_dir, "flow-graphs", &mut stored_bytes);
    let understandings = count_store(&agent_dir, "understandings", &mut stored_bytes);
    let todos = count_store(&agent_dir, "todos", &mut stored_bytes);
    let failure_fingerprints = count_store(&agent_dir, "failure-fingerprints", &mut stored_bytes);
    let context_ledger_files = count_store(&agent_dir, "context-ledger", &mut stored_bytes);
    let active_tasks = load_active_tasks(&agent_dir);
    AxiomDataSummary {
        sessions,
        reflections,
        skills,
        memories,
        knowledge,
        document_indexes,
        code_graphs,
        flow_graphs,
        understandings,
        todos,
        failure_fingerprints,
        context_ledger_files,
        stored_bytes,
        active_tasks,
    }
}

/// The directory the agent should treat as the project root. Set by the global
/// `axiom-app` launcher via AXIOM_CWD; falls back to the process working dir.
pub fn default_cwd() -> String {
    if let Ok(c) = std::env::var("AXIOM_CWD") {
        if !c.is_empty() {
            return c;
        }
    }
    // GUI apps launched from Finder/Spotlight inherit current_dir = "/". Running
    // the agent at the filesystem root makes it try to build context over the
    // entire disk, which stalls or errors the model call (blank chat). Fall back
    // to a safe, bounded workspace: ~/AXIOM (created on demand), else $HOME.
    let cur = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    if !cur.is_empty() && cur != "/" {
        return cur;
    }
    if let Some(home) = home_dir() {
        let workspace = home.join("AXIOM");
        // Best-effort create a tidy default workspace; ignore failures.
        let _ = std::fs::create_dir_all(&workspace);
        if workspace.is_dir() {
            return workspace.to_string_lossy().to_string();
        }
        return home.to_string_lossy().to_string();
    }
    ".".into()
}

fn env_first(keys: &[&str], fallback: &str) -> String {
    keys.iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| fallback.to_string())
}

#[tauri::command]
fn app_config() -> AppConfig {
    AppConfig {
        cwd: default_cwd(),
        platform: std::env::consts::OS.to_string(),
        agent_model: env_first(&["AXIOM_PRIMARY_MODEL"], "Configured model"),
        space_model: env_first(&["AXIOM_SPACE_MODEL", "GEMINI_MODEL"], "gemini-3.5-flash"),
    }
}

fn load_env_file(file: &std::path::Path) {
    let Ok(text) = fs::read_to_string(file) else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(eq) = line.find('=') {
            let key = line[..eq].trim();
            let val = line[eq + 1..].trim().trim_matches('"').trim_matches('\'');
            if !key.is_empty() && std::env::var_os(key).is_none() {
                std::env::set_var(key, val);
            }
        }
    }
}

/// Load AXIOM's user-level `.env` first, then project-local files. Packaged macOS
/// apps cannot reliably read a source checkout under Downloads, and Finder launches
/// do not inherit shell variables, so `~/.axiom/.env` is the stable runtime location.
/// Existing process env is never overwritten.
fn load_dotenv() {
    let mut files: Vec<PathBuf> = Vec::new();
    if let Some(explicit) = std::env::var_os("AXIOM_ENV_FILE") {
        files.push(PathBuf::from(explicit));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        files.push(home.join(".axiom/.env"));
        files.push(home.join(".config/axiom/.env"));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        files.push(PathBuf::from(xdg).join("axiom/.env"));
    }

    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(c) = std::env::current_dir() {
        starts.push(c);
    }
    if cfg!(debug_assertions) {
        starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    }

    let mut seen: HashSet<PathBuf> = HashSet::new();
    for file in files {
        if seen.insert(file.clone()) {
            load_env_file(&file);
        }
    }
    for start in starts {
        let mut dir = start.as_path();
        for _ in 0..8 {
            let file = dir.join(".env");
            if seen.insert(file.clone()) {
                load_env_file(&file);
            }
            match dir.parent() {
                Some(p) => dir = p,
                None => break,
            }
        }
    }
}

/// Read any file as base64 — used by Space to place dropped images into Excalidraw.
/// Capped at 20 MB so we never block the UI with a huge read.
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use std::io::Read;
    const MAX: u64 = 20 * 1024 * 1024;
    let p = std::path::Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| format!("cannot stat {path}: {e}"))?;
    if meta.len() > MAX {
        return Err(format!("file too large for inline encoding ({} MB)", meta.len() / 1_048_576));
    }
    let mut buf = Vec::with_capacity(meta.len() as usize);
    fs::File::open(p)
        .and_then(|mut f| f.read_to_end(&mut buf))
        .map_err(|e| format!("cannot read {path}: {e}"))?;
    Ok(base64_encode(&buf))
}

/// Path to the user's AXIOM env file (`~/.axiom/.env`).
fn axiom_env_path() -> Option<PathBuf> {
    Some(home_dir()?.join(".axiom").join(".env"))
}

/// Read the AXIOM config as key→value pairs for the Settings panel. Secrets are
/// returned as-is (the UI masks them); the panel runs locally so this is safe.
#[tauri::command]
fn settings_read() -> serde_json::Value {
    let mut map = serde_json::Map::new();
    if let Some(path) = axiom_env_path() {
        if let Ok(contents) = fs::read_to_string(&path) {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = line.split_once('=') {
                    let k = k.trim().strip_prefix("export ").unwrap_or(k.trim());
                    let v = v.trim().trim_matches('"').trim_matches('\'');
                    map.insert(k.to_string(), serde_json::Value::String(v.to_string()));
                }
            }
        }
    }
    serde_json::Value::Object(map)
}

/// Merge the given key/value updates into `~/.axiom/.env`, preserving any keys
/// the UI didn't touch. An empty value removes the key. Applies to the live
/// process env too so a relaunch isn't required for most changes.
#[tauri::command]
fn settings_write_env(updates: std::collections::HashMap<String, String>) -> Result<(), String> {
    let path = axiom_env_path().ok_or("could not resolve your home directory (HOME or USERPROFILE)")?;
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    // Load existing lines into an ordered map.
    let mut entries: Vec<(String, String)> = Vec::new();
    if let Ok(contents) = fs::read_to_string(&path) {
        for line in contents.lines() {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = t.split_once('=') {
                let k = k.trim().strip_prefix("export ").unwrap_or(k.trim()).to_string();
                entries.push((k, v.trim().to_string()));
            }
        }
    }
    for (k, v) in &updates {
        if let Some(slot) = entries.iter_mut().find(|(ek, _)| ek == k) {
            slot.1 = v.clone();
        } else {
            entries.push((k.clone(), v.clone()));
        }
        // Reflect into the live process env (empty = unset).
        if v.is_empty() {
            std::env::remove_var(k);
        } else {
            std::env::set_var(k, v);
        }
    }
    let body: String = entries
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| format!("{k}={v}\n"))
        .collect();
    fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Minimal Base64 encoder (no external dep needed for this small use-case).
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) & 63] as char);
        out.push(TABLE[(n >> 12) & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n & 63] as char } else { '=' });
    }
    out
}

/// Read any file as UTF-8 text (for code/text files dropped onto Space).
#[tauri::command]
fn read_file_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("cannot read {path}: {e}"))
}

fn main() {
    load_dotenv();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(agent::AgentState::default())
        .manage(agent::SpaceAgentState::default())
        .manage(ide::IdeState::default())
        .manage(lsp::LspState::default())
        .invoke_handler(tauri::generate_handler![
            app_config,
            gemini::gemini_prompt,
            agent::agent_prompt,
            agent::agent_command,
            agent::agent_abort,
            agent::agent_set_cwd,
            agent::agent_cwd,
            agent::space_agent_prompt,
            agent::space_agent_command,
            agent::space_agent_abort,
            agent::space_agent_set_cwd,
            agent::space_agent_cwd,
            ide::ide_open_folder,
            ide::ide_open_path,
            ide::ide_list_dir,
            ide::ide_read_file,
            ide::ide_write_file,
            lsp::lsp_set_root,
            lsp::lsp_did_open,
            lsp::lsp_did_change,
            lsp::lsp_did_close,
            lsp::lsp_request,
            lsp::lsp_shutdown_all,
            read_file_base64,
            read_file_text,
            axiom_data_summary,
            gemini_oauth::gemini_oauth_login,
            gemini_oauth::gemini_oauth_status,
            gemini_oauth::gemini_oauth_logout,
            codex_oauth::codex_oauth_login,
            codex_oauth::codex_oauth_status,
            codex_oauth::codex_oauth_logout,
            settings_read,
            settings_write_env
        ])
        .run(tauri::generate_context!())
        .expect("error while running AXIOM");
}
