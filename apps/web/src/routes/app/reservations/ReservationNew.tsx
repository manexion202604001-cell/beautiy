import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Scissors, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { appointmentKeys, appointmentsApi } from '../../../api/appointments';
import { useStaffList } from '../../../api/org';
import { Button, Label, Select, Tabs, Textarea } from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { hhmmToMinutes, minutesToHhmm, todayIn, zonedToIso } from '../../../lib/time';
import { DateTimeDrumPicker, TimeDrumPicker } from './DrumPicker';
import { BOOKING_ROUTES, formatCurrency, formatDuration, type PickedMenu } from './model';

const DRAFT_KEY = 'salonos_reservation_draft';

interface Draft {
  customerId: string;
  customerName: string;
  selectedMenus: PickedMenu[];
  date: string;
  startTime: string;
  endTime: string;
  memo: string;
  staffType: 'free' | 'designated';
  targetStaffId: string | null;
  route: string;
}

function loadDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}
const saveDraft = (d: Draft) => sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
const clearDraft = () => sessionStorage.removeItem(DRAFT_KEY);

/** 新規予約作成 */
export default function ReservationNew() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { currentShopId: shopId, timezone: tz } = useAuth();

  const [customerId, setCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [menus, setMenus] = useState<PickedMenu[]>([]);
  const [date, setDate] = useState(() => todayIn(tz));
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('11:00');
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);
  const [targetStaffId, setTargetStaffId] = useState<string | null>(null);
  const [staffType, setStaffType] = useState<'free' | 'designated'>('free');
  const [route, setRoute] = useState('phone');
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const staffQ = useStaffList({ shopId: shopId ?? undefined }, !!shopId);
  const staff = (staffQ.data ?? []).filter((s) => s.status === 'active');

  const totalDuration = menus.reduce((sum, m) => sum + m.duration, 0);
  const totalPrice = menus.reduce((sum, m) => sum + m.price, 0);

  // values handed over in the URL (calendar, customer picker, menu picker) + the draft saved before leaving
  useEffect(() => {
    const qDate = params.get('date');
    const qTime = params.get('time');
    const qStaff = params.get('staff_id');
    const qCustomerId = params.get('customer_id');
    const qCustomerName = params.get('customer_name');
    const qMenus = params.get('menu_data');
    if (qStaff) {
      setTargetStaffId(qStaff);
      setStaffType('designated');
    }
    const draft = loadDraft();
    if ((qCustomerId && qCustomerName) || qMenus) {
      if (qCustomerId && qCustomerName) {
        setCustomerId(qCustomerId);
        setCustomerName(qCustomerName);
      }
      let picked: PickedMenu[] = [];
      if (qMenus) {
        try {
          picked = JSON.parse(qMenus) as PickedMenu[];
          setMenus(picked);
        } catch {
          /* ignore a malformed hand-over */
        }
      }
      if (draft) {
        if (!qCustomerId) {
          setCustomerId(draft.customerId || '');
          setCustomerName(draft.customerName || '');
        }
        if (!qMenus) setMenus(draft.selectedMenus || []);
        setDate(draft.date);
        setStartTime(draft.startTime);
        setMemo(draft.memo);
        setRoute(draft.route || 'phone');
        if (!qStaff) {
          setStaffType(draft.staffType || 'free');
          setTargetStaffId(draft.targetStaffId || null);
        }
        if (qMenus && picked.length > 0) {
          const minutes = picked.reduce((sum, m) => sum + m.duration, 0);
          setEndTime(minutesToHhmm(hhmmToMinutes(draft.startTime) + minutes));
        } else setEndTime(draft.endTime);
        clearDraft();
      }
      return;
    }
    if (qDate) setDate(qDate);
    if (qTime) {
      setStartTime(qTime);
      const [h, m] = qTime.split(':').map(Number) as [number, number];
      setEndTime(`${String(h + 1).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
    // read once on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draft = (): Draft => ({
    customerId,
    customerName,
    selectedMenus: menus,
    date,
    startTime,
    endTime,
    memo,
    staffType,
    targetStaffId,
    route,
  });
  const pickCustomer = () => {
    saveDraft(draft());
    navigate('/app/customers?mode=select');
  };
  const pickMenus = () => {
    saveDraft(draft());
    const q = new URLSearchParams();
    if (staffType === 'designated' && targetStaffId) q.set('staff_id', targetStaffId);
    if (menus.length > 0) q.set('selected', JSON.stringify(menus));
    navigate(`/app/menus/select?${q.toString()}`);
  };

  const submit = async () => {
    if (!shopId || !customerId || menus.length === 0 || !endTime) return;
    if (staffType === 'designated' && !targetStaffId) {
      toast.error('指名の場合はスタッフを選択してください');
      return;
    }
    if (staffType === 'free' && staff.length === 0) {
      toast.error('スタッフが登録されていません');
      return;
    }
    const minutes = hhmmToMinutes(endTime) - hhmmToMinutes(startTime);
    if (minutes <= 0) {
      toast.error('終了時間は開始日時より後にしてください');
      return;
    }
    setSaving(true);
    try {
      await appointmentsApi.create(
        {
          shopId,
          customerId,
          staffId: staffType === 'designated' ? targetStaffId : null,
          isNominated: staffType === 'designated',
          startAt: zonedToIso(date, startTime, tz),
          menuIds: menus.map((m) => m.id),
          ...(minutes !== totalDuration ? { durationMin: minutes } : {}),
          source: BOOKING_ROUTES.find((r) => r.value === route)?.source ?? 'phone',
          staffNote: memo || null,
        },
        idempotencyKey,
      );
      clearDraft();
      void qc.invalidateQueries({ queryKey: appointmentKeys.all });
      navigate('/app/calendar');
    } catch (e) {
      // a server answer consumed this key; the next attempt is a new request
      setIdempotencyKey(newIdempotencyKey());
      toast.error('予約の作成に失敗しました', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg sy-4 overflow-x-hidden">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="戻る" onClick={() => navigate('/app/calendar')}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-bold">新規予約作成</h1>
      </div>

      <div className="sy-2">
        <Label>顧客</Label>
        {customerId ? (
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{customerName}</span>
            </div>
            <Button variant="outline" size="sm" onClick={pickCustomer}>
              変更
            </Button>
          </div>
        ) : (
          <Button variant="outline" className="w-full justify-start gap-2" onClick={pickCustomer}>
            <User className="h-4 w-4" />
            顧客を選択
          </Button>
        )}
      </div>

      <div className="sy-2">
        <Label>担当スタッフ</Label>
        <Tabs
          label="担当スタッフ"
          value={staffType}
          onValueChange={(v) => {
            setStaffType(v);
            if (v === 'free') {
              setTargetStaffId(null);
              setMenus([]);
            }
          }}
          listClassName="grid w-full grid-cols-2"
          items={[
            { value: 'free', label: 'フリー' },
            { value: 'designated', label: '指名' },
          ]}
        />
        {staffType === 'designated' ? (
          <Select
            label="スタッフ"
            value={targetStaffId || ''}
            onValueChange={(v) => {
              setTargetStaffId(v);
              setMenus([]);
            }}
            placeholder="スタッフを選択"
            options={staff.map((s) => ({ value: s.id, label: s.display_name }))}
          />
        ) : null}
      </div>

      <div className="sy-2">
        <Label>メニュー</Label>
        {menus.length > 0 ? (
          <div className="rounded-md border">
            {menus.map((m, i) => (
              <div key={m.id} className={`flex items-center gap-2 p-2.5 ${i < menus.length - 1 ? 'border-b' : ''}`}>
                <Scissors className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium leading-tight">{m.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDuration(m.duration)} / {formatCurrency(m.price)}
                  </p>
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between border-t bg-muted/30 px-3 py-2">
              <span className="text-xs text-muted-foreground">
                合計: {formatDuration(totalDuration)} / {formatCurrency(totalPrice)}
              </span>
              <Button variant="outline" size="sm" onClick={pickMenus}>
                変更
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" className="w-full justify-between gap-2" onClick={pickMenus}>
            <span className="flex items-center gap-2">
              <Scissors className="h-4 w-4" />
              メニューを選択
            </span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Button>
        )}
      </div>

      <div className="sy-2">
        <Label>開始日時</Label>
        <DateTimeDrumPicker
          date={date}
          time={startTime}
          onDateChange={setDate}
          onTimeChange={(t) => {
            setStartTime(t);
            if (totalDuration > 0) setEndTime(minutesToHhmm(hhmmToMinutes(t) + totalDuration));
          }}
          label="開始日時"
        />
      </div>

      <div className="sy-2">
        <Label>終了時間</Label>
        <TimeDrumPicker value={endTime} onChange={setEndTime} label="終了時間" />
        {menus.length > 0 && totalDuration > 0
          ? (() => {
              const minutes = hhmmToMinutes(endTime) - hhmmToMinutes(startTime);
              return minutes !== totalDuration ? (
                <p className="text-xs text-muted-foreground">
                  メニュー所要時間: {formatDuration(totalDuration)} → 変更済み: {formatDuration(minutes)}
                </p>
              ) : null;
            })()
          : null}
      </div>

      <div className="sy-2">
        <Label>予約経路</Label>
        <Select
          label="予約経路"
          value={route}
          onValueChange={setRoute}
          options={BOOKING_ROUTES.map((r) => ({ value: r.value, label: r.label }))}
        />
      </div>

      <div className="sy-2">
        <Label>メモ</Label>
        <Textarea
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="予約に関するメモ..."
          rows={3}
        />
      </div>

      <div className="flex flex-col gap-3 pb-4 pt-2">
        <Button
          className="w-full"
          onClick={() => void submit()}
          disabled={saving || !customerId || menus.length === 0 || !endTime}
        >
          {saving ? '作成中...' : '新規予約を作成する'}
        </Button>
        <Button className="w-full" variant="ghost" onClick={() => navigate('/app/calendar')}>
          戻る
        </Button>
      </div>
    </div>
  );
}
