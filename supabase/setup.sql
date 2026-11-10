-- RECORDING In Progress photo gallery: database + storage setup
-- Paste all of this into Supabase -> SQL Editor -> New query, then click Run.

-- ---------------------------------------------------------------- tables
create table if not exists public.photos (
  id          uuid primary key default gen_random_uuid(),
  path        text not null unique check (path ~ '^[0-9a-f-]{36}\.(webp|jpg)$'),
  author      text not null default 'Anonymous' check (char_length(author) between 1 and 40),
  caption     text not null default '' check (char_length(caption) <= 200),
  tags        text[] not null default '{}' check (cardinality(tags) <= 8),
  width       int check (width between 1 and 4096),
  height      int check (height between 1 and 4096),
  status      text not null default 'pending' check (status in ('pending', 'approved')),
  created_at  timestamptz not null default now()
);
create index if not exists photos_status_created on public.photos (status, created_at desc);
alter table public.photos enable row level security;

-- Moderators (filled in by hand, see the bottom of this file). No policies: only the database itself reads it.
create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade
);
alter table public.admins enable row level security;

-- ---------------------------------------------------------------- helpers
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Flood guard: at most 300 photos waiting for review, and 40 uploads per 10 minutes overall.
create or replace function public.uploads_open() returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from public.photos where status = 'pending') < 300
     and (select count(*) from public.photos where created_at > now() - interval '10 minutes') < 40;
$$;

-- ---------------------------------------------------------------- photo rows
-- Visitors may only fill in these columns; status and created_at always take their defaults.
revoke insert, update on public.photos from anon, authenticated;
grant insert (path, author, caption, tags, width, height) on public.photos to anon, authenticated;
grant update (status, caption, tags) on public.photos to authenticated;

drop policy if exists "submit photo" on public.photos;
create policy "submit photo" on public.photos for insert to anon, authenticated
  with check (status = 'pending' and public.uploads_open());

drop policy if exists "see approved" on public.photos;
create policy "see approved" on public.photos for select to anon, authenticated
  using (status = 'approved' or public.is_admin());

drop policy if exists "admin update" on public.photos;
create policy "admin update" on public.photos for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin delete" on public.photos;
create policy "admin delete" on public.photos for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------- storage
-- Private bucket: a file can only be viewed once its photo is approved (or by a moderator).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 3145728, array['image/webp', 'image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = 3145728, allowed_mime_types = array['image/webp', 'image/jpeg'];

drop policy if exists "gallery upload" on storage.objects;
create policy "gallery upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'photos'
              and name ~ '^[0-9a-f-]{36}\.(webp|jpg)$'
              and public.uploads_open());

drop policy if exists "gallery read" on storage.objects;
create policy "gallery read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'photos'
         and (public.is_admin()
              or exists (select 1 from public.photos p where p.path = objects.name and p.status = 'approved')));

drop policy if exists "gallery admin delete" on storage.objects;
create policy "gallery admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_admin());

-- ---------------------------------------------------------------- make yourself a moderator
-- 1. Authentication -> Users -> Add user -> Create new user (your email + a password, tick Auto Confirm).
-- 2. Run this line on its own, with your email:
--    insert into public.admins (user_id) select id from auth.users where email = 'YOUR EMAIL HERE';
-- 3. Authentication -> Sign In / Providers: turn OFF "Allow new users to sign up".
