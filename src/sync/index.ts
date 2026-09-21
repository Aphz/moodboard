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

/** Largo mínimo de la contraseña (coincide con el mínimo por defecto de Supabase). */
export const MIN_PASSWORD_LENGTH = 8;

/** Resultado de `signIn`, pensado para que la interfaz decida qué mostrar. */
export type SignInCode = 'ok' | 'confirm-email' | 'wrong-password' | 'error';

/** Respuesta de `signIn`: nunca lanza, siempre trae un mensaje traducido. */
export interface SignInResult {
  ok: boolean;
  code: SignInCode;
  message: string;
}

/** Estado de un paso del asistente: ✅ ❌ ⏳. */
export type SetupStepState = 'ok' | 'fail' | 'pending';

/** Un paso comprobado, con su explicación de una línea ya traducida. */
export interface SetupStep {
  state: SetupStepState;
  message: string;
}

/** Informe del asistente de configuración (`checkSetup`). */
export interface SetupReport {
  /** Subdominio del proyecto (`abcdefgh`), o cadena vacía si la URL no sirve. */
  ref: string;
  /** Paso A: la URL responde y la clave anon vale. */
  project: SetupStep;
  /** Paso B: `mailer_autoconfirm` activo (no se necesita el correo). */
  confirmEmail: SetupStep;
  /** Paso C: tabla `scenes` y bucket `blobs`. */
  data: SetupStep;
  /** `true` cuando falta ejecutar `supabase/schema.sql`. */
  needsSql: boolean;
}

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
 * Traduce los errores habituales de Supabase a un texto claro en el idioma de
 * la app. El usuario no debería ver nunca la jerga cruda de la API.
 */
