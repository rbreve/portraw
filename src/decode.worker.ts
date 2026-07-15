/// <reference lib="webworker" />
// ============================================================================
// decode.worker.ts — STAGE 1 of the two-stage architecture.
//
// The DNG is decoded here EXACTLY ONCE per file (plus an optional fast
// half-size pass for instant preview). All subsequent edits happen in the
// fragment shader (stage 2) by changing uniforms — this worker is never
// touched again until a new file is dropped.
//
// Decode contract (what the shader assumes about its input texture):
//   * 16-bit output            (outputBps: 16)   — full sensor precision
//   * sRGB primaries           (outputColor: 1)  — known color gamut
//   * LINEAR gamma             (gamm: [1, 1])    — scene-referred light;
//                                                  exposure/WB math is only
//                                                  correct in linear
//   * camera white balance     (useCameraWb)     — neutral baseline; the
//                                                  temp/tint sliders are
//                                                  RELATIVE to this
//   * auto-brighten DISABLED   (noAutoBright)    — exposure belongs to the
//                                                  user, not the decoder
//
// The decoded uint16 RGB is converted here (off the main thread) into
// RGBA16F half-float bit patterns, ready for direct texImage2D upload as an
// RGBA16F texture, and posted back as a TRANSFERABLE buffer (zero-copy).
// ============================================================================
import LibRaw from 'libraw-wasm';

export interface DecodeRequest {
  /** Raw file bytes. Transferred into the worker. */
  fileBuffer: ArrayBuffer;
}

export type DecodeResponse =
  | { type: 'status'; message: string }
  | {
      type: 'image';
      /** 'preview' = fast half-size decode, 'full' = final full-res decode. */
      stage: 'preview' | 'full';
      width: number;
      height: number;
      /** Interleaved RGBA float16 bit patterns, one Uint16 per channel. */
      pixels: Uint16Array;
      /** 256-bin histogram of display-referred (sRGB-encoded) luminance. */
      histogram: Uint32Array;
    }
  | { type: 'error'; message: string };

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
  if (exponent >= 31) return sign | 0x7c00; // overflow -> infinity (cannot happen for 0..1)
  // Round mantissa to 10 bits, nearest-even.
  mantissa += 0x1000;
  if (mantissa & 0x800000) {
    mantissa = 0;
    exponent += 1;
    if (exponent >= 31) return sign | 0x7c00;
  }
  return sign | (exponent << 10) | (mantissa >>> 13);
}

/** LUT: uint16 sample value -> half-float bits of (value / 65535). */
const uint16ToHalfBits: Uint16Array = (() => {
  const lut = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) lut[i] = floatToHalfBits(i / 65535);
  return lut;
})();

const HALF_ONE = 0x3c00; // float16 bits for 1.0 (alpha channel)

/**
 * LUT: linear uint16 luminance -> histogram bin (0..255) in DISPLAY space.
 * The tone curve operates on sRGB-encoded values, so the histogram behind it
 * must live in the same domain — encode with the sRGB OETF before binning.
 */
const luminanceToBin: Uint8Array = (() => {
  const lut = new Uint8Array(65536);
  for (let i = 0; i < 65536; i++) {
    const linear = i / 65535;
    const srgb = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    lut[i] = Math.min(255, Math.round(srgb * 255));
  }
  return lut;
})();

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

async function decodeOnce(
  bytes: Uint8Array,
  halfSize: boolean,
): Promise<{ width: number; height: number; pixels: Uint16Array; histogram: Uint32Array }> {
  const raw = new LibRaw();
  try {
    await raw.open(bytes, {
      outputBps: 16, //      16-bit samples
      outputColor: 1, //     sRGB primaries
      gamm: [1, 1], //       LINEAR transfer — no gamma baked in
      useCameraWb: true, //  as-shot WB is the neutral baseline
      noAutoBright: true, // keep exposure fully user-controlled
      highlight: 0, //       plain clip; recovery is done in the shader
      halfSize,
    });
    const image = await raw.imageData();
    if (image.bits !== 16 || !(image.data instanceof Uint16Array)) {
      throw new Error(`expected 16-bit output, got ${image.bits}-bit`);
    }
    if (image.colors !== 3 && image.colors !== 4) {
      throw new Error(`unsupported channel count: ${image.colors}`);
    }
    const { rgba, histogram } = convertPixels(image.data, image.width * image.height, image.colors);
    return { width: image.width, height: image.height, pixels: rgba, histogram };
  } finally {
    // Each LibRaw instance owns an internal worker holding a large wasm heap;
    // release it as soon as the decode is done.
    raw.worker.terminate();
  }
}

workerScope.onmessage = async ({ data }: MessageEvent<DecodeRequest>) => {
  const post = (msg: DecodeResponse, transfer: Transferable[] = []) =>
    workerScope.postMessage(msg, transfer);

  try {
    const fileBytes = new Uint8Array(data.fileBuffer);

    // Pass 1 — half-size decode for a near-instant preview.
    // LibRaw.open() transfers (detaches) the buffer it is given, so each pass
    // gets its own copy of the file bytes.
    post({ type: 'status', message: 'Decoding preview…' });
    const preview = await decodeOnce(fileBytes.slice(), true);
    post({ type: 'image', stage: 'preview', ...preview }, [
      preview.pixels.buffer,
      preview.histogram.buffer,
    ]);

    // Pass 2 — the one true full-resolution decode.
    post({ type: 'status', message: 'Decoding full resolution…' });
    const full = await decodeOnce(fileBytes, false);
    post({ type: 'image', stage: 'full', ...full }, [full.pixels.buffer, full.histogram.buffer]);
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
