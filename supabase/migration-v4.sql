-- נאמן v4: קבלת סחורה (צילום תעודת משלוח, רשימה לסימון, הודעה לספק). אפשר להריץ שוב בלי נזק.

create table if not exists public.suppliers (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 80),
  phone      text,
  hp         text,                                  -- company number printed on its documents (ח.פ. / ע.מ.)
  template   jsonb not null default '{}'::jsonb,     -- how this supplier's documents are read: learned, no AI needed
  created_at timestamptz not null default now(),
  unique (store_id, name)
);
alter table public.suppliers add column if not exists hp text;
alter table public.suppliers add column if not exists template jsonb not null default '{}'::jsonb;

create table if not exists public.receipts (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id) on delete cascade,
  supplier_id   uuid references public.suppliers(id) on delete set null,
  supplier_name text,
  doc_no        text,
  doc_date      date,
  source        text not null default 'ocr' check (source in ('ocr','ai','photo','pdf','excel','manual')),
  status        text not null default 'draft' check (status in ('draft','open','done')),   -- draft = list still being checked
  note          text,
  created_at    timestamptz not null default now(),
  closed_at     timestamptz
);
create index if not exists receipts_store on public.receipts(store_id, created_at desc);
alter table public.receipts drop constraint if exists receipts_source_check;
alter table public.receipts add constraint receipts_source_check check (source in ('ocr','ai','photo','pdf','excel','manual'));
alter table public.receipts drop constraint if exists receipts_status_check;
alter table public.receipts add constraint receipts_status_check check (status in ('draft','open','done'));
alter table public.receipts alter column status set default 'draft';
alter table public.receipts alter column source set default 'ocr';
alter table public.receipts add column if not exists read_info jsonb;   -- how the document was read (free OCR / AI), totals check, learned layout

create table if not exists public.receipt_items (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores(id) on delete cascade,
  receipt_id   uuid not null references public.receipts(id) on delete cascade,
  pos          int not null default 0,
  name         text not null check (char_length(name) between 1 and 200),
  code         text,                                   -- barcode / catalog number printed on the document
  qty_ordered  numeric not null default 0 check (qty_ordered >= 0),
  qty_received numeric not null default 0 check (qty_received >= 0),
  qty_damaged  numeric not null default 0 check (qty_damaged >= 0),
  unit_price   numeric,
  product_id   uuid references public.products(id) on delete set null,
  extra        boolean not null default false           -- arrived but was not on the document
);
create index if not exists receipt_items_receipt on public.receipt_items(receipt_id, pos);

-- "the supplier calls it X, we call it Y": learned once, used on every next document from that supplier
create table if not exists public.supplier_aliases (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  alias       text not null,
  product_id  uuid not null references public.products(id) on delete cascade,
  unique (supplier_id, alias)
);

