/**
 * Motor de sincronización entre dispositivos (iPhone ⇄ iPad ⇄ …) contra el
 * **Google Drive del propio usuario**.
 *
 * No hay servidor ni base de datos: la app pide un `access_token` con Google
 * Identity Services (ámbito `drive.file`) y habla directamente con la API REST
 * de Drive. El usuario sólo pulsa "Conectar con Google"; el desarrollador
 * registra la app una vez en Google Cloud y fija el ID de cliente en la build
 * (`VITE_GOOGLE_CLIENT_ID`, ver `docs/SYNC.md`).
 *
 * Flujo:
 *  1. `initSync(app)` al arrancar: si no hay ID de cliente el estado es
 *     `'off'`; si hay token guardado y vigente arranca; si no, `'signed-out'`.
 *  2. `fullSync()` compara los tableros locales con los de Drive y sube, baja
 *     o fusiona (`mergeScenes`) según corresponda.
 *  3. Cada 10 s (con la app visible) se consulta `changes.list` para enterarse
 *     de lo que hizo el otro dispositivo.
 *  4. Cualquier cambio local se sube 2 s después del último evento del store
 *     (y nunca dos veces en menos de 6 s),
 *     y una vez por minuto se reconcilia la lista completa (`files.list`).
 *
 * Nada de lo que ocurre aquí puede romper la app: todos los callbacks están
 * envueltos en `try/catch` y los fallos sólo cambian el estado a `'error'`.
 */
import type { App } from '../app';
import { createScene, type Scene } from '../core/model';
import {
  deleteScene,
  getKV,
  getLocalBlob,
  listScenes,
  loadScene,
  saveScene,
  setKV,
  setRemoteBlobProvider,
  type SceneMeta
} from '../core/persistence';
import { appSettings, updateAppSettings } from '../core/settings';
import { t } from '../i18n';
import { Drive, DriveError, SCOPES, fetchEmail, type RemoteSceneMeta, type TokenSource } from './gdrive';
import { mergeScenes, sceneDigest } from './merge';

export { mergeScenes, sceneDigest } from './merge';
export { ROOT_FOLDER_NAME, extForMime, mimeForName, parseModifiedTime } from './gdrive';

/** Estados observables de la sincronización (`'off'` = build sin ID de cliente). */
export type SyncState = 'off' | 'signed-out' | 'syncing' | 'synced' | 'offline' | 'error';

/** Sesión de Google guardada en IndexedDB (sobrevive a recargar la app). */
export interface GoogleToken {
  /** `access_token` de Google (vive una hora). */
  token: string;
  /** Momento (ms) en que vence. */
  exp: number;
  /** Correo del usuario, para mostrarlo en el diálogo. */
  email: string;
}

/** Huella de un tablero tal como quedó en la última sincronización. */
interface SyncRecord {
  /** `sceneDigest` del contenido sincronizado. */
  digest: string;
  /** `modifiedTime` remoto (ms) correspondiente. */
  remoteMtime: number;
  /** Identificador del archivo en Drive. */
  fileId: string;
  /** `updatedAt` local del tablero en ese momento (para saltar lecturas). */
  updatedAt?: number;
}

/** Milisegundos de espera tras el último cambio antes de subir el tablero. */
const PUSH_DEBOUNCE_MS = 2000;
/** Distancia mínima entre dos subidas: Drive limita las escrituras por archivo. */
const PUSH_MIN_GAP_MS = 6000;
/** Reintento cuando el usuario está en medio de un gesto. */
const BUSY_RETRY_MS = 1000;
/** Cada cuánto se consulta `changes.list` con la app visible. */
const POLL_MS = 10000;
/**
 * Cada cuántos sondeos se hace una reconciliación completa (`files.list`).
 * Es la red de seguridad si el flujo de cambios de Drive llega con retraso.
 */
