// Instagram-style export framing: pick a canvas format (square / horizontal /
// vertical, using Instagram's recommended aspect ratios — see FRAME_SIZES in
// gl.ts), choose the output width, and optionally pad the photo so the whole shot fits
// inside without Instagram's feed auto-crop clipping it. This module only
// owns the settings UI + a live preview swatch; the actual pixel compositing
// happens in GlRenderer.exportBlob.
import { makeBoundSlider } from './controls';
import { FRAME_SIZES, type ExportFormat } from './gl';

export interface ExportFrameSettings {
  format: ExportFormat;
  borderPercent: number;
  borderColor: string;
  width: number;
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
const MIN_EXPORT_WIDTH = 640;

export class ExportPanel {
  readonly element: HTMLElement;

  private readonly formatButtons = new Map<ExportFormat, HTMLButtonElement>();
  private readonly previewBox: HTMLElement;
  private readonly previewPhoto: HTMLElement;
  private readonly widthInput: HTMLInputElement;
  private readonly widthTextInput: HTMLInputElement;
  private readonly widthMinimum: HTMLElement;
  private readonly widthMaximum: HTMLElement;

  private format: ExportFormat = 'original';
  private borderPercent = 6;
  private photoAspect = 1;
  private originalWidth = MIN_EXPORT_WIDTH;
  private exportWidth = MIN_EXPORT_WIDTH;
  private followsOriginalWidth = true;

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

    const resolutionLabel = document.createElement('label');
    resolutionLabel.htmlFor = 'export-width-value';
    resolutionLabel.textContent = 'Resolution width';

    this.widthTextInput = document.createElement('input');
    this.widthTextInput.id = 'export-width-value';
    this.widthTextInput.type = 'number';
    this.widthTextInput.className = 'export-resolution-input';
    this.widthTextInput.min = String(MIN_EXPORT_WIDTH);
    this.widthTextInput.max = String(MIN_EXPORT_WIDTH);
    this.widthTextInput.step = '1';
    this.widthTextInput.value = String(MIN_EXPORT_WIDTH);
    this.widthTextInput.disabled = true;
    this.widthTextInput.addEventListener('input', () => {
      const value = this.widthTextInput.valueAsNumber;
      const minimumWidth = this.getMinimumWidth();
      if (Number.isFinite(value) && value >= minimumWidth && value <= this.originalWidth) {
        this.setExportWidth(value);
      }
    });
    this.widthTextInput.addEventListener('change', () => this.commitWidthTextInput());
    this.widthTextInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        this.commitWidthTextInput();
        this.widthTextInput.select();
      }
    });

    const resolutionValue = document.createElement('div');
    resolutionValue.className = 'export-resolution-value';
    resolutionValue.append(this.widthTextInput, 'px');

    const resolutionHeader = document.createElement('div');
    resolutionHeader.className = 'export-resolution-header';
    resolutionHeader.append(resolutionLabel, resolutionValue);

    this.widthInput = document.createElement('input');
    this.widthInput.id = 'export-width-slider';
    this.widthInput.type = 'range';
    this.widthInput.className = 'slider-input';
    this.widthInput.setAttribute('aria-label', 'Resolution width');
    this.widthInput.min = String(MIN_EXPORT_WIDTH);
    this.widthInput.max = String(MIN_EXPORT_WIDTH);
    this.widthInput.step = '1';
    this.widthInput.value = String(MIN_EXPORT_WIDTH);
    this.widthInput.disabled = true;
    this.widthInput.addEventListener('input', () => {
      this.setExportWidth(this.widthInput.valueAsNumber);
    });

    const resolutionTrack = document.createElement('div');
    resolutionTrack.className = 'slider-track';
    resolutionTrack.append(this.widthInput);

    this.widthMinimum = document.createElement('span');
    this.widthMaximum = document.createElement('span');
    const resolutionBounds = document.createElement('div');
    resolutionBounds.className = 'export-resolution-bounds';
    resolutionBounds.append(this.widthMinimum, this.widthMaximum);

    const resolution = document.createElement('div');
    resolution.className = 'export-resolution';
    resolution.append(resolutionHeader, resolutionTrack, resolutionBounds);

    const borderSlider = makeBoundSlider({
      label: 'Border size',
      min: 0,
      max: 20,
      step: 1,
      value: this.borderPercent,
      onInput: (value) => {
        this.borderPercent = value;
        this.updatePreview();
      },
    });

    this.element = document.createElement('div');
    this.element.className = 'export-frame';
    this.element.append(formatGrid, this.previewBox, resolution, borderSlider.element);

    this.updateResolutionReadout();
    this.setFormat('original');
  }

  getSettings(): ExportFrameSettings {
    return {
      format: this.format,
      borderPercent: this.borderPercent,
      borderColor: BORDER_COLOR,
      width: this.exportWidth,
    };
  }

  /** Keep the slider bounded by the current cropped photo's available pixel width. */
  setOriginalWidth(width: number, resetToOriginal = false): void {
    const previousOriginalWidth = this.originalWidth;
    const roundedWidth = Math.max(1, Math.round(width));
    const minimumWidth = Math.min(MIN_EXPORT_WIDTH, roundedWidth);
    const wasAtOriginal = this.followsOriginalWidth || this.exportWidth === previousOriginalWidth;

    this.originalWidth = roundedWidth;
    if (resetToOriginal || wasAtOriginal) {
      this.exportWidth = roundedWidth;
      this.followsOriginalWidth = true;
    } else {
      this.exportWidth = Math.max(minimumWidth, Math.min(this.exportWidth, roundedWidth));
      this.followsOriginalWidth = this.exportWidth === roundedWidth;
    }

    this.widthInput.min = String(minimumWidth);
    this.widthInput.max = String(roundedWidth);
    this.widthInput.value = String(this.exportWidth);
    this.widthInput.disabled = roundedWidth === minimumWidth;
    this.widthTextInput.min = String(minimumWidth);
    this.widthTextInput.max = String(roundedWidth);
    this.widthTextInput.disabled = roundedWidth === minimumWidth;
    this.updateResolutionReadout();
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
    this.updatePreview();
  }

  private updateResolutionReadout(): void {
    const minimumWidth = this.getMinimumWidth();
    this.widthTextInput.value = String(this.exportWidth);
    this.widthMinimum.textContent = `${minimumWidth} px`;
    this.widthMaximum.textContent = `Original (${this.originalWidth} px)`;
  }

  private getMinimumWidth(): number {
    return Math.min(MIN_EXPORT_WIDTH, this.originalWidth);
  }

  private setExportWidth(width: number): void {
    this.exportWidth = Math.max(
      this.getMinimumWidth(),
      Math.min(Math.round(width), this.originalWidth),
    );
    this.followsOriginalWidth = this.exportWidth === this.originalWidth;
    this.widthInput.value = String(this.exportWidth);
    this.updateResolutionReadout();
  }

  private commitWidthTextInput(): void {
    const value = this.widthTextInput.valueAsNumber;
    this.setExportWidth(Number.isFinite(value) ? value : this.exportWidth);
  }

  private updatePreview(): void {
    const showsNothing = this.format === 'original' && this.borderPercent <= 0;
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

    const borderPx = (this.borderPercent / 100) * Math.min(canvasW, canvasH);
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
