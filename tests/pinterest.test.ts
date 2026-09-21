/**
 * Pruebas de la importación desde un enlace de Pinterest
 * (src/features/pinterest.ts): normalización de enlaces, parseo del HTML y
 * del RSS, unión de pines, URLs del lector y del proxy, y la descarga con
 * variantes de respaldo. La red se simula con un `fetch` falso.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE_PROXY,
  MAX_PINS,
  READER_BASE,
  boardMetaFromHtml,
  downloadPins,
  fetchBoard,
  isPinterestUrl,
  mergePins,
  normalizePinterestUrl,
  pinsFromBoardHtml,
  pinsFromRss,
  proxiedImageUrl,
  rssUrlFor,
  variantUrl,
  type PinImage
} from '../src/features/pinterest';

const H1 = '3a/9e/07/3a9e07c90852c2ef30947b20ed7a75b7';
const H2 = '2c/d3/26/2cd326d8357a4f34ee53a0714851da74';
const H3 = '11/22/33/1122334455667788990011223344aabb';

/** HTML mínimo con la forma real de `__PWS_INITIAL_PROPS__` de un tablero. */
function boardHtml(): string {
  const pin = (id: string, hash: string, ext = 'jpg') => ({
    id,
    type: 'pin',
    image_signature: hash.slice(-32),
    images: {
      '236x': { url: `https://i.pinimg.com/236x/${hash}.jpg`, width: 236, height: 295 },
      orig: { url: `https://i.pinimg.com/originals/${hash}.${ext}`, width: 1080, height: 1349 }
    }
  });
  const props = {
    initialReduxState: {
      boards: { b1: { id: '263601453128956842', type: 'board', name: 'Moodboard 1', url: '/aphz/moodboard-1/', pin_count: 45, privacy: 'public' } },
      pins: { p1: pin('p1', H1), p2: pin('p2', H2, 'png') },
      resources: {
        BoardFeedResource: {
          '[["board_id","263601453128956842"]]': { data: [pin('p1', H1), pin('p2', H2, 'png')], nextBookmark: 'xyz' }
        }
      }
    }
  };
  return (
    '<html><head><title>Moodboard 1 on Pinterest</title></head><body>' +
    `<img src="https://i.pinimg.com/75x75_RS/aa/bb/cc/aabbccaabbccaabbccaabbccaabbccaa.jpg">` +
    `<script id="__PWS_INITIAL_PROPS__" type="application/json">${JSON.stringify(props)}</script></body></html>`
  );
}

const RSS =
  '<rss><channel><title>Moodboard 1</title>' +
  `<item><link>https://cl.pinterest.com/pin/263601384441093629/</link><description>&lt;img src="https://i.pinimg.com/236x/${H1}.jpg"&gt;</description></item>` +
  `<item><link>https://cl.pinterest.com/pin/263601384441093630/</link><description>&lt;img src="https://i.pinimg.com/236x/${H3}.jpg"&gt;</description></item>` +
  '</channel></rss>';

describe('normalizePinterestUrl / isPinterestUrl', () => {
  it('acepta pin.it, pinterest.com, dominios por país y sin esquema', () => {
    expect(normalizePinterestUrl('https://pin.it/5pahFOjCj')).toBe('https://pin.it/5pahFOjCj');
    expect(normalizePinterestUrl('pin.it/abc')).toBe('https://pin.it/abc');
    expect(normalizePinterestUrl(' http://cl.pinterest.com/aphz/moodboard-1/#x ')).toBe('https://cl.pinterest.com/aphz/moodboard-1/');
    expect(normalizePinterestUrl('www.pinterest.es/u/b/')).toBe('https://www.pinterest.es/u/b/');
    expect(isPinterestUrl('https://pinterest.com/pin/123/')).toBe(true);
  });

  it('rechaza lo que no es de Pinterest', () => {
    expect(normalizePinterestUrl('https://example.com/pinterest.com/')).toBeNull();
    expect(normalizePinterestUrl('https://notpinterest.com/x')).toBeNull();
    expect(normalizePinterestUrl('hola mundo')).toBeNull();
    expect(normalizePinterestUrl('')).toBeNull();
    expect(isPinterestUrl('https://i.pinimg.com/236x/a.jpg')).toBe(false);
  });
});

describe('rssUrlFor', () => {
  it('sólo para URLs con forma usuario/tablero', () => {
    expect(rssUrlFor('https://cl.pinterest.com/aphz/moodboard-1/?invite_code=1')).toBe('https://cl.pinterest.com/aphz/moodboard-1.rss');
    expect(rssUrlFor('https://www.pinterest.com/pin/263601384441093629/')).toBeNull();
    expect(rssUrlFor('https://pin.it/abc')).toBeNull();
    expect(rssUrlFor('https://www.pinterest.com/aphz/')).toBeNull();
  });
});

describe('proxiedImageUrl / variantUrl', () => {
  const pin: PinImage = { id: 'p', hash: H1, ext: 'png', url: `https://i.pinimg.com/originals/${H1}.png` };
  it('pasa por el proxy con tamaño y JPEG', () => {
    const u = proxiedImageUrl(pin.url, 800);
    expect(u.startsWith(IMAGE_PROXY)).toBe(true);
    expect(u).toContain(`url=${encodeURIComponent(`i.pinimg.com/originals/${H1}.png`)}`);
    expect(u).toContain('w=800&h=800&fit=inside');
    expect(u).toContain('output=jpg');
  });
  it('las variantes reducidas siempre son jpg; el original conserva su extensión', () => {
    expect(variantUrl(pin, 'originals')).toBe(`https://i.pinimg.com/originals/${H1}.png`);
    expect(variantUrl(pin, '736x')).toBe(`https://i.pinimg.com/736x/${H1}.jpg`);
  });
});