const FULL_EVERY_N_POLLS = 6;
/** No sondear dos veces en menos de esto al recuperar el foco. */
const FOCUS_THROTTLE_MS = 3000;
/** Margen para dar un token por vencido antes de tiempo. */
const TOKEN_SKEW_MS = 60000;
/** Tiempo máximo de espera de una renovación silenciosa. */
const SILENT_TIMEOUT_MS = 8000;

const KV_TOKEN = 'gdriveToken';
const KV_LAST_SYNC = 'lastSyncAt';
const KV_PAGE_TOKEN = 'gdrivePageToken';
const recKey = (sceneId: string) => `lastSync:${sceneId}`;

const GIS_SRC = 'https://accounts.google.com/gsi/client';

// ---------------------------------------------------------------------------
// tipos mínimos de Google Identity Services

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

interface Gis {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (r: GisTokenResponse) => void;
        error_callback?: (e: unknown) => void;
      }): GisTokenClient;
      revoke(token: string, done?: () => void): void;
    };
  };
}

// ---------------------------------------------------------------------------
// estado del módulo

let app: App | null = null;
let drive: Drive | null = null;
let token: GoogleToken | null = null;
let tokenClient: GisTokenClient | null = null;
let gisPromise: Promise<Gis> | null = null;
/** Resolución pendiente de `requestAccessToken` (sólo una a la vez). */
let pendingToken: ((r: GisTokenResponse | null) => void) | null = null;

let state: SyncState = 'off';
let errorMsg = '';
let lastSyncAt = 0;
let syncing = false;
let syncPending = false;
/** Último sondeo o sincronización, para no repetirlo al recuperar el foco. */
let lastPollAt = 0;
/** Última subida, para espaciar las escrituras sobre el mismo archivo. */
let lastPushAt = 0;
let netBound = false;

let unsubscribeStore: (() => void) | null = null;
let pushTimer = 0;
let pollTimer = 0;

/** Huella del último contenido sincronizado, por tablero (evita subir ecos). */
const syncedDigest = new Map<string, string>();
/** `sceneId` → `fileId` en Drive, tal como se vio en la última lista. */
const fileIds = new Map<string, string>();
/** Bitmaps que ya sabemos que están en Drive. */
const uploadedBlobs = new Set<string>();

const stateListeners = new Set<(s: SyncState) => void>();

// ---------------------------------------------------------------------------
// API observable

/** Suscribe un callback a los cambios de estado. Devuelve la baja. */
export function onSyncState(cb: (s: SyncState) => void): () => void {
  stateListeners.add(cb);
  return () => {
    stateListeners.delete(cb);
  };
}

export function getSyncState(): SyncState {
  return state;
}

/** Último error legible (cadena vacía si no hay). */
export function getSyncError(): string {
  return errorMsg;
}

/** Usuario con sesión de Google iniciada, o `null`. */
/** ¿Hay una cuenta conectada y el motor ya está en marcha? */
export function isConnected(): boolean {
  return !!token && !!drive;
}

/** Usuario con sesión de Google iniciada, o null. */
export function getSyncUser(): { email: string } | null {
  return token ? { email: token.email } : null;
}

/** Momento (ms) de la última sincronización correcta; 0 si nunca. */
export function getLastSync(): number {
  return lastSyncAt;
}

/** App registrada en `initSync` (la usa el diálogo de cuenta). */
export function getSyncApp(): App | null {
  return app;
}

function notify() {
  for (const l of stateListeners) {
    try {
      l(state);
    } catch {
      /* un oyente roto no puede tumbar la sincronización */
    }
  }
}

function setState(s: SyncState) {
  state = s;
  if (s !== 'error' && s !== 'offline' && s !== 'signed-out') errorMsg = '';
  notify();
}

function fail(e: unknown) {
  errorMsg = describeSyncError(e);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setState('offline');
    return;
  }
  console.warn('[sync]', e);
  setState('error');
}

// ---------------------------------------------------------------------------
// mensajes de error

/**
 * Traduce los errores habituales de Drive y de Google Identity Services a un
 * texto claro en el idioma de la app. El usuario nunca ve la jerga cruda.
 */
