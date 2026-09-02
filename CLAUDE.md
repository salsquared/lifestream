# LIFEstream — Claude instructions

## Planning docs
- Write all planning/design docs as standalone HTML files (not Markdown) under `docs/`.
- **Link the shared stylesheet — never inline CSS.** Every doc carries
  `<link rel="stylesheet" href="./assets/style.css">` (or `../assets/style.css` from a
  `docs/` subdirectory) and no `<style>` block of its own. `docs/assets/style.css` is the
  single source of truth for how these docs look; a rule that belongs to a doc type belongs
  in that file, not in the doc.
  - This replaces an earlier "inline CSS" rule, which predates the shared-stylesheet
    convention used across the other projects on this machine. If you find a doc with an
    inline `<style>` block, that is drift to fix, not a pattern to copy.
- The stylesheet is dark-mode and owns the palette (CSS custom properties on `:root`).
  Use its variables — `--blue`, `--green`, `--teal`, `--amber`, `--red`, `--text`,
  `--text-muted`, `--surface` — rather than inventing per-doc colors.
- For diagrams use **mermaid** via the CDN script
  `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs`, initialized with a
  dark theme whose `themeVariables` match the stylesheet's palette.
- **Never hand-write SVG diagrams.** Mermaid only. (SVG produced by app code — e.g. d3-geo —
  is unrelated and fine.)
