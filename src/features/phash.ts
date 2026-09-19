/**
 * Hash perceptual (dHash de 64 bits) para detectar imágenes duplicadas o
 * muy parecidas dentro del tablero.
 *
 * El dHash reduce la imagen a 9×8 píxeles en escala de grises y compara cada
 * píxel con su vecino de la derecha: 8 comparaciones por fila × 8 filas = 64
 * bits, que se serializan como 16 caracteres hexadecimales. Es robusto frente
 * a reescalados, recompresión JPEG y cambios suaves de brillo.
 *
 * Todo el módulo es PURO salvo `phashFromBitmap`, que necesita un `<canvas>`.
 */

/** Ancho por defecto de la miniatura interna (8 comparaciones por fila). */
const DEFAULT_W = 9;
/** Alto por defecto de la miniatura interna. */
const DEFAULT_H = 8;
/** Bits del hash. */
const HASH_BITS = 64;

/**
 * Reduce un buffer RGBA a escala de grises con el tamaño indicado, promediando
 * por área (cada píxel destino es la media ponderada de la región de origen que
 * le corresponde, incluyendo coberturas parciales).
 *
 * @param data  Píxeles de origen en RGBA.
 * @param srcW  Ancho de origen en píxeles.
 * @param srcH  Alto de origen en píxeles.
 * @param dstW  Ancho de destino.
 * @param dstH  Alto de destino.
 * @returns     Luminancias 0..255 en orden fila-mayor (`dstW * dstH` valores).
 */
export function grayscaleResize(
  data: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Float32Array {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
    throw new Error('grayscaleResize: dimensiones inválidas');
  }
  if (data.length < srcW * srcH * 4) {
    throw new Error('grayscaleResize: el buffer no cubre srcW × srcH píxeles RGBA');
  }

  // Luminancia de origen precalculada (evita recalcularla en cada solape).
  const gray = new Float32Array(srcW * srcH);
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    gray[i] = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
  }

  const out = new Float32Array(dstW * dstH);
  const sx = srcW / dstW;
  const sy = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const y0 = y * sy;
    const y1 = (y + 1) * sy;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(srcH - 1, Math.ceil(y1) - 1);
    for (let x = 0; x < dstW; x++) {
      const x0 = x * sx;
      const x1 = (x + 1) * sx;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(srcW - 1, Math.ceil(x1) - 1);
      let sum = 0;
      let wsum = 0;
      for (let iy = iy0; iy <= iy1; iy++) {
        const wy = Math.min(iy + 1, y1) - Math.max(iy, y0);
        if (wy <= 0) continue;
        const row = iy * srcW;
        for (let ix = ix0; ix <= ix1; ix++) {
          const wx = Math.min(ix + 1, x1) - Math.max(ix, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          sum += gray[row + ix]! * w;
          wsum += w;
        }
      }
      out[y * dstW + x] = wsum > 0 ? sum / wsum : 0;
    }
  }
  return out;
}

/**
 * Calcula el dHash a partir de una imagen ya reducida a `w × h` en escala de
 * grises (por defecto 9×8). Cada bit indica si un píxel es más claro que su
 * vecino derecho.
 *
 * @returns Hash en hexadecimal (16 caracteres con el tamaño por defecto).
 */
export function dhashFromGray(
  gray: Float32Array | number[],
  w = DEFAULT_W,
  h = DEFAULT_H
): string {
  if (w < 2 || h < 1) throw new Error('dhashFromGray: se necesitan al menos 2×1 píxeles');
  if (gray.length < w * h) throw new Error('dhashFromGray: faltan valores de gris');
  let hex = '';
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w - 1; x++) {
      const bit = (gray[row + x] as number) > (gray[row + x + 1] as number) ? 1 : 0;
      nibble = (nibble << 1) | bit;
      if (++bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  if (bits > 0) hex += (nibble << (4 - bits)).toString(16);
  return hex;
}

/**
 * dHash completo de un buffer RGBA: reduce a 9×8 en gris y compara vecinos.
 *
 * @param data Píxeles en RGBA.
 * @param w    Ancho del buffer.
 * @param h    Alto del buffer.
 */
export function dhash(data: Uint8ClampedArray, w: number, h: number): string {
  return dhashFromGray(grayscaleResize(data, w, h, DEFAULT_W, DEFAULT_H), DEFAULT_W, DEFAULT_H);
}

/** Número de bits puestos en un valor 0..15. */
function popcount4(v: number): number {
  return ((v >> 3) & 1) + ((v >> 2) & 1) + ((v >> 1) & 1) + (v & 1);
}

/**
 * Distancia de Hamming (número de bits distintos) entre dos hashes
 * hexadecimales de la misma longitud.
 */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error('hamming: los hashes deben tener la misma longitud');
  }
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i]!, 16);
    const y = parseInt(b[i]!, 16);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      throw new Error('hamming: hash hexadecimal inválido');
    }
    d += popcount4(x ^ y);
  }
  return d;
}