export function describeSyncError(e: unknown): string {
  if (e instanceof DriveError) {
    if (e.status === 401 || e.status === 403) {
      const r = e.reason.toLowerCase();
      if (r.includes('ratelimit') || r.includes('quota')) return t('ui_sync_err_rate_limit');
      if (e.status === 401) return t('ui_sync_err_reconnect');
      return t('ui_sync_err_denied');
    }
    if (e.status === 429) return t('ui_sync_err_rate_limit');
    if (e.status >= 500) return t('ui_sync_err_server');
  }
  const raw = typeof e === 'string' ? e : String((e as { message?: string })?.message ?? e ?? '');
  const m = raw.toLowerCase();
  if (!raw || raw === 'undefined' || raw === 'null') return t('ui_sync_err_unknown');
  if (m.includes('popup') || m.includes('access_denied') || m.includes('interaction_required')) return t('ui_sync_err_reconnect');
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed') || m.includes('network request failed')) {
    return t('ui_sync_err_network');
  }
  return `${t('ui_sync_err_unknown')} (${raw})`;
}

// ---------------------------------------------------------------------------
// ID de cliente de Google

/**
 * ID de cliente OAuth de la build, con respaldo en los ajustes de la app para
 * poder probarlo antes de fijarlo en el `.env`.
 */
export function getClientId(): string {
  const fromEnv = (import.meta.env?.VITE_GOOGLE_CLIENT_ID ?? '').trim();
  return fromEnv || (appSettings.googleClientId ?? '').trim();
}

/** ¿Esta build puede sincronizar (hay ID de cliente)? */
export function hasClientId(): boolean {
  return getClientId().length > 0;
}

// ---------------------------------------------------------------------------
// Google Identity Services

/** Carga el script de GIS bajo demanda (nunca en el arranque en frío). */
function ensureGis(): Promise<Gis> {
  const existing = (globalThis as { google?: Gis }).google;
  if (existing?.accounts?.oauth2) return Promise.resolve(existing);
  if (gisPromise) return gisPromise;
  gisPromise = new Promise<Gis>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('no DOM'));
      return;
    }
    const done = () => {
      const g = (globalThis as { google?: Gis }).google;
      if (g?.accounts?.oauth2) resolve(g);
      else reject(new Error(t('ui_sync_err_network')));
    };
    const prev = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (prev) {
      prev.addEventListener('load', done);
      prev.addEventListener('error', () => reject(new Error(t('ui_sync_err_network'))));
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', done);
    script.addEventListener('error', () => reject(new Error(t('ui_sync_err_network'))));
    document.head.appendChild(script);
  }).catch((e) => {
    gisPromise = null;
    throw e;
  });
  return gisPromise;
}

/** Cliente de token de GIS, creado una sola vez por ID de cliente. */
async function ensureTokenClient(): Promise<GisTokenClient> {
  if (tokenClient) return tokenClient;
  const gis = await ensureGis();
  tokenClient = gis.accounts.oauth2.initTokenClient({
    client_id: getClientId(),
    scope: SCOPES,
    callback: (r) => {
      const resolve = pendingToken;
      pendingToken = null;
      try {
        resolve?.(r);
      } catch {
        /* nunca lanzar desde un callback de Google */
      }
    },
    error_callback: () => {
      const resolve = pendingToken;
      pendingToken = null;
      try {
        resolve?.(null);
      } catch {
        /* ignorar */
      }
    }
  });
  return tokenClient;
}

/**
 * Pide un `access_token`. `silent` usa `prompt: ''` (sin interacción); Safari
 * puede bloquearlo, y entonces se devuelve `null` y el estado pasa a
 * `'signed-out'` con el aviso de volver a conectar.
 */
