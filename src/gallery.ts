// Fullscreen gallery for browsing a folder's thumbnails: a grid of bigger
// tiles, or a slideshow (big photo + left/right nav + filmstrip). Reuses the
// small thumbnails FolderPanel already generated; the slideshow's big photo
// is a sharper preview generated on demand (see LARGE_MAX_DIMENSION) so
// browsing doesn't wait on every thumbnail being upscaled up front.
import { generateThumbnail, LARGE_MAX_DIMENSION } from './thumbnail';
import { getCachedThumbnail, putCachedThumbnail, thumbnailCacheKey } from './thumbnailCache';

export interface GalleryPhoto {
  name: string;
  handle: FileSystemFileHandle;
  thumbUrl?: string;
}

type Mode = 'grid' | 'slideshow';

const ICONS = {
  grid: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="9" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  slideshow:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 6l4 2.5-4 2.5V6z" fill="currentColor"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  chevronLeft:
    '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path d="M10 2.5L5 8l5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevronRight:
    '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path d="M6 2.5L11 8l-5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  maximize:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 5.5v-4h4M14.5 5.5v-4h-4M1.5 10.5v4h4M14.5 10.5v4h-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function iconButton(icon: string, title: string, className: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.title = title;
  button.innerHTML = icon;
  return button;
}

export class GalleryOverlay {
  readonly element: HTMLElement;

  private readonly titleEl: HTMLElement;
  private readonly gridModeButton: HTMLButtonElement;
  private readonly slideshowModeButton: HTMLButtonElement;
  private readonly bodyEl: HTMLElement;
  private readonly gridEl: HTMLElement;
  private readonly stageImg: HTMLImageElement;
  private readonly prevButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly filmstripEl: HTMLElement;

  private photos: GalleryPhoto[] = [];
  private dirName = '';
  private mode: Mode = 'grid';
  private currentIndex = 0;
  // Bumped on every open() so a slow large-preview decode from a previous
  // session (or a photo the user has since navigated away from) can't paint
  // onto the stage after the fact.
  private generation = 0;
  private readonly largeUrls = new Set<string>();
  private readonly keydownHandler = (e: KeyboardEvent) => this.onKeydown(e);

  constructor(private readonly onOpenPhoto: (file: File, name: string) => void) {
    this.element = document.createElement('div');
    this.element.className = 'gallery-overlay hidden';

    const toolbar = document.createElement('div');
    toolbar.className = 'gallery-toolbar';

    this.titleEl = document.createElement('span');
    this.titleEl.className = 'gallery-title';

    const modeToggle = document.createElement('div');
    modeToggle.className = 'gallery-mode-toggle';
    this.gridModeButton = iconButton(ICONS.grid, 'Grid view', 'gallery-mode-button');
    this.slideshowModeButton = iconButton(ICONS.slideshow, 'Slideshow view', 'gallery-mode-button');
    this.gridModeButton.addEventListener('click', () => this.setMode('grid'));
    this.slideshowModeButton.addEventListener('click', () => this.setMode('slideshow'));
    modeToggle.append(this.gridModeButton, this.slideshowModeButton);

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'gallery-open-button';
    openButton.textContent = 'Open in editor';
    openButton.addEventListener('click', () => this.openCurrent());

    const closeButton = iconButton(ICONS.close, 'Close', 'icon-button gallery-close');
    closeButton.addEventListener('click', () => this.close());

    toolbar.append(this.titleEl, modeToggle, openButton, closeButton);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'gallery-body';

    this.gridEl = document.createElement('div');
    this.gridEl.className = 'gallery-grid';

    const slideshowEl = document.createElement('div');
    slideshowEl.className = 'gallery-slideshow';

    const stage = document.createElement('div');
    stage.className = 'gallery-stage';
    this.prevButton = iconButton(ICONS.chevronLeft, 'Previous photo', 'gallery-nav gallery-nav-prev');
    this.nextButton = iconButton(ICONS.chevronRight, 'Next photo', 'gallery-nav gallery-nav-next');
    this.prevButton.addEventListener('click', () => this.showSlide(this.currentIndex - 1));
    this.nextButton.addEventListener('click', () => this.showSlide(this.currentIndex + 1));
    this.stageImg = document.createElement('img');
    this.stageImg.className = 'gallery-stage-img';
    this.stageImg.alt = '';
    this.stageImg.addEventListener('dblclick', () => this.openCurrent());
    stage.append(this.prevButton, this.stageImg, this.nextButton);

    this.filmstripEl = document.createElement('div');
    this.filmstripEl.className = 'gallery-filmstrip';

    slideshowEl.append(stage, this.filmstripEl);
    this.bodyEl.append(this.gridEl, slideshowEl);
    this.element.append(toolbar, this.bodyEl);
  }

  open(photos: GalleryPhoto[], dirName: string): void {
    this.photos = photos;
    this.dirName = dirName;
    this.currentIndex = 0;
    this.generation++;
    for (const url of this.largeUrls) URL.revokeObjectURL(url);
    this.largeUrls.clear();
    this.stageImg.src = '';

    this.renderGrid();
    this.renderFilmstrip();
    this.setMode('grid');

    this.element.classList.remove('hidden');
    window.addEventListener('keydown', this.keydownHandler);
  }

