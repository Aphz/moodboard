/**
 * Máscara de opacidad de una imagen: dónde hay pixeles y dónde se ve a través.
 *
 * iOS sabe recortar el sujeto de una foto —es lo que hace al crear un sticker—
 * y lo deja en el portapapeles como PNG con transparencia. Al pegarlo, la
 * importación conserva ese alfa, pero para la app la imagen seguía siendo un
 * rectángulo: el fondo recortado tapaba lo que hubiera debajo y se llevaba los
 * toques. Con la máscara, un recorte se comporta como lo que aparenta ser.
 *
 * La máscara es una rejilla gruesa (48×48 celdas, sea cual sea el tamaño de la
 * imagen) con el alfa de cada celda. No pretende ser exacta: lo grueso juega a
 * favor, porque da holgura al dedo sin cálculos extra, y ocupa 2 KB por imagen
 * en vez de los megas del bitmap.
 *
 * Módulo PURO: la rejilla se la pasa quien pueda leer pixeles (`imageCache`).
 */

/** Lado de la rejilla, en celdas. */
export const MASK_SIZE = 48;

/**
 * Alfa mínimo para considerar que en una celda hay algo.
 *
 * Bajo a propósito: al reducir la imagen a la rejilla, una celda que sólo toca
 * el borde del sujeto queda con un alfa pequeño, y ese borde sigue siendo
 * parte de la figura.
 */
export const ALPHA_MIN = 8;

export interface AlphaMask {
  size: number;
  /** Alfa 0..255 por celda, en orden fila por fila. */
  cells: Uint8Array;
  /** `true` si no hay ni una celda transparente: la imagen es un rectángulo. */
  opaque: boolean;
}

/** Recorte por fracciones, como lo guarda `ImageItem`. */
export interface CropFractions {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Arma la máscara a partir del alfa ya muestreado. */
export function makeMask(cells: Uint8Array, size = MASK_SIZE): AlphaMask {
  let opaque = true;
  for (const a of cells) {
    if (a < 255) {
      opaque = false;
      break;
    }
  }
  return { size, cells, opaque };
}

/**
 * Qué parte de la imagen ORIGINAL corresponde a un punto local del ítem.
 *
 * El recorte es la parte incómoda: `w` y `h` son los de la parte visible, así
 * que la fracción dentro de lo visible hay que devolverla al sistema de la
 * imagen completa, que es donde vive la máscara.
 */
export function localToUV(
  local: { x: number; y: number },
  w: number,
  h: number,
  crop?: CropFractions | null
): { u: number; v: number } {
  if (w <= 0 || h <= 0) return { u: -1, v: -1 };
  const fx = (local.x + w / 2) / w;
  const fy = (local.y + h / 2) / h;
  if (!crop) return { u: fx, v: fy };
  return {
    u: crop.left + fx * (1 - crop.left - crop.right),
    v: crop.top + fy * (1 - crop.top - crop.bottom)
  };
}

/** Alfa de la celda que contiene `(u, v)`; fuera de la imagen, 0. */
export function sampleMask(m: AlphaMask, u: number, v: number): number {
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return 0;
  const cx = Math.min(m.size - 1, Math.floor(u * m.size));
  const cy = Math.min(m.size - 1, Math.floor(v * m.size));
  return m.cells[cy * m.size + cx] ?? 0;
}

/**
 * ¿Hay imagen en `(u, v)` o a menos de `(ru, rv)` de ahí?
 *
 * Los radios van en fracciones de la imagen, para que la holgura del dedo
 * signifique lo mismo en una foto enorme y en un sticker chico.
 */
export function maskHit(m: AlphaMask, u: number, v: number, ru = 0, rv = 0): boolean {
  if (m.opaque) return u >= 0 && u < 1 && v >= 0 && v < 1;
  if (sampleMask(m, u, v) >= ALPHA_MIN) return true;
  if (ru <= 0 && rv <= 0) return false;
  // barrido por celdas: la rejilla es gruesa, así que son pocas
  const du = Math.max(1, Math.ceil(ru * m.size));
  const dv = Math.max(1, Math.ceil(rv * m.size));
  const cx = Math.floor(u * m.size);
  const cy = Math.floor(v * m.size);
  for (let y = cy - dv; y <= cy + dv; y++) {
    if (y < 0 || y >= m.size) continue;
    for (let x = cx - du; x <= cx + du; x++) {
      if (x < 0 || x >= m.size) continue;
      // el barrido es un rombo, no un cuadrado: la esquina queda más lejos
      if (Math.abs(x - cx) / du + Math.abs(y - cy) / dv > 1) continue;
      if ((m.cells[y * m.size + x] ?? 0) >= ALPHA_MIN) return true;
    }
  }
  return false;
}
