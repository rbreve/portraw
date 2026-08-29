// The single flat edit-state object. UI events mutate it and call render() —
// no store, no pub/sub. Slider values are kept in UI units; gl.ts owns the
// mapping from these units to normalized shader uniforms.

// --- color mixer -------------------------------------------------------------
// Band and zone orders are the contract with the shader's u_colorMix array —
// gl.ts flattens in exactly this order.
export const COLOR_BANDS = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta',
] as const;
export type ColorBand = (typeof COLOR_BANDS)[number];

export const TONE_ZONES = ['dark', 'mid', 'light'] as const;
export type ToneZone = (typeof TONE_ZONES)[number];

/** One band+zone cell of the mixer. All values -100..100, 0 = no change. */
export interface HslAdjustment {
  hue: number;
  saturation: number;
  luminance: number;
}

export type ColorMixState = Record<ColorBand, Record<ToneZone, HslAdjustment>>;

export function createDefaultColorMixState(): ColorMixState {
  return Object.fromEntries(
    COLOR_BANDS.map((band) => [
      band,
      Object.fromEntries(
        TONE_ZONES.map((zone) => [zone, { hue: 0, saturation: 0, luminance: 0 }]),
      ),
    ]),
  ) as ColorMixState;
}

/** Deep copy so presets and live state never share nested cell objects. */
export function cloneColorMixState(source: ColorMixState): ColorMixState {
  const clone = createDefaultColorMixState();
  for (const band of COLOR_BANDS) {
    for (const zone of TONE_ZONES) {
      clone[band][zone] = { ...source[band][zone] };
    }
  }
  return clone;
}

// --- color grading -----------------------------------------------------------
// 3-way grade: one wheel per tone zone. Zone order is the contract with the
// shader's u_colorGrade array — gl.ts flattens in exactly this order.
export const GRADE_ZONES = ['shadows', 'midtones', 'highlights'] as const;
export type GradeZone = (typeof GRADE_ZONES)[number];

/**
 * One wheel of the 3-way color grade. hue is 0..360 degrees on the wheel,
 * saturation 0..100 (0 = no tint, so hue is irrelevant at rest), luminance
 * -100..100 (0 = no change).
 */
export interface GradeWheel {
  hue: number;
  saturation: number;
  luminance: number;
}

export type ColorGradeState = Record<GradeZone, GradeWheel>;

export function createDefaultColorGradeState(): ColorGradeState {
  return Object.fromEntries(
    GRADE_ZONES.map((zone) => [zone, { hue: 0, saturation: 0, luminance: 0 }]),
  ) as ColorGradeState;
}

/** Deep copy so presets and live state never share wheel objects. */
export function cloneColorGradeState(source: ColorGradeState): ColorGradeState {
  return Object.fromEntries(
    GRADE_ZONES.map((zone) => [zone, { ...source[zone] }]),
  ) as ColorGradeState;
}

// --- tone curve ------------------------------------------------------------------
// Control points in normalized [0,1]^2 space (x = input, y = output), the same
// shape curve.ts's CurveEditor edits directly — kept here so presets/session
// persistence can save and restore it like any other develop setting.
export interface CurvePoint {
  x: number;
  y: number;
}

export function createDefaultCurvePoints(): CurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
}

/** Deep copy so presets and live state never share point objects. */
export function cloneCurvePoints(points: CurvePoint[]): CurvePoint[] {
  return points.map((p) => ({ ...p }));
}

// --- crop ----------------------------------------------------------------------
// Normalized to [0,1] against the full decoded image, top-left origin — the
// same space as the shader's v_uv, so gl.ts can use x/y/width/height directly
// as a uv offset + scale with no unit conversion.
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// --- edit state ----------------------------------------------------------------
export interface EditState {
  exposureEv: number; //  -5..+5  EV stops
  highlights: number; // -100..100
  shadows: number; //    -100..100
  temperature: number; // -100..100  (+ warmer)
  tint: number; //       -100..100  (+ magenta)
  saturation: number; // -100..100  (0 = unchanged)
  colorMix: ColorMixState;
  colorGrade: ColorGradeState;
  curvePoints: CurvePoint[];
  // null = full, uncropped image.
  crop: CropRect | null;
  // Mirror the image horizontally/vertically — per-photo geometry, like crop.
  flipHorizontal: boolean;
  flipVertical: boolean;
  // Debug toggles
  bypassCurve: boolean;
  showLinear: boolean;
  showClipping: boolean;
}

export function createDefaultEditState(): EditState {
  return {
    exposureEv: 0,
    highlights: 0,
    shadows: 0,
    temperature: 0,
    tint: 0,
    saturation: 0,
    colorMix: createDefaultColorMixState(),
    colorGrade: createDefaultColorGradeState(),
    curvePoints: createDefaultCurvePoints(),
    crop: null,
    flipHorizontal: false,
    flipVertical: false,
    bypassCurve: false,
    showLinear: false,
    showClipping: false,
  };
}

