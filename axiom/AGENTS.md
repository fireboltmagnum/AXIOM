# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## AXIOM Tool Use

Use the AXIOM tools deliberately. They are meant to reduce guessing before edits, not replace reading exact source when exact source matters.

### `todo_list`

- Use `todo_list` for any task with 3+ discrete steps, any long-running implementation, or any task where progress can become ambiguous.
- Start with `action=create` and a short title before doing the work.
- Use `action=set_current` before starting a step.
- Use `action=check`, `action=fail`, or `action=skip` immediately when a step ends; do not batch status updates at the end.
- Use `action=add` when new necessary work is discovered.
- Use `action=read` when resuming or when unsure what remains.
- Do not create todo lists for tiny one-step answers, simple questions, or trivial edits.

### `understand_code`

- Use `understand_code` as the fast "Understand Anything"-style source map for unfamiliar files or folders.
- Use it when you need a structured overview of paths, languages, imports, exports, and symbols before deciding what to read or edit.
- Prefer it before large edits, broad refactors, or touching modules you have not inspected.
- Treat its output as a navigation aid only. Always use `read` for the exact lines before making precise edits.
- Use it for per-file/per-folder structure. Use `code_graph` for cross-file relationships, and `flow_graph` for behavior or debugging flow.

### `code_graph`

- Use `code_graph` as the Graphify-style codebase relationship tool.
- Use `code_graph action=index` in rigorous mode for unfamiliar medium/large codebases when imports, exports, symbol ownership, dependency direction, or cross-file relationships matter.
- Use `code_graph action=search` to find files/symbols/modules related to a concept.
- Use `code_graph action=neighbors` to inspect what a file, symbol, or module touches directly.
- Use `code_graph action=path` to answer "how is X connected to Y?" questions.
- Do not use `code_graph` for non-code documents; use `sparse_tree_grep` for documents and `knowledge_graph` for durable non-code facts.
- After `code_graph` narrows the target, still use `read` before editing exact code.

### `flow_graph`

- Use `flow_graph` when behavior matters: execution flow, data movement, error paths, side effects, events, async/callback paths, or debugging.
- Use `flow_graph action=analyze` for static flow before debugging complex behavior.
- Use `flow_graph action=path` for questions like "what happens from X to Y?", "how does user input reach the model call?", or "what path causes this state change?"
- Use `flow_graph action=data` for value provenance: where a variable/input comes from, how it transforms, and where it is returned, stored, rendered, written, or sent.
- Use `flow_graph action=effects` for file I/O, env vars, network calls, subprocesses, database calls, global state, event emit/listen/handle code, throws, and catches.
- Use `flow_graph action=explain` to inspect one node's incoming/outgoing flow.
- Use `flow_graph action=debug` or `action=trace` only when running the command/test is useful and acceptable. These actions execute the command with a timeout, capture stdout/stderr, parse stack frames, and map failures back to saved flow graph nodes.
- `flow_graph` currently provides static flow plus command debug traces. It is not yet a full runtime instrumentation timeline; do not claim it proves every runtime branch unless the command trace actually observed it.

### `sparse_tree_grep`

- Use `sparse_tree_grep` for long non-code documents such as books, PDFs, transcripts, research notes, logs, and design docs.
- Do not use `sparse_tree_grep` for source code. Use `rg`, `read`, `understand_code`, `code_graph`, and `flow_graph` for code.
- Use `sparse_tree_grep action=compile` before answering detailed questions about a long document that has not been indexed yet. `compile` builds the expandable JSON tree with chunks, byte ranges, line/page markers, lightweight summaries, keywords, entities, phrases, and optional local embeddings.
- Use `sparse_tree_grep action=search` to cheaply find candidate scenes/sections across the compiled JSON tree before reading exact text. Search uses entity, phrase, action-signal, lexical, and optional embedding reranking, so it can find paraphrases like "fight scene" matching "gunfight" or "brawl".
- Use `sparse_tree_grep action=expand` when a root node looks relevant but the exact occurrence is still unclear. Expanding shows child nodes and occurrence locations without loading large source text.
- Use `sparse_tree_grep action=describe` on the best candidate `chunkId` or `nodeId` before extraction when there are multiple similar hits. `describe` lazily creates/stores compact scene or section descriptions for only the promising chunks, including entities, actions, settings, evidence sentences, and neighboring chunks.
- Use `sparse_tree_grep action=extract` only after search/expand/describe has narrowed the target. Extract exact source text before quoting, summarizing a specific passage, or making fine-grained claims.
- Preferred workflow for "find the fight scene between Anna and Gosh": `compile` the book if needed, `search` the natural-language query, `describe` the top few candidate chunks, then `extract` the exact chunk that matches.

### RepairLoop + FailureFingerprintIndex

