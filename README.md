# portraw

A lightweight web-based RAW (DNG) photo editor — "lite Lightroom" — in vanilla
TypeScript with no UI framework.

 <img width="1697" height="929" alt="Screenshot 2026-09-05 at 2 20 13" src="https://github.com/user-attachments/assets/3cb9f3c3-dfa9-43d2-9596-34b3bb9ae105" />



## Architecture

Two stages, strictly separated:

1. **Decode once** (`src/decode.worker.ts`) — the DNG is decoded in a Web
   Worker by [libraw-wasm](https://www.npmjs.com/package/libraw-wasm):
   16-bit, sRGB primaries, **linear** gamma, camera white balance as baseline,
   auto-brighten disabled. The result is converted to RGBA float16 and
   transferred (zero-copy) to the main thread, where it becomes an RGBA16F
   texture. A half-size pass runs first for an instant preview.
2. **Edit in real time** (`src/shader.frag`) — every adjustment is a uniform
   on a single WebGL2 fragment shader drawing one fullscreen quad. Slider
   changes never re-decode or touch pixels in JS.

Pipeline order inside the shader: white balance → exposure →
highlights/shadows → sRGB OETF → tone-curve LUTs → color mixer →
saturation → color grading → output.

## Files

| File                    | Responsibility                                    |
| ----------------------- | ------------------------------------------------- |
| `src/main.ts`           | bootstrap, file drop, wiring                      |
| `src/gl.ts`             | WebGL2 setup, textures, `render()`, export        |
| `src/shader.frag`       | the entire edit pipeline                          |
| `src/decode.worker.ts`  | one-time LibRaw decode → linear RGBA16F           |
| `src/controls.ts`       | slider/toggle DOM factories                       |
| `src/colorMixer.ts`     | color mixer panel (band × tone zone HSL)          |
| `src/colorGrade.ts`     | color grading panel (3-way wheels + luminance)    |
| `src/config.ts`         | tuning knobs for the color grading engine         |
| `src/preset.ts`         | preset model + localStorage store                 |
| `src/presetPanel.ts`    | presets panel (save by name, icon grid, apply)    |
| `src/curve.ts`          | RGB/channel curve editor → monotone-cubic LUTs    |
| `src/curveLut.ts`       | Pure tone-curve interpolation and LUT generation |
| `src/crop.ts`           | interactive crop overlay (arrange, resize, lock)  |
| `src/exportPanel.ts`    | Instagram-style export framing + border settings  |
| `src/folderPanel.ts`    | folder browser (File System Access API)           |
| `src/state.ts`          | the flat `EditState` object                       |

## Run

```bash
npm install
npm run dev      # develop (http://localhost:5173)
npm run build    # type-check + production build
npm run preview  # serve the production build
```

> The dev/preview servers send COOP/COEP headers because libraw-wasm's
> pthreads build needs `SharedArrayBuffer`. Any production host must send the
> same headers.

## Features

- **Develop sliders** — exposure, highlights, shadows, temperature, tint and
  saturation, all applied live at 60 fps with no re-decode.
- **Color mixer** — targeted hue/saturation/luminance adjustments across
  eight hue bands (red, orange, yellow, green, aqua, blue, purple, magenta),
  each split into darks / mids / lights.
- **Color grading** — 3-way shadows/midtones/highlights wheels for
  hue + saturation tinting, plus a per-zone luminance slider. Applied after
  global saturation, so a fully desaturated image can still be split-toned.
  Strength and zone-mask tuning live in `src/config.ts`.
- **Tone curves** — RGB master plus independent red, green, and blue SVG
  curves over the image histogram, with monotone-cubic interpolation baked to
  a four-row LUT texture.
- **Crop** — a draggable, resizable overlay over the full image, freeform or
  locked to the source's aspect ratio; the crop is normalized so it survives
  export at full resolution.
- **Folder browser** — pick a folder (Chrome/Edge only, via the File System
  Access API) and click through every DNG in a shoot without re-opening a
  file picker each time.
- **Presets** — *Save preset* snapshots the current develop settings
  (sliders + color mixer + color grading) under a name, shown as an icon with
  the name's first three letters on a random color. Presets persist in
  `localStorage`; click one to apply, hover to delete.
- **Export** — render the (possibly cropped) photo at full resolution to
  JPEG or PNG. Optionally add a solid-color border, and/or frame it for
  Instagram: original size, or centered/scaled (never upscaled) into square
  (1080×1080), horizontal (1080×566) or vertical (1080×1350) canvases at
  Instagram's own recommended pixel dimensions, with a live preview swatch
  before you export.
- **Debug toggles** — bypass the tone curves, view the pre-gamma linear
  buffer, or overlay blown/crushed pixels.

## Use

Drop a `.dng` onto the window, use *Open RAW…*, or *Open folder…* to browse
a shoot. Adjust the develop sliders, color mixer, color grading and tone
curve from the Edit tab; frame and apply a crop from the Crop tab; save/apply
snapshots from the Presets tab; and pick a format, border and destination
file type from the Export tab.
