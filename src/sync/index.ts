/**
 * Motor de sincronización entre dispositivos (iPhone ⇄ iPad ⇄ …).
 *
 * Es completamente opcional: mientras el usuario no configure un proyecto de
 * Supabase el estado es `'off'` y este módulo no carga el SDK (se importa con
 * `import()` dinámico, así que no pesa en el bundle inicial).
 *
 * Flujo:
 *  1. `initSync(app)` al arrancar: lee la configuración y la sesión guardada.
 *  2. `fullSync()` compara las escenas locales con las remotas y sube, baja o
 *     fusiona (`mergeScenes`) según corresponda.
 *  3. Realtime avisa de los cambios hechos en el otro dispositivo.
 *  4. Cualquier cambio local se sube 3 s después del último evento del store.
 *
 * Nada de lo que ocurre aquí puede romper la app: todos los callbacks están
 * envueltos en `try/catch` y los fallos sólo cambian el estado a `'error'`.
 */
import type { App } from '../app';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { RemoteSceneMeta, SceneChange, SyncConfig } from './supabase';
import { createScene, type Scene } from '../core/model';
import {
  deleteScene,
  getKV,
  getLocalBlob,
  listScenes,
  loadScene,
  saveScene,
  setKV,
  setRemoteBlobProvider
} from '../core/persistence';
import { t } from '../i18n';
import { mergeScenes, sceneDigest } from './merge';

export type { SyncConfig } from './supabase';
export { mergeScenes, sceneDigest } from './merge';

/** Estados observables de la sincronización. */
export type SyncState = 'off' | 'signed-out' | 'syncing' | 'synced' | 'offline' | 'error';

/** Milisegundos de espera tras el último cambio antes de subir la escena. */
const PUSH_DEBOUNCE_MS = 3000;
/** Reintento cuando el usuario está en medio de un gesto. */
const BUSY_RETRY_MS = 1000;

const KV_CONFIG = 'syncConfig';
const KV_LAST_SYNC = 'lastSyncAt';
const KV_BLOBS = 'syncedBlobs';
const recKey = (sceneId: string) => `lastSync:${sceneId}`;

/** Huella de la escena tal como quedó en la última sincronización. */
interface SyncRecord {
  /** `sceneDigest` del contenido sincronizado. */
  digest: string;
  /** `updated_at` remoto (ms) correspondiente. */
  remote: number;
}

type Engine = typeof import('./supabase');

// ---------------------------------------------------------------------------
// estado del módulo

let app: App | null = null;
let engine: Engine | null = null;
let sb: SupabaseClient | null = null;
let cfg: SyncConfig | null = null;
let user: { id: string; email: string } | null = null;
let channel: RealtimeChannel | null = null;

let state: SyncState = 'off';
let errorMsg = '';
let lastSyncAt = 0;
let syncing = false;
let syncPending = false;
let netBound = false;

let unsubscribeStore: (() => void) | null = null;
let pushTimer = 0;
/** Huella del último contenido sincronizado, por escena (evita subir ecos). */
const syncedDigest = new Map<string, string>();
/** Bitmaps que ya están en Storage. */
let uploadedBlobs: Set<string> | null = null;

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

/** Usuario con sesión iniciada, o `null`. */
export function getSyncUser(): { email: string } | null {
  return user ? { email: user.email } : null;
}

/** Configuración guardada del proyecto Supabase, o `null`. */
export function getSyncConfig(): SyncConfig | null {
  return cfg;
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
  if (s !== 'error' && s !== 'offline') errorMsg = '';
  notify();
}

function fail(e: unknown) {
  errorMsg = engine ? engine.errorMessage(e) : String((e as { message?: string })?.message ?? e);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setState('offline');
    return;
  }
  console.warn('[sync]', e);
  setState('error');
}

// ---------------------------------------------------------------------------
// carga perezosa del SDK

async function loadEngine(): Promise<Engine> {
  if (!engine) engine = await import('./supabase');
  return engine;
}

