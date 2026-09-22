/**
 * Pruebas de los ajustes (src/core/settings.ts), centradas en que la clave API
 * no se pierda: respaldo en `localStorage`, restauración si IndexedDB vuelve
 * vacía y borrado explícito.
 *
 * `persistence` se sustituye por un almacén en memoria, porque jsdom no trae
 * IndexedDB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Almacén en memoria compartido con el mock; `failRead` simula una base rota. */
const store = vi.hoisted(() => ({ mem: new Map<string, unknown>(), failRead: false }));
vi.mock('../src/core/persistence', () => ({
  getKV: async (k: string, def: unknown) => {
    if (store.failRead) throw new Error('base bloqueada');
    return store.mem.has(k) ? store.mem.get(k) : def;
  },
  setKV: async (k: string, v: unknown) => void store.mem.set(k, v)
}));
const mem = store.mem;

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

/** Carga una instancia limpia del módulo (el estado vive en variables suyas). */
async function loadSettings() {
  vi.resetModules();
  return import('../src/core/settings');
}

beforeEach(() => {
  mem.clear();
  store.failRead = false;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('clave API en los ajustes', () => {
  it('al guardarla queda también en el respaldo de localStorage', async () => {
    const s = await loadSettings();
    await s.loadAppSettings();
    await s.updateAppSettings({ aiApiKey: KEY });
    expect(s.appSettings.aiApiKey).toBe(KEY);
    expect(localStorage.getItem('moodboard.aiApiKey')).toBe(KEY);
    expect((mem.get('appSettings') as { aiApiKey: string }).aiApiKey).toBe(KEY);
  });

  it('si IndexedDB vuelve vacía se restaura desde el respaldo y se reescribe', async () => {
    localStorage.setItem('moodboard.aiApiKey', KEY);
    const s = await loadSettings();
    const loaded = await s.loadAppSettings();
    expect(loaded.aiApiKey).toBe(KEY);
    expect((mem.get('appSettings') as { aiApiKey: string }).aiApiKey).toBe(KEY);
  });

  it('una clave en IndexedDB sin respaldo lo repone', async () => {
    mem.set('appSettings', { aiApiKey: KEY });
    const s = await loadSettings();
    await s.loadAppSettings();
    expect(localStorage.getItem('moodboard.aiApiKey')).toBe(KEY);
  });

  it('quitarla explícitamente también borra el respaldo', async () => {
    localStorage.setItem('moodboard.aiApiKey', KEY);
    const s = await loadSettings();
    await s.loadAppSettings();
    await s.updateAppSettings({ aiApiKey: '' });
    expect(s.appSettings.aiApiKey).toBe('');
    expect(localStorage.getItem('moodboard.aiApiKey')).toBeNull();
  });

  it('cambiar otro ajuste no toca la clave ni su respaldo', async () => {
    localStorage.setItem('moodboard.aiApiKey', KEY);
    const s = await loadSettings();
    await s.loadAppSettings();
    await s.updateAppSettings({ theme: 'light' });
    expect(s.appSettings.aiApiKey).toBe(KEY);
    expect(localStorage.getItem('moodboard.aiApiKey')).toBe(KEY);
  });

  it('guardar otra preferencia no propaga una clave vacía si hay respaldo', async () => {
    // simula el caso real: IndexedDB volvió sin ajustes y el respaldo llegó
    // después de cargar (otra pestaña, o una lectura que falló y se recuperó)
    const s = await loadSettings();
    await s.loadAppSettings();
    expect(s.appSettings.aiApiKey).toBe('');
    localStorage.setItem('moodboard.aiApiKey', KEY);
    await s.updateAppSettings({ aiModel: 'claude-sonnet-5' });
    expect(s.appSettings.aiApiKey).toBe(KEY);
    expect((mem.get('appSettings') as { aiApiKey: string }).aiApiKey).toBe(KEY);
  });

  it('si IndexedDB falla al leer, la app arranca igual y respeta el respaldo', async () => {
    store.failRead = true;
    localStorage.setItem('moodboard.aiApiKey', KEY);
    const s = await loadSettings();
    const loaded = await s.loadAppSettings();
    expect(loaded.aiApiKey).toBe(KEY);
  });

  it('sin localStorage disponible los ajustes siguen funcionando', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('modo privado');
    });
    const s = await loadSettings();
    await s.loadAppSettings();
    await expect(s.updateAppSettings({ aiApiKey: KEY })).resolves.toBeUndefined();
    expect(s.appSettings.aiApiKey).toBe(KEY);
    spy.mockRestore();
  });
});
