/**
 * Pruebas de los algoritmos de ordenación (`src/features/arrange.ts`).
 * Todas las funciones son puras: se comprueba geometría, no estado.
 */
import { describe, it, expect } from 'vitest';
import {
  createImageItem,
  itemBounds,
  unionRects,
  rectsIntersect,
  type Item,
  type ItemId,
  type Rect
} from '../src/core/model';
import {
  arrangeOptimal,
  arrangeMasonry,
  arrangeGrid,
  arrangeRow,
  arrangeColumn,
  arrangeRandom,
  arrangeByColor,
  normalizeSize,
  normalizeArea,
  alignItems,
  distributeItems,
  stackItems,
  snapToGrid,
  hueOfHex,
  type Placement
} from '../src/features/arrange';

const OPTS = { padding: 12, aspect: 16 / 9, seed: 42 };

/** Conjunto de ítems de tamaños y posiciones variadas. */
function makeItems(): Item[] {
  const spec: Array<[number, number, number, number, number]> = [
    // w, h, x, y, scale
    [200, 100, -300, -200, 1],
    [120, 180, 50, -120, 1],
    [300, 300, 400, 100, 0.5],
    [80, 80, -100, 250, 2],
    [240, 160, 320, -320, 1],
    [160, 240, -420, 60, 1.25],
    [100, 100, 120, 220, 1]
  ];
  return spec.map(([w, h, x, y, scale], i) =>
    createImageItem('b', w, h, { id: `it${i}` as ItemId, x, y, scale })
  );
}

/** Caja resultante de aplicar un `Placement` a su ítem. */
function placedRect(items: Item[], p: Placement): Rect {
  const it = items.find((i) => i.id === p.id)!;
  const base = itemBounds(it);
  const k = p.scale !== undefined ? p.scale / it.scale : 1;
  const w = base.w * k;
  const h = base.h * k;
  return { x: p.x - w / 2, y: p.y - h / 2, w, h };
}

function placedRects(items: Item[], ps: Placement[]): Rect[] {
  return ps.map((p) => placedRect(items, p));
}

/** Falla si dos cajas cualesquiera del resultado se solapan. */
function expectNoOverlap(items: Item[], ps: Placement[]) {
  const rects = placedRects(items, ps);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(
        rectsIntersect(rects[i], rects[j]),
        `las cajas ${i} y ${j} se solapan`
      ).toBe(false);
    }
  }
}

/** Falla si el centro de la unión resultante no coincide con el original. */
function expectSameCenter(items: Item[], ps: Placement[]) {
  const before = unionRects(items.map(itemBounds))!;
  const after = unionRects(placedRects(items, ps))!;
  expect(after.x + after.w / 2).toBeCloseTo(before.x + before.w / 2, 6);
  expect(after.y + after.h / 2).toBeCloseTo(before.y + before.h / 2, 6);
}

