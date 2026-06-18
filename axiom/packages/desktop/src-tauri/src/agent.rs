// Drives the REAL AXIOM agent (@axiom/coding-agent) in headless RPC mode as a child
// process. The desktop Chat is a GUI client over the actual agent — same tools
// (read/write/edit/bash), AXIOM runtime, model resolution — not a chatbot. One agent
// per working directory; restarted when the folder changes. Chat and Space run
// separate child processes so stopping Space cannot kill the main Chat agent.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use crate::default_cwd;

#[derive(Default)]
pub struct AgentState(pub Mutex<Agent>);

#[derive(Default)]
pub struct SpaceAgentState(pub Mutex<Agent>);

#[derive(Default)]
pub struct Agent {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    cwd: String,
}

enum AgentProgram {
    Binary(PathBuf),
    NodeScript(PathBuf),
}

fn packaged_agent_candidates(exe_dir: &Path, executable_name: &str) -> Vec<PathBuf> {
    let mut candidates = vec![
        exe_dir.join("../Resources/agent").join(executable_name), // macOS .app
        exe_dir.join("resources/agent").join(executable_name),    // Windows / portable
        exe_dir.join("../resources/agent").join(executable_name), // Linux AppImage / portable
        exe_dir.join("../lib/axiom/resources/agent").join(executable_name), // Linux deb/rpm
        exe_dir.join("../lib/AXIOM/resources/agent").join(executable_name),
    ];
    if let Some(appdir) = std::env::var_os("APPDIR") {
        let appdir = PathBuf::from(appdir);
        candidates.push(appdir.join("usr/lib/axiom/resources/agent").join(executable_name));
        candidates.push(appdir.join("usr/lib/AXIOM/resources/agent").join(executable_name));
        candidates.push(appdir.join("resources/agent").join(executable_name));
    }
    candidates
}

fn packaged_agent_path() -> Option<PathBuf> {
    let executable_name = if cfg!(windows) {
        "axiom-agent.exe"
    } else {
        "axiom-agent"
    };
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    // Tauri places bundled `resources/` differently per OS:
    //   macOS  : <App>.app/Contents/MacOS/<exe>  → ../Resources/agent
    //   Windows: <dir>/<exe>.exe                 → resources/agent
    //   Linux  : /usr/bin/<exe> (or AppImage)    → ../lib/<app>/resources/agent or ./resources/agent
    packaged_agent_candidates(&exe_dir, executable_name)
        .into_iter()
        .find(|path| path.exists())
}

/// Locate the self-contained packaged agent. Development builds retain the Node
/// source fallback, but release builds never reach into the source checkout.
fn find_agent_program() -> Option<AgentProgram> {
    if let Ok(p) = std::env::var("AXIOM_AGENT_BINARY") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(AgentProgram::Binary(path));
        }
    }
    if let Ok(p) = std::env::var("AXIOM_AGENT_CLI") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(AgentProgram::NodeScript(path));
        }
    }
    if let Some(path) = packaged_agent_path() {
        return Some(AgentProgram::Binary(path));
    }
    if !cfg!(debug_assertions) {
        return None;
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    [
        manifest.join("../../coding-agent/dist/cli.js"),
        manifest.join("../node_modules/@axiom/coding-agent/dist/cli.js"),
    ]
    .into_iter()
    .find(|path| path.exists())
    .map(AgentProgram::NodeScript)
}

/// Resolve a Node binary. GUI-launched apps don't inherit the shell PATH, so check
/// the common install locations before falling back to bare `node`. This is only a
/// dev fallback — release builds run the self-contained bundled agent binary.
fn find_node() -> String {
    let candidates: &[&str] = if cfg!(windows) {
        &[]
    } else {
        &[
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/usr/local/bin/bun",
            "/opt/homebrew/bin/bun",
        ]
    };
    for c in candidates {
        if Path::new(c).exists() {
            return c.to_string();
        }
    }
    "node".to_string()
}

