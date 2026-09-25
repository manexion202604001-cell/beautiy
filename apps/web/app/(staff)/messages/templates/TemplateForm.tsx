'use client';
import { ActionForm, ModalButton, SubmitButton } from '@/components/client';
import { Field } from '@/components/ui';
import { saveTemplateAction } from '../actions';
import { SAMPLE_VARS, TEMPLATE_CATEGORIES } from '../labels';
import { BodyEditor, type TemplateLite } from '../ui';

export function TemplateButton({ template, label, className }: { template?: TemplateLite; label: string; className?: string }) {
  return (
    <ModalButton label={label} title={template ? 'テンプレートを編集' : 'テンプレートを作成'} className={className} wide>
      {(close) => (
        <ActionForm action={saveTemplateAction} onSuccess={close}>
          {template && <input type="hidden" name="id" value={template.id} />}
          <div className="form-grid">
            <Field label="テンプレート名" required><input name="name" className="input" defaultValue={template?.name} maxLength={60} required /></Field>
            <Field label="カテゴリ" required hint="予約確定・変更・キャンセル・リマインドのカテゴリは予約通知の本文として自動で使われます">
              <select name="category" className="select" defaultValue={template?.category ?? 'GENERAL'}>
                {Object.entries(TEMPLATE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <div className="field full">
              <label className="req">本文</label>
              <BodyEditor defaultValue={template?.body ?? ''} previewVars={SAMPLE_VARS} />
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={close}>キャンセル</button>
            <SubmitButton>保存</SubmitButton>
          </div>
        </ActionForm>
      )}
    </ModalButton>
  );
}
