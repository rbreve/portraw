// Color mixer panel: pick a color band (swatch row) and a tone zone
// (Darks / Mids / Lights segmented control), then adjust hue, saturation and
// luminance for that one band+zone cell. Mutates the shared ColorMixState and
// calls onChange() — the same mutate-and-render pattern as every other control.
// Dots under swatches/zones mark cells that hold non-zero adjustments.
import { makeBoundSlider, type SliderHandle } from './controls';
import {
  COLOR_BANDS,
  TONE_ZONES,
  type ColorBand,
  type ColorMixState,
  type HslAdjustment,
  type ToneZone,
} from './state';

const SWATCH_COLORS: Record<ColorBand, string> = {
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#f5d90a',
  green: '#46a758',
  blue: '#3b82f6',
};

const ZONE_LABELS: Record<ToneZone, string> = {
  dark: 'Darks',
  mid: 'Mids',
  light: 'Lights',
};

const SLIDER_CHANNELS: ReadonlyArray<{ key: keyof HslAdjustment; label: string }> = [
  { key: 'hue', label: 'Hue' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'luminance', label: 'Luminance' },
];

export class ColorMixerPanel {
  readonly element: HTMLElement;

  private readonly colorMix: ColorMixState;
  private readonly onChange: () => void;
  private selectedBand: ColorBand = 'red';
  private selectedZone: ToneZone = 'mid';
  private readonly swatchButtons = new Map<ColorBand, HTMLButtonElement>();
  private readonly zoneButtons = new Map<ToneZone, HTMLButtonElement>();
  private readonly channelSliders = new Map<keyof HslAdjustment, SliderHandle>();

  constructor(colorMix: ColorMixState, onChange: () => void) {
    this.colorMix = colorMix;
    this.onChange = onChange;
    this.element = document.createElement('div');
    this.element.className = 'color-mixer';
    this.element.append(this.buildSwatchRow(), this.buildZoneRow(), this.buildSliderColumn());
    this.refreshSelection();
  }

  /** Re-read the backing state into the sliders and indicators (e.g. after a
   *  preset is applied, which mutates colorMix outside this panel). */
  syncFromState(): void {
    this.refreshSelection();
  }

  private get selectedAdjustment(): HslAdjustment {
    return this.colorMix[this.selectedBand][this.selectedZone];
  }

  private buildSwatchRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mixer-swatches';
    for (const band of COLOR_BANDS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mixer-swatch';
      button.title = `${band[0].toUpperCase()}${band.slice(1)}s`;
      button.style.setProperty('--swatch', SWATCH_COLORS[band]);
      button.addEventListener('click', () => {
        this.selectedBand = band;
        this.refreshSelection();
      });
      this.swatchButtons.set(band, button);
      row.append(button);
    }
    return row;
  }

  private buildZoneRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mixer-zones';
    for (const zone of TONE_ZONES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mixer-zone';
      button.textContent = ZONE_LABELS[zone];
      button.addEventListener('click', () => {
        this.selectedZone = zone;
        this.refreshSelection();
      });
      this.zoneButtons.set(zone, button);
      row.append(button);
    }
    return row;
  }

  private buildSliderColumn(): HTMLElement {
    const column = document.createElement('div');
    for (const { key, label } of SLIDER_CHANNELS) {
      const slider = makeBoundSlider({
        label,
        min: -100,
        max: 100,
        step: 1,
        value: 0,
        onInput: (value) => {
          this.selectedAdjustment[key] = value;
          this.refreshEditIndicators();
          this.onChange();
        },
      });
      this.channelSliders.set(key, slider);
      column.append(slider.element);
    }
    return column;
  }

  /** Sync selected states and slider positions to the current band+zone. */
  private refreshSelection(): void {
    for (const [band, button] of this.swatchButtons) {
      button.classList.toggle('selected', band === this.selectedBand);
    }
    for (const [zone, button] of this.zoneButtons) {
      button.classList.toggle('selected', zone === this.selectedZone);
    }
    const adjustment = this.selectedAdjustment;
    for (const { key } of SLIDER_CHANNELS) {
      this.channelSliders.get(key)!.setValue(adjustment[key]);
    }
    this.refreshEditIndicators();
  }

  /** Dot a swatch if any of its zones is edited; dot a zone for the current band. */
  private refreshEditIndicators(): void {
    for (const [band, button] of this.swatchButtons) {
      const bandEdited = TONE_ZONES.some((zone) => hasEdits(this.colorMix[band][zone]));
      button.classList.toggle('has-edits', bandEdited);
    }
    for (const [zone, button] of this.zoneButtons) {
      button.classList.toggle('has-edits', hasEdits(this.colorMix[this.selectedBand][zone]));
    }
  }
}

function hasEdits(adjustment: HslAdjustment): boolean {
  return adjustment.hue !== 0 || adjustment.saturation !== 0 || adjustment.luminance !== 0;
}
