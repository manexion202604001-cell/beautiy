'use client';
import { ActionForm, SubmitButton } from '@/components/client';
import { acceptInviteAction } from '../../actions';

export function InviteForm({ token, name, email }: { token: string; name: string; email: string }) {
  return (
    <ActionForm action={acceptInviteAction} className="stack" refresh={false}>
      <input type="hidden" name="token" value={token} />
      <div className="field"><label>メールアドレス</label><input className="input" value={email} readOnly /></div>
      <div className="field"><label className="req" htmlFor="name">お名前</label><input id="name" className="input" name="name" defaultValue={name} required /></div>
      <div className="field"><label className="req" htmlFor="password">パスワード（8文字以上）</label><input id="password" className="input" name="password" type="password" minLength={8} required autoComplete="new-password" /></div>
      <SubmitButton className="btn lg block">参加する</SubmitButton>
    </ActionForm>
  );
}
