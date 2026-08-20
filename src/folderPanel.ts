// Folder browser: pick a directory via the File System Access API and list
// its DNG files so you can click through a shoot without re-opening a file
// picker for each one. Chromium-only (Safari/Firefox don't implement
// showDirectoryPicker) — the button disables itself when unsupported.

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
      openButton.title = 'Folder browsing needs a Chromium-based browser (Chrome, Edge, Arc)';
    }
  }

  private async pickFolder(): Promise<void> {
    if (!window.showDirectoryPicker) return;

    let dirHandle: FileSystemDirectoryHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ id: 'raw-lite-folder' });
    } catch {
      return; // user dismissed the picker
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
