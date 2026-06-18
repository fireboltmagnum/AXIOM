import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// AXIOM Desktop — Vite + React renderer for the Tauri shell.
// Dev server runs on 1420 (Tauri's devUrl); the Rust side loads it.
export default defineConfig({
	plugins: [react()],
	clearScreen: false,
	server: { port: 1420, strictPort: true },
	// Excalidraw reads process.env at runtime; define a safe shim for the browser.
	define: {
		"process.env.IS_PREACT": JSON.stringify("false"),
	},
});
