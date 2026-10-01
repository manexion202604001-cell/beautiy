import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  ACTION_LABEL,
  EVENT_LABEL,
  SOURCE_LABEL,
  STATUS_ACTIONS,
  appointmentKeys,
  appointmentsApi,
  useAppointment,
  useAvailability,
  type TransitionAction,
} from '../../api/appointments';
import { useMenus } from '../../api/catalog';
import { customerKeys } from '../../api/customers';
import { useStaffList } from '../../api/org';
import type { AppointmentDetail } from '../../api/types';
import { errorMessage, isApiError, newIdempotencyKey, type ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  formatAgo,
  formatDateJa,
  formatDateTime,
  formatDuration,
  formatTimeRange,
  formatYen,
} from '../../lib/format';
import { useRevealOnChange } from '../../lib/hooks';
import { zonedParts, zonedToIso } from '../../lib/time';
import { AppointmentQuickActions } from '../../routes/app/pos/AppointmentQuickActions';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Drawer,
  ErrorState,
  Field,
  Icon,
  InlineLoading,
  Input,
  KeyValue,
  Select,
  TabPanel,
  Tabs,
  Textarea,
  useToast,
} from '../ui';
import { CustomerPicker, type PickedCustomer } from './CustomerPicker';
import { MenuPicker, SlotPicker } from './Pickers';
import { StatusBadge } from './StatusBadge';

type Tab = 'detail' | 'edit' | 'history';

const ACTION_VARIANT: Partial<
  Record<TransitionAction, 'primary' | 'secondary' | 'danger' | 'outline'>
> = {
  confirm: 'primary',
  'check-in': 'primary',
  start: 'secondary',
  complete: 'primary',
  cancel: 'outline',
  'no-show': 'outline',
  restore: 'secondary',
};

export function AppointmentDrawer({
  id,
  onClose,
  tz,
}: {
  id: string | null;
  onClose: () => void;
  tz: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const q = useAppointment(id);
  const a = q.data;
  const [tab, setTab] = useState<Tab>('detail');
  const [confirm, setConfirm] = useState<TransitionAction | null>(null);
  const [busy, setBusy] = useState<TransitionAction | null>(null);
  const [actionError, setActionError] = useState<ApiError | Error | null>(null);
  const actionErrorRef = useRevealOnChange<HTMLDivElement>(actionError);

  useEffect(() => {
    setTab('detail');
    setActionError(null);
  }, [id]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: appointmentKeys.all });
    if (a?.customer_id) void qc.invalidateQueries({ queryKey: customerKeys.detail(a.customer_id) });
  };

  const runAction = async (action: TransitionAction, reason?: string) => {
    if (!a) return;
    setBusy(action);
    setActionError(null);
    try {
      const updated = await appointmentsApi.transition(
        a.id,
        action,
        { version: a.version, ...(reason ? { reason } : {}) },
        newIdempotencyKey(),
      );
      qc.setQueryData(appointmentKeys.detail(a.id), updated);
      refresh();
      toast.success(`${ACTION_LABEL[action]}にしました`);
      setConfirm(null);
    } catch (e) {
      setActionError(e as Error);
      setConfirm(null);
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') void q.refetch();
    } finally {
      setBusy(null);
    }
  };

  const onAction = (action: TransitionAction) => {
    if (action === 'cancel' || action === 'no-show' || action === 'restore') setConfirm(action);
    else void runAction(action);
  };

  const canWrite = can('appointment.write');
  const editable = a && ['tentative', 'confirmed', 'checked_in'].includes(a.status);

  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width="lg"
      title={a ? a.customer_name || '顧客未登録の予約' : '予約詳細'}
      description={
        a ? (
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={a.status} size="sm" />
            <span>
              {formatDateJa(zonedParts(a.start_at, tz).date)}{' '}
              {formatTimeRange(a.start_at, a.end_at, tz)}
            </span>
            <span className="font-mono text-xs text-subtle">#{a.booking_reference}</span>
          </span>
        ) : undefined
      }
    >
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {a ? (
        <div className="space-y-5">
          <div ref={actionErrorRef}>
            {actionError ? (
              <ActionErrorAlert error={actionError} onReload={() => void q.refetch()} />
            ) : null}
          </div>

          {canWrite && STATUS_ACTIONS[a.status].length ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="ステータス操作">
              {STATUS_ACTIONS[a.status].map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={ACTION_VARIANT[action] ?? 'secondary'}
                  loading={busy === action}
                  disabled={!!busy}
                  onClick={() => onAction(action)}
                >
                  {ACTION_LABEL[action]}
                </Button>
              ))}
            </div>
          ) : null}
          <AppointmentQuickActions a={a} onNavigate={onClose} />

          <Tabs
            idBase="appt"
            label="予約情報"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'detail', label: '詳細' },
              { value: 'edit', label: '変更', disabled: !canWrite || !editable },
              { value: 'history', label: '履歴' },
            ]}
          />
          {tab === 'detail' ? (
            <TabPanel idBase="appt" value="detail">
              <DetailView a={a} tz={tz} />
            </TabPanel>
          ) : null}
          {tab === 'edit' && editable ? (
            <TabPanel idBase="appt" value="edit">
              <EditForm
                a={a}
                tz={tz}
                onSaved={(updated) => {
                  qc.setQueryData(appointmentKeys.detail(a.id), updated);
                  refresh();
                  setTab('detail');
                }}
                onReload={() => void q.refetch()}
              />
            </TabPanel>
          ) : null}
          {tab === 'history' ? (
            <TabPanel idBase="appt" value="history">
              <HistoryView id={a.id} tz={tz} />
            </TabPanel>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        title="予約をキャンセルしますか？"
        description="お客様都合・店舗都合などの理由を記録できます。"
        tone="danger"
        confirmLabel="キャンセルする"
        cancelLabel="戻る"
        reason
        reasonLabel="キャンセル理由"
        reasonPlaceholder="例: お客様より電話連絡（体調不良）"
        loading={busy === 'cancel'}
        onConfirm={(reason) => runAction('cancel', reason)}
      />
      <ConfirmDialog
        open={confirm === 'no-show'}
        onClose={() => setConfirm(null)}
        title="無断キャンセルとして記録しますか？"
        description="顧客の無断キャンセル回数に反映されます。"
        tone="danger"
        confirmLabel="無断キャンセルにする"
        loading={busy === 'no-show'}
        onConfirm={() => runAction('no-show')}
      />
      <ConfirmDialog
        open={confirm === 'restore'}
        onClose={() => setConfirm(null)}
        title="予約を復元しますか？"
        description="元の日時・担当で確定状態に戻します。その時間が埋まっている場合は復元できません。"
        confirmLabel="復元する"
        loading={busy === 'restore'}
        onConfirm={() => runAction('restore')}
      />
    </Drawer>
  );
}

