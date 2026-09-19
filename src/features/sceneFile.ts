/**
 * Formato de archivo `.moodboard`: un ZIP con la escena y sus imágenes.
 *
 * Estructura del contenedor:
 *
 * ```text
 * scene.json              → el objeto `Scene` serializado (nivel de compresión 6)
 * blobs/<blobId>.<ext>    → un archivo por cada bitmap referenciado (nivel 0)
 * ```
 *
 * Los bitmaps ya vienen comprimidos (PNG/JPG/WebP/GIF), así que se guardan
 * «stored» (nivel 0) para no gastar CPU en el iPad; sólo `scene.json` se
 * desinfla.
 *
 * Al importar se regeneran TODOS los identificadores (escena, ítems y blobs)
 * para que un mismo archivo pueda abrirse varias veces sin pisar los datos
 * que ya existen en IndexedDB.
 */
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import {
  descendantsOf,
  itemBounds,
  uid,
  unionRects,
  type ImageItem,
  type Item,
  type ItemId,
  type Scene
} from '../core/model';

/** Ruta del manifiesto dentro del ZIP. */
const SCENE_ENTRY = 'scene.json';
/** Carpeta de bitmaps dentro del ZIP. */
const BLOB_DIR = 'blobs/';
/** Extensión del archivo exportado. */
export const SCENE_FILE_EXT = '.moodboard';

// ---------------------------------------------------------------------------
// Tipos MIME

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
};

/** Extensión de archivo para un tipo MIME de imagen (`png` si no se reconoce). */
export function mimeToExt(type: string): string {
  return MIME_TO_EXT[(type || '').toLowerCase().split(';')[0].trim()] ?? 'png';
}

/** Tipo MIME para una extensión de archivo (genérico si no se reconoce). */
export function extToMime(ext: string): string {
  const e = (ext || '').toLowerCase().replace(/^\./, '');
  return EXT_TO_MIME[e] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Utilidades

/**
 * Lee un `Blob` completo como bytes.
 *
 * En navegadores modernos y en jsdom basta `Blob.arrayBuffer()`; si no existe
 * (WebKit antiguo) se recurre a `FileReader`.
 */
export function blobToU8(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((b) => new Uint8Array(b));
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
    fr.onerror = () => reject(new Error('No se pudo leer el archivo'));
    fr.readAsArrayBuffer(blob);
  });
}

/** Nombre de archivo saneado para una escena, con extensión `.moodboard`. */
export function sceneFileName(scene: Scene): string {
  const raw = (scene?.name ?? '').normalize('NFC');
  const clean = raw
    // caracteres prohibidos en FAT/iOS/Windows y controles
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60)
    .trim();
  return `${clean || 'moodboard'}${SCENE_FILE_EXT}`;
}

/** Copia profunda sin depender de `structuredClone`. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Resuelve el conjunto de ítems a exportar: los pedidos más todos sus
 * descendientes (sin repetir y conservando el orden original de la escena).
 */
function collectItems(scene: Scene, onlyItems?: Set<ItemId>): Item[] {
  if (!onlyItems || onlyItems.size === 0) return scene.items.slice();
  const keep = new Set<ItemId>();
  for (const id of onlyItems) {
    if (!scene.items.some((i) => i.id === id)) continue;
    keep.add(id);
    for (const d of descendantsOf(scene, id)) keep.add(d.id);
  }
  return scene.items.filter((i) => keep.has(i.id));
}

/** Centro geométrico de un conjunto de ítems (media de posiciones si no hay caja). */
function centerOf(items: Item[]): { x: number; y: number } {
  const rects = items.filter((i) => i.kind !== 'group').map(itemBounds);
  const box = unionRects(rects);
  if (box) return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  if (items.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const i of items) {
    sx += i.x;
    sy += i.y;
  }
  return { x: sx / items.length, y: sy / items.length };
}

// ---------------------------------------------------------------------------
// Exportación

export interface ExportSceneOptions {
  /** Si se indica, sólo se exportan estos ítems y sus descendientes. */
  onlyItems?: Set<ItemId>;
}

/**
 * Empaqueta una escena (o una parte) en un `Blob` con formato `.moodboard`.
 *
 * @param scene     Escena de origen (no se modifica).
 * @param getBlobFn Lector de bitmaps por `blobId`; si devuelve `null` el ítem
 *                  se exporta igualmente, pero sin su imagen.
 * @param opts      `onlyItems` limita la exportación a una selección: los
 *                  roots resultantes pierden el padre y todo se recentra en 0,0.
 */
