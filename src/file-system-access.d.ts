// TypeScript's bundled DOM lib has FileSystemDirectoryHandle but not yet
// showDirectoryPicker() or the async-iterable directory methods (Chromium
// ships these; they haven't landed in the lib TS ships). Ambient additions
// covering only the surface folderPanel.ts uses.
export {};

declare global {
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemHandle>;
  }

  interface Window {
    showDirectoryPicker?(options?: {
      id?: string;
      mode?: 'read' | 'readwrite';
    }): Promise<FileSystemDirectoryHandle>;
  }
}
