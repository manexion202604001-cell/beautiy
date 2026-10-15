import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useShop, useStaffList, useUpdateShop } from '../../api/org';
import { scheduleKeys, schedulesApi, useBusinessHours, useExceptions } from '../../api/schedules';
import { staffScreenApi, staffScreenKeys } from '../../api/staffScreen';
import type { BusinessHour, ShopSettings, Staff } from '../../api/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Separator,
  Tabs,
} from '../../components/shad';
import { Switch } from '../../components/shad/switch';
import { useToast } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cx } from '../../lib/cn';
import { addDays, todayIn } from '../../lib/time';
import { StaffSettingsDialog } from './staff/StaffSettingsDialog';

const DAYS = ['日', '月', '火', '水', '木', '金', '土'];
type Tab = 'hours' | 'capacity' | 'settings' | 'staff';

interface DayRow {
  weekday: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
}

/** One row per weekday out of the stored ranges (earliest opening – latest closing) */
function toDayRows(hours: BusinessHour[]): DayRow[] {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
    const rows = hours.filter((h) => h.weekday === weekday);
    return {
      weekday,
      openTime: rows.length ? rows.map((r) => r.open_time).sort()[0]! : '10:00',
      closeTime: rows.length
        ? rows
            .map((r) => r.close_time)
            .sort()
            .at(-1)!
        : '19:00',
      isClosed: rows.length === 0,
    };
  });
}

const dayColor = (weekday: number) =>
  weekday === 0 ? 'text-red-500' : weekday === 6 ? 'text-blue-500' : '';

/** '' → null (no number), otherwise the number clamped to 1–20 */
function parseCapacity(value: string): number | null {
  const n = parseInt(value);
  return Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : null;
}

interface RuleForm {
  /** 'days' = the shop still uses the older 「N日先まで」 setting */
  advance: string;
  cutoffType: 'same_day' | 'days_before';
  sameDayMinutes: number;
  daysBefore: number;
  cutoffTime: string;
  calcMethod: 'calendar' | 'business_days';
  defaultCapacity: number | null;
  acceptSameStartTime: boolean;
  acceptOutsideHours: boolean;
}

function toRuleForm(s: ShopSettings): RuleForm {
  return {
    advance: s.booking.advanceMonths === null ? 'days' : String(s.booking.advanceMonths),
    cutoffType: s.booking.cutoffType,
    sameDayMinutes: s.booking.leadTimeMin,
    daysBefore: s.booking.cutoffDaysBefore,
    cutoffTime: s.booking.cutoffTime,
    calcMethod: s.booking.calcMethod,
    defaultCapacity: s.capacity.default,
    acceptSameStartTime: s.booking.acceptSameStartTime,
    acceptOutsideHours: s.booking.acceptOutsideHours,
  };
}

