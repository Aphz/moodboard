/**
 * Pruebas del cliente de la Messages API (src/ai/claude.ts) y de la tabla de
 * precios (src/ai/pricing.ts).
 *
 * `globalThis.fetch` se sustituye por un mock; la clave API se fija mutando
 * `appSettings` (no se usa `updateAppSettings` porque escribe en IndexedDB,
 * que no existe en jsdom).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appSettings } from '../src/core/settings';
import {
  aiAvailable,
  describeBoard,
  tagImages,
  redactKey,
  resolveModel,
  addUsage,
  emptyUsage,
  AiError,
  MAX_TOKENS_DESCRIBE,
  MAX_TOKENS_TAG
} from '../src/ai/claude';
import {
  AI_MODELS,
  DEFAULT_AI_MODEL,
  estimateImageTokens,
  estimateRequest,
  formatTokens,
  formatUsd,
  isKnownModel,
  pricingFor,
  usageToUsd
} from '../src/ai/pricing';

/** Respuesta simulada de la API con un único bloque de texto y su consumo. */
function okResponse(text: string, usage = { input_tokens: 1000, output_tokens: 240 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }], usage })
  };
}

/** Respuesta de error simulada. */
function errResponse(status: number, body: unknown = { error: { message: 'boom' } }) {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function mockFetch(impl: () => unknown) {
  const fn = vi.fn(async () => impl());
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const IMG = { id: 'a', name: 'uno.jpg', jpegBase64: 'AAAA' };

beforeEach(() => {
  appSettings.aiApiKey = 'sk-ant-test-1234';
  appSettings.aiModel = 'claude-sonnet-5';
  vi.restoreAllMocks();
});

describe('tagImages', () => {
  it('llama al endpoint correcto con POST y las cabeceras de clave y acceso directo', async () => {
    const fn = mockFetch(() => okResponse('{"a":["x","y","z"]}'));
    await tagImages({ images: [IMG], lang: 'es' });

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test-1234');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(String(init.body)) as {
      model: string;
      max_tokens: number;
      messages: { role: string; content: unknown[] }[];
    };
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.max_tokens).toBe(MAX_TOKENS_TAG);
    expect(body.messages[0]!.role).toBe('user');
  });

  it('parsea JSON envuelto en texto y devuelve { result, usage }', async () => {
    mockFetch(() => okResponse('Aquí está: {"a":["x"]} gracias'));
    const { result, usage } = await tagImages({ images: [IMG], lang: 'es' });
    expect(result).toEqual({ a: ['x'] });
    expect(usage.inputTokens).toBe(1000);
    expect(usage.outputTokens).toBe(240);
    // Sonnet 5: 2 US$/MTok de entrada, 10 de salida.
    expect(usage.usd).toBeCloseTo(1000 * 2e-6 + 240 * 1e-5, 10);
  });

  it('normaliza etiquetas (minúsculas, sin #)', async () => {
    mockFetch(() => okResponse('{"a":["#Rojo"," Neón "]}'));
    const { result } = await tagImages({ images: [IMG], lang: 'es' });
    expect(result['a']).toEqual(['rojo', 'neón']);
  });

  it('divide en lotes secuenciales de 20 imágenes y acumula el consumo', async () => {
    const fn = mockFetch(() => okResponse('{"a":["x"]}'));
    const images = Array.from({ length: 25 }, (_, i) => ({ ...IMG, id: `i${i}` }));
    const { usage } = await tagImages({ images, lang: 'en' });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(usage.inputTokens).toBe(2000);
    expect(usage.outputTokens).toBe(480);
  });

  it('lanza AiError con status 401 y mensaje de clave inválida', async () => {
    mockFetch(() => errResponse(401));
    await expect(tagImages({ images: [IMG], lang: 'es' })).rejects.toMatchObject({
      name: 'AiError',
      status: 401,
      message: 'clave inválida'
    });
    await expect(tagImages({ images: [IMG], lang: 'es' })).rejects.toBeInstanceOf(AiError);
  });

  it('lanza AiError con status 429 explicando límite o falta de crédito', async () => {
    mockFetch(() => errResponse(429));
    await expect(tagImages({ images: [IMG], lang: 'es' })).rejects.toMatchObject({
      status: 429,
      message: 'límite de uso o sin crédito en la cuenta de Anthropic'
    });
  });
});

