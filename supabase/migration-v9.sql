-- נאמן v9: נאמן תזכורות - מנוי, עובדים, וואטסאפ API לכל חנות ויומן שליחות. אפשר להריץ שוב בלי נזק.

-- 1. מנוי והגדרות שליחה בטבלת החנויות (plan קיים: trial / active / paused)
alter table public.stores add column if not exists sub_renews date;
alter table public.stores add column if not exists wa_mode text not null default 'off';
alter table public.stores add column if not exists wa_connected boolean not null default false;
alter table public.stores add column if not exists wa_test_phone text;
alter table public.stores drop constraint if exists stores_wa_mode_chk;
alter table public.stores add constraint stores_wa_mode_chk check (wa_mode in ('off','dry','test','live'));
alter table public.stores drop constraint if exists stores_wa_test_phone_chk;
alter table public.stores add constraint stores_wa_test_phone_chk check (wa_test_phone is null or wa_test_phone ~ '^05[0-9]{8}$');

-- בעל החנות לא משנה לבד מנוי, חידוש וסטטוס חיבור. רק אתה (מסך הניהול / SQL) והפונקציות בשרת
create or replace function public.guard_store() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(auth.role(), '') = 'authenticated' then
    if tg_op = 'INSERT' then
      new.plan := 'trial'; new.owner := auth.uid(); new.sub_renews := null; new.wa_connected := false; new.wa_mode := 'off';
    elsif new.plan is distinct from old.plan or new.owner is distinct from old.owner
       or new.sub_renews is distinct from old.sub_renews or new.wa_connected is distinct from old.wa_connected then
      raise exception 'not allowed';
    end if;
  end if;
  return new;
end $$;

-- 2. פרטי ה-API של וואטסאפ: טבלה שאף משתמש לא יכול לקרוא. רק פונקציות השרת
create table if not exists public.store_wa_secrets (
  store_id        uuid primary key references public.stores(id) on delete cascade,
  phone_number_id text not null,
  access_token    text not null,
  template_name   text not null,
  template_lang   text not null default 'he',
  updated_at      timestamptz not null default now()
);
alter table public.store_wa_secrets enable row level security;
revoke all on public.store_wa_secrets from anon, authenticated;

-- 3. יומן שליחות
create table if not exists public.wa_log (
  id          bigint generated always as identity primary key,
  store_id    uuid not null references public.stores(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  name        text,
  phone       text,
  status      text not null check (status in ('dry','test','sent','failed','skipped')),
  detail      text,
  wa_id       text,
  by_user     uuid,
  at          timestamptz not null default now()
);
create index if not exists wa_log_store_at on public.wa_log(store_id, at desc);
alter table public.wa_log enable row level security;
revoke all on public.wa_log from anon, authenticated;
grant select on public.wa_log to authenticated;

-- 4. עובדים: הרשאה נפרדת לתזכורות (ברירת מחדל: אין). עובד של "נאמן ספקים" לא רואה לקוחות
alter table public.store_members add column if not exists can_reminders boolean not null default false;
create or replace function public.is_reminder_worker(sid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.store_members m where m.store_id = sid and m.user_id = auth.uid() and m.active and m.can_reminders);
$$;
revoke all on function public.is_reminder_worker(uuid) from public, anon;
grant execute on function public.is_reminder_worker(uuid) to authenticated;
create or replace function public.can_see_reminders(sid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.owns_store(sid) or public.is_reminder_worker(sid);
$$;
revoke all on function public.can_see_reminders(uuid) from public, anon;
grant execute on function public.can_see_reminders(uuid) to authenticated;

drop policy if exists wa_log_read on public.wa_log;
create policy wa_log_read on public.wa_log for select to authenticated using (public.can_see_reminders(store_id));

-- החנות עצמה: עובד תזכורות קורא (בלי לכתוב)
drop policy if exists stores_reminder_worker_read on public.stores;
create policy stores_reminder_worker_read on public.stores for select to authenticated using (public.is_reminder_worker(id));

-- קריאה לעובד בטבלאות התזכורות; כתיבה מוגבלת: להוסיף ולעדכן לקוחות, לרשום מכירות ותזכורות. בלי מחיקה, בלי שינוי מוצרים וכללים
do $$
declare t text;
begin
  foreach t in array array['products','customers','purchases','reminders','rules','customer_rules','events'] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', t||'_rw_read', t);
      execute format('create policy %I on public.%I for select to authenticated using (public.is_reminder_worker(store_id))', t||'_rw_read', t);
    end if;
  end loop;
  foreach t in array array['customers','customer_rules'] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', t||'_rw_ins', t);
      execute format('create policy %I on public.%I for insert to authenticated with check (public.is_reminder_worker(store_id))', t||'_rw_ins', t);
      execute format('drop policy if exists %I on public.%I', t||'_rw_upd', t);
      execute format('create policy %I on public.%I for update to authenticated using (public.is_reminder_worker(store_id)) with check (public.is_reminder_worker(store_id))', t||'_rw_upd', t);
    end if;
  end loop;
  foreach t in array array['purchases','reminders'] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', t||'_rw_ins', t);
      execute format('create policy %I on public.%I for insert to authenticated with check (public.is_reminder_worker(store_id))', t||'_rw_ins', t);
    end if;
  end loop;
end $$;

-- my_store: מחזיר גם אם העובד רשאי לתזכורות
create or replace function public.my_store() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'role', 'worker', 'worker_name', m.name, 'can_reminders', m.can_reminders)
       from public.store_members m join public.stores s on s.id = m.store_id
      where m.user_id = auth.uid() and m.active limit 1),
    (select jsonb_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'role', 'owner', 'can_reminders', true)
       from public.stores s where s.owner = auth.uid())
  );
$$;
