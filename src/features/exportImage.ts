/** Exportación a PNG/JPEG y compartir/descargar en iOS y escritorio. */
import { descendantsOf, itemBounds, unionRects, type Item, type Rect } from '../core/model';
import type { Store } from '../core/store';
import { ensureBitmaps } from '../render/imageCache';
import { renderToCanvas, type Renderer } from '../render/renderer';

export interface ExportOptions {
  includeChildren: boolean;
  scale: number;
  background: string | null; // null = transparente
  format: 'image/png' | 'image/jpeg';
  quality?: number;
}

/** Ítems a exportar: raíces + (opcional) descendientes. */
export function exportSet(store: Store, roots: Item[], includeChildren: boolean): Item[] {
  const set = new Set<Item>();
  for (const r of roots) {
    set.add(r);
    if (includeChildren || r.kind === 'group') for (const d of descendantsOf(store.scene, r.id)) set.add(d);
  }
  return [...set];
}

export async function renderItemsToBlob(renderer: Renderer, items: Item[], opts: ExportOptions): Promise<{ blob: Blob; bounds: Rect } | null> {
  const drawable = items.filter((i) => i.kind !== 'group' && i.visible);
  const bounds = unionRects(drawable.map(itemBounds));
  if (!bounds) return null;
  await ensureBitmaps(drawable.filter((i) => i.kind === 'image').map((i) => (i as { blobId: string }).blobId));
  // limitar a ~16 Mpx en iOS
  const maxPx = 16e6;
  let scale = opts.scale;
  if (bounds.w * bounds.h * scale * scale > maxPx) scale = Math.sqrt(maxPx / (bounds.w * bounds.h));
  const canvas = renderToCanvas(renderer, drawable, bounds, scale, opts.background);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, opts.format, opts.quality ?? 0.92));
  if (!blob) return null;
  return { blob, bounds };
}

export function canShareFiles(): boolean {
  return typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
}

/** Comparte (iOS) o descarga (escritorio) un archivo. */
export async function shareOrDownload(blob: Blob, filename: string, title = filename): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], filename, { type: blob.type });
  if (canShareFiles() && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
      /* si falla, descargar */
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

export function safeFileName(name: string): string {
  return (name || 'moodboard').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80) || 'moodboard';
}
