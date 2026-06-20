// Codex OAuth ("Sign in with ChatGPT") for AXIOM.
//
// Lets a user authenticate with their ChatGPT account and use the subscription's
// Codex/GPT models as AXIOM's MAIN (coding) model. This mirrors the official
// `codex login` flow (OAuth 2.0 + PKCE against auth.openai.com). The public
// installed-app client id is the one shipped in the open-source Codex CLI.
//
// Flow:
//   1. Generate a PKCE verifier/challenge + state.
//   2. Spin up a localhost:1455 callback server (Codex's fixed redirect port).
//   3. Open the consent screen at auth.openai.com.
//   4. Receive ?code= on /auth/callback, exchange it (with code_verifier) for
//      access/refresh/id tokens.
//   5. Persist the ChatGPT OAuth token to AXIOM's normal agent auth store
//      (~/.axiom/agent/auth.json) under provider `openai-codex`.
//
// The resulting credential is NOT a normal OpenAI API key. The coding-agent's
// `openai-codex` provider sends it to chatgpt.com/backend-api with the
// chatgpt-account-id header. Codex is only offered as the main/coding model.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

// Public installed-app client id from the official Codex CLI.
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER: &str = "https://auth.openai.com";
const SCOPES: &str = "openid profile email offline_access";
const REDIRECT_PORT: u16 = 1455;

#[derive(Serialize, Deserialize, Default)]
pub struct CodexOAuthTokens {
    /// Legacy field from an earlier broken implementation. Kept only so old
    /// token files still deserialize; the agent does not use this.
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub id_token: String,
    /// Unix seconds when access_token expires.
    #[serde(default)]
    pub expiry: i64,
    #[serde(default, rename = "accountId")]
    pub account_id: String,
    #[serde(default)]
    pub email: String,
}

fn tokens_path() -> Option<PathBuf> {
    Some(crate::home_dir()?.join(".axiom").join("codex-oauth.json"))
}

fn agent_auth_path() -> Option<PathBuf> {
    Some(crate::home_dir()?.join(".axiom").join("agent").join("auth.json"))
}

