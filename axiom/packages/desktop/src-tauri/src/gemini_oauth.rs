// Gemini OAuth ("Login with Google") for AXIOM.
//
// Lets a user authenticate with a *personal Google account* and use the free
// Code Assist tier (~1000 requests/day) instead of a metered GEMINI_API_KEY
// (20/day free). This is the same flow the official `gemini` CLI uses; the
// installed-app OAuth client id/secret are public values shipped in that
// open-source CLI.
//
// Flow:
//   1. Spin up a localhost callback server on a free port.
//   2. Open the Google consent screen in the browser.
//   3. Receive ?code=... on the callback, exchange it for tokens.
//   4. Persist tokens to ~/.axiom/gemini-oauth.json (mode 0600).
//
// The agent reads that file to mint Bearer tokens for the Code Assist endpoint
// (https://cloudcode-pa.googleapis.com). Token refresh is handled on read.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// Public installed-app client credentials from the official gemini-cli.
const CLIENT_ID: &str = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const CLIENT_SECRET: &str = "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";
const SCOPES: &str = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";
const AUTH_URI: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI: &str = "https://oauth2.googleapis.com/token";

#[derive(Serialize, Deserialize, Default)]
pub struct GeminiOAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds when access_token expires.
    pub expiry: i64,
    #[serde(default)]
    pub email: String,
}

fn tokens_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".axiom").join("gemini-oauth.json"))
}

