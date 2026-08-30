// SVG tone-curve editor.
//
// Control points live in normalized [0,1]^2 space (x = input, y = output).
// RGB is the master curve; Red, Green, and Blue are independent channel curves.
// On every change all four are sampled into LUTs for one GPU texture upload.

import {
  cloneToneCurveState,
  createDefaultCurvePoints,
  createDefaultToneCurveState,
  CURVE_CHANNELS,
  type CurveChannel,
  type CurvePoint,
  type ToneCurveState,
} from './state';
import { buildCurveLut, buildCurveLuts, CURVE_LUT_SIZE, type CurveLutSet } from './curveLut';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW = CURVE_LUT_SIZE;
const MIN_POINT_GAP_X = 0.02;
const DOUBLE_CLICK_MS = 350;

const CHANNEL_LABELS: Record<CurveChannel, string> = {
  rgb: 'RGB',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
};

export class CurveEditor {
  readonly element: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly path: SVGPathElement;
  private readonly histogramPath: SVGPathElement;
  private readonly handleLayer: SVGGElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly channelButtons = new Map<CurveChannel, HTMLButtonElement>();
  private toneCurves = createDefaultToneCurveState();
  private activeChannel: CurveChannel = 'rgb';
  private dragIndex = -1;
  // Native 'dblclick' can't be used here: rebuild() replaces every handle
  // element on each pointerdown, and browsers key click-count tracking off
  // the event target, so a second click on a freshly recreated node never
  // registers as a double click. Track it ourselves instead.
  private lastPointerDownAt = 0;
  private lastPointerDownIndex = -1;

