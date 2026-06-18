/// <reference types="vite/client" />

import type { AxiomBridge } from "./bridge";

// `window.axiom` is installed by src/bridge.ts (Tauri invoke/event wrapper).
declare global {
	interface Window {
		axiom: AxiomBridge;
	}
}
