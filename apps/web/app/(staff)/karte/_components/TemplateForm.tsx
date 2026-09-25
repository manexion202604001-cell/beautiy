'use client';
import { ActionForm, ModalButton, SubmitButton } from '@/components/client';
import { saveTemplateAction } from '../actions';

export interface TemplateValues { id?: string; name: string; treatmentNote: string; formulaNote: string; careMemo: string }

export function TemplateButton({ template, label, className }: { template?: TemplateValues; label: React.ReactNode; className?: string }) {
  return (
    <ModalButton label={label} title={template?.id ? 'テンプレートを編集' : '新しいテンプレート'} className={className} wide>
      {(close) => (
        <ActionForm action={saveTemplateAction} onSuccess={() => setTimeout(close, 600)}>
          {template?.id && <input type="hidden" name="id" value={template.id} />}
          <div className="stack">
            <div className="field"><label htmlFor="tp-name" className="req">テンプレート名</label><input id="tp-name" name="name" className="input" defaultValue={template?.name} required maxLength={60} placeholder="例: カラー（リタッチ）" /></div>
            <div className="field"><label htmlFor="tp-t">施術内容</label><textarea id="tp-t" name="treatmentNote" className="textarea" rows={4} defaultValue={template?.treatmentNote} maxLength={10000} /></div>
            <div className="field"><label htmlFor="tp-f">薬剤・レシピ</label><textarea id="tp-f" name="formulaNote" className="textarea mono" rows={3} defaultValue={template?.formulaNote} maxLength={10000} /></div>
            <div className="field"><label htmlFor="tp-c">お客様へのケアメモ</label><textarea id="tp-c" name="careMemo" className="textarea" rows={3} defaultValue={template?.careMemo} maxLength={10000} /></div>
            <p className="sub" style={{ margin: 0 }}>カルテ編集画面で「テンプレート」から挿入できます。入力済みの内容には追記されます。</p>
          </div>
          <div className="form-actions"><button type="button" className="btn secondary" onClick={close}>キャンセル</button><SubmitButton>保存</SubmitButton></div>
        </ActionForm>
      )}
    </ModalButton>
  );
}
