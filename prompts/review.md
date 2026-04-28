---
description: Review current changes or a specified scope for correctness and risk
argument-hint: "[scope]"
---
Review the current changes or this scope: $ARGUMENTS

If this is a small direct review, proceed immediately. If nontrivial, first load the relevant skills and briefly state which ones you are using.

Review focus:
- Correctness bugs and edge cases
- Security/privacy risks, especially secret exposure
- Error handling and failure modes
- Test coverage and verification gaps
- Performance or maintainability issues only when material

Rules:
- Do not modify files unless explicitly asked.
- Prefer concrete findings with file/line references when available.
- Distinguish blocking issues from nits.
- If no issues are found, say what was inspected and why it looks safe.
- Do not print or inspect credential-bearing files.

Suggested checks:
1. Inspect repo status and relevant diffs/files.
2. Identify likely runtime/test entrypoints, but do not run expensive commands unless useful.
3. Return findings ordered by severity, then open questions and suggested verification.