fn save_tokens(tokens: &CodexOAuthTokens) -> Result<(), String> {
    let path = tokens_path().ok_or("could not resolve your home directory (HOME or USERPROFILE)")?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let json = serde_json::to_string_pretty(tokens).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn save_agent_auth(tokens: &CodexOAuthTokens) -> Result<(), String> {
    if tokens.access_token.is_empty() || tokens.refresh_token.is_empty() || tokens.account_id.is_empty() {
        return Err("Codex OAuth token is incomplete; cannot configure agent auth.".into());
    }
    let path = agent_auth_path().ok_or("could not resolve your home directory (HOME or USERPROFILE)")?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    root.insert(
        "openai-codex".to_string(),
        serde_json::json!({
            "type": "oauth",
            "access": tokens.access_token,
            "refresh": tokens.refresh_token,
            "expires": tokens.expiry.saturating_mul(1000),
            "accountId": tokens.account_id,
        }),
    );
    let json = serde_json::to_string_pretty(&serde_json::Value::Object(root)).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn remove_agent_auth() {
    let Some(path) = agent_auth_path() else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    if let Some(obj) = value.as_object_mut() {
        obj.remove("openai-codex");
    }
    if let Ok(json) = serde_json::to_string_pretty(&value) {
        let _ = std::fs::write(&path, json);
    }
}

pub fn load_tokens() -> Option<CodexOAuthTokens> {
    let path = tokens_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

// --- PKCE helpers ---

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_pair() -> (String, String) {
    let mut buf = [0u8; 64];
    rand::rng().fill_bytes(&mut buf);
    let verifier = b64url(&buf);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn random_state() -> String {
    let mut buf = [0u8; 24];
    rand::rng().fill_bytes(&mut buf);
    b64url(&buf)
}

// --- Commands ---

#[tauri::command]
pub fn codex_oauth_status() -> serde_json::Value {
    match load_tokens() {
        Some(mut t) if !t.access_token.is_empty() && !t.refresh_token.is_empty() => {
            if t.account_id.is_empty() {
                t.account_id = account_id_from_access_token(&t.access_token).unwrap_or_default();
            }
            if !t.account_id.is_empty() {
                let _ = save_agent_auth(&t);
            }
            serde_json::json!({ "loggedIn": true, "email": t.email })
        }
        _ => serde_json::json!({ "loggedIn": false }),
    }
}

#[tauri::command]
pub fn codex_oauth_logout() -> Result<(), String> {
    if let Some(path) = tokens_path() {
        let _ = std::fs::remove_file(path);
    }
    remove_agent_auth();
    Ok(())
}

#[tauri::command]
pub async fn codex_oauth_login(_app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(run_login_flow)
        .await
        .map_err(|e| e.to_string())?
}

fn run_login_flow() -> Result<serde_json::Value, String> {
    // Codex requires the fixed redirect port 1455 (registered for its client id).
    let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
        .map_err(|e| format!("Could not bind localhost:{REDIRECT_PORT} (is Codex already logging in?): {e}"))?;
    let redirect_uri = format!("http://localhost:{REDIRECT_PORT}/auth/callback");

    let (verifier, challenge) = pkce_pair();
    let state = random_state();

    let auth_url = format!(
        "{ISSUER}/oauth/authorize?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=pi&state={}",
        urlencode(CLIENT_ID),
        urlencode(&redirect_uri),
        urlencode(SCOPES),
        urlencode(&challenge),
        urlencode(&state),
    );
    open_browser(&auth_url)?;

    let (code, returned_state) = wait_for_code(&listener)?;
    if returned_state != state {
        return Err("OAuth state mismatch — possible interference; aborting.".into());
    }

    let tokens = exchange_code(&code, &redirect_uri, &verifier)?;
    let email = tokens.email.clone();
    save_tokens(&tokens)?;
    save_agent_auth(&tokens)?;
    Ok(serde_json::json!({ "loggedIn": true, "email": email }))
}

fn exchange_code(code: &str, redirect_uri: &str, verifier: &str) -> Result<CodexOAuthTokens, String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("{ISSUER}/oauth/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", CLIENT_ID),
            ("code_verifier", verifier),
        ])
        .send()
        .map_err(|e| format!("token request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!("Codex token exchange failed ({status}): {}", &text.chars().take(300).collect::<String>()));
    }
    #[derive(Deserialize)]
    struct TokenResp {
        #[serde(default)]
        access_token: String,
        #[serde(default)]
        refresh_token: String,
        #[serde(default)]
        id_token: String,
        #[serde(default)]
        expires_in: i64,
    }
    let tr: TokenResp = resp.json().map_err(|e| e.to_string())?;
    let email = email_from_id_token(&tr.id_token).unwrap_or_default();
    let account_id = account_id_from_access_token(&tr.access_token)
        .ok_or_else(|| "Codex OAuth token did not include a ChatGPT account id.".to_string())?;
    Ok(CodexOAuthTokens {
        api_key: String::new(),
        expiry: now_secs() + tr.expires_in.max(0),
        access_token: tr.access_token,
        refresh_token: tr.refresh_token,
        id_token: tr.id_token,
        account_id,
        email,
    })
}

/// Best-effort email from the id_token's (unverified) JWT payload.
fn email_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    json.get("email").and_then(|e| e.as_str()).map(String::from)
}

fn account_id_from_access_token(access_token: &str) -> Option<String> {
    let payload = access_token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    json.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id")
        .and_then(|value| value.as_str())
        .map(String::from)
}

fn open_browser(url: &str) -> Result<(), String> {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(cmd)
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open browser: {e}"))
}

/// Block on the callback server until the redirect arrives with ?code= & state.
fn wait_for_code(listener: &TcpListener) -> Result<(String, String), String> {
    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };
        let mut reader = BufReader::new(&stream);
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).is_err() {
            continue;
        }
        // GET /auth/callback?code=XXX&state=YYY HTTP/1.1
        let query = request_line
            .split_whitespace()
            .nth(1)
            .and_then(|path| path.split('?').nth(1))
            .unwrap_or("")
            .to_string();
        let mut code = None;
        let mut state = String::new();
        for kv in query.split('&') {
            let mut it = kv.splitn(2, '=');
            match (it.next(), it.next()) {
                (Some("code"), Some(v)) => code = Some(urldecode(v)),
                (Some("state"), Some(v)) => state = urldecode(v),
                _ => {}
            }
        }
        let body = if code.is_some() {
            "<html><body style='font-family:system-ui;background:#0e0e0e;color:#eee;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h2>AXIOM is signed in with ChatGPT.</h2><p>You can close this tab and return to AXIOM.</p></div></body></html>"
        } else {
            "<html><body><h2>Login failed</h2><p>No authorization code received.</p></body></html>"
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();

        if let Some(code) = code {
            return Ok((code, state));
        }
        return Err("no authorization code in callback".into());
    }
    Err("callback server closed without a code".into())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
