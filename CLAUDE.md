# LIFEstream — Claude instructions

## Planning docs
- Write all planning/design docs as standalone HTML files (not Markdown) under `docs/`.
- Use a dark-mode color scheme by default: dark background, light text, muted rules, accent colors that read well on dark.
- Inline CSS. For diagrams use **mermaid** via the CDN script `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs`, initialized with a dark theme matching the doc palette.
- **Never hand-write SVG diagrams.** Mermaid only. (SVG produced by app code — e.g. d3-geo — is unrelated and fine.)
