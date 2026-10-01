import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { orgApi, orgKeys, useOrganization, useUpdateShop } from '../../api/org';
import { scheduleKeys, schedulesApi, useBusinessHours, useExceptions } from '../../api/schedules';
import type { CalendarException, Shop, ShopSettings } from '../../api/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  ErrorState,
  Field,
  Icon,
  IconButton,
  InlineLoading,
  Input,
  PageHeader,
  Segmented,
  Select,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  useToast,
} from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { WEEKDAYS_JA, formatDateJa } from '../../lib/format';
import { addMonths, daysInMonth, startOfMonth, todayIn, weekdayOf } from '../../lib/time';

type Tab = 'shop' | 'booking' | 'hours' | 'holidays' | 'org';

export default function Settings() {
  const { currentShop, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'shop';
  const welcome = params.get('welcome') === '1';
  if (!currentShop) return <InlineLoading />;
  const shopEditable = can('shop.manage');
  return (
    <div>
      <PageHeader
        title="店舗設定"
        description={`${currentShop.name} の基本情報・予約ルール・営業時間を設定します。`}
      />
      {welcome ? (
        <Alert tone="success" title="ご登録ありがとうございます！" className="mb-5">
          まずは営業時間とメニューを設定し、スタッフを招待しましょう。予約ページは{' '}
          <Link
            className="font-medium text-primary underline"
            to={`/book/${currentShop.slug}`}
            target="_blank"
          >
            /book/{currentShop.slug}
          </Link>{' '}
          で公開されます。
        </Alert>
      ) : null}
      <Tabs
        idBase="settings"
        label="設定"
        value={tab}
        onChange={(t) => setParams(t === 'shop' ? {} : { tab: t }, { replace: true })}
        items={[
          { value: 'shop', label: '店舗情報' },
          { value: 'booking', label: '予約・通知' },
          { value: 'hours', label: '営業時間' },
          { value: 'holidays', label: '休業日' },
          { value: 'org', label: '法人設定' },
        ]}
      />
      <div className="pt-5">
        <TabPanel idBase="settings" value={tab}>
          {!shopEditable && tab !== 'org' ? (
            <Alert tone="info" className="mb-4">
              閲覧のみ可能です（変更には「店舗の作成・設定」権限が必要です）。
            </Alert>
          ) : null}
          {tab === 'shop' ? (
            <ShopInfoTab key={currentShop.id} shop={currentShop} editable={shopEditable} />
          ) : null}
          {tab === 'booking' ? (
            <BookingTab key={currentShop.id} shop={currentShop} editable={shopEditable} />
          ) : null}
          {tab === 'hours' ? (
            <HoursTab key={currentShop.id} shop={currentShop} editable={can('schedule.manage')} />
          ) : null}
          {tab === 'holidays' ? (
            <HolidaysTab
              key={currentShop.id}
              shop={currentShop}
              editable={can('schedule.manage')}
            />
          ) : null}
          {tab === 'org' ? <OrgTab editable={can('org.manage')} /> : null}
        </TabPanel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shop info

function ShopInfoTab({ shop, editable }: { shop: Shop; editable: boolean }) {
  const toast = useToast();
  const update = useUpdateShop();
  const [f, setF] = useState({
    name: shop.name,
    slug: shop.slug,
    phone: shop.phone ?? '',
    email: shop.email ?? '',
    postalCode: shop.postal_code ?? '',
    prefecture: shop.prefecture ?? '',
    city: shop.city ?? '',
    addressLine: shop.address_line ?? '',
    description: shop.description ?? '',
    publicBookingEnabled: shop.public_booking_enabled,
    status: shop.status,
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const bookingUrl = `${window.location.origin}/book/${shop.slug}`;

  const save = () => {
    setError(null);
    if (!f.name.trim()) return setError('店舗名を入力してください');
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(f.slug) || f.slug.length < 3)
      return setError('店舗IDは英小文字・数字・ハイフン（3文字以上）で入力してください');
    update.mutate(
      {
        id: shop.id,
        input: {
          name: f.name.trim(),
          slug: f.slug,
          phone: f.phone.trim() || null,
          email: f.email.trim() || null,
          postalCode: f.postalCode.trim() || null,
          prefecture: f.prefecture.trim() || null,
          city: f.city.trim() || null,
          addressLine: f.addressLine.trim() || null,
          description: f.description.trim() || null,
          publicBookingEnabled: f.publicBookingEnabled,
          status: f.status,
        },
      },
      {
        onSuccess: () => toast.success('店舗情報を保存しました'),
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
      <Card>
        <CardHeader title="基本情報" />
        {error ? (
          <Alert tone="danger" className="mb-4">
            {error}
          </Alert>
        ) : null}
        <fieldset disabled={!editable} className="grid gap-4 sm:grid-cols-2">
          <Field label="店舗名" required>
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="店舗ID（予約URL）" required hint="変更すると予約URLが変わります">
            <Input value={f.slug} onChange={(e) => set('slug', e.target.value.toLowerCase())} />
          </Field>
          <Field label="電話番号">
            <Input type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="メールアドレス">
            <Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
          </Field>
          <Field label="郵便番号">
            <Input value={f.postalCode} onChange={(e) => set('postalCode', e.target.value)} />
          </Field>
          <Field label="都道府県">
            <Input value={f.prefecture} onChange={(e) => set('prefecture', e.target.value)} />
          </Field>
          <Field label="市区町村">
            <Input value={f.city} onChange={(e) => set('city', e.target.value)} />
          </Field>
          <Field label="番地・建物">
            <Input value={f.addressLine} onChange={(e) => set('addressLine', e.target.value)} />
          </Field>
          <Field label="店舗紹介" className="sm:col-span-2" hint="予約ページに表示されます">
            <Textarea
              value={f.description}
              onChange={(e) => set('description', e.target.value)}
              rows={3}
              maxLength={2000}
            />
          </Field>
          <Field label="営業状態">
            <Select
              value={f.status}
              onChange={(e) => set('status', e.target.value as Shop['status'])}
            >
              <option value="active">営業中</option>
              <option value="inactive">一時休止</option>
              <option value="closed">閉店</option>
            </Select>
          </Field>
        </fieldset>
        {editable ? (
          <div className="mt-5 flex justify-end">
            <Button variant="primary" loading={update.isPending} onClick={save}>
              保存
            </Button>
          </div>
        ) : null}
      </Card>
      <Card className="h-fit">
        <CardHeader
          title="Web・LINE予約"
          description="お客様がアプリ不要で予約できるページです。LINEのリッチメニューにも設定できます。"
        />
        <Switch
          checked={f.publicBookingEnabled}
          onChange={(v) => set('publicBookingEnabled', v)}
          disabled={!editable}
          label="オンライン予約を受け付ける"
          description="オフにすると予約ページが表示されなくなります（保存で反映）。"
        />
        <div className="mt-4 rounded-xl bg-surface-2/60 p-3">
          <p className="text-xs text-muted">予約ページURL</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate text-[13px]">{bookingUrl}</code>
            <IconButton
              icon="copy"
              label="URLをコピー"
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(bookingUrl)
                  .then(() => toast.success('URLをコピーしました'))
              }
            />
            <a
              href={`/book/${shop.slug}`}
              target="_blank"
              rel="noreferrer"
              className="text-primary"
              aria-label="予約ページを開く"
            >
              <Icon name="external" size={18} />
            </a>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ booking & notifications

function NumberField({
  label,
  value,
  onChange,
  unit,
  min,
  max,
  hint,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit: string;
  min: number;
  max: number;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))}
        trailing={unit}
        disabled={disabled}
      />
    </Field>
  );
}

function BookingTab({ shop, editable }: { shop: Shop; editable: boolean }) {
  const toast = useToast();
  const update = useUpdateShop();
  const [s, setS] = useState<ShopSettings>(shop.settings);
  const b = s.booking;
  const r = s.reminders;
  const p = s.pos;
  const rv = s.review;
  const setB = (patch: Partial<ShopSettings['booking']>) =>
    setS((x) => ({ ...x, booking: { ...x.booking, ...patch } }));
  const setR = (patch: Partial<ShopSettings['reminders']>) =>
    setS((x) => ({ ...x, reminders: { ...x.reminders, ...patch } }));
  const setP = (patch: Partial<ShopSettings['pos']>) =>
    setS((x) => ({ ...x, pos: { ...x.pos, ...patch } }));
  const setRv = (patch: Partial<ShopSettings['review']>) =>
    setS((x) => ({ ...x, review: { ...x.review, ...patch } }));
  const dirty = JSON.stringify(s) !== JSON.stringify(shop.settings);
  const d = !editable;

  const save = () =>
    update.mutate(
      {
        id: shop.id,
        input: {
          settings: {
            ...s,
            review: { ...s.review, googleReviewUrl: s.review.googleReviewUrl || undefined },
          },
        },
      },
      {
        onSuccess: () => toast.success('予約・通知設定を保存しました'),
        onError: (e) => toast.error(e),
      },
    );

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="オンライン予約のルール"
            description="Web/LINE予約に適用されます。スタッフによる登録は時間外予約を許可できます。"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="予約枠の間隔">
              <Select
                value={String(b.slotIntervalMin)}
                onChange={(e) => setB({ slotIntervalMin: Number(e.target.value) })}
                disabled={d}
              >
                {[5, 10, 15, 20, 30, 60].map((n) => (
                  <option key={n} value={n}>
                    {n}分ごと
                  </option>
                ))}
              </Select>
            </Field>
            <NumberField
              label="受付締切（開始の何分前まで）"
              value={b.leadTimeMin}
              onChange={(v) => setB({ leadTimeMin: v })}
              unit="分前"
              min={0}
              max={10080}
              disabled={d}
            />
            <NumberField
              label="予約受付期間"
              value={b.horizonDays}
              onChange={(v) => setB({ horizonDays: v })}
              unit="日先まで"
              min={1}
              max={365}
              disabled={d}
            />
            <NumberField
              label="キャンセル・変更期限"
              value={b.cancelDeadlineHours}
              onChange={(v) => setB({ cancelDeadlineHours: v })}
              unit="時間前"
              min={0}
              max={336}
              hint="この時間を過ぎると、お客様はWebで変更できません"
              disabled={d}
            />
            <NumberField
              label="1回の予約で選べるメニュー数"
              value={b.maxServicesPerBooking}
              onChange={(v) => setB({ maxServicesPerBooking: v })}
              unit="件まで"
              min={1}
              max={10}
              disabled={d}
            />
          </div>
          <div className="mt-5 space-y-4">
            <Switch
              checked={b.allowStaffSelection}
              onChange={(v) => setB({ allowStaffSelection: v })}
              label="スタッフ指名を受け付ける"
              description="オフにすると全予約がフリー（指名なし）になります。"
              disabled={d}
            />
            <Switch
              checked={b.autoAssignFree}
              onChange={(v) => setB({ autoAssignFree: v })}
              label="フリー予約を自動で割り当てる"
              description="指名なしの予約を、その日の予約が少ないスタッフに自動で割り当てます。"
              disabled={d}
            />
            <Switch
              checked={b.requireApproval}
              onChange={(v) => setB({ requireApproval: v })}
              label="オンライン予約を仮予約にする（承認制）"
              description="ダッシュボードの「要対応」から承認すると確定します。"
              disabled={d}
            />
          </div>
        </Card>
        <Card>
          <CardHeader
            title="リマインド通知"
            description="LINEまたはSMS/メールで送信されます（メッセージ機能で送信）。"
          />
          <div className="space-y-4">
            <Switch
              checked={r.enabled}
              onChange={(v) => setR({ enabled: v })}
              label="予約通知を送信する"
              disabled={d}
            />
            <Switch
              checked={r.confirmation}
              onChange={(v) => setR({ confirmation: v })}
              label="予約完了時に確認メッセージを送る"
              disabled={d || !r.enabled}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="前日リマインドの送信時刻">
                <Select
                  value={String(r.dayBeforeHour)}
                  onChange={(e) => setR({ dayBeforeHour: Number(e.target.value) })}
                  disabled={d || !r.enabled}
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>
                      {i}:00
                    </option>
                  ))}
                </Select>
              </Field>
              <NumberField
                label="当日リマインド"
                value={r.sameDayHoursBefore}
                onChange={(v) => setR({ sameDayHoursBefore: v })}
                unit="時間前（0=送らない）"
                min={0}
                max={12}
                disabled={d || !r.enabled}
              />
            </div>
          </div>
          <div className="mt-6 border-t border-border pt-5">
            <CardHeader title="口コミ依頼" className="mb-3" />
            <div className="space-y-4">
              <Switch
                checked={rv.autoRequest}
                onChange={(v) => setRv({ autoRequest: v })}
                label="施術後に口コミ依頼を自動送信"
                disabled={d}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  label="送信タイミング"
                  value={rv.requestDelayHours}
                  onChange={(v) => setRv({ requestDelayHours: v })}
                  unit="時間後"
                  min={0}
                  max={72}
                  disabled={d || !rv.autoRequest}
                />
                <Field label="GoogleクチコミURL" optional>
                  <Input
                    type="url"
                    value={rv.googleReviewUrl ?? ''}
                    onChange={(e) => setRv({ googleReviewUrl: e.target.value })}
                    disabled={d}
                    placeholder="https://g.page/r/..."
                  />
                </Field>
              </div>
            </div>
          </div>
        </Card>
      </div>
      <Card>
        <CardHeader title="会計・ポイント" description="会計機能（近日公開）で使用されます。" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField
            label="ポイント還元率"
            value={p.pointRateBp / 100}
            onChange={(v) => setP({ pointRateBp: Math.round(v * 100) })}
            unit="%"
            min={0}
            max={100}
            disabled={d}
          />
          <NumberField
            label="ポイント有効期限"
            value={p.pointExpiryDays}
            onChange={(v) => setP({ pointExpiryDays: v })}
            unit="日"
            min={0}
            max={3650}
            disabled={d}
          />
          <Field label="端数処理">
            <Select
              value={p.roundingMode}
              onChange={(e) =>
                setP({ roundingMode: e.target.value as ShopSettings['pos']['roundingMode'] })
              }
              disabled={d}
            >
              <option value="floor">切り捨て</option>
              <option value="round">四捨五入</option>
              <option value="ceil">切り上げ</option>
            </Select>
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox
              label="レジ開局を必須にする"
              checked={p.requireOpenRegister}
              onChange={(e) => setP({ requireOpenRegister: e.target.checked })}
              disabled={d}
            />
          </div>
          <Field label="レシートのフッター" className="sm:col-span-2 lg:col-span-4">
            <Textarea
              value={p.receiptFooter}
              onChange={(e) => setP({ receiptFooter: e.target.value })}
              rows={2}
              maxLength={500}
              disabled={d}
            />
          </Field>
        </div>
      </Card>
      {editable ? (
        <div className="sticky bottom-4 flex justify-end">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-2 shadow-card">
            {dirty ? (
              <span className="text-[13px] text-warning">未保存の変更があります</span>
            ) : (
              <span className="text-[13px] text-muted">変更はありません</span>
            )}
            <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setS(shop.settings)}>
              元に戻す
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={update.isPending}
              disabled={!dirty}
              onClick={save}
            >
              保存
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ business hours

interface HourRow {
  open: boolean;
  start: string;
  end: string;
  extra: { start: string; end: string }[];
}

function HoursTab({ shop, editable }: { shop: Shop; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const hours = useBusinessHours(shop.id);
  const [rows, setRows] = useState<HourRow[]>([]);
  useEffect(() => {
    if (!hours.data) return;
    setRows(
      [0, 1, 2, 3, 4, 5, 6].map((wd) => {
        const list = hours.data.filter((h) => h.weekday === wd);
        return list.length
          ? {
              open: true,
              start: list[0]!.open_time,
              end: list[0]!.close_time,
              extra: list.slice(1).map((h) => ({ start: h.open_time, end: h.close_time })),
            }
          : { open: false, start: '10:00', end: '20:00', extra: [] };
      }),
    );
  }, [hours.data]);

  const save = useMutation({
    mutationFn: () =>
      schedulesApi.replaceBusinessHours(
        shop.id,
        rows.flatMap((r, wd) =>
          r.open
            ? [
                { weekday: wd, openTime: r.start, closeTime: r.end },
                ...r.extra.map((x) => ({ weekday: wd, openTime: x.start, closeTime: x.end })),
              ]
            : [],
        ),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scheduleKeys.all });
      toast.success('営業時間を保存しました');
    },
    onError: (e) => toast.error(e),
  });

  if (hours.isLoading) return <InlineLoading />;
  if (hours.error) return <ErrorState error={hours.error} />;
  const invalid = rows.some((r) => r.open && r.end <= r.start);
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <Card className="max-w-3xl">
      <CardHeader
        title="営業時間"
        description="曜日ごとの営業時間です。祝日・臨時休業は「休業日」タブで設定します。"
      />
      <ul className="divide-y divide-border rounded-xl border border-border">
        {order.map((wd) => {
          const r = rows[wd];
          if (!r) return null;
          const update = (patch: Partial<HourRow>) =>
            setRows((xs) => xs.map((x, i) => (i === wd ? { ...x, ...patch } : x)));
          return (
            <li key={wd} className="flex flex-wrap items-center gap-4 px-4 py-3">
              <span
                className={cn(
                  'w-6 text-sm font-semibold',
                  wd === 0 ? 'text-danger' : wd === 6 ? 'text-info' : '',
                )}
              >
                {WEEKDAYS_JA[wd]}
              </span>
              <div className="w-36">
                <Switch
                  checked={r.open}
                  onChange={(v) => update({ open: v })}
                  label={r.open ? '営業' : '定休日'}
                  disabled={!editable}
                />
              </div>
              {r.open ? (
                <div className="flex items-center gap-2">
                  <label className="sr-only" htmlFor={`bh-s-${wd}`}>
                    {WEEKDAYS_JA[wd]}曜 開店
                  </label>
                  <Input
                    id={`bh-s-${wd}`}
                    type="time"
                    step={900}
                    inputSize="sm"
                    value={r.start}
                    onChange={(e) => update({ start: e.target.value })}
                    className="w-28"
                    disabled={!editable}
                  />
                  <span className="text-muted">〜</span>
                  <label className="sr-only" htmlFor={`bh-e-${wd}`}>
                    {WEEKDAYS_JA[wd]}曜 閉店
                  </label>
                  <Input
                    id={`bh-e-${wd}`}
                    type="time"
                    step={900}
                    inputSize="sm"
                    value={r.end}
                    onChange={(e) => update({ end: e.target.value })}
                    className="w-28"
                    disabled={!editable}
                  />
                  {r.extra.length ? <Badge size="sm">他{r.extra.length}枠</Badge> : null}
                </div>
              ) : null}
              {r.open && r.end <= r.start ? (
                <span className="text-xs text-danger">終了は開始より後にしてください</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {editable ? (
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={invalid}
            onClick={() => save.mutate()}
          >
            保存
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------ holidays (calendar exceptions)

function HolidaysTab({ shop, editable }: { shop: Shop; editable: boolean }) {
  const { timezone: tz } = useAuth();
  const today = todayIn(tz);
  const [month, setMonth] = useState(startOfMonth(today));
  const monthEnd = `${month.slice(0, 8)}${String(daysInMonth(month)).padStart(2, '0')}`;
  const ex = useExceptions(shop.id, month, monthEnd);
  const hours = useBusinessHours(shop.id);
  const [editing, setEditing] = useState<string | null>(null);
  const byDate = useMemo(() => new Map((ex.data ?? []).map((e) => [e.date, e])), [ex.data]);
  const leading = (weekdayOf(month) + 6) % 7; // Monday-first
  const cells: (string | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from(
      { length: daysInMonth(month) },
      (_, i) => `${month.slice(0, 8)}${String(i + 1).padStart(2, '0')}`,
    ),
  ];
  const regularOpen = (date: string) =>
    (hours.data ?? []).some((h) => h.weekday === weekdayOf(date));

  return (
    <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">
            {Number(month.slice(0, 4))}年{Number(month.slice(5, 7))}月
          </h2>
          <div className="flex gap-1">
            <IconButton
              icon="chevron-left"
              label="前の月"
              variant="secondary"
              size="sm"
              onClick={() => setMonth(addMonths(month, -1))}
            />
            <Button size="sm" variant="secondary" onClick={() => setMonth(startOfMonth(today))}>
              今月
            </Button>
            <IconButton
              icon="chevron-right"
              label="次の月"
              variant="secondary"
              size="sm"
              onClick={() => setMonth(addMonths(month, 1))}
            />
          </div>
        </div>
        <div
          className="grid grid-cols-7 gap-1 text-center text-xs"
          role="grid"
          aria-label="休業日カレンダー"
        >
          {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
            <div
              key={wd}
              role="columnheader"
              className={cn(
                'py-1 font-medium',
                wd === 0 ? 'text-danger' : wd === 6 ? 'text-info' : 'text-muted',
              )}
            >
              {WEEKDAYS_JA[wd]}
            </div>
          ))}
          {cells.map((d, i) => {
            if (!d) return <div key={`e-${i}`} />;
            const e = byDate.get(d);
            const closed = e ? e.is_closed : !regularOpen(d);
            return (
              <button
                key={d}
                type="button"
                role="gridcell"
                disabled={!editable}
                onClick={() => setEditing(d)}
                aria-label={`${formatDateJa(d)} ${e ? (e.is_closed ? '臨時休業' : `特別営業 ${e.open_time}-${e.close_time}`) : closed ? '定休日' : '営業日'}`}
                className={cn(
                  'flex h-16 flex-col items-center justify-start gap-0.5 rounded-lg border p-1 text-[13px] transition-colors disabled:cursor-default',
                  d === today ? 'border-primary' : 'border-border',
                  e?.is_closed
                    ? 'bg-danger-soft text-danger'
                    : e
                      ? 'bg-info-soft text-info'
                      : closed
                        ? 'bg-closed text-subtle'
                        : 'bg-surface hover:bg-surface-2',
                )}
              >
                <span className="font-semibold tabular">{Number(d.slice(8))}</span>
                <span className="text-[10px] leading-tight">
                  {e
                    ? e.is_closed
                      ? '臨時休業'
                      : `${e.open_time}-${e.close_time}`
                    : closed
                      ? '定休'
                      : ''}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted">
          日付をクリックすると、臨時休業・特別営業時間を設定できます。
        </p>
      </Card>
      <Card className="h-fit">
        <CardHeader title="この月の設定" />
        {ex.isLoading ? <InlineLoading /> : null}
        {ex.data && !ex.data.length ? (
          <p className="text-[13px] text-muted">臨時休業・特別営業はありません。</p>
        ) : null}
        <ul className="divide-y divide-border">
          {(ex.data ?? []).map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 py-2.5 text-[13px]">
              <span>
                <span className="font-medium">{formatDateJa(e.date)}</span>
                <span className="ml-2 text-muted">
                  {e.is_closed ? '臨時休業' : `特別営業 ${e.open_time}〜${e.close_time}`}
                </span>
                {e.note ? <span className="block text-xs text-subtle">{e.note}</span> : null}
              </span>
              {editable ? (
                <Button size="xs" variant="ghost" onClick={() => setEditing(e.date)}>
                  編集
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      {editing ? (
        <ExceptionDialog
          shopId={shop.id}
          date={editing}
          existing={byDate.get(editing) ?? null}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function ExceptionDialog({
  shopId,
  date,
  existing,
  onClose,
}: {
  shopId: string;
  date: string;
  existing: CalendarException | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<'closed' | 'special'>(
    existing && !existing.is_closed ? 'special' : 'closed',
  );
  const [open, setOpen] = useState(existing?.open_time ?? '10:00');
  const [close, setClose] = useState(existing?.close_time ?? '18:00');
  const [note, setNote] = useState(existing?.note ?? '');
  const [saving, setSaving] = useState(false);
  const done = (msg: string) => {
    void qc.invalidateQueries({ queryKey: scheduleKeys.all });
    toast.success(msg);
    onClose();
  };
  const save = async () => {
    setSaving(true);
    try {
      await schedulesApi.upsertException(
        shopId,
        date,
        kind === 'closed'
          ? { isClosed: true, note: note || null }
          : { isClosed: false, openTime: open, closeTime: close, note: note || null },
      );
      done('休業日を保存しました');
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    setSaving(true);
    try {
      await schedulesApi.deleteException(shopId, date);
      done('通常の営業時間に戻しました');
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={formatDateJa(date, { year: true })}
      footer={
        <>
          {existing ? (
            <Button variant="ghost" className="mr-auto" onClick={remove} disabled={saving}>
              通常営業に戻す
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={kind === 'special' && close <= open}
            onClick={save}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          label="種類"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'closed', label: '臨時休業' },
            { value: 'special', label: '特別営業時間' },
          ]}
        />
        {kind === 'special' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="開店">
              <Input
                type="time"
                step={900}
                value={open}
                onChange={(e) => setOpen(e.target.value)}
              />
            </Field>
            <Field
              label="閉店"
              error={close <= open ? '閉店は開店より後にしてください' : undefined}
            >
              <Input
                type="time"
                step={900}
                value={close}
                onChange={(e) => setClose(e.target.value)}
              />
            </Field>
          </div>
        ) : null}
        <Field label="メモ" optional>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="年末年始、研修など"
            maxLength={200}
          />
        </Field>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ organization

const TIMEZONES = [
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Taipei',
  'Asia/Singapore',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'UTC',
];

function OrgTab({ editable }: { editable: boolean }) {
  const org = useOrganization();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<{ name: string; timezone: string; invoice: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (org.data && !f)
      setF({
        name: org.data.name,
        timezone: org.data.timezone,
        invoice: org.data.invoice_registration_number ?? '',
      });
  }, [org.data, f]);
  const save = useMutation({
    mutationFn: () =>
      orgApi.updateOrganization({
        name: f!.name.trim(),
        timezone: f!.timezone,
        invoiceRegistrationNumber: f!.invoice.trim() || null,
      }),
    onSuccess: (o) => {
      qc.setQueryData(orgKeys.org, o);
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('法人設定を保存しました');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  if (org.isLoading || !f) return <InlineLoading />;
  if (org.error) return <ErrorState error={org.error} />;
  const invoiceInvalid = !!f.invoice && !/^T\d{13}$/.test(f.invoice);
  return (
    <Card className="max-w-2xl">
      <CardHeader
        title="法人設定"
        description={`プラン: ${org.data?.plan ?? ''} ・ 法人ID: ${org.data?.slug ?? ''}`}
      />
      {!editable ? (
        <Alert tone="info" className="mb-4">
          閲覧のみ可能です（変更には「法人設定の管理」権限が必要です）。
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <fieldset disabled={!editable} className="space-y-4">
        <Field label="法人名・屋号" required>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="タイムゾーン" hint="新しく作成する店舗の既定値です">
          <Select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
            {[...new Set([f.timezone, ...TIMEZONES])].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="適格請求書発行事業者 登録番号"
          hint="T + 13桁の数字（インボイス制度）"
          error={invoiceInvalid ? 'T + 13桁の数字で入力してください' : undefined}
        >
          <Input
            value={f.invoice}
            onChange={(e) =>
              setF({ ...f, invoice: e.target.value.toUpperCase().replace(/[^T0-9]/g, '') })
            }
            placeholder="T1234567890123"
            maxLength={14}
          />
        </Field>
      </fieldset>
      {editable ? (
        <div className="mt-5 flex justify-end">
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={invoiceInvalid || !f.name.trim()}
            onClick={() => save.mutate()}
          >
            保存
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
