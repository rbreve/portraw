#version 300 es
// ============================================================================
// shader.frag — STAGE 2: the ENTIRE edit pipeline.
//
// Input : u_image, linear-light RGBA16F (sRGB primaries, camera WB applied,
//         no gamma, no auto-brighten) — decoded once by decode.worker.ts.
// Output: display-referred sRGB to the canvas.
//
// Every edit is a pure function of uniforms, so moving a slider only updates
// a uniform and redraws this one fullscreen quad — pixels are never touched
// in JS and the RAW is never re-decoded.
//
// Pipeline order (deliberate, do not shuffle):
//   1. White balance      (linear — channel gains only make sense here)
//   2. Exposure           (linear — light is additive in linear)
//   3. Highlights/Shadows (linear — tonal compression on scene light)
//   4. sRGB OETF          (linear -> display-referred)
//   5. Tone curve LUT     (display — curves are drawn in display space)
//   6. Color mixer        (display — per-band HSL, split by tone zone)
//   7. Saturation         (display — luma/chroma split)
//   8. Color grading      (display — 3-way tint wheels; after saturation so
//                          a desaturated image can still be split-toned)
//   9. Out (+ debug overlays)
// ============================================================================
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_image;    // linear RGBA16F source
uniform sampler2D u_curveLut; // 256x1 R16F master tone curve

// --- edit uniforms (normalized; mapping from slider units happens in gl.ts) -
uniform float u_temperature;  // -1..+1, + = warmer (relative to camera WB)
uniform float u_tint;         // -1..+1, + = magenta, - = green
uniform float u_exposureEv;   // exposure in EV stops
uniform float u_highlights;   // -1..+1, - recovers (darkens) highlights
uniform float u_shadows;      // -1..+1, + lifts shadows
uniform float u_saturation;   //  0..2,  1 = unchanged

// --- color mixer --------------------------------------------------------------
// Per-band HSL adjustments, split by tone zone. Indexed [band * 3 + zone] with
// bands (red, orange, yellow, green, aqua, blue, purple, magenta) and zones
// (dark, mid, light) — the same order as COLOR_BANDS / TONE_ZONES in state.ts,
// flattened by gl.ts. Each entry is (hue, saturation, luminance), all -1..+1.
uniform vec3 u_colorMix[24];

// --- color grading -----------------------------------------------------------
// 3-way grade, one wheel per tone zone. Indexed by zone (shadows, midtones,
// highlights) — the same order as GRADE_ZONES in state.ts, flattened by gl.ts.
// Each entry is (hue in degrees, saturation 0..1, luminance -1..+1).
uniform vec3 u_colorGrade[3];
// Tuning knobs, sourced from config.ts (see there for docs) rather than
// hard-coded here so the grade can be tuned in one place.
uniform float u_gradeTintStrength;  // chroma shift at full wheel saturation
uniform float u_gradeLumStrength;   // headroom fraction at full luminance
uniform vec2 u_gradeShadowFade;     // shadow weight fades 1 -> 0 across [x, y]
uniform vec2 u_gradeHighlightFade;  // highlight weight fades 0 -> 1 across [x, y]

// --- debug toggles -----------------------------------------------------------
uniform bool u_bypassCurve;   // skip step 5 (isolate curve bugs)
uniform bool u_showLinear;    // output the working linear buffer (pre-OETF);
                              // looks dark — that is the point
uniform bool u_showClipping;  // paint blown / crushed pixels

// Rec.709 luma weights — correct for sRGB-primary data.
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Strength of a full slider deflection, in EV stops applied at mask peak.
const float TEMP_STRENGTH      = 0.50;
const float TINT_STRENGTH      = 0.35;
const float HIGHLIGHT_STRENGTH = 1.50;
const float SHADOW_STRENGTH    = 2.00;

// Highlight mask shaping (all in sRGB-encoded luminance, 0..1):
//   KNEE       — where the full-strength highlight zone begins. Raise to
//                confine the effect to brighter pixels; lower to widen it.
//   MID_REACH  — where the midtone tail starts fading in. Lower to reach
//                deeper into the midtones.
//   MID_AMOUNT — fraction of full strength applied across the midtone tail
//                (0 = highlights only, 1 = midtones get the full effect).
const float HIGHLIGHT_KNEE       = 0.60;
const float HIGHLIGHT_MID_REACH  = 0.25;
const float HIGHLIGHT_MID_AMOUNT = 0.30;

