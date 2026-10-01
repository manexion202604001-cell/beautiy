import { useState } from 'react';
import { FORM_KIND_LABEL, formsApi, useFormTemplates, type FormKind } from '../../../api/forms';
import type { FieldValues } from '../../../api/kartes';
import {
  DynamicField,
  compactValues,
  fieldErrorsFromApi,
  validateFields,
} from '../../../components/forms/DynamicField';
import { SignaturePad } from '../../../components/forms/SignaturePad';
import { Alert, Button, Dialog, Field, Input, Select } from '../../../components/ui';
import { errorMessage, isApiError, newIdempotencyKey } from '../../../lib/api';
import { useStableKey } from '../../../lib/hooks';

/** Staff-assisted form (店頭でのカウンセリング・同意書): answers + canvas signature → PNG data URL */
export function FormFillDialog({
  customerId,
  customerName,
  appointmentId,
  defaultKind,
  onClose,
  onSubmitted,
}: {
  customerId: string;
  customerName: string;
  appointmentId?: string;
  defaultKind?: FormKind;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const templates = useFormTemplates();
  const active = (templates.data ?? []).filter((t) => t.status === 'active');
  const [templateId, setTemplateId] = useState('');
  const template =
    active.find((t) => t.id === templateId) ??
    active.find((t) => t.kind === defaultKind) ??
    active[0];
  const [answers, setAnswers] = useState<FieldValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [signature, setSignature] = useState<string | null>(null);
  const [signer, setSigner] = useState(customerName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, regenerate] = useStableKey(newIdempotencyKey);

  const submit = async () => {
    if (!template) return;
    const errs = validateFields(template.fields, answers);
    if (template.requires_signature && !signature) errs.__signature = '署名してください';
    if (template.requires_signature && !signer.trim()) errs.__signer = '署名者名を入力してください';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      await formsApi.createResponse(
        {
          templateId: template.id,
          customerId,
          appointmentId: appointmentId ?? null,
          answers: compactValues(template.fields, answers),
          ...(signature
            ? { signature: { dataUrl: signature, signerName: signer.trim() || customerName } }
            : {}),
        },
        key,
      );
      onSubmitted();
    } catch (e) {
      setError(errorMessage(e));
      if (isApiError(e)) {
        setErrors(fieldErrorsFromApi(e.fieldErrors(), 'answers'));
        if (e.status > 0) regenerate();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="フォームに記入"
      description="お客様に端末をお渡しして記入・署名いただけます。提出後は変更できません。"
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void submit()}
            disabled={!template}
            data-testid="submit-form-response"
          >
            提出する
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field label="フォーム">
          <Select
            value={template?.id ?? ''}
            onChange={(e) => {
              setTemplateId(e.target.value);
              setAnswers({});
              setErrors({});
            }}
          >
            {!active.length ? <option value="">（公開中のフォームがありません）</option> : null}
            {active.map((t) => (
              <option key={t.id} value={t.id}>
                【{FORM_KIND_LABEL[t.kind]}】{t.name}（v{t.version}）
              </option>
            ))}
          </Select>
        </Field>
        {template?.body_markdown ? (
          <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-surface-2 p-4 text-[13px] leading-relaxed">
            {template.body_markdown}
          </div>
        ) : null}
        {template?.fields.map((f) => (
          <DynamicField
            key={`${template.id}:${f.key}`}
            field={f}
            value={answers[f.key]}
            onChange={(v) => setAnswers((a) => ({ ...a, [f.key]: v }))}
            error={errors[f.key] || null}
            size="lg"
          />
        ))}
        {template?.requires_signature ? (
          <div className="space-y-3">
            <Field label="署名者名" required error={errors.__signer || null}>
              <Input value={signer} onChange={(e) => setSigner(e.target.value)} maxLength={100} />
            </Field>
            <div>
              <p className="mb-1.5 text-[13px] font-medium">
                署名 <span className="text-danger">*</span>
              </p>
              <SignaturePad onChange={setSignature} />
              {errors.__signature ? (
                <p className="text-xs font-medium text-danger" role="alert">
                  {errors.__signature}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
