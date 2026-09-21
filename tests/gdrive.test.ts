/**
 * Sincronización con Google Drive: cliente REST (`src/sync/gdrive.ts`) y motor
 * (`src/sync/index.ts`).
 *
 * No se toca la red: `fetch` está simulado con un Drive de mentira en memoria
 * (`FakeDrive`) que entiende las mismas rutas que usa la app, y
 * `src/core/persistence` está reemplazado por mapas en memoria.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNoteItem, createScene, type Item, type Scene } from '../src/core/model';
import {
  Drive,
  DriveError,
  extForMime,
  mimeForName,
  multipartBody,
  parseModifiedTime,
  type TokenSource
} from '../src/sync/gdrive';
import { sceneDigest } from '../src/sync/merge';

// ---------------------------------------------------------------------------
// dobles de `src/core/persistence` y `src/core/settings`

const mem = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  scenes: new Map<string, unknown>(),
  blobs: new Map<string, unknown>(),
  provider: null as unknown
}));

vi.mock('../src/core/persistence', () => ({
  getKV: async (key: string, fallback: unknown) => (mem.kv.has(key) ? mem.kv.get(key) : fallback),
  setKV: async (key: string, value: unknown) => {
    mem.kv.set(key, value);
  },
  listScenes: async () =>
    [...mem.scenes.values()].map((s) => {
      const scene = s as Scene;
      return { id: scene.id, name: scene.name, updatedAt: scene.updatedAt, itemCount: scene.items.length, thumb: null };
    }),
  loadScene: async (id: string) => (mem.scenes.get(id) as Scene | undefined) ?? null,
  saveScene: async (scene: Scene) => {
    mem.scenes.set(scene.id, scene);
  },
  deleteScene: async (id: string) => {
    mem.scenes.delete(id);
  },
  getLocalBlob: async (id: string) => (mem.blobs.get(id) as Blob | undefined) ?? null,
  setRemoteBlobProvider: (p: unknown) => {
    mem.provider = p;
  }
}));

vi.mock('../src/core/settings', () => ({
  appSettings: { googleClientId: 'moodboard-test.apps.googleusercontent.com' },
  updateAppSettings: async () => undefined
}));

// ---------------------------------------------------------------------------
// Drive de mentira

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  modifiedTime: string;
  appProperties: Record<string, string>;
  content: string;
}

interface Call {
  method: string;
  url: string;
  contentType: string;
  authorization: string;
  metadata?: Record<string, unknown>;
  content?: string;
  raw?: string;
}

/** Lee un Blob como texto (jsdom todavía no implementa `Blob.text()`). */
function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** Separa un cuerpo `multipart/related` en metadatos + contenido. */
function parseMultipart(text: string, contentType: string): { metadata: Record<string, unknown>; content: string } {
  const boundary = /boundary=([^;\s]+)/.exec(contentType)?.[1] ?? '';
  const parts = text.split(`--${boundary}`);
  const body = (p: string) => p.slice(p.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
  return { metadata: JSON.parse(body(parts[1])) as Record<string, unknown>, content: body(parts[2]) };
}

function jsonResponse(data: unknown, status = 200): Response {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
    blob: async () => new Blob([text], { type: 'application/json' })
  } as unknown as Response;
}

/** Drive en memoria: entiende las rutas que usa `src/sync/gdrive.ts`. */
class FakeDrive {
  files = new Map<string, FakeFile>();
  calls: Call[] = [];
  private seq = 0;
  /** `startPageToken` que devuelve `changes`. */
  pageToken = 'page-1';
  /** Cambios que devuelve `changes.list`. */
  changes: unknown[] = [];

