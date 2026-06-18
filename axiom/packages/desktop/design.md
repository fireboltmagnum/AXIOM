# AXIOM Desktop — Design Spec

> _The operating system for human–agent collaboration._
> A macOS-first Electron app: a browser-style tabbed shell over **one agent brain per project**, surfaced as **Chat · Space · Dashboard · IDE**.

This is the build spec distilled from the UI mockups. It is the single source of truth for the front-end. Build order is at the bottom.

---

## 0. The keystone

A project has **one agent session**. Chat, IDE, Space, and Dashboard are *windows onto that same session*. A tab is just `{ surface, projectId, viewState }`. "The agent is present in Space" is not a feature — it falls out of surfaces sharing a brain. Everything else serves this.

The agent core already exists (`@axiom/coding-agent`, `createAgentSession`). The desktop app is a **presentation layer** over it — it does not reimplement the agent.

---

## 1. Design language ("warm Linear")

Restraint + clean structure, but rounded and friendly. The look comes from hierarchy and space, not decoration.

### Accent
- **Coral** `#FF7A6B` — the one accent, used sparingly (primary buttons, active tab, focus rings, selection, *your* cursor in Space). Everything else neutral.

### Color tokens (dark-first, light parallel)
| Token | Dark | Light |
|---|---|---|
| `bg/base` | `#0E0E10` | `#FCFCFD` |
| `bg/elevated` | `#161618` | `#FFFFFF` |
| `bg/overlay` | `#1E1E22` | `#FFFFFF` + shadow |
| `border/hairline` | `rgba(255,255,255,.06)` | `rgba(0,0,0,.08)` |
| `text/primary` | `#EDEDEF` | `#1A1A1E` |
| `text/secondary` | `#A0A0A8` | `#5A5A63` |
| `text/muted` | `#6E6E76` | `#8A8A93` |
| `accent` | `#FF7A6B` | `#F1604F` |
| `success / warn / error` | desaturated green / amber / red |

### Type
- Chrome: **Inter** (or Geist). Scale: 11 / 12 / 13 / 14 / 16 / 20 / 24. Body 13–14. Weights 400/500, 600 for emphasis. Slight negative tracking on headings.
- Personality (model chip, Space ink): **Excalifont**.
- Code: a mono (JetBrains Mono / Geist Mono).

### Space, shape, motion
- 4px grid: 4 / 8 / 12 / 16 / 24 / 32.
- Radii: 6–8 on controls/cards, 10–12 on panels. Not pill-everything.
- Motion: 120–180ms ease-out, opacity + small translate, **no bounce**.
- Elevation: surface token + hairline; soft shadow **only** on true overlays.
- Icons: Lucide base, lightly customized.

---

## 2. App shell

```
┌──────────────────────────────────────────────────────────────────────┐
│ ◖◖◖  ▢ Chat ·····  ▢ Space ··  ▢ auth.ts ··  +    🌐 💬 ▦ ▤   ☾  ⚙   │ ← titlebar = tab bar
├──────────────────────────────────────────────────────────────────────┤
│                        ( active surface )                              │
└──────────────────────────────────────────────────────────────────────┘
```

- **Tabs**: icon + title + close; reorderable; **persist across restarts**. A surface can be open multiple times.
- **`+`** → the **new-tab launcher** (§7).
- **Bookmark rail** (right of tabs): one-click spawn `🌐 SPACE · 💬 Chat · ▦ Dashboard · ▤ IDE`. Same icons/identity as the launcher cards.
- **Far right**: theme toggle, settings.
- **mac-first**: inset traffic lights; the tab bar is the draggable titlebar; subtle window vibrancy behind `bg/base`.
- **Shortcuts**: `⌘T` new tab, `⌘W` close, `⌘1–9` jump, `⌘K` search/open (lives in Dashboard search + launcher omnibox — **no separate floating palette**).

---

## 3. Chat surface

Calm by default, transparent on demand. One **disclosure component** (chevron + label + meta) is reused for *thinking, steps, tool I/O, and the live "Working" state*.

