import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { scheduleKeys } from '../../../api/schedules';
import {
  staffScreenApi,
  staffScreenKeys,
  type StaffDayHours,
  type StaffReservationSettings,
} from '../../../api/staffScreen';
import {
  Button,
  Checkbox,
  Dialog,
  DialogTitle,
  Input,
  Label,
  Tabs,
} from '../../../components/shad';
import { Switch } from '../../../components/shad/switch';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { cx } from '../../../lib/cn';

const DAYS = ['日', '月', '火', '水', '木', '金', '土'];

const DEFAULT_HOURS: StaffDayHours[] = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  openTime: '09:00',
  closeTime: '19:00',
  isClosed: weekday === 0,
}));

const DEFAULT_RESERVATION: StaffReservationSettings = {
  advanceBookingDays: 365,
  sameDayCutoffHours: 1,
  maxConcurrent: 1,
  acceptSameStartTime: false,
  acceptOutsideHours: false,
};

type Tab = 'hours' | 'reservation';

/**
 * 「{スタッフ名} - 設定」: the staff member's own 営業時間 and 予約設定 at the shop. Opened from the
 * スタッフ screen (gear button) and from 予約受付設定 › スタッフ別設定.
 */
export function StaffSettingsDialog({
  open,
  onOpenChange,
  staffMember,
  shopId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staffMember: { id: string; name: string } | null;
  shopId: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('hours');
  const [hours, setHours] = useState<StaffDayHours[]>(DEFAULT_HOURS);
  const [settings, setSettings] = useState<StaffReservationSettings>(DEFAULT_RESERVATION);
  const [loading, setLoading] = useState(false);
  const [savingHours, setSavingHours] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [copying, setCopying] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [hasHours, setHasHours] = useState(false);
  const [hasSettings, setHasSettings] = useState(false);

  const staffId = staffMember?.id;
  useEffect(() => {
    if (!open || !staffId || !shopId) return;
    let cancelled = false;
    setLoading(true);
    setTab('hours');
    Promise.all([
      staffScreenApi.businessHours(staffId, shopId),
      staffScreenApi.reservationSettings(staffId, shopId),
    ])
      .then(([h, r]) => {
        if (cancelled) return;
        setHasHours(h.configured);
        setHours(h.hours);
        setHasSettings(r.individual);
        setSettings(r.settings);
      })
      .catch((e: unknown) => {
        if (!cancelled) toast.error('スタッフ設定の読み込みに失敗しました', errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, staffId, shopId]);

  const refreshLists = () => {
    void qc.invalidateQueries({ queryKey: staffScreenKeys.overview(shopId) });
    void qc.invalidateQueries({ queryKey: scheduleKeys.all });
  };

  const copyShopHours = async () => {
    if (!staffId) return;
    setCopying(true);
    try {
      const res = await staffScreenApi.copyShopHours(staffId, shopId);
      setHours(res.hours);
      setHasHours(res.configured);
      refreshLists();
    } catch (e) {
      toast.error('サロンの営業時間を反映できませんでした', errorMessage(e));
    } finally {
      setCopying(false);
    }
  };

  const saveHours = async () => {
    if (!staffId) return;
    setSavingHours(true);
    try {
      const res = await staffScreenApi.saveBusinessHours(staffId, shopId, hours);
      setHours(res.hours);
      setHasHours(res.configured);
      refreshLists();
      toast.success('営業時間を保存しました');
    } catch (e) {
      toast.error('営業時間の保存に失敗しました', errorMessage(e));
    } finally {
      setSavingHours(false);
    }
  };

  const saveSettings = async () => {
    if (!staffId) return;
    setSavingSettings(true);
    try {
      const res = await staffScreenApi.saveReservationSettings(staffId, shopId, settings);
      setSettings(res.settings);
      setHasSettings(res.individual);
      refreshLists();
      toast.success('予約設定を保存しました');
    } catch (e) {
      toast.error('予約設定の保存に失敗しました', errorMessage(e));
    } finally {
      setSavingSettings(false);
    }
  };

  const resetSettings = async () => {
    if (!staffId) return;
    setResetting(true);
    try {
      const res = await staffScreenApi.resetReservationSettings(staffId, shopId);
      setSettings(res.settings);
      setHasSettings(res.individual);
      refreshLists();
    } catch (e) {
      toast.error('サロンの予約設定に戻せませんでした', errorMessage(e));
    } finally {
      setResetting(false);
    }
  };

  const updateDay = <K extends keyof StaffDayHours>(
    weekday: number,
    key: K,
    value: StaffDayHours[K],
  ) => setHours((prev) => prev.map((h) => (h.weekday === weekday ? { ...h, [key]: value } : h)));

  if (!staffMember) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-h-[90vh] max-w-lg overflow-y-auto"
      title={<DialogTitle>{staffMember.name} - 設定</DialogTitle>}
    >
      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">読み込み中...</div>
      ) : (
        <div className="w-full">
          <Tabs<Tab>
            label="スタッフ設定"
            value={tab}
            onValueChange={setTab}
            listClassName="grid w-full grid-cols-2"
            items={[
              { value: 'hours', label: '営業時間' },
              { value: 'reservation', label: '予約設定' },
            ]}
          />
          {tab === 'hours' ? (
            <div role="tabpanel" className="mt-2 sy-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {hasHours ? '個別設定済み' : '未設定（サロンの営業時間を使用）'}
                </p>
                <Button variant="outline" size="sm" onClick={copyShopHours} disabled={copying}>
                  {copying ? '反映中...' : 'サロンの営業時間を反映'}
                </Button>
              </div>
              <div className="sy-2">
                {[...hours]
                  .sort((a, b) => a.weekday - b.weekday)
                  .map((h) => (
                    <div
                      key={h.weekday}
                      className="flex items-center gap-2"
                      data-weekday={h.weekday}
                    >
                      <span
                        className={cx(
                          'w-6 text-center text-sm font-medium',
                          h.weekday === 0 ? 'text-red-500' : h.weekday === 6 ? 'text-blue-500' : '',
                        )}
                      >
                        {DAYS[h.weekday]}
                      </span>
                      <Input
                        type="time"
                        aria-label={`${DAYS[h.weekday]}曜 開始`}
                        value={h.openTime}
                        onChange={(e) => updateDay(h.weekday, 'openTime', e.target.value)}
                        className="h-8 w-28 text-sm"
                        disabled={h.isClosed}
                      />
                      <span className="text-sm text-muted-foreground">~</span>
                      <Input
                        type="time"
                        aria-label={`${DAYS[h.weekday]}曜 終了`}
                        value={h.closeTime}
                        onChange={(e) => updateDay(h.weekday, 'closeTime', e.target.value)}
                        className="h-8 w-28 text-sm"
                        disabled={h.isClosed}
                      />
                      <div className="flex items-center gap-1">
                        <Checkbox
                          id={`staff-day-closed-${h.weekday}`}
                          checked={h.isClosed}
                          onCheckedChange={(v) => updateDay(h.weekday, 'isClosed', v)}
                        />
                        <label
                          htmlFor={`staff-day-closed-${h.weekday}`}
                          className="text-xs text-muted-foreground"
                        >
                          休み
                        </label>
                      </div>
                    </div>
                  ))}
              </div>
              <Button onClick={saveHours} disabled={savingHours} className="w-full">
                {savingHours ? '保存中...' : '営業時間を保存'}
              </Button>
            </div>
          ) : (
            <div role="tabpanel" className="mt-2 sy-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {hasSettings ? '個別設定済み' : '未設定（サロンの予約設定を使用）'}
                </p>
                {hasSettings ? (
                  <Button variant="outline" size="sm" onClick={resetSettings} disabled={resetting}>
                    {resetting ? '反映中...' : 'サロンの予約設定に戻す'}
                  </Button>
                ) : null}
              </div>
              <div className="sy-4">
                <div className="sy-1.5">
                  <Label htmlFor="staff-advance-days" className="text-sm">
                    何日先まで予約を受け付ける
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="staff-advance-days"
                      type="number"
                      min={1}
                      max={730}
                      value={settings.advanceBookingDays}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          advanceBookingDays: parseInt(e.target.value) || 365,
                        }))
                      }
                      className="h-8 w-24"
                    />
                    <span className="text-sm text-muted-foreground">日</span>
                  </div>
                </div>
                <div className="sy-1.5">
                  <Label htmlFor="staff-cutoff-hours" className="text-sm">
                    当日予約の締め切り
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="staff-cutoff-hours"
                      type="number"
                      min={0}
                      max={24}
                      value={settings.sameDayCutoffHours}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          sameDayCutoffHours: parseInt(e.target.value) || 0,
                        }))
                      }
                      className="h-8 w-24"
                    />
                    <span className="text-sm text-muted-foreground">時間前（0 = 制限なし）</span>
                  </div>
                </div>
                <div className="sy-1.5">
                  <Label htmlFor="staff-max-concurrent" className="text-sm">
                    同時刻に予約可能な人数
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="staff-max-concurrent"
                      type="number"
                      min={1}
                      max={10}
                      value={settings.maxConcurrent}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, maxConcurrent: parseInt(e.target.value) || 1 }))
                      }
                      className="h-8 w-24"
                    />
                    <span className="text-sm text-muted-foreground">人</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <Label id="staff-same-start-label" className="text-sm">
                    開始時刻が同じ予約を受付する
                  </Label>
                  <Switch
                    aria-labelledby="staff-same-start-label"
                    checked={settings.acceptSameStartTime}
                    onCheckedChange={(v) => setSettings((s) => ({ ...s, acceptSameStartTime: v }))}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label id="staff-outside-hours-label" className="text-sm">
                    営業時間外の予約を受付する
                  </Label>
                  <Switch
                    aria-labelledby="staff-outside-hours-label"
                    checked={settings.acceptOutsideHours}
                    onCheckedChange={(v) => setSettings((s) => ({ ...s, acceptOutsideHours: v }))}
                  />
                </div>
              </div>
              <Button onClick={saveSettings} disabled={savingSettings} className="w-full">
                {savingSettings ? '保存中...' : '予約設定を保存'}
              </Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
