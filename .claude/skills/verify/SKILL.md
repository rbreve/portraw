---
name: verify
description: Build, launch, and drive portraw in headless Chrome to verify a change end-to-end.
---

# Verifying portraw changes

GUI app (Vite + WebGL2). GLSL only compiles at runtime, so `npm run build`
passing is NOT evidence a shader change works — a broken shader renders a
black canvas and logs errors to the browser console.

## Launch

```bash
npm run dev -- --port 5199 --strictPort   # background; COOP/COEP headers are in vite.config.ts
```

## Drive (Playwright, no install needed)

Playwright lives in the npx cache; system Chrome works headless with WebGL2:

```bash
ls -d ~/.npm/_npx/*/node_modules/playwright | head -1   # use as NODE_PATH
NODE_PATH=<that dir> node driver.cjs
```

Driver essentials:
- `chromium.launch({ channel: 'chrome', headless: true })`.
- Load a photo through the real surface: `page.setInputFiles('#file-input', dng)`.
  Test DNGs: `~/Photos/TampereStreets/*.DNG` (or `mdfind "kMDItemFSName == '*.DNG'"`).
- Wait for the FULL decode before capturing: `#status` text becomes `W × H`
  (the preview stage says "Preview (half size)…").
- Evidence: `#view` canvas has `preserveDrawingBuffer`, so
  `canvas.toDataURL()` diffs prove a render changed; `page.screenshot()` for
  the human-readable frame.
- Capture `page.on('console')` and `page.on('pageerror')` — shader compile
  failures surface only there. A `/favicon.ico` 404 is pre-existing noise.

## Gotchas

- Session persistence is debounced 400ms — wait ~700ms before reading
  `localStorage['portraw:session']` or you read stale state.
- Opening a file intentionally RESETS all edits (resetControlsForNewFile), so
  "edit → reopen → check persistence" is not a valid probe.
- Tab switching: click `.tool-rail-button[data-tab="…"]` — a bare
  `[data-tab=…]` selector matches the hidden `.tab-panel` div first.
- `localStorage.clear()` + reload first for a clean baseline; presets can be
  injected under key `portraw:presets`, session under `portraw:session`.
- Export: `page.waitForEvent('download')` + click `#export-jpeg`.
