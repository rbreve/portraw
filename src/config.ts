// Central tuning file: every adjustable constant of the color grading engine
// lives here, in one place, so behavior can be tuned without touching shader
// or UI code. The processing values are pushed to the shader as uniforms on
// every draw, so an edit here takes effect on the next Vite hot-reload.

export const colorGradeTuning = {
  /**
   * Chroma shift toward the wheel's hue at full saturation, in display-referred
   * units along a zero-luma axis (tinting never changes brightness).
   * Raise for stronger maximum tints; 0.15–0.40 is a sensible range.
   */
  tintStrength: 0.25,

  /**
   * Fraction of the remaining lightness headroom (when brightening) or footroom
   * (when darkening) consumed at ±100 luminance. 1.0 pushes the zone all the
   * way to white/black at full deflection; it can never clip.
   */
  luminanceStrength: 0.6,

  /**
   * Shadow-zone weight fades from 1 to 0 across this display-luma span [lo, hi].
   * Lower the pair to confine the shadow wheel to deeper shadows.
   */
  shadowFade: [0.05, 0.45] as [number, number],

  /**
   * Highlight-zone weight fades from 0 to 1 across this span [lo, hi]. Raise
   * the pair to confine the highlight wheel to brighter pixels. Keep
   * shadowFade[1] <= highlightFade[0] or the midtone zone collapses (the
   * shader clamps the midtone weight to 0 rather than going negative).
   */
  highlightFade: [0.55, 0.95] as [number, number],
};

// UI-side knobs for the color grading panel.
export const colorGradeUi = {
  /** Luminance slider range/step under each wheel (slider units, 0 = no change). */
  luminance: { min: -100, max: 100, step: 1 },
};
