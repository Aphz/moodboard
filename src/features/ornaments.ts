/**
 * Ornamentos, simbología y conectores del tablero.
 *
 * Un moodboard no se distingue por la cantidad de imágenes sino por lo que las
 * acompaña: los signos sueltos, las marcas tipográficas y las flechas que
 * relacionan una referencia con otra. Este módulo decide QUÉ signos van con el
 * mood del tablero y DÓNDE caben sin tapar nada, y arma la geometría de los
 * conectores. Crear los ítems es cosa del llamador, en una sola transacción.
 *
 * Módulo PURO, como el resto de `features/`: no toca el store ni el DOM.
 */
import { rectsIntersect, unionRects, type Point, type Rect } from '../core/model';
import { mulberry32 } from './arrange';

// ---------------------------------------------------------------------------
// Repertorios por mood

/** Moods con repertorio propio de signos. */
export type MoodId = 'editorial' | 'tecnico' | 'romantico' | 'brutalista' | 'retro' | 'natural' | 'nocturno';

export interface MoodSet {
  /** Glifos sueltos: el ornamento propiamente tal. */
  symbols: string[];
  /** Marcas tipográficas breves, para usar de tanto en tanto. */
  words: string[];
  /** Palabras del tablero que delatan este mood (en minúsculas, sin tildes). */
  hints: string[];
}

/**
 * Catálogo local. Existe para que la función sirva SIN clave de IA: el mood se
 * deduce de las etiquetas del tablero y los signos salen de aquí. Con clave, la
 * IA propone su propio repertorio y este queda como respaldo.
 */
export const MOOD_SETS: Record<MoodId, MoodSet> = {
  editorial: {
    symbols: ['✳', '→', '✦', '—', '·', '↳', '◦'],
    words: ['REF', '01', 'N°', 'FIG.'],
    hints: ['editorial', 'revista', 'moda', 'tipografia', 'minimal', 'limpio', 'estudio', 'blanco']
  },
  tecnico: {
    symbols: ['+', '×', '▣', '◧', '⊕', '⇢', '⌗'],
    words: ['V.01', 'SPEC', 'MM', 'REV'],
    hints: ['tecnico', 'industrial', 'plano', 'maqueta', 'producto', 'ingenieria', 'metal', 'motor']
  },
  romantico: {
    symbols: ['❀', '✿', '♡', '❋', '✧', '~'],
    words: ['s/f', 'nota'],
    hints: ['romantico', 'flores', 'floral', 'suave', 'pastel', 'boda', 'delicado', 'seda']
  },
  brutalista: {
    symbols: ['▮', '■', '▲', '✕', '//', '█'],
    words: ['RAW', 'NO', '×3'],
    hints: ['brutalista', 'crudo', 'urbano', 'concreto', 'punk', 'cartel', 'grafiti', 'ruido']
  },
  retro: {
    symbols: ['★', '☆', '◎', '☼', '≈', '✺'],
    words: ['1974', 'HI-FI', '45 RPM'],
    hints: ['retro', 'vintage', 'analogico', 'cassette', 'ochenta', 'setenta', 'polaroid', 'neon']
  },
  natural: {
    symbols: ['☘', '〰', '◠', '☁', '✽', '↟'],
    words: ['N—S', 'flora'],
    hints: ['natural', 'bosque', 'playa', 'tierra', 'organico', 'paisaje', 'botanico', 'madera', 'piedra']
  },
  nocturno: {
    symbols: ['✷', '☾', '✵', '◐', '✦', '·'],
    words: ['00:00', 'NOCT'],
    hints: ['nocturno', 'noche', 'oscuro', 'luna', 'club', 'sombra', 'negro']
  }
};

/** Mood por defecto cuando no hay pistas suficientes. */
export const DEFAULT_MOOD: MoodId = 'editorial';

/** Todos los moods, en el orden en que conviene ofrecerlos. */
export const MOODS: MoodId[] = ['editorial', 'tecnico', 'romantico', 'brutalista', 'retro', 'natural', 'nocturno'];

/** Minúsculas y sin tildes, para comparar pistas con etiquetas del usuario. */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Deduce el mood a partir del texto del tablero (nombre, etiquetas,
 * categorías). Cuenta cuántas pistas de cada repertorio aparecen; si no
 * aparece ninguna, devuelve `DEFAULT_MOOD`.
 */
