/**
 * Pruebas de los ajustes (src/core/settings.ts), centradas en que la clave API
 * no se pierda: respaldo en `localStorage`, restauración si IndexedDB vuelve
 * vacía y borrado explícito.
 *
 * `persistence` se sustituye por un almacén en memoria, porque jsdom no trae
 * IndexedDB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, unknown>();
vi.mock('../src/core/persistence', () => ({
  getKV: async (k: string, def: unknown) => (mem.has(k) ? mem.get(k) : def),
  setKV: async (k: string, v: unknown) => void mem.set(k, v)
}));

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

/** Carga una instancia limpia del módulo (el estado vive en variables suyas). */
async function loadSettings() {
  vi.resetModules();
  return import('../src/core/settings');
}

beforeEach(() => {
  mem.clear();
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