### Turn lifecycle (a self-tidying glass cockpit)
1. Turn starts → **thinking streams live** (dimmed, growing).
2. Narration begins → thinking **auto-folds** to `▸ Thought for Ns`.
3. Tools run → each **step card auto-expands as it completes** (Detailed default); running shows `◐`.
4. Settled → finished turn stays detailed; **older turns auto-tidy** to narration-only.

```
LIVE                                   SETTLED (older, tidied)
▾ Thinking…                            ▸ Thought for 4s
  │ 111-6864477 is an order #, not…    Fixed the misread date and reorganized.
Fixing the misread date…               ▸ View steps (3)
▾ View steps
 ├ ⌨ execute_code   ◐ running
 ├ ✎ write organize.py        ✓
 └ $ bash python organize.py  ◐
Working ›
```

- **Typed tool cards**: `✎ edit/write`→diff, `$ bash`→output, `⌨ execute_code`→stdout, `🔍 read/gather_context`→paths, `🧠 memory`→recall.
- **Inline permission card**: Allow / Deny + "remember this session." (e.g. file-deletion requests.)
- **Composer**: `How can I help you today?` · `⬚ Work in a folder` (project scope) · `+` (attach files/images) · hand-drawn model chip (`gemini 3.5 flash ⌄`) · coral `Let's go →`.
- **Steering**: composer stays live while the agent runs → typed text queues as `/steer` chips ("sends after this step") + a **Stop**.
- Renders real `AgentSession` events 1:1 (`thinking_*`, `tool_execution_*`, assistant text, in-flight turn).

---

## 4. Space surface

tldraw engine, Excalidraw look (Excalifont + rough.js). Clean frame, expressive ink.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⊟ ← →  Reading Notes / Bret Victor   ┌─ ▢◇◯ ↗ ─ ✎ T 🖼 ⬚ ⚡ ─┐  Share ◰ ▦│
│ ▷                                    └──── top-center toolbar ────┘     │
│ ✎   ▢ hero.glb ⋯ ◌                                       · · · · · · · · │
│ 🔍  ┌──────────┐○╲___                                    · · · · · · · · │
│     │ 3D view  │     ╲○ ▢ notes.md            ◣ Agent     · · · · · · · · │
│     └──────────┘                                                         │
│  ⬤ space        ┌─ How can I help you today? ──────┐         ⊟ 21% ⊞    │
│  to talk        │ ⬚ Work in folder + gemini⌄ Let's go│                   │
└──────────────────────────────────────────────────────────────────────┘
```

- **Toolbar**: top-center (lock/hand/select/rect/diamond/ellipse/arrow/line/draw/text/image/eraser/frame), number shortcuts. Left vertical mini-rail (cursor/pencil/search). Left properties panel on selection. Zoom + minimap bottom-right. Dotted infinite canvas.
- **Preview node** (one per file): header (type icon, name, `⋯`, status) / **live interactive body** / footer (type·size·`⤢ open`) / edge **ports** for connections. Resizable; coral selection handles. **Offscreen/zoomed-out → poster thumbnail + paused** (virtualization is mandatory).
- **Preview tiers** (real preview when possible, rich card otherwise, **never fake**):
  - T1 native: `png jpg gif webp avif svg bmp` · `mp4 webm mov` · audio · `pdf` (pdf.js) · code (Monaco) · **html** (sandboxed interactive iframe).
  - T2 web libs: 3D `glb gltf obj(+mtl) stl ply dae fbx x3d wrl` (three.js) · `tif` (utif) · `exr hdr` (RGBE/EXR) · `tga` · `dxf`. `obj+mtl` together = one textured node.
  - T3 sidecar convert (ffmpeg/assimp/USD): `avi mkv` transcode · `usd*` · `abc` (→glb, geometry-only).
  - T4 rich card: `chan` (Nuke camera data) · `mtl` (companion file).
- **Multi-drop → auto-grid.** **Connections manual-only**, smooth bezier bindings.
- **On-canvas composer** (type to agent, always works) + **"space to talk" orb** (voice; LiveKit later).
- **Dual cursors**: you = **coral**, agent = **indigo**, named labels. The agent acts **visibly** (cursor travels, then performs the action).

---

## 5. Dashboard surface (Command Center)

The only surface with its own left sidebar. The landing surface.

- **Left nav**: Home · Spaces · Agents · Memory · Knowledge · Search · Checkpoints · Cognitive Replay · Metrics · Settings · Integrations · Billing · Team.
- **Top bar**: `Search everything (⌘K)` · theme · notifications · `New +`.
- **Home widgets** (modular grid): Workspace Overview cards (tasks · agents · progress · Live · avatars) · Active-Tasks **kanban** (Queued / Running / Waiting-for-Human / Completed) · live **Agent Activity Feed** · **Runtime Metrics** sparklines (Tokens Saved, Tool Calls, Successful/Failed Plans) · **AXIOM Diagnostics** (SparseTreeGrep, Planning, Memory) · Recent Workspaces · Recent Checkpoints.
- **Footer**: runtime status (Operational) + version.

---

## 6. IDE surface

VS Code shape with the agent docked right.

- Left activity bar + **Explorer** (file tree, git status U/M, modified dots) + **Monaco** editor (tabs, breadcrumb, real highlighting) + **the same Chat panel docked right** + status bar (branch, Ln/Col, indent, encoding, EOL, language).
- **Watch it edit live**: agent edits land in Monaco with change decorations while the chat narrates.

---

## 7. New-tab launcher

```
                    ▲ AXIOM
        ┌────────────────────────────────────┐
        │ 🔍 Search or open anything…   ⌘K   │
        └────────────────────────────────────┘
 Open a surface
 [ 🌐 SPACE ] [ 💬 Chat ] [ ▦ Dashboard ] [ ▤ IDE ]
        │ click → quick workspace picker (or ＋ New project)
 Recent
 ▢ Research Notes  Space 3m   ▢ SparseTreeGrepStore.ts  IDE 1h
