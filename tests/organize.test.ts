/**
 * Pruebas de la disposición por categorías (src/features/organize.ts): cada
 * categoría queda como un bloque compacto, los bloques no se solapan, todos
 * los ítems reciben posición y el hueco del título queda sobre cada bloque.
 */
import { describe, expect, it } from 'vitest';
import { createImageItem, itemBounds, unionRects, type ImageItem, type Rect } from '../src/core/model';
import { clustersFromAssignments, layoutByCategory, shareColumns } from '../src/features/organize';

function img(id: string, w: number, h: number, x = 0, y = 0): ImageItem {
  return createImageItem('b', w, h, { id, name: id, x, y });
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const OPTS = { padding: 10, gap: 60, titleHeight: 80, aspect: 1.5 };

/** Caja de un ítem ya colocado, aplicando la escala que trae el collage. */
function boxOf(it: ImageItem, pl: { x: number; y: number; scale?: number }): Rect {
  return itemBounds({ ...it, x: pl.x, y: pl.y, scale: pl.scale ?? it.scale });
}

describe('layoutByCategory', () => {
  const items = [
    img('a', 300, 200, 0, 0),
    img('b', 200, 300, 50, 50),
    img('c', 250, 250, 100, 100),
    img('d', 400, 200, 150, 150),
    img('e', 200, 200, 200, 200)
  ];
  const clusters = [
    { title: 'Poses', ids: ['a', 'b'] },
    { title: 'Texturas', ids: ['c', 'd', 'e'] },
    { title: 'Vacía', ids: [] },
    { title: 'Fantasma', ids: ['zzz'] }
  ];
  const byId = new Map(items.map((i) => [i.id, i]));
  const placementOf = (out: ReturnType<typeof layoutByCategory>, id: string) => out.placements.find((p) => p.id === id)!;

  it('deja los bloques de alto parejo: ninguno pasa de 1,4 veces el más bajo', () => {
    const out = layoutByCategory(items, clusters, OPTS);
    const alturas = out.clusters.map((c) => c.content.h);
    expect(Math.max(...alturas)).toBeLessThanOrEqual(Math.min(...alturas) * 1.4);
  });

  it('coloca todos los ítems y descarta las categorías vacías o sin ítems conocidos', () => {
    const out = layoutByCategory(items, clusters, OPTS);
    expect(out.placements.map((p) => p.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(out.clusters.map((c) => c.title)).toEqual(['Poses', 'Texturas']);
  });

  it('iguala el ancho de todas las imágenes: eso es lo que da el aire de collage', () => {
    const out = layoutByCategory(items, clusters, OPTS);
    const widths = out.placements.map((p) => boxOf(byId.get(p.id)!, p).w);
    for (const w of widths) expect(w).toBeCloseTo(widths[0]!, 6);
    // y cada una conserva su proporción
    for (const p of out.placements) {
      const it = byId.get(p.id)!;
      const b = boxOf(it, p);
      expect(b.h / b.w).toBeCloseTo(it.h / it.w, 6);
    }
  });

  it('ninguna imagen se solapa con otra, ni dentro ni entre categorías', () => {
    const out = layoutByCategory(items, clusters, OPTS);
    const boxes = out.placements.map((p) => boxOf(byId.get(p.id)!, p));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
    }
  });

  it('las categorías ocupan franjas horizontales separadas', () => {
    const out = layoutByCategory(items, clusters, OPTS);
    const [p, q] = out.clusters;
    expect(overlaps(p!.rect, q!.rect)).toBe(false);
    expect(q!.rect.x).toBeGreaterThanOrEqual(p!.rect.x + p!.rect.w);
  });

  it('cada imagen queda dentro de la caja de contenido de su categoría, bajo el título', () => {
    const out = layoutByCategory(items, clusters, OPTS);
    for (const c of out.clusters) {
      expect(c.rect.h).toBeCloseTo(c.content.h + OPTS.titleHeight, 6);
      expect(c.content.y).toBeCloseTo(c.rect.y + OPTS.titleHeight, 6);
      const u = unionRects(c.ids.map((id) => boxOf(byId.get(id)!, placementOf(out, id))))!;
      expect(u.x).toBeGreaterThanOrEqual(c.content.x - 1e-6);
      expect(u.y).toBeGreaterThanOrEqual(c.content.y - 1e-6);
      expect(u.x + u.w).toBeLessThanOrEqual(c.content.x + c.content.w + 1e-6);
      expect(u.y + u.h).toBeLessThanOrEqual(c.content.y + c.content.h + 1e-6);
    }
  });

  it('sin títulos el bloque empieza justo en las imágenes', () => {
    const out = layoutByCategory(items, clusters, { ...OPTS, titleHeight: 0 });
    for (const c of out.clusters) {
      expect(c.rect.y).toBeCloseTo(c.content.y, 6);
      expect(c.rect.h).toBeCloseTo(c.content.h, 6);
    }
  });

  it('una sola categoría con un solo ítem lo lleva al ancho de columna', () => {
    const solo = img('solo', 100, 200, 42, 43);
    const out = layoutByCategory([solo], [{ title: 'Uno', ids: ['solo'] }], { ...OPTS, titleHeight: 0 });
    expect(out.placements).toHaveLength(1);
    const b = boxOf(solo, out.placements[0]!);
    expect(b.w).toBeCloseTo(100, 6); // única imagen: su propio ancho es la mediana
    expect(out.clusters[0]!.rect).toEqual({ x: 0, y: 0, w: 100, h: 200 });
  });

  it('sin ítems devuelve vacío', () => {
    expect(layoutByCategory([], clusters, OPTS)).toEqual({ placements: [], clusters: [] });
  });
});

describe('shareColumns', () => {
  it('reparte en proporción al peso y la suma cuadra', () => {
    const out = shareColumns([300, 100], 8);
    expect(out.reduce((a, b) => a + b, 0)).toBe(8);
    expect(out[0]).toBeGreaterThan(out[1]!);
  });

  it('da al menos una columna a cada categoría aunque pese poco', () => {
    expect(shareColumns([1000, 1], 3)).toEqual([2, 1]);
    expect(shareColumns([1000, 1, 1], 3)).toEqual([1, 1, 1]);
  });

  it('nunca devuelve menos columnas que categorías', () => {
    expect(shareColumns([5, 5, 5], 1)).toEqual([1, 1, 1]);
  });

  it('equilibra: la categoría más pesada recibe las columnas que sobran', () => {
    // dos categorías, una el triple de alta: con 4 columnas le tocan 3
    expect(shareColumns([300, 100], 4)).toEqual([3, 1]);
  });

  it('con pesos cero reparte parejo', () => {
    expect(shareColumns([0, 0], 4)).toEqual([2, 2]);
    expect(shareColumns([], 4)).toEqual([]);
  });
});

describe('clustersFromAssignments', () => {
  it('respeta el orden dado y añade al final las categorías no listadas', () => {
    const out = clustersFromAssignments({ a: 'Ropa', b: 'Poses', c: 'Otros', d: 'Poses' }, ['Poses', 'Texturas', 'Ropa']);
    expect(out).toEqual([
      { title: 'Poses', ids: ['b', 'd'] },
      { title: 'Ropa', ids: ['a'] },
      { title: 'Otros', ids: ['c'] }
    ]);
  });
});