async function requestToken(silent: boolean): Promise<GoogleToken | null> {
  if (!hasClientId()) return null;
  const client = await ensureTokenClient();
  const response = await new Promise<GisTokenResponse | null>((resolve) => {
    let settled = false;
    const finish = (r: GisTokenResponse | null) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    pendingToken = finish;
    if (silent) window.setTimeout(() => finish(null), SILENT_TIMEOUT_MS);
    try {
      client.requestAccessToken(silent ? { prompt: '' } : undefined);
    } catch {
      finish(null);
    }
  });
  if (!response?.access_token) return null;
  const seconds = Number(response.expires_in ?? 3600);
  const next: GoogleToken = {
    token: response.access_token,
    exp: Date.now() + (Number.isFinite(seconds) ? seconds : 3600) * 1000,
    email: token?.email ?? ''
  };
  if (!next.email) next.email = await fetchEmail(next.token);
  token = next;
  await setKV(KV_TOKEN, next);
  return next;
}

/** ¿El token guardado sirve para usarlo ahora mismo? */
function tokenIsValid(v: GoogleToken | null | undefined): boolean {
  return !!v?.token && v.exp - TOKEN_SKEW_MS > Date.now();
}

/** Fuente de token para el cliente de Drive. */
const tokens: TokenSource = {
  async get() {
    if (token && tokenIsValid(token)) return token.token;
    const next = await renew();
    return next?.token ?? null;
  },
  async refresh() {
    const next = await renew();
    return next?.token ?? null;
  }
};

/** Renovación silenciosa; si falla, se corta la sesión con un aviso claro. */
async function renew(): Promise<GoogleToken | null> {
  try {
    const next = await requestToken(true);
    if (next) return next;
  } catch {
    /* tratado abajo como sesión caída */
  }
  await forgetSession(t('ui_sync_err_reconnect'));
  return null;
}

/** Olvida la sesión local y deja el estado en `'signed-out'`. */
async function forgetSession(message = ''): Promise<void> {
  token = null;
  await stop();
  errorMsg = message;
  setState(hasClientId() ? 'signed-out' : 'off');
}

// ---------------------------------------------------------------------------
// arranque / parada

/**
 * Arranca la sincronización. Es idempotente: se puede llamar varias veces
 * (al iniciar la app, tras conectar con Google o tras pegar un ID de cliente).
 */
export async function initSync(appRef: App): Promise<void> {
  app = appRef;
  bindNetwork();
  try {
    lastSyncAt = await getKV<number>(KV_LAST_SYNC, 0);
    if (!hasClientId()) {
      token = null;
      setState('off');
      return;
    }
    const saved = await getKV<GoogleToken | null>(KV_TOKEN, null);
    if (!saved?.token) {
      token = null;
      setState('signed-out');
      return;
    }
    if (tokenIsValid(saved)) {
      token = saved;
      // el script de GIS sólo hace falta para renovar: se carga en segundo plano
      void ensureGis().catch(() => undefined);
      await start();
      return;
    }
    // había sesión pero el token venció: GIS puede renovarla sin molestar
    token = saved;
    setState('signed-out');
    void ensureGis().catch(() => undefined);
    if (await renew()) await start();
  } catch (e) {
    fail(e);
  }
}

async function start(): Promise<void> {
  if (!token) return;
  drive ??= new Drive(tokens);
  const d = drive;

  // los bitmaps que falten se bajan de Drive al vuelo
  setRemoteBlobProvider(async (id) => {
    if (!token) return null;
    const blob = await d.downloadBlob(id);
    if (!blob) return null;
    const { w, h } = await decodeSize(blob);
    return { blob, w, h };
  });

  watchStore();
  startPolling();
  await fullSync();
}

async function stop(): Promise<void> {
  syncedDigest.clear();
  fileIds.clear();
  uploadedBlobs.clear();
  drive?.reset();
  setRemoteBlobProvider(null);
  unsubscribeStore?.();
  unsubscribeStore = null;
  if (typeof window !== 'undefined') {
    clearTimeout(pushTimer);
    clearInterval(pollTimer);
  }
  pushTimer = 0;
  pollTimer = 0;
}

