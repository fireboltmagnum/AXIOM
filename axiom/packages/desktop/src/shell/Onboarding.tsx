// AXIOM first-run onboarding. Shows on every launch until the user has ANY
// working credential (Google login, ChatGPT login, or any API key in ~/.axiom/.env).
// A warm, guided setup rather than dumping people into the Settings panel.

import { useEffect, useState } from "react";
import { axiom } from "../bridge.ts";
import { AxiomWordmark } from "./Logo.tsx";
import "./Onboarding.css";

interface Status { loggedIn: boolean; email?: string }

// Providers a beginner is most likely to have a free key for. Mirrors Settings'
// catalog but trimmed to the recommended starting points.
const QUICK_KEYS: { id: string; label: string; keyName: string; hint: string }[] = [
	{ id: "google", label: "Google Gemini", keyName: "GEMINI_API_KEY", hint: "Free tier at aistudio.google.com/apikey" },
	{ id: "groq", label: "Groq", keyName: "GROQ_API_KEY", hint: "Fast free Llama models" },
	{ id: "openrouter", label: "OpenRouter", keyName: "OPENROUTER_API_KEY", hint: "One key, many free models" },
];

type Step = "welcome" | "signin" | "key";

export function Onboarding({ onDone }: { onDone: () => void }) {
	const [step, setStep] = useState<Step>("welcome");
	const [gemini, setGemini] = useState<Status>({ loggedIn: false });
	const [codex, setCodex] = useState<Status>({ loggedIn: false });
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [keyName, setKeyName] = useState(QUICK_KEYS[0].keyName);
	const [keyVal, setKeyVal] = useState("");

	// Re-check auth on mount; if already authed, this component shouldn't have
	// mounted, but guard anyway.
	useEffect(() => {
		void axiom.settings.geminiOAuthStatus().then(setGemini).catch(() => {});
		void axiom.settings.codexOAuthStatus().then(setCodex).catch(() => {});
	}, []);

	async function loginGoogle() {
		setBusy("google");
		setError("");
		try {
			const res = await axiom.settings.geminiOAuthLogin();
			setGemini(res);
			if (res.loggedIn) {
				// Default everyone to the free Gemini tier (unified multimodal).
				await axiom.settings.writeEnv({
					AXIOM_MODEL_MODE: "unified",
					AXIOM_PRIMARY_PROVIDER: "google",
					AXIOM_PRIMARY_MODEL: "gemini-2.5-flash",
					AXIOM_SPACE_PROVIDER: "google",
					AXIOM_SPACE_MODEL: "gemini-2.5-flash",
				}).catch(() => {});
				finish();
			}
		} catch (err) {
			setError(`Google sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(null);
		}
	}

	async function loginChatGPT() {
		setBusy("codex");
		setError("");
		try {
			const res = await axiom.settings.codexOAuthLogin();
			setCodex(res);
			if (res.loggedIn) finish();
		} catch (err) {
			setError(`ChatGPT sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(null);
		}
	}

	async function saveKey() {
		if (!keyVal.trim()) {
			setError("Paste a key first, or sign in with Google above.");
			return;
		}
		setBusy("key");
		setError("");
		try {
			const updates: Record<string, string> = { [keyName]: keyVal.trim() };
			// Point the model selection at the provider whose key we just set.
			if (keyName === "GEMINI_API_KEY") {
				Object.assign(updates, { AXIOM_PRIMARY_PROVIDER: "google", AXIOM_PRIMARY_MODEL: "gemini-2.5-flash", AXIOM_SPACE_PROVIDER: "google", AXIOM_SPACE_MODEL: "gemini-2.5-flash", AXIOM_MODEL_MODE: "unified" });
			}
			await axiom.settings.writeEnv(updates);
			finish();
		} catch (err) {
			setError(`Could not save key: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(null);
		}
	}

	function finish() {
		try { localStorage.setItem("axiom.onboarded", "1"); } catch { /* ignore */ }
		onDone();
	}

	return (
		<div className="ob-root">
			<div className="ob-aurora" />
			<div className="ob-card">
				<div className="ob-brandrow">
					<AxiomWordmark />
					<span className="ob-step">{step === "welcome" ? "Welcome" : step === "signin" ? "Step 1 of 1" : "Bring your own key"}</span>
				</div>

				{step === "welcome" && (
					<div className="ob-pane">
						<h1>Let's get you set up.</h1>
						<p className="ob-lead">
							AXIOM is a real coding agent built to be great on free models. Pick how you
							want to connect — it takes about ten seconds.
						</p>
						<div className="ob-points">
							<div><span className="ob-dot" /> Free Gemini tier with one Google sign-in</div>
							<div><span className="ob-dot" /> Or use a ChatGPT subscription, or any API key</div>
							<div><span className="ob-dot" /> Everything stays on your machine</div>
						</div>
						<button className="ob-btn primary lg" onClick={() => setStep("signin")}>Get started →</button>
					</div>
				)}

				{step === "signin" && (
					<div className="ob-pane">
						<h1>Connect AXIOM</h1>
						<p className="ob-lead">The free Google option is recommended — it covers both Chat and Space.</p>

						<button className="ob-provider google" disabled={busy === "google"} onClick={() => void loginGoogle()}>
							<span className="ob-pico">G</span>
							<span className="ob-ptext">
								<strong>{busy === "google" ? "Waiting for your browser…" : "Continue with Google"}</strong>
								<small>Free Gemini Code Assist tier · recommended</small>
							</span>
							<span className="ob-badge">Free</span>
						</button>

						<button className="ob-provider chatgpt" disabled={busy === "codex"} onClick={() => void loginChatGPT()}>
							<span className="ob-pico">↗</span>
							<span className="ob-ptext">
								<strong>{busy === "codex" ? "Waiting for your browser…" : "Continue with ChatGPT"}</strong>
								<small>Use your ChatGPT subscription as the coding model</small>
							</span>
						</button>

						<button className="ob-linkbtn" onClick={() => setStep("key")}>
							I'd rather paste an API key →
						</button>
						{error && <p className="ob-error">{error}</p>}
					</div>
				)}

				{step === "key" && (
					<div className="ob-pane">
						<h1>Use your own key</h1>
						<p className="ob-lead">Stored locally in <code>~/.axiom/.env</code>. Never leaves your machine.</p>

						<div className="ob-keyrow">
							<select value={keyName} onChange={(e) => { setKeyName(e.target.value); }}>
								{QUICK_KEYS.map((k) => <option key={k.id} value={k.keyName}>{k.label}</option>)}
							</select>
							<input
								type="password"
								placeholder="Paste your API key"
								value={keyVal}
								onChange={(e) => setKeyVal(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") void saveKey(); }}
								autoFocus
							/>
						</div>
						<p className="ob-keyhint">{QUICK_KEYS.find((k) => k.keyName === keyName)?.hint}</p>

						<div className="ob-actions">
							<button className="ob-linkbtn" onClick={() => setStep("signin")}>← Back to sign-in</button>
							<button className="ob-btn primary" disabled={busy === "key"} onClick={() => void saveKey()}>
								{busy === "key" ? "Saving…" : "Finish setup"}
							</button>
						</div>
						{error && <p className="ob-error">{error}</p>}
					</div>
				)}
			</div>
		</div>
	);
}
