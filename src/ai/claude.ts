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
 * Costo: cada llamada se cobra en la cuenta de Anthropic del usuario. Por eso
 * el modelo por defecto es el más barato de la tabla (`DEFAULT_AI_MODEL`,
 * Haiku 4.5), todas las funciones devuelven el consumo real (`usage`) y existe
 * un contador acumulado local (`recordUsage` / `getAiUsage` / `resetAiUsage`).
 */
import { appSettings } from '../core/settings';
import { cleanSymbols } from '../features/ornaments';
import { getKV, setKV } from '../core/persistence';
import { DEFAULT_AI_MODEL, isKnownModel, usageToUsd, type UsageEstimate } from './pricing';

/** Endpoint de la Messages API. */
const API_URL = 'https://api.anthropic.com/v1/messages';

/** Versión de la API (cabecera `anthropic-version`). */
const API_VERSION = '2023-06-01';

/** Cabecera que habilita el acceso directo desde el navegador (CORS). */
const BROWSER_HEADER = 'anthropic-dangerous-direct-browser-access';

/** Tiempo máximo por petición (ms). */
const TIMEOUT_MS = 60_000;

/** Máximo de imágenes por llamada (y tamaño de lote al etiquetar). */
const MAX_IMAGES = 20;

/** Tope de salida al describir el tablero (texto breve). */
export const MAX_TOKENS_DESCRIBE = 600;

/** Tope de salida por lote al etiquetar (sólo devuelve un JSON corto). */
export const MAX_TOKENS_TAG = 400;

/** Tope de salida al sugerir agrupaciones (JSON corto). */
export const MAX_TOKENS_ARRANGE = 600;

/** Tope de salida por lote al clasificar en categorías (JSON corto). */
export const MAX_TOKENS_CLASSIFY = 500;

/** Tope de salida al sugerir simbología (mood + una lista corta de signos). */
export const MAX_TOKENS_ORNAMENTS = 300;

/** Máximo de imágenes que se envían al sugerir simbología (sólo si faltan etiquetas). */
const ORNAMENT_IMAGES = 6;

/** Máximo de categorías que la IA puede proponer por sí sola. */
export const MAX_AD_HOC_CATEGORIES = 7;

/** Categoría de respaldo para lo que no encaja en ninguna otra. */
export const OTHER_CATEGORY: Record<AiLang, string> = { es: 'Otros', en: 'Other' };

/** Idiomas soportados por los prompts. */
export type AiLang = 'es' | 'en';

/** Consumo de una o varias llamadas, con su costo en dólares. */
export type AiUsage = UsageEstimate;

/** Contador acumulado guardado en este dispositivo. */
export interface AiUsageTotals extends AiUsage {
  /** Número de llamadas a la API contabilizadas. */
  calls: number;
}

/** Clave del contador acumulado en el almacén kv de IndexedDB. */
const USAGE_KEY = 'aiUsage';

/** Bloque de contenido admitido por esta integración (texto o imagen JPEG). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: 'image/jpeg'; data: string };
    };

/**
 * Mensaje de saldo agotado. La API de Anthropic se paga aparte de la
 * suscripción de Claude.ai: los créditos se compran en console.anthropic.com.
 */
export const NO_CREDIT =
  'Sin saldo en la API de Anthropic. Es una cuenta aparte de la suscripción de Claude.ai: ' +
  'compra créditos en console.anthropic.com → Plans & Billing (Billing).';

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
/**
 * ¿Tiene forma de clave de Anthropic? Sirve para no guardar por error una
 * cadena vacía, el texto ofuscado o una contraseña que iOS haya autocompletado
 * en el campo: la clave sólo se ve una vez en la consola, así que perderla
 * obliga a crear otra.
 */
export function isApiKeyLike(value: string): boolean {
  const v = (value ?? '').trim();
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(v);
}

export function redactKey(key: string): string {
  const k = key.trim();
  if (!k) return '';
  if (k.length <= 4) return '•'.repeat(k.length);
  return '•'.repeat(Math.min(8, k.length - 4)) + k.slice(-4);
}

/**
 * Modelo que se usará en la próxima llamada: el elegido en ajustes si está en
 * la tabla de precios, si no el por defecto (el más económico).
 */
