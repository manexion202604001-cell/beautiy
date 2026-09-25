'use client';
import { useState } from 'react';
import { ActionForm, ModalButton, SubmitButton } from '@/components/client';
import { Field } from '@/components/ui';
import { saveRuleAction } from '../actions';
import { SAMPLE_VARS, TRIGGER_HELP, TRIGGER_LABEL, TRIGGER_UNIT } from '../labels';
import { BodyEditor } from '../ui';

export interface RuleLite { id: string; name: string; trigger: string; offsetValue: number; body: string; channel: string; shopId: string | null; active: boolean }

const DEFAULTS: Record<string, { offset: number; body: string; name: string }> = {
  REMINDER_BEFORE: { offset: 24, name: '前日リマインド', body: '{{customer_name}}様\n{{date}} {{time}}より{{shop_name}}でお待ちしております。\nメニュー：{{menu}}\n変更・キャンセルはこちら\n{{manage_url}}' },
  VISIT_CYCLE: { offset: 45, name: '来店周期フォロー', body: '{{customer_name}}様\n前回のご来店から{{days_since}}日が経ちました。そろそろメンテナンスの時期です。\nご予約はこちら\n{{booking_url}}' },
  AFTER_VISIT_REVIEW: { offset: 3, name: '来店後の口コミ依頼', body: '{{customer_name}}様\n本日はご来店ありがとうございました。よろしければご感想をお聞かせください。\n{{review_url}}' },
  BIRTHDAY: { offset: 0, name: 'お誕生日メッセージ', body: '{{customer_name}}様\nお誕生日おめでとうございます！\n{{shop_name}}スタッフ一同、素敵な一年になりますようお祈りしております。\n{{booking_url}}' },
  DORMANT: { offset: 180, name: '休眠掘り起こし', body: '{{customer_name}}様\nご無沙汰しております、{{shop_name}}です。お変わりありませんか？\nまたのご来店を心よりお待ちしております。\n{{booking_url}}' },
};

export function RuleButton({ rule, shops, label, className }: { rule?: RuleLite; shops: { id: string; name: string }[]; label: string; className?: string }) {
  return (
    <ModalButton label={label} title={rule ? '自動配信ルールを編集' : '自動配信ルールを作成'} className={className} wide>
      {(close) => <RuleFormBody rule={rule} shops={shops} close={close} />}
    </ModalButton>
  );
}

function RuleFormBody({ rule, shops, close }: { rule?: RuleLite; shops: { id: string; name: string }[]; close: () => void }) {
  const [trigger, setTrigger] = useState(rule?.trigger ?? 'REMINDER_BEFORE');
  const [seed, setSeed] = useState({ key: 0, body: rule?.body ?? DEFAULTS.REMINDER_BEFORE.body });
  const [name, setName] = useState(rule?.name ?? DEFAULTS.REMINDER_BEFORE.name);
  const [offset, setOffset] = useState(String(rule?.offsetValue ?? DEFAULTS.REMINDER_BEFORE.offset));
  const unit = TRIGGER_UNIT[trigger];
  return (
    <ActionForm action={saveRuleAction} onSuccess={close}>
      {rule && <input type="hidden" name="id" value={rule.id} />}
      <div className="form-grid">
        <Field label="トリガー" required hint={TRIGGER_HELP[trigger]}>
          <select name="trigger" className="select" value={trigger} onChange={(e) => {
            const t = e.target.value;
            setTrigger(t);
            if (!rule) { setSeed((s) => ({ key: s.key + 1, body: DEFAULTS[t].body })); setName(DEFAULTS[t].name); setOffset(String(DEFAULTS[t].offset)); }
          }}>
            {Object.entries(TRIGGER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="ルール名" required><input name="name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></Field>
        {trigger !== 'BIRTHDAY' ? (
          <Field label={unit.includes('時間') ? '時間' : '日数'} required>
            <div className="row"><input name="offsetValue" type="number" className="input" min={unit.includes('時間') ? 1 : 1} max={unit.includes('時間') ? 168 : 3650} value={offset} onChange={(e) => setOffset(e.target.value)} required /><span className="sub nowrap">{unit}</span></div>
          </Field>
        ) : <input type="hidden" name="offsetValue" value="0" />}
        <Field label="チャネル" required>
          <select name="channel" className="select" defaultValue={rule?.channel ?? 'LINE'}>
            <option value="LINE">LINE</option>
            <option value="EMAIL">メール</option>
          </select>
        </Field>
        <Field label="対象店舗">
          <select name="shopId" className="select" defaultValue={rule?.shopId ?? ''}>
            <option value="">すべての店舗</option>
            {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <div className="field" style={{ justifyContent: 'flex-end' }}>
          <label className="checkbox"><input type="checkbox" name="active" defaultChecked={rule?.active ?? true} />有効にする</label>
        </div>
        <div className="field full">
          <label className="req">本文</label>
          <BodyEditor key={seed.key} defaultValue={seed.body} previewVars={SAMPLE_VARS} />
        </div>
      </div>
      <div className="form-actions">
        <button type="button" className="btn secondary" onClick={close}>キャンセル</button>
        <SubmitButton>保存</SubmitButton>
      </div>
    </ActionForm>
  );
}
