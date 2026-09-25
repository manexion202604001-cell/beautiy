'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ActionForm, SubmitButton } from '@/components/client';
import { saveCustomerAction } from '../actions';

export interface CustomerFormValues {
  id?: string;
  lastName: string; firstName: string; lastNameKana: string; firstNameKana: string;
  phone: string; email: string; address: string;
  birthday: string; gender: string; notes: string;
  assignedStaffId: string; primaryShopId: string;
  lineOptIn: boolean; emailOptIn: boolean; favorite: boolean;
}

export function CustomerForm({
  initial, staff, shops, contactEditable, maskedHints,
}: {
  initial: CustomerFormValues;
  staff: { userId: string; displayName: string }[];
  shops: { id: string; name: string }[];
  /** true when the editor sees decrypted contact values (blank then clears). */
  contactEditable: boolean;
  maskedHints?: { phone: string; email: string; address: string | null };
}) {
  const [dupHint, setDupHint] = useState(false);
  const [v, setV] = useState(initial);
  const bind = (name: keyof CustomerFormValues) => ({
    name, id: name, value: String(v[name] ?? ''),
    onChange: (e: { target: { value: string } }) => setV((o) => ({ ...o, [name]: e.target.value })),
  });
  const check = (name: 'lineOptIn' | 'emailOptIn' | 'favorite') => ({
    name, checked: v[name], onChange: (e: { target: { checked: boolean } }) => setV((o) => ({ ...o, [name]: e.target.checked })),
  });
  const isEdit = !!initial.id;
  const maskedHint = (v: string | null | undefined) => (v ? `登録済み: ${v}（変更する場合のみ入力）` : '未登録');
  return (
    <ActionForm action={saveCustomerAction} onSuccess={() => setDupHint(false)} showSuccess={false}>
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <input type="hidden" name="contactEditable" value={contactEditable ? '1' : '0'} />
      <div className="card">
        <div className="card-head"><h2>基本情報</h2></div>
        <div className="form-grid">
          <div className="field"><label htmlFor="lastName" className="req">姓</label><input {...bind('lastName')} className="input" required maxLength={50} autoComplete="off" /></div>
          <div className="field"><label htmlFor="firstName">名</label><input {...bind('firstName')} className="input" maxLength={50} autoComplete="off" /></div>
          <div className="field"><label htmlFor="lastNameKana">セイ</label><input {...bind('lastNameKana')} className="input" maxLength={50} placeholder="ヤマダ" autoComplete="off" /></div>
          <div className="field"><label htmlFor="firstNameKana">メイ</label><input {...bind('firstNameKana')} className="input" maxLength={50} placeholder="ハナコ" autoComplete="off" /></div>
          <div className="field"><label htmlFor="birthday">誕生日</label><input {...bind('birthday')} type="date" className="input" max={new Date().toISOString().slice(0, 10)} /></div>
          <div className="field">
            <label htmlFor="gender">性別</label>
            <select {...bind('gender')} className="select">
              <option value="">未設定</option><option>女性</option><option>男性</option><option>その他</option><option>回答しない</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card section">
        <div className="card-head">
          <h2>連絡先</h2>
          <span className="sub">暗号化して保存されます</span>
        </div>
        {!contactEditable && isEdit && <div className="alert info" style={{ marginBottom: 12 }}>個人情報はロック中のため、現在の値は表示されません。新しい値を入力した項目のみ上書きされます。</div>}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="phone">電話番号</label>
            <input {...bind('phone')} className="input" type="tel" inputMode="tel" maxLength={30} placeholder="090-1234-5678" autoComplete="off" />
            {!contactEditable && isEdit && <div className="hint">{maskedHint(maskedHints?.phone)}</div>}
          </div>
          <div className="field">
            <label htmlFor="email">メールアドレス</label>
            <input {...bind('email')} className="input" type="email" maxLength={200} autoComplete="off" />
            {!contactEditable && isEdit && <div className="hint">{maskedHint(maskedHints?.email)}</div>}
          </div>
          <div className="field full">
            <label htmlFor="address">住所</label>
            <input {...bind('address')} className="input" maxLength={300} autoComplete="off" />
            {!contactEditable && isEdit && <div className="hint">{maskedHints?.address ? '登録済み（変更する場合のみ入力）' : '未登録'}</div>}
          </div>
          <label className="checkbox"><input type="checkbox" {...check('lineOptIn')} />LINEでのお知らせを受け取る</label>
          <label className="checkbox"><input type="checkbox" {...check('emailOptIn')} />メールでのお知らせを受け取る</label>
        </div>
      </div>

      <div className="card section">
        <div className="card-head"><h2>サロン管理</h2></div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="assignedStaffId">担当スタッフ</label>
            <select {...bind('assignedStaffId')} className="select">
              <option value="">担当なし</option>
              {staff.map((s) => <option key={s.userId} value={s.userId}>{s.displayName}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="primaryShopId">主な利用店舗</label>
            <select {...bind('primaryShopId')} className="select">
              <option value="">未設定</option>
              {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="field full">
            <label htmlFor="notes">顧客メモ（スタッフ間共有）</label>
            <textarea {...bind('notes')} className="textarea" maxLength={5000} placeholder="アレルギー、好み、会話のきっかけなど" />
          </div>
          <label className="checkbox"><input type="checkbox" {...check('favorite')} />お気に入り顧客</label>
        </div>
      </div>

      {!isEdit && (
        <div className="section">
          <label className="checkbox"><input type="checkbox" name="allowDuplicate" checked={dupHint} onChange={(e) => setDupHint(e.target.checked)} />電話番号・メールが既存顧客と重複していても登録する</label>
        </div>
      )}
      <div className="form-actions">
        <Link href={isEdit ? `/customers/${initial.id}` : '/customers'} className="btn secondary">キャンセル</Link>
        <SubmitButton pendingText="保存中…">{isEdit ? '保存する' : '登録する'}</SubmitButton>
      </div>
    </ActionForm>
  );
}
