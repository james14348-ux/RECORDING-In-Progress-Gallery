-- RECORDING In Progress gallery, update 3: pinned photos.
-- Paste all of this into Supabase -> SQL Editor -> New query, then click Run. Safe to run more than once.

-- A pinned photo sits at the top of "All" and of every tag it has. Newest pin first.
alter table public.photos add column if not exists pinned_at timestamptz;
create index if not exists photos_pinned on public.photos (status, pinned_at desc nulls last);

-- Only moderators can pin (the "admin update" policy already limits updates to them).
grant update (pinned_at) on public.photos to authenticated;

-- Hiding a photo again also unpins it.
create or replace function public.stamp_approved() returns trigger
language plpgsql as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    new.approved_at := now();
  elsif new.status <> 'approved' then
    new.approved_at := null;
    new.pinned_at := null;
  end if;
  return new;
end $$;
