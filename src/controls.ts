// Small DOM factories for the control panel. No framework: each control is a
// plain element whose input events mutate editState and call render().

export interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onInput: (value: number) => void;
}

export interface SliderHandle {
  element: HTMLElement;
  /** Update the displayed value without firing onInput (e.g. when re-binding). */
  setValue(value: number): void;
}

/**
 * Label + range input + live value readout. Double-click resets to the
 * initial value. Returns a handle so callers that re-bind one slider to
 * different targets (like the color mixer) can sync the display.
 */
export function makeBoundSlider(spec: SliderSpec): SliderHandle {
  const row = document.createElement('div');
  row.className = 'slider-row';

  const label = document.createElement('label');
  label.textContent = spec.label;

  const readout = document.createElement('span');
  readout.className = 'slider-value';

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.value);

  const decimals = spec.step % 1 === 0 ? 0 : String(spec.step).split('.')[1].length;
  const showValue = (value: number) => {
    readout.textContent = value.toFixed(decimals);
  };
  const apply = (value: number) => {
    showValue(value);
    spec.onInput(value);
  };
  apply(spec.value);

  input.addEventListener('input', () => apply(input.valueAsNumber));
  input.addEventListener('dblclick', () => {
    input.value = String(spec.value);
    apply(spec.value);
  });

  row.append(label, input, readout);
  return {
    element: row,
    setValue(value: number) {
      input.value = String(value);
      showValue(value);
    },
  };
}

/** Plain element-only variant for sliders that never re-bind. */
export function makeSlider(spec: SliderSpec): HTMLElement {
  return makeBoundSlider(spec).element;
}

/** Checkbox toggle for the debug switches. */
export function makeToggle(
  label: string,
  onChange: (enabled: boolean) => void,
  initialChecked = false,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'toggle-row';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = initialChecked;
  input.addEventListener('change', () => onChange(input.checked));

  const text = document.createElement('span');
  text.textContent = label;

  row.append(input, text);
  return row;
}
