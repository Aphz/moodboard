/**
 * Importación de imágenes: archivos, portapapeles, URLs, drag & drop.
 * Optimiza según ajustes, calcula paleta + hash perceptual y coloca las
 * imágenes en la escena (en cuadrícula temporal para evitar parpadeos).
 */
import { createImageItem, uid, type ImageItem, type Point } from '../core/model';
import { putBlob } from '../core/persistence';
import { appSettings } from '../core/settings';
import type { Store } from '../core/store';
import { putBitmap } from '../render/imageCache';
import { decodeImage, fetchImageBlob, imageDataOf, isImageFile, optimizeImage } from './imageTools';
import { extractPalette } from './palette';
import { dhash } from './phash';
import { arrangeGrid } from './arrange';
import { t } from '../i18n';
import { toast } from '../ui/dialogs';

export interface ImportedImage {
  blobId: string;
  w: number;
  h: number;
  bitmap: ImageBitmap;
  palette: string[];
  phash: string;
  bytes: number;
}

/** Decodifica, optimiza y guarda un blob. No toca la escena. */
export async function ingestBlob(blob: Blob, name: string): Promise<ImportedImage> {
  const opt = await optimizeImage(blob, appSettings.autoOptimizeMaxSide, appSettings.optimizeQuality);
  const bitmap = await decodeImage(opt.blob);
  const blobId = uid('b');
  await putBlob(blobId, opt.blob, bitmap.width, bitmap.height);
  putBitmap(blobId, bitmap);
  let palette: string[] = [];
  let phash = '';
  try {
    const small = imageDataOf(bitmap, 96);
    palette = extractPalette(small.data, 6);
    phash = dhash(small.data, small.width, small.height);
  } catch {
    /* sin paleta */
  }
  void name;
  return { blobId, w: bitmap.width, h: bitmap.height, bitmap, palette, phash, bytes: opt.blob.size };
}

/**
 * Importa varios archivos/blobs a la escena. Los coloca centrados en
 * `at` (escena) o en el centro de la vista si no se indica.
 */
export async function importBlobs(
  store: Store,
  entries: { blob: Blob; name: string }[],
  at: Point,
  opts: { parentId?: string | null } = {}
): Promise<ImageItem[]> {
  if (entries.length === 0) return [];
  const tt = toast(t('ui_optimizing'), { spinner: true });
  const items: ImageItem[] = [];
  let failed = 0;
  try {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      tt.update(`${t('ui_optimizing')} ${i + 1}/${entries.length}`);
      try {
        const img = await ingestBlob(e.blob, e.name);
        const it = createImageItem(img.blobId, img.w, img.h, {
          name: e.name.replace(/\.[a-z0-9]+$/i, '') || 'Imagen',
          source: e.name,
          palette: img.palette,
          phash: img.phash,
          x: at.x,
          y: at.y
        });
        // tamaño inicial razonable en pantalla: lado mayor ≈ 480 unidades
        const maxSide = Math.max(img.w, img.h);
        if (maxSide > 480) it.scale = 480 / maxSide;
        items.push(it);
      } catch (err) {
        console.warn('import failed', e.name, err);
        failed++;
      }
    }
  } finally {
    tt.close();
  }
  if (items.length === 0) {
    toast(t('ui_import_error'), { error: true });
    return [];
  }
  store.commit(() => {
    for (const it of items) {
      if (opts.parentId) it.parentId = opts.parentId;
      store.addItem(it);
    }
    if (items.length > 1) {
      const aspect = Math.max(0.5, Math.min(2.5, innerWidth / Math.max(1, innerHeight)));
      const pl = arrangeGrid(items, { padding: store.scene.settings.alignPadding, aspect });
      store.update(
        pl.map((p) => p.id),
        (it) => {
          const p = pl.find((x) => x.id === it.id)!;
          it.x = p.x;
          it.y = p.y;
        }
      );
    }
    store.select(items.map((i) => i.id));
  });
  if (failed) toast(`${t('ui_import_error')} (${failed})`, { error: true });
  return items;
}

export async function importFiles(store: Store, files: FileList | File[], at: Point): Promise<ImageItem[]> {
  const list = [...files].filter(isImageFile);
  return importBlobs(store, list.map((f) => ({ blob: f, name: f.name })), at);
}

export async function importFromUrl(store: Store, url: string, at: Point): Promise<ImageItem[]> {
  const tt = toast(t('ui_optimizing'), { spinner: true });
  try {
    const blob = await fetchImageBlob(url);
    const name = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'imagen');
    return await importBlobs(store, [{ blob, name }], at);
  } catch {
    toast(t('ui_url_error'), { error: true });
    return [];
  } finally {
    tt.close();
  }
}

/** Extrae imágenes/URLs de un DataTransfer (pegar o soltar). */
export async function entriesFromDataTransfer(dt: DataTransfer): Promise<{ blobs: { blob: Blob; name: string }[]; urls: string[]; text: string }> {
  const blobs: { blob: Blob; name: string }[] = [];
  const urls: string[] = [];
  let text = '';
  for (const item of dt.items ?? []) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f && isImageFile(f)) blobs.push({ blob: f, name: f.name || `pegado-${Date.now()}.png` });
    }
  }
  if (blobs.length === 0 && dt.files?.length) for (const f of dt.files) if (isImageFile(f)) blobs.push({ blob: f, name: f.name });
  const html = dt.getData('text/html');
  if (blobs.length === 0 && html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const img of doc.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (src && /^https?:/.test(src)) urls.push(src);
    }
  }
  const uri = dt.getData('text/uri-list') || dt.getData('text/plain');
  if (blobs.length === 0 && urls.length === 0 && uri) {
    const first = uri.split('\n')[0].trim();
    if (/^https?:\/\/\S+\.(png|jpe?g|webp|gif|avif|bmp|svg)(\?\S*)?$/i.test(first) || (/^https?:\/\//.test(first) && !/\s/.test(first))) urls.push(first);
    else text = uri;
  }
  return { blobs, urls, text };
}
