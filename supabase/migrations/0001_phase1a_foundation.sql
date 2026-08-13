-- Phase 1-A: 基盤スキーマ
-- テナント分離 / カルテ所有権 / ロール別アクセス / 監査ログ / 予約排他制御
-- CLAUDE.md ルール: 全テーブル RLS 有効・tenant_id 強制・EXCLUDE USING gist

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- テナント / 店舗
-- ---------------------------------------------------------------
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'standard',
  created_at timestamptz not null default now()
);

create table salons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  open_time time not null default '10:00',
  close_time time not null default '20:00',
  closed_weekdays smallint[] not null default '{}',
  invoice_number text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- スタッフ（auth.users と 1:1）
-- ---------------------------------------------------------------
create type staff_role as enum ('owner', 'manager', 'stylist', 'assistant', 'freelance');

create table staff (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  auth_user_id uuid unique references auth.users(id),
  name text not null,
  name_kana text not null default '',
  role staff_role not null default 'stylist',
  color text not null default '#C8A96A',
  accept_start time,
  accept_end time,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 顧客（所有権モデル: salon | staff）
-- ---------------------------------------------------------------
create type owner_type as enum ('salon', 'staff');

create table customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  owner_type owner_type not null default 'salon',
  owner_staff_id uuid references staff(id),
  name text not null,
  name_kana text not null default '',
  phone text,
  email text,
  birthday date,
  gender text,
  line_user_id text,
  address text,
  occupation text,
  channel text,
  tags text[] not null default '{}',
  warnings text[] not null default '{}',
  visit_cycle_days int,
  note text not null default '',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint staff_owner_requires_staff
    check (owner_type <> 'staff' or owner_staff_id is not null)
);

create index customers_search_idx on customers (tenant_id, name_kana, phone);

-- ---------------------------------------------------------------
-- メニュー / 設備リソース
-- ---------------------------------------------------------------
create table menus (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  category text not null default '',
  name text not null,
  duration_min int not null,
  price int not null, -- 円（整数）
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  name text not null, -- セット面 / シャンプー台等
  capacity int not null default 1
);

-- ---------------------------------------------------------------
-- 予約（排他制御: 受け入れ基準 10-1）
-- ---------------------------------------------------------------
create type reservation_status as enum ('confirmed', 'tentative', 'done', 'cancelled', 'no_show');

create table reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  customer_id uuid references customers(id),
  customer_name text not null default '',
  staff_id uuid not null references staff(id),
  resource_id uuid references resources(id),
  menu_ids uuid[] not null default '{}',
  time_range tstzrange not null,
  nominated boolean not null default false,
  status reservation_status not null default 'confirmed',
  source text not null default 'app',
  note text not null default '',
  created_at timestamptz not null default now(),
  -- 同一スタッフの時間帯重複をDB層でブロック（キャンセル系は対象外）
  constraint reservations_staff_no_overlap
    exclude using gist (
      staff_id with =,
      time_range with &&
    ) where (status in ('confirmed', 'tentative', 'done')),
  -- 同一設備の時間帯重複もブロック
  constraint reservations_resource_no_overlap
    exclude using gist (
      resource_id with =,
      time_range with &&
    ) where (resource_id is not null and status in ('confirmed', 'tentative', 'done'))
);

create index reservations_range_idx on reservations using gist (tenant_id, time_range);

-- ---------------------------------------------------------------
-- 監査ログ
-- ---------------------------------------------------------------
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  actor_staff_id uuid references staff(id),
  action text not null, -- karte_view / karte_edit / export / payment_fix / payment_reverse ...
  target_type text not null,
  target_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index audit_logs_tenant_idx on audit_logs (tenant_id, created_at desc);

-- ---------------------------------------------------------------
-- RLS ヘルパー
-- ---------------------------------------------------------------
create or replace function current_tenant_id() returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from staff where auth_user_id = auth.uid()
$$;

create or replace function current_staff() returns staff
language sql stable security definer set search_path = public as $$
  select * from staff where auth_user_id = auth.uid()
$$;

-- ---------------------------------------------------------------
-- RLS: 全テーブル有効化 + テナント分離（受け入れ基準 10-6）
-- ---------------------------------------------------------------
alter table tenants enable row level security;
alter table salons enable row level security;
alter table staff enable row level security;
alter table customers enable row level security;
alter table menus enable row level security;
alter table resources enable row level security;
alter table reservations enable row level security;
alter table audit_logs enable row level security;

create policy tenant_isolation_tenants on tenants
  for select using (id = current_tenant_id());

create policy tenant_isolation_salons on salons
  for all using (tenant_id = current_tenant_id());

create policy tenant_isolation_staff on staff
  for all using (tenant_id = current_tenant_id());

-- 顧客: テナント分離 + 所有権分離（受け入れ基準 10-3）
-- staff 個人所有顧客は、所有者本人・オーナー・店長のみ参照可
create policy customers_select on customers
  for select using (
    tenant_id = current_tenant_id()
    and (
      owner_type = 'salon'
      or owner_staff_id = (current_staff()).id
      or (current_staff()).role in ('owner', 'manager')
    )
  );

create policy customers_write on customers
  for all using (
    tenant_id = current_tenant_id()
    and (
      owner_type = 'salon'
      or owner_staff_id = (current_staff()).id
      or (current_staff()).role in ('owner', 'manager')
    )
  );

create policy tenant_isolation_menus on menus
  for all using (tenant_id = current_tenant_id());

create policy tenant_isolation_resources on resources
  for all using (tenant_id = current_tenant_id());

create policy tenant_isolation_reservations on reservations
  for all using (tenant_id = current_tenant_id());

-- 監査ログ: 追記は全スタッフ、閲覧はオーナーのみ
create policy audit_logs_insert on audit_logs
  for insert with check (tenant_id = current_tenant_id());

create policy audit_logs_select on audit_logs
  for select using (
    tenant_id = current_tenant_id() and (current_staff()).role = 'owner'
  );