/// Load the user's AXIOM env (`~/.axiom/.env`) as key/value pairs. GUI-launched
/// apps inherit no shell env, so without this the agent never sees
/// AXIOM_PRIMARY_MODEL / API keys and falls back to the wrong default model.
/// Returns owned pairs the caller applies to the child command; existing process
/// env wins so an explicit override (e.g. AXIOM_AGENT_CLI) is never clobbered.
fn load_axiom_env() -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let path = match dirs_axiom_env() {
        Some(p) => p,
        None => return pairs,
    };
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return pairs,
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        // Strip optional surrounding quotes and an optional leading `export `.
        let key = key.strip_prefix("export ").unwrap_or(key).trim();
        let value = value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string();
        pairs.push((key.to_string(), value));
    }
    pairs
}

/// Temporary debug log to /tmp/axiom-agent.log so we can see exactly what the
/// GUI-spawned agent does (the app's stdout doesn't surface agent stdio).
fn dbg_log(msg: &str) {
    use std::io::Write as _;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/axiom-agent.log")
    {
        let _ = writeln!(f, "{msg}");
    }
}

/// `~/.axiom/.env`, resolved without extra dependencies.
fn dirs_axiom_env() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".axiom").join(".env"))
}

fn ensure_started(app: &AppHandle, agent: &mut Agent, event_channel: &'static str) -> Result<(), String> {
    let running = match agent.child.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)) && agent.stdin.is_some(),
        None => false,
    };
    if running {
        return Ok(());
    }
    agent.child = None;
    agent.stdin = None;
    let program = find_agent_program().ok_or_else(|| {
        "The packaged AXIOM agent runtime is missing. Reinstall or rebuild AXIOM.".to_string()
    })?;
    if agent.cwd.is_empty() {
        agent.cwd = default_cwd();
    }
    let (mut command, description) = match program {
        AgentProgram::Binary(path) => {
            let description = path.display().to_string();
            (Command::new(path), description)
        }
        AgentProgram::NodeScript(path) => {
            let node = find_node();
            let description = format!("{node} {}", path.display());
            let mut command = Command::new(node);
            command.arg(path);
            (command, description)
        }
    };
    // GUI launches inherit no shell env, so feed the agent the user's
    // ~/.axiom/.env (model selection + API keys). Without this the agent can't
    // see AXIOM_PRIMARY_MODEL and silently falls back to the wrong default.
    let env_pairs = load_axiom_env();
    for (key, value) in &env_pairs {
        command.env(key, value);
    }
    // The Space agent is a separate process and must run the MULTIMODAL Space model
    // (AXIOM_SPACE_*), not the main/coding model. The agent only reads
    // AXIOM_PRIMARY_PROVIDER / AXIOM_PRIMARY_MODEL, so for the Space child we map the
    // Space selection onto those vars. Without this, Space silently runs the coding
    // model (e.g. text-only Codex) and draws poorly / can't see the board.
    let is_space = event_channel == "space_agent:event";
    if is_space {
        let get = |k: &str| {
            env_pairs
                .iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.clone())
                .filter(|v| !v.is_empty())
        };
        if let Some(space_provider) = get("AXIOM_SPACE_PROVIDER") {
            command.env("AXIOM_PRIMARY_PROVIDER", space_provider);
        }
        if let Some(space_model) = get("AXIOM_SPACE_MODEL") {
            command.env("AXIOM_PRIMARY_MODEL", space_model);
        }
    }
    let mut child = command
        .arg("--mode")
        .arg("rpc")
        // Enable Space canvas tools. Chat normally never calls them; Space uses
        // a separate child/event channel so stopping Space cannot kill Chat.
        .env("AXIOM_SPACE_TOOLS", "1")
        .current_dir(&agent.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start agent via {description}: {e}"))?;

    dbg_log(&format!(
        "SPAWNED agent: {description} | cwd={}",
        agent.cwd
    ));

    let stdout = child.stdout.take().ok_or("agent has no stdout")?;
    let stderr = child.stderr.take().ok_or("agent has no stderr")?;
    let stdin = child.stdin.take().ok_or("agent has no stdin")?;

    let app2 = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            dbg_log(&format!("OUT {}", &line[..line.len().min(4000)]));
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                let _ = app2.emit(event_channel, v);
            }
        }
        let _ = app2.emit(event_channel, serde_json::json!({ "type": "rpc_exit" }));
    });
    let app3 = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            dbg_log(&format!("ERR {line}"));
            let lower = line.to_lowercase();
            if lower.contains("error") || lower.contains("failed") || lower.contains("panic") {
                let _ = app3.emit(event_channel, serde_json::json!({ "type": "rpc_error", "error": line }));
            }
        }
    });

    agent.child = Some(child);
    agent.stdin = Some(stdin);
    Ok(())
}

