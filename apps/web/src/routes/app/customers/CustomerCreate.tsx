import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { customerKeys, customersApi } from '../../../api/customers';
import { useStaffList } from '../../../api/org';
import type { CustomerInput } from '../../../api/types';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Separator,
  Textarea,
} from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useStableKey } from '../../../lib/hooks';
import { lookupAddress, splitName } from './shared';

const EMPTY = {
  name: '',
  name_kana: '',
  gender: '',
  birthday: '',
  occupation: '',
  postal_code: '',
  address: '',
  phone: '',
  email: '',
  memo: '',
  staff_id: '',
};

/**
 * 新規顧客登録. ?mode=select: opened from the reservation form's customer picker — after the
 * customer is registered the reservation form continues with them.
 */
export default function CustomerCreate() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { currentShopId } = useAuth();
  const selectMode = params.get('mode') === 'select';
  const staffQ = useStaffList({});
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [searchingAddress, setSearchingAddress] = useState(false);
  // one key per attempt: a retried request never registers the customer twice
  const [key, regenerateKey] = useStableKey(newIdempotencyKey);
  const set = (patch: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...patch }));

  const onPostalCode = async (value: string) => {
    set({ postal_code: value });
    if (value.replace(/-/g, '').length !== 7) return;
    setSearchingAddress(true);
    const address = await lookupAddress(value);
    if (address) set({ address });
    setSearchingAddress(false);
  };

  const submit = async () => {
    if (!form.name.trim()) {
      toast.error('名前は必須です');
      return;
    }
    setSaving(true);
    try {
      const [lastName, firstName] = splitName(form.name);
      const [lastNameKana, firstNameKana] = splitName(form.name_kana);
      const input: CustomerInput = {
        lastName,
        firstName,
        lastNameKana,
        firstNameKana,
        gender: (form.gender || undefined) as CustomerInput['gender'],
        birthday: form.birthday || undefined,
        occupation: form.occupation || undefined,
        postalCode: form.postal_code || undefined,
        address: form.address || undefined,
        phone: form.phone || undefined,
        email: form.email || undefined,
        memo: form.memo || undefined,
        primaryStaffId: form.staff_id && form.staff_id !== 'none' ? form.staff_id : undefined,
        primaryShopId: currentShopId ?? undefined,
      };
      const { customer } = await customersApi.create(input, key);
      void qc.invalidateQueries({ queryKey: customerKeys.all });
      if (selectMode) {
        navigate(
          `/app/calendar/new?customer_id=${customer.id}&customer_name=${encodeURIComponent(customer.display_name)}`,
        );
        return;
      }
      navigate(`/app/customers/${customer.id}`);
    } catch (e) {
      regenerateKey();
      toast.error('顧客の登録に失敗しました', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sy-4 md:sy-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="戻る" onClick={() => navigate(-1)}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-bold md:text-2xl">新規顧客登録</h1>
      </div>

      <Card>
        <CardHeader className="py-4 md:py-6">
          <CardTitle className="text-base md:text-lg">顧客情報</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="sy-2">
                <Label htmlFor="customer-name">
                  名前 <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="customer-name"
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="山田 花子"
                />
              </div>
              <div className="sy-2">
                <Label htmlFor="customer-kana">よみがな</Label>
                <Input
                  id="customer-kana"
                  value={form.name_kana}
                  onChange={(e) => set({ name_kana: e.target.value })}
                  placeholder="ヤマダ ハナコ"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="sy-2">
                <Label>性別</Label>
                <Select
                  label="性別"
                  value={form.gender}
                  onValueChange={(gender) => set({ gender })}
                  placeholder="選択してください"
                  options={[
                    { value: 'female', label: '女性' },
                    { value: 'male', label: '男性' },
                    { value: 'other', label: 'その他' },
                  ]}
                />
              </div>
              <div className="sy-2">
                <Label htmlFor="customer-birthday">生年月日</Label>
                <Input
                  id="customer-birthday"
                  type="date"
                  value={form.birthday}
                  onChange={(e) => set({ birthday: e.target.value })}
                />
              </div>
            </div>
            <div className="sy-2">
              <Label htmlFor="customer-occupation">職業</Label>
              <Input
                id="customer-occupation"
                value={form.occupation}
                onChange={(e) => set({ occupation: e.target.value })}
                placeholder="会社員"
              />
            </div>
            <Separator />
            <div className="grid grid-cols-2 gap-4">
              <div className="sy-2">
                <Label htmlFor="customer-phone">電話番号</Label>
                <Input
                  id="customer-phone"
                  type="tel"
                  value={form.phone}
                  onChange={(e) => set({ phone: e.target.value })}
                  placeholder="090-1234-5678"
                />
              </div>
              <div className="sy-2">
                <Label htmlFor="customer-email">メールアドレス</Label>
                <Input
                  id="customer-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => set({ email: e.target.value })}
                  placeholder="example@email.com"
                />
              </div>
            </div>
            <Separator />
            <div className="grid grid-cols-3 gap-4">
              <div className="sy-2">
                <Label htmlFor="customer-postal">郵便番号</Label>
                <div className="relative">
                  <Input
                    id="customer-postal"
                    value={form.postal_code}
                    onChange={(e) => void onPostalCode(e.target.value)}
                    placeholder="123-4567"
                  />
                  {searchingAddress ? (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="col-span-2 sy-2">
                <Label htmlFor="customer-address">住所</Label>
                <Input
                  id="customer-address"
                  value={form.address}
                  onChange={(e) => set({ address: e.target.value })}
                  placeholder="東京都渋谷区..."
                />
              </div>
            </div>
            <Separator />
            <div className="sy-2">
              <Label>担当スタッフ</Label>
              <Select
                label="担当スタッフ"
                value={form.staff_id}
                onValueChange={(staff_id) => set({ staff_id })}
                placeholder="担当未設定"
                options={[
                  { value: 'none', label: '担当未設定' },
                  ...(staffQ.data ?? []).map((s) => ({ value: s.id, label: s.display_name })),
                ]}
              />
            </div>
            <div className="sy-2">
              <Label htmlFor="customer-memo">メモ</Label>
              <Textarea
                id="customer-memo"
                value={form.memo}
                onChange={(e) => set({ memo: e.target.value })}
                placeholder="特記事項など"
                rows={3}
              />
            </div>
            <Separator />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => navigate(-1)}>
                キャンセル
              </Button>
              <Button onClick={() => void submit()} disabled={saving}>
                {saving ? '登録中...' : '登録する'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
