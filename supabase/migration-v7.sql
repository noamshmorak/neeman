-- נאמן v7: הגנות מפני מחיקה. אפשר להריץ שוב בלי נזק.
-- 1. מחיקת משתמש או חנות לא מוחקת נתונים: הפעולה נחסמת (RESTRICT) במקום למחוק הכול בשרשרת.
do $$ declare r record; begin
  for r in
    select c.conrelid::regclass as tbl, c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.contype = 'f' and c.confdeltype = 'c' and c.connamespace = 'public'::regnamespace
      and (c.confrelid = 'public.stores'::regclass
           or (c.confrelid = 'auth.users'::regclass and c.conrelid <> 'public.store_members'::regclass))
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I %s', r.tbl, r.conname, replace(r.def, 'ON DELETE CASCADE', 'ON DELETE RESTRICT'));
  end loop;
end $$;

-- 2. חסימת מחיקה פיזית של חנויות ושל מסמכי נאמן ספקים. האפליקציה רק מסמנת deleted. עקיפה מכוונת רק עם set local app.allow_delete = 'on'
create or replace function public.block_hard_delete() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('app.allow_delete', true), '') = 'on' then return old; end if;
  raise exception 'מחיקה לצמיתות חסומה (%). סמן deleted במקום למחוק', tg_table_name using errcode = '42501';
end $$;
drop trigger if exists no_hard_delete on public.sup_docs;
create trigger no_hard_delete before delete on public.sup_docs for each row execute function public.block_hard_delete();
drop trigger if exists no_hard_delete on public.stores;
create trigger no_hard_delete before delete on public.stores for each row execute function public.block_hard_delete();
drop trigger if exists no_truncate on public.sup_docs;
create trigger no_truncate before truncate on public.sup_docs for each statement execute function public.block_hard_delete();
revoke delete, truncate on public.sup_docs from anon, authenticated;

-- 3. היסטוריית גרסאות: כל שינוי שומר את הגרסה הקודמת של המסמך (90 יום), אפשר לשחזר
create table if not exists public.sup_docs_history (
  id        bigint generated always as identity primary key,
  store_id  uuid not null references public.stores(id) on delete restrict,
  path      text not null,
  data      jsonb,
  ts        bigint,
  deleted   boolean,
  saved_at  timestamptz not null default now()
);
create index if not exists sup_docs_history_doc on public.sup_docs_history (store_id, path, saved_at desc);
alter table public.sup_docs_history enable row level security;
drop policy if exists sup_docs_history_owner on public.sup_docs_history;
create policy sup_docs_history_owner on public.sup_docs_history for select to authenticated using (public.owns_store(store_id));
revoke insert, update, delete, truncate on public.sup_docs_history from anon, authenticated;
create or replace function public.sup_docs_keep() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.data is distinct from new.data or old.deleted is distinct from new.deleted then
    insert into public.sup_docs_history(store_id, path, data, ts, deleted) values (old.store_id, old.path, old.data, old.ts, old.deleted);
    delete from public.sup_docs_history where store_id = old.store_id and path = old.path and saved_at < now() - interval '90 days';
  end if;
  return new;
end $$;
drop trigger if exists sup_docs_keep on public.sup_docs;
create trigger sup_docs_keep after update on public.sup_docs for each row execute function public.sup_docs_keep();