export function resolveModel(): string {
  const m = appSettings.aiModel.trim();
  return isKnownModel(m) ? m : DEFAULT_AI_MODEL;
}

// ---------------------------------------------------------------------------
// Contador de consumo (local, en IndexedDB kv)

/** Consumo en cero, útil como acumulador inicial. */
export function emptyUsage(): AiUsage {
  return { inputTokens: 0, outputTokens: 0, usd: 0 };
}

/** Suma dos consumos (para acumular lotes dentro de una misma operación). */
export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    usd: a.usd + b.usd
  };
}

/** Totales acumulados en este dispositivo desde el último reinicio. */
export async function getAiUsage(): Promise<AiUsageTotals> {
  const saved = await getKV<Partial<AiUsageTotals>>(USAGE_KEY, {});
  return {
    inputTokens: Number(saved.inputTokens) || 0,
    outputTokens: Number(saved.outputTokens) || 0,
    usd: Number(saved.usd) || 0,
    calls: Number(saved.calls) || 0
  };
}

/** Suma un consumo al contador acumulado y devuelve los nuevos totales. */
export async function recordUsage(usage: AiUsage, calls = 1): Promise<AiUsageTotals> {
  const prev = await getAiUsage();
  const next: AiUsageTotals = {
    inputTokens: prev.inputTokens + (usage.inputTokens || 0),
    outputTokens: prev.outputTokens + (usage.outputTokens || 0),
    usd: prev.usd + (usage.usd || 0),
    calls: prev.calls + calls
  };
  await setKV(USAGE_KEY, next);
  return next;
}

/** Deja el contador acumulado en cero. */
export async function resetAiUsage(): Promise<AiUsageTotals> {
  const zero: AiUsageTotals = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };
  await setKV(USAGE_KEY, zero);
  return zero;
}

// ---------------------------------------------------------------------------
// Llamada HTTP

interface ApiTextBlock {
  type: string;
  text?: string;
}

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface ApiResponse {
  content?: ApiTextBlock[];
  usage?: ApiUsage;
}

/** Construye el AiError adecuado a partir de una respuesta HTTP fallida. */
async function errorFromResponse(res: Response): Promise<AiError> {
  if (res.status === 401) return new AiError('clave inválida', 401);
  let detail = `error ${res.status}`;
  let raw = '';
  try {
    const body: unknown = await res.json();
    const msg = (body as { error?: { message?: string } } | null)?.error?.message;
    if (typeof msg === 'string' && msg) {
      raw = msg;
      detail = msg;
    }
  } catch {
    try {
      const txt = await res.text();
      if (txt) {
        raw = txt;
        detail = txt.slice(0, 300);
      }
    } catch {
      /* cuerpo ilegible: se mantiene el mensaje genérico */
    }
  }
  // Saldo de la API agotado: es una cuenta distinta de la suscripción de
  // Claude.ai, así que conviene decirlo con todas sus letras.
  if (/credit balance is too low|insufficient.*credit/i.test(raw)) {
    return new AiError(NO_CREDIT, res.status);
  }
  if (res.status === 429) return new AiError('límite de peticiones por minuto: espera un momento y reintenta', 429);
  return new AiError(detail, res.status);
}

/**
 * POST a la Messages API con un único turno de usuario.
 * Devuelve el texto concatenado de los bloques `text` y el consumo real
 * (`usage`) que informa el cuerpo de la respuesta, ya convertido a dólares.
 */
async function callClaude(opts: {
  system: string;
  content: ContentBlock[];
  maxTokens?: number;
  json?: boolean;
}): Promise<{ text: string; usage: AiUsage }> {
  const key = appSettings.aiApiKey.trim();
  if (!key) throw new AiError('no hay clave API configurada');

  const model = resolveModel();
  const system = opts.json
    ? `${opts.system}\n\nResponde SÓLO con JSON válido, sin comentarios ni vallas de código.`
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
        model,
        max_tokens: opts.maxTokens ?? MAX_TOKENS_DESCRIBE,
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

  const inputTokens = Number(data.usage?.input_tokens) || 0;
  const outputTokens = Number(data.usage?.output_tokens) || 0;
  return {
    text,
    usage: { inputTokens, outputTokens, usd: usageToUsd(model, { inputTokens, outputTokens }) }
  };
}

