// IndexedDB-backed cache for folder-browser thumbnails. Deliberately not a
// hidden folder written back into the user's photo directory — see
// docs/thumbnail-cache-spec.md for why (permission escalation, cluttering a
// folder that may be synced/cataloged by other tools, breaks on read-only
// sources).

const DB_NAME = 'portraw-thumbnails';
const STORE_NAME = 'thumbnails';

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
 * Cache key for a file's thumbnail. There's no stable cross-session ID for a
 * FileSystemFileHandle, so identity is reconstructed from metadata that's
 * already available without reading the file's contents. Size + mtime
 * changing means the file changed, which naturally invalidates the entry.
 */
export function thumbnailCacheKey(dirName: string, file: File, maxDimension = 256): string {
  const base = `${dirName}/${file.name}:${file.size}:${file.lastModified}`;
  return maxDimension === 256 ? base : `${base}:${maxDimension}`;
}

export async function getCachedThumbnail(key: string): Promise<Blob | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as Blob | undefined);
    request.onerror = () => reject(request.error as Error);
  });
}

export async function putCachedThumbnail(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error as Error);
  });
}
