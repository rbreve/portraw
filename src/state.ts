// The single flat edit-state object. UI events mutate it and call render() —
// no store, no pub/sub. Slider values are kept in UI units; gl.ts owns the
// mapping from these units to normalized shader uniforms.

// --- color mixer -------------------------------------------------------------
// Band and zone orders are the contract with the shader's u_colorMix array —
// gl.ts flattens in exactly this order.
export const COLOR_BANDS = ['red', 'orange', 'yellow', 'green', 'blue'] as const;
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

// --- edit state ----------------------------------------------------------------
export interface EditState {
  exposureEv: number; //  -5..+5  EV stops
  highlights: number; // -100..100
  shadows: number; //    -100..100
  temperature: number; // -100..100  (+ warmer)
  tint: number; //       -100..100  (+ magenta)
  saturation: number; // -100..100  (0 = unchanged)
  colorMix: ColorMixState;
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
    bypassCurve: false,
    showLinear: false,
    showClipping: false,
  };
}

// --- presets -------------------------------------------------------------------
// A preset stores the develop settings only; debug toggles are session state and
// deliberately excluded so applying a preset never flips a debug switch.
export type PresetSettings = Omit<EditState, 'bypassCurve' | 'showLinear' | 'showClipping'>;

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
  return state;
}
