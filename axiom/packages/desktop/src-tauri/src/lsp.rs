// Language Server bridge for the IDE surface.
//
// Spawns real language servers (typescript-language-server, pyright, rust-analyzer,
// gopls, clangd, …) as child processes and speaks the Language Server Protocol
// (JSON-RPC over stdio with Content-Length framing). The webview drives document
// lifecycle (didOpen/didChange/didClose) and hover/definition requests; every
// server notification/response is forwarded to the webview as an `lsp:event`.
//
// One server per language id, lazily started on first use for the open workspace
// and reused across files. Servers are matched to files by extension via REGISTRY.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

/// A language server we know how to launch. `command`/`args` is the server's CLI;
/// it must already be installed (PATH or absolute). Multiple extensions can map to
/// the same `language_id`.
struct ServerSpec {
    language_id: &'static str,
    command: &'static str,
    args: &'static [&'static str],
    /// File extensions (no dot) this server handles.
    extensions: &'static [&'static str],
}

/// Built-in language-server registry. Extend by adding rows — no other code change
/// is needed to support a new language end-to-end.
const REGISTRY: &[ServerSpec] = &[
    ServerSpec {
        language_id: "typescript",
        command: "typescript-language-server",
        args: &["--stdio"],
        extensions: &["ts", "tsx", "js", "jsx", "mjs", "cjs"],
    },
    ServerSpec {
        language_id: "python",
        command: "pyright-langserver",
        args: &["--stdio"],
        extensions: &["py", "pyi"],
    },
    ServerSpec {
        language_id: "rust",
        command: "rust-analyzer",
        args: &[],
        extensions: &["rs"],
    },
    ServerSpec {
        language_id: "go",
        command: "gopls",
        args: &[],
        extensions: &["go"],
    },
    ServerSpec {
        language_id: "c",
        command: "clangd",
        args: &[],
        extensions: &["c", "h", "cpp", "cc", "hpp", "cxx"],
    },
    ServerSpec {
        language_id: "json",
        command: "vscode-json-language-server",
        args: &["--stdio"],
        extensions: &["json", "jsonc"],
    },
    ServerSpec {
        language_id: "html",
        command: "vscode-html-language-server",
        args: &["--stdio"],
        extensions: &["html", "htm"],
    },
    ServerSpec {
        language_id: "css",
        command: "vscode-css-language-server",
        args: &["--stdio"],
        extensions: &["css", "scss", "less"],
    },
    ServerSpec {
        language_id: "yaml",
        command: "yaml-language-server",
        args: &["--stdio"],
        extensions: &["yaml", "yml"],
    },
    ServerSpec {
        language_id: "bash",
        command: "bash-language-server",
        args: &["start"],
        extensions: &["sh", "bash"],
    },
];

fn spec_for_extension(ext: &str) -> Option<&'static ServerSpec> {
    let ext = ext.to_lowercase();
    REGISTRY
        .iter()
        .find(|spec| spec.extensions.iter().any(|e| *e == ext))
}

fn spec_for_language(language_id: &str) -> Option<&'static ServerSpec> {
    REGISTRY.iter().find(|spec| spec.language_id == language_id)
}

/// Map a file path to its language id, if any server handles it.
pub fn language_id_for(path: &str) -> Option<&'static str> {
    let ext = PathBuf::from(path)
        .extension()
        .map(|e| e.to_string_lossy().to_string())?;
    spec_for_extension(&ext).map(|spec| spec.language_id)
}

struct Server {
    child: Child,
    stdin: ChildStdin,
    /// Monotonic request id for this server.
    next_id: Arc<AtomicI64>,
    initialized: bool,
}

#[derive(Default)]
pub struct LspState(pub Mutex<LspInner>);

#[derive(Default)]
pub struct LspInner {
    servers: HashMap<&'static str, Server>,
    root_uri: Option<String>,
}

fn path_to_uri(path: &str) -> String {
    // Minimal file URI. Paths from the IDE are already absolute + canonical.
    let encoded = path.replace(' ', "%20");
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

/// Write one LSP message (Content-Length framed) to a server's stdin.
fn write_message(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let body = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    stdin
        .write_all(header.as_bytes())
        .and_then(|_| stdin.write_all(body.as_bytes()))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("failed to write to language server: {e}"))
}

/// Spawn the reader thread that parses framed JSON-RPC from a server's stdout and
/// forwards every message to the webview as `lsp:event` tagged with the language id.
fn spawn_reader(app: AppHandle, language_id: &'static str, stdout: std::process::ChildStdout) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            // Read headers up to the blank line.
            let mut content_length: usize = 0;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => return, // EOF: server exited
                    Ok(_) => {}
                    Err(_) => return,
                }
                let trimmed = line.trim_end();
                if trimmed.is_empty() {
                    break; // end of headers
                }
                if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                    content_length = rest.trim().parse().unwrap_or(0);
                }
            }
            if content_length == 0 {
                continue;
            }
            let mut buf = vec![0u8; content_length];
            if reader.read_exact(&mut buf).is_err() {
                return;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(&buf) {
                let _ = app.emit(
                    "lsp:event",
                    json!({ "languageId": language_id, "message": value }),
                );
            }
        }
    });
}

