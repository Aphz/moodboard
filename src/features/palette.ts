/**
 * Extracción de paletas de color a partir de píxeles RGBA.
 *
 * Todas las funciones de este módulo (salvo `paletteFromBitmap`) son PURAS y
 * operan sobre `Uint8ClampedArray` en formato RGBA, de modo que se pueden
 * probar en jsdom sin necesidad de un `<canvas>` real.
 *
 * El algoritmo de cuantización es un *mean-cut* (variante de median-cut que
 * corta por la media del canal más extendido en lugar de por la mediana de
 * población): produce cajas muy ajustadas cuando la imagen tiene colores
 * planos y se comporta bien con fotografías. Después de cuantizar, los
 * colores perceptualmente parecidos se fusionan usando la distancia ΔE76 en
 * espacio CIE-Lab.
 */

/** Color en componentes 0..255. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Color en tono (0..360), saturación (0..1) y luminosidad (0..1). */
export interface HSL {
  h: number;
  s: number;
  l: number;
}

/** Opciones de muestreo de `extractPalette`. */
export interface PaletteOptions {
  /** Alfa mínimo (0..255) para que un píxel cuente. Por defecto 8. */
  ignoreAlphaBelow?: number;
  /** Tomar 1 de cada N píxeles. Por defecto se calcula para ~20 000 muestras. */
  sampleStep?: number;
  /** Distancia ΔE76 por debajo de la cual dos colores se fusionan. Por defecto 25. */
  mergeDistance?: number;
}

/** Color cuantizado con su población (número de píxeles muestreados). */
interface Swatch extends RGB {
  n: number;
}

/** Conjunto de muestras de píxeles separadas por canal. */
interface Samples {
  r: number[];
  g: number[];
  b: number[];
}

/** Caja de color: índices de muestras + límites por canal. */
interface Box {
  idx: number[];
  min: [number, number, number];
  max: [number, number, number];
}

const MAX_SAMPLES = 20000;
/** Número mínimo de cajas de cuantización, independientemente de `count`. */
const MIN_BUCKETS = 5;

/** Redondea y recorta un valor al rango 0..255. */
function clamp255(v: number): number {
  const n = Math.round(v);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

// ---------------------------------------------------------------------------
// Conversiones de color

/** Convierte componentes 0..255 a `#rrggbb` en minúsculas. */
export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => clamp255(v).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Convierte `#rgb`, `#rrggbb` o `#rrggbbaa` (se ignora el alfa) a componentes
 * 0..255. Devuelve `null` si la cadena no es un color hexadecimal válido.
 */
export function hexToRgb(hex: string): RGB | null {
  if (typeof hex !== 'string') return null;
  let s = hex.trim().toLowerCase();
  if (s.startsWith('#')) s = s.slice(1);
  if (!/^[0-9a-f]+$/.test(s)) return null;
  if (s.length === 3 || s.length === 4) {
    const r = parseInt(s[0]! + s[0]!, 16);
    const g = parseInt(s[1]! + s[1]!, 16);
    const b = parseInt(s[2]! + s[2]!, 16);
    return { r, g, b };
  }
  if (s.length === 6 || s.length === 8) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16)
    };
  }
  return null;
}

/** RGB (0..255) → HSL con tono en grados (0..360) y s/l en 0..1. */
export function rgbToHsl(r: number, g: number, b: number): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/** HSL (h en grados, s/l en 0..1) → RGB 0..255. */
export function hslToRgb(h: number, s: number, l: number): RGB {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.min(1, Math.max(0, s));
  const ll = Math.min(1, Math.max(0, l));
  if (ss === 0) {
    const v = clamp255(ll * 255);
    return { r: v, g: v, b: v };
  }
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hh < 60) [rp, gp, bp] = [c, x, 0];
  else if (hh < 120) [rp, gp, bp] = [x, c, 0];
  else if (hh < 180) [rp, gp, bp] = [0, c, x];
  else if (hh < 240) [rp, gp, bp] = [0, x, c];
  else if (hh < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return { r: clamp255((rp + m) * 255), g: clamp255((gp + m) * 255), b: clamp255((bp + m) * 255) };
}

