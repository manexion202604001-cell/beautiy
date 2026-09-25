'use client';
import { ActionForm, SubmitButton } from '@/components/client';
import { signupAction } from '../actions';

export function SignupForm() {
  return (
    <ActionForm action={signupAction} className="stack" refresh={false}>
      <div className="form-grid">
        <div className="field full"><label className="req" htmlFor="orgName">サロン名（組織名）</label><input id="orgName" className="input" name="orgName" required placeholder="例）Salon Lumière" /></div>
        <div className="field"><label className="req" htmlFor="shopName">最初の店舗名</label><input id="shopName" className="input" name="shopName" required placeholder="例）表参道店" /></div>
        <div className="field"><label htmlFor="seatCount">席数</label><input id="seatCount" className="input" name="seatCount" type="number" min={1} max={50} defaultValue={3} /></div>
        <div className="field full"><label className="req" htmlFor="name">オーナーのお名前</label><input id="name" className="input" name="name" required autoComplete="name" /></div>
        <div className="field full"><label className="req" htmlFor="email">メールアドレス</label><input id="email" className="input" name="email" type="email" required autoComplete="email" /></div>
        <div className="field full"><label className="req" htmlFor="password">パスワード（8文字以上）</label><input id="password" className="input" name="password" type="password" minLength={8} required autoComplete="new-password" /></div>
      </div>
      <SubmitButton className="btn lg block" pendingText="作成中…">サロンを作成して始める</SubmitButton>
      <p className="sub">作成後、営業時間・メニュー（初期値入り）・スタッフ招待を設定できます。</p>
    </ActionForm>
  );
}
