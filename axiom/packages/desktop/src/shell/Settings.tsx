// AXIOM Settings — credentials, model selection, and account login.
// Reads/writes ~/.axiom/.env via the Tauri `settings` bridge and runs the OAuth
// flows: Gemini ("Login with Google", free Code Assist tier) and Codex ("Sign in
// with ChatGPT", subscription Codex/GPT models).
//
// Model selection has two modes:
//   • Unified — one MULTIMODAL model for both Chat and Space (no handoff needed).
//   • Split   — a MAIN (coding) model + a separate MULTIMODAL model for Space.
// Codex is not multimodal, so it is only offered as the main model in Split mode.

import { useEffect, useState } from "react";
import { axiom } from "../bridge.ts";
import "./Settings.css";

type Tab = "account" | "models" | "keys";
type ModelMode = "unified" | "split";

interface Provider {
	id: string;
	label: string;
	/** Default model id to set when this provider is chosen. */
	model: string;
	/** ~/.axiom/.env key for the API key (BYOK). */
	keyName?: string;
	/** Can this provider serve a multimodal (vision) model? */
	multimodal: boolean;
	/** OAuth identity, if any: lets the user sign in instead of pasting a key. */
	oauth?: "gemini" | "codex";
	hint?: string;
}

// The provider catalog. Mirrors AXIOM/Hermes's registered providers (env-api-keys),
// minus Nous and ambient-credential-only providers (Bedrock/Vertex ADC). `multimodal`
// gates which providers can fill the Space / unified slot.
const PROVIDERS: Provider[] = [
	{ id: "google", label: "Google Gemini", model: "gemini-2.5-flash", keyName: "GEMINI_API_KEY", multimodal: true, oauth: "gemini", hint: "Free Code Assist tier via Google login" },
	{ id: "openai", label: "OpenAI API", model: "gpt-4o", keyName: "OPENAI_API_KEY", multimodal: true, hint: "Metered OpenAI API key" },
	{ id: "openai-codex", label: "ChatGPT Codex", model: "gpt-5.5", multimodal: false, oauth: "codex", hint: "ChatGPT subscription coding model" },
	{ id: "anthropic", label: "Anthropic Claude", model: "claude-sonnet-4-6", keyName: "ANTHROPIC_API_KEY", multimodal: true },
	{ id: "openrouter", label: "OpenRouter", model: "openrouter/auto", keyName: "OPENROUTER_API_KEY", multimodal: true, hint: "One key, many models" },
	{ id: "xai", label: "xAI Grok", model: "grok-2-vision", keyName: "XAI_API_KEY", multimodal: true },
	{ id: "nvidia-nim", label: "NVIDIA NIM", model: "google/gemma-4-31b-it", keyName: "NVIDIA_API_KEY", multimodal: false },
	{ id: "deepseek", label: "DeepSeek", model: "deepseek-chat", keyName: "DEEPSEEK_API_KEY", multimodal: false },
	{ id: "groq", label: "Groq", model: "llama-3.3-70b-versatile", keyName: "GROQ_API_KEY", multimodal: false },
	{ id: "cerebras", label: "Cerebras", model: "llama-3.3-70b", keyName: "CEREBRAS_API_KEY", multimodal: false },
	{ id: "mistral", label: "Mistral", model: "mistral-large-latest", keyName: "MISTRAL_API_KEY", multimodal: false },
	{ id: "together", label: "Together", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", keyName: "TOGETHER_API_KEY", multimodal: false },
	{ id: "fireworks", label: "Fireworks", model: "accounts/fireworks/models/llama-v3p3-70b-instruct", keyName: "FIREWORKS_API_KEY", multimodal: false },
	{ id: "moonshotai", label: "Moonshot (Kimi)", model: "kimi-k2", keyName: "MOONSHOT_API_KEY", multimodal: false },
	{ id: "zai", label: "Z.AI (GLM)", model: "glm-4.6", keyName: "ZAI_API_KEY", multimodal: true },
];

const byId = (id: string) => PROVIDERS.find((p) => p.id === id);

export function Settings({ onClose }: { onClose: () => void }) {
	const [tab, setTab] = useState<Tab>("account");
	const [env, setEnv] = useState<Record<string, string>>({});
	const [gemini, setGemini] = useState<{ loggedIn: boolean; email?: string }>({ loggedIn: false });
	const [codex, setCodex] = useState<{ loggedIn: boolean; email?: string }>({ loggedIn: false });
	const [busy, setBusy] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		void axiom.settings.read().then(setEnv);
		void axiom.settings.geminiOAuthStatus().then(setGemini);
		void axiom.settings.codexOAuthStatus().then(setCodex);
	}, []);

	const mode: ModelMode = (env.AXIOM_MODEL_MODE as ModelMode) ?? "unified";
	const mainProvider = env.AXIOM_PRIMARY_PROVIDER ?? "google";
	const spaceProvider = env.AXIOM_SPACE_PROVIDER ?? mainProvider;

	function setKey(key: string, value: string) {
		setEnv((cur) => ({ ...cur, [key]: value }));
	}

	async function save(updates: Record<string, string>) {
		setBusy("save");
		setError("");
		try {
			await axiom.settings.writeEnv(updates);
			setEnv((cur) => ({ ...cur, ...updates }));
			await axiom.agent.abort().catch(() => {});
			setSaved(true);
			setTimeout(() => setSaved(false), 1600);
		} catch (err) {
			setError(`Could not save settings: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(null);
		}
	}

	// Choosing the main/unified model. In unified mode it also drives Space.
	function chooseMain(p: Provider) {
		const updates: Record<string, string> = {
			AXIOM_PRIMARY_PROVIDER: p.id,
			AXIOM_PRIMARY_MODEL: p.model,
		};
		if (mode === "unified") {
			// Unified must be multimodal; mirror it into the Space slot too.
			updates.AXIOM_SPACE_PROVIDER = p.id;
			updates.AXIOM_SPACE_MODEL = p.model;
		}
		void save(updates);
	}

	function chooseSpace(p: Provider) {
		void save({ AXIOM_SPACE_PROVIDER: p.id, AXIOM_SPACE_MODEL: p.model });
	}

	function setMode(next: ModelMode) {
		const updates: Record<string, string> = { AXIOM_MODEL_MODE: next };
		if (next === "unified") {
			// Collapse onto the main model — but only if it's multimodal; otherwise
			// fall back to a sensible multimodal default (Gemini).
			const main = byId(mainProvider);
			const target = main?.multimodal ? main : byId("google")!;
			updates.AXIOM_PRIMARY_PROVIDER = target.id;
			updates.AXIOM_PRIMARY_MODEL = target.model;
			updates.AXIOM_SPACE_PROVIDER = target.id;
			updates.AXIOM_SPACE_MODEL = target.model;
		}
		void save(updates);
	}

	async function oauthLogin(kind: "gemini" | "codex") {
		setBusy(`login-${kind}`);
		setError("");
		try {
			const result = kind === "gemini"
				? await axiom.settings.geminiOAuthLogin()
				: await axiom.settings.codexOAuthLogin();
			if (kind === "gemini") {
				setGemini(result);
			} else {
				setCodex(result);
				await save({
					AXIOM_MODEL_MODE: "split",
					AXIOM_PRIMARY_PROVIDER: "openai-codex",
					AXIOM_PRIMARY_MODEL: "gpt-5.5",
					AXIOM_SPACE_PROVIDER: env.AXIOM_SPACE_PROVIDER || "google",
					AXIOM_SPACE_MODEL: env.AXIOM_SPACE_MODEL || "gemini-2.5-flash",
				});
			}
		} catch (err) {
			setError(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(null);
		}
	}

	async function oauthLogout(kind: "gemini" | "codex") {
		setError("");
		try {
			if (kind === "gemini") { await axiom.settings.geminiOAuthLogout(); setGemini({ loggedIn: false }); }
			else { await axiom.settings.codexOAuthLogout(); setCodex({ loggedIn: false }); }
		} catch (err) {
			setError(`Sign out failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const multimodalProviders = PROVIDERS.filter((p) => p.multimodal);

	return (
		<div className="settings-overlay" onClick={onClose}>
			<div className="settings-modal" onClick={(e) => e.stopPropagation()}>
				<nav className="settings-rail">
					<div className="rail-title">Settings</div>
					<div className="settings-tabs">
						<button className={tab === "account" ? "on" : ""} onClick={() => setTab("account")}>
							<span className="tico" aria-hidden="true">◆</span> Account
						</button>
						<button className={tab === "models" ? "on" : ""} onClick={() => setTab("models")}>
							<span className="tico" aria-hidden="true">⚇</span> Models
						</button>
						<button className={tab === "keys" ? "on" : ""} onClick={() => setTab("keys")}>
							<span className="tico" aria-hidden="true">⚷</span> API Keys
						</button>
					</div>
				</nav>

				<header className="settings-head">
					<h2>{tab === "account" ? "Account" : tab === "models" ? "Models" : "API Keys"}</h2>
					<button className="settings-close" onClick={onClose} aria-label="Close settings">✕</button>
				</header>

				<div className="settings-body">
					{tab === "account" && (
						<section className="settings-section">
							<h3>Sign in</h3>
							<p className="settings-hint">
								Use a subscription instead of a metered API key. Sign in with Google for the free
								Gemini tier, or with ChatGPT to use your Codex/GPT subscription as the coding model.
							</p>

							<div className="settings-oauth-row">
								<div className="settings-oauth-info">
									<strong>Google (Gemini)</strong>
									<small>Free Code Assist tier · multimodal · works for Chat & Space</small>
								</div>
								{gemini.loggedIn ? (
									<div className="settings-account">
										<span className="settings-led on" />
										<span className="settings-account-name">{gemini.email || "Signed in"}</span>
										<button className="settings-btn ghost" onClick={() => void oauthLogout("gemini")}>Sign out</button>
									</div>
								) : (
									<button className="settings-btn primary" disabled={busy === "login-gemini"} onClick={() => void oauthLogin("gemini")}>
										{busy === "login-gemini" ? "Waiting for browser…" : "Login with Google"}
									</button>
								)}
							</div>

							<div className="settings-oauth-row">
								<div className="settings-oauth-info">
									<strong>ChatGPT (Codex)</strong>
									<small>Your ChatGPT subscription · coding model only (not multimodal)</small>
								</div>
								{codex.loggedIn ? (
									<div className="settings-account">
										<span className="settings-led on" />
										<span className="settings-account-name">{codex.email || "Signed in"}</span>
										<button className="settings-btn ghost" onClick={() => void oauthLogout("codex")}>Sign out</button>
									</div>
								) : (
									<button className="settings-btn primary" disabled={busy === "login-codex"} onClick={() => void oauthLogin("codex")}>
										{busy === "login-codex" ? "Waiting for browser…" : "Sign in with ChatGPT"}
									</button>
								)}
							</div>
						</section>
					)}

					{tab === "models" && (
						<section className="settings-section">
							<h3>How AXIOM uses models</h3>
							<div className="settings-mode">
								<button
									className={`settings-mode-card${mode === "unified" ? " on" : ""}`}
									onClick={() => setMode("unified")}
								>
									<strong>One multimodal model</strong>
									<small>Same model for Chat and Space. It sees the board directly — no handoff needed.</small>
								</button>
								<button
									className={`settings-mode-card${mode === "split" ? " on" : ""}`}
									onClick={() => setMode("split")}
								>
									<strong>Two models</strong>
									<small>A strong coding model for Chat + a multimodal model for Space. Use “Transfer to Chat” to hand a design across.</small>
								</button>
							</div>

							<h3 style={{ marginTop: 18 }}>{mode === "unified" ? "Multimodal model (Chat + Space)" : "Main model (Chat / coding)"}</h3>
							<p className="settings-hint">
								{mode === "unified"
									? "Must be multimodal so it can read the Space board. Codex is hidden here (it isn’t multimodal)."
									: "Your coding brain for Chat. Codex (ChatGPT login) lives here."}
							</p>
							<div className="settings-providers">
								{(mode === "unified" ? multimodalProviders : PROVIDERS).map((p) => (
									<button
										key={p.id}
										className={`settings-provider${mainProvider === p.id ? " on" : ""}`}
										onClick={() => chooseMain(p)}
									>
										<strong>{p.label}</strong>
										<small>{p.model}</small>
										{p.oauth && <span className="settings-tag">{p.oauth === "gemini" ? "Google login" : "ChatGPT login"}</span>}
									</button>
								))}
							</div>

							{mode === "split" && (
								<>
									<h3 style={{ marginTop: 18 }}>Multimodal model (Space)</h3>
									<p className="settings-hint">Reads the whiteboard. Multimodal only — Codex can’t go here.</p>
									<div className="settings-providers">
										{multimodalProviders.map((p) => (
											<button
												key={p.id}
												className={`settings-provider${spaceProvider === p.id ? " on" : ""}`}
												onClick={() => chooseSpace(p)}
											>
												<strong>{p.label}</strong>
												<small>{p.model}</small>
											</button>
										))}
									</div>
								</>
							)}
						</section>
					)}

					{tab === "keys" && (
						<section className="settings-section">
							<h3>API keys (bring your own)</h3>
							<p className="settings-hint">Stored locally in ~/.axiom/.env. Leave blank to use a sign-in (Google / ChatGPT) instead.</p>
							{PROVIDERS.filter((p) => p.keyName).map((p) => (
								<label key={p.id} className="settings-field">
									<span>{p.label}{p.multimodal ? "" : " · text only"}</span>
									<input
										type="password"
										placeholder={`${p.keyName}…`}
										value={env[p.keyName!] ?? ""}
										onChange={(e) => setKey(p.keyName!, e.target.value)}
										onBlur={() => save({ [p.keyName!]: env[p.keyName!] ?? "" })}
									/>
								</label>
							))}
						</section>
					)}
				</div>

				<footer className="settings-foot">
					{error && <span className="settings-error">{error}</span>}
					{saved && <span className="settings-saved">Saved ✓</span>}
					<button className="settings-btn" onClick={onClose}>Done</button>
				</footer>
			</div>
		</div>
	);
}