/** Crea (o reutiliza) el cliente de Supabase. Lanza si no hay configuración. */
async function ensureClient(): Promise<SupabaseClient> {
  if (sb) return sb;
  if (!cfg) cfg = await getKV<SyncConfig | null>(KV_CONFIG, null);
  if (!cfg?.url || !cfg?.anonKey) throw new Error(t('ui_sync_not_configured'));
  const eng = await loadEngine();
  sb = eng.createSupabase(cfg);
  sb.auth.onAuthStateChange((event, session) => {
    try {
      if (event === 'SIGNED_OUT' || !session?.user) {
        if (user) void stop();
        return;
      }
      user = { id: session.user.id, email: session.user.email ?? '' };
    } catch {
      /* nunca lanzar desde un callback */
    }
  });
  return sb;
}

// ---------------------------------------------------------------------------
// arranque / parada

/**
 * Arranca la sincronización si hay configuración y sesión. Es idempotente y
 * seguro llamarla varias veces (tras configurar o iniciar sesión).
 */
export async function initSync(appRef: App): Promise<void> {
  app = appRef;
  bindNetwork();
  try {
    cfg = await getKV<SyncConfig | null>(KV_CONFIG, null);
    lastSyncAt = await getKV<number>(KV_LAST_SYNC, 0);
    if (!cfg?.url || !cfg?.anonKey) {
      setState('off');
      return;
    }
    const client = await ensureClient();
    const { data } = await client.auth.getSession();
    if (!data.session?.user) {
      user = null;
      setState('signed-out');
      return;
    }
    user = { id: data.session.user.id, email: data.session.user.email ?? '' };
    await start();
  } catch (e) {
    fail(e);
  }
}

async function start(): Promise<void> {
  if (!sb || !user) return;
  const eng = await loadEngine();
  const client = sb;
  const uid = user.id;

  // los bitmaps que falten se bajan de Storage al vuelo
  setRemoteBlobProvider(async (id) => {
    if (!sb || !user) return null;
    const blob = await eng.downloadBlob(sb, user.id, id);
    if (!blob) return null;
    const { w, h } = await decodeSize(blob);
    return { blob, w, h };
  });

  watchStore();

  if (channel) {
    try {
      await client.removeChannel(channel);
    } catch {
      /* ignorar */
    }
    channel = null;
  }
  channel = eng.subscribeScenes(client, uid, (c) => void onRemoteChange(c));

  await fullSync();
}

async function stop(): Promise<void> {
  user = null;
  syncedDigest.clear();
  uploadedBlobs = null;
  setRemoteBlobProvider(null);
  unsubscribeStore?.();
  unsubscribeStore = null;
  clearTimeout(pushTimer);
  if (sb && channel) {
    try {
      await sb.removeChannel(channel);
    } catch {
      /* ignorar */
    }
  }
  channel = null;
  setState(cfg ? 'signed-out' : 'off');
}

function bindNetwork() {
  if (netBound || typeof window === 'undefined') return;
  netBound = true;
  window.addEventListener('online', () => {
    if (user) void fullSync();
  });
  window.addEventListener('offline', () => {
    if (user) setState('offline');
  });
  document.addEventListener('visibilitychange', () => {
    if (!user) return;
    if (document.visibilityState === 'visible') void fullSync();
    else void pushCurrentScene();
  });
}

/** Sube la escena abierta 3 s después del último cambio real. */
function watchStore() {
  if (unsubscribeStore || !app) return;
  unsubscribeStore = app.store.subscribe((e) => {
    if (e.type === 'viewport' || e.type === 'selection') return;
    clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => void pushCurrentScene(), PUSH_DEBOUNCE_MS);
  });
}

// ---------------------------------------------------------------------------
// configuración y sesión