// Color-mixer tuning — what one full slider deflection does:
//   MIX_HUE_RANGE_DEG : max hue rotation in degrees
//   MIX_SAT_RANGE     : max saturation scale (1.0 -> -100 fully desaturates)
//   MIX_LUM_RANGE     : max fraction of remaining lightness headroom (or
//                       footroom, when darkening) consumed at full deflection
const float MIX_HUE_RANGE_DEG = 30.0;
const float MIX_SAT_RANGE     = 1.0;
const float MIX_LUM_RANGE     = 0.6;

// Band placement on the hue wheel (degrees): center of each band and the
// distance over which its influence falls off to zero. Bands overlap a little
// so in-between hues blend contributions from both neighbours.
// Order: red, orange, yellow, green, aqua, blue, purple, magenta.
const float MIX_BAND_HUE[8]   = float[](0.0, 35.0, 62.0, 120.0, 180.0, 225.0, 275.0, 315.0);
const float MIX_BAND_WIDTH[8] = float[](55.0, 45.0, 55.0, 70.0, 65.0, 70.0, 60.0, 55.0);

// Tone-zone crossfades in HSL lightness: darks fade out across LO..HI of the
// first pair, lights fade in across the second; mids fill the remainder.
// The three weights always sum to 1, so a cell never double-counts a pixel.
const float MIX_DARK_FADE_LO  = 0.15;
const float MIX_DARK_FADE_HI  = 0.45;
const float MIX_LIGHT_FADE_LO = 0.55;
const float MIX_LIGHT_FADE_HI = 0.85;

// Below this HSL saturation the mixer fades out entirely — neutrals have no
// meaningful hue and would otherwise pick up noisy shifts.
const float MIX_CHROMA_FADE_LO = 0.03;
const float MIX_CHROMA_FADE_HI = 0.20;

// ----------------------------------------------------------------------------
// sRGB OETF (the standard piecewise encode, NOT a plain pow(1/2.2)).
// Converts linear light to display-referred values.
// ----------------------------------------------------------------------------
vec3 linearToSrgb(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return mix(lo, hi, step(vec3(0.0031308), c));
}

