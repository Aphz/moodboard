/**
 * Cliente mínimo de la Messages API de Anthropic, pensado para llamarse
 * DIRECTAMENTE desde el navegador con `fetch` (sin SDK, para no engordar el
 * bundle de la PWA).
 *
 * La clave API la guarda el usuario en este dispositivo (`appSettings.aiApiKey`,
 * persistida en IndexedDB) y viaja en la cabecera `x-api-key`. Para que el
 * navegador pueda hacer la petición cross-origin hace falta además la cabecera
 * `anthropic-dangerous-direct-browser-access: true`, que habilita CORS en el
 * endpoint. Esto expone la clave en el cliente: es aceptable aquí porque la
 * clave es del propio usuario y nunca sale de su dispositivo salvo hacia la API.
 *
 * Modelo por defecto: `appSettings.aiModel` (ver `DEFAULT_MODEL`).
 */
import { appSettings } from '../core/settings';

/** Endpoint de la Messages API. */
const API_URL = 'https://api.anthropic.com/v1/messages';

/** Versión de la API (cabecera `anthropic-version`). */
const API_VERSION = '2023-06-01';

/** Cabecera que habilita el acceso directo desde el navegador (CORS). */
const BROWSER_HEADER = 'anthropic-dangerous-direct-browser-access';

/** Modelo por defecto si `appSettings.aiModel` está vacío. */
const DEFAULT_MODEL = 'claude-sonnet-5';

/** Tiempo máximo por petición (ms). */
const TIMEOUT_MS = 60_000;

/** Máximo de imágenes por llamada. */
const MAX_IMAGES = 20;

/** Idiomas soportados por los prompts. */
export type AiLang = 'es' | 'en';

/** Bloque de contenido admitido por esta integración (texto o imagen JPEG). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: 'image/jpeg'; data: string };
    };

/** Error de la capa IA; `status` es el código HTTP cuando lo hay. */
export class AiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AiError';
    this.status = status;
  }
}

/** ¿Hay clave API guardada en este dispositivo? */
export function aiAvailable(): boolean {
  return appSettings.aiApiKey.trim().length > 0;
}

/** Versión ofuscada de una clave: sólo se muestran los últimos 4 caracteres. */
export function redactKey(key: string): string {
  const k = key.trim();
  if (!k) return '';
  if (k.length <= 4) return '•'.repeat(k.length);
  return '•'.repeat(Math.min(8, k.length - 4)) + k.slice(-4);
}

// ---------------------------------------------------------------------------
// Llamada HTTP

interface ApiTextBlock {
  type: string;
  text?: string;
}

interface ApiResponse {
  content?: ApiTextBlock[];
}

/** Construye el AiError adecuado a partir de una respuesta HTTP fallida. */
async function errorFromResponse(res: Response): Promise<AiError> {
  if (res.status === 401) return new AiError('clave inválida', 401);
  if (res.status === 429) return new AiError('límite de uso', 429);
  let detail = `error ${res.status}`;
  try {
    const body: unknown = await res.json();
    const msg = (body as { error?: { message?: string } } | null)?.error?.message;
    if (typeof msg === 'string' && msg) detail = msg;
  } catch {
    try {
      const txt = await res.text();
      if (txt) detail = txt.slice(0, 300);
    } catch {
      /* cuerpo ilegible: se mantiene el mensaje genérico */
    }
  }
  return new AiError(detail, res.status);
}

/**
 * POST a la Messages API con un único turno de usuario.
 * Devuelve el texto concatenado de los bloques `text` de la respuesta.
 */
async function callClaude(opts: {
  system: string;
  content: ContentBlock[];
  maxTokens?: number;
  json?: boolean;
}): Promise<string> {
  const key = appSettings.aiApiKey.trim();
  if (!key) throw new AiError('no hay clave API configurada');

  const system = opts.json
    ? `${opts.system}\n\nResponde ÚNICAMENTE con JSON válido, sin explicaciones, sin comentarios y sin vallas de código.`
    : opts.system;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
        [BROWSER_HEADER]: 'true'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: appSettings.aiModel || DEFAULT_MODEL,
        max_tokens: opts.maxTokens ?? 1024,
        system,
        messages: [{ role: 'user', content: opts.content }]
      })
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'AbortError') throw new AiError('tiempo de espera agotado (60 s)');
    throw new AiError('no se pudo contactar con la API');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw await errorFromResponse(res);

  let data: ApiResponse;
  try {
    data = (await res.json()) as ApiResponse;
  } catch {
    throw new AiError('respuesta ilegible de la API');
  }
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  if (!text) throw new AiError('respuesta vacía de la API');
  return text;
}

// ---------------------------------------------------------------------------
// Utilidades

/** Nombre del idioma para los prompts. */
function langName(lang: AiLang): string {
  return lang === 'es' ? 'español' : 'inglés (English)';
}

/** Instrucción común: idioma y prohibición de inventar. */
function baseRules(lang: AiLang): string {
  return (
    `Responde siempre en ${langName(lang)}. ` +
    'No inventes contenido: describe únicamente lo que se ve en las imágenes y lo que dicen las notas. ' +
    'Si algo no se puede saber a partir del material, dilo en lugar de suponerlo.'
  );
}

/**
 * Extrae el primer objeto JSON `{...}` de un texto (tolerante a prosa alrededor
 * o a vallas de código). Devuelve `null` si no hay ninguno equilibrado.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parsea con tolerancia un objeto JSON incrustado en la respuesta del modelo. */