function bindNetwork() {
  if (netBound || typeof window === 'undefined') return;
  netBound = true;
  window.addEventListener('online', () => {
    if (token) void fullSync();
  });
  window.addEventListener('offline', () => {
    if (token) setState('offline');
  });
  document.addEventListener('visibilitychange', () => {
    if (!token) return;
    if (document.visibilityState === 'visible') void fullSync();
    else void pushCurrentScene();
  });
  // en iPad (Split View, Slide Over) la app puede seguir visible y perder el foco
  window.addEventListener('focus', () => {
    if (!token || Date.now() - lastPollAt < FOCUS_THROTTLE_MS) return;
    void pollChanges();
  });
}

/**
 * Sube el tablero abierto 2 s después del último cambio real, sin acercar
 * dos subidas a menos de `PUSH_MIN_GAP_MS`.
 */
function watchStore() {
  if (unsubscribeStore || !app) return;
  unsubscribeStore = app.store.subscribe((e) => {
    if (e.type === 'viewport' || e.type === 'selection') return;
    if (typeof window === 'undefined') return;
    clearTimeout(pushTimer);
    const wait = Math.max(PUSH_DEBOUNCE_MS, lastPushAt + PUSH_MIN_GAP_MS - Date.now());
    pushTimer = window.setTimeout(() => void pushCurrentScene(), wait);
  });
}

/**
 * Sondea `changes.list` cada 10 s mientras la app está visible y, una vez por
 * minuto, reconcilia la lista completa por si el flujo de cambios se retrasa.
 */
function startPolling() {
  if (pollTimer || typeof window === 'undefined') return;
  let ticks = 0;
  pollTimer = window.setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    ticks++;
    if (ticks % FULL_EVERY_N_POLLS === 0) void fullSync();
    else void pollChanges();
  }, POLL_MS);
}

// ---------------------------------------------------------------------------
// conectar / desconectar

/**
 * Pide permiso a Google y arranca la sincronización.
 * Nunca lanza: devuelve `false` y deja el motivo en `getSyncError()`.
 */