export async function exportSceneFile(
  scene: Scene,
  getBlobFn: (id: string) => Promise<Blob | null>,
  opts: ExportSceneOptions = {}
): Promise<Blob> {
  const subset = !!opts.onlyItems && opts.onlyItems.size > 0;
  const picked = collectItems(scene, opts.onlyItems);
  const ids = new Set(picked.map((i) => i.id));
  const items = clone(picked);

  // Los ítems cuyo padre queda fuera del recorte pasan a ser raíces.
  for (const it of items) {
    if (it.parentId !== null && !ids.has(it.parentId)) it.parentId = null;
  }

  if (subset) {
    const c = centerOf(items);
    for (const it of items) {
      it.x -= c.x;
      it.y -= c.y;
    }
  }

  const out: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};

  // Un mismo blobId sólo se escribe una vez aunque lo usen varios ítems.
  const written = new Set<string>();
  for (const it of items) {
    if (it.kind !== 'image') continue;
    const img = it as ImageItem;
    if (!img.blobId || written.has(img.blobId)) continue;
    written.add(img.blobId);
    const blob = await getBlobFn(img.blobId);
    if (!blob) continue;
    const bytes = await blobToU8(blob);
    out[`${BLOB_DIR}${img.blobId}.${mimeToExt(blob.type)}`] = [bytes, { level: 0 }];
  }

  const doc: Scene = {
    ...clone(scene),
    items,
    viewport: subset ? { x: 0, y: 0, zoom: 1 } : clone(scene.viewport),
    updatedAt: Date.now()
  };
  out[SCENE_ENTRY] = [strToU8(JSON.stringify(doc)), { level: 6 }];

  const zipped = zipSync(out, { level: 0 });
  return new Blob([zipped as unknown as BlobPart], { type: 'application/zip' });
}

// ---------------------------------------------------------------------------
// Importación

/** Extrae `blobId` y extensión de una entrada `blobs/<id>.<ext>`. */
function parseBlobEntry(path: string): { id: string; ext: string } | null {
  if (!path.startsWith(BLOB_DIR)) return null;
  const name = path.slice(BLOB_DIR.length);
  if (!name || name.includes('/')) return null;
  const dot = name.lastIndexOf('.');
  const id = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return id ? { id, ext } : null;
}

/** Comprueba, con mensajes legibles, que el JSON leído parece una `Scene`. */
function validateScene(data: unknown): Scene {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('El archivo .moodboard está dañado: scene.json no es válido');
  }
  const s = data as Partial<Scene>;
  if (s.version !== 1) {
    throw new Error(`Versión de escena no compatible: ${String(s.version)}`);
  }
  if (!Array.isArray(s.items)) {
    throw new Error('El archivo .moodboard está dañado: falta la lista de ítems');
  }
  return s as Scene;
}

/**
 * Lee un archivo `.moodboard` y devuelve una `Scene` lista para `store.loadScene`.
 *
 * Todos los identificadores se regeneran (escena, ítems y blobs) manteniendo la
 * coherencia de `parentId`, y cada bitmap se guarda con `putBlobFn` usando el
 * `naturalW`/`naturalH` declarado por su ítem.
 *
 * @throws Error con un mensaje legible si el archivo no es un `.moodboard` válido.
 */
export async function importSceneFile(
  file: Blob,
  putBlobFn: (id: string, blob: Blob, w: number, h: number) => Promise<void>
): Promise<Scene> {
  const bytes = await blobToU8(file);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('No es un archivo .moodboard válido (no se pudo abrir el ZIP)');
  }

  const manifest = entries[SCENE_ENTRY];
  if (!manifest) {
    throw new Error('No es un archivo .moodboard válido: falta scene.json');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(manifest));
  } catch {
    throw new Error('El archivo .moodboard está dañado: scene.json no es JSON');
  }
  const src = validateScene(parsed);

  // Nuevos ids de ítems y de blobs.
  const idMap = new Map<ItemId, ItemId>();
  for (const it of src.items) {
    if (it && typeof it.id === 'string') idMap.set(it.id, uid());
  }
  const blobMap = new Map<string, string>();
  for (const it of src.items) {
    if (it?.kind === 'image' && it.blobId) {
      if (!blobMap.has(it.blobId)) blobMap.set(it.blobId, uid('b'));
    }
  }

  const items: Item[] = clone(src.items).map((it) => {
    const next = it as Item;
    next.id = idMap.get(it.id) ?? uid();
    next.parentId = next.parentId ? idMap.get(next.parentId) ?? null : null;
    if (next.kind === 'image' && next.blobId) {
      next.blobId = blobMap.get(next.blobId) ?? next.blobId;
    }
    return next;
  });

  // Tamaños declarados por los ítems, indexados por blobId nuevo.
  const sizes = new Map<string, { w: number; h: number }>();
  for (const it of items) {
    if (it.kind === 'image') {
      sizes.set(it.blobId, { w: it.naturalW || it.w || 0, h: it.naturalH || it.h || 0 });
    }
  }

  for (const [path, data] of Object.entries(entries)) {
    const parsedEntry = parseBlobEntry(path);
    if (!parsedEntry) continue;
    const newId = blobMap.get(parsedEntry.id);
    if (!newId) continue; // bitmap huérfano: no lo referencia ningún ítem
    const size = sizes.get(newId) ?? { w: 0, h: 0 };
    const blob = new Blob([data as unknown as BlobPart], { type: extToMime(parsedEntry.ext) });
    await putBlobFn(newId, blob, size.w, size.h);
  }

  const now = Date.now();
  return {
    ...src,
    id: uid('s'),
    version: 1,
    name: typeof src.name === 'string' && src.name ? src.name : 'Sin título',
    items,
    viewport: src.viewport ?? { x: 0, y: 0, zoom: 1 },
    createdAt: typeof src.createdAt === 'number' ? src.createdAt : now,
    updatedAt: now
  };
}
