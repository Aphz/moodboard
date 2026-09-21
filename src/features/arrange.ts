/**
 * Algoritmos de ordenación automática de ítems (tipo PureRef).
 *
 * Todas las funciones de este módulo son PURAS: reciben los ítems
 * seleccionados (los "roots" de la selección) y devuelven una lista de
 * `Placement` con las NUEVAS posiciones de CENTRO (y, cuando aplica, una
 * nueva `scale`). No mutan la entrada ni tocan el store; el llamador aplica
 * el resultado dentro de `store.commit(() => store.update(...))`.
 *
 * La caja de cada ítem es siempre `itemBounds(it)`, es decir la caja alineada
 * a ejes que ya tiene en cuenta escala, recorte y rotación.
 *
 * Salvo que se indique lo contrario, el conjunto resultante queda centrado en
 * el mismo centro que la unión de las cajas originales, de modo que el
 * reordenado no "salta" en el lienzo.
 */
import {
  itemBounds,
  effectiveSize,
  unionRects,
  type Item,
  type ItemId,
  type Rect
} from '../core/model';

// ---------------------------------------------------------------------------
// Tipos públicos

/** Nueva posición (centro) y, opcionalmente, nueva escala de un ítem. */
export interface Placement {
  id: ItemId;
  x: number;
  y: number;
  scale?: number;
}

/** Opciones comunes de los algoritmos de empaquetado. */
export interface ArrangeOptions {
  /** separación mínima entre cajas, en unidades de escena */
  padding: number;
  /** proporción ancho/alto del viewport; la usan todos los métodos que empaquetan */
  aspect: number;
  /** semilla del PRNG determinista (sólo `arrangeRandom`) */
  seed?: number;
}

// ---------------------------------------------------------------------------
// Utilidades internas

/** Par ítem + su caja actual, para no recalcular `itemBounds` en cada paso. */
interface Boxed {
  it: Item;
  b: Rect;
}

function boxed(items: Item[]): Boxed[] {
  return items.map((it) => ({ it, b: itemBounds(it) }));
}

/** Centro de un rectángulo. */
function centerOf(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Unión de las cajas actuales de los ítems (null si la lista está vacía). */
function currentUnion(list: Boxed[]): Rect | null {
  return unionRects(list.map((e) => e.b));
}

/** Aspecto saneado: siempre un número finito y positivo. */
function safeAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
}

/** Padding saneado: nunca negativo ni NaN. */
function safePadding(padding: number): number {
  return Number.isFinite(padding) && padding > 0 ? padding : 0;
}

/**
 * Convierte posiciones de esquina superior-izquierda en `Placement`s
 * (centros) y desplaza todo el conjunto para que su unión quede centrada en
 * `target`.
 */
function finish(
  placed: Array<{ id: ItemId; left: number; top: number; w: number; h: number }>,
  target: { x: number; y: number }
): Placement[] {
  const u = unionRects(placed.map((p) => ({ x: p.left, y: p.top, w: p.w, h: p.h })));
  if (!u) return [];
  const c = centerOf(u);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  return placed.map((p) => ({ id: p.id, x: p.left + p.w / 2 + dx, y: p.top + p.h / 2 + dy }));
}

/** Mediana de una lista de números (media de los dos centrales si es par). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** PRNG determinista mulberry32: misma semilla, misma secuencia. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ¿Se solapan dos rectángulos inflados `pad/2` por cada lado? */
function collides(a: Rect, b: Rect, pad: number): boolean {
  const h = pad / 2;
  return (
    a.x - h < b.x + b.w + h &&
    a.x + a.w + h > b.x - h &&
    a.y - h < b.y + b.h + h &&
    a.y + a.h + h > b.y - h
  );
}

// ---------------------------------------------------------------------------
// Empaquetado

/**
 * Empaquetado por estanterías ("shelf") con un ancho máximo dado.
 * Devuelve las esquinas superiores-izquierdas en un espacio local (0,0).
 */
