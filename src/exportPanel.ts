// Instagram-style export framing: pick a canvas format (square / horizontal /
// vertical, at Instagram's own recommended pixel sizes — see FRAME_SIZES in
// gl.ts) and optionally pad the photo with a border so the whole shot fits
// inside without Instagram's feed auto-crop clipping it. This module only
// owns the settings UI + a live preview swatch; the actual pixel compositing
// happens in GlRenderer.exportBlob.
import { makeBoundSlider, makeToggle } from './controls';
import { FRAME_SIZES, type ExportFormat } from './gl';

export interface ExportFrameSettings {
  format: ExportFormat;
  borderPercent: number;
  borderColor: string;
}

const FORMAT_LABELS: Record<ExportFormat, string> = {
  original: 'Original',
  square: 'Square',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
};

const FORMATS = ['original', 'square', 'horizontal', 'vertical'] as const;

// Matted-border color. Not user-configurable yet — white matches the classic
// "square-fit" look most Instagram padding apps default to.
const BORDER_COLOR = '#ffffff';
const PREVIEW_MAX_WIDTH = 240;

export class ExportPanel {
  readonly element: HTMLElement;

  private readonly formatButtons = new Map<ExportFormat, HTMLButtonElement>();
  private readonly previewBox: HTMLElement;
  private readonly previewPhoto: HTMLElement;
  private readonly borderSliderInput: HTMLInputElement;

  private format: ExportFormat = 'original';
  private borderEnabled = false;
  private borderPercent = 6;
  private photoAspect = 1;

  constructor() {
    const formatGrid = document.createElement('div');
    formatGrid.className = 'format-grid';
    for (const format of FORMATS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = FORMAT_LABELS[format];
      button.addEventListener('click', () => this.setFormat(format));
      this.formatButtons.set(format, button);
      formatGrid.append(button);
    }

    this.previewPhoto = document.createElement('div');
    this.previewPhoto.className = 'export-preview-photo';

    this.previewBox = document.createElement('div');
    this.previewBox.className = 'export-preview hidden';
    this.previewBox.append(this.previewPhoto);

    const borderToggleRow = makeToggle('Add border', (enabled) => {
      this.borderEnabled = enabled;
      this.updateBorderControls();
      this.updatePreview();
    });

    const borderSlider = makeBoundSlider({
      label: 'Border size',
      min: 2,
      max: 20,
      step: 1,
      value: this.borderPercent,
      onInput: (value) => {
        this.borderPercent = value;
        this.updatePreview();
      },
    });
    this.borderSliderInput = borderSlider.element.querySelector('input')!;

    this.element = document.createElement('div');
    this.element.className = 'export-frame';
    this.element.append(formatGrid, this.previewBox, borderToggleRow, borderSlider.element);

    this.setFormat('original');
    this.updateBorderControls();
  }

  getSettings(): ExportFrameSettings {
    return {
      format: this.format,
      borderPercent: this.borderEnabled ? this.borderPercent : 0,
      borderColor: BORDER_COLOR,
    };
  }

  /** Update the preview's inner rectangle to match the (possibly cropped) photo's aspect ratio. */
  setPhotoAspect(aspect: number): void {
    this.photoAspect = aspect > 0 ? aspect : 1;
    this.updatePreview();
  }

  /** Show an actual snapshot of the current (edited, cropped) photo inside the preview, or clear it. */
  setPhotoThumbnail(dataUrl: string | null): void {
    if (dataUrl) {
      this.previewPhoto.style.backgroundImage = `url(${dataUrl})`;
      this.previewPhoto.style.backgroundSize = 'cover';
      this.previewPhoto.style.backgroundPosition = 'center';
    } else {
      this.previewPhoto.style.backgroundImage = '';
      this.previewPhoto.style.backgroundSize = '';
      this.previewPhoto.style.backgroundPosition = '';
    }
  }

  /** Re-measure the preview box — call after it becomes visible (e.g. the Export tab is selected). */
  refreshLayout(): void {
    this.updatePreview();
  }

  private setFormat(format: ExportFormat): void {
    this.format = format;
    for (const [key, button] of this.formatButtons) {
      button.classList.toggle('selected', key === format);
    }
    this.updateBorderControls();
    this.updatePreview();
  }

  private updateBorderControls(): void {
    this.borderSliderInput.disabled = !this.borderEnabled;
  }

  private updatePreview(): void {
    const showsNothing = this.format === 'original' && !this.borderEnabled;
    this.previewBox.classList.toggle('hidden', showsNothing);
    if (showsNothing) return;

    const containerWidth = this.previewBox.parentElement?.clientWidth || PREVIEW_MAX_WIDTH;
    const canvasW = Math.min(containerWidth, PREVIEW_MAX_WIDTH);

    if (this.format === 'original') {
      // No fixed target shape — the framed canvas keeps the photo's own aspect
      // ratio, so the border is added proportionally to each dimension (see
      // GlRenderer.composeBorderedOriginalBlob for the matching export math).
      const canvasH = canvasW / this.photoAspect;
      this.previewBox.style.width = `${canvasW}px`;
      this.previewBox.style.height = `${canvasH}px`;

      const p = this.borderPercent / 100;
      const factor = p / (1 + 2 * p);
      const padX = canvasW * factor;
      const padY = canvasH * factor;
      this.previewBox.style.padding = `${padY}px ${padX}px`;
      this.previewPhoto.style.width = `${canvasW - 2 * padX}px`;
      this.previewPhoto.style.height = `${canvasH - 2 * padY}px`;
      return;
    }

    const { width: targetW, height: targetH } = FRAME_SIZES[this.format];
    const aspect = targetW / targetH;
    const canvasH = canvasW / aspect;

    this.previewBox.style.width = `${canvasW}px`;
    this.previewBox.style.height = `${canvasH}px`;

    const borderPx = this.borderEnabled ? (this.borderPercent / 100) * Math.min(canvasW, canvasH) : 0;
    this.previewBox.style.padding = `${borderPx}px`;

    const innerW = Math.max(1, canvasW - borderPx * 2);
    const innerH = Math.max(1, canvasH - borderPx * 2);
    let photoW = innerW;
    let photoH = photoW / this.photoAspect;
    if (photoH > innerH) {
      photoH = innerH;
      photoW = photoH * this.photoAspect;
    }
    this.previewPhoto.style.width = `${photoW}px`;
    this.previewPhoto.style.height = `${photoH}px`;
  }
}
