// Presets panel: a "Save preset" action that asks for a name inline, plus a
// grid of saved-preset icons. Each icon shows the name's first 3 letters on a
// random colored background; clicking it applies the preset, and a hover × on
// the icon deletes it. The panel only drives the UI — saving/applying the
// actual settings is delegated through the callbacks.
import { PresetStore, presetInitials, type Preset } from './preset';
import type { EditState } from './state';

export interface PresetPanelCallbacks {
  /** Return the live state to snapshot when the user saves a preset. */
  getCurrentState: () => EditState;
  /** Apply a stored preset's settings to the live state and re-render. */
  onApply: (preset: Preset) => void;
}

export class PresetPanel {
  readonly element: HTMLElement;

  private readonly store: PresetStore;
  private readonly callbacks: PresetPanelCallbacks;
  private readonly grid: HTMLElement;
  private readonly saveRow: HTMLElement;
  private readonly nameInput: HTMLInputElement;

  constructor(store: PresetStore, callbacks: PresetPanelCallbacks) {
    this.store = store;
    this.callbacks = callbacks;

    this.element = document.createElement('div');
    this.element.className = 'preset-panel';

    this.nameInput = document.createElement('input');
    this.saveRow = this.buildSaveRow();
    this.grid = document.createElement('div');
    this.grid.className = 'preset-grid';

    this.element.append(this.saveRow, this.grid);
    this.renderGrid();
  }

  private buildSaveRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'preset-save-row';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.textContent = 'Save preset';
    saveButton.addEventListener('click', () => this.openNameEntry());

    this.nameInput.type = 'text';
    this.nameInput.placeholder = 'Preset name';
    this.nameInput.className = 'preset-name-input';
    this.nameInput.hidden = true;
    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.commitNameEntry();
      else if (event.key === 'Escape') this.closeNameEntry();
    });
    this.nameInput.addEventListener('blur', () => this.commitNameEntry());

    row.append(saveButton, this.nameInput);
    return row;
  }

  private openNameEntry(): void {
    this.nameInput.hidden = false;
    this.nameInput.value = '';
    this.nameInput.focus();
  }

  private closeNameEntry(): void {
    this.nameInput.hidden = true;
    this.nameInput.value = '';
  }

  private commitNameEntry(): void {
    if (this.nameInput.hidden) return; // already closed (avoids double-fire on blur)
    const name = this.nameInput.value.trim();
    this.closeNameEntry();
    if (!name) return;
    this.store.save(name, this.callbacks.getCurrentState());
    this.renderGrid();
  }

  private renderGrid(): void {
    this.grid.replaceChildren();
    const presets = this.store.list();
    if (presets.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'preset-empty';
      empty.textContent = 'No presets yet.';
      this.grid.append(empty);
      return;
    }
    for (const preset of presets) {
      this.grid.append(this.buildIcon(preset));
    }
  }

  private buildIcon(preset: Preset): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'preset-icon-wrap';

    const icon = document.createElement('button');
    icon.type = 'button';
    icon.className = 'preset-icon';
    icon.style.background = preset.color;
    icon.textContent = presetInitials(preset.name);
    icon.title = preset.name;
    icon.addEventListener('click', () => this.callbacks.onApply(preset));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'preset-delete';
    remove.textContent = '\u00d7';
    remove.title = `Delete "${preset.name}"`;
    remove.addEventListener('click', () => {
      this.store.remove(preset.id);
      this.renderGrid();
    });

    wrapper.append(icon, remove);
    return wrapper;
  }
}