/** 予約受付設定: 営業時間・定休日 / 受付可能数 / 予約設定 / スタッフ別設定 */
export default function ReservationSettings() {
  const toast = useToast();
  const qc = useQueryClient();
  const { currentShopId, timezone: tz } = useAuth();
  const shopId = currentShopId ?? '';
  const today = todayIn(tz);

  const shopQ = useShop(currentShopId);
  const hoursQ = useBusinessHours(currentShopId);
  const closuresQ = useExceptions(currentShopId, today, addDays(today, 730));
  const updateShop = useUpdateShop();
  const shop = shopQ.data;

  const [tab, setTab] = useState<Tab>('hours');
  const [days, setDays] = useState<DayRow[]>(toDayRows([]));
  const [holiday, setHoliday] = useState({
    enabled: false,
    isClosed: false,
    openTime: '10:00',
    closeTime: '19:00',
  });
  const [capacity, setCapacity] = useState<{ weekdays: (number | null)[]; holiday: number | null }>(
    {
      weekdays: [null, null, null, null, null, null, null],
      holiday: null,
    },
  );
  const [rules, setRules] = useState<RuleForm | null>(null);
  const [savingHours, setSavingHours] = useState(false);
  const [savingCapacity, setSavingCapacity] = useState(false);
  const [savingRules, setSavingRules] = useState(false);

  useEffect(() => {
    if (hoursQ.data) setDays(toDayRows(hoursQ.data));
  }, [hoursQ.data]);
  // settings are loaded into the forms once per shop; saving refreshes them from the response
  const loadedFor = shop?.id;
  useEffect(() => {
    if (!shop) return;
    applySettings(shop.settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedFor]);

  function applySettings(s: ShopSettings) {
    setHoliday({
      enabled: s.hours.holidayEnabled,
      isClosed: s.hours.holidayClosed,
      openTime: s.hours.holidayOpenTime,
      closeTime: s.hours.holidayCloseTime,
    });
    setCapacity({ weekdays: [...s.capacity.weekdays], holiday: s.capacity.holiday });
    setRules(toRuleForm(s));
  }

  const updateDay = (weekday: number, patch: Partial<DayRow>) =>
    setDays((prev) => prev.map((d) => (d.weekday === weekday ? { ...d, ...patch } : d)));

  // ---------------------------------------------------------------- 営業時間・定休日
  const saveHours = async () => {
    if (!shop) return;
    setSavingHours(true);
    try {
      const saved = await schedulesApi.replaceBusinessHours(
        shop.id,
        days
          .filter((d) => !d.isClosed)
          .map((d) => ({ weekday: d.weekday, openTime: d.openTime, closeTime: d.closeTime })),
      );
      setDays(toDayRows(saved));
      if (holiday.enabled) {
        if (!holiday.isClosed && holiday.closeTime <= holiday.openTime) {
          throw new Error('祝日の終了時刻は開始時刻より後にしてください');
        }
        await updateShop.mutateAsync({
          id: shop.id,
          input: {
            settings: {
              hours: {
                holidayClosed: holiday.isClosed,
                holidayOpenTime: holiday.openTime,
                holidayCloseTime: holiday.closeTime,
              },
            },
          },
        });
      }
      void qc.invalidateQueries({ queryKey: scheduleKeys.all });
      toast.success('営業時間を保存しました');
    } catch (e) {
      toast.error('営業時間の保存に失敗しました', errorMessage(e));
    } finally {
      setSavingHours(false);
    }
  };

  const toggleHolidayHours = async (enabled: boolean) => {
    if (!shop) return;
    setHoliday((h) => ({ ...h, enabled }));
    try {
      await updateShop.mutateAsync({
        id: shop.id,
        input: { settings: { hours: { holidayEnabled: enabled } } },
      });
      void qc.invalidateQueries({ queryKey: scheduleKeys.all });
    } catch (e) {
      setHoliday((h) => ({ ...h, enabled: !enabled }));
      toast.error('祝日の営業時間の設定に失敗しました', errorMessage(e));
    }
  };

  // ---------------------------------------------------------------- 臨時休業日
  const [closureDate, setClosureDate] = useState('');
  const [closureReason, setClosureReason] = useState('');
  const [addingClosure, setAddingClosure] = useState(false);
  const closures = (closuresQ.data ?? []).filter((c) => c.is_closed);

  const addClosure = async () => {
    if (!shop || !closureDate) return;
    setAddingClosure(true);
    try {
      await schedulesApi.upsertException(shop.id, closureDate, {
        isClosed: true,
        note: closureReason.trim() || null,
      });
      setClosureDate('');
      setClosureReason('');
      await qc.invalidateQueries({ queryKey: scheduleKeys.all });
    } catch (e) {
      toast.error('臨時休業日の追加に失敗しました', errorMessage(e));
    } finally {
      setAddingClosure(false);
    }
  };

  const deleteClosure = async (date: string) => {
    if (!shop) return;
    try {
      await schedulesApi.deleteException(shop.id, date);
      await qc.invalidateQueries({ queryKey: scheduleKeys.all });
    } catch (e) {
      toast.error('削除に失敗しました', errorMessage(e));
    }
  };

  // ---------------------------------------------------------------- 受付可能数
  const saveCapacity = async () => {
    if (!shop) return;
    setSavingCapacity(true);
    try {
      const saved = await updateShop.mutateAsync({
        id: shop.id,
        input: {
          settings: { capacity: { weekdays: capacity.weekdays, holiday: capacity.holiday } },
        },
      });
      setCapacity({
        weekdays: [...saved.settings.capacity.weekdays],
        holiday: saved.settings.capacity.holiday,
      });
      toast.success('受付可能数を保存しました');
    } catch (e) {
      toast.error('受付可能数の保存に失敗しました', errorMessage(e));
    } finally {
      setSavingCapacity(false);
    }
  };

  // ---------------------------------------------------------------- 予約設定
  const saveRules = async () => {
    if (!shop || !rules) return;
    setSavingRules(true);
    try {
      const saved = await updateShop.mutateAsync({
        id: shop.id,
        input: {
          settings: {
            booking: {
              ...(rules.advance === 'days' ? {} : { advanceMonths: parseInt(rules.advance) }),
              cutoffType: rules.cutoffType,
              ...(rules.cutoffType === 'same_day' ? { leadTimeMin: rules.sameDayMinutes } : {}),
              cutoffDaysBefore: rules.daysBefore,
              cutoffTime: rules.cutoffTime,
              calcMethod: rules.calcMethod,
              acceptSameStartTime: rules.acceptSameStartTime,
              acceptOutsideHours: rules.acceptOutsideHours,
            },
            capacity: { default: rules.defaultCapacity },
          },
        },
      });
      setRules(toRuleForm(saved.settings));
      toast.success('予約設定を保存しました');
    } catch (e) {
      toast.error('予約設定の保存に失敗しました', errorMessage(e));
    } finally {
      setSavingRules(false);
    }
  };

  // ---------------------------------------------------------------- スタッフ別設定
  const staffQ = useStaffList({ shopId: shopId || undefined }, tab === 'staff' && !!shopId);
  const overviewQ = useQuery({
    queryKey: staffScreenKeys.overview(shopId),
    queryFn: () => staffScreenApi.settingsOverview(shopId),
    enabled: tab === 'staff' && !!shopId,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsStaff, setSettingsStaff] = useState<Staff | null>(null);

  if (shopQ.isLoading || hoursQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }
  if (!shop || !rules) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">店舗情報が見つかりません</div>
      </div>
    );
  }

  const horizonDays = shop.settings.booking.horizonDays;
  const advanceOptions = [
    ...(rules.advance === 'days'
      ? [{ value: 'days', label: `${horizonDays}日先まで（現在の設定）` }]
      : []),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => ({
      value: String(n),
      label: `${n}ヶ月先まで`,
    })),
  ];
  const sameDayOptions = [
    { value: '0', label: '直前まで' },
    { value: '30', label: '30分前まで' },
    { value: '60', label: '1時間前まで' },
    { value: '120', label: '2時間前まで' },
    { value: '180', label: '3時間前まで' },
  ];
  if (!sameDayOptions.some((o) => o.value === String(rules.sameDayMinutes))) {
    sameDayOptions.push({
      value: String(rules.sameDayMinutes),
      label: `${rules.sameDayMinutes}分前まで`,
    });
  }
  const daysBeforeOptions = [1, 2, 3, 5, 7].map((n) => ({ value: String(n), label: `${n}日前` }));
  if (!daysBeforeOptions.some((o) => o.value === String(rules.daysBefore))) {
    daysBeforeOptions.push({ value: String(rules.daysBefore), label: `${rules.daysBefore}日前` });
  }
  const cutoffTimeOptions = ['24:00', '21:00', '18:00', '15:00', '12:00', '09:00'].map((t) => ({
    value: t,
    label: `${Number(t.slice(0, 2))}時まで`,
  }));
  if (!cutoffTimeOptions.some((o) => o.value === rules.cutoffTime)) {
    cutoffTimeOptions.push({ value: rules.cutoffTime, label: `${rules.cutoffTime}まで` });
  }

  const capacityRows = [
    ...days.map((d) => ({
      key: String(d.weekday),
      label: DAYS[d.weekday]!,
      color: dayColor(d.weekday),
      isClosed: d.isClosed,
      value: capacity.weekdays[d.weekday] ?? null,
      holiday: false,
      weekday: d.weekday,
    })),
    ...(holiday.enabled
      ? [
          {
            key: 'holiday',
            label: '祝',
            color: 'text-red-500',
            isClosed: holiday.isClosed,
            value: capacity.holiday,
            holiday: true,
            weekday: 7,
          },
        ]
      : []),
  ];

  return (
    <>
      <div className="sy-6">
        <h1 className="text-2xl font-bold">予約受付設定</h1>

        <div>
          <Tabs<Tab>
            label="予約受付設定"
            value={tab}
            onValueChange={setTab}
            listClassName="flex h-auto w-full flex-wrap gap-1"
            items={[
              { value: 'hours', label: '営業時間・定休日' },
              { value: 'capacity', label: '受付可能数' },
              { value: 'settings', label: '予約設定' },
              { value: 'staff', label: 'スタッフ別設定' },
            ]}
          />

          {tab === 'hours' ? (
            <div role="tabpanel" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle>営業時間・定休日</CardTitle>
                  <CardDescription>
                    曜日ごとの営業時間と定休日を設定します。スタッフの個別設定がない場合、この設定が適用されます。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="sy-4">
                    {days.map((d) => (
                      <div
                        key={d.weekday}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1"
                        data-weekday={d.weekday}
                      >
                        <div className={cx('w-8 shrink-0 font-medium', dayColor(d.weekday))}>
                          {DAYS[d.weekday]}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="time"
                            aria-label={`${DAYS[d.weekday]}曜 開店`}
                            value={d.openTime}
                            disabled={d.isClosed}
                            className="w-[7rem]"
                            onChange={(e) => updateDay(d.weekday, { openTime: e.target.value })}
                          />
                          <span className="text-muted-foreground">〜</span>
                          <Input
                            type="time"
                            aria-label={`${DAYS[d.weekday]}曜 閉店`}
                            value={d.closeTime}
                            disabled={d.isClosed}
                            className="w-[7rem]"
                            onChange={(e) => updateDay(d.weekday, { closeTime: e.target.value })}
                          />
                        </div>
                        <label className="flex shrink-0 items-center gap-1.5">
                          <input
                            type="checkbox"
                            aria-label={`${DAYS[d.weekday]}曜 休`}
                            checked={d.isClosed}
                            onChange={(e) => updateDay(d.weekday, { isClosed: e.target.checked })}
                          />
                          <span className="text-sm">休</span>
                        </label>
                      </div>
                    ))}
                    {holiday.enabled ? (
                      <div
                        className="flex flex-wrap items-center gap-x-3 gap-y-1"
                        data-weekday="holiday"
                      >
                        <div className="w-8 shrink-0 font-medium text-red-500">祝</div>
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="time"
                            aria-label="祝日 開店"
                            value={holiday.openTime}
                            disabled={holiday.isClosed}
                            className="w-[7rem]"
                            onChange={(e) =>
                              setHoliday((h) => ({ ...h, openTime: e.target.value }))
                            }
                          />
                          <span className="text-muted-foreground">〜</span>
                          <Input
                            type="time"
                            aria-label="祝日 閉店"
                            value={holiday.closeTime}
                            disabled={holiday.isClosed}
                            className="w-[7rem]"
                            onChange={(e) =>
                              setHoliday((h) => ({ ...h, closeTime: e.target.value }))
                            }
                          />
                        </div>
                        <label className="flex shrink-0 items-center gap-1.5">
                          <input
                            type="checkbox"
                            aria-label="祝日 休"
                            checked={holiday.isClosed}
                            onChange={(e) =>
                              setHoliday((h) => ({ ...h, isClosed: e.target.checked }))
                            }
                          />
                          <span className="text-sm">休</span>
                        </label>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-4">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={holiday.enabled}
                        onChange={(e) => void toggleHolidayHours(e.target.checked)}
                      />
                      <span className="text-sm font-medium">祝日の営業時間を個別に設定する</span>
                    </label>
                    <p className="ml-5 mt-1 text-xs text-muted-foreground">
                      有効にすると、祝日は通常の曜日設定ではなく祝日の営業時間が適用されます
                    </p>
                  </div>
                  <Separator className="my-6" />
                  <Button onClick={() => void saveHours()} disabled={savingHours}>
                    {savingHours ? '保存中...' : '保存'}
                  </Button>
                </CardContent>
              </Card>

              <Card className="mt-6">
                <CardHeader>
                  <CardTitle>臨時休業日</CardTitle>
                  <CardDescription>
                    定休日以外の臨時休業日（年末年始、内装工事など）を設定します。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="mb-4 flex flex-wrap gap-2">
                    <Input
                      type="date"
                      aria-label="臨時休業日"
                      value={closureDate}
                      onChange={(e) => setClosureDate(e.target.value)}
                      min={today}
                      className="w-44"
                    />
                    <Input
                      type="text"
                      aria-label="理由"
                      placeholder="理由（任意）"
                      value={closureReason}
                      onChange={(e) => setClosureReason(e.target.value)}
                      className="w-48"
                    />
                    <Button
                      onClick={() => void addClosure()}
                      disabled={!closureDate || addingClosure}
                    >
                      {addingClosure ? '追加中...' : '追加'}
                    </Button>
                  </div>
                  {closures.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      登録されている臨時休業日はありません
                    </p>
                  ) : (
                    <div className="sy-2" data-testid="closures">
                      {closures.map((c) => (
                        <div
                          key={c.id}
                          className="flex items-center justify-between rounded-lg border p-3"
                        >
                          <div>
                            <p className="font-medium">
                              {new Date(`${c.date}T00:00:00`).toLocaleDateString('ja-JP', {
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                                weekday: 'short',
                              })}
                            </p>
                            {c.note ? (
                              <p className="text-sm text-muted-foreground">{c.note}</p>
                            ) : null}
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`${c.date} を削除`}
                            onClick={() => void deleteClosure(c.date)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}

          {tab === 'capacity' ? (
            <div role="tabpanel" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle>受付可能数設定</CardTitle>
                  <CardDescription>
                    曜日ごとの同時受付可能人数を設定します。未設定の場合は予約設定のデフォルト値が適用されます。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="sy-4">
                    {capacityRows.map((row) => (
                      <div key={row.key} className="flex items-center gap-4" data-weekday={row.key}>
                        <div className={cx('w-12 font-medium', row.color)}>{row.label}</div>
                        {row.isClosed ? (
                          <span className="text-sm text-muted-foreground">定休日</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              aria-label={`${row.label} 受付可能数`}
                              min={1}
                              max={20}
                              value={row.value ?? rules.defaultCapacity ?? ''}
                              placeholder="制限なし"
                              onChange={(e) => {
                                const n = parseCapacity(e.target.value);
                                setCapacity((c) =>
                                  row.holiday
                                    ? { ...c, holiday: n }
                                    : {
                                        ...c,
                                        weekdays: c.weekdays.map((v, i) =>
                                          i === row.weekday ? n : v,
                                        ),
                                      },
                                );
                              }}
                              className="w-20"
                            />
                            <span className="text-sm text-muted-foreground">人</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <Separator className="my-6" />
                  <Button onClick={() => void saveCapacity()} disabled={savingCapacity}>
                    {savingCapacity ? '保存中...' : '保存'}
                  </Button>
                </CardContent>
              </Card>
            </div>
          ) : null}

          {tab === 'settings' ? (
            <div role="tabpanel" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle>予約設定</CardTitle>
                  <CardDescription>
                    サロン全体の予約ルールを設定します。スタッフの個別設定がない場合、この設定が適用されます。
                  </CardDescription>
                </CardHeader>
                <CardContent className="sy-6">
                  <div className="sy-2">
                    <Label>受付開始</Label>
                    <p className="text-sm text-muted-foreground">
                      何ヶ月先まで予約を受け付けるか（当月＋Nヶ月の末日まで）
                    </p>
                    <div className="flex items-center gap-2">
                      <Select
                        label="受付開始"
                        className="w-48"
                        value={rules.advance}
                        onValueChange={(advance) => setRules({ ...rules, advance })}
                        options={advanceOptions}
                      />
                    </div>
                  </div>
                  <Separator />
                  <div className="sy-4">
                    <div>
                      <Label>受付締切</Label>
                      <p className="text-sm text-muted-foreground">
                        予約の受付をいつまで可能にするか
                      </p>
                    </div>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="radio"
                        name="booking-cutoff"
                        className="mt-1"
                        checked={rules.cutoffType === 'same_day'}
                        onChange={() => setRules({ ...rules, cutoffType: 'same_day' })}
                      />
                      <div className="sy-2">
                        <span className="text-sm font-medium">当日まで受付をする</span>
                        {rules.cutoffType === 'same_day' ? (
                          <Select
                            label="当日の受付締切"
                            className="w-40"
                            value={String(rules.sameDayMinutes)}
                            onValueChange={(v) =>
                              setRules({ ...rules, sameDayMinutes: parseInt(v) })
                            }
                            options={sameDayOptions}
                          />
                        ) : null}
                      </div>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="radio"
                        name="booking-cutoff"
                        className="mt-1"
                        checked={rules.cutoffType === 'days_before'}
                        onChange={() => setRules({ ...rules, cutoffType: 'days_before' })}
                      />
                      <div className="sy-2">
                        <span className="text-sm font-medium">前日以前に締め切る</span>
                        {rules.cutoffType === 'days_before' ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Select
                              label="締切日"
                              className="w-28"
                              value={String(rules.daysBefore)}
                              onValueChange={(v) => setRules({ ...rules, daysBefore: parseInt(v) })}
                              options={daysBeforeOptions}
                            />
                            <span className="text-sm text-muted-foreground">の</span>
                            <Select
                              label="締切時刻"
                              className="w-28"
                              value={rules.cutoffTime}
                              onValueChange={(cutoffTime) => setRules({ ...rules, cutoffTime })}
                              options={cutoffTimeOptions}
                            />
                          </div>
                        ) : null}
                      </div>
                    </label>
                  </div>
                  <Separator />
                  <div className="sy-2">
                    <Label>受付期間の計算方法</Label>
                    <p className="text-sm text-muted-foreground">
                      受付開始・受付締切の日数カウント方法
                    </p>
                    <Select
                      label="受付期間の計算方法"
                      className="w-56"
                      value={rules.calcMethod}
                      onValueChange={(v) =>
                        setRules({ ...rules, calcMethod: v as RuleForm['calcMethod'] })
                      }
                      options={[
                        { value: 'calendar', label: '日数で計算' },
                        { value: 'business_days', label: '営業日で計算（休業日を除く）' },
                      ]}
                    />
                    {rules.calcMethod === 'business_days' ? (
                      <p className="text-xs text-muted-foreground">
                        定休日と臨時休業日を除いた営業日数でカウントします
                      </p>
                    ) : null}
                  </div>
                  <Separator />
                  <div className="sy-2">
                    <Label htmlFor="default-capacity">デフォルト受付可能数</Label>
                    <p className="text-sm text-muted-foreground">
                      曜日別の受付可能数が未設定の場合に適用されるデフォルト値
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        id="default-capacity"
                        type="number"
                        min={1}
                        max={20}
                        value={rules.defaultCapacity ?? ''}
                        placeholder="制限なし"
                        onChange={(e) =>
                          setRules({ ...rules, defaultCapacity: parseCapacity(e.target.value) })
                        }
                        className="w-24"
                      />
                      <span className="text-sm text-muted-foreground">人</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <Label id="same-start-label">開始時刻が同じ予約を受付する</Label>
                      <p className="text-sm text-muted-foreground">
                        同じ時間帯に複数の予約を受け付けます
                      </p>
                    </div>
                    <Switch
                      aria-labelledby="same-start-label"
                      checked={rules.acceptSameStartTime}
                      onCheckedChange={(v) => setRules({ ...rules, acceptSameStartTime: v })}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <Label id="outside-hours-label">営業時間外の予約を受付する</Label>
                      <p className="text-sm text-muted-foreground">
                        営業時間外でも予約を受け付けます
                      </p>
                    </div>
                    <Switch
                      aria-labelledby="outside-hours-label"
                      checked={rules.acceptOutsideHours}
                      onCheckedChange={(v) => setRules({ ...rules, acceptOutsideHours: v })}
                    />
                  </div>
                  <Separator />
                  <Button onClick={() => void saveRules()} disabled={savingRules}>
                    {savingRules ? '保存中...' : '保存'}
                  </Button>
                </CardContent>
              </Card>
            </div>
          ) : null}

          {tab === 'staff' ? (
            <div role="tabpanel" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle>スタッフ別設定</CardTitle>
                  <CardDescription>
                    スタッフごとの個別設定を管理します。未設定の場合はサロンの設定が適用されます。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {staffQ.isLoading || overviewQ.isLoading ? (
                    <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
                  ) : (staffQ.data ?? []).length === 0 ? (
                    <div className="py-8 text-center text-muted-foreground">
                      スタッフが登録されていません
                    </div>
                  ) : (
                    <div className="sy-2" data-testid="staff-settings-list">
                      {(staffQ.data ?? []).map((s) => {
                        const ownHours = overviewQ.data?.hours.includes(s.id) ?? false;
                        const ownRules = overviewQ.data?.reservation.includes(s.id) ?? false;
                        return (
                          <div
                            key={s.id}
                            role="button"
                            tabIndex={0}
                            className="flex cursor-pointer items-center justify-between rounded-lg border p-3 hover:bg-accent"
                            onClick={() => {
                              setSettingsStaff(s);
                              setSettingsOpen(true);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setSettingsStaff(s);
                                setSettingsOpen(true);
                              }
                            }}
                          >
                            <div>
                              <p className="font-medium">{s.display_name}</p>
                              <div className="mt-1 flex gap-3">
                                <span
                                  className={cx(
                                    'text-xs',
                                    ownHours ? 'text-primary' : 'text-muted-foreground',
                                  )}
                                >
                                  営業時間: {ownHours ? '個別設定あり' : 'サロン設定'}
                                </span>
                                <span
                                  className={cx(
                                    'text-xs',
                                    ownRules ? 'text-primary' : 'text-muted-foreground',
                                  )}
                                >
                                  予約設定: {ownRules ? '個別設定あり' : 'サロン設定'}
                                </span>
                              </div>
                            </div>
                            <span className="text-sm text-muted-foreground">編集 →</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}
        </div>
      </div>

      {/* outside the spaced column: its sibling margin would push the fixed panel down */}
      <StaffSettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) void qc.invalidateQueries({ queryKey: staffScreenKeys.overview(shopId) });
        }}
        staffMember={
          settingsStaff ? { id: settingsStaff.id, name: settingsStaff.display_name } : null
        }
        shopId={shopId}
      />
    </>
  );
}
