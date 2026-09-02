/// <reference lib="webworker" />
// ============================================================================
// decode.worker.ts — STAGE 1 of the two-stage architecture.
//
// The RAW file is decoded here EXACTLY ONCE (plus an optional fast
// half-size pass for instant preview). All subsequent edits happen in the
// fragment shader (stage 2) by changing uniforms — this worker is never
// touched again until a new file is dropped.
//
// Decode contract (what the shader assumes about its input texture):
//   * 16-bit output            (outputBps: 16)   — full sensor precision
//   * sRGB primaries           (outputColor: 1)  — known color gamut
//   * LINEAR gamma             — see below: LibRaw's BT.709 output gamma is
//                                inverted in the conversion LUT, so the
//                                texture really is scene-referred linear
//   * camera white balance     (useCameraWb)     — neutral baseline; the
//                                                  temp/tint sliders are
//                                                  RELATIVE to this
//   * auto-brighten DISABLED   (noAutoBright)    — exposure belongs to the
//                                                  user, not the decoder
//   * HIGHLIGHT HEADROOM       (highlight: 2)    — texels may exceed 1.0.
//
// Gamma: libraw-wasm IGNORES the `gamm` option (verified empirically — any
// value produces identical output), so LibRaw always applies its default
// BT.709 output curve (4.5x toe, 1.0993x^0.45 - 0.0993 above). We undo that
// exact curve in the conversion LUT below. Do NOT pass `gamm` to open(): if a
// future wrapper version starts honouring it, the default must stay BT.709 or
// this inversion silently becomes a double transform.
//
// Highlight headroom: white balance multiplies each channel by a different
// gain, so after WB the channels clip at different points — the lowest-gain
// channel (usually green) still holds real sensor data past the level where
// the others saturate. With highlight: 0 LibRaw normalises the WB gains so
// every channel clips at 65535, discarding that data. With a non-zero mode it
// normalises to the LARGEST gain instead: nothing clips, the image just comes
// out darker by the gain ratio max(mul)/min(mul). We read that ratio from the
// as-shot multipliers in the metadata and scale the linearised samples back
// up during float conversion, so 1.0 means "white" exactly as before — but
// genuinely brighter sensor data now lands ABOVE 1.0 in the half-float
// texture, where the shader's highlights/exposure sliders can pull real
// detail back down. Mode 2 additionally blends fully-blown pixels toward
// neutral so they fade to white instead of the magenta cast of raw unclipped
// data.
//
// The decoded uint16 RGB is converted here (off the main thread) into
// RGBA16F half-float bit patterns, ready for direct texImage2D upload as an
// RGBA16F texture, and posted back as a TRANSFERABLE buffer (zero-copy).
// ============================================================================
import LibRaw from 'libraw-wasm';

export interface DecodeRequest {
  /**
   * Echoed back on every response so the caller can drop stale results. The
   * worker's onmessage is async (awaits WASM decode calls), so if a second
   * file is posted before the first one's two decode passes finish, the
   * event loop interleaves them — without an id, responses for two different
   * files can arrive mixed together with no way to tell them apart.
   */
  requestId: number;
  /** Raw file bytes. Transferred into the worker. */
  fileBuffer: ArrayBuffer;
}

export type DecodeResponse =
  | { type: 'status'; requestId: number; message: string }
  | {
      type: 'image';
      requestId: number;
      /** 'preview' = fast half-size decode, 'full' = final full-res decode. */
      stage: 'preview' | 'full';
      width: number;
      height: number;
      /** Interleaved RGBA float16 bit patterns, one Uint16 per channel. */
      pixels: Uint16Array;
      /** 256-bin histogram of display-referred (sRGB-encoded) luminance. */
      histogram: Uint32Array;
    }
  | { type: 'error'; requestId: number; message: string };

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

// ---------------------------------------------------------------------------
// uint16 -> float16 conversion.
//
// LibRaw hands us integers 0..65535; the GPU wants IEEE 754 half-float bit
// patterns. Only 65536 distinct inputs exist, so we precompute the whole
// mapping once and then converting a 24-megapixel image is a single
// table-lookup pass.
// ---------------------------------------------------------------------------

