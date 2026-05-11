# ben-pi-harness

Benjamin's personal [pi](https://pi.dev) harness package.

This package bundles the reusable parts of the local pi setup:

- extensions
- prompt templates
- themes
- package verification/release helpers

Machine-local pi state such as `settings.json`, `AGENTS.md`, auth files, and session history intentionally stays outside this package.

## Contents

```text
extensions/
  ui-polish/            Rounded prompt boxes and responsive Catppuccin footer
  harness-commands.ts   /mode, /status, /checkpoint, /skills-audit, ambient task binding, skill routing, and cleanup guards
  safety-gate.ts        Secret/private-file egress guardrails and git finalization checks
  session-continuity/   Automatic checkpoints and custom compaction summaries and diagnostics
prompts/
  handoff.md            Session/task handoff prompt
  review.md             Review prompt
  simplify.md           Simplification prompt
themes/
  catppuccin-mocha.json Catppuccin Mocha theme with blue-forward accents
scripts/
  verify.mjs            Local/CI package verification
  harness-audit.mjs     Harness structure, bloat, and stale-reference audit
  skills-audit.mjs      Shared skill graph validator and bloat summary
  changelog.mjs         Draft release notes from git commits
packages/
  ben-pi-latex-preview/ Optional lazy LaTeX/math preview package
```

## Optional LaTeX preview package

`packages/ben-pi-latex-preview` is a separate pi package. Its default extension is a lightweight lazy loader: it only imports the heavy renderer in TeX/math-looking projects or when an assistant response contains substantial LaTeX/math.

To enable it globally while keeping it outside the core harness package:

```json
{
  "packages": [
    "./packages/ben-pi-harness",
    "./packages/ben-pi-harness/packages/ben-pi-latex-preview"
  ]
}
```

## Ambient-first context

The normal workflow is to ask naturally; slash commands are inspect/override/admin/debug surfaces, not the primary UX. On each agent turn, the harness runs a deterministic ambient context assembler over ordered lanes such as rendering guidance, active mode, skill routing, cleanup guidance, subagent topology guidance for detailed work, active `.agents` task context, and bounded repo metadata. Standard/complex turns include a compact Ambient Context Receipt so the inferred context remains visible without requiring a command. Natural-language execution prompts such as “go ahead and implement” or “ship this end-to-end” activate an ambient execution protocol routed by the shared `.agents` `execution-route.sh` contract. The injected guidance asks the agent to use the selected primary execution profile, capability overlays, profile-aware subagents when useful, verification, simplification, and automatic commit/push of task-relevant verified changes with incremental commits for larger tasks. `/status` and `/doctor` expose the last route state as active, inactive, or safely degraded without exposing raw prompts or script-output details. Subagent topology remains guidance-only: the harness does not spawn subagents or track subagent usage in `/status` or final footers. Final assistant responses for nontrivial turns also get a terminal-width-aware compact visual harness footer covering ambient weight, safe execution route metadata when detected, task operational state, artifact metadata capture, and durable-memory write posture without exposing raw prompts, paths, or memory content. ANSI color rendering is supported for explicit display-only callers, but persisted assistant footers stay plain by default to keep transcripts and logs clean.

Pi reuses the shared `.agents/tasks` control plane through the versioned `.agents` task API. By default the harness looks under `$HOME/.agents`; set `AGENTS_SHARED_ROOT` when using a different checkout. For standard/complex prompts it attempts to bind or reuse an active task, inject compact task context, heartbeat during tool activity, checkpoint meaningful turns, capture safe typed task-artifact metadata, and release current-session leases on shutdown. `/doctor` also surfaces bounded lifecycle diagnostics from `.agents` such as active/terminal status, lease state, route metadata, event counts, blocker count, and next action without reading task files directly. It additionally shows read-only task retention, artifact-hygiene, archive, and archived-bundle delete counts from the shared retention API so task-package buildup is visible without enabling deletion/archive execution or path/content reporting. Task classification passes prompts through a private temporary file instead of raw argv, and session compaction uses git status without scanning untracked filenames.

The shared `.agents` scripts own project-root, bootstrap-path, sensitive-path, execution-route, artifact-capture, HTML artifact, and approved-memory policy via `task-api.sh info`, `task-candidate-root.sh`, `execution-route.sh`, `path-safety.sh`, `task-artifact-*.sh`, `html-artifact-policy.sh`, `memory-context.sh`, `memory-stats.sh`, and `memory-review.sh`; the TypeScript harness is only the Pi runtime adapter/UI layer. Set `AGENTS_SHARED_ROOT` to point at an alternate `.agents` checkout, `AGENTS_SKILLS_ROOT` to override the default skills root, and `TASKS_ROOT` to isolate task packages in tests. Approved task/project memory is considered automatically for scoped standard/complex turns. Nontrivial turns also include a short instruction to mention durable memory candidates in final responses. If a user explicitly asks to remember/list/review/promote/forget memory, Pi injects safe `.agents` admin-script guidance but still performs no hidden durable-memory write or review during prompt assembly. Bound task state is operational and may update automatically through `.agents/tasks` leases, heartbeats, checkpoints, status updates, and typed artifact metadata. Task artifacts are metadata-only, policy-filtered records such as edited paths or verification summaries; they do not copy raw prompts, transcripts, or file contents. Global memory, vector memory, and automatic memory promotion are intentionally not enabled.

For long reports or briefs that would be hard to scan in chat, `.agents` may steer the agent to create a local HTML artifact and keep the chat response concise. The harness surfaces that guidance and may open the completed local file only when the shared HTML auto-open decision enables it; it does not decide report structure or create artifacts on its own.

