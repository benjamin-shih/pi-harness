# Changelog

All notable changes to this personal pi harness package are tracked here.

## Unreleased

### Added
- None.

### Changed
- None.

### Fixed
- None.

### Breaking
- None.

## 0.3.0 - 2026-05-05

### Added
- Ambient pi binding to the shared `.agents/tasks` control plane: pi can auto-bind/reuse tasks, inject task context, heartbeat leases, checkpoint meaningful turns, capture safe typed task-artifact metadata, and release current-session tasks on shutdown without slash-command usage.
- Consumption of the versioned `.agents` task API and candidate-root policy instead of hardcoding bootstrap-path binding rules in TypeScript.
- Consumption of `.agents` sensitive-path policy via `path-safety.sh`, keeping only Pi-specific UI and git-finalization behavior in the harness.
- Consumption of the shared `.agents` ambient execution-route API so Pi no longer owns execution-intent, profile, overlay, or guidance routing rules.
- Kitty/terminal titlebar spinner while an agent turn is running; idle tabs keep the compact `π` title.
- `/doctor` (`/doct` alias) for read-only harness health checks across package audit, model/context/git state, tools, memory-spine status, and AGENTS task binding.
- `/memory` for detailed memory-spine checkpoint, compaction, fallback, and diagnostic inspection.

### Changed
- `/status` now includes compact memory-spine health, entry counts, and active AGENTS task state.
- Centralized `.agents`/skills root configuration behind environment-aware shared helpers.
- Split cleanup-guard diff logic out of the main harness command extension.
- Updated the local Pi development dependency to `@mariozechner/pi-coding-agent@0.71.0`.
- Task-layer verification now includes a local real-script integration path when `AGENTS_SHARED_ROOT` is available.
- Harness audit now treats internally split directory extensions and same-name support modules as part of their owning runtime extension.
- System prompt guidance now asks agents to avoid level-3-and-deeper Markdown headings so terminal responses render cleanly.

### Fixed
- Safety gate now blocks bash writes to block-level sensitive paths and recursive grep/shell traversal over sensitive descendants.

### Breaking
- None.

## 0.2.0 - 2026-04-30

### Added
- Aesthetic polish with rounded prompt editor and rounded sent-prompt boxes.
- Harness mode command (`/mode`) for fast/default/deep/readonly/full operating modes.
- Harness status command (`/status`), now including harness audit health, plus visible session checkpoints (`/checkpoint`).
- Lightweight skill-routing reminders for standard and complex prompts.
- Behavioral safety-gate verification in `npm run verify`.
- `/skills-audit`, `npm run skills:audit`, and `npm run harness:audit` for skill graph, harness bloat, and stale-reference checks.
- Release-note drafting script and tracked pre-push validation hook.
- Automatic session-continuity extension with hidden checkpoints, footer memory status, and custom compaction summaries.
- Optional `ben-pi-latex-preview` package with lazy TeX/math-context activation.
- Post-change cleanup reminders for coding/file edits plus a one-shot major-change cleanup guard.

### Changed
- Bumped package metadata to `0.2.0` for the first real release tag.
- Split session continuity into a directory module with smaller checkpoint, prompt, redaction, and compaction internals.
- Folded prompt/card styling and the Catppuccin footer into one `ui-polish` extension module.
- Folded `/skills-audit` into `harness-commands.ts` and git-finalization checks into `safety-gate.ts` to reduce core extension count.
- Catppuccin theme now uses blue/sapphire-forward UI accents while the footer keeps its original mauve/pink segment colors.
- Sent prompt boxes are tighter, terminal-width-responsive rounded cards with blue borders, hot-reloadable styling, and no shaded interior fill.
- Live prompt editor border now uses Catppuccin green while sent prompt cards keep the existing blue border.
- Footer token and cost totals now include subagent usage recorded in the current session.
- CI now uses Node 24, Node-24-based GitHub actions, local harness audit, and package verification.
- Safety gate is now egress-focused: it blocks secret/private-file output, upload, and sensitive git inclusion, but no longer prompts for ordinary filesystem, package-manager, or destructive commands.
- LaTeX preview moved out of the core harness extension set into the optional lazy package.
- Display-equation guidance now asks agents to use `displaymath` environments, and the LaTeX preview renders every display equation in a response instead of stopping after ten.
- LaTeX preview widget chrome is quieter and no longer shows transient-storage or inline/display policy help text.

### Fixed
- LaTeX preview now ignores Markdown code fences/spans when extracting display math and falls back to plain text if Markdown rendering fails.
- LaTeX preview display extraction no longer carries the obsolete inline-render/capped-snippet path now that displaymath rendering is the supported flow.
- Footer extension statuses are now compact colored chips, and narrow terminal layouts drop state/model detail more aggressively instead of overflowing.
- Live prompt editor green border now survives pi's custom-editor border-color override during reload and recolors the full top/bottom border lines.
- Memory-spine custom compaction now strips bulky tool-result/thinking bodies, uses model-aware prompt/output budgets, sends provider system instructions, serializes structured exception details, persists fallback diagnostics, detects default compaction, and returns deterministic harness fallback summaries when model summarization fails.

### Breaking
- None.

## 0.1.0 - 2026-04-28

### Added
- Initial pi package manifest.
- Responsive Catppuccin footer extension.
- Safety gate extension for sensitive paths and risky operations.
- Prompt templates: `/simplify`, `/review`, `/handoff`.
- Catppuccin Mocha theme.
- GitHub Actions CI verification.

### Changed
- None.

### Fixed
- None.

### Breaking
- None.
