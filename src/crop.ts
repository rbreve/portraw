// Crop tool: a sidebar panel (mode + actions) plus an interactive overlay drawn
// on top of the viewport. Arranging is always relative to the FULL image — the
// caller is expected to make the renderer show the uncropped image for the
// duration (see CropOverlayCallbacks.onModeChange) so the overlay's coordinate
// space always matches what's on screen.
//
// CropRect is normalized [0,1] against the full image (see state.ts). In that
// space "locked to the photo's aspect ratio" reduces to width === height: a
// normalized width is a fraction of image width, a normalized height a
// fraction of image height, so equal fractions always yield the same pixel
// aspect ratio as the source image.
import type { CropRect } from './state';

export type CropMode = 'freeform' | 'locked';
type Corner = 'nw' | 'ne' | 'sw' | 'se';
type DragMode = 'move' | Corner;

const MIN_SIZE = 0.05;
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

// Mirror-axis icons: a center line with arrows pointing outward along the
// axis being flipped (vertical line + horizontal arrows = flip horizontal).
const FLIP_H_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M16 8l4 4-4 4"/><path d="M8 8L4 12l4 4"/></svg>`;
const FLIP_V_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M8 16l4 4 4-4"/><path d="M8 8l4-4 4 4"/></svg>`;

export interface CropOverlayCallbacks {
  /** The crop rect currently applied to the live image, if any. */
  getCrop: () => CropRect | null;
  /** Commit the arranged rectangle as the new crop. */
  onApply: (crop: CropRect) => void;
  /** Clear any applied crop. */
  onReset: () => void;
  /** Fires when arranging starts/stops — caller should show/hide the full image. */
  onModeChange: (arranging: boolean) => void;
  /** The flip state currently applied to the live image. */
  getFlip: () => { horizontal: boolean; vertical: boolean };
  /** Toggle mirroring the image along the given axis. */
  onToggleFlip: (axis: 'horizontal' | 'vertical') => void;
}

export class CropOverlay {
  readonly element: HTMLElement;

  private readonly callbacks: CropOverlayCallbacks;
  private readonly overlayEl: HTMLElement;
  private readonly boundsEl: HTMLElement;
  private readonly rectEl: HTMLElement;
  private readonly maskTop: HTMLElement;
  private readonly maskBottom: HTMLElement;
  private readonly maskLeft: HTMLElement;
  private readonly maskRight: HTMLElement;
  private readonly primaryButton: HTMLButtonElement;
  private readonly flipHButton: HTMLButtonElement;
  private readonly flipVButton: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly modeButtons = new Map<CropMode, HTMLButtonElement>();

  private imageWidth = 0;
  private imageHeight = 0;
  private mode: CropMode = 'freeform';
  private arranging = false;
  private rect: CropRect = fullRect();

  private dragMode: DragMode | null = null;
  private dragStartPointer = { x: 0, y: 0 };
  private dragStartRect: CropRect = fullRect();

