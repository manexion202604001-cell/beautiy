import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { catalogApi, catalogKeys, useCategories, useResources } from '../../../api/catalog';
import { useStaffList } from '../../../api/org';
import type { EffectiveMenu, MenuInput } from '../../../api/types';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Field,
  IconButton,
  InlineLoading,
  Input,
  Segmented,
  Select,
  Textarea,
  useToast,
} from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { resourceTypeLabel } from './shared';

interface FormState {
  scope: 'common' | 'shop';
  categoryId: string;
  name: string;
  description: string;
  durationMin: string;
  bufferBeforeMin: string;
  bufferAfterMin: string;
  price: string;
  priceTaxIncluded: boolean;
  taxRateBp: '1000' | '800';
  isPublic: boolean;
  isConsultation: boolean;
  newCustomerOnly: boolean;
  sortOrder: string;
  status: 'active' | 'inactive';
  requirements: { resourceType: string; offsetMin: string; durationMin: string }[];
  staffIds: string[];
}

const empty = (allShops: boolean): FormState => ({
  scope: allShops ? 'common' : 'shop',
  categoryId: '',
  name: '',
  description: '',
  durationMin: '60',
  bufferBeforeMin: '0',
  bufferAfterMin: '0',
  price: '',
  priceTaxIncluded: true,
  taxRateBp: '1000',
  isPublic: true,
  isConsultation: false,
  newCustomerOnly: false,
  sortOrder: '0',
  status: 'active',
  requirements: [],
  staffIds: [],
});

