# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Start dev server
pnpm build        # TypeScript check + Vite build → dist/
pnpm test         # Unit tests (vitest, jsdom)
pnpm test:watch   # Unit tests in watch mode
pnpm test:e2e     # E2E tests (Playwright, requires dev server or auto-starts via vite preview on port 4173)
pnpm lint         # ESLint
```

Run a single unit test file:
```bash
pnpm vitest run src/lib/markdownLocator.test.ts
```

## Architecture

This is a single-page React app: a Markdown editor with live preview, targeting WeChat Official Account publishing.

### Rendering pipeline (in `App.tsx`)

1. **`preprocessMarkdown()`** — normalize markdown (fix bold fragmentation, separator ambiguity)
2. **`md.render()`** — markdown-it → raw HTML (with highlight.js code blocks)
3. **`applyTheme(html, themeId)`** — DOM-parse and apply inline styles from the active theme; also handles image grid layout (consecutive image paragraphs → 2-column grids)
4. **`markElementIndexes(html)`** — enhancement layer: adds `data-md-type` / `data-md-index` attributes for click-to-locate (kept separate from core rendering)

### Click-to-locate (bi-directional sync)

Clicking a preview element highlights the corresponding source in the editor. Three files form a closed system — they must stay consistent:

- **`src/lib/indexerRules.ts`** — central source of truth: `ElementType` union, `MARKDOWN_RULES` (how to detect each type in markdown text), `HTML_TAG_MAP` (which HTML tag each type maps to). **When adding a new element type, start here.**
- **`src/lib/markdownIndexer.ts`** — reads rendered HTML, stamps `data-md-type`/`data-md-index` on every element using global sequential indexing (single counter, document order)
- **`src/lib/markdownLocator.ts`** — given a type + global index, walks the markdown source and returns character `{start, end}` for `textarea.setSelectionRange()`
- **`src/lib/imageSelector.ts`** — special-case locator for images (matches by `src`/`alt` rather than index)

### WeChat export (`src/lib/wechatCompat.ts`)

`makeWeChatCompatible()` transforms the rendered HTML for paste into WeChat:
- Converts flex image grids → `<table>` layout (WeChat ignores flex)
- Flattens `<p>` inside `<li>` → `<span>`
- Distributes `font-family`/`font-size`/`color`/`line-height` from container to every text node (WeChat ignores CSS inheritance)
- Converts all `<img src>` to Base64 (avoids "third-party image" errors)
- Appends CJK punctuation into the preceding inline element to prevent line-break issues

### Themes (`src/lib/themes/`)

Each theme is a `Theme` object with `id`, `name`, `description`, and `styles: Record<string, string>`. The `styles` keys are CSS selectors; values are inline style strings applied via `applyTheme()`. Themes are split into three files (`classic.ts`, `modern.ts`, `extra.ts`) and aggregated in `index.ts` → `THEMES` array.

### Scroll sync

`App.tsx` implements bidirectional scroll sync between editor and preview. A `scrollSyncLockRef` prevents feedback loops — whichever panel scrolled first "wins" for 50ms. The active scroll element differs by device mode: PC uses `previewOuterScrollRef`; mobile/tablet uses `previewInnerScrollRef`.

### Magic paste (`src/lib/htmlToMarkdown.ts`)

Uses `turndown` + `turndown-plugin-gfm` to convert rich text (from clipboard) to Markdown. Custom rule preserves full data URLs for pasted images.

### Test locations

- Unit tests: `src/lib/*.test.ts` (run with vitest/jsdom)
- E2E tests: `e2e/app.spec.ts` (Playwright, Chromium only, auto-starts vite dev server on port 4173)
