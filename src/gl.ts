// WebGL2 setup + the single fullscreen-quad edit program.
//
// The full-resolution RGBA16F texture stays resident on the GPU; render()
// only pushes uniforms and draws one quad, so every slider runs at 60fps.
// The canvas drawing buffer is viewport-sized (the GPU downscales the
// full-res texture for display); export temporarily resizes it to full res.
import * as twgl from 'twgl.js';
import fragmentSource from './shader.frag?raw';
import { COLOR_BANDS, TONE_ZONES, type ColorMixState, type EditState } from './state';

const vertexSource = `#version 300 es
layout(location = 0) in vec2 position;
out vec2 v_uv;
void main() {
  // Decoded rows arrive top-first; GL's v axis points up, so flip v here.
  v_uv = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

export class GlRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly programInfo: twgl.ProgramInfo;
  private readonly quad: twgl.BufferInfo;
  private readonly imageTexture: WebGLTexture;
  private readonly curveLutTexture: WebGLTexture;
  private imageWidth = 0;
  private imageHeight = 0;

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

  /** Push uniforms and draw the quad, letterboxed to the image aspect. */
  render(state: EditState): void {
    if (!this.hasImage) return;
    const gl = this.gl;
    this.sizeDrawingBufferToDisplay();

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.setViewportLetterboxed();
    this.draw(state);
  }

  /** Render at full image resolution and encode via canvas.toBlob. */
  async exportBlob(state: EditState, mimeType: string, quality?: number): Promise<Blob> {
    if (!this.hasImage) throw new Error('no image loaded');
    const gl = this.gl;
    this.canvas.width = this.imageWidth;
    this.canvas.height = this.imageHeight;
    gl.viewport(0, 0, this.imageWidth, this.imageHeight);
    this.draw(state);

    try {
      return await new Promise<Blob>((resolve, reject) => {
        this.canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob failed'))),
          mimeType,
          quality,
        );
      });
    } finally {
      this.render(state); // restore the interactive viewport-sized view
    }
  }

  private draw(state: EditState): void {
    const gl = this.gl;
    gl.useProgram(this.programInfo.program);
    twgl.setBuffersAndAttributes(gl, this.programInfo, this.quad);
    // Single place where UI slider units become normalized shader uniforms.
    twgl.setUniforms(this.programInfo, {
      u_image: this.imageTexture,
      u_curveLut: this.curveLutTexture,
      u_exposureEv: state.exposureEv,
      u_highlights: state.highlights / 100,
      u_shadows: state.shadows / 100,
      u_temperature: state.temperature / 100,
      u_tint: state.tint / 100,
      u_saturation: 1 + state.saturation / 100,
      u_colorMix: flattenColorMix(state.colorMix),
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

  private setViewportLetterboxed(): void {
    const { width: bufferW, height: bufferH } = this.canvas;
    const scale = Math.min(bufferW / this.imageWidth, bufferH / this.imageHeight);
    const w = Math.round(this.imageWidth * scale);
    const h = Math.round(this.imageHeight * scale);
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