describe('sin clave API', () => {
  beforeEach(() => {
    appSettings.aiApiKey = '';
  });

  it('aiAvailable() es false', () => {
    expect(aiAvailable()).toBe(false);
  });

  it('describeBoard lanza AiError sin llamar a fetch', async () => {
    const fn = mockFetch(() => okResponse('hola'));
    await expect(describeBoard({ images: [], notes: [], lang: 'es' })).rejects.toBeInstanceOf(AiError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('utilidades', () => {
  it('aiAvailable() es true con clave', () => {
    expect(aiAvailable()).toBe(true);
  });

  it('redactKey sólo muestra los últimos 4 caracteres', () => {
    const red = redactKey('sk-ant-secreto-9876');
    expect(red.endsWith('9876')).toBe(true);
    expect(red).not.toContain('secreto');
  });

  it('describeBoard devuelve el markdown y usa un tope de salida breve', async () => {
    const fn = mockFetch(() => okResponse('## Dirección visual\nTexto'));
    const { result } = await describeBoard({
      images: [{ name: 'uno.jpg', jpegBase64: 'AAAA' }],
      notes: ['nota'],
      lang: 'es'
    });
    expect(result).toContain('Dirección visual');
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).max_tokens).toBe(MAX_TOKENS_DESCRIBE);
  });

  it('addUsage suma consumos partiendo de emptyUsage()', () => {
    const total = addUsage(emptyUsage(), { inputTokens: 10, outputTokens: 5, usd: 0.001 });
    expect(total).toEqual({ inputTokens: 10, outputTokens: 5, usd: 0.001 });
  });
});

describe('resolveModel', () => {
  it('devuelve el modelo de los ajustes si está en la tabla', () => {
    appSettings.aiModel = 'claude-opus-5';
    expect(resolveModel()).toBe('claude-opus-5');
  });

  it('cae al por defecto (el más económico) si el modelo no está en la tabla', () => {
    appSettings.aiModel = 'modelo-inventado';
    expect(resolveModel()).toBe(DEFAULT_AI_MODEL);
    expect(DEFAULT_AI_MODEL).toBe('claude-haiku-4-5');
  });

  it('el por defecto es el más barato de la tabla', () => {
    const cheapest = [...AI_MODELS].sort((a, b) => a.inputUsdPerMTok - b.inputUsdPerMTok)[0]!;
    expect(cheapest.id).toBe(DEFAULT_AI_MODEL);
  });
});

describe('estimateImageTokens', () => {
  it('aplica la regla (ancho × alto) / 750', () => {
    expect(estimateImageTokens(750, 1)).toBe(1);
    expect(estimateImageTokens(384, 384)).toBe(Math.ceil((384 * 384) / 750));
  });

  it('tiene tope de 1600 tokens por imagen', () => {
    expect(estimateImageTokens(4000, 3000)).toBe(1600);
  });

  it('devuelve 0 con medidas inválidas', () => {
    expect(estimateImageTokens(0, 100)).toBe(0);
    expect(estimateImageTokens(-5, 10)).toBe(0);
    expect(estimateImageTokens(Number.NaN, 10)).toBe(0);
  });
});

describe('estimateRequest', () => {
  it('suma tokens de imágenes y de texto, y usa maxOutput como salida', () => {
    const est = estimateRequest({
      model: 'claude-haiku-4-5',
      images: [{ w: 384, h: 384 }],
      textChars: 400,
      maxOutput: 600
    });
    expect(est.inputTokens).toBe(estimateImageTokens(384, 384) + 100);
    expect(est.outputTokens).toBe(600);
    expect(est.usd).toBeCloseTo(est.inputTokens * 1e-6 + 600 * 5e-6, 10);
  });

  it('el mismo pedido es más caro con Opus 5 que con Haiku 4.5', () => {
    const base = { images: [{ w: 384, h: 256 }], textChars: 200, maxOutput: 400 };
    const haiku = estimateRequest({ ...base, model: 'claude-haiku-4-5' });
    const opus = estimateRequest({ ...base, model: 'claude-opus-5' });
    expect(opus.usd).toBeCloseTo(haiku.usd * 5, 10);
  });

  it('sin modelo usa el por defecto y sin datos da cero', () => {
    expect(estimateRequest({ images: [], textChars: 0, maxOutput: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      usd: 0
    });
    const a = estimateRequest({ images: [{ w: 100, h: 100 }], textChars: 40, maxOutput: 10 });
    const b = estimateRequest({ model: DEFAULT_AI_MODEL, images: [{ w: 100, h: 100 }], textChars: 40, maxOutput: 10 });
    expect(a).toEqual(b);
  });
});

describe('usageToUsd y formato', () => {
  it('cobra entrada y salida al precio del modelo', () => {
    expect(usageToUsd('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(1, 10);
    expect(usageToUsd('claude-haiku-4-5', { inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(5, 10);
    expect(usageToUsd('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(12, 10);
    expect(usageToUsd('claude-opus-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(30, 10);
  });

  it('un modelo desconocido se cobra al precio del por defecto', () => {
    const u = { inputTokens: 2000, outputTokens: 100 };
    expect(usageToUsd('modelo-inventado', u)).toBeCloseTo(usageToUsd(DEFAULT_AI_MODEL, u), 12);
    expect(isKnownModel('modelo-inventado')).toBe(false);
    expect(pricingFor('modelo-inventado').id).toBe(DEFAULT_AI_MODEL);
  });

  it('formatUsd usa coma decimal y más decimales cuando el monto es mínimo', () => {
    expect(formatUsd(0.004)).toBe('US$ 0,004');
    expect(formatUsd(1.5)).toBe('US$ 1,50');
    expect(formatUsd(0.00012)).toBe('US$ 0,0001');
    expect(formatUsd(0)).toBe('US$ 0,00');
  });

  it('formatTokens agrupa los miles con punto', () => {
    expect(formatTokens(1240)).toBe('1.240');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1234567)).toBe('1.234.567');
  });
});