/// Persist tokens with owner-only permissions.
fn save_tokens(tokens: &GeminiOAuthTokens) -> Result<(), String> {
    let path = tokens_path().ok_or("no HOME")?;
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

pub fn load_tokens() -> Option<GeminiOAuthTokens> {
    let path = tokens_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

const CODE_ASSIST: &str = "https://cloudcode-pa.googleapis.com/v1internal";

/// Return a valid access token, refreshing via the refresh_token if expired.
async fn valid_access_token() -> Option<String> {
    let tokens = load_tokens()?;
    if tokens.refresh_token.is_empty() {
        return None;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if !tokens.access_token.is_empty() && tokens.expiry - 60 > now {
        return Some(tokens.access_token);
    }
    // Refresh.
    let resp = reqwest::Client::new()
        .post(TOKEN_URI)
        .form(&[
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("refresh_token", tokens.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    let access = json.get("access_token")?.as_str()?.to_string();
    let expires_in = json.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600);
    let _ = save_tokens(&GeminiOAuthTokens {
        access_token: access.clone(),
        expiry: now + expires_in,
        ..tokens
    });
    Some(access)
}

/// Discover the Code Assist project id for the signed-in account.
async fn code_assist_project(access_token: &str) -> Option<String> {
    let resp = reqwest::Client::new()
        .post(format!("{CODE_ASSIST}:loadCodeAssist"))
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "metadata": { "pluginType": "GEMINI" } }))
        .send()
        .await
        .ok()?;
    let json: serde_json::Value = resp.json().await.ok()?;
    json.get("cloudaicompanionProject")
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// Try the free Code Assist tier (used by Space). Returns:
///   Ok(Some(text)) — signed in and the call succeeded
///   Ok(None)       — not signed in (caller falls back to API key)
///   Err(msg)       — signed in but the call failed (real error to surface)
pub async fn try_code_assist(
    model: &str,
    contents: &[serde_json::Value],
) -> Result<Option<String>, String> {
    let Some(access_token) = valid_access_token().await else {
        return Ok(None);
    };
    let project = code_assist_project(&access_token).await;
    let mut envelope = serde_json::json!({
        "model": model,
        "request": { "contents": contents },
    });
    if let Some(project) = project {
        envelope["project"] = serde_json::Value::String(project);
    }
    let resp = reqwest::Client::new()
        .post(format!("{CODE_ASSIST}:generateContent"))
        .bearer_auth(&access_token)
        .json(&envelope)
        .send()
        .await
        .map_err(|e| format!("Network error reaching Gemini (Login): {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        if status.as_u16() == 429 {
            return Err("Free Gemini limit reached for now — wait a moment and try again.".to_string());
        }
        return Err(format!("Gemini (Login) error {status}: {}", &body.chars().take(300).collect::<String>()));
    }
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Invalid Gemini response: {e}"))?;
    // Code Assist nests the normal response under `.response`.
    let root = json.get("response").unwrap_or(&json);
    let text = root["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default();
    if text.is_empty() {
        return Err("Gemini (Login) returned no text.".to_string());
    }
    Ok(Some(text))
}

/// Whether the user has completed Gemini OAuth login.
#[tauri::command]
pub fn gemini_oauth_status() -> serde_json::Value {
    match load_tokens() {
        Some(t) if !t.refresh_token.is_empty() => {
            serde_json::json!({ "loggedIn": true, "email": t.email })
        }
        _ => serde_json::json!({ "loggedIn": false }),
    }
}

/// Remove stored Gemini OAuth tokens (log out).
#[tauri::command]
pub fn gemini_oauth_logout() -> Result<(), String> {
    if let Some(path) = tokens_path() {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// Run the full OAuth login flow. Blocks until the browser redirect completes
/// (or times out). Returns the signed-in email on success.
#[tauri::command]
pub async fn gemini_oauth_login(_app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(run_login_flow)
        .await
        .map_err(|e| e.to_string())?
}

fn run_login_flow() -> Result<serde_json::Value, String> {
    // 1. Bind a localhost callback server on an ephemeral port.
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind failed: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth2callback");

    // 2. Build the consent URL and open the browser.
    let auth_url = format!(
        "{AUTH_URI}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        urlencode(CLIENT_ID),
        urlencode(&redirect_uri),
        urlencode(SCOPES),
    );
    open_browser(&auth_url)?;

    // 3. Wait for the redirect with ?code=...
    let code = wait_for_code(&listener)?;

    // 4. Exchange the code for tokens.
    let tokens = exchange_code(&code, &redirect_uri)?;
    let email = tokens.email.clone();
    save_tokens(&tokens)?;
    Ok(serde_json::json!({ "loggedIn": true, "email": email }))
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

/// Block on the callback server until Google redirects with the auth code.
fn wait_for_code(listener: &TcpListener) -> Result<String, String> {
    // Single-shot: accept one connection, parse the GET line for ?code=.
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
        // GET /oauth2callback?code=XXX&scope=... HTTP/1.1
        let code = request_line
            .split_whitespace()
            .nth(1)
            .and_then(|path| path.split('?').nth(1))
            .and_then(|query| {
                query.split('&').find_map(|kv| {
                    let mut it = kv.splitn(2, '=');
                    match (it.next(), it.next()) {
                        (Some("code"), Some(v)) => Some(urldecode(v)),
                        _ => None,
                    }
                })
            });

        let body = if code.is_some() {
            "<html><body style='font-family:system-ui;background:#0e0e0e;color:#eee;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h2>AXIOM is signed in.</h2><p>You can close this tab and return to AXIOM.</p></div></body></html>"
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
            return Ok(code);
        }
        return Err("no authorization code in callback".into());
    }
    Err("callback server closed without a code".into())
}

fn exchange_code(code: &str, redirect_uri: &str) -> Result<GeminiOAuthTokens, String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(TOKEN_URI)
        .form(&[
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .map_err(|e| format!("token request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!("token exchange failed ({status}): {text}"));
    }

    #[derive(Deserialize)]
    struct TokenResp {
        access_token: String,
        #[serde(default)]
        refresh_token: String,
        #[serde(default)]
        expires_in: i64,
    }
    let tr: TokenResp = resp.json().map_err(|e| e.to_string())?;
    let expiry = now_secs() + tr.expires_in.max(0);
    let email = fetch_email(&tr.access_token).unwrap_or_default();
    Ok(GeminiOAuthTokens {
        access_token: tr.access_token,
        refresh_token: tr.refresh_token,
        expiry,
        email,
    })
}

fn fetch_email(access_token: &str) -> Option<String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access_token)
        .send()
        .ok()?;
    let v: serde_json::Value = resp.json().ok()?;
    v.get("email").and_then(|e| e.as_str()).map(String::from)
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
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
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