// ---------------------------------------------------------------------------
// Utilidades

/** Nombre del idioma para los prompts. */
function langName(lang: AiLang): string {
  return lang === 'es' ? 'español' : 'inglés (English)';
}

/** Instrucción común: idioma y prohibición de inventar. */
function baseRules(lang: AiLang): string {
  return `Responde en ${langName(lang)}. Describe sólo lo que se ve; no inventes.`;
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

/**
 * Normaliza el nombre de una categoría: sin `#`, espacios repetidos ni punto
 * final, con mayúscula inicial y como mucho 40 caracteres.
 */
export function normalizeCategory(c: unknown): string | null {
  if (typeof c !== 'string') return null;
  const s = c.trim().replace(/^#+\s*/, '').replace(/\s+/g, ' ').replace(/[.:]+$/, '').trim().slice(0, 40);
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Busca `name` en `list` sin distinguir mayúsculas; devuelve el nombre canónico. */
function findCategory(list: string[], name: string): string | null {
  const lower = name.toLowerCase();
  return list.find((c) => c.toLowerCase() === lower) ?? null;
}

// ---------------------------------------------------------------------------
// Funciones de alto nivel
//
// Todas devuelven `{ result, usage }`: `usage` es el consumo real de la API
// (acumulado entre lotes) para poder mostrarlo y sumarlo al contador local.

/**
 * Analiza el moodboard (hasta 20 imágenes + textos de las notas) y devuelve un
 * markdown breve (≤ 200 palabras) con dirección visual, paleta, temas,
 * referencias y sugerencias de qué falta.
 */
export async function describeBoard(input: {
  images: { name: string; jpegBase64: string }[];
  notes: string[];
  lang: AiLang;
}): Promise<{ result: string; usage: AiUsage }> {
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
    `Eres director de arte y analizas moodboards. ${baseRules(input.lang)} ` +
    'Markdown breve, máximo 200 palabras, con estas secciones: dirección visual, paleta, temas, ' +
    'referencias y qué falta. Concreto, sin adjetivos vacíos.';

  const { text, usage } = await callClaude({ system, content, maxTokens: MAX_TOKENS_DESCRIBE });
  return { result: text, usage };
}

/**
 * Etiqueta imágenes (3-6 etiquetas por imagen, en minúsculas y sin `#`).
 * Procesa en lotes secuenciales de 20 imágenes y devuelve `{ id: tags[] }`
 * junto al consumo sumado de todos los lotes.
 */
export async function tagImages(input: {
  images: { id: string; name: string; jpegBase64: string }[];
  lang: AiLang;
}): Promise<{ result: Record<string, string[]>; usage: AiUsage }> {
  const out: Record<string, string[]> = {};
  let usage = emptyUsage();
  const system =
    `Catalogas referencias visuales. ${baseRules(input.lang)} ` +
    'Para cada imagen da 3 a 6 etiquetas en minúsculas, sin almohadilla (tema, estilo, color, medio, ' +
    'ambiente). Devuelve sólo un objeto JSON con los identificadores dados como claves: ' +
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

    const res = await callClaude({ system, content, maxTokens: MAX_TOKENS_TAG, json: true });
    usage = addUsage(usage, res.usage);
    const parsed = parseJsonLoose(res.text) as Record<string, unknown>;
    for (const [id, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const tags = value.map(normalizeTag).filter((t): t is string => t !== null);
      if (tags.length) out[id] = tags.slice(0, 6);
    }
  }
  return { result: out, usage };
}

/** Agrupa ítems por tema (sólo texto: no envía imágenes, así que es muy barato). */
export async function suggestArrangement(input: {
  items: { id: string; name: string; tags: string[]; palette: string[] }[];
  lang: AiLang;
}): Promise<{ result: { groups: { title: string; ids: string[] }[] }; usage: AiUsage }> {
  const system =
    `Organizas un moodboard. ${baseRules(input.lang)} ` +
    'Agrupa los ítems por tema o afinidad visual usando sólo los datos dados. Cada ítem va en un ' +
    'único grupo y cada grupo lleva un título corto. Devuelve sólo JSON: ' +
    '{ "groups": [ { "title": "...", "ids": ["..."] } ] }.';

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

  const res = await callClaude({ system, content, maxTokens: MAX_TOKENS_ARRANGE, json: true });
  const parsed = parseJsonLoose(res.text) as { groups?: unknown };
  const raw = Array.isArray(parsed.groups) ? parsed.groups : [];
  const groups: { title: string; ids: string[] }[] = [];
  for (const g of raw) {
    const obj = g as { title?: unknown; ids?: unknown };
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const ids = Array.isArray(obj.ids) ? obj.ids.filter((x): x is string => typeof x === 'string') : [];
    if (title && ids.length) groups.push({ title, ids });
  }
  return { result: { groups }, usage: res.usage };
}

/** Resultado de `classifyImages`: categorías en orden y a cuál va cada imagen. */
export interface ClassifyResult {
  /** Categorías finales, en orden de aparición (la de respaldo va al final). */
  categories: string[];
  /** `{ id: categoría }` para cada imagen recibida. */
  assignments: Record<string, string>;
}

/**
 * Clasifica imágenes en categorías, en lotes secuenciales de 20.
 *
 * - Con `categories` (p. ej. «Poses, Texturas, Ropa») cada imagen va a una de
 *   ellas o, si no encaja, a la de respaldo (`OTHER_CATEGORY`).
 * - Sin `categories`, el primer lote pide a la IA que proponga entre 3 y
 *   `MAX_AD_HOC_CATEGORIES` categorías cortas adecuadas al tablero; los lotes
 *   siguientes reutilizan esas y sólo pueden añadir una nueva si sobra cupo.
 *
 * Es la función más barata de la capa IA por imagen: pensada para miniaturas de
 * 256 px (≈ 90 tokens cada una) y una salida JSON corta.
 */
export async function classifyImages(input: {
  images: { id: string; name: string; jpegBase64: string }[];
  categories: string[];
  lang: AiLang;
}): Promise<{ result: ClassifyResult; usage: AiUsage }> {
  const other = OTHER_CATEGORY[input.lang];
  const fixed: string[] = [];
  for (const c of input.categories) {
    const n = normalizeCategory(c);
    if (n && !findCategory(fixed, n) && n.toLowerCase() !== other.toLowerCase()) fixed.push(n);
  }
  const adHoc = fixed.length === 0;
  const known: string[] = [...fixed];
  const assignments: Record<string, string> = {};
  let usedOther = false;
  let usage = emptyUsage();

  const system =
    `Eres director de arte y ordenas referencias visuales de un moodboard. ${baseRules(input.lang)} ` +
    'Cada imagen va a exactamente una categoría. Devuelve sólo JSON con esta forma: ' +
    '{ "categories": ["..."], "assignments": { "<id>": "<categoría>" } }.';

  for (const batch of chunk(input.images, MAX_IMAGES)) {
    const content: ContentBlock[] = [];
    for (const img of batch) {
      content.push({ type: 'text', text: `id: ${img.id} — nombre: ${img.name}` });
      content.push(imageBlock(img.jpegBase64));
    }
    let instruction: string;
    if (!adHoc) {
      instruction =
        `Categorías permitidas: ${known.join(', ')}. Asigna cada imagen a una de ellas; ` +
        `si ninguna encaja de verdad, usa "${other}".`;
    } else if (known.length === 0) {
      instruction =
        `Propón entre 3 y ${MAX_AD_HOC_CATEGORIES} categorías cortas (1 a 3 palabras) que dividan este ` +
        'tablero de forma útil para trabajar (por ejemplo poses, texturas, ropa, paleta, entorno, ' +
        'tipografía) y asigna cada imagen a una. Prefiere pocas categorías claras a muchas vagas.';
    } else {
      instruction =
        `Categorías ya definidas: ${known.join(', ')}. Usa esas. Sólo si una imagen claramente no ` +
        `encaja en ninguna, crea una categoría nueva corta (máximo ${MAX_AD_HOC_CATEGORIES} en total) ` +
        `o usa "${other}".`;
    }
    content.push({ type: 'text', text: `${instruction} Identificadores: ${batch.map((i) => i.id).join(', ')}.` });

    const res = await callClaude({ system, content, maxTokens: MAX_TOKENS_CLASSIFY, json: true });
    usage = addUsage(usage, res.usage);
    const parsed = parseJsonLoose(res.text) as { categories?: unknown; assignments?: unknown };

    // categorías nuevas (sólo en modo ad hoc y mientras quede cupo)
    if (adHoc && Array.isArray(parsed.categories)) {
      for (const raw of parsed.categories) {
        const n = normalizeCategory(raw);
        if (!n || findCategory(known, n) || n.toLowerCase() === other.toLowerCase()) continue;
        if (known.length < MAX_AD_HOC_CATEGORIES) known.push(n);
      }
    }
    const rawAssign =
      parsed.assignments && typeof parsed.assignments === 'object' ? (parsed.assignments as Record<string, unknown>) : {};
    for (const img of batch) {
      const n = normalizeCategory(rawAssign[img.id]);
      let cat = n ? findCategory(known, n) : null;
      if (!cat && n && adHoc && n.toLowerCase() !== other.toLowerCase() && known.length < MAX_AD_HOC_CATEGORIES) {
        known.push(n);
        cat = n;
      }
      if (!cat) {
        cat = other;
        usedOther = true;
      }
      assignments[img.id] = cat;
    }
  }

  return { result: { categories: usedOther ? [...known, other] : known, assignments }, usage };
}

/** Simbología propuesta para un tablero: el mood en pocas palabras y sus signos. */
export interface OrnamentSuggestion {
  /** Mood del tablero en 2 a 4 palabras, para mostrarlo tal cual. */
  mood: string;
  /** Signos breves (glifos o marcas de hasta 6 caracteres), ya saneados. */
  symbols: string[];
}

/**
 * Propone el mood del tablero y la simbología que lo acompaña: flechas,
 * asteriscos, cruces, marcas de referencia… los signos que se dibujan a mano
 * sobre un moodboard.
 *
 * Es la llamada más barata de la capa IA: con etiquetas basta el texto (unos
 * cientos de tokens). Sólo si el tablero no tiene etiquetas ni categorías se
 * mandan hasta 6 miniaturas para no adivinar el mood a ciegas.
 */
export async function suggestOrnaments(input: {
  board: string;
  tags: string[];
  categories: string[];
  palette: string[];
  images?: { jpegBase64: string }[];
  lang: AiLang;
}): Promise<{ result: OrnamentSuggestion; usage: AiUsage }> {
  const tags = input.tags.map(normalizeTag).filter((t): t is string => t !== null).slice(0, 30);
  const categories = input.categories.map((c) => c.trim()).filter(Boolean).slice(0, 10);
  const palette = input.palette.filter((c) => typeof c === 'string' && c.trim()).slice(0, 6);
  const pistas = tags.length + categories.length;

  const system =
    `Eres director de arte y montas moodboards a mano. ${baseRules(input.lang)} ` +
    'Di el mood del tablero en 2 a 4 palabras y propón entre 6 y 10 signos tipográficos breves que ' +
    'lo acompañen: flechas, asteriscos, cruces, guiones, números de referencia, marcas cortas. ' +
    'Cada signo, como mucho 6 caracteres, en una sola línea y sin emoji de color. ' +
    'Devuelve sólo JSON: { "mood": "...", "symbols": ["..."] }.';

  const content: ContentBlock[] = [];
  if (pistas < 3 && input.images?.length) {
    for (const img of input.images.slice(0, ORNAMENT_IMAGES)) content.push(imageBlock(img.jpegBase64));
  }
  content.push({
    type: 'text',
    text:
      'Tablero (JSON):\n' +
      JSON.stringify({ nombre: input.board, categorias: categories, etiquetas: tags, paleta: palette }, null, 0) +
      '\n\nPropón el mood y su simbología.'
  });

  const res = await callClaude({ system, content, maxTokens: MAX_TOKENS_ORNAMENTS, json: true });
  const parsed = parseJsonLoose(res.text) as { mood?: unknown; symbols?: unknown };
  const mood = typeof parsed.mood === 'string' ? parsed.mood.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
  return { result: { mood, symbols: cleanSymbols(parsed.symbols) }, usage: res.usage };
}
