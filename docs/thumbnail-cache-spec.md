# Folder thumbnails + cache

## Problem

`FolderPanel` (`src/folderPanel.ts`) currently lists `.dng` files as plain
text buttons — no visual preview. Decoding a full thumbnail-quality preview
for every file in a folder on each visit would be slow (LibRaw demosaic, even
half-size, takes real time per file) and wasteful to repeat every time the
same folder is reopened.

## Where to cache: IndexedDB, not a `.thumbnails/` folder on disk

The suggested `.thumbnails/<foldername>/` approach means writing files back
into the user's photo folder via the File System Access API. Rejected:

- **Needs elevated permission.** `showDirectoryPicker()` is currently called
  with the default `'read'` mode (`folderPanel.ts:39`). Writing a cache
  folder requires `'readwrite'`, which means an extra permission prompt (or
  a re-prompt via `requestPermission`) that read-only browsing doesn't need
  today.
- **Pollutes the user's folder.** A dotfolder is hidden on macOS/Linux but
  not Windows, and RAW folders are often synced (cloud drives, backups,
  Lightroom/Capture One catalogs watching the folder) — an app-specific
  cache directory showing up there is a footgun.
- **Breaks if the source is read-only** (mounted card, network share,
  read-only permission grant) — no fallback, thumbnails just never cache.

**IndexedDB** avoids all three: it's origin-scoped, invisible to the user,
needs no extra permission, and works even when the source folder is
read-only. Browsers grant it a generous quota (tied to available disk via
the Storage API), which is plenty for small JPEG thumbnails.

## Cache key

No stable cross-session ID exists for a `FileSystemFileHandle`, so identity
is reconstructed from cheap metadata already available without reading the
file:

```
key = `${dirHandle.name}/${file.name}:${file.size}:${file.lastModified}`
```

If a file changes (size or mtime differ), it's a cache miss and gets
regenerated — the old entry is simply orphaned (see eviction below). Two
different folders that happen to share a name and contain identically
named/sized/timestamped files could theoretically collide; acceptable risk
for a personal thumbnail cache, not worth solving now.

## Generating the thumbnail

Don't reuse the existing half-size decode path (`decodeOnce(bytes, true)` in
`src/decode.worker.ts`) — it still demosaics the whole frame, which is
overkill for a 100–200px grid thumbnail. LibRaw exposes the embedded preview
JPEG directly:

```ts
await raw.open(bytes);
const thumb = await raw.thumbnailData(); // { data, width, height, format: 'jpeg' | ... }
```

Most DNGs carry a JPEG-format embedded preview — extracting it skips the
demosaic entirely and is close to instant. Downscale it (via
`createImageBitmap` + `OffscreenCanvas`, capped at ~256px on the long edge)
before storing, so cache entries stay small regardless of the embedded
preview's native size. Fall back to the existing half-size RAW decode only
if `thumbnailData()` returns nothing or a non-JPEG format.

## Flow

1. New worker task type (extend `decode.worker.ts` or add
   `thumbnail.worker.ts` — reuses the same LibRaw dependency either way).
2. On "Open folder…", for each `.dng` entry, `FolderPanel`:
   - computes the cache key from `handle.getFile()` metadata (cheap — no
     read of file contents required beyond the `File` object's own
     `size`/`lastModified`),
   - looks it up in IndexedDB,
   - if hit: paints the cached blob immediately,
   - if miss: queues a worker job to extract+downscale the thumbnail, paints
     a placeholder until it resolves, then stores the result and paints it.
3. Cap concurrent thumbnail jobs (e.g. 3–4 at a time) so opening a folder of
   500 files doesn't spawn 500 workers at once.

## Storage shape

Single object store, e.g. `thumbnails`, keyed by the string above, value:

```ts
{ blob: Blob /* image/jpeg */, width: number, height: number }
```

## Eviction

Keep it simple for v1: no proactive eviction. Call
`navigator.storage.persist()` once so the cache isn't the first thing
cleared under storage pressure. If it grows to be a problem later, add an
LRU sweep keyed off a `lastUsed` timestamp field — not needed at typical
shoot sizes (JPEG thumbnails at ~256px are a few KB each; even a folder of
thousands is low tens of MB).

## Out of scope

- Persisting `dirHandle` itself for a "recent folders" list (a different,
  separable feature — handles *are* structured-cloneable and IndexedDB can
  store them, but that's not needed just to cache thumbnails).
- Watching the folder for external changes — thumbnails simply regenerate
  next time the folder is opened if a file's size/mtime changed.
