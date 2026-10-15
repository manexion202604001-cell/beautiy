import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { CounselingSheetData, FieldValues } from '../../api/kartes';
import { consentSections, walkinApi } from '../../api/walkin';
import {
  DynamicField,
  compactValues,
  fieldErrorsFromApi,
  validateFields,
} from '../../components/forms/DynamicField';
import { SignaturePad } from '../../components/forms/SignaturePad';
import { Slider } from '../../components/shad/slider';
import { Alert, Button, Checkbox, EmptyState, Field, Icon, Input, PageSpinner, Textarea } from '../../components/ui';
import { errorMessage, isApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import {
  COUNSELING_CATEGORIES,
  type CounselingCategory,
  type CounselingQuestion,
} from '../app/customers/counselingQuestions';
import { PublicShell, ShopHeader } from './PublicShell';

type Answer = string | string[];
type CategoryAnswers = Record<string, Answer>;

const blank = (v: Answer | undefined) => v === undefined || (Array.isArray(v) ? v.length === 0 : v.trim() === '');

/** A question is shown only while the question it depends on has one of the listed answers */
function visible(q: CounselingQuestion, answers: CategoryAnswers) {
  if (!q.showWhen) return true;
  const other = answers[q.showWhen.questionId];
  return typeof other === 'string' && q.showWhen.values.includes(other);
}

/** Follow-up inputs of a radio_with_text question are open for its trigger answer(s) (default: the first option) */
function subFieldsOpen(q: CounselingQuestion, value: Answer | undefined) {
  if (!q.subFields?.length || typeof value !== 'string' || !value) return false;
  const trigger = q.subFieldTrigger ?? q.options?.[0];
  return Array.isArray(trigger) ? trigger.includes(value) : value === trigger;
}

/** What is sent for one category: answered, currently visible questions only */
function answeredOf(category: CounselingCategory, answers: CategoryAnswers): CategoryAnswers {
  const out: CategoryAnswers = {};
  for (const q of category.questions) {
    if (!visible(q, answers)) continue;
    const v = answers[q.id];
    if (!blank(v)) out[q.id] = typeof v === 'string' ? v.trim() : v!;
    if (subFieldsOpen(q, v)) {
      for (const f of q.subFields ?? []) {
        const sv = answers[f.id];
        if (!blank(sv)) out[f.id] = typeof sv === 'string' ? sv.trim() : sv!;
      }
    }
  }
  return out;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'rounded-full border px-4 py-2 text-sm transition-colors',
        on ? 'border-primary bg-primary-soft font-medium text-primary' : 'border-border bg-surface text-fg',
      )}
    >
      {on ? '✓ ' : ''}
      {children}
    </button>
  );
}