  id(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  /** Crea una carpeta ya existente (para saltarse el descubrimiento). */
  folder(name: string, parent?: string): string {
    const id = this.id('folder-');
    this.files.set(id, {
      id,
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parent ? [parent] : [],
      modifiedTime: '2024-01-01T00:00:00.000Z',
      appProperties: {},
      content: ''
    });
    return id;
  }

  /** Crea el archivo JSON de un tablero. */
  putScene(scene: Scene, parent: string, modifiedTime: string, deleted = false): string {
    const id = this.id('file-');
    this.files.set(id, {
      id,
      name: `${scene.id}.json`,
      mimeType: 'application/json',
      parents: [parent],
      modifiedTime,
      appProperties: {
        kind: 'scene',
        sceneId: scene.id,
        updatedAt: String(scene.updatedAt),
        ...(deleted ? { deleted: '1' } : {})
      },
      content: JSON.stringify(scene)
    });
    return id;
  }

  /** Archivos que devuelve una consulta `q` (subconjunto de la sintaxis real). */
  private query(q: string): FakeFile[] {
    const name = /name='([^']*)'/.exec(q)?.[1];
    const parent = /'([^']*)' in parents/.exec(q)?.[1];
    const mime = /mimeType='([^']*)'/.exec(q)?.[1];
    const kind = /key='kind' and value='([^']*)'/.exec(q)?.[1];
    const blobId = /key='blobId' and value='([^']*)'/.exec(q)?.[1];
    return [...this.files.values()].filter((f) => {
      if (name !== undefined && f.name !== name) return false;
      if (parent !== undefined && !f.parents.includes(parent)) return false;
      if (mime !== undefined && f.mimeType !== mime) return false;
      if (kind !== undefined && f.appProperties.kind !== kind) return false;
      if (blobId !== undefined && f.appProperties.blobId !== blobId) return false;
      return true;
    });
  }

  private meta(f: FakeFile) {
    return {
      id: f.id,
      name: f.name,
      modifiedTime: f.modifiedTime,
      appProperties: f.appProperties,
      size: String(f.content.length)
    };
  }

  /** Implementación de `fetch`. */
  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const contentType = headers.get('Content-Type') ?? '';
    const call: Call = { method, url, contentType, authorization: headers.get('Authorization') ?? '' };
    if (init.body) {
      const raw = typeof init.body === 'string' ? init.body : await blobText(init.body as Blob);
      call.raw = raw;
      if (contentType.startsWith('multipart/related')) {
        const parsed = parseMultipart(raw, contentType);
        call.metadata = parsed.metadata;
        call.content = parsed.content;
      } else if (contentType.startsWith('application/json')) {
        call.metadata = JSON.parse(raw) as Record<string, unknown>;
      }
    }
    this.calls.push(call);

    if (url.includes('/oauth2/v3/userinfo')) return jsonResponse({ email: 'tester@gmail.com' });
    if (url.includes('/changes/startPageToken')) return jsonResponse({ startPageToken: this.pageToken });
    if (url.includes('/drive/v3/changes?')) return jsonResponse({ changes: this.changes, newStartPageToken: this.pageToken });

    // subida (crear o actualizar) con multipart
    if (url.includes('/upload/drive/v3/files')) {
      const metadata = (call.metadata ?? {}) as {
        name?: string;
        mimeType?: string;
        parents?: string[];
        appProperties?: Record<string, string | null>;
      };
      const existing = /\/upload\/drive\/v3\/files\/([^?]+)/.exec(url)?.[1];
      const id = existing ?? this.id('file-');
      const prev = this.files.get(id);
      const props: Record<string, string> = { ...(prev?.appProperties ?? {}) };
      for (const [k, v] of Object.entries(metadata.appProperties ?? {})) {
        if (v === null) delete props[k];
        else props[k] = v;
      }
      const file: FakeFile = {
        id,
        name: metadata.name ?? prev?.name ?? id,
        mimeType: metadata.mimeType ?? prev?.mimeType ?? 'application/octet-stream',
        parents: metadata.parents ?? prev?.parents ?? [],
        modifiedTime: new Date(2024, 5, 1, 12, this.seq).toISOString(),
        appProperties: props,
        content: call.content ?? ''
      };
      this.files.set(id, file);
      return jsonResponse({ id: file.id, modifiedTime: file.modifiedTime });
    }

    const fileMatch = /\/drive\/v3\/files\/([^?]+)/.exec(url);
    if (fileMatch) {
      const file = this.files.get(decodeURIComponent(fileMatch[1]));
      if (!file) return jsonResponse({ error: { message: 'File not found' } }, 404);
      if (method === 'DELETE') {
        this.files.delete(file.id);
        return jsonResponse({});
      }
      if (method === 'PATCH') {
        const patch = (call.metadata ?? {}) as { appProperties?: Record<string, string>; modifiedTime?: string };
        Object.assign(file.appProperties, patch.appProperties ?? {});
        if (patch.modifiedTime) file.modifiedTime = patch.modifiedTime;
        return jsonResponse({ id: file.id, modifiedTime: file.modifiedTime });
      }
      if (url.includes('alt=media')) {
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(file.content) as unknown,
          text: async () => file.content,
          blob: async () => new Blob([file.content], { type: file.mimeType })
        } as unknown as Response;
      }
      return jsonResponse(this.meta(file));
    }

    // creación de carpetas y listados
    if (url.includes('/drive/v3/files')) {
      if (method === 'POST') {
        const body = (call.metadata ?? {}) as { name?: string; mimeType?: string; parents?: string[] };
        const id = this.id('folder-');
        this.files.set(id, {
          id,
          name: body.name ?? '',
          mimeType: body.mimeType ?? 'application/octet-stream',
          parents: body.parents ?? [],
          modifiedTime: new Date().toISOString(),
          appProperties: {},
          content: ''
        });
        return jsonResponse({ id });
      }
      const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(url)?.[1] ?? '');
      return jsonResponse({ files: this.query(q).map((f) => this.meta(f)) });
    }

    return jsonResponse({ error: { message: `ruta no simulada: ${url}` } }, 404);
  };
}

