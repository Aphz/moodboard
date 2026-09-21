-- ---------------------------------------------------------------------------
-- Moodboard · esquema de sincronización para Supabase
--
-- Pega este archivo completo en el SQL Editor de tu proyecto y ejecútalo.
-- Es idempotente: puedes volver a ejecutarlo sin romper nada.
--
-- Guía paso a paso: docs/SYNC.md
-- ---------------------------------------------------------------------------

-- 1. Tabla de escenas -------------------------------------------------------
create table if not exists public.scenes (
  id         text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null default '',
  data       jsonb,
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);

create index if not exists scenes_user_id_idx on public.scenes (user_id);
create index if not exists scenes_updated_at_idx on public.scenes (user_id, updated_at desc);

-- 2. RLS: cada usuario sólo ve y escribe sus propias escenas ----------------
alter table public.scenes enable row level security;

drop policy if exists "scenes_select_own" on public.scenes;
create policy "scenes_select_own" on public.scenes
  for select using (auth.uid() = user_id);

drop policy if exists "scenes_insert_own" on public.scenes;
create policy "scenes_insert_own" on public.scenes
  for insert with check (auth.uid() = user_id);

drop policy if exists "scenes_update_own" on public.scenes;
create policy "scenes_update_own" on public.scenes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "scenes_delete_own" on public.scenes;
create policy "scenes_delete_own" on public.scenes
  for delete using (auth.uid() = user_id);

-- 3. Realtime: avisar de los cambios al otro dispositivo --------------------
-- El filtro `user_id=eq.<uid>` que usa la app necesita REPLICA IDENTITY FULL.
alter table public.scenes replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.scenes;
exception
  when duplicate_object then null;  -- ya estaba publicada
  when undefined_object then null;  -- la publicación no existe en este proyecto
end $$;

-- 4. Storage: bucket privado para los bitmaps -------------------------------
-- Cada imagen se guarda en `blobs/<user_id>/<blobId>`.
insert into storage.buckets (id, name, public)
values ('blobs', 'blobs', false)
on conflict (id) do nothing;

-- Políticas: el usuario sólo entra a su propia carpeta (primer segmento de la
-- ruta = su uid). `storage.foldername(name)` devuelve el arreglo de carpetas.
drop policy if exists "blobs_select_own" on storage.objects;
create policy "blobs_select_own" on storage.objects
  for select using (
    bucket_id = 'blobs' and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "blobs_insert_own" on storage.objects;
create policy "blobs_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'blobs' and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "blobs_update_own" on storage.objects;
create policy "blobs_update_own" on storage.objects
  for update using (
    bucket_id = 'blobs' and auth.uid()::text = (storage.foldername(name))[1]
  ) with check (
    bucket_id = 'blobs' and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "blobs_delete_own" on storage.objects;
create policy "blobs_delete_own" on storage.objects
  for delete using (
    bucket_id = 'blobs' and auth.uid()::text = (storage.foldername(name))[1]
  );
