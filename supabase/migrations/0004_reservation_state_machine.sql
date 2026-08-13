-- マスター要件 §63 予約状態遷移 / RESERVATION-008 変更履歴 / RESERVATION-009 キャンセル理由
-- 遷移ルールはアプリ層に加えてDB層のトリガーでも強制する（不正遷移の最終防衛線）

create type cancel_reason as enum
  ('customer_request', 'shop_request', 'no_show', 'duplicate', 'other');

alter table reservations
  add column cancellation_reason cancel_reason;

-- ---------------------------------------------------------------
-- 変更履歴
-- ---------------------------------------------------------------
create table reservation_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  reservation_id uuid not null references reservations(id) on delete cascade,
  before_status reservation_status not null,
  after_status reservation_status not null,
  reason cancel_reason,
  changed_by uuid references staff(id),
  changed_at timestamptz not null default now()
);

create index reservation_history_idx on reservation_history (reservation_id, changed_at desc);

alter table reservation_history enable row level security;

create policy tenant_isolation_reservation_history on reservation_history
  for all using (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------
-- 遷移検証トリガー（§63）
-- 正常系: requested → confirmed → checked_in → in_service → completed
-- 代替系: requested/confirmed → cancelled、confirmed → no_show
-- completed → cancelled は遷移表に存在しないため必ず拒否される
-- ---------------------------------------------------------------
create or replace function check_reservation_transition() returns trigger
language plpgsql as $$
begin
  if old.status = new.status then
    return new;
  end if;
  if not (
    (old.status = 'requested'  and new.status in ('confirmed', 'cancelled')) or
    (old.status = 'confirmed'  and new.status in ('checked_in', 'cancelled', 'no_show')) or
    (old.status = 'checked_in' and new.status = 'in_service') or
    (old.status = 'in_service' and new.status = 'completed')
  ) then
    raise exception 'invalid reservation transition: % -> %', old.status, new.status;
  end if;
  -- 履歴を自動記録
  insert into reservation_history
    (tenant_id, reservation_id, before_status, after_status, reason)
  values
    (new.tenant_id, new.id, old.status, new.status, new.cancellation_reason);
  return new;
end $$;

create trigger reservations_transition before update of status on reservations
  for each row execute function check_reservation_transition();
