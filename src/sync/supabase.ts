/**
 * Capa delgada sobre `@supabase/supabase-js`: crea el cliente y expone las
 * operaciones concretas (escenas en Postgres, bitmaps en Storage, Realtime).
 *
 * Este módulo es el único que importa el SDK de Supabase, así que el
 * empaquetador lo deja en un chunk aparte y `src/sync/index.ts` lo carga con
 * `import()` sólo cuando el usuario configuró un proyecto.
 *
 * El esquema SQL correspondiente está en `supabase/schema.sql` y la guía de
 * configuración en `docs/SYNC.md`.
 */
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { Scene } from '../core/model';

/** Configuración del proyecto Supabase del usuario (se guarda en IndexedDB). */
export interface SyncConfig {
  url: string;
  anonKey: string;
}

/** Fila de la tabla `scenes` tal como la devuelve PostgREST. */
export interface SceneRow {
  id: string;
  user_id: string;
  name: string;
  data: Scene | null;
  updated_at: string;
  deleted: boolean;
}

/** Resumen de una escena remota (sin descargar el JSON completo). */
export interface RemoteSceneMeta {
  id: string;
  name: string;
  updatedAt: number;
  deleted: boolean;
}

export const SCENES_TABLE = 'scenes';
export const BLOBS_BUCKET = 'blobs';

/** Convierte un `timestamptz` de Postgres a milisegundos. */
function toMs(iso: string | null | undefined): number {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Crea el cliente. La sesión se persiste en `localStorage` para que al volver
 * a abrir la PWA en iOS el usuario siga con sesión iniciada.
 */
export function createSupabase(cfg: SyncConfig): SupabaseClient {
  return createClient(cfg.url.replace(/\/+$/, ''), cfg.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: localStorage,
      storageKey: 'moodboard-auth'
    },
    realtime: { params: { eventsPerSecond: 5 } }
  });
}

/** Mensaje legible de cualquier error del SDK. */
export function errorMessage(e: unknown): string {
  if (!e) return '';
  if (typeof e === 'string') return e;
  const o = e as { message?: string; error_description?: string };
  return o.message || o.error_description || String(e);
}

// ---------------------------------------------------------------------------
// escenas

/** Lista los resúmenes de todas las escenas del usuario, incluidas las borradas. */
export async function listRemoteScenes(sb: SupabaseClient): Promise<RemoteSceneMeta[]> {
  const { data, error } = await sb.from(SCENES_TABLE).select('id,name,updated_at,deleted');
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    updatedAt: toMs(r.updated_at as string),
    deleted: Boolean(r.deleted)
  }));
}

/** Descarga una escena completa. Devuelve `null` si no existe. */
export async function fetchRemoteScene(
  sb: SupabaseClient,
  id: string
): Promise<{ scene: Scene | null; updatedAt: number; deleted: boolean } | null> {
  const { data, error } = await sb.from(SCENES_TABLE).select('id,name,data,updated_at,deleted').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as SceneRow;
  const scene = row.data ? ({ ...row.data, id: row.id } as Scene) : null;
  return { scene, updatedAt: toMs(row.updated_at), deleted: Boolean(row.deleted) };
}

/** Sube (inserta o reemplaza) una escena. `updated_at` se toma de la escena. */
export async function pushRemoteScene(sb: SupabaseClient, userId: string, scene: Scene): Promise<void> {
  const { error } = await sb.from(SCENES_TABLE).upsert(
    {
      id: scene.id,
      user_id: userId,
      name: scene.name,
      data: scene,
      updated_at: new Date(scene.updatedAt).toISOString(),
      deleted: false
    },
    { onConflict: 'id' }
  );
  if (error) throw error;
}

/** Borrado lógico: el otro dispositivo lo verá y borrará su copia local. */
export async function softDeleteRemoteScene(sb: SupabaseClient, userId: string, id: string): Promise<void> {
  const { error } = await sb.from(SCENES_TABLE).upsert(
    { id, user_id: userId, name: '', data: null, updated_at: new Date().toISOString(), deleted: true },
    { onConflict: 'id' }
  );
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// bitmaps (Storage)

function blobPath(userId: string, blobId: string): string {
  return `${userId}/${blobId}`;
}

/**
 * Sube un bitmap. Los `blobId` son aleatorios y únicos, así que si el objeto
 * ya existe simplemente ya está sincronizado y el error se ignora.
 */
export async function uploadBlob(sb: SupabaseClient, userId: string, blobId: string, blob: Blob): Promise<void> {
  const { error } = await sb.storage.from(BLOBS_BUCKET).upload(blobPath(userId, blobId), blob, {
    upsert: false,
    contentType: blob.type || 'application/octet-stream',
    cacheControl: '31536000'
  });
  if (!error) return;
  const msg = errorMessage(error).toLowerCase();
  const status = (error as { statusCode?: string | number }).statusCode;
  if (msg.includes('already exists') || msg.includes('duplicate') || String(status) === '409') return;
  throw error;
}

/** Descarga un bitmap del bucket privado. Devuelve `null` si no está. */
export async function downloadBlob(sb: SupabaseClient, userId: string, blobId: string): Promise<Blob | null> {
  const { data, error } = await sb.storage.from(BLOBS_BUCKET).download(blobPath(userId, blobId));
  if (error) {
    const msg = errorMessage(error).toLowerCase();
    if (msg.includes('not found') || msg.includes('does not exist')) return null;
    throw error;
  }
  return data ?? null;
}

// ---------------------------------------------------------------------------
// Realtime

export type SceneChange = { id: string; updatedAt: number; deleted: boolean } | null;

/**
 * Escucha cambios en las escenas del usuario. El payload de Realtime puede
 * venir truncado si la fila es grande, así que sólo se leen `id`,
 * `updated_at` y `deleted`; el JSON se vuelve a pedir por REST.
 *
 * `onChange(null)` significa "llegó un cambio pero no sé de cuál escena":
 * el llamador debe hacer una sincronización completa.
 */
export function subscribeScenes(
  sb: SupabaseClient,
  userId: string,
  onChange: (change: SceneChange) => void,
  onStatus?: (status: string) => void
): RealtimeChannel {
  const channel = sb
    .channel(`scenes-${userId}`)
    .on(
      // los tipos de `postgres_changes` del SDK no aceptan un filtro dinámico
      'postgres_changes' as never,
      { event: '*', schema: 'public', table: SCENES_TABLE, filter: `user_id=eq.${userId}` },
      (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
        try {
          const row = (payload.new ?? payload.old ?? {}) as Record<string, unknown>;
          const id = typeof row.id === 'string' ? row.id : null;
          if (!id) {
            onChange(null);
            return;
          }
          onChange({
            id,
            updatedAt: toMs(row.updated_at as string),
            deleted: Boolean(row.deleted)
          });
        } catch {
          /* nunca lanzar desde un callback de Realtime */
        }
      }
    )
    .subscribe((status: string) => {
      try {
        onStatus?.(status);
      } catch {
        /* ignorar */
      }
    });
  return channel;
}