function ActionErrorAlert({ error, onReload }: { error: Error; onReload: () => void }) {
  const code = isApiError(error) ? error.code : '';
  if (code === 'VERSION_CONFLICT') {
    return (
      <Alert
        tone="warning"
        title="他の操作で予約が更新されています"
        action={
          <Button size="xs" variant="secondary" icon="refresh" onClick={onReload}>
            最新を表示
          </Button>
        }
      >
        最新の内容を確認してから、もう一度操作してください。
      </Alert>
    );
  }
  if (
    code === 'SLOT_UNAVAILABLE' ||
    code === 'APPOINTMENT_OVERLAP' ||
    code === 'RESOURCE_OVERLAP'
  ) {
    return (
      <Alert tone="danger" title="この時間帯は予約できません">
        {errorMessage(error)}
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title="操作できませんでした">
      {errorMessage(error)}
    </Alert>
  );
}

function DetailView({ a, tz }: { a: AppointmentDetail; tz: string }) {
  const servicesTotal = a.services.reduce((s, x) => s + x.price, 0);
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted">顧客</p>
            {a.customer_id ? (
              <Link
                to={`/app/customers/${a.customer_id}`}
                className="mt-0.5 inline-flex items-center gap-1 text-[15px] font-semibold text-primary hover:underline"
              >
                {a.customer_name || '（氏名未登録）'}
                <Icon name="chevron-right" size={16} />
              </Link>
            ) : (
              <p className="mt-0.5 text-[15px] font-semibold text-muted">顧客未登録</p>
            )}
            <p className="mt-0.5 text-xs text-muted">
              {[
                a.customer_last_name_kana &&
                  `${a.customer_last_name_kana} ${a.customer_first_name_kana ?? ''}`,
                a.customer_phone,
              ]
                .filter(Boolean)
                .join(' ・ ')}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            {a.is_new_customer ? (
              <Badge tone="info">新規</Badge>
            ) : a.customer_visit_count ? (
              <Badge>来店{a.customer_visit_count}回</Badge>
            ) : null}
          </div>
        </div>
      </div>

      <KeyValue
        items={[
          {
            label: '日時',
            value: `${formatDateJa(zonedParts(a.start_at, tz).date, { year: true })} ${formatTimeRange(a.start_at, a.end_at, tz)}`,
          },
          {
            label: '担当',
            value: (
              <span className="inline-flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: a.staff_color ?? 'var(--subtle)' }}
                  aria-hidden
                />
                {a.staff_name ?? '未定'}
                {a.is_nominated ? (
                  <Badge size="sm" tone="primary">
                    指名
                  </Badge>
                ) : (
                  <Badge size="sm">フリー</Badge>
                )}
              </span>
            ),
          },
          { label: '予約経路', value: SOURCE_LABEL[a.source] ?? a.source },
          ...(a.resources.length
            ? [{ label: '設備', value: a.resources.map((r) => r.name).join('、') }]
            : []),
          ...(a.cancel_reason ? [{ label: 'キャンセル理由', value: a.cancel_reason }] : []),
          { label: '登録日時', value: formatDateTime(a.created_at, tz) },
        ]}
      />

      <div>
        <p className="mb-2 text-[13px] font-semibold">メニュー</p>
        <ul className="divide-y divide-border rounded-xl border border-border">
          {a.services.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 px-3 py-2.5 text-[13px]"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-fg">{s.name}</span>
                <span className="text-xs text-muted">{formatDuration(s.duration_min)}</span>
              </span>
              <span className="tabular">{formatYen(s.price)}</span>
            </li>
          ))}
          <li className="flex items-center justify-between px-3 py-2.5 text-[13px]">
            <span className="text-muted">見込み金額{a.coupon_id ? '（クーポン適用後）' : ''}</span>
            <span className="font-semibold tabular">
              {formatYen(a.estimated_total ?? servicesTotal)}
            </span>
          </li>
        </ul>
      </div>

      {a.customer_note || a.staff_note ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {a.customer_note ? (
            <div className="rounded-xl bg-surface-2 p-3">
              <p className="text-xs font-medium text-muted">お客様の要望</p>
              <p className="mt-1 whitespace-pre-wrap text-[13px]">{a.customer_note}</p>
            </div>
          ) : null}
          {a.staff_note ? (
            <div className="rounded-xl bg-warning-soft/60 p-3">
              <p className="text-xs font-medium text-muted">スタッフメモ</p>
              <p className="mt-1 whitespace-pre-wrap text-[13px]">{a.staff_note}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function EditForm({
  a,
  tz,
  onSaved,
  onReload,
}: {
  a: AppointmentDetail;
  tz: string;
  onSaved: (a: AppointmentDetail) => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const menus = useMenus(a.shop_id);
  const staff = useStaffList({ shopId: a.shop_id, bookableOnly: true });
  const start = zonedParts(a.start_at, tz);
  const [customer, setCustomer] = useState<PickedCustomer | null>(
    a.customer_id
      ? {
          id: a.customer_id,
          name: a.customer_name ?? '',
          phone: a.customer_phone,
          visitCount: a.customer_visit_count ?? undefined,
        }
      : null,
  );
  const [menuIds, setMenuIds] = useState<string[]>(
    a.services.map((s) => s.menu_id).filter((x): x is string => !!x),
  );
  const [staffId, setStaffId] = useState(a.staff_id ?? '');
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [allowOutside, setAllowOutside] = useState(false);
  const [customerNote, setCustomerNote] = useState(a.customer_note ?? '');
  const [staffNote, setStaffNote] = useState(a.staff_note ?? '');
  const [error, setError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);
  const errorRef = useRevealOnChange<HTMLDivElement>(error);

  const availQuery = useMemo(
    () =>
      menuIds.length
        ? { shopId: a.shop_id, menuIds, staffId: staffId || undefined, from: date, to: date }
        : null,
    [a.shop_id, menuIds, staffId, date],
  );
  const availability = useAvailability(availQuery);
  // GET /availability has no "exclude this appointment" option → the current slot shows as busy; keep it selectable
  const currentIso = a.start_at;
  const merged = useMemo(() => {
    const slots = availability.data?.days[0]?.slots ?? [];
    const own =
      date === start.date &&
      (!staffId || staffId === a.staff_id) &&
      !slots.some((s) => s.start === currentIso);
    const list = own
      ? [...slots, { start: currentIso, end: a.end_at, staffIds: a.staff_id ? [a.staff_id] : [] }]
      : slots;
    return [...list].sort((x, y) => x.start.localeCompare(y.start));
  }, [availability.data, date, start.date, staffId, a.staff_id, currentIso, a.end_at]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const newStart = zonedToIso(date, time, tz);
    const origMenuIds = a.services.map((s) => s.menu_id).filter(Boolean);
    const menusChanged = menuIds.join(',') !== origMenuIds.join(',');
    try {
      const updated = await appointmentsApi.update(
        a.id,
        {
          version: a.version,
          ...(newStart !== a.start_at ? { startAt: newStart } : {}),
          ...(staffId !== (a.staff_id ?? '')
            ? { staffId: staffId || null, isNominated: !!staffId }
            : {}),
          ...(menusChanged ? { menuIds } : {}),
          ...((customer?.id ?? null) !== a.customer_id ? { customerId: customer?.id ?? null } : {}),
          customerNote: customerNote.trim() || null,
          staffNote: staffNote.trim() || null,
          ...(allowOutside ? { allowOutsideSchedule: true } : {}),
        },
        newIdempotencyKey(),
      );
      toast.success('予約を変更しました');
      onSaved(updated);
    } catch (e) {
      setError(e as Error);
      if (isApiError(e) && (e.code === 'SLOT_UNAVAILABLE' || e.code === 'APPOINTMENT_OVERLAP'))
        void availability.refetch();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div ref={errorRef}>
        {error ? <ActionErrorAlert error={error} onReload={onReload} /> : null}
      </div>
      <div>
        <p className="mb-2 text-[13px] font-medium">顧客</p>
        <CustomerPicker value={customer} onChange={setCustomer} />
      </div>
      <div>
        <p className="mb-2 text-[13px] font-medium">メニュー</p>
        <MenuPicker menus={menus.data ?? []} value={menuIds} onChange={setMenuIds} max={10} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="担当スタッフ">
          <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">フリー（自動割当）</option>
            {(staff.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="日付">
          <Input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </Field>
        <Field label="開始時刻">
          <Input
            type="time"
            step={900}
            value={time}
            onChange={(e) => e.target.value && setTime(e.target.value)}
          />
        </Field>
      </div>
      {menuIds.length ? (
        <div>
          <p className="mb-2 text-xs text-muted">空き枠から選ぶ</p>
          <SlotPicker
            slots={merged}
            value={zonedToIso(date, time, tz)}
            onChange={(iso) => setTime(zonedParts(iso, tz).time)}
            tz={tz}
            loading={availability.isLoading}
          />
        </div>
      ) : null}
      <Checkbox
        label="時間外予約を許可（スタッフ判断）"
        checked={allowOutside}
        onChange={(e) => setAllowOutside(e.target.checked)}
      />
      <Field label="お客様の要望">
        <Textarea value={customerNote} onChange={(e) => setCustomerNote(e.target.value)} rows={2} />
      </Field>
      <Field label="スタッフメモ">
        <Textarea value={staffNote} onChange={(e) => setStaffNote(e.target.value)} rows={2} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="primary" onClick={save} loading={saving} disabled={!menuIds.length}>
          変更を保存
        </Button>
      </div>
    </div>
  );
}

function HistoryView({ id, tz }: { id: string; tz: string }) {
  const staff = useStaffList({ includeInactive: true });
  const q = useQuery({
    queryKey: appointmentKeys.history(id),
    queryFn: () => appointmentsApi.history(id),
  });
  if (q.isLoading) return <InlineLoading />;
  if (q.error) return <ErrorState error={q.error} />;
  const nameOf = (actorType: string, actorId: string | null) => {
    if (actorType === 'staff')
      return staff.data?.find((s) => s.id === actorId)?.display_name ?? 'スタッフ';
    if (actorType === 'customer') return 'お客様';
    if (actorType === 'external') return '外部連携';
    return 'システム';
  };
  return (
    <ol className="relative space-y-4 border-l border-border pl-5">
      {(q.data ?? [])
        .slice()
        .reverse()
        .map((e) => {
          const p = e.payload as { reason?: string; from?: unknown; to?: { startAt?: string } };
          return (
            <li key={e.id} className="relative">
              <span
                className="absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-primary"
                aria-hidden
              />
              <p className="text-[13px] font-medium text-fg">
                {EVENT_LABEL[e.event_type] ?? e.event_type}
              </p>
              <p className="text-xs text-muted">
                {formatDateTime(e.created_at, tz)}（{formatAgo(e.created_at)}）・{' '}
                {nameOf(e.actor_type, e.actor_id)}
              </p>
              {e.event_type === 'rescheduled' && p.to?.startAt ? (
                <p className="mt-0.5 text-xs text-muted">→ {formatDateTime(p.to.startAt, tz)}</p>
              ) : null}
              {p.reason ? <p className="mt-0.5 text-xs text-muted">理由: {p.reason}</p> : null}
            </li>
          );
        })}
    </ol>
  );
}
