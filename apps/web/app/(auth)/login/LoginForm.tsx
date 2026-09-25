'use client';
import { ActionForm, SubmitButton } from '@/components/client';
import { loginAction } from '../actions';

export function LoginForm({ next, demo }: { next?: string; demo: boolean }) {
  return (
    <ActionForm action={loginAction} className="stack" refresh={false}>
      <input type="hidden" name="next" value={next ?? '/dashboard'} />
      <div className="field"><label htmlFor="email">メールアドレス</label><input id="email" className="input" name="email" type="email" autoComplete="username" required defaultValue={demo ? 'owner@demo.salon' : ''} /></div>
      <div className="field"><label htmlFor="password">パスワード</label><input id="password" className="input" name="password" type="password" autoComplete="current-password" required defaultValue={demo ? 'demo1234' : ''} /></div>
      <SubmitButton className="btn lg block" pendingText="ログイン中…">ログイン</SubmitButton>
    </ActionForm>
  );
}