export function moodFromText(text: string): MoodId {
  const hay = fold(text ?? '');
  if (!hay.trim()) return DEFAULT_MOOD;
  let best: MoodId = DEFAULT_MOOD;
  let bestScore = 0;
  for (const mood of MOODS) {
    let score = 0;
    for (const hint of MOOD_SETS[mood].hints) if (hay.includes(hint)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = mood;
    }
  }
  return best;
}

/**
 * Repertorio de un mood: sus glifos y, al final, una marca tipográfica. Se
 * devuelve siempre en el mismo orden para que la vista previa sea estable.
 */
export function symbolsForMood(mood: MoodId, words = 1): string[] {
  const set = MOOD_SETS[mood] ?? MOOD_SETS[DEFAULT_MOOD];
  return [...set.symbols, ...set.words.slice(0, Math.max(0, words))];
}

/**
 * ¿Sirve como ornamento? Se aceptan glifos y marcas de hasta 6 caracteres en
 * una sola línea; se rechazan los emoji (no son signos tipográficos y en el
 * lienzo salen como cajas de color).
 */
export function isOrnamentText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s || s.length > 6 || /[\n\r\t]/.test(s)) return false;
  return !/[\u{1F000}-\u{1FAFF}\u{FE0F}]/u.test(s);
}

/** Limpia una lista de signos propuesta desde fuera (por ejemplo, por la IA). */
export function cleanSymbols(list: unknown, max = 10): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    if (!isOrnamentText(raw)) continue;
    const s = raw.trim();
    if (!out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Colocación

/** Un ornamento ya situado, en coordenadas de escena. */
export interface OrnamentSpec {
  text: string;
  /** centro del signo */
  x: number;
  y: number;
  /** alto nominal del glifo (tamaño de fuente en unidades de escena) */
  size: number;
  rotation: number;
}

export interface OrnamentOptions {
  /** Cuántos ornamentos colocar como mucho. */
  count: number;
  /** Alto nominal del glifo; por defecto, una fracción del ancho típico. */
  size?: number;
  /** Separación mínima con las imágenes; por defecto, medio glifo. */
  margin?: number;
  /** Semilla del PRNG determinista: misma semilla, mismo resultado. */
  seed?: number;
}

/** Mediana de una lista de números. */
function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Caja que ocupa un signo dibujado como nota, centrada en `(x, y)`.
 *
 * Una nota reserva `fontSize * 0.6` de relleno por lado y su línea mide
 * `fontSize * 1.35`, así que el alto ronda 2,6 veces el tamaño del glifo. Se
 * usa tanto al buscar hueco como al crear el ítem: si no fueran la misma caja,
 * el signo terminaría montado sobre una imagen.
 */
export function ornamentBox(text: string, size: number, x = 0, y = 0): Rect {
  const w = size * (0.8 * Math.max(1, text.length) + 1.2);
  const h = size * 2.6;
  return { x: x - w / 2, y: y - h / 2, w, h };
}

/** Tamaño de glifo que no compite con las imágenes: un quinto del ancho típico. */
export function defaultOrnamentSize(boxes: Rect[]): number {
  const w = median(boxes.map((b) => b.w).filter((v) => v > 0));
  return w > 0 ? w / 5 : 0;
}

/**
 * Sitúa signos en los claros del tablero y en su margen, sin tapar ninguna
 * imagen ni amontonarse entre ellos.
 *
 * Recorre una rejilla de candidatos barajada con un PRNG determinista y se
 * queda con los primeros que quepan, así que el resultado es reproducible pero
 * no parece alineado.
 */
export function placeOrnaments(boxes: Rect[], symbols: string[], opts: OrnamentOptions): OrnamentSpec[] {
  const syms = symbols.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
  const count = Math.max(0, Math.floor(opts.count));
  if (!syms.length || !count || !boxes.length) return [];
  const area = unionRects(boxes);
  if (!area) return [];
  const size = opts.size && opts.size > 0 ? opts.size : defaultOrnamentSize(boxes);
  if (size <= 0) return [];
  const margin = opts.margin !== undefined && opts.margin >= 0 ? opts.margin : size / 2;
  const rnd = mulberry32(opts.seed ?? 1);

  // el campo de juego incluye un margen alrededor del tablero: ahí es donde un
  // moodboard suele dejar sus marcas sueltas
  const band = size * 2;
  const field: Rect = { x: area.x - band, y: area.y - band, w: area.w + band * 2, h: area.h + band * 2 };
  const step = Math.max(size, Math.min(field.w, field.h) / 24);

  const cands: Point[] = [];
  for (let y = field.y + step / 2; y < field.y + field.h; y += step) {
    for (let x = field.x + step / 2; x < field.x + field.w; x += step) cands.push({ x, y });
  }
  // barajado determinista (Fisher-Yates con el mismo PRNG)
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cands[i], cands[j]] = [cands[j]!, cands[i]!];
  }

  const out: OrnamentSpec[] = [];
  const taken: Rect[] = [];
  for (const c of cands) {
    if (out.length >= count) break;
    const text = syms[out.length % syms.length]!;
    const s = size * (0.7 + rnd() * 0.7);
    const rotation = rnd() < 0.7 ? 0 : (rnd() - 0.5) * 0.6;
    const b0 = ornamentBox(text, s, c.x, c.y);
    const box: Rect = { x: b0.x - margin, y: b0.y - margin, w: b0.w + margin * 2, h: b0.h + margin * 2 };
    if (boxes.some((b) => rectsIntersect(box, b))) continue;
    // separación entre ornamentos: no se agrupan en un rincón
    const apart: Rect = { x: box.x - size, y: box.y - size, w: box.w + size * 2, h: box.h + size * 2 };
    if (taken.some((b) => rectsIntersect(apart, b))) continue;
    taken.push(box);
    out.push({ text, x: c.x, y: c.y, size: s, rotation });
  }
  return out;
}

