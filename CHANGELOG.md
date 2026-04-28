# Changelog

All notable changes to this personal pi harness package are tracked here.

## Unreleased

### Added
- Harness mode command (`/mode`) for fast/default/deep/readonly/full operating modes.
- Harness status command (`/status`) and visible session checkpoints (`/checkpoint`).
- Lightweight skill-routing reminder for standard and complex prompts.
- Behavioral safety-gate verification in `npm run verify`.
- Release-note drafting script and tracked pre-push validation hook.

### Changed
- CI and local validation now exercise extension loading, prompt/theme metadata, and safety-gate behavior.

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
