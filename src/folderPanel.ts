// Folder browser: pick a directory via the File System Access API and list
// its DNG files so you can click through a shoot without re-opening a file
// picker for each one. Supported in Chrome/Edge; not in Safari/Firefox
// (unimplemented) or Brave (deliberately disabled for privacy) — the button
// disables itself when unsupported.

export class FolderPanel {
  readonly element: HTMLElement;

  private readonly listEl: HTMLElement;
  private readonly fileButtons = new Map<string, HTMLButtonElement>();

  constructor(private readonly onSelect: (file: File, name: string) => void) {
    this.element = document.createElement('div');
    this.element.className = 'folder-panel';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.textContent = 'Open folder…';
    openButton.addEventListener('click', () => void this.pickFolder());

    this.listEl = document.createElement('div');
    this.listEl.className = 'folder-list';

    this.element.append(openButton, this.listEl);

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

    const entries: Array<{ name: string; handle: FileSystemFileHandle }> = [];
    for await (const handle of dirHandle.values()) {
      if (handle.kind === 'file' && /\.dng$/i.test(handle.name)) {
        entries.push({ name: handle.name, handle: handle as FileSystemFileHandle });
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    this.fileButtons.clear();
    this.listEl.replaceChildren(
      ...entries.map(({ name, handle }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'folder-item';
        button.textContent = name;
        button.addEventListener('click', () => void this.select(name, handle));
        this.fileButtons.set(name, button);
        return button;
      }),
    );

    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'folder-empty';
      empty.textContent = 'No .dng files in this folder.';
      this.listEl.append(empty);
    }
  }

  private async select(name: string, handle: FileSystemFileHandle): Promise<void> {
    const file = await handle.getFile();
    for (const [entryName, button] of this.fileButtons) {
      button.classList.toggle('selected', entryName === name);
    }
    this.onSelect(file, name);
  }
}