function shelfPack(
  boxes: Array<{ id: ItemId; w: number; h: number }>,
  maxW: number,
  padding: number
): Array<{ id: ItemId; left: number; top: number; w: number; h: number }> {
  const out: Array<{ id: ItemId; left: number; top: number; w: number; h: number }> = [];
  let cx = 0;
  let cy = 0;
  let shelfH = 0;
  for (const b of boxes) {
    if (cx > 0 && cx + b.w > maxW) {
      // salto de estantería
      cx = 0;
      cy += shelfH + padding;
      shelfH = 0;
    }
    out.push({ id: b.id, left: cx, top: cy, w: b.w, h: b.h });
    cx += b.w + padding;
    shelfH = Math.max(shelfH, b.h);
  }
  return out;
}

/**
 * Empaquetado "óptimo" tipo shelf/skyline: ordena los ítems por altura
 * descendente y prueba varios anchos de contenedor, quedándose con el que
 * minimiza el área desperdiciada respetando la proporción `opts.aspect`.
 * Nunca deja solapes y respeta `opts.padding` entre cajas.
 */
export function arrangeOptimal(items: Item[], opts: ArrangeOptions): Placement[] {
  const list = boxed(items);
  const u = currentUnion(list);
  if (!u) return [];
  const target = centerOf(u);
  const padding = safePadding(opts.padding);
  const aspect = safeAspect(opts.aspect);

  const boxes = [...list]
    .sort((a, b) => b.b.h - a.b.h || b.b.w - a.b.w || (a.it.id < b.it.id ? -1 : 1))
    .map((e) => ({ id: e.it.id, w: e.b.w, h: e.b.h }));

  const sumArea = boxes.reduce((s, b) => s + (b.w + padding) * (b.h + padding), 0);
  const widest = boxes.reduce((m, b) => Math.max(m, b.w), 0);
  const base = Math.max(widest, Math.sqrt(sumArea * aspect));

  let best: ReturnType<typeof shelfPack> | null = null;
  let bestScore = Infinity;
  for (const f of [0.4, 0.55, 0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.8, 2.2, 2.7, 3.3]) {
    const maxW = Math.max(widest, base * f);
    const packed = shelfPack(boxes, maxW, padding);
    const pu = unionRects(packed.map((p) => ({ x: p.left, y: p.top, w: p.w, h: p.h })));
    if (!pu) continue;
    // Puntaje: área del contenedor con la proporción de la vista que envuelve
    // al resultado. Minimizarlo equivale a maximizar el zoom al que todo el
    // conjunto cabe en pantalla, que es lo que el usuario percibe como "óptimo".
    const side = Math.max(pu.w / aspect, pu.h);
    const score = side * side * aspect;
    if (score < bestScore) {
      bestScore = score;
      best = packed;
    }
  }
  if (!best) return [];
  return finish(best, target);
}

/** Caja ya colocada por el empaquetado en columnas, en coordenadas locales. */
export interface MasonryBox {
  id: ItemId;
  left: number;
  top: number;
  w: number;
  h: number;
  /** Escala absoluta que debe quedar en el ítem para ocupar `w`. */
  scale: number;
}

export interface MasonryOptions {
  /** Separación entre imágenes (y entre columnas). */
  padding: number;
  /** Número de columnas; si falta se deduce de `aspect`. */
  columns?: number;
  /** Ancho de columna; si falta se usa la mediana de los anchos actuales. */
  columnWidth?: number;
  /** Proporción ancho/alto deseada, sólo para deducir `columns`. */
  aspect?: number;
  /** Deja que las imágenes apaisadas ocupen dos columnas (collage con variedad). */
  spanWide?: boolean;
}

/**
 * Proporción ancho/alto a partir de la cual una imagen ocupa dos columnas.
 *
 * Una panorámica al ancho de una sola columna queda como una tira minúscula;
 * a doble ancho recupera presencia sin volverse el ítem más alto del tablero.
 */
export const SPAN_ASPECT = 1.6;

