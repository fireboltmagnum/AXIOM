AXIOM
Autonomous eXperimental Intelligence Orchestration Matrix.

v2 base. Forked from Pi (MIT, by Mario Zechner / earendil-works). AXIOM-specific cognitive layers are not in this base yet — see AXIOM research paper full.txt for the target architecture.

Packages
Package	Description
@axiom/ai	Unified multi-provider LLM API (OpenAI, Anthropic, Google, Bedrock, Mistral, etc.)
@axiom/agent-core	Agent runtime with tool calling, transport, sessions, compaction
@axiom/coding-agent	Interactive coding agent CLI (AXIOM/axiom) with bash, edit, write, grep, find, read tools
@axiom/tui	Terminal UI library with differential rendering
Status
This is the pre-cognition base. It is a renamed fork of Pi at parity with upstream, with package names, binary name, and config directory rebranded:

npm packages: @earendil-works/pi-* → @axiom/*
CLI binary: pi → axiom
secondary CLI: pi-ai → axiom-ai
config dir: .pi/ → .axiom/ (per-project) and ~/.pi/agent/ → ~/.axiom/agent/ (per-user)
runtime app identity: axiomConfig in packages/coding-agent/package.json
User-facing PI_* env vars have been renamed to AXIOM_* (AXIOM_OFFLINE, AXIOM_PACKAGE_DIR, AXIOM_TELEMETRY, AXIOM_SKIP_VERSION_CHECK, AXIOM_SHARE_VIEWER_URL, AXIOM_CODING_AGENT_DIR, AXIOM_CODING_AGENT_SESSION_DIR, AXIOM_STARTUP_BENCHMARK). The remote update-check and install-telemetry hooks pointed at pi.dev have been stubbed — both are now no-ops.

The AXIOM cognitive layers (ASCoT reasoning stack, AKSE, IP validation, Context Agent knowledge graph, self-improvement loops) are not implemented here yet. They will be layered on top of this base in subsequent work.

The adjacent pi-reference/ directory is reference material only. The runtime project is this axiom/ directory.

Model Setup
The default model is Google AI Studio gemma-4-31b-it, with nvidia-nim/google/gemma-4-31b-it as the fallback. Local .env loading is enabled, and .env is ignored by git.

Retry behavior is configured in .axiom/settings.json: 3 agent-level retries with increasing delays, provider SDK retries disabled, and a 30s provider timeout. If Google exhausts its retries, AXIOM switches to NVIDIA NIM for the retry path. Gemma runs with visible thinking on by default; press Tab to cycle thinking levels and Shift+Tab to cycle AXIOM effort.

AXIOM Runtime
The first AXIOM core layer is enabled through .axiom/settings.json.

Fast path: safe tiny prompts such as greetings and status checks are answered locally, so they do not wait on Google or NVIDIA.
Trace: each task writes structured lifecycle records to .axiom/traces/*.jsonl.
IP validation: finalized assistant messages pass deterministic checks for empty replies, raw analysis leakage, raw provider JSON, and bad direct-response shape.
Effort profiles: off, fast, balanced, rigorous, and custom control router, fast path, trace, and IP validation independently.
Development
npm install --ignore-scripts   # install deps
npm run build                  # build all packages
npm run check                  # lint, format, type-check
./test.sh                      # run tests (skips LLM-dependent tests without API keys)
./axiom-test.sh                # run axiom from sources (any directory)
AXIOM                           # if ~/.local/bin/AXIOM has been installed
License
MIT. Upstream Pi is also MIT — see LICENSE.
