/**
 * Cliente mínimo de **Google Drive REST v3** hecho sólo con `fetch`.
 *
 * No hay servidor ni SDK: la app habla directamente con Drive usando el
 * `access_token` que Google Identity Services le entrega al usuario, con el
 * ámbito `drive.file`. Ese ámbito sólo permite ver y tocar los archivos que
 * crea esta misma app, así que el resto del Drive del usuario queda intacto.
 *
 * Estructura que se crea en el Drive del usuario:
 *
 * ```
 * Moodboard/
 *   scenes/   <sceneId>.json   appProperties: { kind: 'scene', sceneId, updatedAt }
 *   blobs/    <blobId>.<ext>   appProperties: { kind: 'blob',  blobId }
 * ```
 *
 * Borrar un tablero es un **borrado lógico**: se marca `appProperties.deleted`
 * y se refresca `modifiedTime`, para que el otro dispositivo se entere y borre
 * su copia local. Pasados 30 días el archivo se elimina de verdad.
 *
 * Todas las llamadas pasan por `request()`, que reintenta lo que se puede
 * reintentar (401 → renovar el token una vez; 403 por cuota, 429 y 5xx →
 * espera exponencial, 3 intentos).
 */
import type { Scene } from '../core/model';
import { getKV, setKV } from '../core/persistence';

// ---------------------------------------------------------------------------
// constantes

/** Carpeta raíz que la app crea en el Drive del usuario. */
export const ROOT_FOLDER_NAME = 'Moodboard';
/** Subcarpeta con el JSON de cada tablero. */
export const SCENES_FOLDER_NAME = 'scenes';
/** Subcarpeta con los bitmaps de las imágenes. */
export const BLOBS_FOLDER_NAME = 'blobs';

/** MIME de las carpetas de Drive. */
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/** Endpoint con el correo del usuario (ámbito `userinfo.email`). */
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Ámbitos que pide la app: sus propios archivos y el correo del usuario. */
export const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';

/** Un tablero borrado se elimina de verdad pasado este tiempo. */
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Intentos totales de una petición reintentable. */
const MAX_ATTEMPTS = 3;
/** Base de la espera exponencial (ms). */
const BACKOFF_MS = 200;

/** Clave de IndexedDB donde se cachean los identificadores de las carpetas. */
export const KV_FOLDERS = 'gdriveFolders';

// ---------------------------------------------------------------------------
// tipos

/**
 * Fuente del `access_token`. La implementa `src/sync/index.ts`, que es quien
 * habla con Google Identity Services; aquí sólo se consume.
 */
export interface TokenSource {
  /** Token utilizable ahora mismo (renovándolo si venció), o `null`. */
  get(): Promise<string | null>;
  /** Fuerza una renovación tras un 401. Devuelve el token nuevo o `null`. */
  refresh(): Promise<string | null>;
}

/** Archivo de Drive tal como lo devuelve la API con los campos que pedimos. */
export interface DriveFile {
  id: string;
  name: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
  size?: string;
}

/** Resumen de un tablero remoto (sin descargar su JSON). */
export interface RemoteSceneMeta {
  /** Identificador del archivo en Drive. */
  fileId: string;
  /** Identificador de la escena (`Scene.id`). */
  sceneId: string;
  /** `modifiedTime` en milisegundos. */
  modifiedTime: number;
  /** `true` si está marcado como borrado (borrado lógico). */
  deleted: boolean;
}

/** Identificadores de las tres carpetas de la app. */
export interface DriveFolders {
  root: string;
  scenes: string;
  blobs: string;
}

/** Un cambio anunciado por `changes.list`. */
export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: DriveFile;
}

