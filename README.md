# raw lite

A lightweight web-based RAW (DNG) photo editor — "lite Lightroom" — in vanilla
TypeScript with no UI framework.

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
highlights/shadows → sRGB OETF → tone curve LUT → color mixer →
saturation → output.

## Files

| File                    | Responsibility                                    |
| ----------------------- | ------------------------------------------------- |
| `src/main.ts`           | bootstrap, file drop, wiring                      |
| `src/gl.ts`             | WebGL2 setup, textures, `render()`, export        |
| `src/shader.frag`       | the entire edit pipeline                          |
| `src/decode.worker.ts`  | one-time LibRaw decode → linear RGBA16F           |
| `src/controls.ts`       | slider/toggle DOM factories                       |
| `src/colorMixer.ts`     | color mixer panel (band × tone zone HSL)          |
| `src/preset.ts`         | preset model + localStorage store                 |
| `src/presetPanel.ts`    | presets panel (save by name, icon grid, apply)    |
| `src/curve.ts`          | SVG curve editor → 256-entry monotone-cubic LUT   |
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

## Use

Drop a `.dng` onto the window (or *Open RAW…*). Adjust exposure, highlights,
shadows, temperature, tint, saturation and the tone curve — all at 60 fps.
The color mixer targets one of five hue bands (red, orange, yellow, green,
blue) split into darks / mids / lights, with hue, saturation and luminance
per cell. *Save preset* snapshots the current develop settings (sliders +
color mixer) under a name; its icon shows the name's first three letters on a
random color. Presets persist in `localStorage`; click one to apply, hover to
delete.
Debug toggles can bypass the curve, show the linear buffer, and overlay
blown/crushed pixels. Export renders at full resolution to JPEG or PNG.