/** Fuente de token de mentira. */
function fakeTokens(first = 'token-1'): TokenSource & { refreshes: number; current: string } {
  return {
    current: first,
    refreshes: 0,
    async get() {
      return this.current;
    },
    async refresh() {
      this.refreshes++;
      this.current = `token-${this.refreshes + 1}`;
      return this.current;
    }
  };
}

// ---------------------------------------------------------------------------
// utilidades de escena

const NOW = 1_700_000_000_000;

function scene(id: string, updatedAt: number, items: Item[] = []): Scene {
  const s = createScene('Tablero');
  s.id = id;
  s.createdAt = 1;
  s.updatedAt = updatedAt;
  s.items = items;
  s.tombstones = {};
  return s;
}

function note(id: string, mtime: number, text = id): Item {
  const n = createNoteItem(text);
  n.id = id;
  n.mtime = mtime;
  n.createdAt = 1;
  return n;
}

// ---------------------------------------------------------------------------

let server: FakeDrive;

beforeEach(() => {
  mem.kv.clear();
  mem.scenes.clear();
  mem.blobs.clear();
  mem.provider = null;
  server = new FakeDrive();
  vi.stubGlobal('fetch', vi.fn(server.fetch));
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initTokenClient: () => ({ requestAccessToken: () => undefined }),
        revoke: () => undefined
      }
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// helpers puros

describe('helpers puros', () => {
  it('extForMime deduce la extensión del bitmap', () => {
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('image/webp')).toBe('webp');
    expect(extForMime('image/svg+xml')).toBe('svg');
    expect(extForMime('IMAGE/PNG; charset=binary')).toBe('png');
    expect(extForMime('')).toBe('bin');
    expect(extForMime('application/octet-stream')).toBe('bin');
  });

  it('mimeForName deduce el MIME desde el nombre', () => {
    expect(mimeForName('b_123.jpg')).toBe('image/jpeg');
    expect(mimeForName('b_123.JPEG')).toBe('image/jpeg');
    expect(mimeForName('s_1.json')).toBe('application/json');
    expect(mimeForName('sin-extension')).toBe('application/octet-stream');
  });

  it('parseModifiedTime convierte RFC 3339 a milisegundos', () => {
    expect(parseModifiedTime('2024-06-01T12:00:00.000Z')).toBe(Date.parse('2024-06-01T12:00:00.000Z'));
    expect(parseModifiedTime('')).toBe(0);
    expect(parseModifiedTime(null)).toBe(0);
    expect(parseModifiedTime('vaya')).toBe(0);
  });

  it('multipartBody arma las dos partes con su frontera', async () => {
    const { body, type } = multipartBody({ name: 'a.json' }, '{"x":1}', 'application/json');
    expect(type).toMatch(/^multipart\/related; boundary=/);
    const parsed = parseMultipart(await blobText(body), type);
    expect(parsed.metadata).toEqual({ name: 'a.json' });
    expect(parsed.content).toBe('{"x":1}');
  });
});

