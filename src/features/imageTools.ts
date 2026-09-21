/**
 * Utilidades de imagen que dependen del DOM: decodificación, reescalado,
 * recodificación, miniaturas y descarga remota.
 *
 * Todo lo que toca `canvas`/`fetch` vive aquí para que `palette.ts` y
 * `phash.ts` sigan siendo puros y testeables. Los blobs resultantes se
 * guardan con `putBlob()` de `src/core/persistence.ts`.
 */

/** Lienzo real o fuera de pantalla. */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Fuente de imagen dibujable en un lienzo. */
export type DrawableImage = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

/** Extensiones de archivo que tratamos como imagen. */
const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'heic',
  'heif',
  'avif',
  'bmp',
  'svg'
];

/** Tipos MIME que pueden llevar canal alfa. */
const ALPHA_TYPES = ['image/png', 'image/gif', 'image/webp', 'image/avif'];

/** Caché del soporte de WebP en la codificación de lienzos. */
let webpSupport: boolean | null = null;

// ---------------------------------------------------------------------------
// Lienzos

/** Crea un lienzo fuera de pantalla si el navegador lo permite. */
function createCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Obtiene el contexto 2D de cualquier tipo de lienzo. */
function get2d(canvas: AnyCanvas, opts?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const ctx = (canvas as unknown as HTMLCanvasElement).getContext('2d', opts) as
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('No se pudo obtener el contexto 2D del lienzo');
  return ctx;
}

/** Codifica un lienzo a `Blob` (soporta `OffscreenCanvas` y `<canvas>`). */
function canvasToBlob(canvas: AnyCanvas, type: string, quality?: number): Promise<Blob> {
  const off = canvas as OffscreenCanvas;
  if (typeof off.convertToBlob === 'function') {
    return off.convertToBlob({ type, quality });
  }
  const el = canvas as HTMLCanvasElement;
  return new Promise<Blob>((resolve, reject) => {
    el.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('El lienzo no pudo codificarse a imagen'))),
      type,
      quality
    );
  });
}

/** Tamaño natural de una fuente de imagen. */
function sizeOf(img: DrawableImage): { w: number; h: number } {
  const el = img as HTMLImageElement;
  return {
    w: (el.naturalWidth || (img as ImageBitmap).width) | 0,
    h: (el.naturalHeight || (img as ImageBitmap).height) | 0
  };
}

/** Comprueba (una sola vez) si el navegador codifica WebP desde un lienzo. */
async function supportsWebp(): Promise<boolean> {
  if (webpSupport !== null) return webpSupport;
  try {
    const c = createCanvas(1, 1);
    get2d(c).clearRect(0, 0, 1, 1);
    const b = await canvasToBlob(c, 'image/webp');
    webpSupport = b.type === 'image/webp';
  } catch {
    webpSupport = false;
  }
  return webpSupport;
}

// ---------------------------------------------------------------------------
// Decodificación

/**
 * Decodifica un `Blob` a `ImageBitmap` respetando la orientación EXIF.
 * Si `createImageBitmap` no admite opciones (Safari antiguo) reintenta sin
 * ellas y, como último recurso, decodifica con un `<img>` y una object URL.
 */
export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      try {
        return await createImageBitmap(blob);
      } catch {
        /* se prueba con <img> */
      }
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.decoding = 'async';
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('No se pudo decodificar la imagen'));
      el.src = url;
    });
    if (typeof createImageBitmap === 'function') return await createImageBitmap(img);
    throw new Error('Este navegador no admite createImageBitmap');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Detecta un GIF animado (más de un bloque de control gráfico). */