```

- Omnibox doubles as `⌘K` (search workspaces/files/surfaces). Four surface cards match the bookmark rail; coral on hover. Clicking → **workspace picker** → surface opens bound to that project's agent brain. Recents span surfaces.

---

## 8. Model architecture

Two **user-selectable profiles** (same router underneath):

- **Unified** (default, easiest): one multimodal model for code + Space. One key, shared context, no handoff.
- **Split** (power users): text **code brain** (GLM-5.1 / Qwen3-Coder / DeepSeek / StepFun-3.7-free) + light multimodal **Space brain**. The Space brain owns *all* seeing and synthesizes a rich **`design.md` + file pointers**; the code brain builds from the spec (asks up when unclear).

Why the split is safe: the boundary is a **spec**, not shared perception (the coder doesn't need "red block left or right"). Space brain = light multimodal (**Gemini Flash-Lite** or **Qwen3-VL-Flash**), token-disciplined: read the structured board state, only vision media-node *content*, downscale screenshots.

Current launch default: **`gemini-3.5-flash`** (Google AI Studio), unified profile.

---

## 9. Tech stack

- **Shell**: Electron (consistent Chromium for WebGL/video/HTML/EXR previews; runs the Node/TS agent in-process). mac-first.
- **Canvas**: tldraw (custom shapes/embeds, arrow bindings, presence cursors, infinite camera) styled Excalidraw-ish.
- **Code views**: Monaco. **Previews**: three.js (3D), pdf.js, utif/RGBE (images), sandboxed iframes (html).
- **Agent**: `@axiom/coding-agent` in-process.
- **Collaboration (Phase 4)**: Yjs (board CRDT) + LiveKit Agents (voice + remote). Local-first until then.
- **Renderer**: React + the token system above. State per tab; one agent session per project.

---

## 10. Build order

- **P0 — Shell**: Electron window, tab bar + `+` launcher + bookmark rail, theme tokens (dark/light), Chat surface hosting `@axiom/coding-agent`. _← start here._
- **P1 — Space MVP**: tldraw board, T1 preview nodes, connections, toolbar, the aesthetic. Single user.
- **P2 — Agent in Space**: presence cursor + canvas tool API + the Chat→Space handoff (ask-on-handoff).
- **P3 — Heavy previews + perf**: three.js, sidecar conversions, viewport virtualization.
- **P4 — Multiplayer + voice**: Yjs + LiveKit.
- **Cross-cutting**: Dashboard, IDE, settings grow alongside once the shell exists.