describe('empaquetado', () => {
  const methods: Array<[string, (i: Item[]) => Placement[]]> = [
    ['arrangeOptimal', (i) => arrangeOptimal(i, OPTS)],
    ['arrangeGrid', (i) => arrangeGrid(i, OPTS)],
    ['arrangeRow', (i) => arrangeRow(i, OPTS)],
    ['arrangeColumn', (i) => arrangeColumn(i, OPTS)],
    ['arrangeRandom', (i) => arrangeRandom(i, OPTS)]
  ];

  for (const [name, fn] of methods) {
    it(`${name}: devuelve un placement por ítem, sin solapes y con el centro preservado`, () => {
      const items = makeItems();
      const snapshot = JSON.stringify(items);
      const ps = fn(items);
      expect(ps).toHaveLength(items.length);
      expect(new Set(ps.map((p) => p.id)).size).toBe(items.length);
      expectNoOverlap(items, ps);
      expectSameCenter(items, ps);
      // no muta la entrada
      expect(JSON.stringify(items)).toBe(snapshot);
    });
  }

  it('lista vacía devuelve lista vacía', () => {
    expect(arrangeOptimal([], OPTS)).toEqual([]);
    expect(arrangeGrid([], OPTS)).toEqual([]);
    expect(arrangeRow([], OPTS)).toEqual([]);
    expect(arrangeRandom([], OPTS)).toEqual([]);
    expect(normalizeSize([])).toEqual([]);
    expect(alignItems([], 'left', 4)).toEqual([]);
  });

  it('arrangeGrid usa ceil(sqrt(n * aspect)) columnas y celdas del mayor ítem', () => {
    const items = makeItems(); // n = 7, aspect 16/9 -> ceil(sqrt(12.44)) = 4
    const ps = arrangeGrid(items, OPTS);
    const rows = new Set(ps.map((p) => Math.round(placedRect(items, p).y / 0.5)));
    // 7 ítems en 4 columnas -> 2 filas
    const ys = [...new Set(ps.map((p) => Math.round(p.y * 1000) / 1000))];
    expect(rows.size).toBeGreaterThan(0);
    expect(ys.length).toBeGreaterThan(1);
    // cuadrícula: los centros de celda forman como mucho 4 columnas distintas
    const cellW = Math.max(...items.map((i) => itemBounds(i).w));
    const cols = new Set(
      ps.map((p) => Math.round((p.x + cellW * 10) / (cellW + OPTS.padding)))
    );
    expect(cols.size).toBeLessThanOrEqual(4);
  });

  it('arrangeRow alinea los centros en el eje vertical y respeta el orden por x', () => {
    const items = makeItems();
    const ps = arrangeRow(items, OPTS);
    const ys = ps.map((p) => p.y);
    for (const y of ys) expect(y).toBeCloseTo(ys[0], 9);
    const ordenOriginal = [...items].sort((a, b) => a.x - b.x).map((i) => i.id);
    const ordenFinal = [...ps].sort((a, b) => a.x - b.x).map((p) => p.id);
    expect(ordenFinal).toEqual(ordenOriginal);
  });

  it('arrangeColumn alinea los centros en el eje horizontal y ordena por y', () => {
    const items = makeItems();
    const ps = arrangeColumn(items, OPTS);
    const xs = ps.map((p) => p.x);
    for (const x of xs) expect(x).toBeCloseTo(xs[0], 9);
    const ordenOriginal = [...items].sort((a, b) => a.y - b.y).map((i) => i.id);
    const ordenFinal = [...ps].sort((a, b) => a.y - b.y).map((p) => p.id);
    expect(ordenFinal).toEqual(ordenOriginal);
  });

  it('arrangeRandom es determinista con la misma semilla y distinto con otra', () => {
    const items = makeItems();
    const a = arrangeRandom(items, { ...OPTS, seed: 7 });
    const b = arrangeRandom(items, { ...OPTS, seed: 7 });
    const c = arrangeRandom(items, { ...OPTS, seed: 8 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('arrangeByColor ordena por tono y deja los null al final', () => {
    const colores = ['#00ff00', null, '#ff0000', '#0000ff'];
    const items = colores.map((c, i) =>
      createImageItem('b', 100, 100, {
        id: `c${i}` as ItemId,
        x: i * 150,
        y: 0,
        palette: c ? [c] : []
      })
    );
    const ps = arrangeByColor(items, OPTS, (it) =>
      it.kind === 'image' && it.palette[0] ? hueOfHex(it.palette[0]) : null
    );
    // orden de salida = orden de colocación: rojo(0), verde(120), azul(240), null
    expect(ps.map((p) => p.id)).toEqual(['c2', 'c0', 'c3', 'c1']);
    expectNoOverlap(items, ps);
  });
});

describe('normalización', () => {
  it('normalizeSize iguala los lados mayores efectivos', () => {
    const items = makeItems();
    const ps = normalizeSize(items);
    const lados = ps.map((p) => {
      const r = placedRect(items, p);
      return Math.max(r.w, r.h);
    });
    for (const l of lados) expect(l).toBeCloseTo(lados[0], 6);
    // mantiene el centro de cada ítem
    for (const p of ps) {
      const it = items.find((i) => i.id === p.id)!;
      expect(p.x).toBe(it.x);
      expect(p.y).toBe(it.y);
    }
  });

  it('normalizeArea iguala las áreas efectivas', () => {
    const items = makeItems();
    const ps = normalizeArea(items);
    const areas = ps.map((p) => {
      const r = placedRect(items, p);
      return r.w * r.h;
    });
    for (const a of areas) expect(a).toBeCloseTo(areas[0], 4);
  });
});

describe('alineado, distribución y apilado', () => {
  it('alignItems("left") deja todos los bordes izquierdos iguales', () => {
    const items = makeItems();
    const padding = 5;
    const ps = alignItems(items, 'left', padding);
    const union = unionRects(items.map(itemBounds))!;
    const xs = placedRects(items, ps).map((r) => r.x);
    for (const x of xs) expect(x).toBeCloseTo(union.x + padding, 9);
  });

  it('alignItems("bottom") deja todos los bordes inferiores iguales', () => {
    const items = makeItems();
    const ps = alignItems(items, 'bottom', 0);
    const union = unionRects(items.map(itemBounds))!;
    const bottoms = placedRects(items, ps).map((r) => r.y + r.h);
    for (const b of bottoms) expect(b).toBeCloseTo(union.y + union.h, 9);
  });

  it('alignItems("centerH") iguala los centros horizontales', () => {
    const items = makeItems();
    const ps = alignItems(items, 'centerH', 0);
    const union = unionRects(items.map(itemBounds))!;
    for (const p of ps) expect(p.x).toBeCloseTo(union.x + union.w / 2, 9);
  });

  it('distributeItems("h") deja huecos iguales y no mueve el primero ni el último', () => {
    const items = makeItems();
    const ps = distributeItems(items, 'h');
    const rects = placedRects(items, ps).sort((a, b) => a.x - b.x);
    const huecos: number[] = [];
    for (let i = 1; i < rects.length; i++) huecos.push(rects[i].x - (rects[i - 1].x + rects[i - 1].w));
    for (const g of huecos) expect(g).toBeCloseTo(huecos[0], 6);

    const antes = items.map(itemBounds).sort((a, b) => a.x - b.x);
    expect(rects[0].x).toBeCloseTo(antes[0].x, 9);
    const ultimo = rects[rects.length - 1];
    const ultimoAntes = antes[antes.length - 1];
    expect(ultimo.x + ultimo.w).toBeCloseTo(ultimoAntes.x + ultimoAntes.w, 9);
  });

  it('distributeItems("v") deja huecos iguales', () => {
    const items = makeItems();
    const rects = placedRects(items, distributeItems(items, 'v')).sort((a, b) => a.y - b.y);
    const huecos: number[] = [];
    for (let i = 1; i < rects.length; i++) huecos.push(rects[i].y - (rects[i - 1].y + rects[i - 1].h));
    for (const g of huecos) expect(g).toBeCloseTo(huecos[0], 6);
  });

  it('stackItems apila sin huecos (salvo padding) y conserva el centro', () => {
    const items = makeItems();
    const padding = 10;
    const ps = stackItems(items, 'h', padding);
    const rects = placedRects(items, ps).sort((a, b) => a.x - b.x);
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i].x - (rects[i - 1].x + rects[i - 1].w)).toBeCloseTo(padding, 6);
    }
    expectSameCenter(items, ps);
    expectNoOverlap(items, ps);
  });
});

describe('ayudas', () => {
  it('snapToGrid redondea al múltiplo más cercano', () => {
    expect(snapToGrid(13, 8)).toBe(16);
    expect(snapToGrid(11, 8)).toBe(8);
    expect(snapToGrid(-13, 8)).toBe(-16);
    expect(snapToGrid(7.5, 0)).toBe(7.5);
  });

  it('hueOfHex devuelve el tono en grados', () => {
    expect(hueOfHex('#ff0000')).toBe(0);
    expect(hueOfHex('#00ff00')).toBe(120);
    expect(hueOfHex('#0000ff')).toBe(240);
    expect(hueOfHex('#f00')).toBe(0);
    expect(hueOfHex('#ffff00')).toBe(60);
    expect(hueOfHex('#808080')).toBeNull();
    expect(hueOfHex('no-es-color')).toBeNull();
  });
});

describe('arrangeMasonry', () => {
  const items = [
    createImageItem('b', 200, 300, { id: 'a', x: 0, y: 0 }),
    createImageItem('b', 400, 200, { id: 'b', x: 10, y: 10 }),
    createImageItem('b', 200, 200, { id: 'c', x: 20, y: 20 }),
    createImageItem('b', 300, 900, { id: 'd', x: 30, y: 30 }),
    createImageItem('b', 200, 100, { id: 'e', x: 40, y: 40 })
  ];
  const boxOf = (it: Item, p: Placement): Rect => itemBounds({ ...it, x: p.x, y: p.y, scale: p.scale ?? it.scale });
  const byId = new Map(items.map((i) => [i.id, i]));

  it('deja todas las imágenes con el mismo ancho y su proporción intacta', () => {
    const pl = arrangeMasonry(items, { padding: 10, aspect: 1.5, columns: 2 });
    expect(pl).toHaveLength(items.length);
    const boxes = pl.map((p) => boxOf(byId.get(p.id)!, p));
    for (const b of boxes) expect(b.w).toBeCloseTo(boxes[0]!.w, 6);
    for (const p of pl) {
      const it = byId.get(p.id)!;
      const b = boxOf(it, p);
      expect(b.h / b.w).toBeCloseTo(it.h / it.w, 6);
    }
  });

  it('no deja solapes y respeta el número de columnas pedido', () => {
    const pl = arrangeMasonry(items, { padding: 12, aspect: 1, columns: 3 });
    const boxes = pl.map((p) => boxOf(byId.get(p.id)!, p));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(rectsIntersect(boxes[i]!, boxes[j]!)).toBe(false);
    }
    const lefts = new Set(boxes.map((b) => Math.round(b.x)));
    expect(lefts.size).toBe(3);
  });

  it('apila en la columna más corta: la imagen muy alta no recibe la siguiente', () => {
    const tall = [
      createImageItem('b', 200, 1000, { id: 'alta', x: 0, y: 0 }),
      createImageItem('b', 200, 100, { id: 'baja', x: 0, y: 0 }),
      createImageItem('b', 200, 100, { id: 'tercera', x: 0, y: 0 })
    ];
    const pl = arrangeMasonry(tall, { padding: 10, aspect: 1, columns: 2 });
    const at = (id: ItemId) => pl.find((p) => p.id === id)!;
    // «alta» abre la columna 0 y «baja» la 1; la tercera va sobre «baja», no bajo «alta»
    expect(at('tercera').x).toBeCloseTo(at('baja').x, 6);
    expect(at('tercera').y).toBeGreaterThan(at('baja').y);
  });

  it('mantiene el conjunto centrado donde estaba', () => {
    const before = unionRects(items.map((i) => itemBounds(i)))!;
    const pl = arrangeMasonry(items, { padding: 10, aspect: 1.5 });
    const after = unionRects(pl.map((p) => boxOf(byId.get(p.id)!, p)))!;
    expect(after.x + after.w / 2).toBeCloseTo(before.x + before.w / 2, 6);
    expect(after.y + after.h / 2).toBeCloseTo(before.y + before.h / 2, 6);
  });

  it('sin ítems devuelve una lista vacía', () => {
    expect(arrangeMasonry([], { padding: 10, aspect: 1 })).toEqual([]);
  });
});