/**
 * Tinta que contrasta con el fondo del lienzo: los signos y las flechas se ven
 * igual sobre un tablero oscuro que sobre uno claro.
 */
export function inkColor(canvasColor: string): string {
  const m = /^#?([0-9a-f]{6})/i.exec((canvasColor ?? '').trim());
  if (!m) return '#f2f2f2';
  const n = parseInt(m[1]!, 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.6 ? '#1a1a1a' : '#f2f2f2';
}

// ---------------------------------------------------------------------------
// Conectores

/** Segmento entre dos ítems, ya recortado a sus bordes. */
export interface ConnectorSpec {
  from: Point;
  to: Point;
}

/** Punto del borde de `r` (inflado `gap`) en la dirección `(dx, dy)`. */
function edgePoint(r: Rect, dx: number, dy: number, gap: number): Point {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const hw = r.w / 2 + gap;
  const hh = r.h / 2 + gap;
  const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const tt = Math.min(tx, ty);
  return { x: cx + dx * tt, y: cy + dy * tt };
}

/**
 * Segmento de borde a borde entre dos cajas, separado `gap` de cada una.
 * Devuelve `null` si las cajas están tan juntas (o solapadas) que la flecha
 * quedaría al revés.
 */
export function connectorBetween(a: Rect, b: Rect, gap = 0): ConnectorSpec | null {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (dx === 0 && dy === 0) return null;
  const from = edgePoint(a, dx, dy, gap);
  const to = edgePoint(b, -dx, -dy, gap);
  const vx = to.x - from.x;
  const vy = to.y - from.y;
  // el segmento tiene que apuntar de `a` a `b`: si no, las cajas se tocan
  if (vx * dx + vy * dy <= 0) return null;
  if (Math.hypot(vx, vy) < 1) return null;
  return { from, to };
}

/**
 * Encadena conectores a lo largo de una lista de cajas (1→2, 2→3, …).
 *
 * Si entre dos cajas no cabe el hueco pedido —es lo normal en un collage
 * apretado— la flecha se dibuja igual, de borde a borde. Sólo se saltan los
 * pares que se solapan, donde no hay flecha posible.
 */
export function chainConnectors(boxes: Rect[], gap = 0): ConnectorSpec[] {
  const out: ConnectorSpec[] = [];
  for (let i = 1; i < boxes.length; i++) {
    const a = boxes[i - 1]!;
    const b = boxes[i]!;
    const c = connectorBetween(a, b, gap) ?? connectorBetween(a, b, 0);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Pasa puntos de escena a las coordenadas locales de un ítem `drawing`
 * (centradas en su caja), junto con el centro y el tamaño que debe llevar el
 * ítem. Es lo que espera `createDrawingItem` + `strokes`.
 */
export function centerPoints(points: Point[]): { x: number; y: number; w: number; h: number; points: Point[] } {
  if (!points.length) return { x: 0, y: 0, w: 1, h: 1, points: [] };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return {
    x: cx,
    y: cy,
    w: Math.max(1, x1 - x0),
    h: Math.max(1, y1 - y0),
    points: points.map((p) => ({ x: p.x - cx, y: p.y - cy }))
  };
}
