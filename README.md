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

## Ambient task binding

Pi reuses the shared `.agents/tasks` control plane through the versioned `.agents` task API. By default the harness looks under `$HOME/.agents`; set `AGENTS_SHARED_ROOT` when using a different checkout. For standard/complex prompts it attempts to bind or reuse an active task, inject compact task context, heartbeat during tool activity, checkpoint meaningful turns, capture safe typed task-artifact metadata, and release current-session leases on shutdown.

The shared `.agents` scripts own project-root, bootstrap-path, sensitive-path, and artifact-capture policy via `task-api.sh info`, `task-candidate-root.sh`, `path-safety.sh`, and `task-artifact-*.sh`; the TypeScript harness is only the Pi runtime adapter/UI layer. Set `AGENTS_SHARED_ROOT` to point at an alternate `.agents` checkout, `AGENTS_SKILLS_ROOT` to override the default skills root, and `TASKS_ROOT` to isolate task packages in tests.

## UI polish

The UI polish extension keeps the compact `π` terminal title while idle and animates a small braille spinner in the titlebar during active agent turns. Kitty shows this in tabs when tab titles are enabled. It also displays live elapsed wall-clock time in the working indicator and appends the elapsed time to each final assistant response.

## Commands

After loading this package in pi:

```text
/mode [fast|default|deep|readonly|full]
/status
/doctor            # /doct alias also works
/memory
/checkpoint [note]
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
npm run verify
npm run harness:audit
npm run skills:audit
npm run hooks:install
```

The tracked pre-push hook runs `npm run verify` and `npm run harness:audit`.

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

## Release notes

```bash
npm run changelog -- v0.2.0
```

See `RELEASING.md` for the release checklist.

## Safety notes

Keep this repository scoped to reusable harness code and UI assets only. Do not commit pi auth files, session logs, private keys, environment files, or machine-local secrets.

The safety gate is intentionally egress-focused: it blocks reading/uploading/outputting protected private files and blocks git operations that would include them, but it does not ask for broad filesystem permissions for normal destructive or package-manager commands.

LaTeX preview is intentionally optional because it depends on local TeX/PDF/image tooling and is orthogonal to the core coding harness.

Shell parsing remains a lightweight conservative guardrail. See [`docs/shell-parsing.md`](docs/shell-parsing.md) for the parser/oracle strategy and why native parsers such as `tree-sitter-bash` are not runtime dependencies today.
