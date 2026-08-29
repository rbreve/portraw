// WebGL2 setup + the single fullscreen-quad edit program.
//
// The full-resolution RGBA16F texture stays resident on the GPU; render()
// only pushes uniforms and draws one quad, so every slider runs at 60fps.
// The canvas drawing buffer is viewport-sized (the GPU downscales the
// full-res texture for display); export temporarily resizes it to full res.
import * as twgl from 'twgl.js';
import fragmentSource from './shader.frag?raw';
import { colorGradeTuning } from './config';
import {
  COLOR_BANDS,
  GRADE_ZONES,
  TONE_ZONES,
  type ColorGradeState,
  type ColorMixState,
  type CropRect,
  type EditState,
} from './state';

const vertexSource = `#version 300 es
layout(location = 0) in vec2 position;
uniform vec2 u_cropOrigin; // top-left of the crop rect, in uv space
uniform vec2 u_cropScale;  // crop rect size, in uv space
uniform bool u_flipH;      // mirror the framed (post-crop) image horizontally
uniform bool u_flipV;      // mirror the framed (post-crop) image vertically
out vec2 v_uv;
void main() {
  // Decoded rows arrive top-first; GL's v axis points up, so flip v here.
  vec2 uv = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
  if (u_flipH) uv.x = 1.0 - uv.x;
  if (u_flipV) uv.y = 1.0 - uv.y;
  v_uv = u_cropOrigin + uv * u_cropScale;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

// --- Instagram-style export framing ---------------------------------------------
// "original" exports the (possibly cropped) photo pixels as-is. The other three
// composite the photo onto a fixed-size canvas at Instagram's own recommended
// pixel dimensions, centered and scaled down to fit (never upscaled beyond fit),
// so the whole photo survives Instagram's feed crop instead of being clipped.
export type ExportFormat = 'original' | 'square' | 'horizontal' | 'vertical';

export interface ExportFrameOptions {
  format: ExportFormat;
  /** 0..100, padding between the photo and the canvas edge as % of the canvas's shorter side. 0 = no extra border. */
  borderPercent: number;
  borderColor: string;
}

export const FRAME_SIZES: Record<Exclude<ExportFormat, 'original'>, { width: number; height: number }> = {
  square: { width: 1080, height: 1080 }, // 1:1
  horizontal: { width: 1080, height: 566 }, // 1.91:1
  vertical: { width: 1080, height: 1350 }, // 4:5
};

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob failed'))), mimeType, quality);
  });
}

export class GlRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly programInfo: twgl.ProgramInfo;
  private readonly quad: twgl.BufferInfo;
  private readonly imageTexture: WebGLTexture;
  private readonly curveLutTexture: WebGLTexture;
  private imageWidth = 0;
  private imageHeight = 0;
  // While the crop tool is arranging a new rectangle, render() shows the full
  // image regardless of state.crop so the overlay can reframe from scratch.
  private cropPreviewActive = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer lets canvas.toBlob() read pixels after rAF.
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not supported in this browser');
    this.gl = gl;

    this.programInfo = twgl.createProgramInfo(gl, [vertexSource, fragmentSource]);
    this.quad = twgl.createBufferInfoFromArrays(gl, {
      position: { numComponents: 2, data: [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1] },
    });

    this.imageTexture = gl.createTexture();
    this.curveLutTexture = gl.createTexture();
    this.setCurveLut(identityLut());
  }

  get hasImage(): boolean {
    return this.imageWidth > 0;
  }

  /** Toggle whether render() should ignore state.crop and show the full image. */
  setCropPreviewActive(active: boolean): void {
    this.cropPreviewActive = active;
  }

  /** Upload decoded linear pixels (RGBA float16 bits) as the source texture. */
  setImage(width: number, height: number, rgbaHalfBits: Uint16Array): void {
    const gl = this.gl;
    this.imageWidth = width;
    this.imageHeight = height;
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    // RGBA16F is sampleable with linear filtering in core WebGL2 — no
    // extension needed since we never render INTO a float target.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, rgbaHalfBits);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Upload the 256-entry master tone curve as a 256x1 R16F texture. */
  setCurveLut(lut: Float32Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.curveLutTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, lut.length, 1, 0, gl.RED, gl.FLOAT, lut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Push uniforms and draw the quad, letterboxed to the (possibly cropped) image aspect. */
  render(state: EditState): void {
    if (!this.hasImage) return;
    const gl = this.gl;
    this.sizeDrawingBufferToDisplay();

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const crop = this.cropPreviewActive ? null : state.crop;
    this.setViewportLetterboxed(crop);
    this.draw(state, crop);
  }

  /** Render the cropped region at full image resolution and encode via canvas.toBlob. */
  async exportBlob(state: EditState, mimeType: string, quality?: number, frame?: ExportFrameOptions): Promise<Blob> {
    if (!this.hasImage) throw new Error('no image loaded');
    const gl = this.gl;
    const crop = state.crop;
    const width = crop ? Math.max(1, Math.round(crop.width * this.imageWidth)) : this.imageWidth;
    const height = crop ? Math.max(1, Math.round(crop.height * this.imageHeight)) : this.imageHeight;
    this.canvas.width = width;
    this.canvas.height = height;
    gl.viewport(0, 0, width, height);
    this.draw(state, crop);

    try {
      if (!frame || (frame.format === 'original' && frame.borderPercent <= 0)) {
        return await canvasToBlob(this.canvas, mimeType, quality);
      }
      if (frame.format === 'original') {
        return await this.composeBorderedOriginalBlob(width, height, frame, mimeType, quality);
      }
      return await this.composeFramedBlob(width, height, frame, mimeType, quality);
    } finally {
      this.render(state); // restore the interactive viewport-sized view
    }
  }

  /**
   * Cheap, synchronous small-canvas render of the (possibly cropped) photo for UI
   * thumbnails (e.g. the export preview swatch) — not for final export quality.
   * Reuses this.canvas the same way exportBlob does: resize, draw, read, restore,
   * all synchronously so the on-screen viewport never flashes mid-swap.
   */
  renderThumbnail(state: EditState, maxSize: number): string {
    if (!this.hasImage) return '';
    const gl = this.gl;
    const crop = state.crop;
    const contentW = crop ? crop.width * this.imageWidth : this.imageWidth;
    const contentH = crop ? crop.height * this.imageHeight : this.imageHeight;
    const scale = Math.min(1, maxSize / Math.max(contentW, contentH));
    const width = Math.max(1, Math.round(contentW * scale));
    const height = Math.max(1, Math.round(contentH * scale));
    this.canvas.width = width;
    this.canvas.height = height;
    gl.viewport(0, 0, width, height);
    this.draw(state, crop);
    const dataUrl = this.canvas.toDataURL('image/jpeg', 0.75);
    this.render(state); // restore the interactive viewport-sized view
    return dataUrl;
  }

  /**
   * Pad the just-drawn photo with a border on all sides, scaled proportionally to
   * each dimension so the framed canvas keeps the exact same aspect ratio as the
   * (possibly cropped) source photo.
   */
  private async composeBorderedOriginalBlob(
    contentW: number,
    contentH: number,
    frame: ExportFrameOptions,
    mimeType: string,
    quality?: number,
  ): Promise<Blob> {
    const p = frame.borderPercent / 100;
    const canvasW = Math.round(contentW * (1 + 2 * p));
    const canvasH = Math.round(contentH * (1 + 2 * p));
    const dx = Math.round((canvasW - contentW) / 2);
    const dy = Math.round((canvasH - contentH) / 2);

    const framed = document.createElement('canvas');
    framed.width = canvasW;
    framed.height = canvasH;
    const ctx = framed.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    ctx.fillStyle = frame.borderColor;
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.drawImage(this.canvas, 0, 0, contentW, contentH, dx, dy, contentW, contentH);

    return canvasToBlob(framed, mimeType, quality);
  }

  /** Composite the just-drawn photo (still sitting in this.canvas) onto a fixed-size Instagram canvas. Caller guarantees frame.format !== 'original'. */
  private async composeFramedBlob(
    contentW: number,
    contentH: number,
    frame: ExportFrameOptions,
    mimeType: string,
    quality?: number,
  ): Promise<Blob> {
    const { width: canvasW, height: canvasH } = FRAME_SIZES[frame.format as Exclude<ExportFormat, 'original'>];
    const borderPx = (frame.borderPercent / 100) * Math.min(canvasW, canvasH);
    const innerW = Math.max(1, canvasW - borderPx * 2);
    const innerH = Math.max(1, canvasH - borderPx * 2);
    const scale = Math.min(innerW / contentW, innerH / contentH);
    const drawW = contentW * scale;
    const drawH = contentH * scale;
    const dx = (canvasW - drawW) / 2;
    const dy = (canvasH - drawH) / 2;

    const framed = document.createElement('canvas');
    framed.width = canvasW;
    framed.height = canvasH;
    const ctx = framed.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    ctx.fillStyle = frame.borderColor;
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.drawImage(this.canvas, 0, 0, contentW, contentH, dx, dy, drawW, drawH);

    return canvasToBlob(framed, mimeType, quality);
  }

  private draw(state: EditState, crop: CropRect | null): void {
    const gl = this.gl;
    gl.useProgram(this.programInfo.program);
    twgl.setBuffersAndAttributes(gl, this.programInfo, this.quad);
    // Single place where UI slider units become normalized shader uniforms.
    twgl.setUniforms(this.programInfo, {
      u_image: this.imageTexture,
      u_curveLut: this.curveLutTexture,
      u_cropOrigin: crop ? [crop.x, crop.y] : [0, 0],
      u_cropScale: crop ? [crop.width, crop.height] : [1, 1],
      u_flipH: state.flipHorizontal,
      u_flipV: state.flipVertical,
      u_exposureEv: state.exposureEv,
      u_highlights: state.highlights / 100,
      u_shadows: state.shadows / 100,
      u_temperature: state.temperature / 100,
      u_tint: state.tint / 100,
      u_saturation: 1 + state.saturation / 100,
      u_colorMix: flattenColorMix(state.colorMix),
      u_colorGrade: flattenColorGrade(state.colorGrade),
      u_gradeTintStrength: colorGradeTuning.tintStrength,
      u_gradeLumStrength: colorGradeTuning.luminanceStrength,
      u_gradeShadowFade: colorGradeTuning.shadowFade,
      u_gradeHighlightFade: colorGradeTuning.highlightFade,
      u_bypassCurve: state.bypassCurve,
      u_showLinear: state.showLinear,
      u_showClipping: state.showClipping,
    });
    twgl.drawBufferInfo(gl, this.quad);
  }

  private sizeDrawingBufferToDisplay(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private setViewportLetterboxed(crop: CropRect | null): void {
    const { width: bufferW, height: bufferH } = this.canvas;
    const contentW = crop ? crop.width * this.imageWidth : this.imageWidth;
    const contentH = crop ? crop.height * this.imageHeight : this.imageHeight;
    const scale = Math.min(bufferW / contentW, bufferH / contentH);
    const w = Math.round(contentW * scale);
    const h = Math.round(contentH * scale);
    this.gl.viewport(Math.round((bufferW - w) / 2), Math.round((bufferH - h) / 2), w, h);
  }
}

function identityLut(): Float32Array {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = i / 255;
  return lut;
}

/**
 * Flatten the color-mixer state to the shader's `vec3 u_colorMix[15]`:
 * bands in COLOR_BANDS order × zones in TONE_ZONES order, each entry
 * (hue, saturation, luminance) normalized from slider units to -1..+1.
 */
/**
 * Flatten the color-grade state to the shader's `vec3 u_colorGrade[3]`:
 * zones in GRADE_ZONES order, each entry (hue in degrees, saturation 0..1,
 * luminance -1..+1).
 */
function flattenColorGrade(colorGrade: ColorGradeState): Float32Array {
  const flat = new Float32Array(GRADE_ZONES.length * 3);
  GRADE_ZONES.forEach((zone, index) => {
    const { hue, saturation, luminance } = colorGrade[zone];
    flat.set([hue, saturation / 100, luminance / 100], index * 3);
  });
  return flat;
}

function flattenColorMix(colorMix: ColorMixState): Float32Array {
  const flat = new Float32Array(COLOR_BANDS.length * TONE_ZONES.length * 3);
  let offset = 0;
  for (const band of COLOR_BANDS) {
    for (const zone of TONE_ZONES) {
      const { hue, saturation, luminance } = colorMix[band][zone];
      flat.set([hue / 100, saturation / 100, luminance / 100], offset);
      offset += 3;
    }
  }
  return flat;
}