  close(): void {
    this.element.classList.add('hidden');
    window.removeEventListener('keydown', this.keydownHandler);
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.bodyEl.dataset.mode = mode;
    this.gridModeButton.classList.toggle('selected', mode === 'grid');
    this.slideshowModeButton.classList.toggle('selected', mode === 'slideshow');
    if (mode === 'slideshow') this.showSlide(this.currentIndex);
    else this.updateTitle();
  }

  private renderGrid(): void {
    const tiles = this.photos.map((photo, index) => {
      const thumb = document.createElement('div');
      thumb.className = 'gallery-grid-thumb';
      if (photo.thumbUrl) {
        thumb.style.backgroundImage = `url(${photo.thumbUrl})`;
        thumb.classList.add('loaded');
      }
      const name = document.createElement('span');
      name.className = 'gallery-grid-name';
      name.textContent = photo.name;

      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'gallery-grid-item';
      tile.append(thumb, name);
      tile.addEventListener('click', () => {
        this.currentIndex = index;
        this.setMode('slideshow');
      });
      return tile;
    });
    this.gridEl.replaceChildren(...tiles);
  }

  /** Called by FolderPanel as sidebar thumbnails finish loading, in case they're still in flight when the gallery is opened. */
  refreshThumbnail(photo: GalleryPhoto): void {
    const index = this.photos.indexOf(photo);
    if (index === -1 || !photo.thumbUrl) return;

    const gridThumb = this.gridEl.children[index]?.querySelector<HTMLElement>('.gallery-grid-thumb');
    gridThumb?.style.setProperty('background-image', `url(${photo.thumbUrl})`);
    gridThumb?.classList.add('loaded');

    const filmItem = this.filmstripEl.children[index] as HTMLElement | undefined;
    filmItem?.style.setProperty('background-image', `url(${photo.thumbUrl})`);
    filmItem?.classList.add('loaded');

    if (this.mode === 'slideshow' && index === this.currentIndex && !this.stageImg.src) {
      this.stageImg.src = photo.thumbUrl;
    }
  }

  private renderFilmstrip(): void {
    const items = this.photos.map((photo, index) => {
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'gallery-filmstrip-item';
      if (photo.thumbUrl) {
        thumb.style.backgroundImage = `url(${photo.thumbUrl})`;
        thumb.classList.add('loaded');
      }
      thumb.title = photo.name;
      thumb.addEventListener('click', () => this.showSlide(index));
      return thumb;
    });
    this.filmstripEl.replaceChildren(...items);
  }

  private showSlide(index: number): void {
    if (this.photos.length === 0) return;
    this.currentIndex = Math.max(0, Math.min(index, this.photos.length - 1));
    const photo = this.photos[this.currentIndex];

    this.stageImg.src = photo.thumbUrl ?? '';
    this.prevButton.disabled = this.currentIndex === 0;
    this.nextButton.disabled = this.currentIndex === this.photos.length - 1;
    for (let i = 0; i < this.filmstripEl.children.length; i++) {
      this.filmstripEl.children[i].classList.toggle('selected', i === this.currentIndex);
    }
    (this.filmstripEl.children[this.currentIndex] as HTMLElement | undefined)?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
    });
    this.updateTitle();
    void this.loadLargePreview(this.currentIndex, this.generation);
  }

  private updateTitle(): void {
    if (this.mode === 'slideshow' && this.photos.length > 0) {
      this.titleEl.textContent = `${this.dirName} — ${this.currentIndex + 1} / ${this.photos.length} — ${this.photos[this.currentIndex].name}`;
    } else {
      this.titleEl.textContent = `${this.dirName} — ${this.photos.length} photo${this.photos.length === 1 ? '' : 's'}`;
    }
  }

  private async loadLargePreview(index: number, generation: number): Promise<void> {
    const photo = this.photos[index];
    const file = await photo.handle.getFile();
    const key = thumbnailCacheKey(this.dirName, file, LARGE_MAX_DIMENSION);

    let blob = await getCachedThumbnail(key);
    if (!blob) {
      try {
        blob = await generateThumbnail(file, LARGE_MAX_DIMENSION);
      } catch (error) {
        console.error(`Large preview failed for ${file.name}:`, error);
        return;
      }
      void putCachedThumbnail(key, blob);
    }

    if (generation !== this.generation || index !== this.currentIndex) return; // superseded by a newer open() or slide change
    const url = URL.createObjectURL(blob);
    this.largeUrls.add(url);
    this.stageImg.src = url;
  }

  private async openCurrent(): Promise<void> {
    if (this.photos.length === 0) return;
    const photo = this.photos[this.currentIndex];
    const file = await photo.handle.getFile();
    this.onOpenPhoto(file, photo.name);
    this.close();
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.close();
    } else if (this.mode === 'slideshow' && e.key === 'ArrowLeft') {
      this.showSlide(this.currentIndex - 1);
    } else if (this.mode === 'slideshow' && e.key === 'ArrowRight') {
      this.showSlide(this.currentIndex + 1);
    } else if (this.mode === 'slideshow' && e.key === 'Enter') {
      void this.openCurrent();
    } else {
      return;
    }
    e.preventDefault();
  }
}

export { ICONS as galleryIcons };
