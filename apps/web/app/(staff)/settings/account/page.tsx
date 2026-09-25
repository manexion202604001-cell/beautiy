import { ROLE_LABEL } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { PageHeader, Card, Field } from '@/components/ui';
import { ActionForm, SubmitButton } from '@/components/client';
import { changePasswordAction, updateProfileAction } from './actions';

export const metadata = { title: 'アカウント設定' };

export default async function AccountPage() {
  const ctx = await requirePage();
  return (
    <>
      <PageHeader title="アカウント" back={{ href: '/settings', label: '設定' }} sub={`${ctx.user.email} ・ ${ROLE_LABEL[ctx.role]}`} />
      <div className="grid-2">
        <Card title="プロフィール">
          <ActionForm action={updateProfileAction}>
            <Field label="表示名" htmlFor="displayName" required hint="予約台帳や公開プロフィールに表示されます">
              <input id="displayName" name="displayName" className="input" defaultValue={ctx.membership.displayName} required maxLength={40} />
            </Field>
            <Field label="メールアドレス"><input className="input" value={ctx.user.email} readOnly /></Field>
            <div className="form-actions"><SubmitButton>保存</SubmitButton></div>
          </ActionForm>
        </Card>
        <Card title="パスワードの変更">
          <ActionForm action={changePasswordAction} resetOnSuccess>
            <div className="stack">
              <Field label="現在のパスワード" htmlFor="current" required><input id="current" name="current" type="password" className="input" autoComplete="current-password" required /></Field>
              <Field label="新しいパスワード" htmlFor="next" required hint="8文字以上"><input id="next" name="next" type="password" className="input" autoComplete="new-password" minLength={8} required /></Field>
              <Field label="新しいパスワード（確認）" htmlFor="confirm" required><input id="confirm" name="confirm" type="password" className="input" autoComplete="new-password" minLength={8} required /></Field>
            </div>
            <div className="form-actions"><SubmitButton>パスワードを変更</SubmitButton></div>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
