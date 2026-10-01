import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { FORM_KIND_LABEL, formsApi } from '../../api/forms';
import type { FieldValues } from '../../api/kartes';
import {
  DynamicField,
  compactValues,
  fieldErrorsFromApi,
  validateFields,
} from '../../components/forms/DynamicField';
import { SignaturePad } from '../../components/forms/SignaturePad';
import { Alert, Button, EmptyState, Field, Icon, Input, PageSpinner } from '../../components/ui';
import { errorMessage, isApiError } from '../../lib/api';
import { formatDateJa, formatTime } from '../../lib/format';
import { zonedParts } from '../../lib/time';
import { PublicShell, ShopHeader } from './PublicShell';

/** /f/:token — pre-visit questionnaire / consent form with signature (single use) */
export default function PublicForm() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['public', 'form', token],
    queryFn: () => formsApi.publicView(token),
    retry: false,
    staleTime: Infinity,
  });
  const [answers, setAnswers] = useState<FieldValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [signature, setSignature] = useState<string | null>(null);
  const [signer, setSigner] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (q.data) {
      setAnswers((a) => ({ ...q.data.prefill, ...a }));
      setSigner((s) => s || `${q.data.customer.lastName} ${q.data.customer.firstName}`.trim());
    }
  }, [q.data]);

  if (q.isLoading) return <PageSpinner />;
  if (done) {
    return (
      <PublicShell header={q.data ? <ShopHeader name={q.data.shop?.name ?? ''} /> : undefined}>
        <div className="mt-10 flex flex-col items-center text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success">
            <Icon name="check" size={28} />
          </span>
          <h1 className="text-lg font-semibold">ご回答ありがとうございました</h1>
          <p className="mt-2 text-[13px] text-muted">
            内容はサロンに送信されました。このページは閉じていただいて構いません。
          </p>
        </div>
      </PublicShell>
    );
  }
  if (q.error || !q.data) {
    const invalid =
      isApiError(q.error) && (q.error.code === 'INVALID_LINK' || q.error.status === 401);
    return (
      <PublicShell>
        <EmptyState
          className="mt-10"
          icon="lock"
          title={
            invalid ? 'このリンクは使用済みか、有効期限が切れています' : '読み込みに失敗しました'
          }
          description={
            invalid
              ? '再度ご記入が必要な場合は、サロンへお問い合わせください。'
              : errorMessage(q.error)
          }
        />
      </PublicShell>
    );
  }
  const v = q.data;
  const tz = 'Asia/Tokyo';

  const submit = async () => {
    const errs = validateFields(v.form.fields, answers);
    if (v.form.requiresSignature && !signature) errs.__signature = '署名をお願いします';
    if (v.form.requiresSignature && !signer.trim()) errs.__signer = 'お名前を入力してください';
    setErrors(errs);
    if (Object.keys(errs).length) {
      window.setTimeout(
        () => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
        0,
      );
      setError('未入力の項目があります');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await formsApi.publicSubmit(token, {
        answers: compactValues(v.form.fields, answers),
        ...(signature ? { signature: { dataUrl: signature, signerName: signer.trim() } } : {}),
      });
      setDone(true);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(errorMessage(e));
      if (isApiError(e)) setErrors(fieldErrorsFromApi(e.fieldErrors(), 'answers'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicShell
      header={<ShopHeader name={v.shop?.name ?? 'サロン'} sub={FORM_KIND_LABEL[v.form.kind]} />}
      footer={
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto max-w-xl">
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              loading={busy}
              onClick={() => void submit()}
              data-testid="submit-public-form"
            >
              送信する
            </Button>
          </div>
        </div>
      }
    >
      <h1 className="text-lg font-semibold">{v.form.name}</h1>
      <p className="mb-4 text-[13px] text-muted">
        {v.customer.lastName} {v.customer.firstName} 様
        {v.appointment
          ? ` ・ ご予約 ${formatDateJa(zonedParts(v.appointment.startAt, tz).date)} ${formatTime(v.appointment.startAt, tz)}`
          : ''}
      </p>
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      {v.form.bodyMarkdown ? (
        <div className="mb-5 whitespace-pre-wrap rounded-2xl border border-border bg-surface p-4 text-[13px] leading-relaxed">
          {v.form.bodyMarkdown}
        </div>
      ) : null}
      <div className="space-y-5 rounded-2xl border border-border bg-surface p-4">
        {v.form.fields.map((f) => (
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
        {!v.form.fields.length ? (
          <p className="text-[13px] text-muted">記入項目はありません。</p>
        ) : null}
      </div>
      {v.form.requiresSignature ? (
        <section className="mt-5 space-y-3 rounded-2xl border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold">ご署名</h2>
          <p className="text-xs text-muted">上記の内容を確認し、同意のうえ署名してください。</p>
          <Field label="お名前" required error={errors.__signer || null}>
            <Input
              value={signer}
              onChange={(e) => setSigner(e.target.value)}
              inputSize="lg"
              maxLength={100}
              autoComplete="name"
            />
          </Field>
          <SignaturePad onChange={setSignature} height={200} />
          {errors.__signature ? (
            <p className="text-xs font-medium text-danger" role="alert">
              {errors.__signature}
            </p>
          ) : null}
        </section>
      ) : null}
      <p className="mt-4 text-center text-xs text-subtle">
        送信は1回限りです。送信後の修正はサロンへご連絡ください。
      </p>
    </PublicShell>
  );
}
