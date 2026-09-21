/**
 * Copiar / pegar interno (ítems con jerarquía) y hacia el sistema (imagen PNG).
 * El portapapeles interno vive en memoria y en sessionStorage para sobrevivir
 * recargas dentro de la sesión.
 */
import { descendantsOf, uid, type Item, type ItemId, type Point, type Rect } from '../core/model';
import { itemBounds, unionRects } from '../core/model';
import type { Store } from '../core/store';

interface ClipPayload {
  items: Item[];
  bounds: Rect;
}

let mem: ClipPayload | null = null;

export function copyItems(store: Store, roots: Item[]): number {
  const set = new Map<ItemId, Item>();
  for (const r of roots) {
    set.set(r.id, r);
    for (const d of descendantsOf(store.scene, r.id)) set.set(d.id, d);
  }
  const items = [...set.values()].map((i) => structuredClone(i));
  const bounds = unionRects(items.filter((i) => i.kind !== 'group').map(itemBounds)) ?? { x: 0, y: 0, w: 0, h: 0 };
  mem = { items, bounds };
  try {
    sessionStorage.setItem('moodboard.clip', JSON.stringify(mem));
  } catch {
    /* cuota */
  }
  return items.length;
}

export function hasInternalClip(): boolean {
  if (mem) return true;
  try {
    return !!sessionStorage.getItem('moodboard.clip');
  } catch {
    return false;
  }
}

function readClip(): ClipPayload | null {
  if (mem) return mem;
  try {
    const s = sessionStorage.getItem('moodboard.clip');
    if (s) mem = JSON.parse(s) as ClipPayload;
  } catch {
    /* ignorar */
  }
  return mem;
}

/**
 * Pega los ítems copiados centrados en `at`. Genera ids nuevos y mantiene
 * la jerarquía interna. Las imágenes comparten blob con el original.
 */
export function pasteItems(store: Store, at: Point, parentId: ItemId | null = null): Item[] {
  const clip = readClip();
  if (!clip || clip.items.length === 0) return [];
  const idMap = new Map<ItemId, ItemId>();
  for (const it of clip.items) idMap.set(it.id, uid());
  const dx = at.x - (clip.bounds.x + clip.bounds.w / 2);
  const dy = at.y - (clip.bounds.y + clip.bounds.h / 2);
  const out: Item[] = [];
  store.commit(() => {
    for (const src of clip.items) {
      const it = structuredClone(src);
      it.id = idMap.get(src.id)!;
      it.parentId = src.parentId && idMap.has(src.parentId) ? idMap.get(src.parentId)! : parentId;
      it.x += dx;
      it.y += dy;
      it.z = 0;
      it.createdAt = Date.now();
      store.addItem(it);
      out.push(it);
    }
    store.select(out.filter((i) => !i.parentId || !idMap.has(i.parentId)).map((i) => i.id));
  });
  return out;
}

/** Duplicado in situ (desplazado) manteniendo el padre de cada raíz. */
export function duplicateItems(store: Store, roots: Item[], offset = 24): Item[] {
  const set = new Map<ItemId, Item>();
  for (const r of roots) {
    set.set(r.id, r);
    for (const d of descendantsOf(store.scene, r.id)) set.set(d.id, d);
  }
  const idMap = new Map<ItemId, ItemId>();
  for (const id of set.keys()) idMap.set(id, uid());
  const out: Item[] = [];
  store.commit(() => {
    for (const src of set.values()) {
      const it = structuredClone(src);
      it.id = idMap.get(src.id)!;
      it.parentId = src.parentId && idMap.has(src.parentId) ? idMap.get(src.parentId)! : src.parentId;
      it.x += offset;
      it.y += offset;
      it.z = 0;
      it.createdAt = Date.now();
      store.addItem(it);
      out.push(it);
    }
    store.select(roots.map((r) => idMap.get(r.id)!));
  });
  return out;
}

export async function copyBlobToSystemClipboard(blob: Blob): Promise<boolean> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}

export async function copyTextToSystemClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
