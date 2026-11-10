-- נאמן v6: עובדים ב"נאמן ספקים". לכל עובד משתמש וסיסמה אישיים. אפשר להריץ שוב בלי נזק.
-- עובד רואה ועורך רק את נתוני "נאמן ספקים" (sup_docs), ולא את הלקוחות והתזכורות של החנות.

create table if not exists public.store_members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  store_id   uuid not null references public.stores(id) on delete cascade,
  username   text not null check (username ~ '^[a-z0-9]{2,20}$'),
  name       text not null check (char_length(name) between 1 and 60),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_id, username)
);
alter table public.store_members enable row level security;
drop policy if exists store_members_owner_read on public.store_members;
create policy store_members_owner_read on public.store_members for select to authenticated using (public.owns_store(store_id));
drop policy if exists store_members_self_read on public.store_members;
create policy store_members_self_read on public.store_members for select to authenticated using (user_id = auth.uid());
-- אין הרשאות כתיבה ישירות: יצירה, שינוי ומחיקה של עובדים רק דרך הפונקציה manage-workers

create or replace function public.can_work_store(sid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.owns_store(sid)
      or exists (select 1 from public.store_members m where m.store_id = sid and m.user_id = auth.uid() and m.active);
$$;

create or replace function public.my_store() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'role', 'worker', 'worker_name', m.name)
       from public.store_members m join public.stores s on s.id = m.store_id
      where m.user_id = auth.uid() and m.active limit 1),
    (select jsonb_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'role', 'owner')
       from public.stores s where s.owner = auth.uid())
  );
$$;
revoke all on function public.my_store() from public, anon;
grant execute on function public.my_store() to authenticated;
revoke all on function public.can_work_store(uuid) from public, anon;
grant execute on function public.can_work_store(uuid) to authenticated;

-- הרשאות ב-sup_docs:
--  בעל החנות: הכול.  עובד: קורא הכול, יכול להוסיף ולעדכן (סריקת חשבוניות מעדכנת גם עלויות של מוצרים),
--  אבל לא יכול למחוק, ולא יכול לשנות את הגדרות החנות (settings/...)
create or replace function public.is_active_worker(sid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.store_members m where m.store_id = sid and m.user_id = auth.uid() and m.active);
$$;
revoke all on function public.is_active_worker(uuid) from public, anon;
grant execute on function public.is_active_worker(uuid) to authenticated;

drop policy if exists sup_docs_owner on public.sup_docs;
drop policy if exists sup_docs_team on public.sup_docs;
drop policy if exists sup_docs_read on public.sup_docs;
drop policy if exists sup_docs_owner_write on public.sup_docs;
drop policy if exists sup_docs_worker_ins on public.sup_docs;
drop policy if exists sup_docs_worker_upd on public.sup_docs;
create policy sup_docs_read on public.sup_docs for select to authenticated using (public.can_work_store(store_id));
create policy sup_docs_owner_write on public.sup_docs for all to authenticated
  using (public.owns_store(store_id)) with check (public.owns_store(store_id));
create policy sup_docs_worker_ins on public.sup_docs for insert to authenticated
  with check (public.is_active_worker(store_id) and deleted = false and path not like 'settings/%');
create policy sup_docs_worker_upd on public.sup_docs for update to authenticated
  using (public.is_active_worker(store_id) and deleted = false and path not like 'settings/%')
  with check (public.is_active_worker(store_id) and deleted = false and path not like 'settings/%');
