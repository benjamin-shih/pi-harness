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
  catppuccin-footer.ts  Responsive Catppuccin footer
  harness-commands.ts   /mode, /status, /checkpoint, and skill-routing reminders
  latex-preview.ts      Automatic rendered-LaTeX previews after math-heavy replies
  safety-gate.ts        Secret/private-file and risky-command guardrails
  skills-audit.ts       /skills-audit command for the shared skill graph
prompts/
  handoff.md            Session/task handoff prompt
  review.md             Review prompt
  simplify.md           Simplification prompt
themes/
  catppuccin-mocha.json Catppuccin Mocha theme
scripts/
  verify.mjs            Local/CI package verification
  skills-audit.mjs      Shared skill graph validator and bloat summary
  changelog.mjs         Draft release notes from git commits
```

## Commands

After loading this package in pi:

```text
/mode [fast|default|deep|readonly|full]
/status
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
npm run verify
npm run skills:audit
npm run hooks:install
```

The tracked pre-push hook runs `npm run verify`.

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