fn command_inner(
    app: AppHandle,
    agent: &Mutex<Agent>,
    command: serde_json::Value,
    event_channel: &'static str,
) -> Result<(), String> {
    let mut agent = agent.lock().map_err(|e| e.to_string())?;
    ensure_started(&app, &mut agent, event_channel)?;
    if write_command(&mut agent, &command).is_ok() {
        return Ok(());
    }
    if let Some(child) = agent.child.as_mut() {
        let _ = child.kill();
    }
    agent.child = None;
    agent.stdin = None;
    ensure_started(&app, &mut agent, event_channel)?;
    write_command(&mut agent, &command)
        .map_err(|e| format!("failed to send command after restarting agent: {e}"))
}

fn write_command(agent: &mut Agent, command: &serde_json::Value) -> Result<(), String> {
    let line = format!("{command}\n");
    agent
        .stdin
        .as_mut()
        .ok_or_else(|| "agent stdin is unavailable".to_string())?
        .write_all(line.as_bytes())
        .and_then(|_| agent.stdin.as_mut().expect("stdin checked above").flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_command(
    app: AppHandle,
    state: State<AgentState>,
    command: serde_json::Value,
) -> Result<(), String> {
    command_inner(app, &state.0, command, "agent:event")
}

#[tauri::command]
pub fn space_agent_command(
    app: AppHandle,
    state: State<SpaceAgentState>,
    command: serde_json::Value,
) -> Result<(), String> {
    command_inner(app, &state.0, command, "space_agent:event")
}

#[derive(Deserialize)]
pub struct ImageInput {
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub data: String,
}

fn prompt_inner(
    app: AppHandle,
    agent: &Mutex<Agent>,
    message: String,
    images: Option<Vec<ImageInput>>,
    event_channel: &'static str,
) -> Result<(), String> {
    let mut a = agent.lock().map_err(|e| e.to_string())?;
    ensure_started(&app, &mut a, event_channel)?;

    let imgs: Vec<serde_json::Value> = images
        .unwrap_or_default()
        .into_iter()
        .map(|i| serde_json::json!({ "type": "image", "data": i.data, "mimeType": i.mime_type }))
        .collect();
    let mut cmd = serde_json::json!({ "type": "prompt", "message": message });
    if !imgs.is_empty() {
        cmd["images"] = serde_json::Value::Array(imgs);
    }
    let first_write = write_command(&mut a, &cmd);
    if first_write.is_err() {
        if let Some(child) = a.child.as_mut() {
            let _ = child.kill();
        }
        a.child = None;
        a.stdin = None;
        ensure_started(&app, &mut a, event_channel)?;
        write_command(&mut a, &cmd)
            .map_err(|e| format!("failed to send prompt after restarting agent: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn agent_prompt(
    app: AppHandle,
    state: State<AgentState>,
    message: String,
    images: Option<Vec<ImageInput>>,
) -> Result<(), String> {
    prompt_inner(app, &state.0, message, images, "agent:event")
}

#[tauri::command]
pub fn space_agent_prompt(
    app: AppHandle,
    state: State<SpaceAgentState>,
    message: String,
    images: Option<Vec<ImageInput>>,
) -> Result<(), String> {
    prompt_inner(app, &state.0, message, images, "space_agent:event")
}

fn abort_inner(agent: &Mutex<Agent>, label: &str) -> Result<(), String> {
    let mut a = agent.lock().map_err(|e| e.to_string())?;
    // Try the cooperative abort first (lets the agent flush a clean turn_end).
    if let Some(stdin) = a.stdin.as_mut() {
        let _ = stdin.write_all(b"{\"type\":\"abort\"}\n");
        let _ = stdin.flush();
    }
    // Then hard-kill the child. The cooperative abort can't interrupt an agent
    // that's wedged inside a turn (e.g. a stuck tool loop) because it isn't
    // reading stdin, so Stop must guarantee a halt. The next prompt re-spawns a
    // fresh agent automatically (ensure_started handles a dead child), and the
    // session is persisted to disk so history/resume is unaffected.
    if let Some(child) = a.child.as_mut() {
        let _ = child.kill();
    }
    a.child = None;
    a.stdin = None;
    dbg_log(&format!("ABORT: killed {label} agent child (hard stop)"));
    Ok(())
}

#[tauri::command]
pub fn agent_abort(state: State<AgentState>) -> Result<(), String> {
    abort_inner(&state.0, "main")
}

#[tauri::command]
pub fn space_agent_abort(state: State<SpaceAgentState>) -> Result<(), String> {
    abort_inner(&state.0, "space")
}

fn set_cwd_inner(agent: &Mutex<Agent>, cwd: String) -> Result<(), String> {
    let mut a = agent.lock().map_err(|e| e.to_string())?;
    if !cwd.is_empty() && cwd != a.cwd {
        if let Some(child) = a.child.as_mut() {
            let _ = child.kill();
        }
        a.child = None;
        a.stdin = None;
        a.cwd = cwd; // next prompt re-spawns in the new folder
    }
    Ok(())
}

#[tauri::command]
pub fn agent_set_cwd(state: State<AgentState>, cwd: String) -> Result<(), String> {
    set_cwd_inner(&state.0, cwd)
}

#[tauri::command]
pub fn space_agent_set_cwd(state: State<SpaceAgentState>, cwd: String) -> Result<(), String> {
    set_cwd_inner(&state.0, cwd)
}

fn cwd_inner(agent: &Mutex<Agent>) -> String {
    let a = agent.lock().map(|a| a.cwd.clone()).unwrap_or_default();
    if a.is_empty() {
        default_cwd()
    } else {
        a
    }
}

#[tauri::command]
pub fn agent_cwd(state: State<AgentState>) -> String {
    cwd_inner(&state.0)
}

#[tauri::command]
pub fn space_agent_cwd(state: State<SpaceAgentState>) -> String {
    cwd_inner(&state.0)
}

#[cfg(test)]
mod tests {
    use super::packaged_agent_candidates;
    use std::path::Path;

    #[test]
    fn packaged_agent_candidates_cover_supported_os_layouts() {
        let candidates = packaged_agent_candidates(Path::new("/app/Contents/MacOS"), "axiom-agent");
        let rendered: Vec<String> = candidates.iter().map(|path| path.to_string_lossy().to_string()).collect();

        assert!(rendered.iter().any(|path| path.ends_with("/Contents/MacOS/../Resources/agent/axiom-agent")));
        assert!(rendered.iter().any(|path| path.ends_with("/Contents/MacOS/resources/agent/axiom-agent")));
        assert!(rendered.iter().any(|path| path.ends_with("/Contents/MacOS/../resources/agent/axiom-agent")));
        assert!(rendered
            .iter()
            .any(|path| path.ends_with("/Contents/MacOS/../lib/axiom/resources/agent/axiom-agent")));
    }
}
