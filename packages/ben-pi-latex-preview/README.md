# ben-pi-latex-preview

Optional pi package for transient LaTeX/math previews.

This package is intentionally separate from `ben-pi-harness` so the core harness stays focused on safety, memory, footer/status, skills, and UI basics.

## Behavior

The loaded extension is a lightweight lazy loader. It only imports the heavy renderer when either:

- the current project looks TeX/math-heavy (`.tex`, `.bib`, `.sty`, `.cls`, `.qmd`, `.Rmd`, `.typ`, `latexmkrc`, `_quarto.yml`, etc. in the cwd or near parents), or
- an assistant response contains substantial LaTeX/math.

When inactive, it registers only cheap lifecycle hooks and does no rendering work.

## Install

From `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "./packages/ben-pi-harness",
    "./packages/ben-pi-harness/packages/ben-pi-latex-preview"
  ]
}
```

Run `/reload` after changing settings.