export function describeSyncError(e: unknown): string {
  const raw = typeof e === 'string' ? e : String((e as { message?: string; error_description?: string })?.message ?? (e as { error_description?: string })?.error_description ?? e ?? '');
  const m = raw.toLowerCase();
  if (!raw || raw === 'undefined' || raw === 'null') return t('ui_sync_err_unknown');
  if (m.includes('rate limit') || m.includes('over_email_send_rate_limit') || m.includes('too many requests')) return t('ui_sync_err_rate_limit');
  if (m.includes('token has expired') || m.includes('otp_expired') || m.includes('expired or is invalid')) return t('ui_sync_err_token');
  if (m.includes('invalid login credentials') || m.includes('user already registered') || m.includes('user_already_exists')) return t('ui_sync_err_wrong_password');
  if (m.includes('email not confirmed') || m.includes('email_not_confirmed')) return t('ui_sync_err_confirm_email');
  if (m.includes('password should be at least') || m.includes('weak_password')) return t('ui_sync_password_short');
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed') || m.includes('network request failed')) return t('ui_sync_err_network');
  if (m.includes('could not find the table') || (m.includes('relation') && m.includes('does not exist'))) return t('ui_sync_data_no_table');
  if (m.includes('bucket not found')) return t('ui_sync_data_no_bucket');
  return `${t('ui_sync_err_unknown')} (${raw})`;
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

/**
 * Inicia sesión con correo y contraseña, creando la cuenta si hace falta.
 *
 * No depende del correo electrónico: primero prueba `signInWithPassword` y,
 * si esas credenciales no existen, registra la cuenta con `signUp`. Nunca
 * lanza; devuelve un resultado con un código para que la interfaz sepa qué
 * mostrar (por ejemplo, el enlace para desactivar "Confirm email").
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const mail = email.trim();
  if (!mail) return { ok: false, code: 'error', message: t('ui_sync_email_required') };
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, code: 'error', message: t('ui_sync_password_short') };
  try {
    const client = await ensureClient();

    // 1. ¿ya existe la cuenta?
    const signed = await client.auth.signInWithPassword({ email: mail, password });
    if (signed.data?.session?.user) return await adoptSession(signed.data.session.user, mail);
    if (signed.error && !isBadCredentials(signed.error)) {
      const message = describeSyncError(signed.error);
      const code: SignInCode = message === t('ui_sync_err_confirm_email') ? 'confirm-email' : 'error';
      return { ok: false, code, message };
    }

    // 2. no existe (o la contraseña no coincide) ⇒ intentar crearla
    const created = await client.auth.signUp({ email: mail, password });
    if (created.error) {
      const message = describeSyncError(created.error);
      const code: SignInCode = message === t('ui_sync_err_wrong_password') ? 'wrong-password' : 'error';
      return { ok: false, code, message };
    }
    if (created.data.session?.user) return await adoptSession(created.data.session.user, mail);

    const newUser = created.data.user as { identities?: unknown[] } | null;
    if (newUser) {
      // con "Confirm email" activado, Supabase devuelve un usuario sin
      // identidades cuando el correo ya estaba registrado (no delata cuentas)
      if (Array.isArray(newUser.identities) && newUser.identities.length === 0) {
        return { ok: false, code: 'wrong-password', message: t('ui_sync_err_wrong_password') };
      }
      // usuario creado pero sin sesión ⇒ falta desactivar la confirmación
      return { ok: false, code: 'confirm-email', message: t('ui_sync_err_confirm_email') };
    }
    return { ok: false, code: 'error', message: t('ui_sync_err_unknown') };
  } catch (e) {
    return { ok: false, code: 'error', message: describeSyncError(e) };
  }
}

/** ¿El error dice sólo que las credenciales no sirven (cuenta inexistente)? */
function isBadCredentials(e: unknown): boolean {
  const m = String((e as { message?: string })?.message ?? '').toLowerCase();
  const code = String((e as { code?: string })?.code ?? '').toLowerCase();
  return m.includes('invalid login credentials') || code === 'invalid_credentials';
}

/** Guarda el usuario recién autenticado y arranca la sincronización. */
async function adoptSession(u: { id: string; email?: string | null }, fallbackEmail: string): Promise<SignInResult> {
  user = { id: u.id, email: u.email ?? fallbackEmail };
  try {
    await start();
  } catch (e) {
    fail(e);
  }
  return { ok: true, code: 'ok', message: t('ui_sync_account_ok', { email: user.email }) };
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

// ---------------------------------------------------------------------------
// asistente de configuración

/** Subdominio del proyecto (`abcdefgh` en `https://abcdefgh.supabase.co`). */
export function getProjectRef(url: string): string {
  const m = /^https?:\/\/([a-z0-9-]+)\.supabase\.(co|in|net)\/?/i.exec(url.trim());
  return m ? m[1] : '';
}

/** Panel de Supabase: Authentication → Sign In / Providers. */
/** Página de usuarios del panel de Supabase (para borrar una cuenta creada a medias). */
export function usersUrl(url: string): string {
  const ref = getProjectRef(url);
  return ref ? `https://supabase.com/dashboard/project/${ref}/auth/users` : 'https://supabase.com/dashboard';
}

export function providersUrl(url: string): string {
  const ref = getProjectRef(url);
  return ref ? `https://supabase.com/dashboard/project/${ref}/auth/providers` : 'https://supabase.com/dashboard';
}

/** Panel de Supabase: SQL Editor con una consulta nueva. */
export function sqlEditorUrl(url: string): string {
  const ref = getProjectRef(url);
  return ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : 'https://supabase.com/dashboard';
}

/**
 * Comprueba la configuración del proyecto y devuelve un informe por pasos.
 *
 * El paso "proyecto" y el paso "confirmación de correo" se resuelven con una
 * sola llamada a `GET {url}/auth/v1/settings` (sólo `fetch`, sin el SDK), así
 * que se pueden probar con `fetch` simulado. El paso de datos (tabla `scenes`
 * y bucket `blobs`) necesita el cliente de Supabase ya configurado, por eso
 * sólo se ejecuta si se pide con `opts.data`.
 */
export async function checkSetup(
  config: SyncConfig | null = getSyncConfig(),
  opts: { data?: boolean } = {}
): Promise<SetupReport> {
  const report: SetupReport = {
    ref: '',
    project: { state: 'pending', message: t('ui_sync_project_pending') },
    confirmEmail: { state: 'pending', message: t('ui_sync_confirm_pending') },
    data: { state: 'pending', message: t('ui_sync_data_pending') },
    needsSql: false
  };
  const url = (config?.url ?? '').trim().replace(/\/+$/, '');
  const anonKey = (config?.anonKey ?? '').trim();
  if (!url || !anonKey) return report;

  report.ref = getProjectRef(url);
  if (!/^https?:\/\//i.test(url) || !report.ref) {
    report.project = { state: 'fail', message: t('ui_sync_project_bad_url') };
    return report;
  }

  let res: Response;
  try {
    res = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` }
    });
  } catch {
    report.project = { state: 'fail', message: t('ui_sync_project_bad_url') };
    return report;
  }
  if (res.status === 401 || res.status === 403) {
    report.project = { state: 'fail', message: t('ui_sync_project_bad_key') };
    return report;
  }
  if (!res.ok) {
    report.project = { state: 'fail', message: t('ui_sync_project_bad_url') };
    return report;
  }
  report.project = { state: 'ok', message: t('ui_sync_project_ok') };

  let settings: { mailer_autoconfirm?: boolean } = {};
  try {
    settings = ((await res.json()) as { mailer_autoconfirm?: boolean }) ?? {};
  } catch {
    settings = {};
  }
  report.confirmEmail =
    settings.mailer_autoconfirm === true
      ? { state: 'ok', message: t('ui_sync_confirm_ok') }
      : { state: 'fail', message: t('ui_sync_confirm_fail') };

  if (opts.data) await checkData(report);
  return report;
}

/** Comprueba la tabla `scenes` y el bucket `blobs` con el cliente guardado. */
async function checkData(report: SetupReport): Promise<void> {
  try {
    const client = await ensureClient();
    const eng = await loadEngine();

    const table = await client.from(eng.SCENES_TABLE).select('id', { head: true, count: 'exact' });
    if (table.error) {
      const msg = eng.errorMessage(table.error).toLowerCase();
      const code = String((table.error as { code?: string }).code ?? '');
      if (code === 'PGRST205' || code === '42P01' || msg.includes('does not exist') || msg.includes('could not find the table')) {
        report.data = { state: 'fail', message: t('ui_sync_data_no_table') };
        report.needsSql = true;
        return;
      }
      report.data = { state: 'fail', message: describeSyncError(table.error) };
      return;
    }

    const bucket = await client.storage.from(eng.BLOBS_BUCKET).list('', { limit: 1 });
    if (bucket.error) {
      const msg = eng.errorMessage(bucket.error).toLowerCase();
      if (msg.includes('bucket not found') || msg.includes('not found')) {
        report.data = { state: 'fail', message: t('ui_sync_data_no_bucket') };
        report.needsSql = true;
        return;
      }
      report.data = { state: 'fail', message: describeSyncError(bucket.error) };
      return;
    }

    report.data = { state: 'ok', message: t('ui_sync_data_ok') };
  } catch {
    report.data = { state: 'pending', message: t('ui_sync_data_pending') };
  }
}

// ---------------------------------------------------------------------------
// enlace para configurar el otro dispositivo

/** Prefijo del hash que transporta la configuración entre dispositivos. */
export const SETUP_HASH_PREFIX = '#setup=';

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Base del enlace: la app tal como está abierta, sin fijar ningún dominio. */
function currentBase(): string {
  return typeof location === 'undefined' ? '' : location.origin + location.pathname;
}

/**
 * Arma el enlace que lleva la configuración al otro dispositivo.
 * La clave anon es pública por diseño, así que puede viajar en el enlace.
 */
export function encodeSetupLink(config: SyncConfig, base: string = currentBase()): string {
  const payload = JSON.stringify({
    url: config.url.trim().replace(/\/+$/, ''),
    anonKey: config.anonKey.trim()
  });
  return `${base}${SETUP_HASH_PREFIX}${toBase64Url(payload)}`;
}

/**
 * Lee la configuración de un enlace o de un hash (`#setup=…`).
 * Devuelve `null` si no viene, está corrupto o no parece una URL de proyecto.
 */
export function decodeSetupLink(link: string): SyncConfig | null {
  try {
    const i = link.indexOf(SETUP_HASH_PREFIX);
    if (i < 0) return null;
    const raw = link.slice(i + SETUP_HASH_PREFIX.length).split('&')[0].trim();
    if (!raw) return null;
    const data = JSON.parse(fromBase64Url(raw)) as Partial<SyncConfig>;
    const url = String(data.url ?? '').trim().replace(/\/+$/, '');
    const anonKey = String(data.anonKey ?? '').trim();
    if (!/^https?:\/\//i.test(url) || !anonKey) return null;
    return { url, anonKey };
  } catch {
    return null;
  }
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