/** Similitud 0..1 entre dos hashes (1 = idénticos). */
export function similarity(a: string, b: string): number {
  const bits = Math.max(HASH_BITS, a.length * 4);
  return 1 - hamming(a, b) / bits;
}

/** Candidato a comparar: identificador de ítem + su hash perceptual. */
export interface HashCandidate {
  id: string;
  hash: string;
}

/** Resultado de una búsqueda por similitud. */
export interface SimilarMatch {
  id: string;
  score: number;
}

/**
 * Busca los candidatos cuya similitud con `target` alcance el umbral.
 *
 * @param threshold Similitud mínima (0..1). Por defecto 0.85.
 * @returns Coincidencias ordenadas de mayor a menor similitud.
 */
export function findSimilar(
  target: string,
  candidates: HashCandidate[],
  threshold = 0.85
): SimilarMatch[] {
  const out: SimilarMatch[] = [];
  for (const c of candidates) {
    if (!c || typeof c.hash !== 'string' || c.hash.length !== target.length) continue;
    const score = similarity(target, c.hash);
    if (score >= threshold) out.push({ id: c.id, score });
  }
  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return out;
}

/**
 * Agrupa candidatos que probablemente sean la misma imagen usando union-find
 * sobre todas las parejas que superan el umbral (la pertenencia es transitiva).
 *
 * @param threshold Similitud mínima para unir dos imágenes. Por defecto 0.92.
 * @returns Grupos de ids con 2 o más miembros, del más grande al más pequeño.
 */
export function findDuplicateGroups(candidates: HashCandidate[], threshold = 0.92): string[][] {
  const list = candidates.filter((c) => c && typeof c.hash === 'string' && c.hash.length > 0);
  const parent = list.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    let cur = i;
    while (parent[cur] !== cur) {
      const next = parent[cur]!;
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      if (a.hash.length !== b.hash.length) continue;
      if (similarity(a.hash, b.hash) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, string[]>();
  for (let i = 0; i < list.length; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(list[i]!.id);
    else groups.set(r, [list[i]!.id]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

// ---------------------------------------------------------------------------
// Puente con el DOM (no cubierto por tests)

/** Fuente de imagen admitida por `phashFromBitmap`. */
export type HashImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

/**
 * Calcula el dHash de una imagen dibujándola en un lienzo 9×8. Ante cualquier
 * fallo (sin contexto 2D, lienzo contaminado…) devuelve una cadena vacía.
 */
export function phashFromBitmap(img: HashImageSource): string {
  try {
    const el = img as HTMLImageElement;
    const w = (el.naturalWidth || (img as ImageBitmap).width) | 0;
    const h = (el.naturalHeight || (img as ImageBitmap).height) | 0;
    if (!w || !h) return '';
    const canvas = document.createElement('canvas');
    canvas.width = DEFAULT_W;
    canvas.height = DEFAULT_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return '';
    ctx.drawImage(img as CanvasImageSource, 0, 0, DEFAULT_W, DEFAULT_H);
    const { data } = ctx.getImageData(0, 0, DEFAULT_W, DEFAULT_H);
    const gray = new Float32Array(DEFAULT_W * DEFAULT_H);
    for (let i = 0; i < gray.length; i++) {
      const o = i * 4;
      gray[i] = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
    }
    return dhashFromGray(gray, DEFAULT_W, DEFAULT_H);
  } catch {
    return '';
  }
}
