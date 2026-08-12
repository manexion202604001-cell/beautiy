-- Phase 1-B/1-D: カルテ・会計スキーマ
-- 会計は確定後 UPDATE 禁止（打消し伝票方式）。カルテ写真は非公開バケット + 署名付きURL。

-- ---------------------------------------------------------------
-- カルテ
-- ---------------------------------------------------------------
create table kartes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  customer_id uuid not null references customers(id),
  staff_id uuid not null references staff(id),
  visit_date date not null,
  menu_names text[] not null default '{}',
  duration_min int not null default 0,
  amount int not null default 0, -- 円（整数）
  recipe jsonb not null default '[]', -- [{brand, product, ratio, minutes}]
  recipe_note text not null default '',
  memo text not null default '',
  created_at timestamptz not null default now()
);

create index kartes_customer_idx on kartes (customer_id, visit_date desc);

create table karte_photos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  karte_id uuid not null references kartes(id) on delete cascade,
  storage_path text not null, -- 非公開バケット。配信は署名付きURL（1時間）のみ
  kind text not null default 'after', -- before | after
  created_at timestamptz not null default now(),
  constraint max_photos_per_karte check (true) -- 上限20枚はアプリ層 + トリガーで担保
);

create or replace function check_karte_photo_limit() returns trigger
language plpgsql as $$
begin
  if (select count(*) from karte_photos where karte_id = new.karte_id) >= 20 then
    raise exception 'karte photo limit (20) exceeded';
  end if;
  return new;
end $$;

create trigger karte_photo_limit before insert on karte_photos
  for each row execute function check_karte_photo_limit();

create table karte_memos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  customer_id uuid not null references customers(id),
  staff_id uuid not null references staff(id),
  body text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 会計（確定後不変・打消し伝票方式）
-- ---------------------------------------------------------------
create type payment_status as enum ('draft', 'fixed', 'voided');

create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  customer_id uuid references customers(id),
  customer_name text not null default '',
  items jsonb not null default '[]',   -- [{name, kind, price, quantity, staff_id, nominated}]
  tenders jsonb not null default '[]', -- [{kind, label, amount}]
  status payment_status not null default 'draft',
  fixed_at timestamptz,
  reversal_of uuid references payments(id),
  created_at timestamptz not null default now()
);

-- 確定済み伝票の改変禁止（status: fixed→voided の遷移のみ許可）
create or replace function forbid_fixed_payment_update() returns trigger
language plpgsql as $$
begin
  if old.status = 'fixed' then
    if new.status = 'voided'
       and new.items = old.items
       and new.tenders = old.tenders
       and new.fixed_at = old.fixed_at then
      return new; -- 打消し処理による取消マークのみ許可
    end if;
    raise exception 'fixed payments are immutable; use reversal slips';
  end if;
  return new;
end $$;

create trigger payments_immutable before update on payments
  for each row execute function forbid_fixed_payment_update();

create table cashier_closings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  closing_date date not null,
  theoretical_cash int not null,
  counted_cash int not null,
  closed_by uuid not null references staff(id),
  closed_at timestamptz not null default now(),
  unique (salon_id, closing_date)
);

-- ---------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------
alter table kartes enable row level security;
alter table karte_photos enable row level security;
alter table karte_memos enable row level security;
alter table payments enable row level security;
alter table cashier_closings enable row level security;

-- カルテは顧客の所有権に追従（個人所有顧客のカルテは所有者とオーナー/店長のみ）
create policy kartes_access on kartes
  for all using (
    tenant_id = current_tenant_id()
    and exists (
      select 1 from customers c
      where c.id = kartes.customer_id
        and (
          c.owner_type = 'salon'
          or c.owner_staff_id = (current_staff()).id
          or (current_staff()).role in ('owner', 'manager')
        )
    )
  );

create policy karte_photos_access on karte_photos
  for all using (tenant_id = current_tenant_id());

create policy karte_memos_access on karte_memos
  for all using (tenant_id = current_tenant_id());

create policy payments_access on payments
  for all using (tenant_id = current_tenant_id());

-- レジ締めの作成はオーナー / 店長のみ
create policy closings_select on cashier_closings
  for select using (tenant_id = current_tenant_id());

create policy closings_insert on cashier_closings
  for insert with check (
    tenant_id = current_tenant_id()
    and (current_staff()).role in ('owner', 'manager')
  );
