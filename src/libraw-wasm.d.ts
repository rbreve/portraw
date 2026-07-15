// Minimal local typings for libraw-wasm@1.1.2 — the published package ships
// only dist/* without its index.d.ts. Covers exactly the surface we use.
declare module 'libraw-wasm' {
  export interface LibRawSettings {
    /** Output at half linear size (quarter pixel count) — fast preview decode. */
    halfSize?: boolean;
    /** Highlight mode, dcraw -H (0 = clip). */
    highlight?: number;
    /** Apply the camera's recorded white balance, dcraw -w. */
    useCameraWb?: boolean;
    /** Output colorspace, dcraw -o (1 = sRGB primaries). */
    outputColor?: number;
    /** Bits per sample, dcraw -4 (8 or 16). */
    outputBps?: number;
    /** Disable auto-brightening, dcraw -W. */
    noAutoBright?: boolean;
    /** Transfer curve [power, toe_slope]; [1, 1] = linear. */
    gamm?: [number, number] | null;
    /** Demosaic quality, dcraw -q. */
    userQual?: number;
  }

  export interface RawImageData {
    width: number;
    height: number;
    /** Samples per pixel (3 = RGB, 4 = RGBA). */
    colors: number;
    bits: number;
    dataSize: number;
    data: Uint8Array | Uint16Array;
  }

  export default class LibRaw {
    /** The package's internal worker — exposed so callers can terminate it. */
    worker: Worker;
    /** Decode the RAW buffer. NOTE: transfers (detaches) the buffer to its worker. */
    open(bytes: Uint8Array, settings?: LibRawSettings): Promise<void>;
    imageData(): Promise<RawImageData>;
    metadata(fullOutput?: boolean): Promise<Record<string, unknown>>;
  }
}