  constructor(viewport: HTMLElement, callbacks: CropOverlayCallbacks) {
    this.callbacks = callbacks;

    // --- canvas overlay: mask + draggable rectangle -----------------------
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'crop-overlay hidden';

    this.boundsEl = document.createElement('div');
    this.boundsEl.className = 'crop-bounds';

    this.maskTop = document.createElement('div');
    this.maskTop.className = 'crop-mask crop-mask-top';
    this.maskBottom = document.createElement('div');
    this.maskBottom.className = 'crop-mask crop-mask-bottom';
    this.maskLeft = document.createElement('div');
    this.maskLeft.className = 'crop-mask crop-mask-left';
    this.maskRight = document.createElement('div');
    this.maskRight.className = 'crop-mask crop-mask-right';

    this.rectEl = document.createElement('div');
    this.rectEl.className = 'crop-rect';
    for (const corner of CORNERS) {
      const handle = document.createElement('div');
      handle.className = `crop-handle crop-handle-${corner}`;
      handle.dataset.corner = corner;
      this.rectEl.append(handle);
    }

    this.boundsEl.append(this.maskTop, this.maskBottom, this.maskLeft, this.maskRight, this.rectEl);
    this.overlayEl.append(this.boundsEl);
    viewport.append(this.overlayEl);

    this.overlayEl.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.overlayEl.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.overlayEl.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.overlayEl.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.overlayEl.addEventListener('dblclick', () => {
      if (this.arranging) this.commit();
    });
    document.addEventListener('keydown', (e) => this.onKeyDown(e));

    // --- sidebar controls ---------------------------------------------------
    this.hint = document.createElement('p');
    this.hint.className = 'crop-hint';
    this.hint.textContent = 'Drag the corners to frame the shot — Enter or double-click to crop, Esc to cancel.';

    const modeRow = document.createElement('div');
    modeRow.className = 'segmented';
    for (const [mode, label] of [
      ['freeform', 'Freeform'],
      ['locked', 'Locked ratio'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => this.setMode(mode));
      this.modeButtons.set(mode, button);
      modeRow.append(button);
    }

    const flipRow = document.createElement('div');
    flipRow.className = 'crop-actions';

    this.flipHButton = document.createElement('button');
    this.flipHButton.type = 'button';
    this.flipHButton.className = 'icon-label-button';
    this.flipHButton.innerHTML = `${FLIP_H_ICON}<span>Flip horizontal</span>`;
    this.flipHButton.disabled = true;
    this.flipHButton.addEventListener('click', () => this.toggleFlip('horizontal'));

    this.flipVButton = document.createElement('button');
    this.flipVButton.type = 'button';
    this.flipVButton.className = 'icon-label-button';
    this.flipVButton.innerHTML = `${FLIP_V_ICON}<span>Flip vertical</span>`;
    this.flipVButton.disabled = true;
    this.flipVButton.addEventListener('click', () => this.toggleFlip('vertical'));

    flipRow.append(this.flipHButton, this.flipVButton);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'crop-actions';

    this.primaryButton = document.createElement('button');
    this.primaryButton.type = 'button';
    this.primaryButton.className = 'primary';
    this.primaryButton.textContent = 'Apply crop';
    this.primaryButton.disabled = true;
    this.primaryButton.addEventListener('click', () => this.commit());

    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.textContent = 'Reset crop';
    resetButton.addEventListener('click', () => this.reset());

    actionsRow.append(this.primaryButton, resetButton);

    this.element = document.createElement('div');
    this.element.className = 'crop-panel';
    this.element.append(modeRow, flipRow, actionsRow, this.hint);

    this.updateModeButtons();
    this.updateFlipButtons();
    this.updateHint();
  }

  /** Called whenever a new image is decoded — enables the tool and resizes the mask. */
  setImageSize(width: number, height: number): void {
    this.imageWidth = width;
    this.imageHeight = height;
    this.primaryButton.disabled = false;
    this.flipHButton.disabled = false;
    this.flipVButton.disabled = false;
    this.refreshLayout();
  }

  /** Re-sync the flip button highlight with live state, e.g. after a new photo resets it. */
  syncFlipButtons(): void {
    this.updateFlipButtons();
  }

  /** Enter arranging mode, e.g. when the Crop tab is selected — a no-op if already arranging or no image is loaded. */
  startArranging(): void {
    if (!this.imageWidth || !this.imageHeight || this.arranging) return;
    this.enterArranging();
  }

  /** Commit the in-progress arrangement, e.g. when navigating away from the Crop tab — a no-op if not arranging. */
  finishArranging(): void {
    if (this.arranging) this.commit();
  }

  /** Re-measure the letterboxed image rect (e.g. on viewport resize). */
  refreshLayout(): void {
    if (!this.imageWidth || !this.imageHeight) return;
    const containerW = this.overlayEl.clientWidth;
    const containerH = this.overlayEl.clientHeight;
    if (containerW <= 0 || containerH <= 0) return;
    const scale = Math.min(containerW / this.imageWidth, containerH / this.imageHeight);
    const w = this.imageWidth * scale;
    const h = this.imageHeight * scale;
    this.boundsEl.style.left = `${(containerW - w) / 2}px`;
    this.boundsEl.style.top = `${(containerH - h) / 2}px`;
    this.boundsEl.style.width = `${w}px`;
    this.boundsEl.style.height = `${h}px`;
  }

  // --- mode / actions ----------------------------------------------------------

  private setMode(mode: CropMode): void {
    this.mode = mode;
    if (mode === 'locked' && this.arranging) {
      const size = Math.min(this.rect.width, this.rect.height);
      const cx = this.rect.x + this.rect.width / 2;
      const cy = this.rect.y + this.rect.height / 2;
      this.rect = centeredSquare(cx, cy, size);
      this.syncRectLayout();
    }
    this.updateModeButtons();
  }

  private enterArranging(): void {
    this.arranging = true;
    this.rect = this.callbacks.getCrop() ?? fullRect();
    this.overlayEl.classList.remove('hidden');
    this.refreshLayout();
    this.syncRectLayout();
    this.updateHint();
    this.callbacks.onModeChange(true);
  }

  private exitArranging(): void {
    this.arranging = false;
    this.overlayEl.classList.add('hidden');
    this.updateHint();
    this.callbacks.onModeChange(false);
  }

  private commit(): void {
    this.callbacks.onApply({ ...this.rect });
    this.exitArranging();
  }

  private reset(): void {
    this.rect = fullRect();
    this.callbacks.onReset();
    if (this.arranging) this.syncRectLayout();
  }

  private updateModeButtons(): void {
    for (const [mode, button] of this.modeButtons) {
      button.classList.toggle('selected', mode === this.mode);
    }
  }

  private toggleFlip(axis: 'horizontal' | 'vertical'): void {
    this.callbacks.onToggleFlip(axis);
    this.updateFlipButtons();
  }

  private updateFlipButtons(): void {
    const flip = this.callbacks.getFlip();
    this.flipHButton.classList.toggle('selected', flip.horizontal);
    this.flipVButton.classList.toggle('selected', flip.vertical);
  }

  private updateHint(): void {
    this.hint.classList.toggle('hidden', !this.arranging);
  }

  // --- pointer interaction -------------------------------------------------------

  private toImageSpace(e: PointerEvent): { x: number; y: number } {
    const rect = this.boundsEl.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    };
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.arranging) return;
    const target = e.target as HTMLElement;
    const corner = target.dataset.corner as Corner | undefined;
    if (corner) {
      this.dragMode = corner;
    } else if (target === this.rectEl) {
      this.dragMode = 'move';
    } else {
      return; // click landed on the mask outside the rect — ignore
    }
    this.dragStartPointer = this.toImageSpace(e);
    this.dragStartRect = { ...this.rect };
    this.overlayEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragMode) return;
    const p = this.toImageSpace(e);
    if (this.dragMode === 'move') this.moveRect(p);
    else this.resizeRect(this.dragMode, p);
    this.syncRectLayout();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.dragMode) return;
    this.dragMode = null;
    this.overlayEl.releasePointerCapture(e.pointerId);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.arranging) return;
    const activeTag = document.activeElement?.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.exitArranging();
    }
  }

  private moveRect(p: { x: number; y: number }): void {
    const dx = p.x - this.dragStartPointer.x;
    const dy = p.y - this.dragStartPointer.y;
    const { width, height } = this.dragStartRect;
    this.rect = {
      x: clamp(this.dragStartRect.x + dx, 0, 1 - width),
      y: clamp(this.dragStartRect.y + dy, 0, 1 - height),
      width,
      height,
    };
  }

  private resizeRect(corner: Corner, p: { x: number; y: number }): void {
    const start = this.dragStartRect;
    // The anchor is the corner opposite the one being dragged — it stays fixed.
    const anchorX = corner === 'ne' || corner === 'se' ? start.x : start.x + start.width;
    const anchorY = corner === 'sw' || corner === 'se' ? start.y : start.y + start.height;
    const dirX = corner === 'ne' || corner === 'se' ? 1 : -1;
    const dirY = corner === 'sw' || corner === 'se' ? 1 : -1;
    const boundX = dirX > 0 ? 1 - anchorX : anchorX;
    const boundY = dirY > 0 ? 1 - anchorY : anchorY;

    let width: number;
    let height: number;
    if (this.mode === 'locked') {
      const desired = Math.max(MIN_SIZE, (p.x - anchorX) * dirX, (p.y - anchorY) * dirY);
      const size = Math.min(desired, boundX, boundY);
      width = size;
      height = size;
    } else {
      width = clamp((p.x - anchorX) * dirX, MIN_SIZE, boundX);
      height = clamp((p.y - anchorY) * dirY, MIN_SIZE, boundY);
    }

    this.rect = {
      x: dirX > 0 ? anchorX : anchorX - width,
      y: dirY > 0 ? anchorY : anchorY - height,
      width,
      height,
    };
  }

  private syncRectLayout(): void {
    const { x, y, width, height } = this.rect;
    this.rectEl.style.left = `${x * 100}%`;
    this.rectEl.style.top = `${y * 100}%`;
    this.rectEl.style.width = `${width * 100}%`;
    this.rectEl.style.height = `${height * 100}%`;

    // Four independent panels darken everything outside the rect — simpler
    // and less clip-prone than a box-shadow spotlight, which would need an
    // overflow:hidden ancestor that also clips the corner handles.
    this.maskTop.style.height = `${y * 100}%`;
    this.maskBottom.style.height = `${(1 - y - height) * 100}%`;
    this.maskLeft.style.top = `${y * 100}%`;
    this.maskLeft.style.height = `${height * 100}%`;
    this.maskLeft.style.width = `${x * 100}%`;
    this.maskRight.style.top = `${y * 100}%`;
    this.maskRight.style.height = `${height * 100}%`;
    this.maskRight.style.width = `${(1 - x - width) * 100}%`;
  }
}

function fullRect(): CropRect {
  return { x: 0, y: 0, width: 1, height: 1 };
}

function centeredSquare(cx: number, cy: number, size: number): CropRect {
  const clamped = Math.min(size, 1);
  return {
    x: clamp(cx - clamped / 2, 0, 1 - clamped),
    y: clamp(cy - clamped / 2, 0, 1 - clamped),
    width: clamped,
    height: clamped,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