-- how many documents the AI read per store per day (a cap, so a mistake can't run up a bill)
create table if not exists public.ai_usage (
  store_id uuid not null references public.stores(id) on delete cascade,
  day      date not null,
  pages    int not null default 0,
  primary key (store_id, day)
);

-- every child row must point at rows of the same store
create or replace function public.check_receiving_store() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- (nested ifs on purpose: plpgsql would read new.<column> even on a table that doesn't have it)
  if tg_table_name = 'receipts' then
    if new.supplier_id is not null then
      if not exists (select 1 from public.suppliers s where s.id = new.supplier_id and s.store_id = new.store_id) then
        raise exception 'supplier does not belong to this store'; end if;
    end if;
  end if;
  if tg_table_name = 'receipt_items' then
    if not exists (select 1 from public.receipts r where r.id = new.receipt_id and r.store_id = new.store_id) then
      raise exception 'receipt does not belong to this store'; end if;
  end if;
  if tg_table_name = 'supplier_aliases' then
    if not exists (select 1 from public.suppliers s where s.id = new.supplier_id and s.store_id = new.store_id) then
      raise exception 'supplier does not belong to this store'; end if;
  end if;
  if tg_table_name in ('receipt_items','supplier_aliases') then
    if new.product_id is not null then
      if not exists (select 1 from public.products p where p.id = new.product_id and p.store_id = new.store_id) then
        raise exception 'product does not belong to this store'; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists same_store on public.receipts;
create trigger same_store before insert or update on public.receipts for each row execute function public.check_receiving_store();
drop trigger if exists same_store on public.receipt_items;
create trigger same_store before insert or update on public.receipt_items for each row execute function public.check_receiving_store();
drop trigger if exists same_store on public.supplier_aliases;
create trigger same_store before insert or update on public.supplier_aliases for each row execute function public.check_receiving_store();

alter table public.suppliers        enable row level security;
alter table public.receipts         enable row level security;
alter table public.receipt_items    enable row level security;
alter table public.supplier_aliases enable row level security;
alter table public.ai_usage         enable row level security;
drop policy if exists suppliers_owner on public.suppliers;
create policy suppliers_owner on public.suppliers for all to authenticated using (public.owns_store(store_id)) with check (public.owns_store(store_id));
-- a receipt can be deleted only while nothing in it was ticked (a failed upload); after that it stays
drop policy if exists receipts_owner on public.receipts;
drop policy if exists receipts_rw on public.receipts;
drop policy if exists receipts_del on public.receipts;
create policy receipts_rw on public.receipts for select to authenticated using (public.owns_store(store_id));
drop policy if exists receipts_ins on public.receipts;
create policy receipts_ins on public.receipts for insert to authenticated with check (public.owns_store(store_id));
drop policy if exists receipts_upd on public.receipts;
create policy receipts_upd on public.receipts for update to authenticated using (public.owns_store(store_id)) with check (public.owns_store(store_id));
create policy receipts_del on public.receipts for delete to authenticated using (public.owns_store(store_id) and status in ('draft','open')
  and not exists (select 1 from public.receipt_items i where i.receipt_id = receipts.id and i.qty_received > 0));
-- lines that came from the delivery note can't be deleted (no delete policy = no delete); only ticked
drop policy if exists receipt_items_owner on public.receipt_items;
drop policy if exists receipt_items_read on public.receipt_items;
drop policy if exists receipt_items_add on public.receipt_items;
drop policy if exists receipt_items_tick on public.receipt_items;
create policy receipt_items_read on public.receipt_items for select to authenticated using (public.owns_store(store_id));
create policy receipt_items_add  on public.receipt_items for insert to authenticated with check (public.owns_store(store_id));
create policy receipt_items_tick on public.receipt_items for update to authenticated using (public.owns_store(store_id)) with check (public.owns_store(store_id));
-- while the list is still a draft (just read, being checked against the paper) a wrong line can be removed
drop policy if exists receipt_items_draft_del on public.receipt_items;
create policy receipt_items_draft_del on public.receipt_items for delete to authenticated using (public.owns_store(store_id)
  and exists (select 1 from public.receipts r where r.id = receipt_items.receipt_id and r.status = 'draft'));
-- and what the document says (product name, code, quantity ordered) can't be changed afterwards; the price can (suppliers change prices)
create or replace function public.lock_receipt_line() returns trigger
language plpgsql set search_path = public as $$
begin
  if exists (select 1 from public.receipts r where r.id = old.receipt_id and r.status = 'draft') then return new; end if;
  if not old.extra and (new.name is distinct from old.name or new.code is distinct from old.code
      or new.qty_ordered is distinct from old.qty_ordered
      or new.receipt_id is distinct from old.receipt_id or new.store_id is distinct from old.store_id) then
    raise exception 'a line from the delivery note can not be changed, only ticked';
  end if;
  return new;
end $$;
drop trigger if exists lock_line on public.receipt_items;
create trigger lock_line before update on public.receipt_items for each row execute function public.lock_receipt_line();
drop policy if exists supplier_aliases_owner on public.supplier_aliases;
create policy supplier_aliases_owner on public.supplier_aliases for all to authenticated using (public.owns_store(store_id)) with check (public.owns_store(store_id));
-- a store can see its own usage, only the server (service role) writes it
drop policy if exists ai_usage_read on public.ai_usage;
create policy ai_usage_read on public.ai_usage for select to authenticated using (public.owns_store(store_id));
