// Single source of truth for which RAW file extensions the app accepts.
// Decoding always goes through LibRaw (decode.worker.ts / thumbnail.ts),
// which handles all of these; the app never needed to be DNG-only — the
// restriction was just in the file-picker filters.
const RAW_EXTENSIONS = [
  'dng', // Adobe/Leica/Ricoh/phones
  'cr2', // Canon
  'cr3', // Canon (CRX codec — present in this libraw-wasm build)
  'nef', // Nikon
  'nrw', // Nikon compacts
  'arw', // Sony
  'raf', // Fujifilm
  'orf', // Olympus/OM System
  'rw2', // Panasonic
  'pef', // Pentax
  'srw', // Samsung
  '3fr', // Hasselblad
  'iiq', // Phase One
] as const;

/** Case-insensitive filename test, e.g. `isRawFile("IMG_0001.CR3") === true`. */
export function isRawFile(name: string): boolean {
  return rawFilePattern.test(name);
}

const rawFilePattern = new RegExp(`\\.(${RAW_EXTENSIONS.join('|')})$`, 'i');

/** Value for `<input type=file accept=…>`. */
export const RAW_ACCEPT = RAW_EXTENSIONS.map((ext) => `.${ext}`).join(',');
