/**
 * Importar un tablero (o un pin) de Pinterest a partir de su enlace, sin
 * servidor propio.
 *
 * Pinterest no envía cabeceras CORS ni en sus páginas ni en su CDN de imágenes,
 * así que una app web no puede leerlos directamente. Se apoya en dos servicios
 * públicos que sí las envían:
 *
 *  - **r.jina.ai** (Jina Reader): devuelve el HTML de la página del tablero ya
 *    renderizado. De ahí sale el JSON `__PWS_INITIAL_PROPS__` con los primeros
 *    ~25 pines (`BoardFeedResource`) y, con el mismo lector, el RSS del tablero
 *    con los 25 más recientes. La unión suele cubrir tableros de hasta 40-50
 *    pines; en tableros más grandes entra sólo esa parte (Pinterest exige
 *    sesión para paginar el resto).
 *  - **wsrv.nl** (images.weserv.nl): proxy de imágenes con `Access-Control-
 *    Allow-Origin: *` que además reduce al tamaño pedido. Se pide el original
 *    de cada pin a 1600 px como máximo.
 *
 * Sólo pasan por esos servicios el enlace del tablero y las URL públicas de
 * las imágenes; nunca datos de la cuenta del usuario.
 *
 * Todo lo que no hace red es puro y está probado en `tests/pinterest.test.ts`.
 */

/** Lector de páginas con CORS. */
export const READER_BASE = 'https://r.jina.ai/';

/** Proxy de imágenes con CORS y reducción de tamaño. */
export const IMAGE_PROXY = 'https://wsrv.nl/';

/** Lado máximo con el que se piden las imágenes al proxy. */
export const PIN_MAX_SIDE = 1600;

/** Tope de pines que se traen de una vez. */
export const MAX_PINS = 250;

/** Lado de las miniaturas del selector (las 236x del CDN bastan). */
export const PIN_THUMB_SIDE = 320;

/** Error del lector o del proxy, con el motivo ya clasificado. */
export class PinterestError extends Error {
  /** `reader-busy` (429/401 del lector), `not-found`, `no-pins`, `network`. */
  kind: 'reader-busy' | 'not-found' | 'no-pins' | 'network';
  constructor(kind: PinterestError['kind'], message: string) {
    super(message);
    this.name = 'PinterestError';
    this.kind = kind;
  }
}

/** Descargas simultáneas. */
const CONCURRENCY = 4;

/** Una imagen de pin: `hash` es la ruta `aa/bb/cc/<md5>` que comparten todas sus variantes. */
export interface PinImage {
  /** Identificador estable (id del pin si se conoce; si no, el hash). */
  id: string;
  /** Ruta común de las variantes en el CDN, sin tamaño ni extensión. */
  hash: string;
  /** Extensión del original (`jpg`, `png`, `gif`, `webp`). */
  ext: string;
  /** Mejor URL conocida (original si está en los datos del tablero). */
  url: string;
  w?: number;
  h?: number;
}

export interface BoardInfo {
  title: string;
  /** URL canónica del tablero o pin, ya resuelta (sin `pin.it`). */
  canonicalUrl: string;
  /** Pines que declara el tablero, si se sabe (para avisar si entran menos). */
  pinCount: number | null;
  pins: PinImage[];
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// URLs

const PINIMG = /https?:\/\/i\.pinimg\.com\/(originals|\d+x(?:\d+)?)\/([0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32})\.([a-z0-9]+)/gi;

/** ¿Parece un enlace de Pinterest (tablero, pin o acortador `pin.it`)? */
export function isPinterestUrl(text: string): boolean {
  return normalizePinterestUrl(text) !== null;
}

/**
 * Limpia un enlace de Pinterest: admite sin `https://`, `pin.it/…`,
 * `pinterest.com`, `cl.pinterest.com`, `pinterest.es`, etc. Devuelve `null`
 * si no es de Pinterest.
 */
export function normalizePinterestUrl(text: string): string | null {
  const raw = (text ?? '').trim();
  if (!raw || /\s/.test(raw)) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const ok = host === 'pin.it' || host === 'pinterest.com' || /(^|\.)pinterest\.[a-z.]+$/.test(host);
  if (!ok) return null;
  u.protocol = 'https:';
  u.hash = '';
  return u.toString();
}

/** URL que se pide al lector para obtener `target`. */
export function readerUrl(target: string): string {
  return READER_BASE + target;
}

/**
 * RSS público de un tablero (`https://host/usuario/tablero.rss`), o `null` si
 * la URL no tiene forma de tablero (un pin, un perfil, `pin.it`…).
 */
export function rssUrlFor(boardUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(boardUrl);
  } catch {
    return null;
  }
  if (u.hostname === 'pin.it') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [user, board] = parts as [string, string];
  if (/^(pin|search|ideas|settings|business|today|explore|_)$/i.test(user)) return null;
  return `${u.protocol}//${u.hostname}/${user}/${board}.rss`;
}