/** Columnas que ocupa una caja: dos si es apaisada y cabe, si no una. */
export function columnSpan(b: Rect, columns: number, spanWide = false): number {
  if (!spanWide || columns < 2 || b.w <= 0 || b.h <= 0) return 1;
  return b.w / b.h >= SPAN_ASPECT ? 2 : 1;
}

/** Ancho de columna por defecto: la mediana de los anchos actuales. */
export function defaultColumnWidth(items: Item[]): number {
  const widths = items.map((it) => itemBounds(it).w).filter((w) => w > 0);
  return widths.length ? median(widths) : 0;
}

/**
 * Columnas que dejan el conjunto con la proporción pedida.
 *
 * Con todas las imágenes al mismo ancho `colW`, el alto total repartido en
 * `n` columnas es `H/n` y el ancho es `n·colW`, así que la proporción sale
 * `n²·colW / H`: despejando, `n = √(aspect · H / colW)`.
 */
function columnsFor(items: Item[], colW: number, aspect: number): number {
  if (colW <= 0) return 1;
  let totalH = 0;
  for (const it of items) {
    const b = itemBounds(it);
    if (b.w > 0) totalH += b.h * (colW / b.w);
  }
  const n = Math.sqrt((safeAspect(aspect) * totalH) / colW);
  return Math.max(1, Math.min(items.length, Math.round(n) || 1));
}

/** Borde superior libre de `span` columnas consecutivas desde `from`. */
function topOf(heights: number[], from: number, span: number): number {
  let top = 0;
  for (let i = from; i < from + span; i++) top = Math.max(top, heights[i] ?? 0);
  return top;
}

/** Hueco muerto que deja apoyar `span` columnas desde `from` en `top`. */
function waste(heights: number[], from: number, span: number, top: number): number {
  let sum = 0;
  for (let i = from; i < from + span; i++) sum += top - (heights[i] ?? 0);
  return sum / 2;
}

/**
 * Hueco de una columna que dejó abierto una imagen a doble ancho: la columna
 * corta del par queda con un vacío entre donde llegaba y donde arranca la
 * imagen ancha. Las siguientes imágenes angostas lo rellenan.
 */
interface Gap {
  col: number;
  top: number;
  h: number;
}

/**
 * Hueco más alto donde quepa algo de `need` de alto, o -1. Sólo sirve si está
 * por encima de `top`, que es donde iría la imagen si no se rellenara nada.
 */
function bestGap(gaps: Gap[], need: number, top: number): number {
  let best = -1;
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i]!;
    if (g.h < need || g.top >= top) continue;
    if (best < 0 || g.top < gaps[best]!.top) best = i;
  }
  return best;
}

/**
 * Empaquetado en columnas tipo collage («masonry»): cada imagen pasa al ancho
 * de una columna —o de dos, si es apaisada y `spanWide` está activo— y se
 * apila donde el collage llega menos abajo, así que las columnas quedan
 * parejas de alto y sin huecos. Devuelve las cajas en coordenadas locales (origen arriba a la izquierda) para que quien llame
 * pueda desplazarlas; `arrangeMasonry` es la versión que trabaja sobre la
 * escena.
 *
 * Respeta el orden recibido, así que ordenar la entrada cambia el resultado.
 */
