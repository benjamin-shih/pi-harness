# Changelog

All notable changes to this personal pi harness package are tracked here.

## Unreleased

### Added
- Aesthetic polish extension with rounded prompt editor and rounded sent-prompt boxes.
- Harness mode command (`/mode`) for fast/default/deep/readonly/full operating modes.
- Harness status command (`/status`) and visible session checkpoints (`/checkpoint`).
- Lightweight skill-routing reminder for standard and complex prompts.
- Behavioral safety-gate verification in `npm run verify`.
- `/skills-audit` command plus `npm run skills:audit` for shared skill graph validation and bloat summaries.
- Release-note drafting script and tracked pre-push validation hook.

### Changed
- Catppuccin theme now uses blue/sapphire-forward UI accents instead of mauve-heavy defaults.
- Footer keeps its original mauve/pink segment colors while the rest of the theme stays blue-forward.
- Bash command titles now use the same blue as startup resource headings.
- Sent prompt boxes are tighter, content-sized ASCII-safe cards with explicit blue borders.
- Safety gate is now egress-focused: it blocks secret/private-file output, upload, and sensitive git inclusion, but no longer prompts for ordinary filesystem, package-manager, or destructive commands.
- CI and local validation now exercise extension loading, prompt/theme metadata, safety-gate behavior, and local skill graph health when present.

### Fixed
- None.

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
