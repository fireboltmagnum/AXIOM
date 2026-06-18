use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiImage {
    mime_type: String,
    data: String,
}

#[derive(Deserialize)]
pub struct GeminiMessage {
    role: String,
    text: String,
    images: Option<Vec<GeminiImage>>,
}

fn mock_response(messages: &[GeminiMessage]) -> Option<String> {
    if std::env::var("AXIOM_SPACE_MOCK").ok().as_deref() != Some("1") {
        return None;
    }
    let image_count = messages
        .iter()
        .map(|message| message.images.as_ref().map_or(0, Vec::len))
        .sum::<usize>();
    let image_bytes = messages
        .iter()
        .flat_map(|message| message.images.as_deref().unwrap_or_default())
        .map(|image| image.data.len())
        .sum::<usize>();
    let has_scene = messages.iter().any(|message| {
        message.text.contains("Viewport bounds:")
            && message.text.contains("Board objects:")
            && message.text.contains("Board links:")
    });
    Some(format!(
        "LOCAL_SPACE_VISION_OK images={image_count} imageBytes={image_bytes} structuredScene={has_scene}"
    ))
}

fn api_key() -> Option<String> {
    [
        "GEMINI_API_KEY",
        "GOOGLE_AI_STUDIO_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
    ]
    .iter()
    .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()))
}

fn model() -> String {
    ["AXIOM_SPACE_MODEL", "GEMINI_MODEL"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()))
        // gemini-2.5-flash is the model served on the free tier (3.5-flash 404s /
        // is quota-starved). Space had been pinned to the dead 3.5-flash.
        .unwrap_or_else(|| "gemini-2.5-flash".to_string())
        .trim_start_matches("models/")
        .to_string()
}

fn clipped(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

#[tauri::command]
pub async fn gemini_prompt(messages: Vec<GeminiMessage>) -> Result<String, String> {
    if let Some(response) = mock_response(&messages) {
        return Ok(response);
    }

    let contents: Vec<serde_json::Value> = messages
        .into_iter()
        .map(|message| {
            let mut parts = vec![serde_json::json!({ "text": message.text })];
            for image in message.images.unwrap_or_default() {
                parts.push(serde_json::json!({
                    "inlineData": {
                        "mimeType": image.mime_type,
                        "data": image.data
                    }
                }));
            }
            serde_json::json!({
                "role": if message.role == "assistant" { "model" } else { "user" },
                "parts": parts
            })
        })
        .collect();

    // Prefer the free Code Assist tier via "Login with Google" (1000/day) over a
    // metered API key. Space used to be pinned to the API-key path on a dead
    // model; now it shares the same OAuth path as Chat.
    if let Some(text) = crate::gemini_oauth::try_code_assist(&model(), &contents).await? {
        return Ok(text);
    }

    let key = api_key().ok_or_else(|| {
        "Not signed in and no API key. Open Settings → Account → Login with Google (free), or set GEMINI_API_KEY in ~/.axiom/.env."
            .to_string()
    })?;

    let endpoint = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={key}",
        model()
    );
    let response = reqwest::Client::new()
        .post(endpoint)
        .json(&serde_json::json!({ "contents": contents }))
        .send()
        .await
        .map_err(|error| format!("Network error reaching Gemini: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read Gemini response: {error}"))?;
    if !status.is_success() {
        if status.as_u16() == 429 {
            return Err(
                "Gemini quota is exhausted. AXIOM did not retry, and your Space board was left unchanged."
                    .to_string(),
            );
        }
        return Err(format!("Gemini error {status}: {}", clipped(&body, 500)));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|error| format!("Invalid Gemini response: {error}"))?;
    let text = json["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default();
    if text.is_empty() {
        return Err("Gemini returned no text.".to_string());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::{mock_response, GeminiImage, GeminiMessage};

    #[test]
    fn mock_reports_visual_and_structured_space_context() {
        std::env::set_var("AXIOM_SPACE_MOCK", "1");
        let response = mock_response(&[GeminiMessage {
            role: "user".to_string(),
            text: "Viewport bounds: {}\nBoard objects: []\nBoard links: []".to_string(),
            images: Some(vec![GeminiImage {
                mime_type: "image/jpeg".to_string(),
                data: "encoded-jpeg".to_string(),
            }]),
        }])
        .expect("mock response");
        std::env::remove_var("AXIOM_SPACE_MOCK");

        assert!(response.contains("images=1"));
        assert!(response.contains("imageBytes=12"));
        assert!(response.contains("structuredScene=true"));
    }
}
