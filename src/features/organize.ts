/**
 * Disposición de un tablero por categorías: cada categoría se empaqueta como un
 * bloque compacto (`arrangeOptimal`) y los bloques se reparten a su vez con el
 * mismo algoritmo, dejando sitio para un título encima de cada uno.
 *
 * Módulo PURO, igual que `arrange.ts`: no toca el store. Devuelve las nuevas
 * posiciones de las imágenes y la caja final de cada categoría para que el
 * llamador cree los grupos y los títulos dentro de una sola transacción.
 */
import { createGroupItem, itemBounds, unionRects, type Item, type ItemId, type Rect } from '../core/model';
import { arrangeOptimal, type Placement } from './arrange';

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
  /** Nuevas posiciones (centro) de cada imagen. */
  placements: Placement[];
  /** Categorías con al menos una imagen, en el orden recibido. */
  clusters: PlacedCluster[];
}

export interface OrganizeOptions {
  /** Separación entre imágenes dentro de una categoría. */
  padding: number;
  /** Separación entre categorías. */
  gap: number;
  /** Alto reservado sobre cada categoría para su título. */
  titleHeight: number;
  /** Proporción ancho/alto de la vista, para repartir las categorías. */
  aspect: number;
}

/** Caja de un ítem si su centro estuviera en `(x, y)`. */
function boundsAt(it: Item, x: number, y: number): Rect {
  return itemBounds({ ...it, x, y });
}

/**
 * Calcula la disposición por categorías.
 *
 * @param items    ítems disponibles (se ignoran los ids que no estén aquí).
 * @param clusters categorías con sus ids; las vacías se descartan.
 */
export function layoutByCategory(items: Item[], clusters: CategoryCluster[], opts: OrganizeOptions): OrganizeLayout {
  const byId = new Map(items.map((i) => [i.id, i]));
  const padding = Math.max(0, opts.padding);
  const gap = Math.max(padding, opts.gap);
  const titleHeight = Math.max(0, opts.titleHeight);

  // 1. cada categoría por separado, como bloque compacto
  const blocks: { cluster: CategoryCluster; placements: Placement[]; content: Rect }[] = [];
  for (const c of clusters) {
    const members = c.ids.map((id) => byId.get(id)).filter((i): i is Item => !!i);
    if (!members.length) continue;
    const pl = members.length === 1 ? [{ id: members[0]!.id, x: members[0]!.x, y: members[0]!.y }] : arrangeOptimal(members, { padding, aspect: 1.25 });
    const content = unionRects(pl.map((p) => boundsAt(byId.get(p.id)!, p.x, p.y)));
    if (!content) continue;
    blocks.push({ cluster: { title: c.title, ids: members.map((m) => m.id) }, placements: pl, content });
  }
  if (!blocks.length) return { placements: [], clusters: [] };

  // 2. los bloques (con el hueco del título) se reparten entre sí
  const proxies = blocks.map((b, i) => {
    const w = b.content.w;
    const h = b.content.h + titleHeight;
    return createGroupItem({ id: `cluster-${i}`, x: b.content.x + w / 2, y: b.content.y - titleHeight + h / 2, w, h });
  });
  const outer = blocks.length === 1 ? [{ id: proxies[0]!.id, x: proxies[0]!.x, y: proxies[0]!.y }] : arrangeOptimal(proxies, { padding: gap, aspect: opts.aspect });

  // 3. trasladar cada bloque a su nueva posición
  const placements: Placement[] = [];
  const placed: PlacedCluster[] = [];
  blocks.forEach((b, i) => {
    const proxy = proxies[i]!;
    const target = outer.find((p) => p.id === proxy.id) ?? { x: proxy.x, y: proxy.y };
    const dx = target.x - proxy.x;
    const dy = target.y - proxy.y;
    for (const p of b.placements) placements.push({ id: p.id, x: p.x + dx, y: p.y + dy });
    const content = { x: b.content.x + dx, y: b.content.y + dy, w: b.content.w, h: b.content.h };
    placed.push({
      ...b.cluster,
      content,
      rect: { x: content.x, y: content.y - titleHeight, w: content.w, h: content.h + titleHeight }
    });
  });
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