/** One question of the counselling sheet, sized for a phone */
function CounselingField({
  q,
  answers,
  onChange,
}: {
  q: CounselingQuestion;
  answers: CategoryAnswers;
  onChange: (id: string, value: Answer) => void;
}) {
  const value = answers[q.id];
  const text = typeof value === 'string' ? value : '';
  const legend = <p className="mb-1.5 text-[13px] font-medium text-fg">{q.label}</p>;
  switch (q.type) {
    case 'text':
      return (
        <Field label={q.label}>
          {q.label.includes('質問') || q.label.includes('要望') ? (
            <Textarea value={text} onChange={(e) => onChange(q.id, e.target.value)} rows={3} maxLength={2000} className="text-base" />
          ) : (
            <Input value={text} onChange={(e) => onChange(q.id, e.target.value)} inputSize="lg" maxLength={500} />
          )}
        </Field>
      );
    case 'multi_select': {
      const list = Array.isArray(value) ? value : [];
      return (
        <div role="group" aria-label={q.label}>
          {legend}
          <div className="flex flex-wrap gap-2">
            {(q.options ?? []).map((o) => (
              <Chip key={o} on={list.includes(o)} onClick={() => onChange(q.id, list.includes(o) ? list.filter((x) => x !== o) : [...list, o])}>
                {o}
              </Chip>
            ))}
          </div>
        </div>
      );
    }
    case 'slider':
      return (
        <div>
          {legend}
          <div className="px-1 py-2">
            <Slider label={q.label} value={text === '' ? 50 : Number(text)} onValueChange={(v) => onChange(q.id, String(v))} max={100} step={25} />
          </div>
          {q.sliderLabels ? (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{q.sliderLabels[0]}</span>
              <span>{text === '' ? '未選択（動かして選択）' : ''}</span>
              <span>{q.sliderLabels[1]}</span>
            </div>
          ) : null}
        </div>
      );
    case 'radio':
    case 'radio_with_text':
      return (
        <div role="group" aria-label={q.label}>
          {legend}
          <div className="flex flex-wrap gap-2">
            {(q.options ?? []).map((o) => (
              <Chip key={o} on={value === o} onClick={() => onChange(q.id, value === o ? '' : o)}>
                {o}
              </Chip>
            ))}
          </div>
          {subFieldsOpen(q, value) ? (
            <div className="ml-3 mt-3 space-y-3 border-l-2 border-border pl-3">
              {(q.subFields ?? []).map((f) => {
                const sv = answers[f.id];
                return (
                  <Field key={f.id} label={f.label}>
                    <Input value={typeof sv === 'string' ? sv : ''} onChange={(e) => onChange(f.id, e.target.value)} inputSize="lg" maxLength={500} />
                  </Field>
                );
              })}
            </div>
          ) : null}
        </div>
      );
    default:
      return null;
  }
}

interface Profile {
  lastName: string;
  firstName: string;
  lastNameKana: string;
  firstNameKana: string;
  birthday: string;
  phone: string;
  occupation: string;
  visitReason: string;
}

const EMPTY: Profile = {
  lastName: '',
  firstName: '',
  lastNameKana: '',
  firstNameKana: '',
  birthday: '',
  phone: '',
  occupation: '',
  visitReason: '',
};

function validateProfile(p: Profile): Record<string, string> {
  const e: Record<string, string> = {};
  if (!p.lastName.trim()) e.lastName = '姓を入力してください';
  if (!p.firstName.trim()) e.firstName = '名を入力してください';
  if (!p.lastNameKana.trim()) e.lastNameKana = 'セイを入力してください';
  if (!p.firstNameKana.trim()) e.firstNameKana = 'メイを入力してください';
  if (!p.birthday) e.birthday = '生年月日を入力してください';
  else if (p.birthday > new Date().toISOString().slice(0, 10)) e.birthday = '生年月日が正しくありません';
  if (p.phone.replace(/\D/g, '').length < 10) e.phone = '電話番号を入力してください';
  return e;
}

const focusFirstInvalid = () =>
  window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);

/**
 * /consent/:shopSlug[?staff=…&form=…] — reception for customers without a reservation:
 * read the consent, enter name / kana / birthday / phone / occupation / visit reason, agree,
 * then (optionally) fill the counselling sheet of today's treatment (髪 / 目 / エクステ / 眉 /
 * ネイル / 顔 / 体). Staff pick the submission up in 同意書一覧.
 */