/** Error de la API de Drive con su código HTTP y el motivo de Google. */
export class DriveError extends Error {
  constructor(
    message: string,
    /** Código HTTP de la respuesta. */
    readonly status: number,
    /** `reason` que trae el cuerpo del error (`userRateLimitExceeded`, …). */
    readonly reason = ''
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

// ---------------------------------------------------------------------------
// utilidades puras

/** Convierte un `modifiedTime` RFC 3339 a milisegundos (0 si no se entiende). */
export function parseModifiedTime(iso: string | null | undefined): number {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Extensión de archivo que le corresponde a un tipo MIME de imagen. */
export function extForMime(mime: string): string {
  const m = (mime || '').toLowerCase().split(';')[0].trim();
  switch (m) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/avif':
      return 'avif';
    case 'image/heic':
      return 'heic';
    case 'image/heif':
      return 'heif';
    case 'image/svg+xml':
      return 'svg';
    case 'application/json':
      return 'json';
    default:
      return 'bin';
  }
}

/** Tipo MIME que se deduce de la extensión de un nombre de archivo. */
export function mimeForName(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'avif':
      return 'image/avif';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'svg':
      return 'image/svg+xml';
    case 'json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

/** Escapa las comillas simples de un valor dentro de una consulta `q`. */
export function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Cuerpo `multipart/related` para subir metadatos + contenido en un viaje. */
export function multipartBody(
  metadata: unknown,
  content: Blob | string,
  contentType: string
): { body: Blob; type: string } {
  const boundary = `moodboard-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const head =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return { body: new Blob([head, content, tail]), type: `multipart/related; boundary=${boundary}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Lee el `reason` y el mensaje de un cuerpo de error de Google. */
async function readError(res: Response): Promise<{ message: string; reason: string }> {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    /* sin cuerpo */
  }
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; errors?: { reason?: string }[] } };
    return {
      message: parsed.error?.message ?? raw ?? `HTTP ${res.status}`,
      reason: parsed.error?.errors?.[0]?.reason ?? ''
    };
  } catch {
    return { message: raw || `HTTP ${res.status}`, reason: '' };
  }
}

/** ¿Este estado merece otro intento tras esperar un poco? */
function isRetryable(status: number, reason: string): boolean {
  if (status === 429) return true;
  if (status >= 500) return true;
  if (status === 403) {
    const r = reason.toLowerCase();
    return r.includes('ratelimitexceeded') || r.includes('userratelimitexceeded') || r.includes('backenderror');
  }
  return false;
}

// ---------------------------------------------------------------------------
// cliente

/**
 * Cliente de Drive atado a una fuente de token. Guarda en memoria (y en
 * IndexedDB) los identificadores de las carpetas para no buscarlas cada vez.
 */
export class Drive {
  private folders: DriveFolders | null = null;
  /** Archivos de bitmap ya vistos en Drive: `blobId` → `fileId`. */
  private blobFiles = new Map<string, string>();

  constructor(private readonly tokens: TokenSource) {}

  /** Olvida las cachés en memoria (al desconectar la cuenta). */
  reset(): void {
    this.folders = null;
    this.blobFiles.clear();
  }

  // -------------------------------------------------------------------------
  // transporte

  /**
   * Petición autenticada con reintentos.
   *
   * @param url     URL absoluta de la API.
   * @param init    opciones de `fetch` (sin la cabecera `Authorization`).
   */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    let token = await this.tokens.get();
    if (!token) throw new DriveError('missing token', 401, 'authError');
    let renewed = false;

    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      const res = await fetch(url, { ...init, headers });
      if (res.ok) return res;

      if (res.status === 401 && !renewed) {
        // el token venció justo ahora: renovarlo una sola vez y repetir
        renewed = true;
        const next = await this.tokens.refresh();
        if (!next) {
          const { message } = await readError(res);
          throw new DriveError(message, 401, 'authError');
        }
        token = next;
        continue;
      }

      const { message, reason } = await readError(res);
      if (isRetryable(res.status, reason) && attempt < MAX_ATTEMPTS - 1) {
        await sleep(BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw new DriveError(message, res.status, reason);
    }
  }

