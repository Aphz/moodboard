/**
 * Pruebas de la disposición por categorías (src/features/organize.ts): cada
 * categoría queda como un bloque compacto, los bloques no se solapan, todos
 * los ítems reciben posición y el hueco del título queda sobre cada bloque.
 */
import { describe, expect, it } from 'vitest';
import { createImageItem, itemBounds, unionRects, type ImageItem, type Rect } from '../src/core/model';
import { clustersFromAssignments, layoutByCategory } from '../src/features/organize';

function img(id: string, w: number, h: number, x = 0, y = 0): ImageItem {
  return createImageItem('b', w, h, { id, name: id, x, y });
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const OPTS = { padding: 10, gap: 60, titleHeight: 80, aspect: 1.5 };

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

  it('coloca todos los ítems y descarta las categorías vacías o sin ítems conocidos', () => {
    const out = layoutByCategory(items, clusters, OPTS);
    expect(out.placements.map((p) => p.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(out.clusters.map((c) => c.title)).toEqual(['Poses', 'Texturas']);
  });

  it('los bloques no se solapan entre sí ni las imágenes dentro de un bloque', () => {
    const out = layoutByCategory(items, clusters, OPTS);
    const [p, q] = out.clusters;
    expect(overlaps(p!.rect, q!.rect)).toBe(false);
    const byId = new Map(items.map((i) => [i.id, i]));
    const boxes = out.placements.map((pl) => itemBounds({ ...byId.get(pl.id)!, x: pl.x, y: pl.y }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
  });

  it('cada imagen queda dentro de la caja de contenido de su categoría, bajo el título', () => {
    const out = layoutByCategory(items, clusters, OPTS);
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const c of out.clusters) {
      expect(c.rect.h).toBeCloseTo(c.content.h + OPTS.titleHeight, 6);
      expect(c.rect.y).toBeCloseTo(c.content.y - OPTS.titleHeight, 6);
      const boxes = c.ids.map((id) => {
        const pl = out.placements.find((p) => p.id === id)!;
        return itemBounds({ ...byId.get(id)!, x: pl.x, y: pl.y });
      });
      const u = unionRects(boxes)!;
      expect(u.x).toBeGreaterThanOrEqual(c.content.x - 1e-6);
      expect(u.y).toBeGreaterThanOrEqual(c.content.y - 1e-6);
      expect(u.x + u.w).toBeLessThanOrEqual(c.content.x + c.content.w + 1e-6);
      expect(u.y + u.h).toBeLessThanOrEqual(c.content.y + c.content.h + 1e-6);
    }
  });

  it('una sola categoría con un solo ítem no lo mueve', () => {
    const out = layoutByCategory([img('solo', 100, 100, 42, 43)], [{ title: 'Uno', ids: ['solo'] }], OPTS);
    expect(out.placements).toEqual([{ id: 'solo', x: 42, y: 43 }]);
    expect(out.clusters[0]!.rect).toEqual({ x: -8, y: -7 - 80, w: 100, h: 180 });
  });

  it('sin ítems devuelve vacío', () => {
    expect(layoutByCategory([], clusters, OPTS)).toEqual({ placements: [], clusters: [] });
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