  constructor(private readonly onChange: (luts: CurveLutSet, curves: ToneCurveState) => void) {
    const channelTabs = document.createElement('div');
    channelTabs.className = 'segmented curve-channels';
    channelTabs.setAttribute('role', 'tablist');
    for (const channel of CURVE_CHANNELS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = CHANNEL_LABELS[channel];
      button.dataset.channel = channel;
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => this.selectChannel(channel));
      this.channelButtons.set(channel, button);
      channelTabs.append(button);
    }

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${VIEW} ${VIEW}`);
    this.svg.classList.add('curve-svg');
    this.svg.append(makeGrid());

    this.histogramPath = document.createElementNS(SVG_NS, 'path');
    this.histogramPath.classList.add('curve-histogram');
    this.path = document.createElementNS(SVG_NS, 'path');
    this.path.classList.add('curve-path');
    this.handleLayer = document.createElementNS(SVG_NS, 'g');
    this.svg.append(this.histogramPath, this.path, this.handleLayer);

    this.resetButton = document.createElement('button');
    this.resetButton.addEventListener('click', () => this.resetActiveCurve());

    this.element = document.createElement('div');
    this.element.className = 'curve-editor';
    this.element.append(channelTabs, this.svg, this.resetButton);

    this.svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.svg.addEventListener('pointerup', () => (this.dragIndex = -1));

    this.updateChannelUi();
    this.resetAll();
  }

  private get points(): CurvePoint[] {
    return this.toneCurves[this.activeChannel];
  }

  /**
   * Draw the image's luminance histogram (256 bins, same domain as the
   * curve's x axis) as a filled area behind the curve.
   */
  setHistogram(bins: Uint32Array): void {
    // Normalize against the interior peak: the extreme bins collect every
    // crushed/blown pixel and a single spike there would flatten the rest.
    let peak = 0;
    for (let i = 1; i < bins.length - 1; i++) peak = Math.max(peak, bins[i]);
    if (peak === 0) peak = Math.max(1, bins[0], bins[bins.length - 1]);

    const d = [`M0,${VIEW}`];
    for (let i = 0; i < bins.length; i++) {
      const x = (i / (bins.length - 1)) * VIEW;
      const y = (1 - Math.min(1, bins[i] / peak)) * VIEW;
      d.push(`L${x.toFixed(1)},${y.toFixed(1)}`);
    }
    d.push(`L${VIEW},${VIEW} Z`);
    this.histogramPath.setAttribute('d', d.join(' '));
  }

  /** Reset the selected channel without disturbing the other curves. */
  resetActiveCurve(): void {
    this.toneCurves[this.activeChannel] = createDefaultCurvePoints();
    this.rebuild();
  }

  /** Back to four identity (linear) curves. */
  resetAll(): void {
    this.toneCurves = createDefaultToneCurveState();
    this.rebuild();
  }

  /** Replace all curves from a loaded preset/session and redraw. */
  setToneCurves(curves: ToneCurveState): void {
    this.toneCurves = cloneToneCurveState(curves);
    for (const channel of CURVE_CHANNELS) {
      this.toneCurves[channel] = this.toneCurves[channel].map((point) => ({
        x: clamp01(point.x),
        y: clamp01(point.y),
      }));
    }
    this.rebuild();
  }

  private selectChannel(channel: CurveChannel): void {
    if (this.activeChannel === channel) return;
    this.activeChannel = channel;
    this.dragIndex = -1;
    this.updateChannelUi();
    this.rebuild(false);
  }

  private updateChannelUi(): void {
    this.element?.setAttribute('data-channel', this.activeChannel);
    for (const [channel, button] of this.channelButtons) {
      const selected = channel === this.activeChannel;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', String(selected));
    }
    this.resetButton.textContent = `Reset ${CHANNEL_LABELS[this.activeChannel]} curve`;
  }

  // --- pointer interaction ---------------------------------------------------

  private toCurveSpace(e: PointerEvent | MouseEvent): CurvePoint {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01(1 - (e.clientY - rect.top) / rect.height), // svg y points down
    };
  }

  private hitTest(p: CurvePoint): number {
    const radius = 0.05;
    return this.points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < radius);
  }

  private onPointerDown(e: PointerEvent): void {
    const p = this.toCurveSpace(e);
    const hitIndex = this.hitTest(p);

    if (hitIndex !== -1) {
      const isDoubleClick =
        hitIndex === this.lastPointerDownIndex && e.timeStamp - this.lastPointerDownAt < DOUBLE_CLICK_MS;
      this.lastPointerDownAt = e.timeStamp;
      this.lastPointerDownIndex = hitIndex;
      // Endpoints can be moved but never removed.
      if (isDoubleClick && hitIndex > 0 && hitIndex < this.points.length - 1) {
        this.points.splice(hitIndex, 1);
        this.lastPointerDownIndex = -1; // don't chain into a triple-click removal
        this.rebuild();
        return;
      }
      this.dragIndex = hitIndex;
      this.svg.setPointerCapture(e.pointerId);
      this.movePoint(hitIndex, p);
      return;
    }

    this.lastPointerDownAt = e.timeStamp;
    this.lastPointerDownIndex = -1;
    // Click on empty space: insert a new point, keeping the array x-sorted.
    const insertAt = this.points.findIndex((q) => q.x > p.x);
    if (insertAt <= 0) return; // never insert outside the endpoints
    this.points.splice(insertAt, 0, p);
    this.dragIndex = insertAt;
    this.svg.setPointerCapture(e.pointerId);
    this.movePoint(insertAt, p);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.dragIndex !== -1) this.movePoint(this.dragIndex, this.toCurveSpace(e));
  }

  private movePoint(index: number, target: CurvePoint): void {
    const last = this.points.length - 1;
    // Endpoints can slide horizontally too, bounded by [0, 1] and by their
    // neighbor's gap; the curve flattens beyond the outermost point's x (see
    // the clamped segment parameter in buildCurveLut).
    const lo = index === 0 ? 0 : this.points[index - 1].x + MIN_POINT_GAP_X;
    const hi = index === last ? 1 : this.points[index + 1].x - MIN_POINT_GAP_X;
    const x = clamp(target.x, lo, hi);
    this.points[index] = { x, y: target.y };
    this.rebuild();
  }

  // --- rendering + LUT ---------------------------------------------------------

  private rebuild(notify = true): void {
    const lut = buildCurveLut(this.points);

    const d = Array.from(lut, (y, i) => {
      const px = (i / (VIEW - 1)) * VIEW;
      const py = (1 - y) * VIEW;
      return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
    }).join(' ');
    this.path.setAttribute('d', d);

    this.handleLayer.replaceChildren(
      ...this.points.map((p) => {
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', String(p.x * VIEW));
        c.setAttribute('cy', String((1 - p.y) * VIEW));
        c.setAttribute('r', '6');
        c.classList.add('curve-handle');
        return c;
      }),
    );

    if (notify) this.onChange(buildCurveLuts(this.toneCurves), cloneToneCurveState(this.toneCurves));
  }
}

// --- small helpers -------------------------------------------------------------

function makeGrid(): SVGGElement {
  const grid = document.createElementNS(SVG_NS, 'g');
  grid.classList.add('curve-grid');
  for (let i = 0; i <= 4; i++) {
    const pos = (i / 4) * VIEW;
    for (const [x1, y1, x2, y2] of [
      [pos, 0, pos, VIEW],
      [0, pos, VIEW, pos],
    ]) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
      grid.append(line);
    }
  }
  return grid;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
