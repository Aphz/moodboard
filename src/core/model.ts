/**
 * Modelo de datos del moodboard.
 *
 * Un `Scene` es un lienzo infinito con una lista plana de `Item`s.
 * La jerarquía (padre/hijo, grupos) se expresa con `parentId`: las notas y
 * los dibujos pueden ser hijos de una imagen y se mueven con ella; un `group`
 * es un ítem contenedor sin contenido visual propio.
 *
 * Todas las coordenadas de ítems están en espacio de escena (unidades de
 * lienzo, no píxeles de pantalla). `x,y` es el centro del ítem; `w,h` su
 * tamaño sin escalar; `rotation` en radianes; `scale` uniforme.
 */

export type ItemId = string;

export type ItemKind = 'image' | 'note' | 'drawing' | 'group';

export interface Transform {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number; // radianes
  scale: number;
  flipX: boolean;
  flipY: boolean;
}

export interface Crop {
  /** fracciones 0..1 del bitmap original */
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ItemBase extends Transform {
  id: ItemId;
  kind: ItemKind;
  name: string;
  parentId: ItemId | null;
  /** orden de dibujo dentro de su nivel (mayor = encima) */
  z: number;
  locked: boolean;
  visible: boolean;
  opacity: number; // 0..1
  /** comentario/nota adjunta (HTML sanitizado o texto plano) */
  comment: string;
  tags: string[];
  createdAt: number;
  /** última modificación (ms). Lo usa la sincronización para fusionar cambios entre dispositivos. */
  mtime?: number;
}

export interface ImageItem extends ItemBase {
  kind: 'image';
  /** clave del blob en IndexedDB */
  blobId: string;
  /** dimensiones del bitmap almacenado */
  naturalW: number;
  naturalH: number;
  crop: Crop | null;
  /** origen: nombre de archivo, URL o 'clipboard' */
  source: string;
  /** paleta dominante (hex) calculada al importar */
  palette: string[];
  /** hash perceptual opcional para detectar duplicados */
  phash?: string;
}

export type NoteAlign = 'left' | 'center' | 'right' | 'justify';

export interface NoteItem extends ItemBase {
  kind: 'note';
  /** texto plano; se soporta markdown ligero (negrita, listas, links) */
  text: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  background: string;
  align: NoteAlign;
  /** si es true, la altura sigue al contenido */
  autoHeight: boolean;
}

export type StrokeTool = 'pen' | 'line' | 'rect' | 'ellipse' | 'arrow';

export interface Stroke {
  tool: StrokeTool;
  color: string;
  width: number;
  /** puntos en coordenadas locales del ítem drawing; p = presión 0..1 */
  points: Array<{ x: number; y: number; p: number }>;
}

export interface DrawingItem extends ItemBase {
  kind: 'drawing';
  strokes: Stroke[];
}

export interface GroupItem extends ItemBase {
  kind: 'group';
  collapsed: boolean;
}

export type Item = ImageItem | NoteItem | DrawingItem | GroupItem;

export interface Viewport {
  /** desplazamiento del origen de escena en píxeles CSS */
  x: number;
  y: number;
  zoom: number;
}

export interface GridSettings {
  enabled: boolean;
  snap: boolean;
  size: number;
  color: string;
}

export interface SceneSettings {
  canvasColor: string; // 'transparent' o hex
  grid: GridSettings;
  alignPadding: number;
}

export interface Scene {
  id: string;
  version: 1;
  name: string;
  items: Item[];
  viewport: Viewport;
  settings: SceneSettings;
  createdAt: number;
  updatedAt: number;
  /** ítems borrados: id → momento del borrado (ms). Permite propagar borrados al sincronizar. */
  tombstones?: Record<ItemId, number>;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Fábricas

export function uid(prefix = 'i'): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}${r}`;
}

export function defaultSettings(): SceneSettings {
  return {
    canvasColor: '#1e1e1e',
    grid: { enabled: false, snap: false, size: 64, color: '#3a3a3a' },
    alignPadding: 8
  };
}

export function createScene(name = 'Sin título'): Scene {
  const now = Date.now();
  return {
    id: uid('s'),
    version: 1,
    name,
    items: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: defaultSettings(),
    createdAt: now,
    updatedAt: now,
    tombstones: {}
  };
}

function baseItem(kind: ItemKind, name: string, t: Partial<Transform> = {}): ItemBase {
  return {
    id: uid(),
    kind,
    name,
    parentId: null,
    z: 0,
    locked: false,
    visible: true,
    opacity: 1,
    comment: '',
    tags: [],
    createdAt: Date.now(),
    mtime: Date.now(),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    rotation: 0,
    scale: 1,
    flipX: false,
    flipY: false,
    ...t
  };
}

export function createImageItem(
  blobId: string,
  naturalW: number,
  naturalH: number,
  opts: Partial<ImageItem> = {}
): ImageItem {
  return {
    ...baseItem('image', opts.name ?? 'Imagen', { w: naturalW, h: naturalH }),
    kind: 'image',
    blobId,
    naturalW,
    naturalH,
    crop: null,
    source: '',
    palette: [],
    ...opts
  } as ImageItem;
}

export function createNoteItem(text = '', opts: Partial<NoteItem> = {}): NoteItem {
  return {
    ...baseItem('note', opts.name ?? 'Nota', { w: 240, h: 120 }),
    kind: 'note',
    text,
    fontSize: 18,
    fontFamily: 'system-ui',
    color: '#f2f2f2',
    background: '#2b2b2bcc',
    align: 'left',
    autoHeight: true,
    ...opts
  } as NoteItem;
}

export function createDrawingItem(opts: Partial<DrawingItem> = {}): DrawingItem {
  return {
    ...baseItem('drawing', opts.name ?? 'Dibujo', { w: 1, h: 1 }),
    kind: 'drawing',
    strokes: [],
    ...opts
  } as DrawingItem;
}

export function createGroupItem(opts: Partial<GroupItem> = {}): GroupItem {
  return {
    ...baseItem('group', opts.name ?? 'Grupo'),
    kind: 'group',
    collapsed: false,
    ...opts
  } as GroupItem;
}

// ---------------------------------------------------------------------------
// Geometría

/** Tamaño efectivo (con escala y recorte) en unidades de escena. */
export function effectiveSize(it: Item): { w: number; h: number } {
  let w = it.w;
  let h = it.h;
  if (it.kind === 'image' && it.crop) {
    w = it.w * (1 - it.crop.left - it.crop.right);
    h = it.h * (1 - it.crop.top - it.crop.bottom);
  }
  return { w: w * it.scale, h: h * it.scale };
}

/** Caja alineada a ejes que contiene al ítem (considera rotación). */
export function itemBounds(it: Item): Rect {
  const { w, h } = effectiveSize(it);
  const c = Math.abs(Math.cos(it.rotation));
  const s = Math.abs(Math.sin(it.rotation));
  const bw = w * c + h * s;
  const bh = w * s + h * c;
  return { x: it.x - bw / 2, y: it.y - bh / 2, w: bw, h: bh };
}

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Convierte un punto de escena a coordenadas locales del ítem (centro = 0,0, sin escala). */
export function sceneToLocal(it: Item, p: Point): Point {
  const dx = p.x - it.x;
  const dy = p.y - it.y;
  const c = Math.cos(-it.rotation);
  const s = Math.sin(-it.rotation);
  let lx = (dx * c - dy * s) / it.scale;
  let ly = (dx * s + dy * c) / it.scale;
  if (it.flipX) lx = -lx;
  if (it.flipY) ly = -ly;
  return { x: lx, y: ly };
}

export function localToScene(it: Item, p: Point): Point {
  let lx = it.flipX ? -p.x : p.x;
  let ly = it.flipY ? -p.y : p.y;
  lx *= it.scale;
  ly *= it.scale;
  const c = Math.cos(it.rotation);
  const s = Math.sin(it.rotation);
  return { x: it.x + lx * c - ly * s, y: it.y + lx * s + ly * c };
}

/** Prueba de impacto precisa (rectángulo rotado). */
export function hitTest(it: Item, p: Point): boolean {
  const l = sceneToLocal(it, p);
  let w = it.w, h = it.h;
  if (it.kind === 'image' && it.crop) {
    w = it.w * (1 - it.crop.left - it.crop.right);
    h = it.h * (1 - it.crop.top - it.crop.bottom);
  }
  return Math.abs(l.x) <= w / 2 && Math.abs(l.y) <= h / 2;
}

// ---------------------------------------------------------------------------
// Jerarquía

export function childrenOf(scene: Scene, id: ItemId | null): Item[] {
  return scene.items.filter((i) => i.parentId === id).sort((a, b) => a.z - b.z);
}

export function descendantsOf(scene: Scene, id: ItemId): Item[] {
  const out: Item[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of scene.items) {
      if (c.parentId === cur) {
        out.push(c);
        stack.push(c.id);
      }
    }
  }
  return out;
}

export function findItem(scene: Scene, id: ItemId): Item | undefined {
  return scene.items.find((i) => i.id === id);
}

export function isAncestor(scene: Scene, maybeAncestor: ItemId, of: ItemId): boolean {
  let cur = findItem(scene, of);
  while (cur && cur.parentId) {
    if (cur.parentId === maybeAncestor) return true;
    cur = findItem(scene, cur.parentId);
  }
  return false;
}

/** Orden de pintado: recorrido en profundidad respetando z por nivel. */
export function paintOrder(scene: Scene): Item[] {
  const out: Item[] = [];
  const visit = (parent: ItemId | null) => {
    for (const c of childrenOf(scene, parent)) {
      out.push(c);
      visit(c.id);
    }
  };
  visit(null);
  return out;
}

/**
 * Orden de renderizado: primero imágenes (y grupos), después notas y dibujos,
 * cada bloque en orden de pintado. Así las anotaciones nunca quedan tapadas
 * por una imagen hermana.
 */
export function renderOrder(scene: Scene): Item[] {
  const order = paintOrder(scene);
  const base = order.filter((i) => i.kind === 'image' || i.kind === 'group');
  const overlay = order.filter((i) => i.kind === 'note' || i.kind === 'drawing');
  return [...base, ...overlay];
}

/** Caja que contiene un ítem y todos sus descendientes visibles. */
export function subtreeBounds(scene: Scene, id: ItemId): Rect | null {
  const it = findItem(scene, id);
  if (!it) return null;
  const rects: Rect[] = [];
  if (it.kind !== 'group') rects.push(itemBounds(it));
  for (const d of descendantsOf(scene, id)) {
    if (d.kind !== 'group' && d.visible) rects.push(itemBounds(d));
  }
  return unionRects(rects);
}

export function sceneBounds(scene: Scene): Rect | null {
  return unionRects(scene.items.filter((i) => i.kind !== 'group' && i.visible).map(itemBounds));
}

export function nextZ(scene: Scene, parentId: ItemId | null): number {
  let z = 0;
  for (const i of scene.items) if (i.parentId === parentId) z = Math.max(z, i.z + 1);
  return z;
}
