<div align="center">

# AXIOM

**A real coding agent, built to be genuinely good on free models.**

Chat with your codebase, draw your ideas on an infinite canvas, and let an agent
do the work — without paying for a frontier-model subscription.

[Download](https://fireboltmagnum.github.io/AXIOM/) · [How it works](#how-it-works) · [Build from source](#build-from-source)

</div>

---

## Why this exists

Good agentic coding tools have mostly been gated behind a paywall. If you can
afford a top-tier model subscription, you get a great assistant. If you can't,
you're locked out.

AXIOM is the other path. It's designed from the ground up to be excellent on the
**free tiers** people already have access to — a free Google sign-in, a Groq key,
an OpenRouter account. Bring whatever you've got; AXIOM makes the most of it.

It is **pre-release** and improving fast. Some edges are rough. It is also real,
it runs locally, and it does actual work.

## What you get

- **Chat** — talk to your codebase. Ask questions, request changes, and watch the
  agent read, edit, and run things to get there.
- **Space** — an infinite canvas for thinking visually. Sketch an idea, drop in
  notes, and turn them into work.
- **Your keys, your machine** — credentials live in `~/.axiom/.env` and never
  leave your computer. Sign in with Google, ChatGPT, or paste an API key.
- **Multi-provider** — Google Gemini, Groq, OpenRouter, and more. Use what's free
  to you; switch any time in Settings.

## Getting started

1. **[Download the installer for your OS](https://fireboltmagnum.github.io/AXIOM/)** —
   macOS (Intel & Apple Silicon), Windows, and Linux.
2. Open AXIOM. A short setup asks how you want to connect.
3. **Continue with Google** for the free Gemini tier (recommended), or use a
   ChatGPT subscription, or paste any API key.

That's it. You're talking to your code.

## How it works

AXIOM runs the agent **in-process** on your machine — no remote backend sitting
between you and your code. The desktop app is built with [Tauri](https://tauri.app)
(a Rust shell around a web UI), and the agent core is TypeScript compiled to a
self-contained binary that the app launches locally.

Because everything runs on your hardware, your code and your keys stay with you.
The only thing that goes out is the request to whichever model provider you chose.

## Build from source

You'll need [Bun](https://bun.sh), [Node.js](https://nodejs.org) 22+, and the
[Rust toolchain](https://rustup.rs).

```bash
git clone https://github.com/fireboltmagnum/AXIOM.git
cd AXIOM/axiom
npm install

# Run the desktop app in dev mode
cd packages/desktop
npm run tauri dev

# Or produce an installer for your platform
npm run tauri build
```

Installers land in `packages/desktop/src-tauri/target/release/bundle/`.

## Project layout

| Path | What's there |
|------|--------------|
| `axiom/packages/desktop` | The Tauri desktop app (Chat, Space, Dashboard, IDE) |
| `axiom/packages/agent`   | The agent core, shipped as a local package |
| `docs/`                  | The landing & download page (GitHub Pages) |
| `.github/workflows/`     | Multi-OS build that publishes releases |

## Contributing

Issues and pull requests are welcome — bug fixes, provider support, and rough-edge
polish especially. AXIOM is early, so there's a lot of room to make it better.

---

<div align="center">

Made by **[Aditya Nair](https://github.com/fireboltmagnum)**

</div>