/** Create / edit menu (base values; per-shop overrides live in OverrideDialog) */
export function MenuDialog({
  shopId,
  menu,
  onClose,
}: {
  shopId: string;
  menu: EffectiveMenu | null;
  onClose: () => void;
}) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const allShops = !!me?.allShops;
  const cats = useCategories(shopId);
  const resources = useResources(shopId);
  const staff = useStaffList({ shopId, bookableOnly: true });
  const detail = useQuery({
    queryKey: catalogKeys.menu(menu?.id ?? ''),
    queryFn: () => catalogApi.menu(menu!.id),
    enabled: !!menu,
  });
  const [f, setF] = useState<FormState>(() => empty(allShops));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const d = detail.data;
    if (!d) return;
    setF({
      scope: d.shop_id ? 'shop' : 'common',
      categoryId: d.category_id ?? '',
      name: d.name,
      description: d.description ?? '',
      durationMin: String(d.duration_min),
      bufferBeforeMin: String(d.buffer_before_min),
      bufferAfterMin: String(d.buffer_after_min),
      price: String(d.price),
      priceTaxIncluded: d.price_tax_included,
      taxRateBp: d.tax_rate_bp === 800 ? '800' : '1000',
      isPublic: d.is_public,
      isConsultation: d.is_consultation,
      newCustomerOnly: d.new_customer_only,
      sortOrder: String(d.sort_order),
      status: d.status,
      requirements: d.resourceRequirements.map((r) => ({
        resourceType: r.resource_type,
        offsetMin: String(r.offset_min),
        durationMin: r.duration_min ? String(r.duration_min) : '',
      })),
      staffIds: d.staff.map((s) => s.staff_id),
    });
  }, [detail.data]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const resourceTypes = [
    ...new Set([
      ...(resources.data ?? []).map((r) => r.resource_type),
      ...f.requirements.map((r) => r.resourceType),
    ]),
  ];

  const save = async () => {
    const errs: Record<string, string> = {};
    const duration = Number(f.durationMin);
    const price = Number(f.price);
    if (!f.name.trim()) errs.name = 'メニュー名を入力してください';
    if (!Number.isInteger(duration) || duration < 5 || duration > 720)
      errs.durationMin = '5〜720分で入力してください';
    if (f.price === '' || !Number.isInteger(price) || price < 0)
      errs.price = '0以上の整数（円）で入力してください';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const input: MenuInput = {
      categoryId: f.categoryId || null,
      name: f.name.trim(),
      description: f.description.trim() || null,
      durationMin: duration,
      bufferBeforeMin: Number(f.bufferBeforeMin) || 0,
      bufferAfterMin: Number(f.bufferAfterMin) || 0,
      price,
      priceTaxIncluded: f.priceTaxIncluded,
      taxRateBp: Number(f.taxRateBp),
      isPublic: f.isPublic,
      isConsultation: f.isConsultation,
      newCustomerOnly: f.newCustomerOnly,
      sortOrder: Number(f.sortOrder) || 0,
      resourceRequirements: f.requirements
        .filter((r) => r.resourceType)
        .map((r) => ({
          resourceType: r.resourceType,
          offsetMin: Number(r.offsetMin) || 0,
          durationMin: r.durationMin ? Number(r.durationMin) : null,
        })),
      staffIds: f.staffIds,
    };
    setSaving(true);
    setError(null);
    try {
      if (menu) await catalogApi.updateMenu(menu.id, { ...input, status: f.status });
      else await catalogApi.createMenu({ ...input, shopId: f.scope === 'shop' ? shopId : null });
      void qc.invalidateQueries({ queryKey: catalogKeys.all });
      toast.success(menu ? 'メニューを更新しました' : 'メニューを追加しました');
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
      title={menu ? 'メニューを編集' : 'メニューを追加'}
      dismissable={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={save}
            disabled={!!menu && !detail.data}
          >
            保存
          </Button>
        </>
      }
    >
      {menu && detail.isLoading ? <InlineLoading /> : null}
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <div className="space-y-5">
        {!menu ? (
          <div>
            <p className="mb-1.5 text-[13px] font-medium">対象店舗</p>
            <Segmented
              label="対象店舗"
              value={f.scope}
              onChange={(v) => set('scope', v)}
              options={[
                { value: 'common', label: '全店舗共通', disabled: !allShops },
                { value: 'shop', label: 'この店舗のみ' },
              ]}
            />
            {!allShops ? (
              <p className="mt-1 text-xs text-muted">
                共通メニューの作成には全店舗権限が必要です。
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="メニュー名" required error={errors.name} className="sm:col-span-2">
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={100} />
          </Field>
          <Field label="カテゴリ">
            <Select value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">未分類</option>
              {(cats.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="表示順">
            <Input
              type="number"
              value={f.sortOrder}
              onChange={(e) => set('sortOrder', e.target.value)}
            />
          </Field>
          <Field label="説明" optional className="sm:col-span-2">
            <Textarea
              value={f.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
              maxLength={2000}
            />
          </Field>
        </div>

        <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="mb-2 text-[13px] font-semibold">時間</legend>
          <Field label="所要時間" required error={errors.durationMin}>
            <Input
              type="number"
              min={5}
              max={720}
              step={5}
              value={f.durationMin}
              onChange={(e) => set('durationMin', e.target.value)}
              trailing="分"
            />
          </Field>
          <Field label="前バッファ" hint="準備時間">
            <Input
              type="number"
              min={0}
              max={240}
              step={5}
              value={f.bufferBeforeMin}
              onChange={(e) => set('bufferBeforeMin', e.target.value)}
              trailing="分"
            />
          </Field>
          <Field label="後バッファ" hint="片付け・清掃">
            <Input
              type="number"
              min={0}
              max={240}
              step={5}
              value={f.bufferAfterMin}
              onChange={(e) => set('bufferAfterMin', e.target.value)}
              trailing="分"
            />
          </Field>
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="mb-2 text-[13px] font-semibold">料金</legend>
          <Field label="料金" required error={errors.price}>
            <Input
              type="number"
              min={0}
              step={10}
              value={f.price}
              onChange={(e) => set('price', e.target.value)}
              leading="¥"
            />
          </Field>
          <Field label="税率">
            <Select
              value={f.taxRateBp}
              onChange={(e) => set('taxRateBp', e.target.value as '1000' | '800')}
            >
              <option value="1000">10%（標準税率）</option>
              <option value="800">8%（軽減税率）</option>
            </Select>
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox
              label="税込価格"
              checked={f.priceTaxIncluded}
              onChange={(e) => set('priceTaxIncluded', e.target.checked)}
            />
          </div>
        </fieldset>

        <fieldset className="space-y-2.5">
          <legend className="mb-2 text-[13px] font-semibold">予約設定</legend>
          <Checkbox
            label="Web/LINE予約に公開"
            description="オフにすると店内での予約登録のみ可能になります"
            checked={f.isPublic}
            onChange={(e) => set('isPublic', e.target.checked)}
          />
          <Checkbox
            label="相談予約（カウンセリングのみ）"
            checked={f.isConsultation}
            onChange={(e) => set('isConsultation', e.target.checked)}
          />
          <Checkbox
            label="新規のお客様限定"
            checked={f.newCustomerOnly}
            onChange={(e) => set('newCustomerOnly', e.target.checked)}
          />
          {menu ? (
            <Checkbox
              label="提供を停止する"
              checked={f.status === 'inactive'}
              onChange={(e) => set('status', e.target.checked ? 'inactive' : 'active')}
            />
          ) : null}
        </fieldset>

        <fieldset>
          <legend className="mb-1 text-[13px] font-semibold">必要な席・設備</legend>
          <p className="mb-2 text-xs text-muted">
            開始からのオフセットと使用時間（空欄＝メニュー終了まで）を指定します。
          </p>
          <div className="space-y-2">
            {f.requirements.map((r, i) => (
              <div
                key={i}
                className="flex flex-wrap items-end gap-2 rounded-xl bg-surface-2/60 p-2"
              >
                <div className="w-44">
                  <label className="mb-1 block text-xs" htmlFor={`req-type-${i}`}>
                    種類
                  </label>
                  <Select
                    id={`req-type-${i}`}
                    selectSize="sm"
                    value={r.resourceType}
                    onChange={(e) =>
                      set(
                        'requirements',
                        f.requirements.map((x, j) =>
                          j === i ? { ...x, resourceType: e.target.value } : x,
                        ),
                      )
                    }
                  >
                    <option value="">選択</option>
                    {resourceTypes.map((t) => (
                      <option key={t} value={t}>
                        {resourceTypeLabel(t)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="w-28">
                  <label className="mb-1 block text-xs" htmlFor={`req-off-${i}`}>
                    開始から（分）
                  </label>
                  <Input
                    id={`req-off-${i}`}
                    inputSize="sm"
                    type="number"
                    min={0}
                    value={r.offsetMin}
                    onChange={(e) =>
                      set(
                        'requirements',
                        f.requirements.map((x, j) =>
                          j === i ? { ...x, offsetMin: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </div>
                <div className="w-28">
                  <label className="mb-1 block text-xs" htmlFor={`req-dur-${i}`}>
                    使用時間（分）
                  </label>
                  <Input
                    id={`req-dur-${i}`}
                    inputSize="sm"
                    type="number"
                    min={5}
                    value={r.durationMin}
                    placeholder="終了まで"
                    onChange={(e) =>
                      set(
                        'requirements',
                        f.requirements.map((x, j) =>
                          j === i ? { ...x, durationMin: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </div>
                <IconButton
                  icon="trash"
                  label="この設備条件を削除"
                  size="sm"
                  onClick={() =>
                    set(
                      'requirements',
                      f.requirements.filter((_, j) => j !== i),
                    )
                  }
                />
              </div>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            className="mt-2"
            disabled={!resourceTypes.length}
            onClick={() =>
              set('requirements', [
                ...f.requirements,
                { resourceType: resourceTypes[0] ?? '', offsetMin: '0', durationMin: '' },
              ])
            }
          >
            設備条件を追加
          </Button>
          {!resourceTypes.length ? (
            <p className="text-xs text-muted">先に「席・設備」タブで設備を登録してください。</p>
          ) : null}
        </fieldset>

        <fieldset>
          <legend className="mb-1 text-[13px] font-semibold">担当可能スタッフ</legend>
          <p className="mb-2 text-xs text-muted">選択しない場合は全スタッフが担当できます。</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(staff.data ?? []).map((s) => (
              <Checkbox
                key={s.id}
                label={s.display_name}
                description={s.title ?? undefined}
                checked={f.staffIds.includes(s.id)}
                onChange={(e) =>
                  set(
                    'staffIds',
                    e.target.checked ? [...f.staffIds, s.id] : f.staffIds.filter((x) => x !== s.id),
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
