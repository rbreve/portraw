// Develop presets: named snapshots of the current settings, persisted to
// localStorage so they survive reloads. This module owns identity + storage
// only; capturing/applying the actual settings lives in state.ts, and the UI
// lives in presetPanel.ts.
import { capturePresetSettings, type EditState, type PresetSettings } from './state';

export interface Preset {
  id: string;
  name: string;
  color: string; // CSS color for the icon background
  settings: PresetSettings;
}

const STORAGE_KEY = 'raw-lite:presets';

/** The 3-letter icon label: first three letters of the name, upper-cased. */
export function presetInitials(name: string): string {
  return name.trim().slice(0, 3).toUpperCase() || '?';
}

/** A saturated-but-readable random background for a new preset's icon. */
function randomIconColor(): string {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 60%, 45%)`;
}

/** Thin wrapper over localStorage: load once, mutate in memory, persist on write. */
export class PresetStore {
  private presets: Preset[] = [];

  constructor() {
    this.presets = this.load();
  }

  list(): readonly Preset[] {
    return this.presets;
  }

  /** Snapshot the live develop settings under `name` and persist it. */
  save(name: string, state: EditState): Preset {
    const preset: Preset = {
      id: crypto.randomUUID(),
      name: name.trim(),
      color: randomIconColor(),
      settings: capturePresetSettings(state),
    };
    this.presets.push(preset);
    this.persist();
    return preset;
  }

  remove(id: string): void {
    this.presets = this.presets.filter((preset) => preset.id !== id);
    this.persist();
  }

  private load(): Preset[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return []; // corrupt or unavailable storage — start empty rather than crash
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.presets));
    } catch {
      // Storage full or blocked; presets simply won't persist this session.
    }
  }
}
