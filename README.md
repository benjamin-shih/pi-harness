# ben-pi-harness

Benjamin's personal [pi](https://pi.dev) harness package.

This package bundles the reusable parts of the local pi setup:

- extensions
- prompt templates
- themes

Machine-local pi state such as `settings.json`, `AGENTS.md`, auth files, and session history intentionally stays outside this package.

## Contents

```text
extensions/
  catppuccin-footer.ts  Responsive Catppuccin footer
  safety-gate.ts        Secret/private-file and risky-command guardrails
prompts/
  handoff.md            Session/task handoff prompt
  review.md             Review prompt
  simplify.md           Simplification prompt
themes/
  catppuccin-mocha.json Catppuccin Mocha theme
```

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

## Remote install later

Once the private GitHub remote is ready, this can be installed on another machine with:

```bash
pi install git:https://github.com/benjamin-shih/pi-harness.git
```

or referenced as a local checkout from `settings.json`.

## Safety notes

Keep this repository scoped to reusable harness code and UI assets only. Do not commit pi auth files, session logs, private keys, environment files, or machine-local secrets.
