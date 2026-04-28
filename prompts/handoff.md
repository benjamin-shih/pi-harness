---
description: Produce a concise handoff summary for continuing work later or in another agent
argument-hint: "[audience or focus]"
---
Create a handoff summary for continuing this work. Audience/focus: $ARGUMENTS

If the task is simple, summarize directly. If substantial, load relevant skills first and use repository/session evidence rather than memory alone.

Include:
- Goal / user intent
- Current state and decisions made
- Files changed or important files inspected
- Commands/checks run and results
- Active assumptions and unresolved questions
- Blockers or risks
- Exact next steps
- Relevant skill/context state another agent should load

Rules:
- Be concise but complete enough for a fresh agent to continue safely.
- Do not include secrets, tokens, private keys, or credential file contents.
- Clearly mark anything uncertain.
- If in a git repo, include a brief repo status summary without dumping sensitive file names or contents.