/**
 * Tono (0..360) de un color hexadecimal, o `null` si es demasiado desaturado
 * (saturación < 0.08) como para que el tono signifique algo. Se usa para
 * ordenar/filtrar por color en la interfaz.
 */
export function hueOf(hex: string): number | null {
  const c = hexToRgb(hex);
  if (!c) return null;
  const { h, s } = rgbToHsl(c.r, c.g, c.b);
  return s < 0.08 ? null : h;
}

/** Luminancia relativa (WCAG) de un color 0..255. */
function relativeLuminance(r: number, g: number, b: number): number {
  const f = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Color de texto legible (`'#000'` o `'#fff'`) sobre el fondo indicado. */
export function contrastText(hex: string): '#000' | '#fff' {
  const c = hexToRgb(hex);
  if (!c) return '#000';
  return relativeLuminance(c.r, c.g, c.b) > 0.179 ? '#000' : '#fff';
}

// ---------------------------------------------------------------------------
// Distancia perceptual (CIE-Lab / ΔE76)

/** RGB (0..255) → CIE-Lab (D65). */
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) => {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  // sRGB → XYZ (referencia blanca D65)
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Distancia perceptual ΔE76 entre dos colores RGB. */
export function colorDistance(a: RGB, b: RGB): number {
  const la = rgbToLab(a.r, a.g, a.b);
  const lb = rgbToLab(b.r, b.g, b.b);
  const dl = la[0] - lb[0];
  const da = la[1] - lb[1];
  const db = la[2] - lb[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

// ---------------------------------------------------------------------------
// Cuantización

/** Toma muestras de píxeles opacos del buffer RGBA. */
function collectSamples(data: Uint8ClampedArray, opts: PaletteOptions): Samples {
  const minAlpha = opts.ignoreAlphaBelow ?? 8;
  const total = Math.floor(data.length / 4);
  const step = Math.max(1, Math.floor(opts.sampleStep ?? Math.ceil(total / MAX_SAMPLES)));
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    if (data[o + 3]! < minAlpha) continue;
    r.push(data[o]!);
    g.push(data[o + 1]!);
    b.push(data[o + 2]!);
  }
  return { r, g, b };
}

/** Construye una caja con los límites por canal de los índices dados. */
function makeBox(px: Samples, idx: number[]): Box {
  const min: [number, number, number] = [255, 255, 255];
  const max: [number, number, number] = [0, 0, 0];
  for (const i of idx) {
    const v: [number, number, number] = [px.r[i]!, px.g[i]!, px.b[i]!];
    for (let c = 0; c < 3; c++) {
      if (v[c]! < min[c]!) min[c] = v[c]!;
      if (v[c]! > max[c]!) max[c] = v[c]!;
    }
  }
  return { idx, min, max };
}

/** Prioridad de corte: población × extensión del canal más ancho. */
function boxScore(box: Box): number {
  const range = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  return range <= 0 ? 0 : box.idx.length * range;
}

/** Parte una caja por la media del canal más extendido. */
function splitBox(px: Samples, box: Box): [Box, Box] | null {
  const ranges = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  let ch = 0;
  if (ranges[1]! > ranges[ch]!) ch = 1;
  if (ranges[2]! > ranges[ch]!) ch = 2;
  if (ranges[ch]! <= 0) return null;
  const chan = ch === 0 ? px.r : ch === 1 ? px.g : px.b;
  let sum = 0;
  for (const i of box.idx) sum += chan[i]!;
  const mean = sum / box.idx.length;
  const lo: number[] = [];
  const hi: number[] = [];
  for (const i of box.idx) (chan[i]! <= mean ? lo : hi).push(i);
  if (lo.length === 0 || hi.length === 0) {
    // Reparto de emergencia: corte por mediana de población.
    const sorted = box.idx.slice().sort((a, b) => chan[a]! - chan[b]!);
    const mid = Math.floor(sorted.length / 2);
    if (mid === 0 || mid >= sorted.length) return null;
    return [makeBox(px, sorted.slice(0, mid)), makeBox(px, sorted.slice(mid))];
  }
  return [makeBox(px, lo), makeBox(px, hi)];
}

/** Color medio de una caja junto con su población. */
function boxAverage(px: Samples, box: Box): Swatch {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of box.idx) {
    r += px.r[i]!;
    g += px.g[i]!;
    b += px.b[i]!;
  }
  const n = box.idx.length;
  return { r: r / n, g: g / n, b: b / n, n };
}

/** Fusiona colores cuya distancia ΔE76 sea menor que `threshold`. */
function mergeSimilar(list: Swatch[], threshold: number): Swatch[] {
  const out: Swatch[] = [];
  for (const s of list) {
    let merged = false;
    for (const o of out) {
      if (colorDistance(s, o) < threshold) {
        const n = o.n + s.n;
        o.r = (o.r * o.n + s.r * s.n) / n;
        o.g = (o.g * o.n + s.g * s.n) / n;
        o.b = (o.b * o.n + s.b * s.n) / n;
        o.n = n;
        merged = true;
        break;
      }
    }
    if (!merged) out.push({ ...s });
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}

/**
 * Extrae hasta `count` colores dominantes de un buffer RGBA, ordenados de
 * mayor a menor población y perceptualmente distintos entre sí.
 *
 * @param data   Píxeles en RGBA (4 bytes por píxel).
 * @param count  Número máximo de colores a devolver.
 * @param opts   Ajustes de muestreo y de fusión.
 * @returns      Colores en formato `#rrggbb`.
 */
export function extractPalette(
  data: Uint8ClampedArray,
  count = 6,
  opts: PaletteOptions = {}
): string[] {
  if (!data || data.length < 4 || count < 1) return [];
  const px = collectSamples(data, opts);
  if (px.r.length === 0) return [];

  const all: number[] = new Array(px.r.length);
  for (let i = 0; i < all.length; i++) all[i] = i;
  const boxes: Box[] = [makeBox(px, all)];

  // Se cuantiza siempre a unas cuantas cajas aunque se pida un solo color, para
  // que el primer resultado sea el color MÁS FRECUENTE y no la media global.
  const target = Math.max(count, MIN_BUCKETS);
  while (boxes.length < target) {
    let bi = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      const s = boxScore(boxes[i]!);
      if (s > best) {
        best = s;
        bi = i;
      }
    }
    if (bi < 0) break;
    const parts = splitBox(px, boxes[bi]!);
    if (!parts) break;
    boxes.splice(bi, 1, parts[0], parts[1]);
  }

  const swatches = boxes.map((b) => boxAverage(px, b)).sort((a, b) => b.n - a.n);
  const merged = mergeSimilar(swatches, opts.mergeDistance ?? 25);
  return merged.slice(0, count).map((s) => rgbToHex(s.r, s.g, s.b));
}

/** Color dominante del buffer RGBA (o `#000000` si no hay píxeles opacos). */
export function dominantColor(data: Uint8ClampedArray): string {
  return extractPalette(data, 1)[0] ?? '#000000';
}

// ---------------------------------------------------------------------------
// Puente con el DOM (no cubierto por tests)

/** Fuente de imagen admitida por `paletteFromBitmap`. */
export type ImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

/** Tamaño natural de una fuente de imagen. */
function sourceSize(img: ImageSource): { w: number; h: number } {
  const el = img as HTMLImageElement;
  const w = (el.naturalWidth || (img as ImageBitmap).width) | 0;
  const h = (el.naturalHeight || (img as ImageBitmap).height) | 0;
  return { w, h };
}

/**
 * Calcula la paleta de una imagen dibujándola en un lienzo pequeño
 * (máximo 96 px de lado). Usa el DOM; ante cualquier fallo (contexto 2D no
 * disponible, lienzo contaminado por CORS…) devuelve una lista vacía.
 */
export function paletteFromBitmap(img: ImageSource, count = 6): string[] {
  try {
    const { w, h } = sourceSize(img);
    if (!w || !h) return [];
    const scale = Math.min(1, 96 / Math.max(w, h));
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(img as CanvasImageSource, 0, 0, dw, dh);
    const { data } = ctx.getImageData(0, 0, dw, dh);
    return extractPalette(data, count);
  } catch {
    return [];
  }
}
