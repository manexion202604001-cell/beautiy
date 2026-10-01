import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { catalogApi, catalogKeys, useMenus } from '../../../api/catalog';
import type { Coupon, CouponInput } from '../../../api/types';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Segmented,
  Select,
  Textarea,
  useToast,
} from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { zonedParts, zonedToIso } from '../../../lib/time';

function toLocalInput(iso: string | null, tz: string) {
  if (!iso) return '';
  const p = zonedParts(iso, tz);
  return `${p.date}T${p.time}`;
}

function fromLocalInput(v: string, tz: string) {
  if (!v) return null;
  const [d, t] = v.split('T');
  return zonedToIso(d!, t ?? '00:00', tz);
}

export function CouponDialog({
  shopId,
  coupon,
  onClose,
}: {
  shopId: string;
  coupon: Coupon | null;
  onClose: () => void;
}) {
  const { timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const menus = useMenus(shopId);
  const [f, setF] = useState({
    scope: coupon?.shop_id ? 'shop' : 'common',
    name: coupon?.name ?? '',
    code: coupon?.code ?? '',
    description: coupon?.description ?? '',
    discountType: coupon?.discount_type ?? 'amount',
    discountValue: coupon ? String(coupon.discount_value) : '',
    applicableMenuIds: coupon?.applicable_menu_ids ?? [],
    minAmount: coupon ? String(coupon.min_amount) : '0',
    validFrom: toLocalInput(coupon?.valid_from ?? null, tz),
    validUntil: toLocalInput(coupon?.valid_until ?? null, tz),
    usageLimit: coupon?.usage_limit ? String(coupon.usage_limit) : '',
    perCustomerLimit: coupon?.per_customer_limit ? String(coupon.per_customer_limit) : '',
    newCustomerOnly: coupon?.new_customer_only ?? false,
    isPublic: coupon?.is_public ?? true,
    status: coupon?.status ?? 'active',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    const errs: Record<string, string> = {};
    const value = Number(f.discountValue);
    if (!f.name.trim()) errs.name = 'クーポン名を入力してください';
    if (f.discountValue === '' || !Number.isInteger(value) || value < 0)
      errs.discountValue = '0以上の整数で入力してください';
    if (f.discountType === 'percent' && value > 100)
      errs.discountValue = '割引率は100以下で入力してください';
    if (f.code && (f.code.length < 3 || f.code.length > 30))
      errs.code = '3〜30文字で入力してください';
    if (f.validFrom && f.validUntil && f.validFrom >= f.validUntil)
      errs.validUntil = '終了は開始より後にしてください';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const input: CouponInput = {
      name: f.name.trim(),
      code: f.code.trim() || null,
      description: f.description.trim() || null,
      discountType: f.discountType,
      discountValue: value,
      applicableMenuIds: f.applicableMenuIds,
      minAmount: Number(f.minAmount) || 0,
      validFrom: fromLocalInput(f.validFrom, tz),
      validUntil: fromLocalInput(f.validUntil, tz),
      usageLimit: f.usageLimit ? Number(f.usageLimit) : null,
      perCustomerLimit: f.perCustomerLimit ? Number(f.perCustomerLimit) : null,
      newCustomerOnly: f.newCustomerOnly,
      isPublic: f.isPublic,
    };
    setSaving(true);
    setError(null);
    try {
      if (coupon) await catalogApi.updateCoupon(coupon.id, { ...input, status: f.status });
      else await catalogApi.createCoupon({ ...input, shopId: f.scope === 'shop' ? shopId : null });
      void qc.invalidateQueries({ queryKey: catalogKeys.all });
      toast.success(coupon ? 'クーポンを更新しました' : 'クーポンを追加しました');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={coupon ? 'クーポンを編集' : 'クーポンを追加'}
      dismissable={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <div className="space-y-5">
        {!coupon ? (
          <Segmented
            label="対象店舗"
            value={f.scope}
            onChange={(v) => set('scope', v)}
            options={[
              { value: 'common', label: '全店舗で利用可' },
              { value: 'shop', label: 'この店舗のみ' },
            ]}
          />
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="クーポン名" required error={errors.name} className="sm:col-span-2">
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={100} />
          </Field>
          <Field label="割引の種類">
            <Select
              value={f.discountType}
              onChange={(e) => set('discountType', e.target.value as Coupon['discount_type'])}
            >
              <option value="amount">金額割引（円引き）</option>
              <option value="percent">割合割引（%OFF）</option>
              <option value="fixed_price">固定価格</option>
            </Select>
          </Field>
          <Field
            label={
              f.discountType === 'percent'
                ? '割引率'
                : f.discountType === 'fixed_price'
                  ? '固定価格'
                  : '割引額'
            }
            required
            error={errors.discountValue}
          >
            <Input
              type="number"
              min={0}
              value={f.discountValue}
              onChange={(e) => set('discountValue', e.target.value)}
              leading={f.discountType === 'percent' ? undefined : '¥'}
              trailing={f.discountType === 'percent' ? '%' : undefined}
            />
          </Field>
          <Field label="クーポンコード" optional error={errors.code} hint="入力式で使う場合">
            <Input
              value={f.code}
              onChange={(e) => set('code', e.target.value.toUpperCase())}
              maxLength={30}
            />
          </Field>
          <Field label="最低利用金額">
            <Input
              type="number"
              min={0}
              value={f.minAmount}
              onChange={(e) => set('minAmount', e.target.value)}
              leading="¥"
            />
          </Field>
          <Field label="利用開始" optional>
            <Input
              type="datetime-local"
              value={f.validFrom}
              onChange={(e) => set('validFrom', e.target.value)}
            />
          </Field>
          <Field label="利用終了" optional error={errors.validUntil}>
            <Input
              type="datetime-local"
              value={f.validUntil}
              onChange={(e) => set('validUntil', e.target.value)}
            />
          </Field>
          <Field label="利用回数の上限（全体）" optional>
            <Input
              type="number"
              min={1}
              value={f.usageLimit}
              onChange={(e) => set('usageLimit', e.target.value)}
              trailing="回"
            />
          </Field>
          <Field label="1人あたりの上限" optional>
            <Input
              type="number"
              min={1}
              value={f.perCustomerLimit}
              onChange={(e) => set('perCustomerLimit', e.target.value)}
              trailing="回"
            />
          </Field>
          <Field label="説明" optional className="sm:col-span-2">
            <Textarea
              value={f.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
            />
          </Field>
        </div>
        <div className="space-y-2.5">
          <Checkbox
            label="予約画面に表示する"
            checked={f.isPublic}
            onChange={(e) => set('isPublic', e.target.checked)}
          />
          <Checkbox
            label="新規のお客様限定"
            checked={f.newCustomerOnly}
            onChange={(e) => set('newCustomerOnly', e.target.checked)}
          />
          {coupon ? (
            <Checkbox
              label="利用を停止する"
              checked={f.status === 'inactive'}
              onChange={(e) => set('status', e.target.checked ? 'inactive' : 'active')}
            />
          ) : null}
        </div>
        <fieldset>
          <legend className="mb-1 text-[13px] font-semibold">対象メニュー</legend>
          <p className="mb-2 text-xs text-muted">選択しない場合は全メニューが対象です。</p>
          <div className="grid max-h-48 gap-2 overflow-y-auto rounded-xl border border-border p-3 sm:grid-cols-2">
            {(menus.data ?? []).map((m) => (
              <Checkbox
                key={m.id}
                label={m.name}
                checked={f.applicableMenuIds.includes(m.id)}
                onChange={(e) =>
                  set(
                    'applicableMenuIds',
                    e.target.checked
                      ? [...f.applicableMenuIds, m.id]
                      : f.applicableMenuIds.filter((x) => x !== m.id),
                  )
                }
              />
            ))}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}