export async function connectGoogle(): Promise<boolean> {
  if (!hasClientId()) {
    errorMsg = t('ui_sync_no_client_id');
    setState('off');
    return false;
  }
  try {
    setState('syncing');
    const next = await requestToken(false);
    if (!next) {
      await forgetSession(t('ui_sync_err_reconnect'));
      return false;
    }
    await start();
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

/** Revoca el token en Google, olvida la sesión y deja de sincronizar. */
export async function disconnectGoogle(): Promise<void> {
  const current = token?.token;
  try {
    if (current) {
      const gis = (globalThis as { google?: Gis }).google;
      gis?.accounts?.oauth2?.revoke?.(current);
    }
  } catch {
    /* si Google no responde, igual olvidamos la sesión aquí */
  }
  tokenClient = null;
  await setKV(KV_TOKEN, null);
  await setKV(KV_PAGE_TOKEN, null);
  await forgetSession();
}

/**
 * Guarda el ID de cliente escrito a mano (modo desarrollador) y reinicia el
 * motor. `appRef` sólo hace falta si todavía no se llamó a `initSync`.
 */
export async function setClientId(id: string, appRef: App | null = null): Promise<void> {
  await updateAppSettings({ googleClientId: id.trim() });
  tokenClient = null;
  gisPromise = null;
  const target = appRef ?? app;
  if (target) await initSync(target);
}

/** Fuerza una sincronización completa ahora mismo. */
export async function syncNow(): Promise<void> {
  await fullSync();
}

// ---------------------------------------------------------------------------
// sincronización

async function fullSync(): Promise<void> {
  if (!drive || !token) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setState('offline');
    return;
  }
  if (syncing) {
    syncPending = true;
    return;
  }
  syncing = true;
  setState('syncing');
  try {
    const remote = await drive.listScenes();
    const remoteById = new Map<string, RemoteSceneMeta>();
    for (const m of remote) {
      remoteById.set(m.sceneId, m);
      fileIds.set(m.sceneId, m.fileId);
    }
    const local = await listScenes();
    const localById = new Map(local.map((l) => [l.id, l]));
    const openId = app?.store.scene.id;
    const ids = new Set<string>([...remoteById.keys(), ...local.map((l) => l.id)]);
    for (const id of ids) {
      const meta = remoteById.get(id) ?? null;
      if (id !== openId && (await unchangedSinceLastSync(id, meta, localById.get(id)))) continue;
      await syncScene(id, meta);
    }
    await pushCurrentScene();
    await drive.pruneDeleted(remote);
    await ensurePageToken();
    lastSyncAt = Date.now();
    lastPollAt = lastSyncAt;
    await setKV(KV_LAST_SYNC, lastSyncAt);
    setState('synced');
  } catch (e) {
    fail(e);
  } finally {
    syncing = false;
    if (syncPending) {
      syncPending = false;
      void fullSync();
    }
  }
}

/**
 * Atajo de la reconciliación periódica: si Drive no cambió desde la última
 * sincronización y el `updatedAt` local es el anotado entonces, no hace falta
 * leer el tablero completo de IndexedDB.
 */
async function unchangedSinceLastSync(id: string, meta: RemoteSceneMeta | null, local: SceneMeta | undefined): Promise<boolean> {
  if (!meta || !local || meta.deleted) return false;
  const rec = await getKV<SyncRecord | null>(recKey(id), null);
  if (!rec || rec.updatedAt === undefined) return false;
  return rec.remoteMtime === meta.modifiedTime && rec.updatedAt === local.updatedAt;
}

/**
 * Anota el punto de partida de `changes.list` la primera vez. Si Drive no
 * responde no pasa nada: se reintenta en la próxima sincronización.
 */
async function ensurePageToken(): Promise<void> {
  try {
    if (!drive) return;
    if (await getKV<string | null>(KV_PAGE_TOKEN, null)) return;
    const startToken = await drive.startPageToken();
    if (startToken) await setKV(KV_PAGE_TOKEN, startToken);
  } catch {
    /* el sondeo de cambios es un extra: no puede romper la sincronización */
  }
}

/**
 * Reconcilia un tablero concreto contra su archivo en Drive.
 *
 * @param id   identificador del tablero.
 * @param meta resumen remoto, o `null` si en Drive no existe.
 */
async function syncScene(id: string, meta: RemoteSceneMeta | null): Promise<void> {
  const d = drive;
  if (!d || !token) return;

  // el tablero abierto puede tener cambios que aún no llegan a IndexedDB
  const localScene = app && app.store.scene.id === id ? app.store.scene : await loadScene(id);
  const rec = await getKV<SyncRecord | null>(recKey(id), null);

  // borrado en Drive ⇒ borrarlo aquí también
  if (meta?.deleted) {
    if (localScene) await removeLocalScene(id);
    await setKV(recKey(id), null);
    syncedDigest.delete(id);
    return;
  }

  // sólo local ⇒ subirlo
  if (!meta) {
    if (localScene) await pushScene(localScene);
    return;
  }

  // sólo remoto
  if (!localScene) {
    if (rec) {
      // lo teníamos sincronizado y ya no está ⇒ se borró en este dispositivo
      await d.softDeleteScene(meta.fileId);
      await setKV(recKey(id), null);
      syncedDigest.delete(id);
      return;
    }
    const remote = await d.downloadScene(meta.fileId);
    if (remote) {
      await saveAndApply(remote);
      await markSynced(remote, meta.fileId, meta.modifiedTime);
    }
    return;
  }

  // en ambos lados: ¿qué cambió desde la última sincronización?
  const localDigest = sceneDigest(localScene);
  const localChanged = !rec || rec.digest !== localDigest;
  const remoteChanged = !rec || rec.remoteMtime !== meta.modifiedTime;
  if (!localChanged && !remoteChanged) return;
  if (localChanged && !remoteChanged) {
    await pushScene(localScene);
    return;
  }

  const remote = await d.downloadScene(meta.fileId);
  if (!remote) {
    await pushScene(localScene);
    return;
  }
  if (!localChanged) {
    await saveAndApply(remote);
    await markSynced(remote, meta.fileId, meta.modifiedTime);
    return;
  }

  // los dos cambiaron ⇒ fusionar
  const merged = mergeScenes(localScene, remote);
  const out = merged.scene;
  if (merged.remoteChanged) {
    // Drive debe ver una marca nueva para que los demás dispositivos se enteren
    out.updatedAt = Math.max(out.updatedAt + 1, Date.now());
    await saveAndApply(out);
    await pushScene(out, true);
  } else {
    await saveAndApply(out);
    await markSynced(out, meta.fileId, meta.modifiedTime);
  }
}

/** Consulta los cambios que hizo el otro dispositivo desde la última vez. */
async function pollChanges(): Promise<void> {
  if (!drive || !token || syncing) return;
  syncing = true;
  try {
    lastPollAt = Date.now();
    const pageToken = await getKV<string | null>(KV_PAGE_TOKEN, null);
    if (!pageToken) {
      await setKV(KV_PAGE_TOKEN, await drive.startPageToken());
      return;
    }
    const { changes, nextToken } = await drive.listChanges(pageToken);
    if (nextToken && nextToken !== pageToken) await setKV(KV_PAGE_TOKEN, nextToken);
    const touched: RemoteSceneMeta[] = [];
    for (const c of changes) {
      const props = c.file?.appProperties;
      if (c.removed || !c.file || props?.kind !== 'scene') continue;
      const sceneId = props.sceneId ?? c.file.name.replace(/\.json$/i, '');
      if (!sceneId) continue;
      touched.push({
        fileId: c.file.id ?? c.fileId,
        sceneId,
        modifiedTime: Date.parse(c.file.modifiedTime ?? '') || 0,
        deleted: props.deleted === '1'
      });
    }
    if (!touched.length) return;
    setState('syncing');
    for (const meta of touched) {
      fileIds.set(meta.sceneId, meta.fileId);
      const rec = await getKV<SyncRecord | null>(recKey(meta.sceneId), null);
      if (rec && rec.remoteMtime === meta.modifiedTime) continue; // eco de lo nuestro
      await syncScene(meta.sceneId, meta);
    }
    lastSyncAt = Date.now();
    await setKV(KV_LAST_SYNC, lastSyncAt);
    setState('synced');
  } catch (e) {
    fail(e);
  } finally {
    syncing = false;
    if (syncPending) {
      syncPending = false;
      void fullSync();
    }
  }
}

/** Sube el tablero abierto si su contenido difiere de lo ya sincronizado. */
async function pushCurrentScene(): Promise<void> {
  try {
    if (!app || !drive || !token) return;
    const scene = app.store.scene;
    if (syncedDigest.get(scene.id) === sceneDigest(scene)) return;
    await pushScene(scene);
    lastSyncAt = Date.now();
    await setKV(KV_LAST_SYNC, lastSyncAt);
    if (state !== 'syncing') setState('synced');
  } catch (e) {
    fail(e);
  }
}

/** Sube un tablero y sus bitmaps, y anota la huella sincronizada. */
async function pushScene(scene: Scene, force = false): Promise<void> {
  const d = drive;
  if (!d || !token) return;
  const digest = sceneDigest(scene);
  if (!force && syncedDigest.get(scene.id) === digest) return;
  let fileId = fileIds.get(scene.id) ?? null;
  if (!fileId) {
    const rec = await getKV<SyncRecord | null>(recKey(scene.id), null);
    fileId = rec?.fileId ?? null;
  }
  const saved = await d.uploadScene(scene, fileId);
  lastPushAt = Date.now();
  fileIds.set(scene.id, saved.fileId);
  await uploadSceneBlobs(scene);
  await markSynced(scene, saved.fileId, saved.modifiedTime, digest);
}

async function markSynced(
  scene: Scene,
  fileId: string,
  remoteMtime: number,
  digest = sceneDigest(scene)
): Promise<void> {
  syncedDigest.set(scene.id, digest);
  fileIds.set(scene.id, fileId);
  const rec: SyncRecord = { digest, remoteMtime, fileId, updatedAt: scene.updatedAt };
  await setKV(recKey(scene.id), rec);
}

/** Guarda el tablero localmente y, si es el abierto, lo aplica al store. */
async function saveAndApply(scene: Scene): Promise<void> {
  const isOpen = !!app && app.store.scene.id === scene.id;
  if (isOpen && app!.gestures.busy) {
    // no interrumpir un gesto en curso: reintentar en un segundo
    window.setTimeout(() => void saveAndApply(scene), BUSY_RETRY_MS);
    return;
  }
  await saveScene(scene);
  syncedDigest.set(scene.id, sceneDigest(scene));
  if (isOpen) {
    app!.store.applyRemote(scene);
  } else if (app) {
    // `saveScene` marca el tablero guardado como "último abierto": restaurarlo
    await setKV('lastSceneId', app.store.scene.id);
  }
}

/** Borra un tablero local; si estaba abierto, cambia a otro sin resucitarlo. */
async function removeLocalScene(id: string): Promise<void> {
  if (app && app.store.scene.id === id) {
    app.store.dirty = false; // que el autosave no lo vuelva a escribir
    const others = (await listScenes()).filter((s) => s.id !== id);
    await deleteScene(id);
    if (others.length) {
      await app.openSceneById(others[0].id);
    } else {
      app.store.loadScene(createScene(t('ui_scene_untitled')));
      await saveScene(app.store.scene);
    }
  } else {
    await deleteScene(id);
  }
  syncedDigest.delete(id);
}

/**
 * Marca un tablero como borrado en Drive. La app no necesita llamarla (el
 * borrado local se detecta solo en la siguiente sincronización), pero es útil
 * para propagarlo al instante.
 */
export async function markSceneDeleted(id: string): Promise<void> {
  try {
    if (!drive || !token) return;
    let fileId = fileIds.get(id) ?? null;
    if (!fileId) {
      const rec = await getKV<SyncRecord | null>(recKey(id), null);
      fileId = rec?.fileId ?? null;
    }
    if (!fileId) {
      const remote = await drive.listScenes();
      for (const m of remote) fileIds.set(m.sceneId, m.fileId);
      fileId = fileIds.get(id) ?? null;
    }
    if (!fileId) return;
    await drive.softDeleteScene(fileId);
    await setKV(recKey(id), null);
    syncedDigest.delete(id);
    fileIds.delete(id);
  } catch (e) {
    fail(e);
  }
}

// ---------------------------------------------------------------------------
// bitmaps

async function uploadSceneBlobs(scene: Scene): Promise<void> {
  const d = drive;
  if (!d || !token) return;
  for (const it of scene.items) {
    if (it.kind !== 'image') continue;
    if (uploadedBlobs.has(it.blobId)) continue;
    if (await d.hasBlob(it.blobId)) {
      uploadedBlobs.add(it.blobId);
      continue;
    }
    const blob = await getLocalBlob(it.blobId);
    if (!blob) continue; // aún no está aquí; ya se subirá desde el otro dispositivo
    await d.uploadBlob(it.blobId, blob);
    uploadedBlobs.add(it.blobId);
  }
}

/** Dimensiones reales de un bitmap descargado (Safari admite createImageBitmap). */
async function decodeSize(blob: Blob): Promise<{ w: number; h: number }> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob);
      const size = { w: bmp.width, h: bmp.height };
      bmp.close?.();
      return size;
    }
  } catch {
    /* caer al <img> */
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ w: 0, h: 0 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}
