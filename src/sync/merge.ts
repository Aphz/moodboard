/**
 * Fusión de escenas entre dispositivos (funciones puras, sin dependencias
 * del DOM ni de red). Es el corazón de la sincronización: dos dispositivos
 * pueden editar la misma escena sin conexión y aquí se reconcilian.
 *
 * Estrategia:
 *  - Por ítem: gana el de `mtime` mayor (LWW, "last writer wins").
 *  - Los borrados se propagan con lápidas (`Scene.tombstones`: id → ms del
 *    borrado). Un ítem sólo se resucita si su `mtime` es posterior a la
 *    lápida (es decir, si de verdad se volvió a crear después de borrarlo).
 *  - `name` y `settings` vienen del lado con `updatedAt` mayor.
 *  - `viewport` nunca se sincroniza: es propio de cada dispositivo.
 *
 * Todo es determinista: con las mismas entradas (y el mismo `now`) el
 * resultado es idéntico, y las entradas jamás se mutan.
 */
import type { Item, ItemId, Scene } from '../core/model';

/** Las lápidas de más de 30 días se descartan: ya no aportan información. */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface MergeResult {
  /** Escena fusionada (objeto nuevo). */
  scene: Scene;
  /** `true` si el resultado difiere de la copia local (hay que guardarla). */
  localChanged: boolean;
  /** `true` si el resultado difiere de la copia remota (hay que subirla). */
  remoteChanged: boolean;
}

// ---------------------------------------------------------------------------
// utilidades

function clone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * JSON con las claves de cada objeto ordenadas alfabéticamente, para que dos
 * estructuras equivalentes produzcan siempre exactamente el mismo texto.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Contenido sincronizable de una escena (sin viewport ni marcas de tiempo del documento). */
function content(scene: Scene): unknown {
  const items = [...scene.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { name: scene.name, settings: scene.settings, items, tombstones: scene.tombstones ?? {} };
}

/** Forma canónica usada para decidir si el resultado difiere de una de las entradas. */
function canonical(scene: Scene): string {
  return stableStringify({ c: content(scene), u: scene.updatedAt });
}

/**
 * Hash FNV-1a de 32 bits del contenido de la escena (sin viewport ni
 * `updatedAt`). Sirve para detectar si una escena cambió de verdad desde la
 * última sincronización sin guardar una copia entera.
 */
export function sceneDigest(scene: Scene): string {
  const s = stableStringify(content(scene));
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// fusión

/**
 * Fusiona la copia local y la remota de una misma escena.
 *
 * @param local  copia de este dispositivo (aporta el `viewport`).
 * @param remote copia descargada del servidor.
 * @param now    reloj de referencia para podar lápidas (inyectable para tests).
 */
export function mergeScenes(local: Scene, remote: Scene, now: number = Date.now()): MergeResult {
  // 1. lápidas: unión quedándose con el borrado más reciente de cada id
  const tomb: Record<ItemId, number> = {};
  for (const [id, at] of Object.entries(local.tombstones ?? {})) tomb[id] = at;
  for (const [id, at] of Object.entries(remote.tombstones ?? {})) tomb[id] = Math.max(tomb[id] ?? 0, at);

  // 2. ítems: orden estable (los locales primero, luego los que sólo están en remoto)
  const localById = new Map(local.items.map((i) => [i.id, i]));
  const remoteById = new Map(remote.items.map((i) => [i.id, i]));
  const order: ItemId[] = [];
  const seen = new Set<ItemId>();
  for (const it of local.items) if (!seen.has(it.id)) (seen.add(it.id), order.push(it.id));
  for (const it of remote.items) if (!seen.has(it.id)) (seen.add(it.id), order.push(it.id));

  const items: Item[] = [];
  for (const id of order) {
    const l = localById.get(id);
    const r = remoteById.get(id);
    // gana el mtime mayor; empate ⇒ local (determinista)
    const winner = !l ? r! : !r ? l : (r.mtime ?? 0) > (l.mtime ?? 0) ? r : l;
    const buried = tomb[id];
    // un lado lo borró después de la última modificación conocida ⇒ sigue borrado
    if (buried !== undefined && buried > (winner.mtime ?? 0)) continue;
    items.push(clone(winner));
  }

  // 3. lápidas finales: sin las de ítems vivos (revividos) y sin las caducadas
  const alive = new Set(items.map((i) => i.id));
  const tombstones: Record<ItemId, number> = {};
  for (const [id, at] of Object.entries(tomb)) {
    if (alive.has(id)) continue;
    if (now - at > TOMBSTONE_TTL_MS) continue;
    tombstones[id] = at;
  }

  // 4. metadatos del documento
  const newest = remote.updatedAt > local.updatedAt ? remote : local;
  const scene: Scene = {
    id: local.id,
    version: 1,
    name: newest.name,
    items,
    viewport: { ...local.viewport },
    settings: clone(newest.settings),
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    tombstones
  };

  const merged = canonical(scene);
  return { scene, localChanged: merged !== canonical(local), remoteChanged: merged !== canonical(remote) };
}