// ---------------------------------------------------------------------------
// cliente REST

describe('Drive', () => {
  it('crea la carpeta Moodboard si no existe y cachea su id', async () => {
    const drive = new Drive(fakeTokens());
    const folders = await drive.ensureFolders();

    const names = [...server.files.values()].map((f) => f.name).sort();
    expect(names).toEqual(['Moodboard', 'blobs', 'scenes']);
    expect(server.files.get(folders.scenes)?.parents).toEqual([folders.root]);
    expect(server.files.get(folders.blobs)?.parents).toEqual([folders.root]);
    // queda cacheada en IndexedDB…
    expect(mem.kv.get('gdriveFolders')).toEqual(folders);
    // …y un cliente nuevo la reutiliza sin volver a buscarla
    const before = server.calls.length;
    const otra = await new Drive(fakeTokens()).ensureFolders();
    expect(otra).toEqual(folders);
    expect(server.calls.length).toBe(before);
  });

  it('reutiliza la carpeta Moodboard existente en vez de duplicarla', async () => {
    const root = server.folder('Moodboard');
    const scenes = server.folder('scenes', root);
    const blobs = server.folder('blobs', root);
    const folders = await new Drive(fakeTokens()).ensureFolders();
    expect(folders).toEqual({ root, scenes, blobs });
    expect(server.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('sube una escena nueva como multipart con sus appProperties', async () => {
    const root = server.folder('Moodboard');
    const scenesFolder = server.folder('scenes', root);
    server.folder('blobs', root);
    const drive = new Drive(fakeTokens());

    const s = scene('s_nueva', 4242, [note('a', 10)]);
    const saved = await drive.uploadScene(s, null);

    const upload = server.calls.find((c) => c.url.includes('/upload/drive/v3/files'))!;
    expect(upload.method).toBe('POST');
    expect(upload.url).toContain('uploadType=multipart');
    expect(upload.contentType).toMatch(/^multipart\/related; boundary=/);
    expect(upload.metadata).toMatchObject({
      name: 's_nueva.json',
      mimeType: 'application/json',
      parents: [scenesFolder],
      appProperties: { kind: 'scene', sceneId: 's_nueva', updatedAt: '4242', deleted: null }
    });
    expect((JSON.parse(upload.content!) as Scene).id).toBe('s_nueva');
    expect(saved.fileId).toBe(server.files.get(saved.fileId)?.id);
    expect(saved.modifiedTime).toBeGreaterThan(0);
  });

  it('actualiza con PATCH al mismo endpoint de subida', async () => {
    const root = server.folder('Moodboard');
    const scenesFolder = server.folder('scenes', root);
    server.folder('blobs', root);
    const drive = new Drive(fakeTokens());
    const fileId = server.putScene(scene('s_1', 1), scenesFolder, '2024-06-01T00:00:00.000Z', true);

    await drive.uploadScene(scene('s_1', 999), fileId);

    const patch = server.calls.find((c) => c.method === 'PATCH' && c.url.includes('/upload/'))!;
    expect(patch.url).toContain(`/upload/drive/v3/files/${fileId}`);
    expect(patch.metadata).not.toHaveProperty('parents');
    // volver a subirla la desmarca como borrada
    expect(server.files.get(fileId)!.appProperties.deleted).toBeUndefined();
    expect(server.files.get(fileId)!.appProperties.updatedAt).toBe('999');
  });

  it('un 401 renueva el token una sola vez y reintenta', async () => {
    const tokens = fakeTokens();
    const drive = new Drive(tokens);
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit = {}) => {
      calls.push(new Headers(init.headers).get('Authorization') ?? '');
      if (calls.length === 1) return jsonResponse({ error: { message: 'Invalid Credentials' } }, 401);
      return jsonResponse({ startPageToken: 'ok' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(drive.startPageToken()).resolves.toBe('ok');
    expect(tokens.refreshes).toBe(1);
    expect(calls).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('si el 401 se repite tras renovar, lanza DriveError sin más intentos', async () => {
    const tokens = fakeTokens();
    const drive = new Drive(tokens);
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'Invalid Credentials' } }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(drive.startPageToken()).rejects.toBeInstanceOf(DriveError);
    expect(tokens.refreshes).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('el borrado lógico marca deleted y refresca modifiedTime', async () => {
    const root = server.folder('Moodboard');
    const scenesFolder = server.folder('scenes', root);
    server.folder('blobs', root);
    const fileId = server.putScene(scene('s_1', 1), scenesFolder, '2024-01-01T00:00:00.000Z');
    const drive = new Drive(fakeTokens());

    const at = Date.parse('2025-03-03T10:00:00.000Z');
    await drive.softDeleteScene(fileId, at);

    expect(server.files.get(fileId)!.appProperties.deleted).toBe('1');
    expect(parseModifiedTime(server.files.get(fileId)!.modifiedTime)).toBe(at);
    const metas = await drive.listScenes();
    expect(metas).toEqual([{ fileId, sceneId: 's_1', modifiedTime: at, deleted: true }]);
  });

  it('poda los tableros borrados hace más de 30 días', async () => {
    const root = server.folder('Moodboard');
    const scenesFolder = server.folder('scenes', root);
    server.folder('blobs', root);
    const viejo = server.putScene(scene('s_viejo', 1), scenesFolder, new Date(NOW - 40 * 86400_000).toISOString(), true);
    const nuevo = server.putScene(scene('s_nuevo', 1), scenesFolder, new Date(NOW - 2 * 86400_000).toISOString(), true);
    const drive = new Drive(fakeTokens());

    const podados = await drive.pruneDeleted(await drive.listScenes(), NOW);

    expect(podados).toBe(1);
    expect(server.files.has(viejo)).toBe(false);
    expect(server.files.has(nuevo)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// motor completo

/** App de mentira: sólo lo que el motor usa. */
function fakeApp(open: Scene) {
  return {
    store: {
      scene: open,
      dirty: false,
      subscribe: () => () => undefined,
      applyRemote: vi.fn((s: Scene) => {
        open.items = s.items;
        open.updatedAt = s.updatedAt;
      }),
      loadScene: vi.fn()
    },
    gestures: { busy: false },
    openSceneById: vi.fn(async () => undefined)
  };
}

/** Prepara el Drive con las carpetas ya creadas y una sesión vigente. */
function connectedState() {
  const root = server.folder('Moodboard');
  const scenesFolder = server.folder('scenes', root);
  const blobsFolder = server.folder('blobs', root);
  mem.kv.set('gdriveFolders', { root, scenes: scenesFolder, blobs: blobsFolder });
  mem.kv.set('gdriveToken', { token: 'token-1', exp: Date.now() + 3600_000, email: 'tester@gmail.com' });
  mem.kv.set('gdrivePageToken', 'page-0');
  return { root, scenesFolder, blobsFolder };
}

/** Carga una instancia limpia del motor. */
async function loadSync() {
  vi.resetModules();
  return import('../src/sync');
}

describe('motor de sincronización', () => {
  it('arranca con la sesión guardada y sube un tablero que sólo existe aquí', async () => {
    const { scenesFolder } = connectedState();
    const local = scene('s_local', 1000, [note('a', 10)]);
    mem.scenes.set(local.id, local);

    const sync = await loadSync();
    await sync.initSync(fakeApp(local) as never);

    expect(sync.getSyncState()).toBe('synced');
    expect(sync.getSyncUser()).toEqual({ email: 'tester@gmail.com' });
    const subido = [...server.files.values()].find((f) => f.name === 's_local.json')!;
    expect(subido.parents).toEqual([scenesFolder]);
    expect(subido.appProperties).toMatchObject({ kind: 'scene', sceneId: 's_local' });
    // y queda anotado para no volver a subirlo
    expect(mem.kv.get('lastSync:s_local')).toMatchObject({ digest: sceneDigest(local), fileId: subido.id });
    await sync.disconnectGoogle();
  });

  it('baja un tablero que sólo está en Drive', async () => {
    const { scenesFolder } = connectedState();
    const abierto = scene('s_abierto', 500);
    mem.scenes.set(abierto.id, abierto);
    const remoto = scene('s_remoto', 900, [note('r', 900, 'desde el iPad')]);
    const fileId = server.putScene(remoto, scenesFolder, '2025-01-01T00:00:00.000Z');

    const sync = await loadSync();
    await sync.initSync(fakeApp(abierto) as never);

    const guardado = mem.scenes.get('s_remoto') as Scene | undefined;
    expect(guardado).toBeTruthy();
    expect(guardado!.items).toHaveLength(1);
    expect(mem.kv.get('lastSync:s_remoto')).toMatchObject({
      fileId,
      remoteMtime: Date.parse('2025-01-01T00:00:00.000Z')
    });
    await sync.disconnectGoogle();
  });

  it('fusiona cuando el tablero cambió en los dos lados', async () => {
    const { scenesFolder } = connectedState();
    const base = scene('s_1', 100, [note('a', 100, 'común')]);
    const local = scene('s_1', 300, [note('a', 100, 'común'), note('b', 300, 'hecho aquí')]);
    const remoto = scene('s_1', 400, [note('a', 100, 'común'), note('c', 400, 'hecho allá')]);
    mem.scenes.set('s_1', local);
    const fileId = server.putScene(remoto, scenesFolder, '2025-02-02T00:00:00.000Z');
    mem.kv.set('lastSync:s_1', {
      digest: sceneDigest(base),
      remoteMtime: Date.parse('2024-12-01T00:00:00.000Z'),
      fileId
    });

    const sync = await loadSync();
    await sync.initSync(fakeApp(local) as never);

    // local: los tres ítems
    const guardado = mem.scenes.get('s_1') as Scene;
    expect(guardado.items.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
    // y el resultado se sube a Drive
    const subido = JSON.parse(server.files.get(fileId)!.content) as Scene;
    expect(subido.items.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
    expect(sync.getSyncState()).toBe('synced');
    await sync.disconnectGoogle();
  });

  it('propaga un borrado hecho en el otro dispositivo', async () => {
    const { scenesFolder } = connectedState();
    const abierto = scene('s_abierto', 10);
    mem.scenes.set(abierto.id, abierto);
    const borrado = scene('s_borrado', 200, [note('x', 200)]);
    mem.scenes.set(borrado.id, borrado);
    const fileId = server.putScene(borrado, scenesFolder, '2025-04-04T00:00:00.000Z', true);
    mem.kv.set('lastSync:s_borrado', {
      digest: sceneDigest(borrado),
      remoteMtime: Date.parse('2025-04-04T00:00:00.000Z'),
      fileId
    });

    const sync = await loadSync();
    await sync.initSync(fakeApp(abierto) as never);

    expect(mem.scenes.has('s_borrado')).toBe(false);
    expect(mem.kv.get('lastSync:s_borrado')).toBeNull();
    await sync.disconnectGoogle();
  });

  it('marca como borrado en Drive el tablero que ya no está aquí', async () => {
    const { scenesFolder } = connectedState();
    const abierto = scene('s_abierto', 10);
    mem.scenes.set(abierto.id, abierto);
    const ido = scene('s_ido', 200);
    const fileId = server.putScene(ido, scenesFolder, '2025-05-05T00:00:00.000Z');
    mem.kv.set('lastSync:s_ido', {
      digest: sceneDigest(ido),
      remoteMtime: Date.parse('2025-05-05T00:00:00.000Z'),
      fileId
    });

    const sync = await loadSync();
    await sync.initSync(fakeApp(abierto) as never);

    expect(server.files.get(fileId)!.appProperties.deleted).toBe('1');
    await sync.disconnectGoogle();
  });

  it('markSceneDeleted propaga el borrado al instante', async () => {
    const { scenesFolder } = connectedState();
    const abierto = scene('s_abierto', 10);
    mem.scenes.set(abierto.id, abierto);
    const otro = scene('s_otro', 200);
    const fileId = server.putScene(otro, scenesFolder, '2025-06-06T00:00:00.000Z');
    mem.scenes.set(otro.id, otro);

    const sync = await loadSync();
    await sync.initSync(fakeApp(abierto) as never);
    mem.scenes.delete('s_otro');
    await sync.markSceneDeleted('s_otro');

    expect(server.files.get(fileId)!.appProperties.deleted).toBe('1');
    await sync.disconnectGoogle();
  });

  it('sin ID de cliente el estado es "off" y no se toca la red', async () => {
    const settings = await import('../src/core/settings');
    const previo = settings.appSettings.googleClientId;
    settings.appSettings.googleClientId = '';
    // El `.env` versionado fija un ID para la build: se anula sólo en este test.
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', '');
    try {
      const sync = await loadSync();
      expect(sync.hasClientId()).toBe(false);
      await sync.initSync(fakeApp(scene('s_x', 1)) as never);
      expect(sync.getSyncState()).toBe('off');
      expect(sync.getSyncUser()).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      settings.appSettings.googleClientId = previo;
    }
  });

  it('sondea cambios cada 10 s y reconcilia la lista completa una vez por minuto', async () => {
    connectedState();
    const abierto = scene('s_abierto', 10);
    mem.scenes.set(abierto.id, abierto);
    // jsdom arranca en "prerender" y el sondeo sólo corre con la app visible
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const sync = await loadSync();
    await sync.initSync(fakeApp(abierto) as never);

    const poll = intervalSpy.mock.calls.find((c) => c[1] === 10_000);
    expect(poll, 'debe programar el sondeo cada 10 s').toBeDefined();
    const tick = poll![0] as () => void;
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const changesCalls = () => server.calls.filter((c) => c.url.includes('/drive/v3/changes?')).length;
    const listCalls = () => server.calls.filter((c) => decodeURIComponent(c.url).includes("value='scene'")).length;
    const list0 = listCalls();
    expect(changesCalls()).toBe(0);

    for (let i = 1; i <= 5; i++) {
      tick();
      await settle();
      expect(changesCalls()).toBe(i);
      expect(listCalls()).toBe(list0);
    }

    // el sexto tic es una reconciliación completa
    tick();
    await settle();
    expect(changesCalls()).toBe(5);
    expect(listCalls()).toBe(list0 + 1);
    await sync.disconnectGoogle();
  });

  it('al recuperar el foco sondea una vez y no repite en menos de 3 s', async () => {
    connectedState();
    const abierto = scene('s_abierto', 10);
    mem.scenes.set(abierto.id, abierto);
    const sync = await loadSync();
    await sync.initSync(fakeApp(abierto) as never);
    const changesCalls = () => server.calls.filter((c) => c.url.includes('/drive/v3/changes?')).length;
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    };
    // la sincronización inicial acaba de terminar: el foco inmediato no sondea
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(changesCalls()).toBe(0);

    const ahora = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(ahora + 5000);
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(changesCalls()).toBe(1);
    // segundo foco inmediato ⇒ no repite
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(changesCalls()).toBe(1);
    spy.mockRestore();
    await sync.disconnectGoogle();
  });

  it('la reconciliación periódica no relee tableros que no cambiaron en ningún lado', async () => {
    const { scenesFolder } = connectedState();
    const abierto = scene('s_abierto', 10);
    mem.scenes.set(abierto.id, abierto);
    const otro = scene('s_otro', 200, [note('a', 1)]);
    mem.scenes.set(otro.id, otro);
    server.putScene(otro, scenesFolder, '2025-06-06T00:00:00.000Z');
    const persistence = await import('../src/core/persistence');
    const loadSpy = vi.spyOn(persistence, 'loadScene');

    const sync = await loadSync();
    await sync.initSync(fakeApp(abierto) as never);
    // la primera pasada sí lee el tablero cerrado para compararlo
    expect(loadSpy.mock.calls.some((c) => c[0] === 's_otro')).toBe(true);
    loadSpy.mockClear();

    await sync.syncNow();
    expect(sync.getSyncState()).toBe('synced');
    expect(loadSpy.mock.calls.some((c) => c[0] === 's_otro')).toBe(false);
    await sync.disconnectGoogle();
  });

  it('con token vencido queda "expired", conserva el correo y no toca la red', async () => {
    connectedState();
    mem.kv.set('gdriveToken', { token: 'viejo', exp: Date.now() - 1000, email: 'tester@gmail.com' });
    const sync = await loadSync();
    await sync.initSync(fakeApp(scene('s_x', 1)) as never);
    expect(sync.getSyncState()).toBe('expired');
    expect(sync.getSyncUser()).toEqual({ email: 'tester@gmail.com' });
    expect(sync.isConnected()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await sync.disconnectGoogle();
  });

  it('el primer toque renueva sin consentimiento (prompt vacío) y arranca la sincronización', async () => {
    connectedState();
    mem.kv.set('gdriveToken', { token: 'viejo', exp: Date.now() - 1000, email: 'tester@gmail.com' });
    let callback: ((r: { access_token?: string; expires_in?: number }) => void) | null = null;
    const requests: unknown[] = [];
    vi.stubGlobal('google', {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: { callback: typeof callback }) => {
            callback = cfg.callback;
            return {
              requestAccessToken: (opts: unknown) => {
                requests.push(opts);
                callback?.({ access_token: 'nuevo', expires_in: 3600 });
              }
            };
          },
          revoke: () => undefined
        }
      }
    });
    const abierto = scene('s_abierto', 10);
    mem.scenes.set(abierto.id, abierto);
    const sync = await loadSync();
    await sync.initSync(fakeApp(abierto) as never);
    expect(sync.getSyncState()).toBe('expired');

    document.dispatchEvent(new Event('pointerup'));
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));

    expect(requests).toEqual([{ prompt: '' }]);
    expect(sync.getSyncState()).toBe('synced');
    expect(sync.getSyncUser()).toEqual({ email: 'tester@gmail.com' });
    expect((mem.kv.get('gdriveToken') as { token: string }).token).toBe('nuevo');
    await sync.disconnectGoogle();
  });

  it('con ID de cliente pero sin sesión guardada queda "signed-out"', async () => {
    const sync = await loadSync();
    expect(sync.hasClientId()).toBe(true);
    await sync.initSync(fakeApp(scene('s_x', 1)) as never);
    expect(sync.getSyncState()).toBe('signed-out');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('desconectar olvida la sesión guardada', async () => {
    connectedState();
    const abierto = scene('s_abierto', 10);
    mem.scenes.set(abierto.id, abierto);

    const sync = await loadSync();
    await sync.initSync(fakeApp(abierto) as never);
    expect(sync.getSyncUser()).not.toBeNull();

    await sync.disconnectGoogle();
    expect(sync.getSyncUser()).toBeNull();
    expect(sync.getSyncState()).toBe('signed-out');
    expect(mem.kv.get('gdriveToken')).toBeNull();
  });

  it('sube los bitmaps que faltan y deja un proveedor remoto para los que no están', async () => {
    connectedState();
    const local = scene('s_img', 1000);
    local.items = [
      {
        ...note('i1', 10),
        kind: 'image',
        blobId: 'b_1',
        naturalW: 4,
        naturalH: 4,
        crop: null,
        source: 'test',
        palette: []
      } as unknown as Item
    ];
    mem.scenes.set(local.id, local);
    mem.blobs.set('b_1', new Blob(['datos'], { type: 'image/png' }));

    const sync = await loadSync();
    await sync.initSync(fakeApp(local) as never);

    const bitmap = [...server.files.values()].find((f) => f.appProperties.kind === 'blob')!;
    expect(bitmap.name).toBe('b_1.png');
    expect(bitmap.appProperties).toEqual({ kind: 'blob', blobId: 'b_1' });
    expect(typeof mem.provider).toBe('function');
    await sync.disconnectGoogle();
  });
});