const float32Scratch = new Float32Array(1);
const uint32Scratch = new Uint32Array(float32Scratch.buffer);

/** IEEE 754 float32 -> float16 bit pattern (round-to-nearest-even). */
function floatToHalfBits(value: number): number {
  float32Scratch[0] = value;
  const bits = uint32Scratch[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  let mantissa = bits & 0x7fffff;
  if (exponent <= 0) return sign; // flush subnormals/zero (inputs are >= 0 anyway)
  if (exponent >= 31) return sign | 0x7c00; // overflow -> infinity (cannot happen for our range)
  // Round mantissa to 10 bits, nearest-even.
  mantissa += 0x1000;
  if (mantissa & 0x800000) {
    mantissa = 0;
    exponent += 1;
    if (exponent >= 31) return sign | 0x7c00;
  }
  return sign | (exponent << 10) | (mantissa >>> 13);
}

const HALF_ONE = 0x3c00; // float16 bits for 1.0 (alpha channel)

// Both LUTs depend on the per-file headroom scale (see header comment), so
// they are (re)built per decode. Building 2x65536 entries costs ~1 ms; the
// preview and full pass share a scale, so the rebuild is skipped for pass 2.

/** LUT: uint16 sample value -> half-float bits of (value / 65535 * scale). */
const uint16ToHalfBits = new Uint16Array(65536);

/**
 * LUT: linear uint16 luminance -> histogram bin (0..255) in DISPLAY space.
 * The tone curve operates on sRGB-encoded values, so the histogram behind it
 * must live in the same domain — encode with the sRGB OETF before binning.
 * Headroom values (> 1.0 after scaling) count as white: they land in the top
 * bin, exactly matching what the shader displays with sliders at rest.
 */
const luminanceToBin = new Uint8Array(65536);

let lutScale = 0; // scale the LUTs were last built for (0 = never built)

/**
 * Exact inverse of LibRaw's BT.709 output curve (see header comment). The
 * breakpoint/offset are the standard Rec.709 solutions of dcraw's
 * gamma_curve(0.45, 4.5) — encode: V = L < 0.018054 ? 4.5 L
 * : 1.0992968 L^0.45 - 0.0992968.
 */
function bt709ToLinear(encoded: number): number {
  return encoded <= 0.018053968510807 * 4.5
    ? encoded / 4.5
    : Math.pow((encoded + 0.099296826809066) / 1.099296826809066, 1 / 0.45);
}

function buildLuts(scale: number): void {
  if (scale === lutScale) return;
  lutScale = scale;
  for (let i = 0; i < 65536; i++) {
    const linear = bt709ToLinear(i / 65535) * scale;
    uint16ToHalfBits[i] = floatToHalfBits(linear);
    const display = Math.min(1, linear);
    const srgb =
      display <= 0.0031308 ? display * 12.92 : 1.055 * Math.pow(display, 1 / 2.4) - 0.055;
    luminanceToBin[i] = Math.min(255, Math.round(srgb * 255));
  }
}

/**
 * Single pass over the decoded samples producing both GPU-ready pixels and
 * the curve-editor histogram:
 *  - expand interleaved uint16 RGB(A) into RGBA half-float bits (alpha forced
 *    to 1.0 — unused, but RGBA keeps the texture layout simple and aligned);
 *  - accumulate a 256-bin histogram of Rec.709 luminance, sRGB-encoded to
 *    match the tone curve's input domain.
 */
function convertPixels(
  samples: Uint16Array,
  pixelCount: number,
  channels: number,
): { rgba: Uint16Array; histogram: Uint32Array } {
  const rgba = new Uint16Array(pixelCount * 4);
  const histogram = new Uint32Array(256);
  for (let p = 0, src = 0, dst = 0; p < pixelCount; p++, src += channels, dst += 4) {
    const r = samples[src];
    const g = samples[src + 1];
    const b = samples[src + 2];
    rgba[dst] = uint16ToHalfBits[r];
    rgba[dst + 1] = uint16ToHalfBits[g];
    rgba[dst + 2] = uint16ToHalfBits[b];
    rgba[dst + 3] = HALF_ONE;
    histogram[luminanceToBin[(0.2126 * r + 0.7152 * g + 0.0722 * b) | 0]]++;
  }
  return { rgba, histogram };
}

// ---------------------------------------------------------------------------
// LibRaw decode
// ---------------------------------------------------------------------------

/**
 * Headroom scale = max/min of the white-balance multipliers actually applied
 * at decode: exactly the factor by which LibRaw's highlight-preserving scaling
 * (any `highlight` mode > 0) darkens the image relative to plain clipping.
 * Multiplying the samples back up by it restores the normal baseline while
 * leaving the preserved highlight data above 1.0.
 *
 * With useCameraWb LibRaw uses the as-shot multipliers (cam_mul) and falls
 * back to the daylight ones (pre_mul) when the file has none — mirrored here.
 * A missing 4th (second-green) entry means "same as green", per dcraw.
 */
function headroomScale(multipliers: readonly (number[] | undefined)[]): number {
  for (const source of multipliers) {
    if (!source || source.length < 3) continue;
    const mul = source.slice(0, 4);
    if (!mul[3]) mul[3] = mul[1];
    if (mul.some((gain) => !(gain > 0))) continue;
    const scale = Math.max(...mul) / Math.min(...mul);
    if (Number.isFinite(scale) && scale >= 1) return Math.min(scale, 8);
  }
  return 1;
}

async function decodeOnce(
  bytes: Uint8Array<ArrayBuffer>,
  halfSize: boolean,
): Promise<{ width: number; height: number; pixels: Uint16Array; histogram: Uint32Array }> {
  const raw = new LibRaw();
  try {
    await raw.open(bytes, {
      outputBps: 16, //      16-bit samples
      outputColor: 1, //     sRGB primaries
      useCameraWb: true, //  as-shot WB is the neutral baseline
      noAutoBright: true, // keep exposure fully user-controlled
      highlight: 2, //       keep unclipped sensor data (see header comment);
      //                     blend fully-blown pixels toward neutral
      halfSize,
    });
    const image = await raw.imageData();
    const meta = await raw.metadata(true); // full output — color_data needs it
    if (!image) throw new Error('no image data');
    if (image.bits !== 16 || !(image.data instanceof Uint16Array)) {
      throw new Error(`expected 16-bit output, got ${image.bits}-bit`);
    }
    if (image.colors !== 3 && image.colors !== 4) {
      throw new Error(`unsupported channel count: ${image.colors}`);
    }
    buildLuts(headroomScale([meta?.color_data?.cam_mul, meta?.color_data?.pre_mul]));
    const { rgba, histogram } = convertPixels(image.data, image.width * image.height, image.colors);
    return { width: image.width, height: image.height, pixels: rgba, histogram };
  } finally {
    // Each LibRaw instance owns an internal worker holding a large wasm heap;
    // release it as soon as the decode is done.
    raw.dispose();
  }
}

workerScope.onmessage = async ({ data }: MessageEvent<DecodeRequest>) => {
  const { requestId } = data;
  const post = (msg: DecodeResponse, transfer: Transferable[] = []) =>
    workerScope.postMessage(msg, transfer);

  try {
    const fileBytes = new Uint8Array(data.fileBuffer);

    // Pass 1 — half-size decode for a near-instant preview.
    // LibRaw.open() transfers (detaches) the buffer it is given, so each pass
    // gets its own copy of the file bytes.
    post({ type: 'status', requestId, message: 'Decoding preview…' });
    const preview = await decodeOnce(fileBytes.slice(), true);
    post({ type: 'image', requestId, stage: 'preview', ...preview }, [
      preview.pixels.buffer,
      preview.histogram.buffer,
    ]);

    // Pass 2 — the one true full-resolution decode.
    post({ type: 'status', requestId, message: 'Decoding full resolution…' });
    const full = await decodeOnce(fileBytes, false);
    post({ type: 'image', requestId, stage: 'full', ...full }, [full.pixels.buffer, full.histogram.buffer]);
  } catch (error) {
    post({ type: 'error', requestId, message: error instanceof Error ? error.message : String(error) });
  }
};