- RepairLoop runs automatically after code edits when AXIOM settings enable it. Do not manually trigger broad verification before the automatic loop has a chance to run.
- When RepairLoop reports `FailureFingerprintIndex recalls`, treat them as prior failure-memory hints. They can identify repeated compiler/test/runtime failure shapes and previous repair paths that later passed.
- Use the recalled hint only when it matches the current parsed failure. Exact source, current stack traces, and current verifier output override old memory.
- If a fingerprint says a previous repair passed after touching specific files, inspect those files and the current failing owner before editing. Do not blindly replay the old fix.
- Repeated fingerprint hits mean the problem shape is recurring; prefer the smallest owner-local repair and avoid broad rewrites.

### ContextLedger

- ContextLedger is internal context hygiene. It records which Context Agent recall items were injected, how many tokens they cost, and whether the task later succeeded or failed.
- When enabled, ContextLedger may suppress repeated low-ROI context before it reaches the system prompt. Treat missing recall as intentional trimming, not a reason to manually dump every memory store.
- If a task needs exact source truth, use the relevant tool (`read`, `rg`, `flow_graph`, `code_graph`, `sparse_tree_grep extract`) instead of assuming omitted context was irrelevant forever.
- ContextLedger outcomes are coarse correlations. Current files, current verifier output, and explicit user instructions override old context ROI history.
- Prefer compact, evidence-backed context over broad memory injection. The ledger rewards context that leads to verified progress and penalizes stale context that repeatedly correlates with failures.

### BenchmarkMode

- BenchmarkMode is AXIOM's strict coding-benchmark discipline for smaller models such as Gemma 31B. Follow it when the system prompt includes `AXIOM BenchmarkMode`.
- When the Evidence Pack includes `BugLens ranked suspects`, inspect those files/functions first. BugLens combines stack/path mentions, symbol declarations, and ripgrep density; it is a localization priority list, not proof.
- Localize before editing. Use `rg`/`read` plus `understand_code`, `code_graph`, or `flow_graph` until the smallest owning file/function/class is known.
- Make the smallest targeted patch that addresses the current evidence. Do not refactor unrelated code, rename broadly, or rewrite working modules for style.
- After edits, RepairLoop may run a verifier ladder: targeted verifier first, then broader cheap verifiers when the targeted check passes. If a later verifier fails, keep the localized fix and repair only the newly exposed broader failure.
- If the same failure repeats twice, stop editing from memory and re-localize from exact verifier output and source.
- If failure count grows sharply, assume the last patch was too broad. Narrow the scope before another edit.

### Tool Selection Order

- For multi-step work, create/update `todo_list` first.
- For unfamiliar code structure, run `understand_code`.
- For cross-file relationships, run `code_graph`.
- For behavior/data/effects/debugging, run `flow_graph`.
- For long non-code documents, run `sparse_tree_grep compile/search/describe/extract`.
- For exact source truth, use `read`.
- For exact textual search, use `rg`/`find`/`ls` before broad shell commands.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple axiom sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing axiom Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s axiom-test -x 80 -y 24
tmux send-keys -t axiom-test "./axiom-test.sh" Enter
sleep 3 && tmux capture-pane -t axiom-test -p     # capture after startup
tmux send-keys -t axiom-test "your prompt here" Enter
tmux send-keys -t axiom-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t axiom-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/axiom-local-release --force
   cd /tmp
   /tmp/axiom-local-release/node/axiom --help
   /tmp/axiom-local-release/node/axiom --version
   /tmp/axiom-local-release/node/axiom
   /tmp/axiom-local-release/bun/axiom --help
   /tmp/axiom-local-release/bun/axiom --version
   ```
   Verify startup, model/account listing, and at least one real prompt with the intended default provider. Failures are release blockers unless the user explicitly accepts the risk.

3. **Brief the user on the WebAuthn flow before running anything**. Print exactly the following message and then stop and wait for the user to confirm in their next message:

   ```
   Before I run the release script, read this carefully:

   - `npm publish` uses WebAuthn 2FA.
   - A login URL will appear in the live bash output in this TUI. I will NOT see it until the command exits.
   - You must watch the bash output, cmd/ctrl-click the URL, log in in the browser, and select the "don't ask again for N minutes" option so publish can continue.
   - This may happen more than once during the release.

   Reply "ready" once you have read this and are watching the bash output. I will not run the release script until you do.
   ```

   Do not proceed to step 4 until the user explicitly confirms.

4. **Run the release script**:
   ```bash
   npm run release:patch    # fixes + additions
   npm run release:minor    # breaking changes
   ```
   Do not pass a `timeout` to the bash tool for this call. If publish fails partway, stop and report to the user what happened (which package failed, the error output) along with possible solutions. Never rerun the version bump on your own.

5. **After publish succeeds**:
   - Add fresh `## [Unreleased]` sections to package changelogs.
   - Commit with `Add [Unreleased] section for next cycle`.
   - Push `main` and the release tag.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
