import { z } from 'zod';
import { useStaffList } from '../../../api/org';
import type { CustomerDetail, CustomerInput } from '../../../api/types';
import { Button, Checkbox, Field, Input, Select } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { emptyToNull, useZodForm } from '../../../lib/form';

const schema = z
  .object({
    lastName: z.string().max(50),
    firstName: z.string().max(50),
    lastNameKana: z
      .string()
      .max(50)
      .regex(/^[゠-ヿ぀-ゟ\s\u3000ー]*$/, 'カタカナで入力してください'),
    firstNameKana: z
      .string()
      .max(50)
      .regex(/^[゠-ヿ぀-ゟ\s\u3000ー]*$/, 'カタカナで入力してください'),
    gender: z.enum(['', 'female', 'male', 'other', 'unknown']),
    birthday: z.string(),
    phone: z
      .string()
      .max(30)
      .regex(/^[0-9+\-()\s]*$/, '数字とハイフンで入力してください'),
    email: z.union([z.literal(''), z.string().email('メールアドレスの形式が正しくありません')]),
    postalCode: z.string().max(10),
    address: z.string().max(300),
    occupation: z.string().max(100),
    acquisitionSource: z.string().max(100),
    customerNumber: z.string().max(50),
    primaryShopId: z.string(),
    primaryStaffId: z.string(),
    marketingOptIn: z.boolean(),
    status: z.enum(['active', 'blocked']),
  })
  .refine((v) => (v.lastName + v.firstName + v.lastNameKana + v.firstNameKana).trim().length > 0, {
    message: '氏名またはフリガナを入力してください',
    path: ['lastName'],
  });

type Values = z.input<typeof schema>;

export function toInitial(c?: CustomerDetail | null, defaults?: Partial<Values>): Values {
  return {
    lastName: c?.last_name ?? '',
    firstName: c?.first_name ?? '',
    lastNameKana: c?.last_name_kana ?? '',
    firstNameKana: c?.first_name_kana ?? '',
    gender: (c?.gender as Values['gender']) ?? '',
    birthday: c?.birthday ?? '',
    phone: c?.phone ?? '',
    email: c?.email ?? '',
    postalCode: c?.postal_code ?? '',
    address: c?.address ?? '',
    occupation: c?.occupation ?? '',
    acquisitionSource: c?.acquisition_source ?? '',
    customerNumber: c?.customer_number ?? '',
    primaryShopId: c?.primary_shop_id ?? '',
    primaryStaffId: c?.primary_staff_id ?? '',
    marketingOptIn: c?.marketing_opt_in ?? true,
    status: c?.status === 'blocked' ? 'blocked' : 'active',
    ...defaults,
  };
}

function toInput(v: z.output<typeof schema>, isNew: boolean): CustomerInput {
  return {
    lastName: v.lastName.trim(),
    firstName: v.firstName.trim(),
    lastNameKana: v.lastNameKana.trim(),
    firstNameKana: v.firstNameKana.trim(),
    gender: v.gender || null,
    birthday: v.birthday || null,
    phone: emptyToNull(v.phone),
    email: emptyToNull(v.email),
    postalCode: emptyToNull(v.postalCode),
    address: emptyToNull(v.address),
    occupation: emptyToNull(v.occupation),
    acquisitionSource: emptyToNull(v.acquisitionSource),
    customerNumber: emptyToNull(v.customerNumber),
    primaryShopId: v.primaryShopId || null,
    primaryStaffId: v.primaryStaffId || null,
    marketingOptIn: v.marketingOptIn,
    ...(isNew ? {} : { status: v.status }),
  };
}