  /** Igual que `request`, pero devolviendo el JSON ya parseado. */
  private async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(url, init);
    return (await res.json()) as T;
  }

  // -------------------------------------------------------------------------
  // carpetas

  /** Busca una carpeta por nombre (y padre); devuelve su id o `null`. */
  private async findFolder(name: string, parentId?: string): Promise<string | null> {
    const parts = [`name=${quote(name)}`, `mimeType=${quote(FOLDER_MIME)}`, 'trashed=false'];
    if (parentId) parts.push(`${quote(parentId)} in parents`);
    const q = encodeURIComponent(parts.join(' and '));
    const data = await this.json<{ files?: DriveFile[] }>(`${API}/files?q=${q}&fields=files(id,name)&pageSize=10`);
    return data.files?.[0]?.id ?? null;
  }

  /** Crea una carpeta y devuelve su id. */
  private async createFolder(name: string, parentId?: string): Promise<string> {
    const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
    if (parentId) body.parents = [parentId];
    const data = await this.json<DriveFile>(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return data.id;
  }

  private async folder(name: string, parentId?: string): Promise<string> {
    return (await this.findFolder(name, parentId)) ?? (await this.createFolder(name, parentId));
  }

  /**
   * Devuelve (creándolas si hace falta) las tres carpetas de la app. El
   * resultado queda cacheado en memoria y en IndexedDB.
   */
  async ensureFolders(): Promise<DriveFolders> {
    if (this.folders) return this.folders;
    const cached = await getKV<DriveFolders | null>(KV_FOLDERS, null);
    if (cached?.root && cached.scenes && cached.blobs) {
      this.folders = cached;
      return cached;
    }
    const root = await this.folder(ROOT_FOLDER_NAME);
    const scenes = await this.folder(SCENES_FOLDER_NAME, root);
    const blobs = await this.folder(BLOBS_FOLDER_NAME, root);
    this.folders = { root, scenes, blobs };
    await setKV(KV_FOLDERS, this.folders);
    return this.folders;
  }

  // -------------------------------------------------------------------------
  // escenas

  /** Lista todos los tableros remotos, incluidos los borrados lógicamente. */
  async listScenes(): Promise<RemoteSceneMeta[]> {
    const folders = await this.ensureFolders();
    const q = [
      `${quote(folders.scenes)} in parents`,
      'trashed=false',
      "appProperties has { key='kind' and value='scene' }"
    ].join(' and ');
    const out: RemoteSceneMeta[] = [];
    let pageToken = '';
    do {
      const url =
        `${API}/files?q=${encodeURIComponent(q)}` +
        '&fields=nextPageToken,files(id,name,modifiedTime,appProperties,size)' +
        '&pageSize=200' +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const page = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>(url);
      for (const f of page.files ?? []) {
        const sceneId = f.appProperties?.sceneId ?? f.name.replace(/\.json$/i, '');
        if (!sceneId) continue;
        out.push({
          fileId: f.id,
          sceneId,
          modifiedTime: parseModifiedTime(f.modifiedTime),
          deleted: f.appProperties?.deleted === '1'
        });
      }
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }

  /** Descarga el JSON completo de un tablero. `null` si no se puede leer. */
  async downloadScene(fileId: string): Promise<Scene | null> {
    const res = await this.request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
    try {
      return (await res.json()) as Scene;
    } catch {
      return null;
    }
  }

  /**
   * Sube un tablero. Crea el archivo si `fileId` es `null` y si no lo
   * actualiza con `PATCH`, siempre en un solo `multipart`.
   */
  async uploadScene(scene: Scene, fileId: string | null): Promise<{ fileId: string; modifiedTime: number }> {
    const folders = await this.ensureFolders();
    const metadata: Record<string, unknown> = {
      name: `${scene.id}.json`,
      mimeType: 'application/json',
      appProperties: {
        kind: 'scene',
        sceneId: scene.id,
        updatedAt: String(scene.updatedAt),
        // al volver a subirla deja de estar borrada (null borra la propiedad)
        deleted: null
      }
    };
    if (!fileId) metadata.parents = [folders.scenes];
    const { body, type } = multipartBody(metadata, JSON.stringify(scene), 'application/json');
    const url = fileId
      ? `${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,modifiedTime`
      : `${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`;
    const data = await this.json<DriveFile>(url, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': type },
      body
    });
    return { fileId: data.id, modifiedTime: parseModifiedTime(data.modifiedTime) };
  }

  /**
   * Borrado lógico: marca el archivo y le pone una marca de tiempo nueva para
   * que el otro dispositivo lo vea como un cambio y borre su copia local.
   */
  async softDeleteScene(fileId: string, now: number = Date.now()): Promise<number> {
    const data = await this.json<DriveFile>(`${API}/files/${encodeURIComponent(fileId)}?fields=id,modifiedTime`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appProperties: { deleted: '1' }, modifiedTime: new Date(now).toISOString() })
    });
    return parseModifiedTime(data.modifiedTime) || now;
  }

  /** Elimina de verdad los tableros borrados hace más de 30 días. */
  async pruneDeleted(metas: RemoteSceneMeta[], now: number = Date.now()): Promise<number> {
    let n = 0;
    for (const m of metas) {
      if (!m.deleted || now - m.modifiedTime <= PRUNE_AFTER_MS) continue;
      await this.request(`${API}/files/${encodeURIComponent(m.fileId)}`, { method: 'DELETE' });
      n++;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // bitmaps

  /** Busca el archivo de un bitmap por su `blobId`. */
  async findBlob(blobId: string): Promise<DriveFile | null> {
    const cached = this.blobFiles.get(blobId);
    if (cached) return { id: cached, name: blobId };
    const q = `appProperties has { key='blobId' and value=${quote(blobId)} } and trashed=false`;
    const data = await this.json<{ files?: DriveFile[] }>(
      `${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,size)&pageSize=10`
    );
    const file = data.files?.[0] ?? null;
    if (file) this.blobFiles.set(blobId, file.id);
    return file;
  }

  /** ¿Ya está subido este bitmap? (con caché en memoria). */
  async hasBlob(blobId: string): Promise<boolean> {
    return (await this.findBlob(blobId)) !== null;
  }

  /** Sube un bitmap si todavía no está. */
  async uploadBlob(blobId: string, blob: Blob): Promise<string> {
    const known = this.blobFiles.get(blobId);
    if (known) return known;
    const folders = await this.ensureFolders();
    const mime = blob.type || 'application/octet-stream';
    const metadata = {
      name: `${blobId}.${extForMime(mime)}`,
      mimeType: mime,
      parents: [folders.blobs],
      appProperties: { kind: 'blob', blobId }
    };
    const { body, type } = multipartBody(metadata, blob, mime);
    const data = await this.json<DriveFile>(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body
    });
    this.blobFiles.set(blobId, data.id);
    return data.id;
  }

  /** Descarga un bitmap por su `blobId`. `null` si no está en el Drive. */
  async downloadBlob(blobId: string): Promise<Blob | null> {
    const file = await this.findBlob(blobId);
    if (!file) return null;
    const res = await this.request(`${API}/files/${encodeURIComponent(file.id)}?alt=media`);
    const data = await res.blob();
    // Safari no siempre rellena `type`: deducirlo del nombre del archivo
    if (data.type) return data;
    return new Blob([data], { type: mimeForName(file.name) });
  }

  // -------------------------------------------------------------------------
  // sondeo de cambios

  /** Punto de partida para `changes.list`. */
  async startPageToken(): Promise<string> {
    const data = await this.json<{ startPageToken?: string }>(`${API}/changes/startPageToken?fields=startPageToken`);
    return data.startPageToken ?? '';
  }

  /**
   * Cambios desde `pageToken`. Devuelve también el token para la próxima
   * consulta (`newStartPageToken`).
   */
  async listChanges(pageToken: string): Promise<{ changes: DriveChange[]; nextToken: string }> {
    const changes: DriveChange[] = [];
    let token = pageToken;
    let next = pageToken;
    for (let guard = 0; guard < 20 && token; guard++) {
      const url =
        `${API}/changes?pageToken=${encodeURIComponent(token)}&pageSize=200` +
        '&fields=newStartPageToken,nextPageToken,changes(fileId,removed,file(id,name,modifiedTime,appProperties))';
      const page = await this.json<{
        changes?: DriveChange[];
        nextPageToken?: string;
        newStartPageToken?: string;
      }>(url);
      for (const c of page.changes ?? []) changes.push(c);
      if (page.nextPageToken) {
        token = page.nextPageToken;
        next = page.nextPageToken;
        continue;
      }
      next = page.newStartPageToken ?? token;
      break;
    }
    return { changes, nextToken: next };
  }
}

/** Pide el correo del usuario con el token actual. Nunca lanza. */
export async function fetchEmail(token: string): Promise<string> {
  try {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return '';
    const data = (await res.json()) as { email?: string };
    return data.email ?? '';
  } catch {
    return '';
  }
}
