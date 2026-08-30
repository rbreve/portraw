// IndexedDB-backed store for per-photo edit settings — deliberately not a
// hidden sidecar file written back into the user's photo directory. Same
// reasoning as thumbnailCache.ts (see docs/thumbnail-cache-spec.md): writing
// to the real folder needs a 'readwrite' permission grant, which means at
// least one browser prompt; IndexedDB needs none. Edits load/save silently in
// the background, catalog-style — open a photo, edit it, browse away, come
// back, the edits are just there.
import {
  captureSidecarSettings,
  createDefaultEditState,
  normalizeToneCurveState,
  type CurvePoint,
  type EditState,
  type SidecarSettings,
} from './state';

const DB_NAME = 'portraw-edits';
const STORE_NAME = 'edits';

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
  return dbPromise;
}

// Best-effort: ask the browser not to evict this origin's storage under
// pressure. No functional impact if unsupported/denied.
void navigator.storage?.persist?.();

/**
 * Cache key for a photo's edits. There's no stable cross-session ID for a
 * FileSystemFileHandle (or a plain dropped/picked File), so identity is
 * reconstructed from metadata already available without reading the file's
 * contents. dirName is '' for photos opened outside the folder browser (drag
 * & drop, the file input). Size + mtime changing means the file changed,
 * which naturally invalidates any saved edits.
 */
export function editCacheKey(dirName: string, file: File): string {
  return `${dirName}/${file.name}:${file.size}:${file.lastModified}`;
}

/** Load a photo's saved edits, merged onto defaults for forward-compat. Undefined if none saved. */
export async function loadEditCache(key: string): Promise<SidecarSettings | undefined> {
  const db = await openDb();
  const raw = await new Promise<SidecarSettings | undefined>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as SidecarSettings | undefined);
    request.onerror = () => reject(request.error as Error);
  });
  if (!raw) return undefined;
  const stored = raw as SidecarSettings & { curvePoints?: CurvePoint[] };
  return {
    ...captureSidecarSettings(createDefaultEditState()),
    ...raw,
    toneCurves: normalizeToneCurveState(stored.toneCurves, stored.curvePoints),
  };
}

/** Save a photo's current edits, overwriting any previous entry for this key. */
export async function saveEditCache(key: string, state: EditState): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(captureSidecarSettings(state), key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error as Error);
  });
}
