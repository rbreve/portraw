// Bootstrap + wiring. The whole app is: one editState object, one renderer,
// one render() closure. UI events mutate editState then call render().
import { GlRenderer } from './gl';
import { makeBoundSlider, makeToggle, type SliderHandle } from './controls';
import { ColorGradePanel } from './colorGrade';
import { ColorMixerPanel } from './colorMixer';
import { CropOverlay } from './crop';
import { ExportPanel } from './exportPanel';
import { FolderPanel } from './folderPanel';
import { PresetPanel } from './presetPanel';
import { PresetStore } from './preset';
import { CurveEditor } from './curve';
import {
  applyPresetSettings,
  createDefaultEditState,
  loadSessionEditState,
  persistSessionEditState,
  resetEditState,
  type EditState,
} from './state';
import type { DecodeRequest, DecodeResponse } from './decode.worker';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const viewport = document.querySelector<HTMLElement>('#viewport')!;
const dropOverlay = document.querySelector<HTMLElement>('#drop-overlay')!;
const statusLine = document.querySelector<HTMLElement>('#status')!;
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!;

const editState: EditState = loadSessionEditState() ?? createDefaultEditState();
const renderer = new GlRenderer(canvas);

// Debounced so a slider drag (many render() calls/sec) doesn't hammer
// localStorage — only the settled value after a short pause gets written.
let persistTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePersist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistSessionEditState(editState), 400);
}
window.addEventListener('beforeunload', () => persistSessionEditState(editState));

const render = () => {
  renderer.render(editState);
  schedulePersist();
};

// Base image pixel dimensions (either decode stage — preview/full share the same
// aspect ratio) — used to compute the (possibly cropped) content aspect for the
// export frame preview.
let imgWidth = 0;
let imgHeight = 0;
function currentContentAspect(): number {
  if (!imgWidth || !imgHeight) return 1;
  const crop = editState.crop;
  const w = crop ? crop.width * imgWidth : imgWidth;
  const h = crop ? crop.height * imgHeight : imgHeight;
  return w / h;
}

/** Re-sync the export preview's aspect ratio + thumbnail with the current photo/crop/edits. */
function refreshExportPreview(): void {
  exportPanel.setPhotoAspect(currentContentAspect());
  exportPanel.setPhotoThumbnail(renderer.hasImage ? renderer.renderThumbnail(editState, 200) : null);
}

// --- decode worker (stage 1) -------------------------------------------------

const decodeWorker = new Worker(new URL('./decode.worker.ts', import.meta.url), {
  type: 'module',
});

// Set whenever a new file starts loading, consumed by the first 'image' message
// that arrives for it (the preview-stage decode) — NOT the second, full-res
// 'image' message for that same file, which must not clobber edits made while
// the preview was up. Resetting is deferred to that message (rather than
// firing immediately in loadFile) so the old photo's edits never flash back to
// defaults while the new file is still being read/decoded — a RAW preview with
// every adjustment zeroed can look dark/flat, which read as "the image reset".
let resetOnNextImage = false;

