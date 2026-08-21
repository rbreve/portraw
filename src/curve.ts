// SVG tone-curve editor.
//
// Control points live in normalized [0,1]^2 space (x = input, y = output).
// On every change the curve is interpolated with monotone cubic Hermite
// splines (Fritsch–Carlson — no overshoot between points) and sampled into a
// 256-entry LUT which the caller uploads as the shader's curve texture.

import { createDefaultCurvePoints, type CurvePoint } from './state';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW = 256; // svg viewBox size; also the LUT size
const MIN_POINT_GAP_X = 0.02;
const DOUBLE_CLICK_MS = 350;

export class CurveEditor {
  readonly element: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly path: SVGPathElement;
  private readonly histogramPath: SVGPathElement;
  private readonly handleLayer: SVGGElement;
  private points: CurvePoint[] = [];
  private dragIndex = -1;
  // Native 'dblclick' can't be used here: rebuild() replaces every handle
  // element on each pointerdown, and browsers key click-count tracking off
  // the event target, so a second click on a freshly recreated node never
  // registers as a double click. Track it ourselves instead.
  private lastPointerDownAt = 0;
  private lastPointerDownIndex = -1;

  constructor(private readonly onChange: (lut: Float32Array, points: CurvePoint[]) => void) {
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

    const resetButton = document.createElement('button');
    resetButton.textContent = 'Reset curve';
    resetButton.addEventListener('click', () => this.reset());

    this.element = document.createElement('div');
    this.element.className = 'curve-editor';
    this.element.append(this.svg, resetButton);

    this.svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.svg.addEventListener('pointerup', () => (this.dragIndex = -1));

    this.reset();
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

  /** Back to the identity (linear) curve. */
  reset(): void {
    this.points = createDefaultCurvePoints();
    this.rebuild();
  }

  /** A copy of the current control points (e.g. to persist in a preset/session). */
  getPoints(): CurvePoint[] {
    return this.points.map((p) => ({ ...p }));
  }

  /** Replace the curve with externally-supplied points (e.g. from a loaded preset/session) and redraw. */
  setPoints(points: CurvePoint[]): void {
    this.points = points.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }));
    this.rebuild();
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
    // the clamp01 in sampleMonotoneCubic).
    const lo = index === 0 ? 0 : this.points[index - 1].x + MIN_POINT_GAP_X;
    const hi = index === last ? 1 : this.points[index + 1].x - MIN_POINT_GAP_X;
    const x = clamp(target.x, lo, hi);
    this.points[index] = { x, y: target.y };
    this.rebuild();
  }

  // --- rendering + LUT ---------------------------------------------------------

  private rebuild(): void {
    const lut = sampleMonotoneCubic(this.points, VIEW);

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

    this.onChange(lut, this.getPoints());
  }
}

// --- monotone cubic interpolation (Fritsch–Carlson) ---------------------------

function sampleMonotoneCubic(points: CurvePoint[], size: number): Float32Array {
  const n = points.length;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);

  // Secant slopes between knots, then knot tangents.
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) slopes.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));

  const tangents = [slopes[0]];
  for (let i = 1; i < n - 1; i++) {
    // Opposite-sign secants mean a local extremum: flat tangent keeps it monotone.
    tangents.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
  }
  tangents.push(slopes[n - 2]);

  // Fritsch–Carlson limiter: clamp tangent magnitude so no segment overshoots.
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const norm = Math.hypot(a, b);
    if (norm > 3) {
      tangents[i] = (3 / norm) * a * slopes[i];
      tangents[i + 1] = (3 / norm) * b * slopes[i];
    }
  }

  // Evaluate the Hermite segments at uniform x.
  const lut = new Float32Array(size);
  let segment = 0;
  for (let k = 0; k < size; k++) {
    const x = k / (size - 1);
    while (segment < n - 2 && x > xs[segment + 1]) segment++;
    const h = xs[segment + 1] - xs[segment];
    const t = clamp01((x - xs[segment]) / h);
    const t2 = t * t;
    const t3 = t2 * t;
    lut[k] = clamp01(
      (2 * t3 - 3 * t2 + 1) * ys[segment] +
        (t3 - 2 * t2 + t) * h * tangents[segment] +
        (-2 * t3 + 3 * t2) * ys[segment + 1] +
        (t3 - t2) * h * tangents[segment + 1],
    );
  }
  return lut;
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
