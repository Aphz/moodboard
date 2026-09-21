/**
 * Tabla de modelos de Claude habilitados en la app, con sus precios vigentes, y
 * utilidades **puras** para estimar cuánto costará una llamada ANTES de hacerla
 * y para convertir el consumo real informado por la API a dólares.
 *
 * Precios oficiales de la API de Anthropic, en US$ por millón de tokens
 * (entrada / salida):
 *
 * | Modelo             | id                 | Entrada | Salida |
 * |--------------------|--------------------|---------|--------|
 * | Claude Haiku 4.5   | `claude-haiku-4-5` | 1,00    | 5,00   |
 * | Claude Sonnet 5    | `claude-sonnet-5`  | 2,00    | 10,00  |
 * | Claude Opus 5      | `claude-opus-5`    | 5,00    | 25,00  |
 *
 * El por defecto de la app es Haiku 4.5 porque es el más barato y basta de
 * sobra para describir un tablero o etiquetar imágenes.
 */
import { t, type MsgKey } from '../i18n';

/** Precio y etiqueta de un modelo disponible en la app. */
export interface ModelPricing {
  /** Identificador exacto que espera la API (sin sufijo de fecha). */
  id: string;
  /** Nombre corto para mostrar, sin traducir. */
  name: string;
  /** Clave i18n de la etiqueta descriptiva (ej. «el más económico»). */
  labelKey: MsgKey;
  /** US$ por millón de tokens de entrada. */
  inputUsdPerMTok: number;
  /** US$ por millón de tokens de salida. */
  outputUsdPerMTok: number;
}

/** Modelos ofrecidos en la app, del más barato al más caro. */
export const AI_MODELS: readonly ModelPricing[] = [
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    labelKey: 'ai_model_haiku',
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5
  },
  {
    id: 'claude-sonnet-5',
    name: 'Sonnet 5',
    labelKey: 'ai_model_sonnet',
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10
  },
  {
    id: 'claude-opus-5',
    name: 'Opus 5',
    labelKey: 'ai_model_opus',
    inputUsdPerMTok: 5,
    outputUsdPerMTok: 25
  }
] as const;

/** Modelo por defecto: el más económico de la tabla. */
export const DEFAULT_AI_MODEL = 'claude-haiku-4-5';

/** Lado mayor (px) al que se reducen las miniaturas antes de enviarlas. */
export const AI_THUMB_MAX_SIDE = 384;

/** Divisor de la documentación de Anthropic: tokens ≈ (ancho × alto) / 750. */
const IMAGE_TOKEN_DIVISOR = 750;

/** Tope práctico de tokens por imagen recomendado por la documentación. */
const MAX_IMAGE_TOKENS = 1600;

/** Aproximación conservadora de caracteres por token para texto. */
const CHARS_PER_TOKEN = 4;

/** Consumo de tokens (y su costo) de una llamada. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Estimación o consumo real, con el costo ya calculado. */
export interface UsageEstimate extends TokenUsage {
  /** Costo en dólares. */
  usd: number;
}

/** ¿El id corresponde a un modelo de la tabla? */
export function isKnownModel(id: string): boolean {
  return AI_MODELS.some((m) => m.id === id);
}

/** Precios de un modelo; si el id no está en la tabla, los del por defecto. */
export function pricingFor(model: string): ModelPricing {
  return AI_MODELS.find((m) => m.id === model) ?? AI_MODELS.find((m) => m.id === DEFAULT_AI_MODEL)!;
}

/** Etiqueta traducida del modelo (ej. «Haiku 4.5 · el más económico»). */
export function modelLabel(model: string): string {
  const p = AI_MODELS.find((m) => m.id === model);
  return p ? t(p.labelKey) : model;
}

/** Texto de precio: «US$ 1 / US$ 5 por millón de tokens». */
export function modelPriceLabel(model: string): string {
  const p = pricingFor(model);
  return t('ui_ai_price_per_mtok', {
    in: formatUsd(p.inputUsdPerMTok),
    out: formatUsd(p.outputUsdPerMTok)
  });
}

/**
 * Tokens que consume una imagen de `w` × `h` px según la regla de la
 * documentación: `(ancho × alto) / 750`, con tope de 1600 tokens por imagen.
 */
export function estimateImageTokens(w: number, h: number): number {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
  return Math.min(MAX_IMAGE_TOKENS, Math.ceil((w * h) / IMAGE_TOKEN_DIVISOR));
}

/**
 * Estimación del consumo de una petición: suma los tokens de las imágenes, los
 * del texto (≈ 4 caracteres por token) y asume que la salida llegará al tope
 * `maxOutput`. El costo se calcula con los precios de `model` (por defecto, el
 * modelo económico de la app).
 */
export function estimateRequest(input: {
  model?: string;
  images?: { w: number; h: number }[];
  textChars?: number;
  maxOutput?: number;
}): UsageEstimate {
  const imgTokens = (input.images ?? []).reduce((acc, i) => acc + estimateImageTokens(i.w, i.h), 0);
  const chars = Math.max(0, input.textChars ?? 0);
  const inputTokens = imgTokens + Math.ceil(chars / CHARS_PER_TOKEN);
  const outputTokens = Math.max(0, Math.round(input.maxOutput ?? 0));
  return {
    inputTokens,
    outputTokens,
    usd: usageToUsd(input.model ?? DEFAULT_AI_MODEL, { inputTokens, outputTokens })
  };
}

/** Costo en dólares de un consumo dado, según los precios del modelo. */
export function usageToUsd(model: string, usage: TokenUsage): number {
  const p = pricingFor(model);
  const inTok = Math.max(0, usage.inputTokens || 0);
  const outTok = Math.max(0, usage.outputTokens || 0);
  return (inTok * p.inputUsdPerMTok + outTok * p.outputUsdPerMTok) / 1_000_000;
}

/**
 * Formatea dólares con coma decimal: `US$ 0,004`. Usa más decimales mientras
 * más pequeño es el monto, para que los costos mínimos no se vean como cero.
 */
export function formatUsd(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  const decimals = v === 0 || v >= 1 ? 2 : v >= 0.001 ? 3 : 4;
  return `US$ ${v.toFixed(decimals).replace('.', ',')}`;
}

/** Formatea una cantidad de tokens con punto de miles: `1.240`. */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
