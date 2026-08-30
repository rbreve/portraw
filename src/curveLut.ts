// Pure tone-curve sampling. DOM controls and WebGL upload both depend on this
// module without depending on each other.
import {
  createDefaultToneCurveState,
  CURVE_CHANNELS,
  type CurveChannel,
  type CurvePoint,
  type ToneCurveState,
} from './state';

export const CURVE_LUT_SIZE = 256;
export type CurveLutSet = Record<CurveChannel, Float32Array>;

/** Sample every persisted curve in shader row order. */
export function buildCurveLuts(curves: ToneCurveState): CurveLutSet {
  return Object.fromEntries(
    CURVE_CHANNELS.map((channel) => [channel, buildCurveLut(curves[channel])]),
  ) as CurveLutSet;
}

/** Four identity LUTs used before the editor binds its persisted state. */
export function createIdentityCurveLuts(): CurveLutSet {
  return buildCurveLuts(createDefaultToneCurveState());
}

/**
 * Interpolate control points with monotone cubic Hermite splines
 * (Fritsch–Carlson), avoiding overshoot between points.
 */
export function buildCurveLut(points: CurvePoint[], size = CURVE_LUT_SIZE): Float32Array {
  if (points.length < 2) throw new Error('A tone curve requires at least two control points');

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const tangents = calculateTangents(xs, ys);
  return sampleSegments(xs, ys, tangents, size);
}

function calculateTangents(xs: number[], ys: number[]): number[] {
  const slopes = xs.slice(0, -1).map((x, index) => (ys[index + 1] - ys[index]) / (xs[index + 1] - x));
  const tangents = [slopes[0]];
  for (let index = 1; index < xs.length - 1; index++) {
    const adjacentSlopesOppose = slopes[index - 1] * slopes[index] <= 0;
    tangents.push(adjacentSlopesOppose ? 0 : (slopes[index - 1] + slopes[index]) / 2);
  }
  tangents.push(slopes.at(-1)!);

  for (let index = 0; index < slopes.length; index++) {
    limitSegmentTangents(tangents, slopes[index], index);
  }
  return tangents;
}

/** Fritsch–Carlson limiter: clamp tangent magnitude so a segment cannot overshoot. */
function limitSegmentTangents(tangents: number[], slope: number, index: number): void {
  if (slope === 0) {
    tangents[index] = 0;
    tangents[index + 1] = 0;
    return;
  }
  const startRatio = tangents[index] / slope;
  const endRatio = tangents[index + 1] / slope;
  const magnitude = Math.hypot(startRatio, endRatio);
  if (magnitude <= 3) return;

  tangents[index] = (3 / magnitude) * startRatio * slope;
  tangents[index + 1] = (3 / magnitude) * endRatio * slope;
}

function sampleSegments(xs: number[], ys: number[], tangents: number[], size: number): Float32Array {
  const lut = new Float32Array(size);
  let segment = 0;
  for (let sample = 0; sample < size; sample++) {
    const x = sample / (size - 1);
    while (segment < xs.length - 2 && x > xs[segment + 1]) segment++;
    lut[sample] = sampleSegment(x, segment, xs, ys, tangents);
  }
  return lut;
}

function sampleSegment(x: number, index: number, xs: number[], ys: number[], tangents: number[]): number {
  const width = xs[index + 1] - xs[index];
  const t = clamp01((x - xs[index]) / width);
  const t2 = t * t;
  const t3 = t2 * t;
  return clamp01(
    (2 * t3 - 3 * t2 + 1) * ys[index] +
      (t3 - 2 * t2 + t) * width * tangents[index] +
      (-2 * t3 + 3 * t2) * ys[index + 1] +
      (t3 - t2) * width * tangents[index + 1],
  );
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