export function masonryBoxes(items: Item[], opts: MasonryOptions): { boxes: MasonryBox[]; w: number; h: number } {
  const padding = safePadding(opts.padding);
  const colW = opts.columnWidth && opts.columnWidth > 0 ? opts.columnWidth : defaultColumnWidth(items);
  if (!items.length || colW <= 0) return { boxes: [], w: 0, h: 0 };
  const columns = Math.max(1, Math.round(opts.columns ?? columnsFor(items, colW, opts.aspect ?? 1)));

  const heights = new Array<number>(columns).fill(0);
  const gaps: Gap[] = [];
  const boxes: MasonryBox[] = [];
  for (const it of items) {
    const b = itemBounds(it);
    if (b.w <= 0 || b.h <= 0) continue;
    const span = columnSpan(b, columns, opts.spanWide);
    // sitio donde el collage llega menos abajo: la columna (o el par de
    // columnas) más corta; ante empate, la de más a la izquierda
    let k = 0;
    let top = topOf(heights, 0, span);
    let best = top + waste(heights, 0, span, top);
    for (let i = 1; i + span <= columns; i++) {
      const candTop = topOf(heights, i, span);
      // el hueco que deja una imagen a doble ancho cuenta como medio: entre
      // dos sitios igual de altos gana el que desperdicia menos
      const score = candTop + waste(heights, i, span, candTop);
      if (score < best) {
        best = score;
        top = candTop;
        k = i;
      }
    }
    const w = span * colW + (span - 1) * padding;
    const factor = w / b.w;
    const h = b.h * factor;

    // si cabe más arriba en un hueco abierto, va ahí: es lo que deja el
    // collage sin claros en medio
    const gi = span === 1 ? bestGap(gaps, h + padding, top) : -1;
    if (gi >= 0) {
      const g = gaps[gi]!;
      boxes.push({ id: it.id, left: g.col * (colW + padding), top: g.top, w, h, scale: (it.scale || 1) * factor });
      const rest = g.h - (h + padding);
      if (rest > 0) gaps[gi] = { col: g.col, top: g.top + h + padding, h: rest };
      else gaps.splice(gi, 1);
      continue;
    }

    boxes.push({
      id: it.id,
      left: k * (colW + padding),
      top,
      w,
      h,
      scale: (it.scale || 1) * factor
    });
    for (let i = k; i < k + span; i++) {
      if (top > heights[i]!) gaps.push({ col: i, top: heights[i]!, h: top - heights[i]! });
      heights[i] = top + h + padding;
    }
  }
  const tallest = heights.reduce((m, v) => Math.max(m, v), 0);
  return {
    boxes,
    w: columns * colW + (columns - 1) * padding,
    h: Math.max(0, tallest - padding)
  };
}

/**
 * Collage en columnas verticales sobre la escena: anchos de una o dos
 * columnas, alturas libres y sin huecos. El conjunto queda centrado donde
 * estaba.
 */
export function arrangeMasonry(
  items: Item[],
  opts: ArrangeOptions & { columns?: number; columnWidth?: number; spanWide?: boolean }
): Placement[] {
  const list = boxed(items);
  const u = currentUnion(list);
  if (!u) return [];
  const target = centerOf(u);
  const { boxes, w, h } = masonryBoxes(items, {
    padding: opts.padding,
    aspect: opts.aspect,
    columns: opts.columns,
    columnWidth: opts.columnWidth,
    spanWide: opts.spanWide
  });
  if (!boxes.length) return [];
  const dx = target.x - w / 2;
  const dy = target.y - h / 2;
  return boxes.map((b) => ({ id: b.id, x: dx + b.left + b.w / 2, y: dy + b.top + b.h / 2, scale: b.scale }));
}

/**
 * Cuadrícula regular: columnas = ceil(sqrt(n * aspect)), celdas del tamaño
 * del ítem más grande y cada ítem centrado dentro de su celda. Respeta el
 * orden del array recibido (por eso `arrangeByColor` puede reutilizarla).
 */
export function arrangeGrid(items: Item[], opts: ArrangeOptions): Placement[] {
  const list = boxed(items);
  const u = currentUnion(list);
  if (!u) return [];
  const target = centerOf(u);
  const padding = safePadding(opts.padding);
  const aspect = safeAspect(opts.aspect);

  const n = list.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * aspect)));
  const cellW = list.reduce((m, e) => Math.max(m, e.b.w), 0);
  const cellH = list.reduce((m, e) => Math.max(m, e.b.h), 0);

  const placed = list.map((e, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellX = col * (cellW + padding);
    const cellY = row * (cellH + padding);
    return {
      id: e.it.id,
      left: cellX + (cellW - e.b.w) / 2,
      top: cellY + (cellH - e.b.h) / 2,
      w: e.b.w,
      h: e.b.h
    };
  });
  return finish(placed, target);
}