/** Guarda la URL y la clave anon del proyecto y reinicia el motor. */
export async function configureSync(next: SyncConfig): Promise<void> {
  const url = next.url.trim().replace(/\/+$/, '');
  const anonKey = next.anonKey.trim();
  if (!/^https?:\/\//i.test(url) || !anonKey) throw new Error(t('ui_sync_invalid_config'));
  await stop();
  sb = null;
  cfg = { url, anonKey };
  await setKV(KV_CONFIG, cfg);
  if (app) await initSync(app);
}

/** Olvida el proyecto configurado (cierra sesión y deja el estado en `'off'`). */
export async function clearSyncConfig(): Promise<void> {
  try {
    if (sb) await sb.auth.signOut();
  } catch {
    /* ignorar */
  }
  await stop();
  sb = null;
  cfg = null;
  await setKV(KV_CONFIG, null);
  setState('off');
}

/** Envía un código de un solo uso al correo indicado. */
export async function sendOtp(email: string): Promise<void> {
  const client = await ensureClient();
  const eng = await loadEngine();
  const { error } = await client.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
  if (error) throw new Error(eng.errorMessage(error));
}

/** Verifica el código recibido por correo e inicia la sincronización. */
export async function verifyOtp(email: string, code: string): Promise<void> {
  const client = await ensureClient();
  const eng = await loadEngine();
  const { data, error } = await client.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
  if (error) throw new Error(eng.errorMessage(error));
  if (!data.user) throw new Error(t('ui_sync_invalid_code'));
  user = { id: data.user.id, email: data.user.email ?? email.trim() };
  await start();
}

/** Cierra la sesión en este dispositivo (los datos locales se conservan). */
export async function signOut(): Promise<void> {
  try {
    if (sb) await sb.auth.signOut();
  } catch (e) {
    fail(e);
  }
  await stop();
}

/** Fuerza una sincronización completa ahora mismo. */
export async function syncNow(): Promise<void> {
  await fullSync();
}

// ---------------------------------------------------------------------------
// sincronización

async function fullSync(): Promise<void> {
  if (!sb || !user) return;
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
    const eng = await loadEngine();
    const remote = await eng.listRemoteScenes(sb);
    const local = await listScenes();
    const remoteById = new Map(remote.map((r) => [r.id, r]));
    const ids = new Set<string>([...remote.map((r) => r.id), ...local.map((l) => l.id)]);
    for (const id of ids) await syncScene(id, remoteById.get(id) ?? null);
    await pushCurrentScene();
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

/**
 * Reconcilia una escena concreta. `remoteMeta` puede venir de la lista de
 * `fullSync`; si es `undefined` se consulta al servidor.
 */
async function syncScene(id: string, remoteMeta: RemoteSceneMeta | null | undefined): Promise<void> {
  const client = sb;
  const u = user;
  if (!client || !u) return;
  const eng = await loadEngine();

  let meta = remoteMeta;
  if (meta === undefined) {
    const list = await eng.listRemoteScenes(client);
    meta = list.find((m) => m.id === id) ?? null;
  }

  // la escena abierta puede tener cambios que aún no llegan a IndexedDB
  const localScene = app && app.store.scene.id === id ? app.store.scene : await loadScene(id);
  const rec = await getKV<SyncRecord | null>(recKey(id), null);

  // borrada en el servidor ⇒ borrarla aquí
  if (meta?.deleted) {
    if (localScene) await removeLocalScene(id);
    await setKV(recKey(id), null);
    syncedDigest.delete(id);
    return;
  }

  // sólo local ⇒ subirla
  if (!meta) {
    if (localScene) await pushScene(localScene);
    return;
  }

  // sólo remota
  if (!localScene) {
    if (rec) {
      // la teníamos sincronizada y ya no está ⇒ se borró en este dispositivo
      await eng.softDeleteRemoteScene(client, u.id, id);
      await setKV(recKey(id), null);
      syncedDigest.delete(id);
      return;
    }
    const remote = await eng.fetchRemoteScene(client, id);
    if (remote?.scene) {
      await saveAndApply(remote.scene);
      await markSynced(remote.scene, remote.updatedAt);
    }
    return;
  }

  // en ambos lados: ¿qué cambió desde la última sincronización?
  const localDigest = sceneDigest(localScene);
  const localChanged = !rec || rec.digest !== localDigest;
  const remoteChanged = !rec || rec.remote !== meta.updatedAt;
  if (!localChanged && !remoteChanged) return;
  if (localChanged && !remoteChanged) {
    await pushScene(localScene);
    return;
  }

  const remote = await eng.fetchRemoteScene(client, id);
  if (!remote?.scene) {
    await pushScene(localScene);
    return;
  }
  if (!localChanged) {
    await saveAndApply(remote.scene);
    await markSynced(remote.scene, remote.updatedAt);
    return;
  }

  // los dos cambiaron ⇒ fusionar
  const merged = mergeScenes(localScene, remote.scene);
  const out = merged.scene;
  if (merged.remoteChanged) {
    // el servidor debe ver una marca de tiempo nueva para que los demás
    // dispositivos se enteren de la fusión
    out.updatedAt = Math.max(out.updatedAt + 1, Date.now());
    await saveAndApply(out);
    await pushScene(out, true);
  } else {
    await saveAndApply(out);
    await markSynced(out, remote.updatedAt);
  }
}

/** Reacciona a un cambio anunciado por Realtime. */
async function onRemoteChange(change: SceneChange): Promise<void> {
  try {
    if (!sb || !user) return;
    if (!change) {
      await fullSync();
      return;
    }
    const rec = await getKV<SyncRecord | null>(recKey(change.id), null);
    if (rec && rec.remote === change.updatedAt) return; // eco de nuestra propia subida
    setState('syncing');
    await syncScene(change.id, { id: change.id, name: '', updatedAt: change.updatedAt, deleted: change.deleted });
    lastSyncAt = Date.now();
    await setKV(KV_LAST_SYNC, lastSyncAt);
    setState('synced');
  } catch (e) {
    fail(e);
  }
}

/** Sube la escena abierta si su contenido difiere de lo ya sincronizado. */
async function pushCurrentScene(): Promise<void> {
  try {
    if (!app || !sb || !user) return;
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

/** Sube una escena y sus bitmaps, y anota la huella sincronizada. */
async function pushScene(scene: Scene, force = false): Promise<void> {
  const client = sb;
  const u = user;
  if (!client || !u) return;
  const digest = sceneDigest(scene);
  if (!force && syncedDigest.get(scene.id) === digest) return;
  const eng = await loadEngine();
  await eng.pushRemoteScene(client, u.id, scene);
  await uploadSceneBlobs(scene);
  await markSynced(scene, scene.updatedAt, digest);
}

async function markSynced(scene: Scene, remoteUpdatedAt: number, digest = sceneDigest(scene)): Promise<void> {
  syncedDigest.set(scene.id, digest);
  const rec: SyncRecord = { digest, remote: remoteUpdatedAt };
  await setKV(recKey(scene.id), rec);
}

/** Guarda la escena localmente y, si es la abierta, la aplica al store. */
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
    // `saveScene` marca la escena guardada como "última abierta": restaurarlo
    await setKV('lastSceneId', app.store.scene.id);
  }
}

/** Borra una escena local; si estaba abierta, cambia a otra sin resucitarla. */
async function removeLocalScene(id: string): Promise<void> {
  if (app && app.store.scene.id === id) {
    app.store.dirty = false; // que el autosave no la vuelva a escribir
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
 * Marca una escena como borrada en el servidor. La app no necesita llamarla
 * (el borrado local se detecta solo en la siguiente sincronización), pero es
 * útil para propagarlo al instante.
 */
export async function markSceneDeleted(id: string): Promise<void> {
  try {
    if (!sb || !user) return;
    const eng = await loadEngine();
    await eng.softDeleteRemoteScene(sb, user.id, id);
    await setKV(recKey(id), null);
    syncedDigest.delete(id);
  } catch (e) {
    fail(e);
  }
}

// ---------------------------------------------------------------------------
// bitmaps

async function uploadSceneBlobs(scene: Scene): Promise<void> {
  const client = sb;
  const u = user;
  if (!client || !u) return;
  const eng = await loadEngine();
  if (!uploadedBlobs) uploadedBlobs = new Set(await getKV<string[]>(KV_BLOBS, []));
  let changed = false;
  for (const it of scene.items) {
    if (it.kind !== 'image') continue;
    if (uploadedBlobs.has(it.blobId)) continue;
    const blob = await getLocalBlob(it.blobId);
    if (!blob) continue; // aún no está aquí; ya se subirá desde el otro dispositivo
    await eng.uploadBlob(client, u.id, it.blobId, blob);
    uploadedBlobs.add(it.blobId);
    changed = true;
  }
  if (changed) await setKV(KV_BLOBS, [...uploadedBlobs]);
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
