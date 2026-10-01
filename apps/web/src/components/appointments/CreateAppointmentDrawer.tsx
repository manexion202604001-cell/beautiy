import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { appointmentKeys, appointmentsApi, useAvailability } from '../../api/appointments';
import { useCoupons, useMenus } from '../../api/catalog';
import { customerKeys } from '../../api/customers';
import { useStaffList } from '../../api/org';
import type { AppointmentDetail, AppointmentSource } from '../../api/types';
import { ApiError, errorMessage, isApiError, newIdempotencyKey } from '../../lib/api';
import { formatDateJa, formatDuration, formatTime, formatYen } from '../../lib/format';
import { useRevealOnChange, useStableKey } from '../../lib/hooks';
import { todayIn, zonedParts, zonedToIso } from '../../lib/time';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Field,
  Input,
  Segmented,
  Select,
  Textarea,
  useToast,
} from '../ui';
import { CustomerPicker, type PickedCustomer } from './CustomerPicker';
import { MenuPicker, SlotPicker } from './Pickers';

export interface CreateInitial {
  staffId?: string | null;
  date?: string;
  time?: string;
  customer?: PickedCustomer | null;
}

export function CreateAppointmentDrawer({
  open,
  onClose,
  shopId,
  tz,
  initial,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  shopId: string;
  tz: string;
  initial?: CreateInitial;
  onCreated?: (a: AppointmentDetail) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const menus = useMenus(shopId);
  const staff = useStaffList({ shopId, bookableOnly: true });
  const coupons = useCoupons(shopId);

  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [menuIds, setMenuIds] = useState<string[]>([]);
  const [staffId, setStaffId] = useState<string>('');
  const [date, setDate] = useState(todayIn(tz));
  const [time, setTime] = useState<string | null>(null);
  const [allowOutside, setAllowOutside] = useState(false);
  const [manualTime, setManualTime] = useState(false);
  const [customerNote, setCustomerNote] = useState('');
  const [staffNote, setStaffNote] = useState('');
  const [couponId, setCouponId] = useState('');
  const [source, setSource] = useState<AppointmentSource>('phone');
  const [status, setStatus] = useState<'confirmed' | 'tentative'>('confirmed');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<ApiError | Error | null>(null);
  const [saving, setSaving] = useState(false);
  const [idemKey, regenerateKey] = useStableKey(newIdempotencyKey);
  const errorRef = useRevealOnChange<HTMLDivElement>(submitError);

  // reset when (re)opened
  useEffect(() => {
    if (!open) return;
    setCustomer(initial?.customer ?? null);
    setMenuIds([]);
    setStaffId(initial?.staffId ?? '');
    setDate(initial?.date ?? todayIn(tz));
    setTime(initial?.time ?? null);
    setManualTime(!!initial?.time);
    setAllowOutside(false);
    setCustomerNote('');
    setStaffNote('');
    setCouponId('');
    setSource('phone');
    setStatus('confirmed');
    setErrors({});
    setSubmitError(null);
  }, [open, initial, tz]);

  const availQuery = useMemo(
    () =>
      menuIds.length
        ? { shopId, menuIds, staffId: staffId || undefined, from: date, to: date }
        : null,
    [shopId, menuIds, staffId, date],
  );
  const availability = useAvailability(open ? availQuery : null);
  const slots = availability.data?.days[0]?.slots ?? [];
  const startIso = time ? zonedToIso(date, time, tz) : null;
  const slotMatch = startIso ? slots.find((s) => s.start === startIso) : undefined;
  const outsideSlots = !!startIso && !!availability.data && !slotMatch;

  const selectedMenus = (menus.data ?? []).filter((m) => menuIds.includes(m.id));
  const total = selectedMenus.reduce((s, m) => s + m.price, 0);
  const duration = selectedMenus.reduce((s, m) => s + m.durationMin, 0);
  const staffName = staff.data?.find((s) => s.id === staffId)?.display_name;

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!menuIds.length) errs.menus = 'メニューを1つ以上選択してください';
    if (!time) errs.time = '開始時刻を選択してください';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const appt = await appointmentsApi.create(
        {
          shopId,
          customerId: customer?.id ?? null,
          staffId: staffId || null,
          isNominated: !!staffId,
          startAt: startIso!,
          menuIds,
          couponId: couponId || null,
          source,
          status,
          customerNote: customerNote.trim() || null,
          staffNote: staffNote.trim() || null,
          allowOutsideSchedule: allowOutside || undefined,
        },
        idemKey,
      );
      regenerateKey();
      void qc.invalidateQueries({ queryKey: appointmentKeys.all });
      if (customer) void qc.invalidateQueries({ queryKey: customerKeys.detail(customer.id) });
      toast.success(
        '予約を登録しました',
        `${formatDateJa(zonedParts(appt.start_at, tz).date)} ${formatTime(appt.start_at, tz)} ${appt.staff_name ?? ''}`,
      );
      onCreated?.(appt);
      onClose();
    } catch (e) {
      // a server response consumed this key → new key for the next attempt (network errors keep it)
      if (isApiError(e) && e.status > 0) regenerateKey();
      setSubmitError(e as Error);
      if (
        isApiError(e) &&
        (e.code === 'SLOT_UNAVAILABLE' ||
          e.code === 'APPOINTMENT_OVERLAP' ||
          e.code === 'RESOURCE_OVERLAP')
      ) {
        void availability.refetch();
      }
    } finally {
      setSaving(false);
    }
  };

  const conflict =
    isApiError(submitError) &&
    ['SLOT_UNAVAILABLE', 'APPOINTMENT_OVERLAP', 'RESOURCE_OVERLAP'].includes(submitError.code);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="予約を作成"
      description={
        time
          ? `${formatDateJa(date)} ${time}〜${staffName ? ` ・ ${staffName}` : ''}`
          : '顧客・メニュー・日時を選択してください'
      }
      width="lg"
      dismissable={!saving}
      footer={
        <>
          <div className="mr-auto text-[13px] text-muted">
            {selectedMenus.length ? (
              <>
                {formatDuration(duration)} ・{' '}
                <span className="font-semibold text-fg tabular">{formatYen(total)}</span>
              </>
            ) : null}
          </div>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={saving}
            data-testid="create-appointment-submit"
          >
            予約を登録
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <div ref={errorRef} className="scroll-mt-4">
          {submitError ? (
            <Alert
              tone="danger"
              title={conflict ? 'この時間帯は予約できません' : '登録できませんでした'}
            >
              {errorMessage(submitError)}
              {conflict
                ? '。空き枠を更新しました。別の時間を選ぶか、担当者を変更してください。'
                : ''}
            </Alert>
          ) : null}
        </div>

        <section aria-labelledby="ca-customer">
          <h3 id="ca-customer" className="mb-2 text-[13px] font-semibold text-fg">
            顧客{' '}
            <span className="ml-1 text-xs font-normal text-subtle">
              任意（未選択の場合は顧客なしで登録）
            </span>
          </h3>
          <CustomerPicker value={customer} onChange={setCustomer} />
        </section>

        <section aria-labelledby="ca-menus">
          <h3 id="ca-menus" className="mb-2 text-[13px] font-semibold text-fg">
            メニュー <span className="text-danger">*</span>
          </h3>
          <MenuPicker
            menus={menus.data ?? []}
            value={menuIds}
            onChange={setMenuIds}
            error={errors.menus}
            max={10}
          />
        </section>

        <section aria-labelledby="ca-when" className="space-y-3">
          <h3 id="ca-when" className="text-[13px] font-semibold text-fg">
            担当・日時 <span className="text-danger">*</span>
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="担当スタッフ">
              <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                <option value="">フリー（指名なし・自動割当）</option>
                {(staff.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name}
                    {s.nomination_fee ? `（指名料 ${formatYen(s.nomination_fee)}）` : ''}
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
          </div>

          {menuIds.length ? (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs text-muted">
                  空き枠（
                  {availability.data ? `${availability.data.slotIntervalMin}分刻み` : '計算中'}）
                </p>
                <button
                  type="button"
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={() => setManualTime((v) => !v)}
                >
                  {manualTime ? '空き枠から選ぶ' : '時刻を直接入力'}
                </button>
              </div>
              {!manualTime ? (
                <SlotPicker
                  slots={slots}
                  value={startIso}
                  onChange={(iso) => setTime(zonedParts(iso, tz).time)}
                  tz={tz}
                  loading={availability.isLoading}
                />
              ) : null}
            </div>
          ) : (
            <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-muted">
              メニューを選択すると空き枠が表示されます
            </p>
          )}

          {manualTime || !menuIds.length ? (
            <Field label="開始時刻" error={errors.time}>
              <Input
                type="time"
                step={900}
                value={time ?? ''}
                onChange={(e) => setTime(e.target.value || null)}
                className="max-w-[10rem]"
              />
            </Field>
          ) : errors.time ? (
            <p className="text-xs font-medium text-danger">{errors.time}</p>
          ) : null}

          {outsideSlots ? (
            <Alert tone="warning" title="選択した時刻は空き枠外です">
              営業時間外・勤務時間外、または他の予約と重なっています。勤務時間外でも受ける場合は下の「時間外予約を許可」をオンにしてください（他の予約との重複は許可されません）。
            </Alert>
          ) : null}
          <Checkbox
            label="時間外予約を許可（スタッフ判断）"
            description="営業時間・シフト外でも登録できます。ダブルブッキングは防止されます。"
            checked={allowOutside}
            onChange={(e) => setAllowOutside(e.target.checked)}
          />
        </section>

        <section aria-labelledby="ca-detail" className="space-y-3">
          <h3 id="ca-detail" className="text-[13px] font-semibold text-fg">
            詳細
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="予約経路">
              <Select
                value={source}
                onChange={(e) => setSource(e.target.value as AppointmentSource)}
              >
                <option value="phone">電話</option>
                <option value="walk_in">店頭</option>
                <option value="staff">スタッフ登録</option>
                <option value="line">LINE</option>
                <option value="web">Web</option>
                <option value="external">外部媒体</option>
              </Select>
            </Field>
            <Field label="クーポン" optional>
              <Select value={couponId} onChange={(e) => setCouponId(e.target.value)}>
                <option value="">使用しない</option>
                {(coupons.data ?? [])
                  .filter((c) => c.status === 'active')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium">ステータス</p>
            <Segmented
              label="予約ステータス"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'confirmed', label: '確定' },
                { value: 'tentative', label: '仮予約' },
              ]}
            />
          </div>
          <Field label="お客様からの要望" optional>
            <Textarea
              value={customerNote}
              onChange={(e) => setCustomerNote(e.target.value)}
              rows={2}
              maxLength={2000}
            />
          </Field>
          <Field label="スタッフメモ（お客様には表示されません）" optional>
            <Textarea
              value={staffNote}
              onChange={(e) => setStaffNote(e.target.value)}
              rows={2}
              maxLength={2000}
            />
          </Field>
        </section>
      </div>
    </Drawer>
  );
}