/**
 * Una sola fila horizontal en el orden actual de izquierda a derecha
 * (por centro x), con los centros alineados verticalmente.
 */
export function arrangeRow(items: Item[], opts: ArrangeOptions): Placement[] {
  const list = boxed(items);
  const u = currentUnion(list);
  if (!u) return [];
  const target = centerOf(u);
  const padding = safePadding(opts.padding);

  const sorted = [...list].sort((a, b) => a.it.x - b.it.x || (a.it.id < b.it.id ? -1 : 1));
  const maxH = sorted.reduce((m, e) => Math.max(m, e.b.h), 0);
  let x = 0;
  const placed = sorted.map((e) => {
    const p = { id: e.it.id, left: x, top: (maxH - e.b.h) / 2, w: e.b.w, h: e.b.h };
    x += e.b.w + padding;
    return p;
  });
  return finish(placed, target);
}

/**
 * Una sola columna vertical en el orden actual de arriba abajo (por centro
 * y), con los centros alineados horizontalmente.
 */
export function arrangeColumn(items: Item[], opts: ArrangeOptions): Placement[] {
  const list = boxed(items);
  const u = currentUnion(list);
  if (!u) return [];
  const target = centerOf(u);
  const padding = safePadding(opts.padding);

  const sorted = [...list].sort((a, b) => a.it.y - b.it.y || (a.it.id < b.it.id ? -1 : 1));
  const maxW = sorted.reduce((m, e) => Math.max(m, e.b.w), 0);
  let y = 0;
  const placed = sorted.map((e) => {
    const p = { id: e.it.id, left: (maxW - e.b.w) / 2, top: y, w: e.b.w, h: e.b.h };
    y += e.b.h + padding;
    return p;
  });
  return finish(placed, target);
}

/**
 * Dispersión aleatoria pero REPRODUCIBLE dentro de un área de proporción
 * `aspect` y superficie igual al área total de los ítems * 2.5.
 * Hace hasta 50 intentos por ítem para no solapar; si aun así no encuentra
 * hueco, busca en espiral hacia afuera (determinista) hasta encontrar uno,
 * de modo que el resultado nunca tiene solapes.
 */
export function arrangeRandom(items: Item[], opts: ArrangeOptions): Placement[] {
  const list = boxed(items);
  const u = currentUnion(list);
  if (!u) return [];
  const target = centerOf(u);
  const padding = safePadding(opts.padding);
  const aspect = safeAspect(opts.aspect);
  const rnd = mulberry32(opts.seed ?? 1);

  const totalArea = list.reduce((s, e) => s + e.b.w * e.b.h, 0);
  const area = Math.max(totalArea * 2.5, 1);
  const W = Math.sqrt(area * aspect);
  const H = area / W;

  const done: Rect[] = [];
  const placed: Array<{ id: ItemId; left: number; top: number; w: number; h: number }> = [];

  for (const e of list) {
    const maxX = Math.max(0, W - e.b.w);
    const maxY = Math.max(0, H - e.b.h);
    let spot: Rect | null = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      const cand: Rect = { x: rnd() * maxX, y: rnd() * maxY, w: e.b.w, h: e.b.h };
      if (!done.some((r) => collides(cand, r, padding))) {
        spot = cand;
        break;
      }
    }
    if (!spot) spot = spiralFreeSpot(done, e.b.w, e.b.h, W / 2, H / 2, padding);
    done.push(spot);
    placed.push({ id: e.it.id, left: spot.x, top: spot.y, w: spot.w, h: spot.h });
  }
  return finish(placed, target);
}

/**
 * Busca (de forma determinista) el primer hueco libre recorriendo anillos
 * concéntricos hacia afuera alrededor de (cx, cy). Termina siempre porque el
 * radio acaba superando la extensión de todo lo ya colocado.
 */