describe('pinsFromBoardHtml', () => {
  it('saca los pines del JSON incrustado con su original, sin duplicados ni avatares', () => {
    const pins = pinsFromBoardHtml(boardHtml());
    expect(pins.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(pins[0]).toMatchObject({ hash: H1, ext: 'jpg', url: `https://i.pinimg.com/originals/${H1}.jpg`, w: 1080, h: 1349 });
    expect(pins[1]!.ext).toBe('png');
  });

  it('sin JSON cae a las imágenes grandes del HTML', () => {
    const html = `<img src="https://i.pinimg.com/736x/${H1}.jpg"><img src="https://i.pinimg.com/75x75_RS/${H2}.jpg"><img src="https://i.pinimg.com/originals/${H3}.png">`;
    const pins = pinsFromBoardHtml(html);
    expect(pins.map((p) => p.hash)).toEqual([H1, H3]);
  });

  it('boardMetaFromHtml usa el objeto board y cae al <title>', () => {
    expect(boardMetaFromHtml(boardHtml(), 'https://pin.it/x')).toEqual({ title: 'Moodboard 1', canonicalUrl: 'https://www.pinterest.com/aphz/moodboard-1/', pinCount: 45 });
    expect(boardMetaFromHtml('<title>Cosas on Pinterest</title>', 'https://pin.it/x')).toEqual({ title: 'Cosas', canonicalUrl: 'https://pin.it/x', pinCount: null });
  });
});

describe('pinsFromRss / mergePins', () => {
  it('eleva las 236x al original y toma el id del pin del enlace anterior', () => {
    const pins = pinsFromRss(RSS);
    expect(pins).toEqual([
      { id: '263601384441093629', hash: H1, ext: 'jpg', url: `https://i.pinimg.com/originals/${H1}.jpg` },
      { id: '263601384441093630', hash: H3, ext: 'jpg', url: `https://i.pinimg.com/originals/${H3}.jpg` }
    ]);
  });
  it('mergePins quita repetidos por hash conservando el primero', () => {
    const merged = mergePins(pinsFromBoardHtml(boardHtml()), pinsFromRss(RSS));
    expect(merged.map((p) => p.hash)).toEqual([H1, H2, H3]);
    expect(merged[0]!.w).toBe(1080);
  });
});

describe('fetchBoard', () => {
  it('pide la página como HTML al lector, luego el RSS, y une los pines', async () => {
    const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === `${READER_BASE}https://pin.it/5pahFOjCj`) return { ok: true, status: 200, text: async () => boardHtml() } as Response;
      if (url === `${READER_BASE}https://www.pinterest.com/aphz/moodboard-1.rss`) return { ok: true, status: 200, text: async () => RSS } as Response;
      return { ok: false, status: 404, text: async () => '' } as Response;
    });
    const progress: string[] = [];
    const board = await fetchBoard('pin.it/5pahFOjCj', fetchFn, (m) => progress.push(m));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Return-Format']).toBe('html');
    expect(board.title).toBe('Moodboard 1');
    expect(board.pinCount).toBe(45);
    expect(board.pins.map((p) => p.hash)).toEqual([H1, H2, H3]);
    expect(progress).toEqual(['board', 'rss']);
  });

  it('sin pines lanza un error legible; con enlace ajeno también', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => '<html></html>' }) as Response);
    await expect(fetchBoard('https://pinterest.com/x/y/', fetchFn)).rejects.toThrow(/pines/);
    await expect(fetchBoard('https://example.com/', fetchFn)).rejects.toThrow(/Pinterest/);
  });

  it('recorta al tope de pines', async () => {
    const many = Array.from({ length: MAX_PINS + 10 }, (_, i) => `<img src="https://i.pinimg.com/736x/aa/bb/cc/${i.toString(16).padStart(32, '0')}.jpg">`).join('');
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => many }) as Response);
    const board = await fetchBoard('https://pin.it/x', fetchFn);
    expect(board.pins.length).toBe(MAX_PINS);
  });
});

describe('downloadPins', () => {
  const pin = (id: string, hash: string): PinImage => ({ id, hash, ext: 'jpg', url: `https://i.pinimg.com/originals/${hash}.jpg` });
  const imgResponse = () => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array([1, 2, 3]) as unknown as BlobPart], { type: 'image/jpeg' }) }) as Response;

  it('baja cada pin por el proxy y cae a 736x si el original falla', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes(encodeURIComponent(`originals/${H2}`))) return { ok: false, status: 404 } as Response;
      return imgResponse();
    });
    const done: number[] = [];
    const out = await downloadPins([pin('a', H1), pin('b', H2)], { fetchFn, onProgress: (d) => done.push(d) });
    expect(out.map((o) => o.name)).toEqual(['pin-a.jpg', 'pin-b.jpg']);
    expect(done).toEqual([1, 2]);
    const urls = fetchFn.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes(encodeURIComponent(`736x/${H2}`)))).toBe(true);
    expect(urls.every((u) => u.startsWith(IMAGE_PROXY))).toBe(true);
  });

  it('omite lo que no llega como imagen y mantiene el orden', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes(encodeURIComponent(H2))) return { ok: true, status: 200, blob: async () => new Blob(['no'], { type: 'text/html' }) } as Response;
      return imgResponse();
    });
    const out = await downloadPins([pin('a', H1), pin('b', H2), pin('c', H3)], { fetchFn });
    expect(out.map((o) => o.pin.id)).toEqual(['a', 'c']);
  });
});