decodeWorker.onmessage = ({ data }: MessageEvent<DecodeResponse>) => {
  switch (data.type) {
    case 'status':
      statusLine.textContent = data.message;
      break;
    case 'image':
      if (resetOnNextImage) {
        resetOnNextImage = false;
        resetControlsForNewFile();
      }
      renderer.setImage(data.width, data.height, data.pixels);
      cropOverlay.setImageSize(data.width, data.height);
      if (activeTab === 'crop') cropOverlay.startArranging();
      imgWidth = data.width;
      imgHeight = data.height;
      curveEditor.setHistogram(data.histogram);
      render();
      refreshExportPreview();
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

/** Reset every develop/crop/debug control back to defaults for the incoming photo. */
function resetControlsForNewFile(): void {
  cropOverlay.finishArranging(); // commit (harmlessly overwritten below) rather than leave arranging mid-drag
  resetEditState(editState);
  for (const [key, slider] of developSliders) slider.setValue(editState[key]);
  colorMixerPanel.syncFromState();
  colorGradePanel.syncFromState();
  curveEditor.reset();
  for (const input of document.querySelectorAll<HTMLInputElement>('#debug-panel input[type=checkbox]')) {
    input.checked = false;
  }
}

async function loadFile(file: File): Promise<void> {
  resetOnNextImage = true;
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

let activeTab = 'edit';

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

// --- crop ----------------------------------------------------------------------
// Arranging always shows the full image (see setCropPreviewActive) so the
// overlay's coordinate space matches what's on screen regardless of any
// already-applied crop.
const cropOverlay = new CropOverlay(viewport, {
  getCrop: () => editState.crop,
  onApply: (crop) => {
    editState.crop = crop;
    render();
    refreshExportPreview();
  },
  onReset: () => {
    editState.crop = null;
    render();
    refreshExportPreview();
  },
  onModeChange: (arranging) => {
    renderer.setCropPreviewActive(arranging);
    render();
  },
});
document.querySelector('#crop-panel')!.append(cropOverlay.element);

// --- color mixer -----------------------------------------------------------------

const colorMixerPanel = new ColorMixerPanel(editState.colorMix, render);
document.querySelector('#color-mixer-panel')!.append(colorMixerPanel.element);

// --- color grading ---------------------------------------------------------------

const colorGradePanel = new ColorGradePanel(editState.colorGrade, render);
document.querySelector('#color-grade-panel')!.append(colorGradePanel.element);

// --- presets -----------------------------------------------------------------------
// Applying a preset mutates editState in place, then we sync every control's
// DOM to the new values and re-render once.
const presetPanel = new PresetPanel(new PresetStore(), {
  getCurrentState: () => editState,
  onApply: (preset) => {
    applyPresetSettings(editState, preset.settings);
    for (const [key, slider] of developSliders) slider.setValue(editState[key]);
    colorMixerPanel.syncFromState();
    colorGradePanel.syncFromState();
    curveEditor.setPoints(editState.curvePoints);
    render();
  },
});
document.querySelector('#preset-panel')!.append(presetPanel.element);

// --- tone curve ----------------------------------------------------------------

const curveEditor = new CurveEditor((lut, points) => {
  editState.curvePoints = points;
  renderer.setCurveLut(lut);
  render();
});
curveEditor.setPoints(editState.curvePoints);
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
    makeToggle(
      label,
      (enabled) => {
        editState[key] = enabled;
        render();
      },
      editState[key],
    ),
  ),
);

// --- export frame (Instagram formats + border) ------------------------------------

const exportPanel = new ExportPanel();
document.querySelector('#export-frame-panel')!.append(exportPanel.element);

// --- export -----------------------------------------------------------------------

const exportButtons: Array<{ id: string; mime: string; quality?: number; ext: string }> = [
  { id: '#export-jpeg', mime: 'image/jpeg', quality: 0.92, ext: 'jpg' },
  { id: '#export-png', mime: 'image/png', ext: 'png' },
];

for (const { id, mime, quality, ext } of exportButtons) {
  document.querySelector<HTMLButtonElement>(id)!.addEventListener('click', async () => {
    statusLine.textContent = 'Exporting…';
    try {
      const blob = await renderer.exportBlob(editState, mime, quality, exportPanel.getSettings());
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `portraw-export.${ext}`;
      link.click();
      URL.revokeObjectURL(url);
      statusLine.textContent = 'Exported';
    } catch (error) {
      statusLine.textContent = `Export failed: ${error instanceof Error ? error.message : error}`;
    }
  });
}

// --- tool rail tabs ------------------------------------------------------------

const toolRailButtons = document.querySelectorAll<HTMLButtonElement>('.tool-rail-button');
const tabPanels = document.querySelectorAll<HTMLElement>('.tab-panel');

function selectTab(tab: string): void {
  activeTab = tab;
  for (const button of toolRailButtons) {
    const selected = button.dataset.tab === tab;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  for (const panel of tabPanels) {
    panel.classList.toggle('active', panel.dataset.tab === tab);
  }
  if (tab === 'crop') {
    if (renderer.hasImage) cropOverlay.startArranging();
  } else {
    cropOverlay.finishArranging();
  }
  if (tab === 'export') {
    exportPanel.refreshLayout();
    refreshExportPreview();
  }
}

for (const button of toolRailButtons) {
  button.addEventListener('click', () => selectTab(button.dataset.tab!));
}

selectTab('edit');

function setExportEnabled(enabled: boolean): void {
  for (const { id } of exportButtons) {
    document.querySelector<HTMLButtonElement>(id)!.disabled = !enabled;
  }
}
setExportEnabled(false);

// --- keep the canvas buffer matched to its on-screen size -------------------------

new ResizeObserver(() => {
  render();
  cropOverlay.refreshLayout();
}).observe(canvas);

// --- dev-only: load a RAW from a URL via ?load=… (testing convenience) -------------

if (import.meta.env.DEV) {
  const loadUrl = new URLSearchParams(location.search).get('load');
  if (loadUrl) {
    void fetch(loadUrl)
      .then((response) => response.blob())
      .then((blob) => loadFile(new File([blob], loadUrl.split('/').pop() ?? 'image.dng')));
  }
}
