# Releasing

This is a private pi harness package. Release tags are mainly for rollback and cross-machine installation.

## Validate

```bash
npm ci
npm run verify
npm run harness:audit
```

Install the tracked pre-push hook once per checkout:

```bash
npm run hooks:install
```

## Draft notes

Generate a commit-based draft:

```bash
npm run changelog -- v0.3.0
```

Then manually edit `CHANGELOG.md`. Keep these sections for every release:

- Added
- Changed
- Fixed
- Breaking

Use `None` if a section is empty. Include commit hashes in draft notes while reviewing; the final changelog can be user-facing and concise.

## Tag

Only tag from a clean worktree after local validation passes and CI is expected to pass:

```bash
git status --short --branch
npm run verify
npm run harness:audit
git tag -a v0.3.0 -m "v0.3.0"
git push origin main --tags
```

If this package is installed elsewhere via a pinned git ref, update the pinned ref after the tag is pushed.
