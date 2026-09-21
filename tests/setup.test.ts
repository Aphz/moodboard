/**
 * Asistente de configuración: comprobaciones automáticas (`checkSetup`) con
 * `fetch` simulado y el enlace `#setup=` que lleva la configuración al otro
 * dispositivo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkSetup,
  decodeSetupLink,
  encodeSetupLink,
  getProjectRef,
  providersUrl,
  sqlEditorUrl
} from '../src/sync';

const CFG = { url: 'https://abcdefgh.supabase.co', anonKey: 'eyJhbGciOiJIUzI1NiJ9.test' };

/** Respuesta de `GET /auth/v1/settings` con el `mailer_autoconfirm` pedido. */
function settingsResponse(autoconfirm: boolean, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ mailer_autoconfirm: autoconfirm, external: { email: true } })
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('checkSetup', () => {
  it('200 con mailer_autoconfirm true ⇒ los dos primeros pasos en verde', async () => {
    const fetchMock = vi.fn(async () => settingsResponse(true));
    vi.stubGlobal('fetch', fetchMock);

    const report = await checkSetup(CFG);

    expect(report.project.state).toBe('ok');
    expect(report.confirmEmail.state).toBe('ok');
    expect(report.data.state).toBe('pending'); // sin `opts.data` no se consulta
    expect(report.ref).toBe('abcdefgh');
    expect(report.needsSql).toBe(false);

    // se pide el endpoint correcto y con las dos cabeceras
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://abcdefgh.supabase.co/auth/v1/settings');
    expect((init.headers as Record<string, string>).apikey).toBe(CFG.anonKey);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CFG.anonKey}`);
  });

  it('200 con mailer_autoconfirm false ⇒ falta desactivar "Confirm email"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => settingsResponse(false)));

    const report = await checkSetup(CFG);

    expect(report.project.state).toBe('ok');
    expect(report.confirmEmail.state).toBe('fail');
    expect(report.confirmEmail.message).toContain('Confirm email');
  });

  it('401 ⇒ la clave anon no sirve', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => settingsResponse(true, 401)));

    const report = await checkSetup(CFG);

    expect(report.project.state).toBe('fail');
    expect(report.project.message).toContain('anon');
    expect(report.confirmEmail.state).toBe('pending');
  });

  it('red caída ⇒ URL incorrecta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const report = await checkSetup(CFG);

    expect(report.project.state).toBe('fail');
    expect(report.project.message).toContain('supabase.co');
  });

  it('una URL que no es de Supabase no llega ni a la red', async () => {
    const fetchMock = vi.fn(async () => settingsResponse(true));
    vi.stubGlobal('fetch', fetchMock);

    const report = await checkSetup({ url: 'https://ejemplo.cl', anonKey: 'x' });

    expect(report.project.state).toBe('fail');
    expect(report.ref).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin configuración deja los tres pasos en espera', async () => {
    const fetchMock = vi.fn(async () => settingsResponse(true));
    vi.stubGlobal('fetch', fetchMock);

    const report = await checkSetup({ url: '', anonKey: '' });

    expect(report.project.state).toBe('pending');
    expect(report.confirmEmail.state).toBe('pending');
    expect(report.data.state).toBe('pending');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('acepta la URL con barra final', async () => {
    const fetchMock = vi.fn(async () => settingsResponse(true));
    vi.stubGlobal('fetch', fetchMock);

    await checkSetup({ url: 'https://abcdefgh.supabase.co/', anonKey: 'k' });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://abcdefgh.supabase.co/auth/v1/settings');
  });
});

describe('enlaces del panel de Supabase', () => {
  it('saca el ref del subdominio', () => {
    expect(getProjectRef('https://abcdefgh.supabase.co')).toBe('abcdefgh');
    expect(getProjectRef('https://abcdefgh.supabase.co/')).toBe('abcdefgh');
    expect(getProjectRef('https://ejemplo.cl')).toBe('');
  });

  it('arma las URLs de providers y del editor SQL', () => {
    expect(providersUrl(CFG.url)).toBe('https://supabase.com/dashboard/project/abcdefgh/auth/providers');
    expect(sqlEditorUrl(CFG.url)).toBe('https://supabase.com/dashboard/project/abcdefgh/sql/new');
    expect(providersUrl('nada')).toBe('https://supabase.com/dashboard');
  });
});

describe('enlace #setup=', () => {
  const BASE = 'https://aphz.github.io/moodboard/';

  it('ida y vuelta', () => {
    const link = encodeSetupLink(CFG, BASE);
    expect(link.startsWith(`${BASE}#setup=`)).toBe(true);
    expect(decodeSetupLink(link)).toEqual(CFG);
  });

  it('el base64url no lleva caracteres que rompan la URL', () => {
    const link = encodeSetupLink({ url: CFG.url, anonKey: 'áéí+/=?&#' }, BASE);
    const payload = link.split('#setup=')[1];
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSetupLink(link)?.anonKey).toBe('áéí+/=?&#');
  });

  it('normaliza la barra final y los espacios', () => {
    const link = encodeSetupLink({ url: ' https://abcdefgh.supabase.co/ ', anonKey: ' k ' }, BASE);
    expect(decodeSetupLink(link)).toEqual({ url: 'https://abcdefgh.supabase.co', anonKey: 'k' });
  });

  it('también lee un hash suelto', () => {
    const hash = encodeSetupLink(CFG, '').trim();
    expect(hash.startsWith('#setup=')).toBe(true);
    expect(decodeSetupLink(hash)).toEqual(CFG);
  });

  it('devuelve null si no hay nada que leer', () => {
    expect(decodeSetupLink('')).toBeNull();
    expect(decodeSetupLink('#')).toBeNull();
    expect(decodeSetupLink('#setup=')).toBeNull();
    expect(decodeSetupLink('#otracosa=1')).toBeNull();
    expect(decodeSetupLink('#setup=no-es-base64-valido!!')).toBeNull();
  });

  it('rechaza una carga sin URL o sin clave', () => {
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeSetupLink(`#setup=${b64({ url: 'https://x.supabase.co' })}`)).toBeNull();
    expect(decodeSetupLink(`#setup=${b64({ anonKey: 'k' })}`)).toBeNull();
    expect(decodeSetupLink(`#setup=${b64({ url: 'ftp://x', anonKey: 'k' })}`)).toBeNull();
  });
});