/** URL de una variante del CDN para un pin. */
export function variantUrl(pin: PinImage, variant: 'originals' | '736x' | '236x'): string {
  const ext = variant === 'originals' ? pin.ext : 'jpg';
  return `https://i.pinimg.com/${variant}/${pin.hash}.${ext}`;
}

/** Miniatura del pin para el selector, a través del proxy. */
export function thumbUrl(pin: PinImage): string {
  return proxiedImageUrl(variantUrl(pin, '236x'), PIN_THUMB_SIDE);
}

/** URL de la imagen a través del proxy, reducida a `maxSide` y en JPEG. */
export function proxiedImageUrl(url: string, maxSide = PIN_MAX_SIDE): string {
  const bare = url.replace(/^https?:\/\//i, '');
  return `${IMAGE_PROXY}?url=${encodeURIComponent(bare)}&w=${maxSide}&h=${maxSide}&fit=inside&we=1&output=jpg&q=88`;
}

// ---------------------------------------------------------------------------
// Parseo

/** Une listas de pines quitando repetidos por hash; conserva el primero. */
export function mergePins(...lists: PinImage[][]): PinImage[] {
  const seen = new Map<string, PinImage>();
  for (const list of lists) for (const p of list) if (!seen.has(p.hash)) seen.set(p.hash, p);
  return [...seen.values()];
}

interface PinImages {
  orig?: { url?: string; width?: number; height?: number };
  [k: string]: { url?: string; width?: number; height?: number } | undefined;
}

/** Convierte un objeto `images` de Pinterest en `PinImage`, o `null`. */
function pinFromImages(id: string, images: PinImages | undefined): PinImage | null {
  if (!images) return null;
  const best = images.orig ?? images['736x'] ?? images['474x'] ?? images['236x'];
  if (!best?.url) return null;
  const m = new RegExp(PINIMG.source, 'i').exec(best.url);
  if (!m) return null;
  return { id, hash: m[2]!, ext: m[3]!.toLowerCase(), url: best.url, w: best.width, h: best.height };
}

/** Recorre un valor JSON llamando a `visit` con cada objeto. */
function walk(value: unknown, visit: (obj: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 40 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  visit(obj);
  for (const v of Object.values(obj)) walk(v, visit, depth + 1);
}

/** JSON incrustado `__PWS_INITIAL_PROPS__` (o `__PWS_DATA__`), o `null`. */
function initialProps(html: string): unknown {
  for (const id of ['__PWS_INITIAL_PROPS__', '__PWS_DATA__']) {
    const m = new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`, 'i').exec(html);
    if (!m) continue;
    try {
      return JSON.parse(m[1]!);
    } catch {
      /* siguiente candidato */
    }
  }
  return null;
}

/**
 * Pines de la página de un tablero (o de un pin). Primero los datos
 * estructurados (`BoardFeedResource`, `PinResource`), que sólo contienen los
 * pines del tablero; si no hay, cualquier imagen grande del CDN que aparezca en
 * el HTML (sin avatares ni miniaturas pequeñas).
 */
export function pinsFromBoardHtml(html: string): PinImage[] {
  const props = initialProps(html);
  const fromFeed: PinImage[] = [];
  const fromPin: PinImage[] = [];
  if (props) {
    walk(props, (obj) => {
      if (typeof obj.type === 'string' && obj.type === 'pin' && obj.images && typeof obj.images === 'object') {
        const id = typeof obj.id === 'string' ? obj.id : '';
        const p = pinFromImages(id, obj.images as PinImages);
        if (!p) return;
        // los pines del feed llevan `image_signature`; los "relacionados" no siempre, pero sí `type: pin`
        (obj.image_signature ? fromFeed : fromPin).push(p);
      }
    });
  }
  const structured = mergePins(fromFeed, fromPin);
  if (structured.length) return structured;

  // último recurso: URLs grandes del CDN en el HTML
  const out: PinImage[] = [];
  for (const m of html.matchAll(PINIMG)) {
    const variant = m[1]!.toLowerCase();
    const size = variant === 'originals' ? Infinity : parseInt(variant, 10);
    if (size < 236) continue;
    out.push({ id: m[2]!, hash: m[2]!, ext: m[3]!.toLowerCase(), url: m[0]! });
  }
  return mergePins(out);
}

/** Pines del RSS de un tablero (imágenes `236x`, elevadas al original). */
export function pinsFromRss(text: string): PinImage[] {
  const out: PinImage[] = [];
  for (const m of text.matchAll(PINIMG)) {
    const hash = m[2]!;
    // el <link> del ítem precede a su imagen: el último enlace de pin antes de la imagen
    const before = text.slice(Math.max(0, m.index! - 400), m.index);
    const pinId = [...before.matchAll(/pinterest\.[a-z.]+\/pin\/(\d+)/gi)].at(-1)?.[1];
    out.push({ id: pinId ?? hash, hash, ext: m[3]!.toLowerCase(), url: `https://i.pinimg.com/originals/${hash}.${m[3]!.toLowerCase()}` });
  }
  return mergePins(out);
}

/**
 * Título, URL canónica y número de pines del tablero. Sale del objeto
 * `type: "board"` del JSON incrustado; si no está (página de un pin), del
 * `<title>` y de la URL pedida.
 */
export function boardMetaFromHtml(html: string, fallbackUrl: string): { title: string; canonicalUrl: string; pinCount: number | null } {
  const props = initialProps(html);
  let b: Record<string, unknown> | null = null;
  if (props) {
    walk(props, (obj) => {
      if (!b && obj.type === 'board' && typeof obj.url === 'string') b = obj;
    });
  }
  b = b as Record<string, unknown> | null;
  const title = (typeof b?.name === 'string' && b.name.trim()) || (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+on Pinterest\s*$/i, '').replace(/\s+/g, ' ').trim();
  const canonicalUrl = typeof b?.url === 'string' && b.url.startsWith('/') ? `https://www.pinterest.com${b.url}` : fallbackUrl;
  const pinCount = typeof b?.pin_count === 'number' ? b.pin_count : null;
  return { title: title || 'Pinterest', canonicalUrl, pinCount };
}

// ---------------------------------------------------------------------------
// Red

/**
 * Lee el tablero por su enlace: página (HTML) y, si tiene forma de tablero,
 * también su RSS; devuelve la unión de pines.
 *
 * @throws Error legible si el lector no responde o la página no tiene pines.
 */
export async function fetchBoard(link: string, fetchFn: FetchFn = fetch, onProgress?: (msg: string) => void): Promise<BoardInfo> {
  const target = normalizePinterestUrl(link);
  if (!target) throw new PinterestError('not-found', 'no es un enlace de Pinterest');

  onProgress?.('board');
  let res: Response;
  try {
    res = await fetchFn(readerUrl(target), { headers: { 'X-Return-Format': 'html' } });
  } catch {
    throw new PinterestError('network', 'sin conexión con el lector');
  }
  if (!res.ok) {
    // el lector público limita las consultas anónimas por IP
    if (res.status === 401 || res.status === 429) throw new PinterestError('reader-busy', `lector saturado (${res.status})`);
    if (res.status === 404) throw new PinterestError('not-found', 'el enlace no existe o es privado');
    throw new PinterestError('network', `el lector respondió ${res.status}`);
  }
  const html = await res.text();
  const meta = boardMetaFromHtml(html, target);
  let pins = pinsFromBoardHtml(html);

  const rss = rssUrlFor(meta.canonicalUrl) ?? rssUrlFor(target);
  if (rss) {
    onProgress?.('rss');
    try {
      const r = await fetchFn(readerUrl(rss));
      if (r.ok) pins = mergePins(pins, pinsFromRss(await r.text()));
    } catch {
      /* el RSS es un extra */
    }
  }
  if (!pins.length) throw new PinterestError('no-pins', 'no se encontraron pines en ese enlace');
  return { title: meta.title, canonicalUrl: meta.canonicalUrl, pinCount: meta.pinCount, pins: pins.slice(0, MAX_PINS) };
}

/**
 * Descarga las imágenes por el proxy (original → 736x → 236x), con
 * `CONCURRENCY` descargas a la vez. Devuelve sólo las que llegaron bien.
 */
export async function downloadPins(
  pins: PinImage[],
  opts: { fetchFn?: FetchFn; maxSide?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<{ blob: Blob; name: string; pin: PinImage }[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const out: { blob: Blob; name: string; pin: PinImage }[] = new Array(pins.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < pins.length) {
      const i = next++;
      const pin = pins[i]!;
      const candidates = [pin.url, variantUrl(pin, 'originals'), variantUrl(pin, '736x'), variantUrl(pin, '236x')];
      for (const url of [...new Set(candidates)]) {
        try {
          const res = await fetchFn(proxiedImageUrl(url, opts.maxSide));
          if (!res.ok) continue;
          const blob = await res.blob();
          if (!blob.size || !(blob.type || '').startsWith('image/')) continue;
          out[i] = { blob, name: `pin-${pin.id}.jpg`, pin };
          break;
        } catch {
          /* siguiente variante */
        }
      }
      done++;
      opts.onProgress?.(done, pins.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pins.length) }, worker));
  return out.filter(Boolean);
}