function spiralFreeSpot(
  done: Rect[],
  w: number,
  h: number,
  cx: number,
  cy: number,
  padding: number
): Rect {
  const step = Math.max(w, h) + padding + 1;
  for (let ring = 1; ring < 500; ring++) {
    const r = ring * step;
    const samples = Math.max(8, ring * 8);
    for (let k = 0; k < samples; k++) {
      const a = (k / samples) * Math.PI * 2;
      const cand: Rect = { x: cx + Math.cos(a) * r - w / 2, y: cy + Math.sin(a) * r - h / 2, w, h };
      if (!done.some((rr) => collides(cand, rr, padding))) return cand;
    }
  }
  return { x: cx, y: cy, w, h };
}

/**
 * Agrupa por color: ordena los ítems según `keyFn` (por ejemplo el tono
 * 0..360 del color dominante; los `null` van al final) y aplica
 * `arrangeGrid` en ese orden.
 */
export function arrangeByColor(
  items: Item[],
  opts: ArrangeOptions,
  keyFn: (it: Item) => number | null
): Placement[] {
  const keyed = items.map((it, i) => ({ it, i, k: keyFn(it) }));
  keyed.sort((a, b) => {
    const ka = a.k;
    const kb = b.k;
    if (ka === null && kb === null) return a.i - b.i;
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka - kb || a.i - b.i;
  });
  return arrangeGrid(
    keyed.map((e) => e.it),
    opts
  );
}

// ---------------------------------------------------------------------------
// Normalización de tamaños

/**
 * Escala cada ítem para que su lado mayor efectivo iguale la mediana de los
 * lados mayores del conjunto. Mantiene el centro de cada ítem.
 */
export function normalizeSize(items: Item[]): Placement[] {
  if (items.length === 0) return [];
  const sizes = items.map((it) => effectiveSize(it));
  const longest = sizes.map((s) => Math.max(s.w, s.h));
  const objetivo = median(longest);
  return items.map((it, i) => {
    const cur = longest[i];
    const factor = cur > 0 && objetivo > 0 ? objetivo / cur : 1;
    return { id: it.id, x: it.x, y: it.y, scale: it.scale * factor };
  });
}

/**
 * Escala cada ítem para que su ÁREA efectiva iguale la mediana de áreas del
 * conjunto. Mantiene el centro de cada ítem.
 */
export function normalizeArea(items: Item[]): Placement[] {
  if (items.length === 0) return [];
  const areas = items.map((it) => {
    const s = effectiveSize(it);
    return s.w * s.h;
  });
  const objetivo = median(areas);
  return items.map((it, i) => {
    const cur = areas[i];
    const factor = cur > 0 && objetivo > 0 ? Math.sqrt(objetivo / cur) : 1;
    return { id: it.id, x: it.x, y: it.y, scale: it.scale * factor };
  });
}

// ---------------------------------------------------------------------------
// Alineado, distribución y apilado

/** Borde de referencia para `alignItems`. */
export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'centerH' | 'centerV';

/**
 * Alinea las cajas al borde indicado de la unión de todas ellas.
 * `padding` actúa como desplazamiento desde ese borde hacia dentro.
 * `centerH` alinea los centros en el eje horizontal (mismo x),
 * `centerV` los alinea en el eje vertical (mismo y).
 * No recentra el conjunto: la unión mantiene su posición.
 */
export function alignItems(items: Item[], edge: AlignEdge, padding: number): Placement[] {
  const list = boxed(items);
  const u = currentUnion(list);
  if (!u) return [];
  const pad = safePadding(padding);
  const c = centerOf(u);

  return list.map(({ it, b }) => {
    let x = b.x + b.w / 2;
    let y = b.y + b.h / 2;
    switch (edge) {
      case 'left':
        x = u.x + pad + b.w / 2;
        break;
      case 'right':
        x = u.x + u.w - pad - b.w / 2;
        break;
      case 'top':
        y = u.y + pad + b.h / 2;
        break;
      case 'bottom':
        y = u.y + u.h - pad - b.h / 2;
        break;
      case 'centerH':
        x = c.x;
        break;
      case 'centerV':
        y = c.y;
        break;
    }
    // el centro del ítem puede no coincidir con el de su caja (nunca ocurre
    // con `itemBounds`, pero lo respetamos por robustez)
    return { id: it.id, x: it.x + (x - (b.x + b.w / 2)), y: it.y + (y - (b.y + b.h / 2)) };
  });
}

