// Folder browser: pick a directory via the File System Access API and list
// its RAW files so you can click through a shoot without re-opening a file
// picker for each one. Supported in Chrome/Edge; not in Safari/Firefox
// (unimplemented) or Brave (deliberately disabled for privacy) — the button
// disables itself when unsupported.
import { GalleryOverlay, galleryIcons } from './gallery';
import { isRawFile } from './rawFormats';
import { generateThumbnail } from './thumbnail';
import { getCachedThumbnail, putCachedThumbnail, thumbnailCacheKey } from './thumbnailCache';

/** How many thumbnails to generate at once when a folder is opened. */
const THUMBNAIL_CONCURRENCY = 4;

interface FolderEntry {
  name: string;
  handle: FileSystemFileHandle;
  thumbEl: HTMLElement;
  thumbUrl?: string;
}

export class FolderPanel {
  readonly element: HTMLElement;

  private readonly listEl: HTMLElement;
  private readonly browseButton: HTMLButtonElement;
  private readonly gallery: GalleryOverlay;
  private readonly fileButtons = new Map<string, HTMLButtonElement>();
  private readonly thumbnailUrls = new Set<string>();
  private entries: FolderEntry[] = [];
  private dirName = '';
  // Bumped on every folder pick; in-flight thumbnail jobs from a previous
  // pick check this before touching the DOM so a slow job for an old folder
  // can't paint onto the newly opened one.
  private generation = 0;

  constructor(private readonly onSelect: (file: File, name: string, dirName: string) => void) {
    this.element = document.createElement('div');
    this.element.className = 'folder-panel';

    const toolbar = document.createElement('div');
    toolbar.className = 'folder-panel-toolbar';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'folder-open-button';
    openButton.textContent = 'Open folder…';
    openButton.addEventListener('click', () => void this.pickFolder());

    toolbar.append(openButton);

    const viewToolbar = document.createElement('div');
    viewToolbar.className = 'folder-view-toolbar';

    this.browseButton = document.createElement('button');
    this.browseButton.type = 'button';
    this.browseButton.className = 'icon-button';
    this.browseButton.title = 'Maximize';
    this.browseButton.innerHTML = galleryIcons.maximize;
    this.browseButton.disabled = true;
    this.browseButton.addEventListener('click', () => this.gallery.open(this.entries, this.dirName));

    viewToolbar.append(this.browseButton);

    this.listEl = document.createElement('div');
    this.listEl.className = 'folder-list';

    this.gallery = new GalleryOverlay((file, name) => this.selectFile(file, name));
    document.body.append(this.gallery.element);

    this.element.append(toolbar, viewToolbar, this.listEl);

    if (!window.showDirectoryPicker) {
      openButton.disabled = true;
      openButton.title =
        'This browser doesn’t support folder access (works in Chrome or Edge; Brave disables it for privacy)';
    }
  }

  private async pickFolder(): Promise<void> {
    if (!window.showDirectoryPicker) return;

    let dirHandle: FileSystemDirectoryHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ id: 'portraw-folder' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return; // user dismissed the picker
      console.error('showDirectoryPicker failed:', error);
      this.listEl.replaceChildren();
      const message = document.createElement('p');
      message.className = 'folder-empty';
      message.textContent = `Couldn't open folder: ${error instanceof Error ? error.message : String(error)}`;
      this.listEl.append(message);
      return;
    }

    this.setViewMode('list');
    const generation = ++this.generation;
    for (const url of this.thumbnailUrls) URL.revokeObjectURL(url);
    this.thumbnailUrls.clear();
    this.browseButton.disabled = true;
    this.dirName = dirHandle.name;

    const entries: Array<{ name: string; handle: FileSystemFileHandle }> = [];
    for await (const handle of dirHandle.values()) {
      if (handle.kind === 'file' && isRawFile(handle.name)) {
        entries.push({ name: handle.name, handle: handle as FileSystemFileHandle });
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    this.fileButtons.clear();
    const buttons: HTMLButtonElement[] = [];
    const folderEntries: FolderEntry[] = entries.map(({ name, handle }) => {
      const thumbEl = document.createElement('div');
      thumbEl.className = 'folder-thumb';

      const label = document.createElement('span');
      label.className = 'folder-item-name';
      label.textContent = name;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'folder-item';
      button.append(thumbEl, label);
      button.addEventListener('click', () => void this.select(name, handle));

      this.fileButtons.set(name, button);
      buttons.push(button);
      return { name, handle, thumbEl };
    });
    this.listEl.replaceChildren(...buttons);
    this.entries = folderEntries;

    if (folderEntries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'folder-empty';
      empty.textContent = 'No RAW files in this folder.';
      this.listEl.append(empty);
      return;
    }

    this.browseButton.disabled = false;
    void this.loadThumbnails(dirHandle.name, folderEntries, generation);
  }

  /** Fills in thumbnails for a freshly listed folder, a few files at a time. */
  private async loadThumbnails(dirName: string, entries: FolderEntry[], generation: number): Promise<void> {
    let next = 0;
    const runWorker = async () => {
      while (next < entries.length) {
        const entry = entries[next++];
        await this.loadThumbnail(dirName, entry, generation);
      }
    };
    await Promise.all(Array.from({ length: Math.min(THUMBNAIL_CONCURRENCY, entries.length) }, runWorker));
  }

  private async loadThumbnail(dirName: string, entry: FolderEntry, generation: number): Promise<void> {
    const file = await entry.handle.getFile();
    const key = thumbnailCacheKey(dirName, file);

    let blob = await getCachedThumbnail(key);
    if (!blob) {
      try {
        blob = await generateThumbnail(file);
      } catch (error) {
        console.error(`Thumbnail failed for ${file.name}:`, error);
        return;
      }
      void putCachedThumbnail(key, blob);
    }

    if (generation !== this.generation) return; // a newer folder pick superseded this one
    const url = URL.createObjectURL(blob);
    this.thumbnailUrls.add(url);
    entry.thumbEl.style.backgroundImage = `url(${url})`;
    entry.thumbEl.classList.add('loaded');
    entry.thumbUrl = url;
    this.gallery.refreshThumbnail(entry);
  }

  private async select(name: string, handle: FileSystemFileHandle): Promise<void> {
    const file = await handle.getFile();
    this.selectFile(file, name);
  }

  private selectFile(file: File, name: string): void {
    for (const [entryName, button] of this.fileButtons) {
      button.classList.toggle('selected', entryName === name);
    }
    this.onSelect(file, name, this.dirName);
  }
}
