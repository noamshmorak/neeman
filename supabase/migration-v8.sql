-- נאמן v8: מסך ניהול לבעל המערכת. אפשר להריץ שוב בלי נזק.
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
create table if not exists public.admin_log (
  id bigint generated always as identity primary key,
  admin_id uuid not null,
  action text not null,
  target text,
  at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
alter table public.admin_log enable row level security;
revoke all on public.platform_admins, public.admin_log from anon, authenticated;
-- הוספת מנהל (מריצים ידנית פעם אחת):
-- insert into public.platform_admins(user_id) select id from auth.users where email = 'noamshmorak@gmail.com' on conflict do nothing;
