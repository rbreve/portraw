// Color grading panel: one hue/saturation wheel per tone zone (Shadows /
// Midtones / Highlights) with a luminance slider under each. Dragging a
// wheel's handle picks hue (angle) and saturation (distance from center).
// Mutates the shared ColorGradeState and calls onChange() — the same
// mutate-and-render pattern as every other control.
//
// Wheel geometry matches the shader's hue convention: 0° (red) points east
// and hue increases counter-clockwise, like a math unit circle.
import { colorGradeUi } from './config';
import { GRADE_ZONES, type ColorGradeState, type GradeWheel, type GradeZone } from './state';

const ZONE_LABELS: Record<GradeZone, string> = {
  shadows: 'Shadows',
  midtones: 'Midtones',
  highlights: 'Highlights',
};

interface ZoneControls {
  wheel: HTMLElement;
  handle: HTMLElement;
  lumInput: HTMLInputElement;
  lumReadout: HTMLElement;
}

export class ColorGradePanel {
  readonly element: HTMLElement;

  private readonly controls = new Map<GradeZone, ZoneControls>();

  constructor(
    private readonly colorGrade: ColorGradeState,
    private readonly onChange: () => void,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'color-grade';
    for (const zone of GRADE_ZONES) {
      this.element.append(this.buildZoneColumn(zone));
    }
    this.syncFromState();
  }

  /** Re-read the backing state into wheels and sliders (e.g. after a preset
   *  is applied, which mutates colorGrade outside this panel). */
  syncFromState(): void {
    for (const zone of GRADE_ZONES) this.refreshZone(zone);
  }

  private buildZoneColumn(zone: GradeZone): HTMLElement {
    const column = document.createElement('div');
    column.className = 'grade-zone';

    const label = document.createElement('span');
    label.className = 'grade-zone-label';
    label.textContent = ZONE_LABELS[zone];

    const wheel = document.createElement('div');
    wheel.className = 'grade-wheel';
    wheel.title = `${ZONE_LABELS[zone]} tint — double-click to reset`;

    const handle = document.createElement('div');
    handle.className = 'grade-handle';
    wheel.append(handle);

    wheel.addEventListener('pointerdown', (event) => {
      wheel.setPointerCapture(event.pointerId);
      this.pickFromPointer(zone, event);
    });
    wheel.addEventListener('pointermove', (event) => {
      if (wheel.hasPointerCapture(event.pointerId)) this.pickFromPointer(zone, event);
    });
    wheel.addEventListener('dblclick', () => {
      Object.assign(this.colorGrade[zone], { hue: 0, saturation: 0 });
      this.refreshZone(zone);
      this.onChange();
    });

    const lumRow = document.createElement('div');
    lumRow.className = 'grade-lum-row';
    lumRow.title = 'Luminance — double-click to reset';

    const lumInput = document.createElement('input');
    lumInput.type = 'range';
    lumInput.min = String(colorGradeUi.luminance.min);
    lumInput.max = String(colorGradeUi.luminance.max);
    lumInput.step = String(colorGradeUi.luminance.step);

    const lumReadout = document.createElement('span');
    lumReadout.className = 'grade-lum-value';

    lumInput.addEventListener('input', () => {
      this.colorGrade[zone].luminance = lumInput.valueAsNumber;
      lumReadout.textContent = String(lumInput.valueAsNumber);
      this.onChange();
    });
    lumInput.addEventListener('dblclick', () => {
      this.colorGrade[zone].luminance = 0;
      this.refreshZone(zone);
      this.onChange();
    });

    lumRow.append(lumInput, lumReadout);
    column.append(label, wheel, lumRow);
    this.controls.set(zone, { wheel, handle, lumInput, lumReadout });
    return column;
  }

  /** Convert a pointer position on the wheel to hue (angle) + saturation (radius). */
  private pickFromPointer(zone: GradeZone, event: PointerEvent): void {
    const { wheel } = this.controls.get(zone)!;
    const rect = wheel.getBoundingClientRect();
    const dx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
    const dy = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
    const radius = Math.min(1, Math.hypot(dx, dy));
    const grade = this.colorGrade[zone];
    // Screen y grows downward; negate so hue increases counter-clockwise.
    grade.hue = Math.round(((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360);
    grade.saturation = Math.round(radius * 100);
    this.refreshZone(zone);
    this.onChange();
  }

  /** Sync one zone's handle position/color and slider to the backing state. */
  private refreshZone(zone: GradeZone): void {
    const { handle, lumInput, lumReadout } = this.controls.get(zone)!;
    const grade = this.colorGrade[zone];
    const angle = (grade.hue * Math.PI) / 180;
    const radius = grade.saturation / 100;
    handle.style.left = `${50 + Math.cos(angle) * radius * 50}%`;
    handle.style.top = `${50 - Math.sin(angle) * radius * 50}%`;
    const lightness = 100 - grade.saturation * 0.5;
    handle.style.background = `hsl(${grade.hue} ${grade.saturation}% ${lightness}%)`;
    handle.classList.toggle('has-edits', hasEdits(grade));
    lumInput.value = String(grade.luminance);
    lumReadout.textContent = String(grade.luminance);
  }
}

function hasEdits(grade: GradeWheel): boolean {
  return grade.saturation !== 0 || grade.luminance !== 0;
}