export default function WalkinConsent() {
  const { shopSlug = '' } = useParams();
  const [params] = useSearchParams();
  const staff = params.get('staff') ?? undefined;
  const form = params.get('form') ?? undefined;
  const q = useQuery({
    queryKey: ['public', 'walkin', shopSlug, staff, form],
    queryFn: () => walkinApi.publicView(shopSlug, { staff, form }),
    retry: false,
    staleTime: Infinity,
  });

  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [answers, setAnswers] = useState<FieldValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [agreed, setAgreed] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** set once the consent is submitted: token for the counselling sheet */
  const [token, setToken] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [category, setCategory] = useState<CounselingCategory | null>(null);
  /** answers typed so far, per category (kept while moving between categories) */
  const [sheet, setSheet] = useState<CounselingSheetData>({});
  const [filled, setFilled] = useState<string[]>([]);

  if (q.isLoading) return <PageSpinner />;
  if (q.error || !q.data) {
    const missing = isApiError(q.error) && q.error.status === 404;
    return (
      <PublicShell>
        <EmptyState
          className="mt-10"
          icon="lock"
          title={missing ? 'このQRコードは現在ご利用いただけません' : '読み込みに失敗しました'}
          description={missing ? 'お手数ですが、スタッフにお声がけください。' : errorMessage(q.error)}
        />
      </PublicShell>
    );
  }
  const v = q.data;
  const header = <ShopHeader name={v.shop.name} sub={v.staff ? `担当: ${v.staff.name}` : '受付'} />;

  if (!v.consent) {
    return (
      <PublicShell header={header}>
        <EmptyState
          className="mt-10"
          icon="file"
          title="同意書の準備ができていません"
          description="お手数ですが、スタッフにお声がけください。"
        />
      </PublicShell>
    );
  }
  const consent = v.consent;
  const signerName = `${profile.lastName} ${profile.firstName}`.trim();

  const set = (key: keyof Profile) => (e: { target: { value: string } }) => {
    setProfile((p) => ({ ...p, [key]: e.target.value }));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: '' }));
  };

  const submitConsent = async () => {
    const errs = { ...validateProfile(profile), ...validateFields(consent.fields, answers) };
    if (consent.requiresSignature && !signature) errs.__signature = '署名をお願いします';
    if (!agreed) errs.__agreed = '同意のチェックをお願いします';
    setErrors(errs);
    if (Object.keys(errs).length) {
      setError('未入力の項目があります');
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await walkinApi.publicSubmit(shopSlug, {
        staffId: v.staff?.id ?? null,
        templateId: consent.templateId,
        customer: {
          lastName: profile.lastName.trim(),
          firstName: profile.firstName.trim(),
          lastNameKana: profile.lastNameKana.trim(),
          firstNameKana: profile.firstNameKana.trim(),
          birthday: profile.birthday,
          phone: profile.phone.trim(),
          occupation: profile.occupation.trim() || null,
          visitReason: profile.visitReason.trim() || null,
        },
        agreed: true,
        answers: compactValues(consent.fields, answers),
        ...(signature ? { signature: { dataUrl: signature, signerName } } : {}),
      });
      setToken(res.token);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(
        isApiError(e) && e.code === 'TEMPLATE_INACTIVE'
          ? '同意書の内容が更新されました。ページを読み込み直してから、もう一度ご提出ください。'
          : errorMessage(e),
      );
      if (isApiError(e)) {
        const fe = e.fieldErrors();
        setErrors({ ...fieldErrorsFromApi(fe, 'answers'), ...fieldErrorsFromApi(fe, 'customer') });
      }
    } finally {
      setBusy(false);
    }
  };

  const openCategory = (c: CounselingCategory | null) => {
    setCategory(c);
    setError(null);
    window.scrollTo({ top: 0 });
  };

  const submitCategory = async () => {
    if (!category || !token) return;
    const answers = answeredOf(category, sheet[category.id] ?? {});
    if (!Object.keys(answers).length) {
      setError('ご記入のうえ送信してください');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await walkinApi.publicCounseling(token, { [category.id]: answers });
      setFilled((f) => (f.includes(category.id) ? f : [...f, category.id]));
      setCategory(null);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------- done
  if (finished) {
    return (
      <PublicShell header={header}>
        <div className="mt-10 flex flex-col items-center text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success">
            <Icon name="check" size={28} />
          </span>
          <h1 className="text-lg font-semibold">ご記入ありがとうございました</h1>
          <p className="mt-2 text-[13px] text-muted-foreground">
            内容はサロンに送信されました。スタッフがご案内しますので、そのままお待ちください。
          </p>
        </div>
      </PublicShell>
    );
  }

  // ---------------------------------------------------------------- counselling: one category being filled
  if (token && category) {
    const answers = sheet[category.id] ?? {};
    const setAnswer = (id: string, value: Answer) =>
      setSheet((d) => ({ ...d, [category.id]: { ...d[category.id], [id]: value } }));
    return (
      <PublicShell
        header={header}
        footer={
          <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
            <div className="mx-auto flex max-w-xl gap-2">
              <Button size="lg" className="flex-1" disabled={busy} onClick={() => openCategory(null)}>
                戻る
              </Button>
              <Button
                variant="primary"
                size="lg"
                className="flex-[2]"
                loading={busy}
                onClick={() => void submitCategory()}
                data-testid="submit-walkin-counseling"
              >
                送信する
              </Button>
            </div>
          </div>
        }
      >
        <h1 className="text-lg font-semibold">カウンセリングシート</h1>
        <p className="mb-4 text-[13px] text-muted-foreground">{category.label}</p>
        {error ? (
          <Alert tone="danger" className="mb-4">
            {error}
          </Alert>
        ) : null}
        <div className="space-y-5 rounded-2xl border border-border bg-surface p-4">
          {category.questions
            .filter((q) => visible(q, answers))
            .map((q) => (
              <CounselingField key={q.id} q={q} answers={answers} onChange={setAnswer} />
            ))}
        </div>
      </PublicShell>
    );
  }

  // ---------------------------------------------------------------- counselling: choose the category (after the consent)
  if (token) {
    return (
      <PublicShell
        header={header}
        footer={
          <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
            <div className="mx-auto max-w-xl">
              <Button
                variant={filled.length ? 'primary' : 'secondary'}
                size="lg"
                className="w-full"
                onClick={() => {
                  setFinished(true);
                  window.scrollTo({ top: 0 });
                }}
                data-testid="finish-walkin"
              >
                {filled.length ? '記入を終了する' : 'カウンセリングシートを記入せずに終了する'}
              </Button>
            </div>
          </div>
        }
      >
        <Alert tone="success" className="mb-4">
          同意書を提出しました。
        </Alert>
        <h1 className="text-lg font-semibold">カウンセリングシート</h1>
        <p className="mb-4 text-[13px] text-muted-foreground">
          本日の施術に当てはまるものを選んでご記入ください。
        </p>
        <ul className="space-y-2">
          {COUNSELING_CATEGORIES.map((c) => {
            const done = filled.includes(c.id);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => openCategory(c)}
                  className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 text-left"
                >
                  <span className="text-[15px] font-medium">{c.label}</span>
                  <span className={done ? 'text-xs font-medium text-success' : 'text-xs text-muted-foreground'}>
                    {done ? '記入済み（修正する）' : '記入する'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </PublicShell>
    );
  }

  // ---------------------------------------------------------------- consent
  const sections = consentSections(consent.bodyMarkdown);
  const titled = sections.filter((s) => s.title);
  return (
    <PublicShell
      header={header}
      footer={
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto max-w-xl">
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              loading={busy}
              disabled={!agreed}
              onClick={() => void submitConsent()}
              data-testid="submit-walkin-consent"
            >
              同意書を提出する
            </Button>
          </div>
        </div>
      }
    >
      <h1 className="text-lg font-semibold">施術同意書の確認とご提出</h1>
      <p className="mb-4 text-[13px] text-muted-foreground">{consent.name}</p>
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}

      <section className="mb-5 space-y-2" aria-label="注意事項">
        {sections
          .filter((s) => !s.title)
          .map((s, i) => (
            <div
              key={`intro-${i}`}
              className="whitespace-pre-wrap rounded-2xl border border-border bg-surface p-4 text-[13px] leading-relaxed"
            >
              {s.items.length ? (
                <ul className="list-inside list-disc space-y-1">
                  {s.items.map((it, j) => (
                    <li key={j}>{it}</li>
                  ))}
                </ul>
              ) : null}
              {s.content}
            </div>
          ))}
        {titled.map((s, i) => (
          <details key={i} className="rounded-2xl border border-border bg-surface" open={titled.length === 1}>
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{s.title}</summary>
            <div className="border-t border-border px-4 py-3 text-[13px] leading-relaxed">
              {s.items.length ? (
                <ul className="list-inside list-disc space-y-1">
                  {s.items.map((it, j) => (
                    <li key={j}>{it}</li>
                  ))}
                </ul>
              ) : null}
              {s.content ? <p className="whitespace-pre-wrap">{s.content}</p> : null}
            </div>
          </details>
        ))}
      </section>

      <section className="space-y-4 rounded-2xl border border-border bg-surface p-4" aria-label="お客様情報">
        <h2 className="text-sm font-semibold">お客様情報</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="お名前（姓）" required error={errors.lastName || null}>
            <Input value={profile.lastName} onChange={set('lastName')} inputSize="lg" maxLength={50} autoComplete="family-name" />
          </Field>
          <Field label="お名前（名）" required error={errors.firstName || null}>
            <Input value={profile.firstName} onChange={set('firstName')} inputSize="lg" maxLength={50} autoComplete="given-name" />
          </Field>
          <Field label="フリガナ（セイ）" required error={errors.lastNameKana || null}>
            <Input value={profile.lastNameKana} onChange={set('lastNameKana')} inputSize="lg" maxLength={50} />
          </Field>
          <Field label="フリガナ（メイ）" required error={errors.firstNameKana || null}>
            <Input value={profile.firstNameKana} onChange={set('firstNameKana')} inputSize="lg" maxLength={50} />
          </Field>
        </div>
        <Field label="生年月日" required error={errors.birthday || null}>
          <Input type="date" value={profile.birthday} onChange={set('birthday')} inputSize="lg" autoComplete="bday" />
        </Field>
        <Field label="電話番号" required error={errors.phone || null}>
          <Input
            type="tel"
            inputMode="tel"
            value={profile.phone}
            onChange={set('phone')}
            inputSize="lg"
            maxLength={20}
            autoComplete="tel"
          />
        </Field>
        <Field label="ご職業">
          <Input value={profile.occupation} onChange={set('occupation')} inputSize="lg" maxLength={100} />
        </Field>
        <Field label="ご来店のきっかけ">
          <Input value={profile.visitReason} onChange={set('visitReason')} inputSize="lg" maxLength={100} />
        </Field>
      </section>

      {consent.fields.length ? (
        <section className="mt-5 space-y-5 rounded-2xl border border-border bg-surface p-4" aria-label="確認事項">
          {consent.fields.map((f) => (
            <DynamicField
              key={f.key}
              field={f}
              value={answers[f.key]}
              onChange={(val) => {
                setAnswers((a) => ({ ...a, [f.key]: val }));
                if (errors[f.key]) setErrors((x) => ({ ...x, [f.key]: '' }));
              }}
              error={errors[f.key] || null}
              size="lg"
            />
          ))}
        </section>
      ) : null}

      {consent.requiresSignature ? (
        <section className="mt-5 space-y-3 rounded-2xl border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold">ご署名</h2>
          <SignaturePad onChange={setSignature} height={200} />
          {errors.__signature ? (
            <p className="text-xs font-medium text-danger" role="alert">
              {errors.__signature}
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="mt-5 rounded-2xl border border-border bg-surface p-4">
        <Checkbox
          label="上記の内容に同意します"
          checked={agreed}
          onChange={(e) => {
            setAgreed(e.target.checked);
            if (errors.__agreed) setErrors((x) => ({ ...x, __agreed: '' }));
          }}
        />
        {errors.__agreed ? (
          <p className="mt-1 text-xs font-medium text-danger" role="alert">
            {errors.__agreed}
          </p>
        ) : null}
      </div>
      <p className="mt-4 text-center text-xs text-subtle">
        提出後、続けてカウンセリングシートをご記入いただけます。
      </p>
    </PublicShell>
  );
}
