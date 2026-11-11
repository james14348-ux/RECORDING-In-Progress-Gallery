-- RECORDING In Progress gallery, update 2: likes and sorting.
-- Paste all of this into Supabase -> SQL Editor -> New query, then click Run. Safe to run more than once.

-- ---------------------------------------------------------------- photo columns
alter table public.photos add column if not exists like_count int not null default 0;
alter table public.photos add column if not exists approved_at timestamptz;
update public.photos set approved_at = created_at where status = 'approved' and approved_at is null;

create index if not exists photos_approved_new on public.photos (status, approved_at desc);
create index if not exists photos_approved_liked on public.photos (status, like_count desc, approved_at desc);

-- "Newest" means newest in the gallery, so stamp the moment a photo is approved.
create or replace function public.stamp_approved() returns trigger
language plpgsql as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    new.approved_at := now();
  elsif new.status <> 'approved' then
    new.approved_at := null;
  end if;
  return new;
end $$;

drop trigger if exists photos_stamp_approved on public.photos;
create trigger photos_stamp_approved before update of status on public.photos
  for each row execute function public.stamp_approved();

-- ---------------------------------------------------------------- likes
-- Each browser gets a random id (sent as the x-voter header). One like per photo per browser.
create table if not exists public.likes (
  photo_id   uuid not null references public.photos (id) on delete cascade,
  voter      uuid not null,
  created_at timestamptz not null default now(),
  primary key (photo_id, voter)
);
create index if not exists likes_recent on public.likes (created_at);
alter table public.likes enable row level security;

-- The id this request says it is (null if missing or malformed).
create or replace function public.voter_id() returns uuid
language sql stable as $$
  select case when h ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then h::uuid end
  from (select lower(coalesce(current_setting('request.headers', true)::json ->> 'x-voter', ''))) as t(h);
$$;

-- Flood guard: at most 1000 likes per 10 minutes across the whole gallery.
create or replace function public.likes_open() returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from public.likes where created_at > now() - interval '10 minutes') < 1000;
$$;

-- Keep photos.like_count in step with the likes table.
create or replace function public.count_likes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.photos set like_count = like_count + 1 where id = new.photo_id;
    return new;
  else
    update public.photos set like_count = greatest(like_count - 1, 0) where id = old.photo_id;
    return old;
  end if;
end $$;

drop trigger if exists likes_count on public.likes;
create trigger likes_count after insert or delete on public.likes
  for each row execute function public.count_likes();

revoke all on public.likes from anon, authenticated;
grant select, delete on public.likes to anon, authenticated;
grant insert (photo_id, voter) on public.likes to anon, authenticated;

-- A browser only ever sees and removes its own likes, so voter ids are never exposed.
drop policy if exists "own likes" on public.likes;
create policy "own likes" on public.likes for select to anon, authenticated
  using (voter = public.voter_id());

drop policy if exists "like approved photo" on public.likes;
create policy "like approved photo" on public.likes for insert to anon, authenticated
  with check (voter = public.voter_id()
              and exists (select 1 from public.photos p where p.id = photo_id and p.status = 'approved')
              and public.likes_open());

drop policy if exists "unlike" on public.likes;
create policy "unlike" on public.likes for delete to anon, authenticated
  using (voter = public.voter_id());