export function CustomerForm({
  initial,
  isNew,
  submitLabel,
  saving,
  onSubmit,
  onCancel,
}: {
  initial: Values;
  isNew: boolean;
  submitLabel: string;
  saving?: boolean;
  onSubmit: (input: CustomerInput) => void;
  onCancel?: () => void;
}) {
  const { shops } = useAuth();
  const f = useZodForm(schema, initial);
  const staff = useStaffList({ shopId: f.values.primaryShopId || undefined });

  return (
    <form
      onSubmit={f.handleSubmit((v) => onSubmit(toInput(v, isNew)))}
      className="space-y-6"
      noValidate
    >
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-[13px] font-semibold text-fg">基本情報</legend>
        <Field label="姓" error={f.errors.lastName}>
          <Input
            value={f.values.lastName}
            onChange={(e) => f.set('lastName', e.target.value)}
            autoComplete="family-name"
          />
        </Field>
        <Field label="名" error={f.errors.firstName}>
          <Input
            value={f.values.firstName}
            onChange={(e) => f.set('firstName', e.target.value)}
            autoComplete="given-name"
          />
        </Field>
        <Field label="セイ" error={f.errors.lastNameKana}>
          <Input
            value={f.values.lastNameKana}
            onChange={(e) => f.set('lastNameKana', e.target.value)}
          />
        </Field>
        <Field label="メイ" error={f.errors.firstNameKana}>
          <Input
            value={f.values.firstNameKana}
            onChange={(e) => f.set('firstNameKana', e.target.value)}
          />
        </Field>
        <Field label="性別">
          <Select
            value={f.values.gender}
            onChange={(e) => f.set('gender', e.target.value as Values['gender'])}
          >
            <option value="">未設定</option>
            <option value="female">女性</option>
            <option value="male">男性</option>
            <option value="other">その他</option>
            <option value="unknown">回答しない</option>
          </Select>
        </Field>
        <Field label="生年月日">
          <Input
            type="date"
            value={f.values.birthday}
            onChange={(e) => f.set('birthday', e.target.value)}
            max="2100-12-31"
          />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-[13px] font-semibold text-fg">連絡先</legend>
        <Field label="電話番号" error={f.errors.phone}>
          <Input
            type="tel"
            value={f.values.phone}
            onChange={(e) => f.set('phone', e.target.value)}
            autoComplete="tel"
          />
        </Field>
        <Field label="メールアドレス" error={f.errors.email}>
          <Input
            type="email"
            value={f.values.email}
            onChange={(e) => f.set('email', e.target.value)}
            autoComplete="email"
          />
        </Field>
        <Field label="郵便番号">
          <Input
            value={f.values.postalCode}
            onChange={(e) => f.set('postalCode', e.target.value)}
            autoComplete="postal-code"
          />
        </Field>
        <Field label="住所">
          <Input
            value={f.values.address}
            onChange={(e) => f.set('address', e.target.value)}
            autoComplete="street-address"
          />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-[13px] font-semibold text-fg">サロン情報</legend>
        <Field label="主担当店舗">
          <Select
            value={f.values.primaryShopId}
            onChange={(e) => f.set('primaryShopId', e.target.value)}
          >
            <option value="">{isNew ? '現在の店舗' : '未設定'}</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="担当スタッフ">
          <Select
            value={f.values.primaryStaffId}
            onChange={(e) => f.set('primaryStaffId', e.target.value)}
          >
            <option value="">未設定</option>
            {(staff.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="来店きっかけ">
          <Input
            value={f.values.acquisitionSource}
            onChange={(e) => f.set('acquisitionSource', e.target.value)}
            list="acq-sources"
          />
        </Field>
        <datalist id="acq-sources">
          {['web', 'line', 'instagram', 'referral', 'walk_in', 'phone', 'hotpepper'].map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Field label="職業">
          <Input
            value={f.values.occupation}
            onChange={(e) => f.set('occupation', e.target.value)}
          />
        </Field>
        <Field label="顧客番号" hint="既存システムからの移行時など">
          <Input
            value={f.values.customerNumber}
            onChange={(e) => f.set('customerNumber', e.target.value)}
          />
        </Field>
        {!isNew ? (
          <Field label="ステータス">
            <Select
              value={f.values.status}
              onChange={(e) => f.set('status', e.target.value as 'active' | 'blocked')}
            >
              <option value="active">有効</option>
              <option value="blocked">予約受付停止</option>
            </Select>
          </Field>
        ) : null}
        <div className="sm:col-span-2">
          <Checkbox
            label="お知らせ・キャンペーン配信を許可"
            description="予約確認やリマインドなどの連絡は、この設定に関わらず送信されます。"
            checked={f.values.marketingOptIn}
            onChange={(e) => f.set('marketingOptIn', e.target.checked)}
          />
        </div>
      </fieldset>

      <div className="flex justify-end gap-2 border-t border-border pt-4">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            キャンセル
          </Button>
        ) : null}
        <Button type="submit" variant="primary" loading={saving}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
