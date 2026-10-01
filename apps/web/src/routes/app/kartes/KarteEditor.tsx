import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useCustomer } from '../../../api/customers';
import {
  chemicalsToInput,
  karteKeys,
  kartesApi,
  useKarte,
  useKarteTemplates,
  type Chemical,
  type FieldValues,
  type KarteDetail,
} from '../../../api/kartes';
import { useStaffList } from '../../../api/org';
import {
  CustomerPicker,
  type PickedCustomer,
} from '../../../components/appointments/CustomerPicker';
import {
  DynamicField,
  compactValues,
  fieldErrorsFromApi,
  validateFields,
} from '../../../components/forms/DynamicField';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  Field,
  Icon,
  IconButton,
  Input,
  PageHeader,
  PageSpinner,
  Select,
  Textarea,
  useToast,
} from '../../../components/ui';
import { errorMessage, isApiError, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDate } from '../../../lib/format';
import { useStableKey } from '../../../lib/hooks';
import { todayIn } from '../../../lib/time';
import { HomecareProducts } from './HomecareProducts';
import { KarteAssets } from './KarteAssets';
import { KarteSharePanel } from './KarteSharePanel';

interface FormState {
  customer: PickedCustomer | null;
  templateId: string;
  visitDate: string;
  staffId: string;
  appointmentId: string | null;
  fields: FieldValues;
  chemicals: Chemical[];
  note: string;
  advice: string;
  products: { id: string; name: string }[];
}

function fromKarte(k: KarteDetail, customerName: string): FormState {
  return {
    customer: { id: k.customer_id, name: customerName },
    templateId: k.template_id ?? '',
    visitDate: k.visit_date,
    staffId: k.staff_id,
    appointmentId: k.appointment_id,
    fields: k.fields ?? {},
    chemicals: chemicalsToInput(k.chemicals),
    note: k.note ?? '',
    advice: k.homecare?.advice ?? '',
    products: k.homecare_products.map((p) => ({ id: p.id, name: p.name })),
  };
}

export default function KarteEditor() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const q = useKarte(isNew ? null : id);
  if (!isNew && q.isLoading) return <PageSpinner />;
  if (!isNew && (q.error || !q.data)) {
    return (
      <div className="mx-auto max-w-xl">
        <ErrorState
          error={q.error ?? new Error('カルテが見つかりません')}
          onRetry={() => void q.refetch()}
        />
      </div>
    );
  }
  return <Editor key={q.data ? `${q.data.id}:${q.data.version}` : 'new'} karte={q.data ?? null} />;
}