/// Ensure a server for `language_id` is running and initialized for the workspace.
fn ensure_server<'a>(
    app: &AppHandle,
    inner: &'a mut LspInner,
    language_id: &'static str,
) -> Result<&'a mut Server, String> {
    if inner.servers.contains_key(language_id) {
        return Ok(inner.servers.get_mut(language_id).expect("just checked"));
    }
    let spec = spec_for_language(language_id)
        .ok_or_else(|| format!("no language server configured for {language_id}"))?;

    let mut child = Command::new(spec.command)
        .args(spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            format!(
                "could not start {} ({}). Install it to enable {} language features.",
                spec.command, e, language_id
            )
        })?;

    let stdout = child.stdout.take().ok_or("language server has no stdout")?;
    let mut stdin = child.stdin.take().ok_or("language server has no stdin")?;
    spawn_reader(app.clone(), language_id, stdout);

    let next_id = Arc::new(AtomicI64::new(1));
    let root_uri = inner.root_uri.clone();
    // LSP initialize handshake.
    let init = json!({
        "jsonrpc": "2.0",
        "id": next_id.fetch_add(1, Ordering::SeqCst),
        "method": "initialize",
        "params": {
            "processId": std::process::id(),
            "rootUri": root_uri,
            "capabilities": {
                "textDocument": {
                    "synchronization": { "didSave": true, "dynamicRegistration": false },
                    "publishDiagnostics": { "relatedInformation": true },
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "definition": { "dynamicRegistration": false }
                }
            }
        }
    });
    write_message(&mut stdin, &init)?;
    // `initialized` notification follows the response in spec, but most servers
    // tolerate sending it right after; the webview never needs the init result.
    let initialized = json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} });
    write_message(&mut stdin, &initialized)?;

    let server = Server {
        child,
        stdin,
        next_id,
        initialized: true,
    };
    inner.servers.insert(language_id, server);
    Ok(inner.servers.get_mut(language_id).expect("just inserted"))
}

/// Set the workspace root for subsequent servers. Call when a folder opens.
#[tauri::command]
pub fn lsp_set_root(state: State<LspState>, path: String) -> Result<(), String> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    inner.root_uri = Some(path_to_uri(&path));
    Ok(())
}

/// Open a document with its language server (textDocument/didOpen). Returns the
/// detected language id, or null when no server handles this file type.
#[tauri::command]
pub fn lsp_did_open(
    app: AppHandle,
    state: State<LspState>,
    path: String,
    text: String,
) -> Result<Option<String>, String> {
    let Some(language_id) = language_id_for(&path) else {
        return Ok(None);
    };
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let uri = path_to_uri(&path);
    let server = ensure_server(&app, &mut inner, language_id)?;
    let msg = json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": { "uri": uri, "languageId": language_id, "version": 1, "text": text }
        }
    });
    write_message(&mut server.stdin, &msg)?;
    Ok(Some(language_id.to_string()))
}

/// Push a full-document change (textDocument/didChange, full sync).
#[tauri::command]
pub fn lsp_did_change(
    state: State<LspState>,
    path: String,
    text: String,
    version: i64,
) -> Result<(), String> {
    let Some(language_id) = language_id_for(&path) else {
        return Ok(());
    };
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let uri = path_to_uri(&path);
    let Some(server) = inner.servers.get_mut(language_id) else {
        return Ok(()); // not opened yet
    };
    let msg = json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didChange",
        "params": {
            "textDocument": { "uri": uri, "version": version },
            "contentChanges": [ { "text": text } ]
        }
    });
    write_message(&mut server.stdin, &msg)
}

/// Close a document (textDocument/didClose).
#[tauri::command]
pub fn lsp_did_close(state: State<LspState>, path: String) -> Result<(), String> {
    let Some(language_id) = language_id_for(&path) else {
        return Ok(());
    };
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let uri = path_to_uri(&path);
    let Some(server) = inner.servers.get_mut(language_id) else {
        return Ok(());
    };
    let msg = json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didClose",
        "params": { "textDocument": { "uri": uri } }
    });
    write_message(&mut server.stdin, &msg)
}

#[derive(Deserialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

/// Generic request forwarder for position-based features (hover, definition).
/// Returns the request id so the webview can correlate the response from `lsp:event`.
#[tauri::command]
pub fn lsp_request(
    state: State<LspState>,
    path: String,
    method: String,
    position: Position,
) -> Result<i64, String> {
    let language_id = language_id_for(&path).ok_or("no language server for this file")?;
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let uri = path_to_uri(&path);
    let server = inner
        .servers
        .get_mut(language_id)
        .ok_or("language server not started for this file")?;
    if !server.initialized {
        return Err("language server not ready".into());
    }
    let id = server.next_id.fetch_add(1, Ordering::SeqCst);
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": {
            "textDocument": { "uri": uri },
            "position": { "line": position.line, "character": position.character }
        }
    });
    write_message(&mut server.stdin, &msg)?;
    Ok(id)
}

/// Shut down all servers (e.g. when changing workspace).
#[tauri::command]
pub fn lsp_shutdown_all(state: State<LspState>) -> Result<(), String> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    for (_, mut server) in inner.servers.drain() {
        let _ = server.child.kill();
    }
    Ok(())
}