/**
 * Reparte los ítems con espaciado uniforme ENTRE cajas a lo largo del eje
 * indicado, manteniendo fijos el primero y el último. Con menos de 3 ítems
 * no hay nada que repartir y se devuelven las posiciones actuales.
 */
export function distributeItems(items: Item[], axis: 'h' | 'v'): Placement[] {
  const list = boxed(items);
  if (list.length === 0) return [];
  const horiz = axis === 'h';
  const sorted = [...list].sort((a, b) => {
    const av = horiz ? a.b.x : a.b.y;
    const bv = horiz ? b.b.x : b.b.y;
    return av - bv || (a.it.id < b.it.id ? -1 : 1);
  });
  if (sorted.length < 3) {
    return sorted.map((e) => ({ id: e.it.id, x: e.it.x, y: e.it.y }));
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const start = horiz ? first.b.x : first.b.y;
  const end = horiz ? last.b.x + last.b.w : last.b.y + last.b.h;
  const sumSize = sorted.reduce((s, e) => s + (horiz ? e.b.w : e.b.h), 0);
  const gap = (end - start - sumSize) / (sorted.length - 1);

  let cursor = start;
  return sorted.map((e) => {
    const size = horiz ? e.b.w : e.b.h;
    const newStart = cursor;
    cursor += size + gap;
    const delta = newStart - (horiz ? e.b.x : e.b.y);
    return { id: e.it.id, x: horiz ? e.it.x + delta : e.it.x, y: horiz ? e.it.y : e.it.y + delta };
  });
}

/**
 * Apila las cajas una tras otra sin huecos (salvo `padding`) en el orden
 * actual a lo largo del eje indicado, alineando los centros en el eje
 * transversal. El conjunto queda centrado en el centro original.
 */
export function stackItems(items: Item[], axis: 'h' | 'v', padding: number): Placement[] {
  const list = boxed(items);
  const u = currentUnion(list);
  if (!u) return [];
  const target = centerOf(u);
  const pad = safePadding(padding);
  const horiz = axis === 'h';
  const sorted = [...list].sort((a, b) => {
    const av = horiz ? a.it.x : a.it.y;
    const bv = horiz ? b.it.x : b.it.y;
    return av - bv || (a.it.id < b.it.id ? -1 : 1);
  });

  const maxCross = sorted.reduce((m, e) => Math.max(m, horiz ? e.b.h : e.b.w), 0);
  let cursor = 0;
  const placed = sorted.map((e) => {
    const p = horiz
      ? { id: e.it.id, left: cursor, top: (maxCross - e.b.h) / 2, w: e.b.w, h: e.b.h }
      : { id: e.it.id, left: (maxCross - e.b.w) / 2, top: cursor, w: e.b.w, h: e.b.h };
    cursor += (horiz ? e.b.w : e.b.h) + pad;
    return p;
  });
  return finish(placed, target);
}

// ---------------------------------------------------------------------------
// Ayudas sueltas

/** Redondea `v` al múltiplo de `size` más cercano (`size <= 0` no hace nada). */
export function snapToGrid(v: number, size: number): number {
  if (!Number.isFinite(size) || size <= 0) return v;
  return Math.round(v / size) * size;
}

/**
 * Tono HSL (0..360) de un color hexadecimal (`#rgb`, `#rrggbb`, `#rrggbbaa`).
 * Devuelve `null` si el color no es válido o es acromático (gris), para que
 * `arrangeByColor` lo mande al final.
 */
export function hueOfHex(hex: string): number | null {
  if (typeof hex !== 'string') return null;
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3 || s.length === 4) s = s.slice(0, 3).split('').map((c) => c + c).join('');
  else if (s.length === 8) s = s.slice(0, 6);
  if (s.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(s)) return null;

  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null; // gris: sin tono

  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}
