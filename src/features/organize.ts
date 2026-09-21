/**
 * Disposición de un tablero por categorías, en collage de columnas verticales.
 *
 * Las imágenes pasan al ancho de una columna —dos, si son apaisadas— y se
 * apilan en la columna más corta (`masonryBoxes`), así que el tablero queda
 * como un collage continuo con variedad de tamaños. Cada categoría ocupa un tramo de columnas contiguas, en proporción
 * a lo que abulta, y los tramos se ponen uno al lado del otro compartiendo el
 * borde superior.
 *
 * Módulo PURO, igual que `arrange.ts`: no toca el store. Devuelve las nuevas
 * posiciones (y escalas) de las imágenes y la caja final de cada categoría
 * para que el llamador cree los grupos dentro de una sola transacción.
 */
import { itemBounds, type Item, type ItemId, type Rect } from '../core/model';
import { columnSpan, defaultColumnWidth, masonryBoxes, type Placement } from './arrange';

/** Una categoría con los ítems que le tocan. */
export interface CategoryCluster {
  title: string;
  ids: ItemId[];
}

/** Caja final de una categoría, ya con el hueco del título incluido. */
export interface PlacedCluster extends CategoryCluster {
  rect: Rect;
  /** Caja que ocupan sólo las imágenes (sin el título). */
  content: Rect;
}

export interface OrganizeLayout {
  /** Nuevas posiciones (centro) y escalas de cada imagen. */
  placements: Placement[];
  /** Categorías con al menos una imagen, en el orden recibido. */
  clusters: PlacedCluster[];
}

export interface OrganizeOptions {
  /** Separación entre imágenes y entre columnas. */
  padding: number;
  /** Separación entre categorías. */
  gap: number;
  /** Alto reservado sobre cada categoría para su título (0 si no lleva). */
  titleHeight: number;
  /** Proporción ancho/alto de la vista, para repartir las columnas. */
  aspect: number;
  /** Ancho de columna; por defecto, la mediana de los anchos actuales. */
  columnWidth?: number;
  /**
   * Aire entre imágenes como fracción del ancho de columna (ver
   * `MasonryOptions.air`). Un tablero no se llena de imágenes pegadas: cuánto
   * respira es parte del gusto de cada quien, así que se elige al organizar.
   */
  air?: number;
}

/** Desequilibrio de alto tolerado entre categorías antes de añadir columnas. */
const COLUMN_BALANCE = 1.35;

/**
 * Reparte `total` columnas entre categorías, al menos una a cada una.
 *
 * Asigna las que sobran de a una, siempre a la categoría cuya columna quedaría
 * más alta (`peso / columnas`), que es lo que deja los bloques parejos.
 */
export function shareColumns(weights: number[], total: number): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const columns = Math.max(n, Math.round(total) || n);
  const out = new Array<number>(n).fill(1);
  const w = weights.map((v) => Math.max(0, v));
  if (w.reduce((a, b) => a + b, 0) <= 0) {
    // sin pesos útiles: reparto parejo
    for (let i = 0; i < columns - n; i++) out[i % n]! += 1;
    return out;
  }
  for (let left = columns - n; left > 0; left--) {
    let best = 0;
    for (let i = 1; i < n; i++) if (w[i]! / out[i]! > w[best]! / out[best]!) best = i;
    out[best]! += 1;
  }
  return out;
}

/**
 * Columnas por categoría: parte de las que pide la proporción de la vista y
 * añade alguna más mientras un bloque quede mucho más alto que otro, para que
 * el collage no termine con un borde inferior muy desparejo.
 */
function columnsPerCategory(weights: number[], wanted: number, maxTotal: number): number[] {
  const n = weights.length;
  let total = Math.max(n, Math.min(maxTotal, wanted));
  let out = shareColumns(weights, total);
  const cap = Math.min(maxTotal, total + n);
  while (total < cap) {
    const heights = weights.map((w, i) => Math.max(0, w) / out[i]!);
    const max = Math.max(...heights);
    const min = Math.min(...heights);
    if (min <= 0 || max <= min * COLUMN_BALANCE) break;
    total += 1;
    out = shareColumns(weights, total);
  }
  return out;
}

