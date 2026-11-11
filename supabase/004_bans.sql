-- RECORDING In Progress gallery, update 4: uploader tags and bans.
-- Paste all of this into Supabase -> SQL Editor -> New query, then click Run. Safe to run more than once.
--
-- Each upload is tagged with a scrambled (salted hash) version of the uploader's IP address. Real IPs are never
-- stored: the tag is enough to see that several uploads came from one person, and to ban them.

-- ---------------------------------------------------------------- the secret salt for the IP hash
-- No policies: only the database itself can read it.
create table if not exists public.app_secrets (k text primary key, v text not null);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;
insert into public.app_secrets (k, v)
values ('ip_salt', encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text || random()::text, 'UTF8')), 'hex'))
on conflict (k) do nothing;

-- ---------------------------------------------------------------- who is asking
-- The caller's IP as Supabase's gateway saw it. cf-connecting-ip is set by Cloudflare in front of Supabase and
-- overwrites anything the visitor sends, so it can't be faked; the others are fallbacks.
create or replace function public.client_ip() returns text
language sql stable as $$
  select nullif(trim(coalesce(h ->> 'cf-connecting-ip', h ->> 'x-real-ip', '')), '')
  from (select coalesce(current_setting('request.headers', true), '{}')::json as h) as t;
$$;

-- The caller's uploader tag: first 16 hex characters of sha256(salt + IP). Null if the IP is unknown.
create or replace function public.uploader_id() returns text
language sql stable security definer set search_path = public as $$
  select case when i.ip is null then null
              else left(encode(sha256(convert_to(s.v || i.ip, 'UTF8')), 'hex'), 16) end
  from (select public.client_ip() as ip) as i
  cross join (select v from public.app_secrets where k = 'ip_salt') as s;
$$;

-- ---------------------------------------------------------------- photos remember their uploader
alter table public.photos add column if not exists uploader text;
create index if not exists photos_uploader on public.photos (uploader);

create or replace function public.stamp_uploader() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.uploader := public.uploader_id();
  return new;
end $$;

drop trigger if exists photos_stamp_uploader on public.photos;
create trigger photos_stamp_uploader before insert on public.photos
  for each row execute function public.stamp_uploader();

-- Visitors can't read the tag (only moderators see it). The site never selects this column.
revoke select on public.photos from anon;
grant select (id, path, author, caption, tags, width, height, status, created_at, like_count, approved_at, pinned_at)
  on public.photos to anon;

-- ---------------------------------------------------------------- bans
create table if not exists public.bans (
  uploader   text primary key,
  note       text not null default '' check (char_length(note) <= 200),
  banned_at  timestamptz not null default now()
);
alter table public.bans enable row level security;
revoke all on public.bans from anon, authenticated;
grant select, insert, delete on public.bans to authenticated;

drop policy if exists "admin bans" on public.bans;
create policy "admin bans" on public.bans for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.is_banned() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.bans where uploader = public.uploader_id());
$$;

-- Banned uploaders can't upload (file or entry) or like.
create or replace function public.uploads_open() returns boolean
language sql stable security definer set search_path = public as $$
  select not public.is_banned()
     and (select count(*) from public.photos where status = 'pending') < 300
     and (select count(*) from public.photos where created_at > now() - interval '10 minutes') < 40;
$$;

create or replace function public.likes_open() returns boolean
language sql stable security definer set search_path = public as $$
  select not public.is_banned()
     and (select count(*) from public.likes where created_at > now() - interval '10 minutes') < 1000;
$$;

-- ---------------------------------------------------------------- moderator helper
-- How many photos each of these uploaders has sent in total, and whether they're banned.
create or replace function public.uploader_stats(tags text[])
returns table (uploader text, uploads bigint, banned boolean)
language sql stable security definer set search_path = public as $$
  select t.u, (select count(*) from public.photos p where p.uploader = t.u),
         exists (select 1 from public.bans b where b.uploader = t.u)
  from unnest(tags) as t(u)
  where public.is_admin();
$$;
revoke execute on function public.uploader_stats(text[]) from anon;
