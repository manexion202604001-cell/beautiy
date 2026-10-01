import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { SOURCE_LABEL } from '../../../api/appointments';
import { customerKeys, customersApi, useCustomer, useTags } from '../../../api/customers';
import { useStaffList } from '../../../api/org';
import type {
  CustomerDetail as Customer,
  DuplicateCandidate,
  Memo,
  TimelineEntry,
} from '../../../api/types';
import { AppointmentDrawer } from '../../../components/appointments/AppointmentDrawer';
import { CreateAppointmentDrawer } from '../../../components/appointments/CreateAppointmentDrawer';
import { reasonLabel } from '../../../components/appointments/CustomerPicker';
import { StatusBadge } from '../../../components/appointments/StatusBadge';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  InlineLoading,
  Input,
  KeyValue,
  PageSpinner,
  Segmented,
  TabPanel,
  Tabs,
  TagChip,
  Textarea,
  useToast,
} from '../../../components/ui';
import { errorMessage, isApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { cn } from '../../../lib/cn';
import {
  GENDER_LABEL,
  formatAge,
  formatAgo,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelativeDay,
  formatTime,
  formatYen,
} from '../../../lib/format';
import { CustomerKartesTab, CustomerFormsTab } from '../kartes/CustomerKarteTabs';
import { CustomerForm, toInitial } from './CustomerForm';

type Tab = 'profile' | 'visits' | 'timeline' | 'memos' | 'tags' | 'duplicates' | 'kartes' | 'forms';

export default function CustomerDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, timezone: tz, currentShopId, shops } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'profile';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'profile') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };
  const q = useCustomer(id);
  const c = q.data;
  const [booking, setBooking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [openAppt, setOpenAppt] = useState<string | null>(null);
  const dupCount = useQuery({
    queryKey: customerKeys.duplicates(id),
    queryFn: () => customersApi.duplicatesFor(id),
    enabled: !!c && c.status !== 'merged',
  });
  const bookingInitial = useMemo(
    () =>
      c
        ? {
            customer: { id: c.id, name: c.display_name, phone: c.phone, visitCount: c.visit_count },
          }
        : undefined,
    [c],
  );

  const del = useMutation({
    mutationFn: () => customersApi.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: customerKeys.all });
      toast.success('顧客を削除しました');
      navigate('/app/customers');
    },
    onError: (e) => toast.error(e),
  });

  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!c) return null;

  const merged = c.status === 'merged';
  const shopName = shops.find((s) => s.id === c.primary_shop_id)?.name;

  return (
    <div className="space-y-5">
      <Link to="/app/customers" className="text-[13px] text-muted hover:text-fg">
        ← 顧客一覧
      </Link>

      {merged ? (
        <Alert
          tone="warning"
          title="この顧客は統合済みです"
          action={
            c.merged_into_id ? (
              <Link
                to={`/app/customers/${c.merged_into_id}`}
                className="text-[13px] font-medium text-primary hover:underline"
              >
                統合先を開く
              </Link>
            ) : null
          }
        >
          予約・カルテ・会計などの履歴は統合先の顧客に移動しています。
        </Alert>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <Avatar name={c.display_name || c.last_name_kana} size={56} color="var(--primary)" />
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
                {c.display_name || '（氏名未登録）'}
                {c.status === 'blocked' ? <Badge tone="danger">予約受付停止</Badge> : null}
                {c.visit_count === 0 ? <Badge tone="info">新規</Badge> : null}
              </h1>
              <p className="text-[13px] text-muted">
                {[
                  `${c.last_name_kana} ${c.first_name_kana}`.trim(),
                  c.gender ? GENDER_LABEL[c.gender] : null,
                  formatAge(c.birthday, tz),
                  c.customer_number ? `No.${c.customer_number}` : null,
                ]
                  .filter(Boolean)
                  .join(' ・ ')}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
                {c.phone ? (
                  <a
                    href={`tel:${c.phone}`}
                    className="inline-flex items-center gap-1 hover:text-fg"
                  >
                    <Icon name="phone" size={14} />
                    {c.phone}
                  </a>
                ) : null}
                {c.email ? (
                  <a
                    href={`mailto:${c.email}`}
                    className="inline-flex items-center gap-1 hover:text-fg"
                  >
                    <Icon name="mail" size={14} />
                    {c.email}
                  </a>
                ) : null}
                {c.identities.some((i) => i.provider === 'line') ? (
                  <span className="inline-flex items-center gap-1 text-success">
                    <Icon name="line" size={14} />
                    LINE連携済み
                  </span>
                ) : null}
                {shopName ? (
                  <span className="inline-flex items-center gap-1">
                    <Icon name="store" size={14} />
                    {shopName}
                  </span>
                ) : null}
              </div>
              {c.tags.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.tags.map((t) => (
                    <TagChip key={t.id} name={t.name} color={t.color} />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          {!merged ? (
            <div className="flex gap-2">
              {can('appointment.write') && currentShopId ? (
                <Button variant="primary" icon="calendar" onClick={() => setBooking(true)}>
                  予約を作成
                </Button>
              ) : null}
              {can('customer.delete') ? (
                <IconButton
                  icon="trash"
                  label="顧客を削除"
                  variant="secondary"
                  onClick={() => setDeleting(true)}
                />
              ) : null}
            </div>
          ) : null}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-3 lg:grid-cols-6">
          <StatItem label="来店回数" value={`${c.visit_count}回`} />
          <StatItem label="累計売上" value={formatYen(c.total_sales)} />
          <StatItem
            label="最終来店"
            value={c.last_visit_at ? formatDate(c.last_visit_at, tz, { weekday: false }) : '—'}
            sub={c.last_visit_at ? formatRelativeDay(c.last_visit_at, tz) : undefined}
          />
          <StatItem
            label="平均来店周期"
            value={c.avg_cycle_days ? `${Math.round(c.avg_cycle_days)}日` : '—'}
          />
          <StatItem
            label="次回予約"
            value={
              c.next_appointment_at
                ? formatDate(c.next_appointment_at, tz, { year: false })
                : 'なし'
            }
            sub={
              c.next_appointment_at
                ? `${formatTime(c.next_appointment_at, tz)}〜 ・ ${formatRelativeDay(c.next_appointment_at, tz)}`
                : undefined
            }
          />
          <StatItem
            label="ポイント"
            value={`${formatNumber(c.point_balance)} pt`}
            sub={c.no_show_count ? `無断キャンセル ${c.no_show_count}回` : undefined}
          />
        </dl>
      </Card>

      <div>
        <Tabs
          idBase="cust"
          label="顧客情報"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'profile', label: 'プロフィール' },
            { value: 'visits', label: '来店履歴' },
            { value: 'timeline', label: 'タイムライン' },
            { value: 'memos', label: 'メモ' },
            ...(can('karte.read')
              ? [
                  { value: 'kartes' as const, label: 'カルテ' },
                  { value: 'forms' as const, label: '書類' },
                ]
              : []),
            { value: 'tags', label: 'タグ' },
            {
              value: 'duplicates',
              label: '重複候補・統合',
              count: dupCount.data?.length || undefined,
            },
          ]}
        />
        <div className="pt-5">
          <TabPanel idBase="cust" value={tab}>
            {tab === 'profile' ? <ProfileTab c={c} /> : null}
            {tab === 'visits' ? <VisitsTab id={c.id} onOpen={setOpenAppt} /> : null}
            {tab === 'timeline' ? <TimelineTab id={c.id} onOpen={setOpenAppt} /> : null}
            {tab === 'memos' ? <MemosTab id={c.id} readOnly={merged} /> : null}
            {tab === 'kartes' ? <CustomerKartesTab customerId={c.id} readOnly={merged} /> : null}
            {tab === 'forms' ? (
              <CustomerFormsTab customerId={c.id} customerName={c.display_name} readOnly={merged} />
            ) : null}
            {tab === 'tags' ? <TagsTab c={c} /> : null}
            {tab === 'duplicates' ? <DuplicatesTab c={c} /> : null}
          </TabPanel>
        </div>
      </div>

      {currentShopId ? (
        <CreateAppointmentDrawer
          open={booking}
          onClose={() => setBooking(false)}
          shopId={currentShopId}
          tz={tz}
          initial={bookingInitial}
        />
      ) : null}
      <AppointmentDrawer id={openAppt} onClose={() => setOpenAppt(null)} tz={tz} />
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="顧客を削除しますか？"
        description="顧客は論理削除され、一覧や検索に表示されなくなります。予約・会計の履歴は保持されます。"
        tone="danger"
        confirmLabel="削除する"
        loading={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </div>
  );
}

function StatItem({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-lg font-semibold tracking-tight tabular">{value}</dd>
      {sub ? <dd className="truncate text-xs text-subtle">{sub}</dd> : null}
    </div>
  );
}

// ------------------------------------------------------------------ profile

function ProfileTab({ c }: { c: Customer }) {
  const { can, timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const save = useMutation({
    mutationFn: (input: Parameters<typeof customersApi.update>[1]) =>
      customersApi.update(c.id, input),
    onSuccess: (updated) => {
      qc.setQueryData(customerKeys.detail(c.id), updated);
      void qc.invalidateQueries({ queryKey: customerKeys.all });
      toast.success('プロフィールを更新しました');
      setEditing(false);
    },
    onError: (e) => toast.error(e),
  });
  const initial = useMemo(() => toInitial(c), [c]);

  if (editing) {
    return (
      <Card>
        <CustomerForm
          initial={initial}
          isNew={false}
          submitLabel="保存"
          saving={save.isPending}
          onCancel={() => setEditing(false)}
          onSubmit={(input) => save.mutate(input)}
        />
      </Card>
    );
  }
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">プロフィール</h2>
          {can('customer.write') && c.status !== 'merged' ? (
            <Button size="sm" icon="edit" onClick={() => setEditing(true)}>
              編集
            </Button>
          ) : null}
        </div>
        <KeyValue
          items={[
            { label: '氏名', value: c.display_name || '—' },
            { label: 'フリガナ', value: `${c.last_name_kana} ${c.first_name_kana}`.trim() || '—' },
            { label: '性別', value: c.gender ? GENDER_LABEL[c.gender] : '—' },
            {
              label: '生年月日',
              value: c.birthday
                ? `${formatDate(c.birthday, tz, { weekday: false })}（${formatAge(c.birthday, tz)}）`
                : '—',
            },
            { label: '電話番号', value: c.phone ?? '—' },
            { label: 'メール', value: c.email ?? '—' },
            {
              label: '住所',
              value:
                [c.postal_code && `〒${c.postal_code}`, c.address].filter(Boolean).join(' ') || '—',
            },
            { label: '職業', value: c.occupation ?? '—' },
            { label: '来店きっかけ', value: c.acquisition_source ?? '—' },
            { label: '配信許可', value: c.marketing_opt_in ? '許可' : '拒否' },
            { label: '初回来店', value: c.first_visit_at ? formatDate(c.first_visit_at, tz) : '—' },
            { label: '登録日', value: formatDate(c.created_at, tz) },
          ]}
        />
      </Card>
      <div className="space-y-5">
        <Card>
          <h2 className="mb-3 text-[15px] font-semibold">担当・店舗</h2>
          {c.relations.length ? (
            <ul className="space-y-2 text-[13px]">
              {c.relations.map((r) => (
                <li key={r.id} className="flex items-center justify-between">
                  <span>
                    {r.relation_type === 'primary_staff'
                      ? `担当: ${r.staff_name ?? '—'}`
                      : '来店店舗'}
                  </span>
                  <span className="text-xs text-muted">
                    {formatDate(r.started_at, tz, { weekday: false })}〜
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">担当関係はまだありません</p>
          )}
        </Card>
        <Card>
          <h2 className="mb-3 text-[15px] font-semibold">外部ID連携</h2>
          {c.identities.length ? (
            <ul className="space-y-2 text-[13px]">
              {c.identities.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2">
                    <Badge tone={i.provider === 'line' ? 'success' : 'neutral'}>
                      {i.provider.toUpperCase()}
                    </Badge>
                    {i.display_name ?? i.external_id}
                  </span>
                  <span className="text-xs text-muted">
                    {formatDate(i.linked_at, tz, { weekday: false })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">LINEなどの外部IDは連携されていません</p>
          )}
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ visits

function VisitsTab({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const { timezone: tz } = useAuth();
  const q = useQuery({ queryKey: customerKeys.visits(id), queryFn: () => customersApi.visits(id) });
  if (q.isLoading) return <InlineLoading />;
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data?.length) return <EmptyState icon="calendar" title="来店・予約履歴はありません" />;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
      {q.data.map((v) => (
        <li key={v.id}>
          <button
            type="button"
            onClick={() => onOpen(v.id)}
            className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-surface-2/60"
          >
            <div className="w-28 shrink-0">
              <p className="text-[13px] font-medium tabular">
                {formatDate(v.start_at, tz, { weekday: false })}
              </p>
              <p className="text-xs text-muted tabular">{formatTime(v.start_at, tz)}〜</p>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">
                {v.services.map((s) => s.name).join('・') || '—'}
              </p>
              <p className="truncate text-xs text-muted">
                {v.shop_name} ・ {v.staff_name ?? '担当未定'}
                {v.is_nominated ? '（指名）' : ''} ・ {SOURCE_LABEL[v.source] ?? v.source}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[13px] tabular">
                {formatYen(v.transaction?.total ?? v.estimated_total)}
              </p>
              <p className="text-[11px] text-subtle">{v.transaction ? '会計済み' : '見込み'}</p>
            </div>
            <StatusBadge status={v.status} size="sm" />
          </button>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ timeline

const KIND_META: Record<
  TimelineEntry['kind'],
  { label: string; icon: 'calendar' | 'receipt' | 'file' | 'message' | 'star' | 'edit' }
> = {
  appointment: { label: '予約', icon: 'calendar' },
  transaction: { label: '会計', icon: 'receipt' },
  karte: { label: 'カルテ', icon: 'file' },
  message: { label: 'メッセージ', icon: 'message' },
  review: { label: '口コミ', icon: 'star' },
  form: { label: 'フォーム', icon: 'edit' },
};

const APPT_STATUS_JA: Record<string, string> = {
  tentative: '仮予約',
  confirmed: '確定',
  checked_in: '来店',
  in_service: '施術中',
  completed: '完了',
  cancelled: 'キャンセル',
  no_show: '無断キャンセル',
};

function timelineSummary(e: TimelineEntry) {
  if (e.kind === 'appointment') return APPT_STATUS_JA[e.summary] ?? e.summary;
  if (e.kind === 'transaction') {
    const total = (e.ref.total as number | undefined) ?? Number(e.summary.split(':')[1]);
    return `${e.summary.startsWith('completed') ? '会計' : e.summary.split(':')[0]} ${formatYen(total)}`;
  }
  if (e.kind === 'message') {
    const [dir, ...rest] = e.summary.split(':');
    return `${dir === 'inbound' ? '受信' : '送信'}: ${rest.join(':')}`;
  }
  return e.summary;
}

function TimelineTab({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const { timezone: tz } = useAuth();
  const q = useQuery({
    queryKey: customerKeys.timeline(id),
    queryFn: () => customersApi.timeline(id),
  });
  if (q.isLoading) return <InlineLoading />;
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data?.length) return <EmptyState icon="layers" title="タイムラインはまだありません" />;
  return (
    <Card>
      <ol className="relative space-y-5 border-l border-border pl-6">
        {q.data.map((e) => {
          const meta = KIND_META[e.kind] ?? { label: e.kind, icon: 'edit' as const };
          return (
            <li key={`${e.kind}-${e.id}`} className="relative">
              <span className="absolute -left-[37px] flex h-6 w-6 items-center justify-center rounded-full border border-border bg-surface text-muted">
                <Icon name={meta.icon} size={13} />
              </span>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[13px] font-medium">{meta.label}</span>
                <span className="text-xs text-muted">{formatDateTime(e.at, tz)}</span>
              </div>
              {e.kind === 'appointment' ? (
                <button
                  type="button"
                  className="text-[13px] text-primary hover:underline"
                  onClick={() => onOpen(e.id)}
                >
                  {timelineSummary(e)}
                </button>
              ) : (
                <p className="text-[13px] text-muted">{timelineSummary(e)}</p>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

// ------------------------------------------------------------------ memos

function MemosTab({ id, readOnly }: { id: string; readOnly: boolean }) {
  const { me, can, timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: customerKeys.memos(id), queryFn: () => customersApi.memos(id) });
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'shared' | 'private'>('shared');
  const [pinned, setPinned] = useState(false);
  const [editing, setEditing] = useState<Memo | null>(null);
  const [editBody, setEditBody] = useState('');
  const [deleting, setDeleting] = useState<Memo | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: customerKeys.memos(id) });

  const create = useMutation({
    mutationFn: () => customersApi.createMemo(id, { body: body.trim(), visibility, pinned }),
    onSuccess: () => {
      setBody('');
      setPinned(false);
      void invalidate();
      toast.success('メモを追加しました');
    },
    onError: (e) => toast.error(e),
  });
  const update = useMutation({
    mutationFn: ({
      memo,
      input,
    }: {
      memo: Memo;
      input: { body?: string; pinned?: boolean; visibility?: 'shared' | 'private' };
    }) => customersApi.updateMemo(memo.id, input),
    onSuccess: () => {
      setEditing(null);
      void invalidate();
    },
    onError: (e) => toast.error(e),
  });
  const remove = useMutation({
    mutationFn: (memo: Memo) => customersApi.deleteMemo(memo.id),
    onSuccess: () => {
      setDeleting(null);
      void invalidate();
      toast.success('メモを削除しました');
    },
    onError: (e) => toast.error(e),
  });

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
      {can('customer.write') && !readOnly ? (
        <Card className="h-fit">
          <h2 className="mb-3 text-[15px] font-semibold">メモを追加</h2>
          <label htmlFor="memo-body" className="sr-only">
            メモ
          </label>
          <Textarea
            id="memo-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="施術の好み、会話の内容、注意事項など"
            maxLength={5000}
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <Segmented
              label="公開範囲"
              value={visibility}
              onChange={setVisibility}
              size="sm"
              options={[
                { value: 'shared', label: 'スタッフ共有' },
                { value: 'private', label: '自分のみ' },
              ]}
            />
            <label className="inline-flex items-center gap-1.5 text-[13px]">
              <input
                type="checkbox"
                className="accent-[var(--primary)]"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
              />
              ピン留め
            </label>
          </div>
          <p className="mt-2 text-xs text-muted">
            「自分のみ」のメモはオーナーを含む他のスタッフには表示されません。
          </p>
          <Button
            className="mt-3"
            variant="primary"
            size="sm"
            disabled={!body.trim()}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            追加
          </Button>
        </Card>
      ) : null}
      <div className="space-y-3">
        {q.isLoading ? <InlineLoading /> : null}
        {q.error ? <ErrorState error={q.error} /> : null}
        {q.data && !q.data.length ? <EmptyState icon="edit" title="メモはまだありません" /> : null}
        {q.data?.map((m) => {
          const mine = m.staff_id === me?.staff.id;
          return (
            <Card key={m.id} className={cn('!p-4', m.pinned && 'border-warning/50')}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="font-medium text-fg">{m.staff_name ?? 'スタッフ'}</span>
                  <span>{formatAgo(m.created_at)}</span>
                  {m.visibility === 'private' ? (
                    <Badge size="sm" tone="neutral">
                      <Icon name="lock" size={11} /> 自分のみ
                    </Badge>
                  ) : null}
                  {m.pinned ? (
                    <Badge size="sm" tone="warning">
                      ピン留め
                    </Badge>
                  ) : null}
                </div>
                {mine && !readOnly ? (
                  <div className="flex gap-1">
                    <IconButton
                      icon={m.pinned ? 'x' : 'star'}
                      label={m.pinned ? 'ピン留めを外す' : 'ピン留め'}
                      size="xs"
                      onClick={() => update.mutate({ memo: m, input: { pinned: !m.pinned } })}
                    />
                    <IconButton
                      icon="edit"
                      label="編集"
                      size="xs"
                      onClick={() => {
                        setEditing(m);
                        setEditBody(m.body);
                      }}
                    />
                    <IconButton
                      icon="trash"
                      label="削除"
                      size="xs"
                      onClick={() => setDeleting(m)}
                    />
                  </div>
                ) : null}
              </div>
              {editing?.id === m.id ? (
                <div className="mt-2 space-y-2">
                  <label htmlFor={`memo-edit-${m.id}`} className="sr-only">
                    メモを編集
                  </label>
                  <Textarea
                    id={`memo-edit-${m.id}`}
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={3}
                  />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      キャンセル
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={update.isPending}
                      disabled={!editBody.trim()}
                      onClick={() => update.mutate({ memo: m, input: { body: editBody.trim() } })}
                    >
                      保存
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed">{m.body}</p>
              )}
              <p className="mt-1 text-[11px] text-subtle">{formatDateTime(m.created_at, tz)}</p>
            </Card>
          );
        })}
      </div>
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="メモを削除しますか？"
        tone="danger"
        confirmLabel="削除する"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

// ------------------------------------------------------------------ tags

const TAG_COLORS = [
  '#0f766e',
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#d97706',
  '#16a34a',
  '#475569',
];

function TagsTab({ c }: { c: Customer }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const tags = useTags();
  const [selected, setSelected] = useState<string[]>(c.tags.map((t) => t.id));
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[0]!);
  useEffect(() => setSelected(c.tags.map((t) => t.id)), [c.tags]);
  const dirty =
    [...selected].sort().join() !==
    c.tags
      .map((t) => t.id)
      .sort()
      .join();
  const writable = can('customer.write') && c.status !== 'merged';

  const save = useMutation({
    mutationFn: () => customersApi.setTags(c.id, selected),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: customerKeys.detail(c.id) });
      void qc.invalidateQueries({ queryKey: customerKeys.tags });
      toast.success('タグを更新しました');
    },
    onError: (e) => toast.error(e),
  });
  const create = useMutation({
    mutationFn: () => customersApi.createTag({ name: newName.trim(), color: newColor }),
    onSuccess: (t) => {
      setNewName('');
      setSelected((s) => [...s, t.id]);
      void qc.invalidateQueries({ queryKey: customerKeys.tags });
    },
    onError: (e) => toast.error(e),
  });

  return (
    <Card>
      <h2 className="text-[15px] font-semibold">タグ</h2>
      <p className="mt-0.5 text-[13px] text-muted">
        クリックで付け外しできます。タグは顧客検索・セグメント配信に使えます。
      </p>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="タグ">
        {(tags.data ?? []).map((t) => {
          const on = selected.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={on}
              disabled={!writable}
              onClick={() => setSelected((s) => (on ? s.filter((x) => x !== t.id) : [...s, t.id]))}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] transition-colors disabled:cursor-default',
                on
                  ? 'border-transparent text-white'
                  : 'border-border bg-surface text-fg hover:bg-surface-2',
              )}
              style={on ? { background: t.color } : undefined}
            >
              {on ? (
                <Icon name="check" size={13} />
              ) : (
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: t.color }}
                  aria-hidden
                />
              )}
              {t.name}
            </button>
          );
        })}
        {tags.data && !tags.data.length ? (
          <p className="text-[13px] text-muted">タグがまだありません</p>
        ) : null}
      </div>
      {writable ? (
        <>
          <div className="mt-5 flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <div className="w-56">
              <label htmlFor="new-tag" className="mb-1 block text-xs font-medium">
                新しいタグ
              </label>
              <Input
                id="new-tag"
                inputSize="sm"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={50}
                placeholder="例: カラー定期"
              />
            </div>
            <div className="flex gap-1" role="radiogroup" aria-label="タグの色">
              {TAG_COLORS.map((col) => (
                <button
                  key={col}
                  type="button"
                  role="radio"
                  aria-checked={newColor === col}
                  aria-label={col}
                  onClick={() => setNewColor(col)}
                  className={cn(
                    'h-7 w-7 rounded-full border-2',
                    newColor === col ? 'border-fg' : 'border-transparent',
                  )}
                  style={{ background: col }}
                />
              ))}
            </div>
            <Button
              size="sm"
              icon="plus"
              disabled={!newName.trim()}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              作成
            </Button>
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              variant="primary"
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              タグを保存
            </Button>
          </div>
        </>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------ duplicates & merge

function DuplicatesTab({ c }: { c: Customer }) {
  const { can, timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const merged = c.status === 'merged';
  const dups = useQuery({
    queryKey: customerKeys.duplicates(c.id),
    queryFn: () => customersApi.duplicatesFor(c.id),
    enabled: !merged,
  });
  const logs = useQuery({
    queryKey: customerKeys.mergeLogs(c.id),
    queryFn: () => customersApi.mergeLogs(c.id),
  });
  const staff = useStaffList({ includeInactive: true });
  const [preview, setPreview] = useState<DuplicateCandidate | null>(null);
  const [undoId, setUndoId] = useState<string | null>(null);

  const dismiss = useMutation({
    mutationFn: (other: string) => customersApi.dismissDuplicate(c.id, other),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: customerKeys.duplicates(c.id) });
      toast.success('重複候補から除外しました');
    },
    onError: (e) => toast.error(e),
  });
  const undo = useMutation({
    mutationFn: (logId: string) => customersApi.undoMerge(logId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: customerKeys.all });
      toast.success('統合を取り消しました');
      setUndoId(null);
    },
    onError: (e) => {
      toast.error(e);
      setUndoId(null);
    },
  });

  return (
    <div className="space-y-5">
      {!merged ? (
        <Card padded={false}>
          <div className="p-5 pb-3">
            <h2 className="text-[15px] font-semibold">重複候補</h2>
            <p className="mt-0.5 text-[13px] text-muted">
              電話・メールの完全一致、または氏名の類似＋生年月日/電話番号下4桁の一致で検出しています。
            </p>
          </div>
          {dups.isLoading ? (
            <div className="px-5 pb-5">
              <InlineLoading />
            </div>
          ) : null}
          {dups.error ? (
            <div className="p-5">
              <ErrorState error={dups.error} />
            </div>
          ) : null}
          {dups.data && !dups.data.length ? (
            <p className="border-t border-border px-5 py-4 text-[13px] text-muted">
              重複候補は見つかりませんでした。
            </p>
          ) : null}
          {dups.data?.length ? (
            <ul className="divide-y divide-border border-t border-border">
              {dups.data.map((d) => (
                <li key={d.customerId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/app/customers/${d.customerId}`}
                      className="text-sm font-medium hover:text-primary hover:underline"
                    >
                      {d.displayName || '（氏名未登録）'}
                    </Link>
                    <p className="text-xs text-muted">
                      {[
                        d.phone,
                        d.email,
                        d.birthday && formatDate(d.birthday, tz, { weekday: false }),
                        `来店${d.visitCount}回`,
                        d.lastVisitAt &&
                          `最終 ${formatDate(d.lastVisitAt, tz, { weekday: false })}`,
                      ]
                        .filter(Boolean)
                        .join(' ・ ')}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge size="sm" tone={d.strength === 'exact' ? 'danger' : 'warning'}>
                        {d.strength === 'exact' ? '強い一致' : '類似'} {Math.round(d.score * 100)}%
                      </Badge>
                      {d.reasons.map((r) => (
                        <Badge key={r} size="sm">
                          {reasonLabel(r)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  {can('customer.merge') ? (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => dismiss.mutate(d.customerId)}
                        disabled={dismiss.isPending}
                      >
                        別人として除外
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        icon="merge"
                        onClick={() => setPreview(d)}
                      >
                        比較して統合
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      <Card padded={false}>
        <div className="p-5 pb-3">
          <h2 className="text-[15px] font-semibold">統合履歴</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            統合は取り消し（Undo）できます。後から関連する統合を行った場合は、新しいものから順に取り消してください。
          </p>
        </div>
        {logs.data && !logs.data.length ? (
          <p className="border-t border-border px-5 py-4 text-[13px] text-muted">
            統合履歴はありません。
          </p>
        ) : null}
        {logs.data?.length ? (
          <ul className="divide-y divide-border border-t border-border">
            {logs.data.map((l) => {
              const asTarget = l.target_customer_id === c.id;
              const other = asTarget ? l.source_customer_id : l.target_customer_id;
              return (
                <li key={l.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-[13px]">
                  <div className="min-w-0 flex-1">
                    <p>
                      {asTarget ? '別の顧客をこの顧客に統合' : 'この顧客を別の顧客に統合'} ・{' '}
                      <Link to={`/app/customers/${other}`} className="text-primary hover:underline">
                        相手の顧客を開く
                      </Link>
                    </p>
                    <p className="text-xs text-muted">
                      {formatDateTime(l.merged_at, tz)} ・{' '}
                      {staff.data?.find((s) => s.id === l.merged_by)?.display_name ?? '—'}
                      {l.reason ? ` ・ 理由: ${l.reason}` : ''}
                    </p>
                  </div>
                  {l.undone_at ? (
                    <Badge>取り消し済み {formatDate(l.undone_at, tz, { weekday: false })}</Badge>
                  ) : can('customer.merge') ? (
                    <Button size="sm" icon="undo" onClick={() => setUndoId(l.id)}>
                      取り消す
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </Card>

      {preview ? (
        <MergeDialog
          current={c}
          candidate={preview}
          onClose={() => setPreview(null)}
          onMerged={(targetId) => {
            setPreview(null);
            void qc.invalidateQueries({ queryKey: customerKeys.all });
            if (targetId !== c.id) navigate(`/app/customers/${targetId}?tab=duplicates`);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={!!undoId}
        onClose={() => setUndoId(null)}
        title="統合を取り消しますか？"
        description="移動した予約・会計・メモなどを元の顧客に戻します。"
        confirmLabel="取り消す"
        loading={undo.isPending}
        onConfirm={() => undoId && undo.mutate(undoId)}
      />
    </div>
  );
}

function MergeDialog({
  current,
  candidate,
  onClose,
  onMerged,
}: {
  current: Customer;
  candidate: DuplicateCandidate;
  onClose: () => void;
  onMerged: (targetId: string) => void;
}) {
  const { timezone: tz } = useAuth();
  const toast = useToast();
  const other = useCustomer(candidate.customerId);
  const [direction, setDirection] = useState<'into-current' | 'into-other'>(
    current.visit_count >= candidate.visitCount ? 'into-current' : 'into-other',
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const merge = useMutation({
    mutationFn: () => {
      const targetId = direction === 'into-current' ? current.id : candidate.customerId;
      const sourceId = direction === 'into-current' ? candidate.customerId : current.id;
      return customersApi.merge(targetId, sourceId, reason.trim() || undefined);
    },
    onSuccess: (res) => {
      const moved = Object.values(res.moved).reduce((s, n) => s + n, 0);
      toast.success('顧客を統合しました', `${moved}件の関連データを移動しました`);
      onMerged(res.targetId);
    },
    onError: (e) => setError(isApiError(e) ? e.message : errorMessage(e)),
  });

  const o = other.data;
  const rows: { label: string; a: (c: Customer) => string }[] = [
    { label: '氏名', a: (x) => x.display_name || '—' },
    { label: 'フリガナ', a: (x) => `${x.last_name_kana} ${x.first_name_kana}`.trim() || '—' },
    { label: '電話番号', a: (x) => x.phone ?? '—' },
    { label: 'メール', a: (x) => x.email ?? '—' },
    {
      label: '生年月日',
      a: (x) => (x.birthday ? formatDate(x.birthday, tz, { weekday: false }) : '—'),
    },
    { label: '来店回数', a: (x) => `${x.visit_count}回` },
    { label: '累計売上', a: (x) => formatYen(x.total_sales) },
    {
      label: '最終来店',
      a: (x) => (x.last_visit_at ? formatDate(x.last_visit_at, tz, { weekday: false }) : '—'),
    },
    { label: 'タグ', a: (x) => x.tags.map((t) => t.name).join('、') || '—' },
    { label: '登録日', a: (x) => formatDate(x.created_at, tz, { weekday: false }) },
  ];
  const target = direction === 'into-current' ? 'current' : 'other';

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="顧客の統合"
      description="残す顧客（統合先）を選んでください。もう一方の予約・カルテ・会計・メッセージ・メモ・タグは統合先へ移動し、空欄の項目は補完されます。"
      dismissable={!merge.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={merge.isPending}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            icon="merge"
            loading={merge.isPending}
            disabled={!o}
            onClick={() => merge.mutate()}
          >
            統合する
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      {other.isLoading ? <InlineLoading /> : null}
      {o ? (
        <>
          <div className="mb-4">
            <Segmented
              label="統合先"
              value={direction}
              onChange={setDirection}
              options={[
                {
                  value: 'into-current',
                  label: `「${current.display_name || '表示中の顧客'}」を残す`,
                },
                { value: 'into-other', label: `「${o.display_name || '候補'}」を残す` },
              ]}
            />
          </div>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-[13px]">
              <thead className="bg-surface-2 text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">項目</th>
                  <th
                    className={cn(
                      'px-3 py-2 text-left font-medium',
                      target === 'current' && 'text-primary',
                    )}
                  >
                    表示中の顧客 {target === 'current' ? '（残す）' : '（統合される）'}
                  </th>
                  <th
                    className={cn(
                      'px-3 py-2 text-left font-medium',
                      target === 'other' && 'text-primary',
                    )}
                  >
                    候補 {target === 'other' ? '（残す）' : '（統合される）'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const a = r.a(current);
                  const b = r.a(o);
                  return (
                    <tr key={r.label} className={a !== b ? 'bg-warning-soft/30' : undefined}>
                      <td className="px-3 py-2 text-muted">{r.label}</td>
                      <td className={cn('px-3 py-2', target === 'current' && 'font-medium')}>
                        {a}
                      </td>
                      <td className={cn('px-3 py-2', target === 'other' && 'font-medium')}>{b}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-4">
            <label htmlFor="merge-reason" className="mb-1 block text-[13px] font-medium">
              統合理由（任意）
            </label>
            <Textarea
              id="merge-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="例: 電話予約時に別名で重複登録"
              maxLength={500}
            />
          </div>
          <p className="mt-3 text-xs text-muted">
            統合は監査ログに記録され、統合履歴から取り消すことができます。
          </p>
        </>
      ) : null}
    </Dialog>
  );
}
