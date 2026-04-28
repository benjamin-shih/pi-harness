---
description: Simplify recently changed code without changing behavior
argument-hint: "[scope or instructions]"
---
Simplify the recently changed code. Scope/instructions: $ARGUMENTS

If this is a trivial cleanup, do it immediately. If it is nontrivial, first load the relevant skills, especially `simplify`, plus coding/repo-discipline skills if you will inspect or edit files.

Goals:
- Preserve observable behavior.
- Prefer the smallest clear change over broad refactors.
- Remove unnecessary complexity, duplication, dead code, and confusing names only where it directly improves the changed area.
- Do not add speculative abstractions or features.

Workflow:
1. Inspect the relevant diff/files.
2. Identify the smallest simplification plan.
3. Make surgical edits only.
4. Run the narrowest meaningful verification.
5. Report what changed, what was verified, and any remaining uncertainty.
