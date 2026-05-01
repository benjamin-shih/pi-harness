# Shell parsing strategy

The safety gate intentionally keeps shell parsing lightweight and conservative. It extracts obvious path operands, redirection targets, mutating commands, and recursive traversal commands, then delegates path policy decisions to `.agents`.

## Current decision

Do **not** add a native shell parser to the runtime hot path yet.

Reasons:

- The gate is a guardrail, not a full shell interpreter.
- Native parser dependencies complicate Pi package install/reload behavior.
- Syntax trees do not solve shell expansion semantics by themselves.
- The current extractor is fast, dependency-free, and fails closed through `.agents` policy when it sees risky paths.

## Test strategy

Use table-driven tests for known safety-sensitive cases:

- adjacent stdout/stderr redirection such as `cmd>path` and `cmd 2>path`,
- input redirection such as `cmd < path`,
- mutating commands such as `tee`, `sed -i`, and file operations,
- `$HOME`, `~`, relative, and absolute path operands,
- recursive traversal commands such as `grep -R`, `find`, `tree`, `rg`, and `ls -R`,
- negative cases where verification/package commands should not trigger broad sensitive-path scans.

## Optional parser oracle candidates

If shell parsing risk grows, evaluate parsers as **test oracles** before runtime dependencies:

1. `tree-sitter-bash`
   - Fast and mature syntax parser with Rust/Node ecosystems.
   - Good for locating redirection and command nodes in tests.
   - Not sufficient for shell expansion or execution semantics.

2. `mvdan.cc/sh`
   - Excellent shell parser and formatter in Go.
   - Strong candidate for an offline oracle or standalone helper.
   - Adds cross-language packaging complexity for a TypeScript Pi package.

3. `bashlex`
   - Python parser that is convenient for tests and experiments.
   - Slower and less attractive for runtime use.

## Escalation criteria

Consider an oracle dependency only if table tests expose repeated parser drift or if the safety gate starts supporting more shell syntax. Consider a runtime parser only if the native packaging, startup cost, and fallback behavior are proven in CI and local Pi reloads.