/**
 * Reset the develop settings (the same fields a preset can set — see
 * PresetSettings below) back to defaults. Mutates colorMix/colorGrade cells in
 * place rather than replacing the objects, so existing references — e.g. the
 * color mixer panel — stay valid.
 */
export function resetDevelopSettings(state: EditState): void {
  state.exposureEv = 0;
  state.highlights = 0;
  state.shadows = 0;
  state.temperature = 0;
  state.tint = 0;
  state.saturation = 0;
  for (const band of COLOR_BANDS) {
    for (const zone of TONE_ZONES) {
      Object.assign(state.colorMix[band][zone], { hue: 0, saturation: 0, luminance: 0 });
    }
  }
  for (const zone of GRADE_ZONES) {
    Object.assign(state.colorGrade[zone], { hue: 0, saturation: 0, luminance: 0 });
  }
  state.curvePoints = createDefaultCurvePoints();
}

/** Reset every field back to defaults for a newly opened photo. */
export function resetEditState(state: EditState): void {
  resetDevelopSettings(state);
  state.crop = null;
  state.flipHorizontal = false;
  state.flipVertical = false;
  state.bypassCurve = false;
  state.showLinear = false;
  state.showClipping = false;
}

// --- presets -------------------------------------------------------------------
// A preset stores the develop settings only; crop/flip are per-photo geometry
// and debug toggles are session state, so all are deliberately excluded —
// applying a preset never reframes the image or flips a debug switch.
export type PresetSettings = Omit<
  EditState,
  'bypassCurve' | 'showLinear' | 'showClipping' | 'crop' | 'flipHorizontal' | 'flipVertical'
>;

/** Snapshot the develop settings of a live state into a standalone preset. */
export function capturePresetSettings(state: EditState): PresetSettings {
  return {
    exposureEv: state.exposureEv,
    highlights: state.highlights,
    shadows: state.shadows,
    temperature: state.temperature,
    tint: state.tint,
    saturation: state.saturation,
    colorMix: cloneColorMixState(state.colorMix),
    colorGrade: cloneColorGradeState(state.colorGrade),
    curvePoints: cloneCurvePoints(state.curvePoints),
  };
}

/**
 * Copy preset settings back into the live state. Scalars are assigned; colorMix
 * cells are mutated in place so existing references (e.g. the mixer panel) stay
 * valid. Returns the same state for convenience.
 */
export function applyPresetSettings(state: EditState, settings: PresetSettings): EditState {
  state.exposureEv = settings.exposureEv;
  state.highlights = settings.highlights;
  state.shadows = settings.shadows;
  state.temperature = settings.temperature;
  state.tint = settings.tint;
  state.saturation = settings.saturation;
  for (const band of COLOR_BANDS) {
    for (const zone of TONE_ZONES) {
      Object.assign(state.colorMix[band][zone], settings.colorMix[band][zone]);
    }
  }
  for (const zone of GRADE_ZONES) {
    // Presets saved before color grading existed have no colorGrade — treat as neutral.
    Object.assign(state.colorGrade[zone], settings.colorGrade?.[zone] ?? { hue: 0, saturation: 0, luminance: 0 });
  }
  state.curvePoints = cloneCurvePoints(settings.curvePoints);
  return state;
}

// --- per-photo sidecar edits -----------------------------------------------------
// Everything a sidecar file persists for one photo: develop settings plus the
// crop/flip geometry (per-photo, unlike a preset). Debug toggles are session-only
// view aids, not photo edits, so they're excluded — same exclusion list as
// PresetSettings, minus crop/flip which sidecars DO carry.
export type SidecarSettings = Omit<EditState, 'bypassCurve' | 'showLinear' | 'showClipping'>;

/** Snapshot a live state's edits (develop settings + crop/flip) for writing to a sidecar file. */
export function captureSidecarSettings(state: EditState): SidecarSettings {
  return {
    ...capturePresetSettings(state),
    crop: state.crop ? { ...state.crop } : null,
    flipHorizontal: state.flipHorizontal,
    flipVertical: state.flipVertical,
  };
}

/** Copy a loaded sidecar's settings back into live state, same mutate-in-place pattern as applyPresetSettings. */
export function applySidecarSettings(state: EditState, settings: SidecarSettings): EditState {
  applyPresetSettings(state, settings);
  state.crop = settings.crop ? { ...settings.crop } : null;
  state.flipHorizontal = settings.flipHorizontal;
  state.flipVertical = settings.flipVertical;
  return state;
}

// --- session persistence --------------------------------------------------------
// The whole live EditState, auto-saved to localStorage so in-progress work
// (develop settings, crop, debug toggles) survives a reload. Distinct from
// named presets, which are saved explicitly and store develop settings only.
const SESSION_STORAGE_KEY = 'portraw:session';

/** Load the last auto-saved session state, merged onto defaults for forward-compat. Null if none/corrupt. */
export function loadSessionEditState(): EditState | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return { ...createDefaultEditState(), ...(parsed as Partial<EditState>) };
  } catch {
    return null; // corrupt or unavailable storage — fall back to defaults
  }
}

export function persistSessionEditState(state: EditState): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked; session simply won't persist.
  }
}