/**
 * Calcula la disposición por categorías.
 *
 * @param items    ítems disponibles (se ignoran los ids que no estén aquí).
 * @param clusters categorías con sus ids; las vacías se descartan.
 */
export function layoutByCategory(items: Item[], clusters: CategoryCluster[], opts: OrganizeOptions): OrganizeLayout {
  const byId = new Map(items.map((i) => [i.id, i]));
  const titleHeight = Math.max(0, opts.titleHeight);

  // 1. categorías con ítems reales, en el orden recibido
  const groups: { cluster: CategoryCluster; members: Item[] }[] = [];
  for (const c of clusters) {
    const members = c.ids.map((id) => byId.get(id)).filter((i): i is Item => !!i);
    if (members.length) groups.push({ cluster: { title: c.title, ids: members.map((m) => m.id) }, members });
  }
  if (!groups.length) return { placements: [], clusters: [] };

  // 2. un único ancho de columna para todo el tablero: es lo que le da al
  //    resultado el aire de collage en vez de bloques sueltos
  const all = groups.flatMap((g) => g.members);
  const colW = opts.columnWidth && opts.columnWidth > 0 ? opts.columnWidth : defaultColumnWidth(all);
  if (colW <= 0) return { placements: [], clusters: [] };
  // el aire se mide contra la columna, así que el tablero respira igual con
  // imágenes grandes o chicas
  const padding = Math.max(Math.max(0, opts.padding), colW * Math.max(0, opts.air ?? 0));
  const gap = Math.max(padding, opts.gap);

  // 3. columnas totales para la proporción de la vista, repartidas por peso.
  //    El peso es el largo de columna que consume cada categoría: una imagen
  //    apaisada ocupa dos columnas, así que cuenta doble.
  const heightOf = (members: Item[]) =>
    members.reduce((acc, it) => {
      const b = itemBounds(it);
      if (b.w <= 0) return acc;
      const span = columnSpan(b, 2, true);
      const w = span * colW + (span - 1) * padding;
      return acc + b.h * (w / b.w) * span;
    }, 0);
  const weights = groups.map((g) => heightOf(g.members));
  const totalH = weights.reduce((a, b) => a + b, 0);
  const aspect = Number.isFinite(opts.aspect) && opts.aspect > 0 ? opts.aspect : 1;
  const wanted = Math.round(Math.sqrt((aspect * totalH) / colW)) || 1;
  const perGroup = columnsPerCategory(weights, wanted, all.length);

  // 4. cada categoría en su tramo de columnas, todas alineadas arriba
  const placements: Placement[] = [];
  const placed: PlacedCluster[] = [];
  let x = 0;
  groups.forEach((g, i) => {
    const columns = perGroup[i]!;
    const { boxes, w, h } = masonryBoxes(g.members, { padding, columns, columnWidth: colW, spanWide: true });
    if (!boxes.length) return;
    const top = titleHeight;
    for (const b of boxes) {
      placements.push({ id: b.id, x: x + b.left + b.w / 2, y: top + b.top + b.h / 2, scale: b.scale });
    }
    const content = { x, y: top, w, h };
    placed.push({
      ...g.cluster,
      content,
      rect: { x, y: 0, w, h: h + titleHeight }
    });
    x += w + gap;
  });
  if (!placed.length) return { placements: [], clusters: [] };
  return { placements, clusters: placed };
}

/**
 * Convierte `{ id: categoría }` en clusters ordenados según `order` (las
 * categorías que no estén en `order` van después, por orden de aparición).
 */
export function clustersFromAssignments(assignments: Record<ItemId, string>, order: string[] = []): CategoryCluster[] {
  const map = new Map<string, ItemId[]>();
  for (const c of order) map.set(c, []);
  for (const [id, cat] of Object.entries(assignments)) {
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(id);
  }
  return [...map.entries()].filter(([, ids]) => ids.length).map(([title, ids]) => ({ title, ids }));
}