function Editor({ karte }: { karte: KarteDetail | null }) {
  const { can, currentShopId, timezone: tz, me } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const shopId = karte?.shop_id ?? currentShopId ?? '';
  const writable = can('karte.write');
  const templates = useKarteTemplates(shopId);
  const staff = useStaffList({ shopId });
  const customerId = karte?.customer_id ?? params.get('customerId') ?? '';
  const customerQ = useCustomer(customerId || null);
  const customerName = customerQ.data?.display_name ?? '';
  const [key, regenerate] = useStableKey(newIdempotencyKey);

  const [f, setF] = useState<FormState>(() =>
    karte
      ? fromKarte(karte, '')
      : {
          customer: null,
          templateId: '',
          visitDate: todayIn(tz),
          staffId: me?.staff.id ?? '',
          appointmentId: params.get('appointmentId'),
          fields: {},
          chemicals: [],
          note: '',
          advice: '',
          products: [],
        },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dirty, setDirty] = useState(false);

  // customer name / default template arrive asynchronously
  useEffect(() => {
    if (
      customerQ.data &&
      (!f.customer || f.customer.id === customerQ.data.id) &&
      !f.customer?.name
    ) {
      setF((x) => ({
        ...x,
        customer: { id: customerQ.data!.id, name: customerQ.data!.display_name },
      }));
    }
  }, [customerQ.data, f.customer]);
  useEffect(() => {
    if (!karte && !f.templateId && templates.data?.length) {
      const def =
        templates.data.find((t) => t.is_default && t.status === 'active') ??
        templates.data.find((t) => t.status === 'active');
      if (def) setF((x) => ({ ...x, templateId: def.id }));
    }
  }, [karte, f.templateId, templates.data]);

  const template = useMemo(
    () =>
      templates.data?.find((t) => t.id === f.templateId) ??
      (karte?.template && karte.template.id === f.templateId ? { ...karte.template } : null),
    [templates.data, f.templateId, karte],
  );
  const fields = useMemo(() => template?.fields ?? [], [template]);

  const latest = useQuery({
    queryKey: ['kartes', 'latest', f.customer?.id ?? ''],
    queryFn: () => kartesApi.latest(f.customer!.id),
    enabled: !karte && !!f.customer?.id,
  });

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setDirty(true);
  };

  const save = async () => {
    if (!f.customer) return setError(new Error('お客様を選択してください'));
    const errs = validateFields(fields, f.fields);
    const chemErr = f.chemicals.findIndex((c) => !c.name.trim());
    if (chemErr >= 0) errs[`chemical.${chemErr}`] = '薬剤名を入力してください';
    setErrors(errs);
    if (Object.keys(errs).length) {
      window.setTimeout(
        () => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
        0,
      );
      return;
    }
    const body = {
      templateId: f.templateId || null,
      visitDate: f.visitDate,
      staffId: f.staffId || undefined,
      fields: template ? compactValues(fields, f.fields) : f.fields,
      chemicals: f.chemicals.map((c) => ({
        name: c.name.trim(),
        brand: c.brand?.trim() || null,
        ratio: c.ratio?.trim() || null,
        processingMin: c.processingMin ?? null,
        note: c.note?.trim() || null,
      })),
      note: f.note.trim() || null,
      homecare: { advice: f.advice.trim() || null, productIds: f.products.map((p) => p.id) },
    };
    setSaving(true);
    setError(null);
    try {
      if (karte) {
        const updated = await kartesApi.update(karte.id, { ...body, version: karte.version });
        qc.setQueryData(karteKeys.detail(karte.id), updated);
        void qc.invalidateQueries({ queryKey: ['kartes', 'list'] });
        toast.success('カルテを保存しました');
        setDirty(false);
      } else {
        const created = await kartesApi.create(
          {
            ...body,
            customerId: f.customer.id,
            shopId,
            appointmentId: f.appointmentId,
            staffId: f.staffId || null,
          },
          key,
        );
        regenerate();
        void qc.invalidateQueries({ queryKey: karteKeys.all });
        toast.success('カルテを作成しました', '写真の追加・共有ができます');
        navigate(`/app/kartes/${created.id}`, { replace: true });
      }
    } catch (e) {
      setError(e);
      if (isApiError(e)) {
        if (e.status > 0 && !karte) regenerate();
        setErrors(fieldErrorsFromApi(e.fieldErrors(), 'fields'));
      }
    } finally {
      setSaving(false);
    }
  };

  const duplicateLatest = async () => {
    const src = latest.data?.karte;
    if (!src) return;
    setSaving(true);
    try {
      const created = await kartesApi.duplicate(src.id, {
        shopId,
        appointmentId: f.appointmentId,
        staffId: f.staffId || null,
        visitDate: f.visitDate,
      });
      void qc.invalidateQueries({ queryKey: karteKeys.all });
      toast.success('前回カルテを複製しました', '内容を確認して保存してください');
      navigate(`/app/kartes/${created.id}`, { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!karte) return;
    try {
      await kartesApi.remove(karte.id);
      void qc.invalidateQueries({ queryKey: karteKeys.all });
      toast.success('カルテを削除しました');
      navigate(`/app/customers/${karte.customer_id}?tab=kartes`);
    } catch (e) {
      toast.error(e);
    } finally {
      setDeleting(false);
    }
  };

  const conflict = isApiError(error) && error.code === 'VERSION_CONFLICT';

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        back={
          <Link
            to={f.customer ? `/app/customers/${f.customer.id}?tab=kartes` : '/app/kartes'}
            className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg"
          >
            <Icon name="chevron-left" size={16} />{' '}
            {f.customer ? `${customerName || f.customer.name} 様` : 'カルテ'}
          </Link>
        }
        title={karte ? `カルテ ${formatDate(karte.visit_date, tz)}` : '新しいカルテ'}
        description={
          karte
            ? `${karte.staff_name ?? ''} ・ 版 ${karte.version}${karte.duplicated_from ? ' ・ 前回から複製' : ''}`
            : undefined
        }
        actions={
          writable ? (
            <>
              {karte ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="!text-danger"
                  icon="trash"
                  onClick={() => setDeleting(true)}
                >
                  削除
                </Button>
              ) : null}
              <Button
                variant="primary"
                icon="check"
                loading={saving}
                onClick={() => void save()}
                data-testid="save-karte"
              >
                {karte ? '保存' : '作成'}
              </Button>
            </>
          ) : null
        }
      />

      {conflict ? (
        <Alert
          tone="warning"
          className="mb-4"
          title="他のスタッフがこのカルテを更新しました"
          action={
            <Button
              size="xs"
              variant="secondary"
              icon="refresh"
              onClick={() => {
                setError(null);
                void qc.invalidateQueries({ queryKey: karteKeys.detail(karte!.id) });
              }}
            >
              最新を読み込む
            </Button>
          }
        >
          最新の内容を読み込むと、未保存の変更は破棄されます。必要な内容は控えてから読み込んでください。
        </Alert>
      ) : error ? (
        <Alert tone="danger" className="mb-4">
          {errorMessage(error)}
        </Alert>
      ) : null}
      {dirty && karte ? <p className="mb-3 text-xs text-warning">未保存の変更があります</p> : null}

      {!karte && writable && latest.data?.karte ? (
        <Alert
          tone="info"
          className="mb-4"
          title={`前回カルテ（${formatDate(latest.data.karte.visit_date, tz)}）があります`}
          action={
            <Button size="sm" icon="copy" loading={saving} onClick={() => void duplicateLatest()}>
              前回カルテを複製
            </Button>
          }
        >
          テンプレート・項目・薬剤・ホームケアをコピーして新しいカルテを作成します（写真・メモはコピーされません）。
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title="基本情報" />
            <div className="grid gap-4 sm:grid-cols-2">
              {karte || customerId ? (
                <Field label="お客様">
                  <Input value={customerName || f.customer?.name || ''} readOnly />
                </Field>
              ) : (
                <CustomerPicker value={f.customer} onChange={(c) => set('customer', c)} />
              )}
              <Field label="来店日" required>
                <Input
                  type="date"
                  value={f.visitDate}
                  onChange={(e) => set('visitDate', e.target.value)}
                  disabled={!writable}
                />
              </Field>
              <Field label="担当">
                <Select
                  value={f.staffId}
                  onChange={(e) => set('staffId', e.target.value)}
                  disabled={!writable}
                >
                  <option value="">（自分）</option>
                  {(staff.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.display_name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="テンプレート">
                <Select
                  value={f.templateId}
                  onChange={(e) => set('templateId', e.target.value)}
                  disabled={!writable}
                >
                  <option value="">自由記入（テンプレートなし）</option>
                  {(templates.data ?? [])
                    .filter((t) => t.status === 'active' || t.id === f.templateId)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
          </Card>

          {fields.length ? (
            <Card>
              <CardHeader
                title={template?.name ?? '施術内容'}
                description="お客様に共有される項目には「共有」マークが付いています"
              />
              <div className="grid gap-4 sm:grid-cols-2">
                {fields.map((fd) => (
                  <div
                    key={fd.key}
                    className={
                      fd.type === 'textarea' ||
                      fd.type === 'multiselect' ||
                      fd.type === 'color_formula'
                        ? 'sm:col-span-2'
                        : undefined
                    }
                  >
                    <DynamicField
                      field={{
                        ...fd,
                        label: fd.customerVisible ? `${fd.label}（共有）` : fd.label,
                      }}
                      value={f.fields[fd.key]}
                      onChange={(v) => {
                        set('fields', { ...f.fields, [fd.key]: v });
                        if (errors[fd.key]) setErrors((x) => ({ ...x, [fd.key]: '' }));
                      }}
                      error={errors[fd.key] || null}
                      disabled={!writable}
                    />
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="使用薬剤"
              actions={
                writable ? (
                  <Button
                    size="sm"
                    icon="plus"
                    onClick={() => set('chemicals', [...f.chemicals, { name: '' }])}
                    disabled={f.chemicals.length >= 50}
                  >
                    薬剤を追加
                  </Button>
                ) : null
              }
            />
            {f.chemicals.length ? (
              <ul className="space-y-3">
                {f.chemicals.map((c, i) => {
                  const upd = (patch: Partial<Chemical>) =>
                    set(
                      'chemicals',
                      f.chemicals.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                    );
                  return (
                    <li
                      key={i}
                      className="grid grid-cols-2 gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1.5fr_1fr_1fr_6rem_auto]"
                    >
                      <Field
                        label="薬剤名"
                        error={errors[`chemical.${i}`] || null}
                        className="col-span-2 sm:col-span-1"
                      >
                        <Input
                          value={c.name}
                          onChange={(e) => upd({ name: e.target.value })}
                          disabled={!writable}
                          inputSize="sm"
                        />
                      </Field>
                      <Field label="メーカー">
                        <Input
                          value={c.brand ?? ''}
                          onChange={(e) => upd({ brand: e.target.value })}
                          disabled={!writable}
                          inputSize="sm"
                        />
                      </Field>
                      <Field label="配合">
                        <Input
                          value={c.ratio ?? ''}
                          onChange={(e) => upd({ ratio: e.target.value })}
                          disabled={!writable}
                          inputSize="sm"
                          placeholder="1:1 6%"
                        />
                      </Field>
                      <Field label="放置(分)">
                        <Input
                          type="number"
                          min={0}
                          max={600}
                          value={c.processingMin ?? ''}
                          onChange={(e) =>
                            upd({
                              processingMin: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                          disabled={!writable}
                          inputSize="sm"
                        />
                      </Field>
                      <div className="flex items-end">
                        {writable ? (
                          <IconButton
                            icon="trash"
                            label={`薬剤${i + 1}を削除`}
                            size="sm"
                            onClick={() =>
                              set(
                                'chemicals',
                                f.chemicals.filter((_, j) => j !== i),
                              )
                            }
                          />
                        ) : null}
                      </div>
                      <Field label="メモ" className="col-span-2 sm:col-span-5">
                        <Input
                          value={c.note ?? ''}
                          onChange={(e) => upd({ note: e.target.value })}
                          disabled={!writable}
                          inputSize="sm"
                        />
                      </Field>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">薬剤の記録はありません。</p>
            )}
          </Card>

          <Card>
            <CardHeader title="ホームケア" description="お客様への共有ページに表示されます" />
            <div className="space-y-4">
              <Field label="アドバイス">
                <Textarea
                  value={f.advice}
                  onChange={(e) => set('advice', e.target.value)}
                  rows={3}
                  maxLength={5000}
                  disabled={!writable}
                  placeholder="例: 2日間はシャンプーを控えめに。カラー用シャンプーをおすすめします。"
                />
              </Field>
              <HomecareProducts
                shopId={shopId}
                value={f.products}
                onChange={(v) => set('products', v)}
                disabled={!writable}
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="スタッフメモ" description="お客様には共有されません" />
            <Textarea
              value={f.note}
              onChange={(e) => set('note', e.target.value)}
              rows={3}
              maxLength={10000}
              disabled={!writable}
              aria-label="スタッフメモ"
            />
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          {karte ? (
            <>
              <KarteAssets karte={karte} writable={writable} />
              <KarteSharePanel karte={karte} writable={writable} />
            </>
          ) : (
            <Card>
              <CardHeader title="写真・共有" />
              <p className="text-[13px] text-muted">
                カルテを作成すると、ビフォー/アフター写真の追加とお客様への共有ができます。
              </p>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="カルテを削除しますか？"
        description="共有リンクも無効になります。"
        tone="danger"
        confirmLabel="削除する"
        onConfirm={() => void remove()}
      />
    </div>
  );
}
