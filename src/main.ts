// Bootstrap + wiring. The whole app is: one editState object, one renderer,
// one render() closure. UI events mutate editState then call render().
import { GlRenderer } from './gl';
import { makeBoundSlider, makeToggle, type SliderHandle } from './controls';
import { ColorMixerPanel } from './colorMixer';
import { FolderPanel } from './folderPanel';
import { PresetPanel } from './presetPanel';
import { PresetStore } from './preset';
import { CurveEditor } from './curve';
import { applyPresetSettings, createDefaultEditState, type EditState } from './state';
import type { DecodeRequest, DecodeResponse } from './decode.worker';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const dropOverlay = document.querySelector<HTMLElement>('#drop-overlay')!;
const statusLine = document.querySelector<HTMLElement>('#status')!;
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!;

const editState: EditState = createDefaultEditState();
const renderer = new GlRenderer(canvas);
const render = () => renderer.render(editState);

// --- decode worker (stage 1) -------------------------------------------------

const decodeWorker = new Worker(new URL('./decode.worker.ts', import.meta.url), {
  type: 'module',
});

decodeWorker.onmessage = ({ data }: MessageEvent<DecodeResponse>) => {
  switch (data.type) {
    case 'status':
      statusLine.textContent = data.message;
      break;
    case 'image':
      renderer.setImage(data.width, data.height, data.pixels);
      curveEditor.setHistogram(data.histogram);
      render();
      statusLine.textContent =
        data.stage === 'preview'
          ? 'Preview (half size) — decoding full resolution…'
          : `${data.width} × ${data.height}`;
      setExportEnabled(data.stage === 'full');
      break;
    case 'error':
      statusLine.textContent = `Decode failed: ${data.message}`;
      break;
  }
};

async function loadFile(file: File): Promise<void> {
  dropOverlay.classList.add('hidden');
  statusLine.textContent = `Reading ${file.name}…`;
  setExportEnabled(false);
  const fileBuffer = await file.arrayBuffer();
  const request: DecodeRequest = { fileBuffer };
  decodeWorker.postMessage(request, [fileBuffer]);
}

// --- file input + drag & drop ---------------------------------------------------

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
});

// --- folder browser ----------------------------------------------------------

const folderPanel = new FolderPanel((file) => void loadFile(file));
document.querySelector('#folder-panel')!.append(folderPanel.element);

const fileBrowser = document.querySelector<HTMLElement>('#file-browser')!;
const fileBrowserToggle = document.querySelector<HTMLButtonElement>('#file-browser-toggle')!;
fileBrowserToggle.addEventListener('click', () => {
  const collapsed = fileBrowser.classList.toggle('collapsed');
  fileBrowserToggle.title = collapsed ? 'Show file browser' : 'Hide file browser';
  fileBrowserToggle.setAttribute('aria-expanded', String(!collapsed));
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('hidden');
  dropOverlay.classList.add('drag-active');
});
window.addEventListener('dragleave', () => {
  dropOverlay.classList.toggle('hidden', renderer.hasImage);
  dropOverlay.classList.remove('drag-active');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('drag-active');
  const file = e.dataTransfer?.files[0];
  if (file) void loadFile(file);
  else dropOverlay.classList.toggle('hidden', renderer.hasImage);
});

// --- develop sliders ---------------------------------------------------------

type NumericKey = 'exposureEv' | 'highlights' | 'shadows' | 'temperature' | 'tint' | 'saturation';

const sliderConfigs: Array<{ key: NumericKey; label: string; min: number; max: number; step: number }> = [
  { key: 'exposureEv', label: 'Exposure', min: -5, max: 5, step: 0.1 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100, step: 0.1 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100, step: 0.1 },
  { key: 'temperature', label: 'Temperature', min: -100, max: 100, step: 0.1 },
  { key: 'tint', label: 'Tint', min: -100, max: 100, step: 0.1 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 0.1 },
];

// Keep each slider's handle keyed by state field so applying a preset can push
// new values back into the slider positions.
const developSliders = new Map<NumericKey, SliderHandle>();
document.querySelector('#sliders')!.append(
  ...sliderConfigs.map((config) => {
    const slider = makeBoundSlider({
      label: config.label,
      min: config.min,
      max: config.max,
      step: config.step,
      value: editState[config.key],
      onInput: (value) => {
        editState[config.key] = value;
        render();
      },
    });
    developSliders.set(config.key, slider);
    return slider.element;
  }),
);

// --- color mixer -----------------------------------------------------------------

const colorMixerPanel = new ColorMixerPanel(editState.colorMix, render);
document.querySelector('#color-mixer-panel')!.append(colorMixerPanel.element);

// --- presets -----------------------------------------------------------------------
// Applying a preset mutates editState in place, then we sync every control's
// DOM to the new values and re-render once.
const presetPanel = new PresetPanel(new PresetStore(), {
  getCurrentState: () => editState,
  onApply: (preset) => {
    applyPresetSettings(editState, preset.settings);
    for (const [key, slider] of developSliders) slider.setValue(editState[key]);
    colorMixerPanel.syncFromState();
    render();
  },
});
document.querySelector('#preset-panel')!.append(presetPanel.element);

// --- tone curve ----------------------------------------------------------------

const curveEditor = new CurveEditor((lut) => {
  renderer.setCurveLut(lut);
  render();
});
document.querySelector('#curve-panel')!.append(curveEditor.element);

// --- debug toggles ---------------------------------------------------------------

type DebugKey = 'bypassCurve' | 'showLinear' | 'showClipping';

const debugConfigs: Array<{ key: DebugKey; label: string }> = [
  { key: 'bypassCurve', label: 'Bypass tone curve' },
  { key: 'showLinear', label: 'Show linear (pre-gamma)' },
  { key: 'showClipping', label: 'Show clipping overlay' },
];

document.querySelector('#debug-panel')!.append(
  ...debugConfigs.map(({ key, label }) =>
    makeToggle(label, (enabled) => {
      editState[key] = enabled;
      render();
    }),
  ),
);

// --- export -----------------------------------------------------------------------

const exportButtons: Array<{ id: string; mime: string; quality?: number; ext: string }> = [
  { id: '#export-jpeg', mime: 'image/jpeg', quality: 0.92, ext: 'jpg' },
  { id: '#export-png', mime: 'image/png', ext: 'png' },
];

for (const { id, mime, quality, ext } of exportButtons) {
  document.querySelector<HTMLButtonElement>(id)!.addEventListener('click', async () => {
    statusLine.textContent = 'Exporting…';
    try {
      const blob = await renderer.exportBlob(editState, mime, quality);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `raw-lite-export.${ext}`;
      link.click();
      URL.revokeObjectURL(url);
      statusLine.textContent = 'Exported';
    } catch (error) {
      statusLine.textContent = `Export failed: ${error instanceof Error ? error.message : error}`;
    }
  });
}

function setExportEnabled(enabled: boolean): void {
  for (const { id } of exportButtons) {
    document.querySelector<HTMLButtonElement>(id)!.disabled = !enabled;
  }
}
setExportEnabled(false);

// --- keep the canvas buffer matched to its on-screen size -------------------------

new ResizeObserver(() => render()).observe(canvas);

// --- dev-only: load a RAW from a URL via ?load=… (testing convenience) -------------

if (import.meta.env.DEV) {
  const loadUrl = new URLSearchParams(location.search).get('load');
  if (loadUrl) {
    void fetch(loadUrl)
      .then((response) => response.blob())
      .then((blob) => loadFile(new File([blob], loadUrl.split('/').pop() ?? 'image.dng')));
  }
}
