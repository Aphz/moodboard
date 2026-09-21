/**
 * Persistencia local (offline-first) sobre IndexedDB.
 *
 *  - `scenes`: documentos Scene completos (JSON) + miniatura.
 *  - `blobs`: bitmaps de imágenes (Blob) referenciados por `blobId`.
 *  - `kv`: preferencias, escena abierta, recientes.
 *
 * Los blobs se comparten entre escenas y se recolectan con `gcBlobs()`.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Scene } from './model';

export interface SceneMeta {
  id: string;
  name: string;
  updatedAt: number;
  itemCount: number;
  thumb: Blob | null;
}

interface MoodboardDB extends DBSchema {
  scenes: { key: string; value: { scene: Scene; meta: SceneMeta }; indexes: { byUpdated: number } };
  blobs: { key: string; value: { id: string; blob: Blob; w: number; h: number; type: string } };
  kv: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<MoodboardDB>> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB<MoodboardDB>('moodboard', 1, {
      upgrade(d) {
        const s = d.createObjectStore('scenes', { keyPath: 'meta.id' });
        s.createIndex('byUpdated', 'meta.updatedAt');
        d.createObjectStore('blobs', { keyPath: 'id' });
        d.createObjectStore('kv');
      }
    });
  }
  return dbPromise;
}

export async function saveScene(scene: Scene, thumb: Blob | null = null): Promise<void> {
  const d = await db();
  const meta: SceneMeta = {
    id: scene.id,
    name: scene.name,
    updatedAt: scene.updatedAt,
    itemCount: scene.items.length,
    thumb
  };
  await d.put('scenes', { scene: structuredClone(scene), meta });
  await setKV('lastSceneId', scene.id);
}

export async function loadScene(id: string): Promise<Scene | null> {
  const d = await db();
  const rec = await d.get('scenes', id);
  return rec?.scene ?? null;
}

export async function deleteScene(id: string): Promise<void> {
  const d = await db();
  await d.delete('scenes', id);
}

export async function listScenes(): Promise<SceneMeta[]> {
  const d = await db();
  const all = await d.getAll('scenes');
  return all.map((r) => r.meta).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putBlob(id: string, blob: Blob, w: number, h: number): Promise<void> {
  const d = await db();
  await d.put('blobs', { id, blob, w, h, type: blob.type });
}

/**
 * Proveedor remoto opcional: si un blob no está en IndexedDB se le pide
 * (p. ej. a la nube tras sincronizar) y se guarda localmente.
 */
export type RemoteBlobProvider = (id: string) => Promise<{ blob: Blob; w: number; h: number } | null>;
let remoteBlobProvider: RemoteBlobProvider | null = null;
const remoteInFlight = new Map<string, Promise<Blob | null>>();

export function setRemoteBlobProvider(p: RemoteBlobProvider | null) {
  remoteBlobProvider = p;
}

export async function getBlob(id: string): Promise<Blob | null> {
  const d = await db();
  const r = await d.get('blobs', id);
  if (r?.blob) return r.blob;
  if (!remoteBlobProvider) return null;
  let p = remoteInFlight.get(id);
  if (!p) {
    p = (async () => {
      try {
        const res = await remoteBlobProvider!(id);
        if (!res) return null;
        await putBlob(id, res.blob, res.w, res.h);
        return res.blob;
      } catch {
        return null;
      } finally {
        remoteInFlight.delete(id);
      }
    })();
    remoteInFlight.set(id, p);
  }
  return p;
}

/** Sólo local, sin consultar al proveedor remoto. */
export async function getLocalBlob(id: string): Promise<Blob | null> {
  const d = await db();
  const r = await d.get('blobs', id);
  return r?.blob ?? null;
}

export async function hasBlob(id: string): Promise<boolean> {
  const d = await db();
  return (await d.getKey('blobs', id)) !== undefined;
}

/** Elimina blobs que ninguna escena guardada referencia. Devuelve cuántos borró. */
export async function gcBlobs(extraLive: Iterable<string> = []): Promise<number> {
  const d = await db();
  const live = new Set<string>(extraLive);
  for (const r of await d.getAll('scenes')) {
    for (const it of r.scene.items) if (it.kind === 'image') live.add(it.blobId);
  }
  const keys = await d.getAllKeys('blobs');
  let n = 0;
  for (const k of keys) {
    if (!live.has(k)) {
      await d.delete('blobs', k);
      n++;
    }
  }
  return n;
}

export async function getKV<T>(key: string, fallback: T): Promise<T> {
  const d = await db();
  const v = await d.get('kv', key);
  return (v === undefined ? fallback : v) as T;
}

export async function setKV(key: string, value: unknown): Promise<void> {
  const d = await db();
  await d.put('kv', value, key);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  }
  return { usage: 0, quota: 0 };
}

/** Pide almacenamiento persistente (evita que iOS purgue los datos). */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* ignorar */
  }
  return false;
}