Task closure is explicit. Use `/close-task completed [reason]` or `/close-task blocked [reason]` when the active task should enter a terminal state. The command passes the reason through a private temporary file, calls `.agents/scripts/task-close.sh`, requests current-session lease release, and does not print raw closure text back into chat.

Async inbox support is a thin `.agents` adapter. `/inbox submit <request>` stores the request through `.agents/scripts/inbox-enqueue.sh`, calls the shared `.agents` scheduler, and launches only explicit scheduler-provided worker specs. `/inbox schedule` asks `.agents` to drain the next eligible item. The harness does not invent scheduling policy or hidden worker launch rules.

## UI polish

The UI polish extension keeps the compact `π` terminal title while idle and animates a small braille spinner in the titlebar during active agent turns. Kitty shows this in tabs when tab titles are enabled. It also displays live elapsed wall-clock time in the working indicator and appends the elapsed time to each final assistant response.

Set `harness.compactToolOutput` in Pi settings to show compact tool rows instead of full read/write/edit/bash output during interactive turns:

```json
{
  "harness": {
    "compactToolOutput": true
  }
}
```

When enabled, tool rows stay terse but informative: bash calls include the command summary, reads include file/range, writes include file/line count, and edits include file/replacement count, without dumping read/write/edit/bash output into the transcript.

## Commands

After loading this package in pi, these commands provide explicit overrides and diagnostics for the ambient workflow:

```text
/mode [fast|default|deep|readonly|full]
/status            # visual bounded snapshot with task/ambient init hints; avoids heavy audit/untracked filename scans
/doctor            # heavier diagnostics/audit; /doct alias also works
/memory
/inbox                         # show async front-door inbox status
/inbox submit <request>        # queue a request through .agents inbox API; does not launch workers yet
/checkpoint [note]
/close-task completed|blocked [reason]  # explicit terminal task close via .agents task-close.sh
/skills-audit [skills-root]
/simplify [scope]
/review [scope]
/handoff [audience or focus]
```

Modes:

- `fast`: smaller/faster GPT, low thinking, all tools
- `default`: latest GPT, high thinking, all tools
- `deep`: latest GPT, xhigh thinking, all tools
- `readonly`: latest GPT, high thinking, read-only tools
- `full`: latest GPT, xhigh thinking, all tools

## Local install

From `~/.pi/agent/settings.json`:

```json
{
  "packages": ["./packages/ben-pi-harness"],
  "theme": "catppuccin-mocha"
}
```

After editing package files, reload pi:

```text
/reload
```

## Development

```bash
npm ci
npm run typecheck
npm run smoke:pi
npm run verify
npm run verify:cross-repo   # local .agents API compatibility check
npm run safe-pi:check       # local package-admission pre-launch check
npm run harness:audit
npm run skills:audit
npm run hooks:install
```

`npm run smoke:pi` performs a local, no-agent-turn Pi package lifecycle smoke check: it loads this package through Pi's `DefaultResourceLoader`, verifies extension registration, and confirms prompt/theme discovery without requiring API keys.

The tracked pre-push hook runs `npm run verify` and `npm run harness:audit`. `npm run verify:full-local` also checks the live local `.agents` API compatibility path; keep it local-only because it depends on this machine's shared control-plane checkout.

Cross-runtime task-script changes live in your `.agents` checkout; validate them with:

```bash
cd "${AGENTS_SHARED_ROOT:-$HOME/.agents}"
make verify-ci      # portable
make verify-local   # includes machine-local Codex schema checks
```

On a new personal macOS/Linux machine, run the `.agents` preflight once the repos are cloned:

```bash
cd "${AGENTS_SHARED_ROOT:-$HOME/.agents}"
BEN_PI_HARNESS_ROOT="${BEN_PI_HARNESS_ROOT:-$HOME/.pi/agent/packages/ben-pi-harness}" make personal-preflight
```

## Remote install later

This can be installed on another machine with:

```bash
pi install git:https://github.com/benjamin-shih/pi-harness.git
```

or referenced as a local checkout from `settings.json`.

## Safe Pi launch

Use the `.agents` wrapper as the default local launch path so package admission runs before Pi loads extensions:

```bash
~/.agents/bin/pi --version
npm run safe-pi:check
```

The harness only surfaces read-only package approval status after extensions have loaded; pre-launch gating belongs to `.agents/scripts/safe-pi.sh`.

## Compatibility checkpoint

Current release target: `v0.5.0`.

Validated with:

- `@earendil-works/pi-coding-agent@0.74.0`
- `pi-subagents@0.24.2`
- `pi-intercom@0.6.0`
- shared `.agents` task, package-policy, memory, and project-instruction diagnostics APIs as of the release tag

## Release notes

```bash
npm run changelog -- v0.5.0
```

See `RELEASING.md` for the release checklist.

## Safety notes

Keep this repository scoped to reusable harness code and UI assets only. Do not commit pi auth files, session logs, private keys, environment files, or machine-local secrets.

The safety gate is intentionally egress-focused: it blocks reading/uploading/outputting protected private files and blocks git operations that would include them, but it does not ask for broad filesystem permissions for normal destructive or package-manager commands.

LaTeX preview is intentionally optional because it depends on local TeX/PDF/image tooling and is orthogonal to the core coding harness.

Shell parsing remains a lightweight conservative guardrail. See [`docs/shell-parsing.md`](docs/shell-parsing.md) for the parser/oracle strategy and why native parsers such as `tree-sitter-bash` are not runtime dependencies today.