// ----------------------------------------------------------------------------
// 5. Tone curve: sample the 256-entry LUT per channel (master RGB curve).
// Texel centers live at (i + 0.5)/256, so map value v in [0,1] onto the
// center span — sampling at v directly would clip the first/last half texel.
// ----------------------------------------------------------------------------
float curve(float v) {
    return texture(u_curveLut, vec2((clamp(v, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5)).r;
}

// ----------------------------------------------------------------------------
// HSL <-> RGB, used by the color mixer and color grading (display-referred values).
// h in degrees [0, 360), s and l in [0, 1].
// ----------------------------------------------------------------------------
vec3 rgbToHsl(vec3 c) {
    float maxC = max(max(c.r, c.g), c.b);
    float minC = min(min(c.r, c.g), c.b);
    float l = (maxC + minC) * 0.5;
    float d = maxC - minC;
    if (d < 1e-5) return vec3(0.0, 0.0, l);
    float s = d / (1.0 - abs(2.0 * l - 1.0));
    float h;
    if (maxC == c.r)      h = mod((c.g - c.b) / d, 6.0);
    else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
    else                  h = (c.r - c.g) / d + 4.0;
    return vec3(h * 60.0, s, l);
}

vec3 hslToRgb(vec3 hsl) {
    float h = mod(hsl.x, 360.0);
    float chroma = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
    float x = chroma * (1.0 - abs(mod(h / 60.0, 2.0) - 1.0));
    float m = hsl.z - chroma * 0.5;
    vec3 rgb = h <  60.0 ? vec3(chroma, x, 0.0)
             : h < 120.0 ? vec3(x, chroma, 0.0)
             : h < 180.0 ? vec3(0.0, chroma, x)
             : h < 240.0 ? vec3(0.0, x, chroma)
             : h < 300.0 ? vec3(x, 0.0, chroma)
             :             vec3(chroma, 0.0, x);
    return rgb + m;
}

// ----------------------------------------------------------------------------
// 6. Color mixer: accumulate (hue, sat, lum) adjustments from every band the
// pixel's hue falls into, each band blended across dark/mid/light tone zones,
// then apply the total once in HSL.
// ----------------------------------------------------------------------------
vec3 applyColorMix(vec3 c) {
    vec3 hsl = rgbToHsl(c);
    float chromaMask = smoothstep(MIX_CHROMA_FADE_LO, MIX_CHROMA_FADE_HI, hsl.y);
    if (chromaMask <= 0.0) return c;

    float lightWeight = smoothstep(MIX_LIGHT_FADE_LO, MIX_LIGHT_FADE_HI, hsl.z);
    float darkWeight  = 1.0 - smoothstep(MIX_DARK_FADE_LO, MIX_DARK_FADE_HI, hsl.z);
    float midWeight   = 1.0 - darkWeight - lightWeight;

    vec3 adjust = vec3(0.0); // accumulated (hue, sat, lum), still -1..+1 scale
    for (int band = 0; band < 8; band++) {
        float hueDistance = abs(mod(hsl.x - MIX_BAND_HUE[band] + 180.0, 360.0) - 180.0);
        float bandWeight = 1.0 - smoothstep(0.0, MIX_BAND_WIDTH[band], hueDistance);
        if (bandWeight <= 0.0) continue;
        adjust += bandWeight * (darkWeight  * u_colorMix[band * 3 + 0]
                              + midWeight   * u_colorMix[band * 3 + 1]
                              + lightWeight * u_colorMix[band * 3 + 2]);
    }
    adjust *= chromaMask;

    hsl.x = mod(hsl.x + adjust.x * MIX_HUE_RANGE_DEG, 360.0);
    hsl.y = clamp(hsl.y * (1.0 + adjust.y * MIX_SAT_RANGE), 0.0, 1.0);
    // Luminance moves toward 1 (or 0) by a fraction of the remaining room, so
    // it can never clip no matter how many bands stack on one pixel.
    float lumShift = clamp(adjust.z, -1.0, 1.0) * MIX_LUM_RANGE;
    hsl.z = clamp(hsl.z + lumShift * (lumShift > 0.0 ? 1.0 - hsl.z : hsl.z), 0.0, 1.0);
    return hslToRgb(hsl);
}

// ----------------------------------------------------------------------------
// 8. Color grading: blend each pixel across shadow/midtone/highlight zones by
// display luma, then per zone apply the wheel's luminance shift and push the
// chroma toward the wheel's hue along a zero-luma axis — the tint colors the
// zone without changing its brightness, and a fully desaturated image still
// takes the tint (the classic split-tone workflow).
// ----------------------------------------------------------------------------
vec3 applyColorGrade(vec3 c) {
    float luma = dot(c, LUMA);
    float highlightWeight = smoothstep(u_gradeHighlightFade.x, u_gradeHighlightFade.y, luma);
    float shadowWeight = 1.0 - smoothstep(u_gradeShadowFade.x, u_gradeShadowFade.y, luma);
    // max() keeps mids at zero (instead of negative) if the fades are tuned to overlap.
    float midWeight = max(1.0 - shadowWeight - highlightWeight, 0.0);
    float zoneWeight[3] = float[](shadowWeight, midWeight, highlightWeight);

    for (int zone = 0; zone < 3; zone++) {
        vec3 grade = u_colorGrade[zone]; // (hue deg, sat, lum)
        float w = zoneWeight[zone];
        // Luminance moves toward 1 (or 0) by a fraction of the remaining room,
        // per channel — it can lift true blacks and never clips.
        float shift = grade.z * u_gradeLumStrength * w;
        c += shift * (shift > 0.0 ? vec3(1.0) - c : c);
        if (grade.y > 0.0) {
            vec3 tint = hslToRgb(vec3(grade.x, 1.0, 0.5));
            c += (tint - dot(tint, LUMA)) * (grade.y * u_gradeTintStrength * w);
        }
    }
    return clamp(c, 0.0, 1.0);
}

void main() {
    vec3 c = texture(u_image, v_uv).rgb;

    // ------------------------------------------------------------------ 1 ---
    // WHITE BALANCE — exponential RGB gains in linear light, relative to the
    // camera-WB baseline already baked in by the decoder (slider at 0 = as
    // shot). Warmer = more red / less blue; tint trades green vs magenta.
    // exp2 keeps gains symmetric and never negative.
    c *= vec3(
        exp2( u_temperature * TEMP_STRENGTH),                          // R
        exp2(-u_tint        * TINT_STRENGTH),                          // G
        exp2(-u_temperature * TEMP_STRENGTH + u_tint * TINT_STRENGTH * 0.5) // B
    );

    // ------------------------------------------------------------------ 2 ---
    // EXPOSURE — one photographic stop per EV: a plain multiply in linear.
    c *= exp2(u_exposureEv);

    // ------------------------------------------------------------------ 3 ---
    // HIGHLIGHTS & SHADOWS — luminance-masked exposure adjustments.
    // The masks are built from sRGB-ENCODED luminance so "highlights" and
    // "shadows" match what the eye calls bright/dark, not raw linear energy
    // (in linear, mid-grey is only ~0.18 and the masks would feel lopsided).
    // smoothstep gives masks with zero slope at their edges, so adjustments
    // fade in without banding or hard transitions.
    {
        float lum = dot(c, LUMA);
        float perceptual = linearToSrgb(vec3(lum)).x;
        // Two-part highlight mask: a full-strength zone above the knee plus a
        // gentler midtone tail below it, blended smoothly so the slider also
        // nudges midtones without dragging them as hard as the highlights.
        float highlightZone = smoothstep(HIGHLIGHT_KNEE, 1.0, perceptual);
        float midtoneTail = smoothstep(HIGHLIGHT_MID_REACH, HIGHLIGHT_KNEE, perceptual)
                            * HIGHLIGHT_MID_AMOUNT;
        float highlightMask = mix(midtoneTail, 1.0, highlightZone);
        float shadowMask = 1.0 - smoothstep(0.0, 0.55, perceptual); // 1 in shadows
        // Negative u_highlights darkens (recovers) highlights; positive
        // u_shadows lifts shadows. Multiplicative gain preserves hue.
        c *= exp2(u_highlights * HIGHLIGHT_STRENGTH * highlightMask);
        c *= exp2(u_shadows * SHADOW_STRENGTH * shadowMask);
    }

    // DEBUG: inspect the working linear buffer before display encoding.
    // Clipping is judged here in LINEAR terms: blown = lost sensor data that
    // steps 4-6 cannot bring back.
    if (u_showLinear) {
        vec3 lin = clamp(c, 0.0, 1.0);
        if (u_showClipping) {
            if (any(greaterThanEqual(c, vec3(1.0)))) lin = vec3(1.0, 0.0, 0.0);
            else if (all(lessThanEqual(c, vec3(0.0005)))) lin = vec3(0.0, 0.2, 1.0);
        }
        outColor = vec4(lin, 1.0);
        return;
    }

    // ------------------------------------------------------------------ 4 ---
    // LINEAR -> DISPLAY: the sRGB opto-electronic transfer function.
    // Everything after this point is display-referred ("what you see").
    c = linearToSrgb(clamp(c, 0.0, 1.0));

    // ------------------------------------------------------------------ 5 ---
    // TONE CURVE — master RGB curve from the SVG editor, as a 256-entry LUT.
    if (!u_bypassCurve) {
        c = vec3(curve(c.r), curve(c.g), curve(c.b));
    }

    // ------------------------------------------------------------------ 6 ---
    // COLOR MIXER — targeted HSL adjustments per hue band and tone zone.
    c = applyColorMix(c);

    // ------------------------------------------------------------------ 7 ---
    // SATURATION — split into luma + chroma, scale only the chroma.
    // At u_saturation = 0 this is an exact Rec.709 greyscale.
    {
        float luma = dot(c, LUMA);
        c = luma + (c - luma) * u_saturation;
    }

    // ------------------------------------------------------------------ 8 ---
    // COLOR GRADING — shadows/midtones/highlights wheels + per-zone luminance.
    c = applyColorGrade(c);

    // ------------------------------------------------------------------ 9 ---
    c = clamp(c, 0.0, 1.0);

    // DEBUG: clipping overlay — red where any channel is blown, blue where
    // all channels are crushed. Evaluated on the final displayed value.
    if (u_showClipping) {
        if (any(greaterThanEqual(c, vec3(254.0 / 255.0)))) c = vec3(1.0, 0.0, 0.0);
        else if (all(lessThanEqual(c, vec3(1.0 / 255.0)))) c = vec3(0.0, 0.2, 1.0);
    }

    outColor = vec4(c, 1.0);
}