function parseJsonLoose(text: string): unknown {
  const raw = extractJsonObject(text);
  if (!raw) throw new AiError('la respuesta no contenía JSON');
  try {
    return JSON.parse(raw);
  } catch {
    throw new AiError('la respuesta contenía JSON inválido');
  }
}

/** Bloque de imagen JPEG en base64 (sin el prefijo `data:`). */
function imageBlock(jpegBase64: string): ContentBlock {
  const data = jpegBase64.includes(',') ? jpegBase64.slice(jpegBase64.indexOf(',') + 1) : jpegBase64;
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } };
}

/** Parte un array en lotes de como mucho `size` elementos. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Normaliza una etiqueta: minúsculas, sin `#` ni espacios sobrantes. */
function normalizeTag(t: unknown): string | null {
  if (typeof t !== 'string') return null;
  const s = t.replace(/^#+/, '').trim().toLowerCase();
  return s ? s : null;
}

// ---------------------------------------------------------------------------
// Funciones de alto nivel

/**
 * Analiza el moodboard (hasta 20 imágenes + textos de las notas) y devuelve un
 * markdown breve (≤ 250 palabras) con dirección visual, paleta, temas,
 * referencias y sugerencias de qué falta.
 */
export async function describeBoard(input: {
  images: { name: string; jpegBase64: string }[];
  notes: string[];
  lang: AiLang;
}): Promise<string> {
  const images = input.images.slice(0, MAX_IMAGES);
  const content: ContentBlock[] = [];
  for (const img of images) {
    content.push({ type: 'text', text: `Imagen: ${img.name}` });
    content.push(imageBlock(img.jpegBase64));
  }
  const notes = input.notes.map((n) => n.trim()).filter(Boolean);
  content.push({
    type: 'text',
    text:
      (notes.length ? `Notas del tablero:\n- ${notes.join('\n- ')}\n\n` : 'El tablero no tiene notas.\n\n') +
      'Analiza este moodboard.'
  });

  const system =
    `Eres un director de arte que analiza moodboards. ${baseRules(input.lang)} ` +
    'Escribe markdown breve, máximo 250 palabras, con estas secciones: dirección visual, paleta, ' +
    'temas, referencias (estilos/épocas/medios reconocibles) y qué falta o qué añadirías. ' +
    'Sé concreto y evita adjetivos vacíos.';

  return callClaude({ system, content, maxTokens: 1024 });
}

/**
 * Etiqueta imágenes (3-6 etiquetas por imagen, en minúsculas y sin `#`).
 * Procesa en lotes secuenciales de 20 imágenes y devuelve `{ id: tags[] }`.
 */
export async function tagImages(input: {
  images: { id: string; name: string; jpegBase64: string }[];
  lang: AiLang;
}): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const system =
    `Eres un catalogador de referencias visuales. ${baseRules(input.lang)} ` +
    'Para cada imagen devuelve entre 3 y 6 etiquetas en minúsculas, sin almohadilla y sin espacios ' +
    'al principio o al final (tema, estilo, color dominante, medio, ambiente). ' +
    'Responde SOLO con un objeto JSON cuyas claves sean exactamente los identificadores dados: ' +
    '{ "<id>": ["etiqueta", ...] }.';

  for (const batch of chunk(input.images, MAX_IMAGES)) {
    const content: ContentBlock[] = [];
    for (const img of batch) {
      content.push({ type: 'text', text: `id: ${img.id} — nombre: ${img.name}` });
      content.push(imageBlock(img.jpegBase64));
    }
    content.push({
      type: 'text',
      text: `Etiqueta cada imagen. Identificadores: ${batch.map((i) => i.id).join(', ')}.`
    });

    const text = await callClaude({ system, content, maxTokens: 1024, json: true });
    const parsed = parseJsonLoose(text) as Record<string, unknown>;
    for (const [id, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const tags = value.map(normalizeTag).filter((t): t is string => t !== null);
      if (tags.length) out[id] = tags.slice(0, 6);
    }
  }
  return out;
}

/** Agrupa ítems por tema. */
export async function suggestArrangement(input: {
  items: { id: string; name: string; tags: string[]; palette: string[] }[];
  lang: AiLang;
}): Promise<{ groups: { title: string; ids: string[] }[] }> {
  const system =
    `Eres un director de arte que organiza un moodboard. ${baseRules(input.lang)} ` +
    'Agrupa los ítems por tema o afinidad visual usando sólo los datos dados (nombre, etiquetas, paleta). ' +
    'Cada ítem debe aparecer en un único grupo y cada grupo necesita un título corto. ' +
    'Responde SOLO con JSON: { "groups": [ { "title": "...", "ids": ["..."] } ] }.';

  const content: ContentBlock[] = [
    {
      type: 'text',
      text:
        'Ítems del tablero (JSON):\n' +
        JSON.stringify(
          input.items.map((i) => ({ id: i.id, name: i.name, tags: i.tags, palette: i.palette })),
          null,
          0
        )
    }
  ];

  const text = await callClaude({ system, content, maxTokens: 1024, json: true });
  const parsed = parseJsonLoose(text) as { groups?: unknown };
  const raw = Array.isArray(parsed.groups) ? parsed.groups : [];
  const groups: { title: string; ids: string[] }[] = [];
  for (const g of raw) {
    const obj = g as { title?: unknown; ids?: unknown };
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const ids = Array.isArray(obj.ids) ? obj.ids.filter((x): x is string => typeof x === 'string') : [];
    if (title && ids.length) groups.push({ title, ids });
  }
  return { groups };
}
