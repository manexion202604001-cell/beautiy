import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { authApi } from '../../api/auth';
import { Alert, Button, Field, Input } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AuthShell } from './AuthShell';

export default function Invite() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { acceptTokens } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 10) return setError('パスワードは10文字以上で入力してください');
    if (password !== confirm) return setError('確認用パスワードが一致しません');
    setBusy(true);
    try {
      const pair = await authApi.acceptInvite(token, password);
      qc.clear();
      acceptTokens(pair);
      navigate('/app', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="スタッフ招待"
      subtitle="パスワードを設定して招待を受け付けます。設定後すぐにログインできます。"
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field label="パスワード" required hint="10文字以上">
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            inputSize="lg"
            autoFocus
          />
        </Field>
        <Field label="パスワード（確認）" required>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            inputSize="lg"
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          招待を受け付ける
        </Button>
        <p className="text-xs text-muted">
          ※
          既にアカウントをお持ちの場合、入力したパスワードは使われず既存のパスワードでログインできます。
        </p>
      </form>
    </AuthShell>
  );
}
