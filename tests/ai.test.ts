/**
 * Pruebas del cliente de la Messages API (src/ai/claude.ts).
 *
 * `globalThis.fetch` se sustituye por un mock; la clave API se fija mutando
 * `appSettings` (no se usa `updateAppSettings` porque escribe en IndexedDB,
 * que no existe en jsdom).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appSettings } from '../src/core/settings';
import { aiAvailable, describeBoard, tagImages, redactKey, AiError } from '../src/ai/claude';

/** Respuesta simulada de la API con un único bloque de texto. */
function okResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] })
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
    expect(body.max_tokens).toBe(1024);
    expect(body.messages[0]!.role).toBe('user');
  });

  it('parsea JSON envuelto en texto', async () => {
    mockFetch(() => okResponse('Aquí está: {"a":["x"]} gracias'));
    const tags = await tagImages({ images: [IMG], lang: 'es' });
    expect(tags).toEqual({ a: ['x'] });
  });

  it('normaliza etiquetas (minúsculas, sin #)', async () => {
    mockFetch(() => okResponse('{"a":["#Rojo"," Neón "]}'));
    const tags = await tagImages({ images: [IMG], lang: 'es' });
    expect(tags['a']).toEqual(['rojo', 'neón']);
  });

  it('divide en lotes secuenciales de 20 imágenes', async () => {
    const fn = mockFetch(() => okResponse('{"a":["x"]}'));
    const images = Array.from({ length: 25 }, (_, i) => ({ ...IMG, id: `i${i}` }));
    await tagImages({ images, lang: 'en' });
    expect(fn).toHaveBeenCalledTimes(2);
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

  it('lanza AiError con status 429 (límite de uso)', async () => {
    mockFetch(() => errResponse(429));
    await expect(tagImages({ images: [IMG], lang: 'es' })).rejects.toMatchObject({
      status: 429,
      message: 'límite de uso'
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

  it('describeBoard devuelve el markdown del primer bloque de texto', async () => {
    mockFetch(() => okResponse('## Dirección visual\nTexto'));
    const md = await describeBoard({
      images: [{ name: 'uno.jpg', jpegBase64: 'AAAA' }],
      notes: ['nota'],
      lang: 'es'
    });
    expect(md).toContain('Dirección visual');
  });
});
