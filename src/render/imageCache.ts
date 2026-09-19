/**
 * Caché de bitmaps decodificados, indexada por `blobId`.
 * Carga perezosa desde IndexedDB; notifica cuando un bitmap queda listo
 * para que el renderizador repinte.
 */
import { getBlob } from '../core/persistence';
import { decodeImage } from '../features/imageTools';

type Entry = { bmp: ImageBitmap | HTMLImageElement | null; loading: boolean; failed: boolean; lastUse: number };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const MAX_ENTRIES = 400;

export function onBitmapReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const l of listeners) l();
}

/** Devuelve el bitmap si está listo; si no, dispara la carga y devuelve null. */
export function getBitmap(blobId: string): ImageBitmap | HTMLImageElement | null {
  const e = cache.get(blobId);
  if (e) {
    e.lastUse = performance.now();
    return e.bmp;
  }
  const entry: Entry = { bmp: null, loading: true, failed: false, lastUse: performance.now() };
  cache.set(blobId, entry);
  void load(blobId, entry);
  return null;
}

export function isFailed(blobId: string): boolean {
  return cache.get(blobId)?.failed ?? false;
}

async function load(blobId: string, entry: Entry) {
  try {
    const blob = await getBlob(blobId);
    if (!blob) throw new Error('blob missing');
    entry.bmp = await decodeImage(blob);
  } catch {
    entry.failed = true;
  } finally {
    entry.loading = false;
    evict();
    notify();
  }
}

/** Inserta un bitmap ya decodificado (p. ej. recién importado). */
export function putBitmap(blobId: string, bmp: ImageBitmap | HTMLImageElement) {
  cache.set(blobId, { bmp, loading: false, failed: false, lastUse: performance.now() });
  evict();
  notify();
}

export function dropBitmap(blobId: string) {
  const e = cache.get(blobId);
  if (e?.bmp && 'close' in e.bmp) e.bmp.close();
  cache.delete(blobId);
}

export function clearBitmapCache() {
  for (const id of [...cache.keys()]) dropBitmap(id);
}

/** Espera a que todos los blobs indicados estén decodificados (para exportar). */
export async function ensureBitmaps(blobIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(blobIds)];
  await Promise.all(
    ids.map(async (id) => {
      const e = cache.get(id);
      if (e?.bmp || e?.failed) return;
      if (!e) {
        const entry: Entry = { bmp: null, loading: true, failed: false, lastUse: performance.now() };
        cache.set(id, entry);
        await load(id, entry);
      } else {
        await new Promise<void>((res) => {
          const off = onBitmapReady(() => {
            const cur = cache.get(id);
            if (!cur || cur.bmp || cur.failed) {
              off();
              res();
            }
          });
        });
      }
    })
  );
}

function evict() {
  if (cache.size <= MAX_ENTRIES) return;
  const entries = [...cache.entries()].filter(([, e]) => !e.loading).sort((a, b) => a[1].lastUse - b[1].lastUse);
  const n = cache.size - MAX_ENTRIES;
  for (let i = 0; i < n && i < entries.length; i++) dropBitmap(entries[i][0]);
}