function isAnimatedGif(bytes: Uint8Array): boolean {
  let frames = 0;
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] === 0x00 && bytes[i + 1] === 0x21 && bytes[i + 2] === 0xf9 && bytes[i + 3] === 0x04) {
      if (++frames > 1) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Optimización

/** Resultado de `optimizeImage`. */
export interface OptimizedImage {
  blob: Blob;
  w: number;
  h: number;
  /** `false` si se devuelve el blob original sin tocar. */
  changed: boolean;
}

/**
 * Reescala y recodifica una imagen para ahorrar memoria y espacio.
 *
 * - Si el lado mayor supera `maxSide` (y `maxSide > 0`) se reescala.
 * - Se codifica a WebP si el navegador puede; si no, a JPEG.
 * - Si el original puede tener alfa (PNG/GIF/WebP/AVIF) se conserva la
 *   transparencia usando WebP o PNG.
 * - Los GIF animados se devuelven intactos (`changed: false`).
 *
 * Siempre devuelve el ancho y alto finales.
 */
export async function optimizeImage(
  blob: Blob,
  maxSide: number,
  quality: number
): Promise<OptimizedImage> {
  const type = (blob.type || '').toLowerCase();

  if (type === 'image/gif') {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (isAnimatedGif(bytes)) {
      const bmp = await decodeImage(blob).catch(() => null);
      const w = bmp?.width ?? 0;
      const h = bmp?.height ?? 0;
      bmp?.close?.();
      return { blob, w, h, changed: false };
    }
  }

  const bmp = await decodeImage(blob);
  const srcW = bmp.width;
  const srcH = bmp.height;
  const longest = Math.max(srcW, srcH);
  const scale = maxSide > 0 && longest > maxSide ? maxSide / longest : 1;
  const dw = Math.max(1, Math.round(srcW * scale));
  const dh = Math.max(1, Math.round(srcH * scale));

  const hasAlpha = ALPHA_TYPES.includes(type);
  const webp = await supportsWebp();
  let outType: string;
  if (hasAlpha) outType = webp ? 'image/webp' : 'image/png';
  else outType = webp ? 'image/webp' : 'image/jpeg';

  // Nada que ganar: mismo tamaño y mismo formato.
  if (scale === 1 && outType === type) {
    bmp.close?.();
    return { blob, w: srcW, h: srcH, changed: false };
  }

  try {
    const canvas = createCanvas(dw, dh);
    const ctx = get2d(canvas, { alpha: hasAlpha });
    if (!hasAlpha) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, dw, dh);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, dw, dh);
    const out = await canvasToBlob(canvas, outType, quality);
    // Si recodificar no compensa y tampoco hubo reescalado, conservamos el original.
    if (scale === 1 && out.size >= blob.size) {
      return { blob, w: srcW, h: srcH, changed: false };
    }
    return { blob: out, w: dw, h: dh, changed: true };
  } catch {
    return { blob, w: srcW, h: srcH, changed: false };
  } finally {
    bmp.close?.();
  }
}

/** Codifica un `ImageBitmap` a `Blob` con el tipo y calidad indicados. */
export async function bitmapToBlob(
  bmp: ImageBitmap,
  type = 'image/png',
  quality?: number
): Promise<Blob> {
  const canvas = createCanvas(bmp.width, bmp.height);
  const ctx = get2d(canvas);
  ctx.drawImage(bmp, 0, 0);
  return canvasToBlob(canvas, type, quality);
}

/**
 * Rasteriza una imagen en un lienzo pequeño y devuelve sus píxeles, listos
 * para `extractPalette()` o `dhash()`.
 *
 * @param maxSide Lado máximo del lienzo auxiliar (128 px por defecto).
 */
export function imageDataOf(img: ImageBitmap | HTMLImageElement, maxSide = 128): ImageData {
  const { w, h } = sizeOf(img);
  if (!w || !h) throw new Error('La imagen no tiene dimensiones válidas');
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = get2d(canvas, { willReadFrequently: true });
  ctx.drawImage(img as CanvasImageSource, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh);
}

/**
 * Genera una miniatura JPEG (calidad 0.8) a partir de un lienzo o un bitmap.
 *
 * @param maxSide Lado mayor de la miniatura (320 px por defecto).
 */
export async function makeThumbnail(
  canvasOrBitmap: DrawableImage,
  maxSide = 320
): Promise<Blob> {
  const { w, h } = sizeOf(canvasOrBitmap);
  if (!w || !h) throw new Error('No hay nada que miniaturizar');
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const canvas = createCanvas(dw, dh);
  const ctx = get2d(canvas, { alpha: false });
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, dw, dh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvasOrBitmap as CanvasImageSource, 0, 0, dw, dh);
  return canvasToBlob(canvas, 'image/jpeg', 0.8);
}

// ---------------------------------------------------------------------------
// Entrada de archivos y red

/**
 * Descarga una imagen por URL validando que la respuesta sea `image/*`.
 * Lanza un `Error` con mensaje legible en español si algo falla.
 */
export async function fetchImageBlob(url: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(url, { mode: 'cors' });
  } catch {
    throw new Error(`No se pudo descargar la imagen (¿sin conexión o bloqueada por CORS?): ${url}`);
  }
  if (!res.ok) {
    throw new Error(`La descarga falló con estado ${res.status} ${res.statusText || ''}`.trim());
  }
  const blob = await res.blob();
  const type = (blob.type || res.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('image/')) {
    throw new Error(`La URL no apunta a una imagen (tipo recibido: ${type || 'desconocido'})`);
  }
  return blob.type ? blob : new Blob([blob], { type });
}

/** Indica si un archivo parece una imagen, por tipo MIME o por extensión. */
export function isImageFile(file: File): boolean {
  if (file.type && file.type.toLowerCase().startsWith('image/')) return true;
  const name = (file.name || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.includes(name.slice(dot + 1));
}

/** Formatea un tamaño en bytes como texto legible (B, KB, MB, GB). */
export function bytesToHuman(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
