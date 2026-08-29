// Cheap thumbnail generation for the folder browser. Deliberately NOT the
// same path as decode.worker.ts's preview decode: this pulls the small JPEG
// preview DNGs carry embedded (skips demosaicing entirely, near-instant),
// falling back to a half-size RAW decode only when a file has none.
//
// The heavy lifting (LibRaw's own decode) already happens off the main
// thread — libraw-wasm spins up its own internal worker per instance — so
// this can be called directly from folderPanel.ts without a dedicated app
// worker.
import LibRaw from 'libraw-wasm';
import type { RawImageData } from 'libraw-wasm';

const MAX_DIMENSION = 256;

/** Larger on-demand preview for the gallery's slideshow "big photo" view. */
export const LARGE_MAX_DIMENSION = 1600;

export async function generateThumbnail(file: File, maxDimension = MAX_DIMENSION): Promise<Blob> {
  const fileBytes = new Uint8Array(await file.arrayBuffer());

  const embedded = await extractEmbeddedThumbnail(fileBytes.slice());
  const source = embedded ?? (await decodeHalfSizeThumbnail(fileBytes));
  return resizeToJpeg(source, maxDimension);
}

/** LibRaw.open() detaches the buffer it's given, so each attempt needs its own copy. */
async function extractEmbeddedThumbnail(bytes: Uint8Array<ArrayBuffer>): Promise<Blob | null> {
  const raw = new LibRaw();
  try {
    await raw.open(bytes);
    const thumb = await raw.thumbnailData();
    if (thumb?.format !== 'jpeg') return null;
    // thumb.data is a plain byte buffer from the wasm heap, never a
    // SharedArrayBuffer view — safe to assert the narrower Blob-compatible type.
    return new Blob([thumb.data as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
  } catch {
    return null;
  } finally {
    raw.dispose();
  }
}

/** Rare fallback for RAWs with no embedded JPEG preview. */
async function decodeHalfSizeThumbnail(bytes: Uint8Array<ArrayBuffer>): Promise<ImageData> {
  const raw = new LibRaw();
  try {
    await raw.open(bytes, { halfSize: true, outputBps: 8 });
    const image = await raw.imageData();
    if (!image) throw new Error('no image data');
    return toImageData(image);
  } finally {
    raw.dispose();
  }
}

function toImageData({ width, height, colors, bits, data }: RawImageData): ImageData {
  if (bits !== 8 || !(data instanceof Uint8Array)) {
    throw new Error(`expected 8-bit RGB(A) output, got ${bits}-bit`);
  }
  if (colors === 4) return new ImageData(new Uint8ClampedArray(data), width, height);
  if (colors !== 3) throw new Error(`unsupported channel count: ${colors}`);

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, src = 0, dst = 0; p < width * height; p++, src += 3, dst += 4) {
    rgba[dst] = data[src];
    rgba[dst + 1] = data[src + 1];
    rgba[dst + 2] = data[src + 2];
    rgba[dst + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

async function resizeToJpeg(source: Blob | ImageData, maxDimension: number): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}
