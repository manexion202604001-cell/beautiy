import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { publicApi } from '../../api/public';
import type { CustomerProfile, PublicAppointment, PublicShopInfo } from '../../api/types';
import { SlotPicker } from '../../components/appointments/Pickers';
import { StatusBadge } from '../../components/appointments/StatusBadge';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  PageSpinner,
  Segmented,
  Switch,
  useToast,
} from '../../components/ui';
import { errorMessage, isApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { WEEKDAYS_JA, formatDateJa, formatDateTime, formatTime, formatYen } from '../../lib/format';
import { customerSession, type CustomerSession } from '../../lib/session';
import { addDays, todayIn, weekdayOf, zonedParts } from '../../lib/time';
import { CustomerLogin } from './CustomerLogin';
import { PublicShell, ShopHeader } from './PublicShell';
import { MyOrders } from './store/MyOrders';

type Tab = 'appointments' | 'orders' | 'profile' | 'notifications';

export default function My() {
  const params = useParams();
  const slug = params.shopSlug ?? customerSession.lastSlug() ?? '';
  const [session, setSession] = useState<CustomerSession | null>(() =>
    slug ? customerSession.get(slug) : null,
  );
  const info = useQuery({
    queryKey: ['public', 'shop', slug],
    queryFn: () => publicApi.shop(slug),
    enabled: !!slug,
    retry: false,
  });

  if (!slug) {
    return (
      <PublicShell>
        <EmptyState
          className="mt-10"
          icon="store"
          title="店舗が指定されていません"
          description="ご予約いただいた店舗の予約ページ、またはLINEのメニューからマイページを開いてください。"
        />
      </PublicShell>
    );
  }
  if (info.isLoading) return <PageSpinner />;
  if (info.error) {
    return (
      <PublicShell>
        <ErrorState className="mt-10" error={info.error} />
      </PublicShell>
    );
  }
  const shop = info.data!;
  const header = <ShopHeader name={shop.shop.name} sub="マイページ" />;

  if (!session) {
    return (
      <PublicShell header={header}>
        <h1 className="mb-1 text-lg font-semibold">マイページにログイン</h1>
        <p className="mb-5 text-[13px] text-muted">
          ご予約の確認・変更・キャンセル、お客様情報の変更ができます。
        </p>
        <div className="rounded-2xl border border-border bg-surface p-4">
          <CustomerLogin
            slug={slug}
            onLoggedIn={(r) =>
              setSession({
                token: r.token,
                customerId: r.customerId,
                via: r.via,
                shopSlug: slug,
                savedAt: Date.now(),
              })
            }
          />
        </div>
        <div className="mt-6 text-center">
          <ButtonLink to={`/book/${slug}`} variant="ghost">
            ログインせずに予約する
          </ButtonLink>
        </div>
      </PublicShell>
    );
  }

  return (
    <PublicShell header={header}>
      <MyPage
        slug={slug}
        shop={shop}
        session={session}
        onLogout={() => {
          customerSession.clear(slug);
          setSession(null);
        }}
      />
    </PublicShell>
  );
}

function MyPage({
  slug,
  shop,
  session,
  onLogout,
}: {
  slug: string;
  shop: PublicShopInfo;
  session: CustomerSession;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<Tab>(() =>
    new URLSearchParams(window.location.search).get('tab') === 'orders' ? 'orders' : 'appointments',
  );
  const profile = useQuery({
    queryKey: ['public', 'me', session.token],
    queryFn: () => publicApi.me(session.token),
    retry: false,
  });
  useEffect(() => {
    if (profile.error && isApiError(profile.error) && profile.error.status === 401) onLogout();
  }, [profile.error, onLogout]);
  const p = profile.data;
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">
            {session.via === 'line' ? 'LINEでログイン中' : 'ログイン中'}
          </p>
          <h1 className="truncate text-lg font-semibold">
            {p ? `${p.last_name} ${p.first_name}`.trim() || 'お客様' : '…'} 様
          </h1>
          {p ? (
            <p className="text-xs text-muted">
              ご来店 {p.visit_count}回 ・ ポイント {p.point_balance.toLocaleString('ja-JP')}pt
            </p>
          ) : null}
        </div>
        <Button size="sm" variant="ghost" onClick={onLogout}>
          ログアウト
        </Button>
      </div>
      <ButtonLink to={`/book/${slug}`} variant="primary" size="lg" icon="plus" className="w-full">
        新しく予約する
      </ButtonLink>
      <Segmented
        label="マイページ"
        value={tab}
        onChange={setTab}
        className="w-full [&>button]:flex-1"
        options={[
          { value: 'appointments', label: 'ご予約' },
          { value: 'orders', label: 'ご注文' },
          { value: 'profile', label: 'お客様情報' },
          { value: 'notifications', label: '通知設定' },
        ]}
      />
      {tab === 'appointments' ? (
        <AppointmentsTab slug={slug} shop={shop} token={session.token} />
      ) : null}
      {tab === 'orders' ? <MyOrders slug={slug} token={session.token} /> : null}
      {tab === 'profile' ? (
        p ? (
          <ProfileTab token={session.token} profile={p} />
        ) : (
          <InlineLoading />
        )
      ) : null}
      {tab === 'notifications' ? <NotificationsTab profile={p} token={session.token} /> : null}
    </div>
  );
}

function AppointmentsTab({
  slug,
  shop,
  token,
}: {
  slug: string;
  shop: PublicShopInfo;
  token: string;
}) {
  const tz = shop.shop.timezone;
  const qc = useQueryClient();
  const toast = useToast();
  const upcoming = useQuery({
    queryKey: ['public', 'my-appointments', token, 'upcoming'],
    queryFn: () => publicApi.myAppointments(token, 'upcoming'),
  });
  const past = useQuery({
    queryKey: ['public', 'my-appointments', token, 'past'],
    queryFn: () => publicApi.myAppointments(token, 'past'),
  });
  const [cancelling, setCancelling] = useState<PublicAppointment | null>(null);
  const [rescheduling, setRescheduling] = useState<PublicAppointment | null>(null);
  const cancel = useMutation({
    mutationFn: ({ a, reason }: { a: PublicAppointment; reason?: string }) =>
      publicApi.cancelMine(token, a.id, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['public', 'my-appointments', token] });
      toast.success('ご予約をキャンセルしました');
      setCancelling(null);
    },
    onError: (e) => {
      toast.error(e);
      setCancelling(null);
    },
  });

  const Card = ({ a, isPast }: { a: PublicAppointment; isPast?: boolean }) => (
    <li className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold">
            {formatDateJa(zonedParts(a.startAt, tz).date)} {formatTime(a.startAt, tz)}〜
          </p>
          <p className="text-xs text-muted">
            {a.shopName} ・ {a.staffName ?? '担当未定'}
            {a.isNominated ? '（指名）' : ''}
          </p>
        </div>
        <StatusBadge status={a.status} size="sm" />
      </div>
      <p className="mt-2 text-[13px]">{a.services.map((s) => s.name).join('、')}</p>
      <p className="text-xs text-muted">
        目安 {formatYen(a.estimatedTotal)} ・ 予約番号 {a.bookingReference}
      </p>
      {!isPast && (a.status === 'tentative' || a.status === 'confirmed') ? (
        a.canModify ? (
          <div className="mt-3 flex gap-2">
            {a.shopId === shop.shop.id ? (
              <Button size="sm" variant="secondary" onClick={() => setRescheduling(a)}>
                日時を変更
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="!text-danger"
              onClick={() => setCancelling(a)}
            >
              キャンセル
            </Button>
          </div>
        ) : (
          <p className="mt-3 text-xs text-warning">
            オンラインでの変更期限（{formatDateTime(a.cancelDeadline, tz)}
            ）を過ぎています。店舗へお電話ください。
          </p>
        )
      ) : null}
    </li>
  );

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-[13px] font-semibold text-muted">今後のご予約</h2>
        {upcoming.isLoading ? <InlineLoading /> : null}
        {upcoming.error ? <ErrorState error={upcoming.error} /> : null}
        {upcoming.data && !upcoming.data.length ? (
          <EmptyState icon="calendar" title="今後のご予約はありません" />
        ) : null}
        <ul className="space-y-2.5">
          {upcoming.data?.map((a) => (
            <Card key={a.id} a={a} />
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-2 text-[13px] font-semibold text-muted">これまでのご来店</h2>
        {past.data && !past.data.length ? (
          <p className="text-[13px] text-muted">履歴はありません</p>
        ) : null}
        <ul className="space-y-2.5">
          {past.data?.map((a) => (
            <Card key={a.id} a={a} isPast />
          ))}
        </ul>
      </section>
      <ConfirmDialog
        open={!!cancelling}
        onClose={() => setCancelling(null)}
        title="ご予約をキャンセルしますか？"
        description={
          cancelling
            ? `${formatDateJa(zonedParts(cancelling.startAt, tz).date)} ${formatTime(cancelling.startAt, tz)}〜`
            : undefined
        }
        tone="danger"
        confirmLabel="キャンセルする"
        cancelLabel="戻る"
        reason
        reasonLabel="キャンセル理由（任意）"
        loading={cancel.isPending}
        onConfirm={(reason) => cancelling && cancel.mutate({ a: cancelling, reason })}
      />
      {rescheduling ? (
        <RescheduleDialog
          slug={slug}
          shop={shop}
          token={token}
          a={rescheduling}
          onClose={() => setRescheduling(null)}
          onDone={() => {
            setRescheduling(null);
            void qc.invalidateQueries({ queryKey: ['public', 'my-appointments', token] });
          }}
        />
      ) : null}
    </div>
  );
}

function RescheduleDialog({
  slug,
  shop,
  token,
  a,
  onClose,
  onDone,
}: {
  slug: string;
  shop: PublicShopInfo;
  token: string;
  a: PublicAppointment;
  onClose: () => void;
  onDone: () => void;
}) {
  const tz = shop.shop.timezone;
  const toast = useToast();
  const today = todayIn(tz);
  const [date, setDate] = useState(
    zonedParts(a.startAt, tz).date < today ? today : zonedParts(a.startAt, tz).date,
  );
  const [slot, setSlot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuIds = a.services.map((s) => s.menuId).filter((x): x is string => !!x);
  const staffId = a.isNominated && a.staffId ? a.staffId : undefined;
  const avail = useQuery({
    queryKey: ['public', 'availability', slug, menuIds, staffId, date, 'reschedule'],
    queryFn: () => publicApi.availability(slug, { menuIds, staffId, from: date, to: date }),
    enabled: menuIds.length > 0,
  });
  const save = useMutation({
    mutationFn: () =>
      publicApi.rescheduleMine(token, a.id, {
        startAt: slot!,
        version: a.version,
        ...(staffId ? {} : { staffId: null }),
      }),
    onSuccess: () => {
      toast.success('ご予約の日時を変更しました');
      onDone();
    },
    onError: (e) => {
      setError(errorMessage(e));
      setSlot(null);
      void avail.refetch();
    },
  });
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
  const closed = (d: string) => {
    const ex = shop.exceptions.find((e) => e.date === d);
    return ex ? ex.is_closed : !shop.businessHours.some((h) => h.weekday === weekdayOf(d));
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="日時を変更"
      description={`現在: ${formatDateJa(zonedParts(a.startAt, tz).date)} ${formatTime(a.startAt, tz)}〜${staffId ? ` ・ ${a.staffName}` : ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            閉じる
          </Button>
          <Button
            variant="primary"
            disabled={!slot}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            この日時に変更
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      ) : null}
      <div
        className="scrollbar-thin -mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-2"
        role="radiogroup"
        aria-label="日付"
      >
        {days.map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={d === date}
            disabled={closed(d)}
            onClick={() => {
              setDate(d);
              setSlot(null);
            }}
            className={cn(
              'flex w-12 shrink-0 flex-col items-center rounded-xl border py-1.5 disabled:opacity-40',
              d === date ? 'border-primary bg-primary text-primary-fg' : 'border-border',
            )}
          >
            <span className="text-[10px]">{WEEKDAYS_JA[weekdayOf(d)]}</span>
            <span className="font-semibold tabular">{Number(d.slice(8))}</span>
          </button>
        ))}
      </div>
      <SlotPicker
        slots={avail.data?.days[0]?.slots ?? []}
        value={slot}
        onChange={(iso) => setSlot(iso)}
        tz={tz}
        loading={avail.isLoading}
      />
    </Dialog>
  );
}

function ProfileTab({ token, profile }: { token: string; profile: CustomerProfile }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    lastName: profile.last_name,
    firstName: profile.first_name,
    lastNameKana: profile.last_name_kana,
    firstNameKana: profile.first_name_kana,
    phone: profile.phone ?? '',
    email: profile.email ?? '',
    birthday: profile.birthday ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      publicApi.updateMe(token, {
        lastName: f.lastName.trim(),
        firstName: f.firstName.trim(),
        lastNameKana: f.lastNameKana.trim(),
        firstNameKana: f.firstNameKana.trim(),
        ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
        email: f.email.trim() || null,
        birthday: f.birthday || null,
      }),
    onSuccess: (p) => {
      qc.setQueryData(['public', 'me', token], p);
      toast.success('お客様情報を更新しました');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <div className="space-y-4 rounded-2xl border border-border bg-surface p-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="姓">
          <Input
            value={f.lastName}
            onChange={(e) => setF({ ...f, lastName: e.target.value })}
            inputSize="lg"
          />
        </Field>
        <Field label="名">
          <Input
            value={f.firstName}
            onChange={(e) => setF({ ...f, firstName: e.target.value })}
            inputSize="lg"
          />
        </Field>
        <Field label="セイ">
          <Input
            value={f.lastNameKana}
            onChange={(e) => setF({ ...f, lastNameKana: e.target.value })}
            inputSize="lg"
          />
        </Field>
        <Field label="メイ">
          <Input
            value={f.firstNameKana}
            onChange={(e) => setF({ ...f, firstNameKana: e.target.value })}
            inputSize="lg"
          />
        </Field>
      </div>
      <Field label="電話番号">
        <Input
          type="tel"
          value={f.phone}
          onChange={(e) => setF({ ...f, phone: e.target.value })}
          inputSize="lg"
        />
      </Field>
      <Field label="メールアドレス">
        <Input
          type="email"
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
          inputSize="lg"
        />
      </Field>
      <Field label="生年月日" hint="お誕生月にクーポンをお送りすることがあります">
        <Input
          type="date"
          value={f.birthday}
          onChange={(e) => setF({ ...f, birthday: e.target.value })}
          inputSize="lg"
        />
      </Field>
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        loading={save.isPending}
        onClick={() => save.mutate()}
      >
        保存する
      </Button>
    </div>
  );
}

function NotificationsTab({
  profile,
  token,
}: {
  profile: CustomerProfile | undefined;
  token: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const toggle = useMutation({
    mutationFn: (v: boolean) => publicApi.updateMe(token, { marketingOptIn: v }),
    onSuccess: (p) => {
      qc.setQueryData(['public', 'me', token], p);
      toast.success('配信設定を更新しました');
    },
    onError: (e) => toast.error(e),
  });
  if (!profile) return <InlineLoading />;
  return (
    <div className="space-y-4 rounded-2xl border border-border bg-surface p-4">
      <Switch
        checked={profile.marketing_opt_in}
        onChange={(v) => toggle.mutate(v)}
        disabled={toggle.isPending}
        label="お得な情報・キャンペーンを受け取る"
        description="ご予約の確認やリマインドは、この設定に関わらずお送りします。"
      />
      <div className="border-t border-border pt-4">
        <p className="mb-3 flex items-center gap-2 text-[13px] font-medium">
          通知チャネルの選択{' '}
          <Badge size="sm" tone="outline">
            準備中
          </Badge>
        </p>
        <div className="space-y-3 opacity-60">
          <Switch checked onChange={() => undefined} disabled label="LINEで受け取る" />
          <Switch checked={false} onChange={() => undefined} disabled label="メールで受け取る" />
          <Switch checked={false} onChange={() => undefined} disabled label="SMSで受け取る" />
        </div>
        <p className="mt-3 text-xs text-muted">チャネルごとの通知設定は近日公開予定です。</p>
      </div>
    </div>
  );
}
