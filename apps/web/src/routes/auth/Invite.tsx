import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { authApi } from '../../api/auth';
import { Button, Input, Label } from '../../components/shad';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AuthCard, AuthErrorBox } from './AuthCard';

/** Target of the staff invitation link: set a password and join the organization */
export default function Invite() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { acceptTokens } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 10) {
      setError('パスワードは10文字以上にしてください');
      return;
    }
    if (password !== confirm) {
      setError('パスワードが一致しません');
      return;
    }
    setBusy(true);
    try {
      const pair = await authApi.acceptInvite(token, password);
      qc.clear();
      acceptTokens(pair);
      navigate('/app', { replace: true });
    } catch (err) {
      setError(errorMessage(err) || 'エラーが発生しました');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard description="スタッフ招待">
      <form onSubmit={submit} className="sy-4" noValidate>
        {error ? <AuthErrorBox>{error}</AuthErrorBox> : null}
        <p className="text-sm text-muted-foreground">
          パスワードを設定して招待を受け付けます。設定後すぐにログインできます。
        </p>
        <div className="sy-2">
          <Label htmlFor="password">パスワード</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder="10文字以上"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={10}
            autoFocus
          />
        </div>
        <div className="sy-2">
          <Label htmlFor="confirmPassword">パスワード（確認）</Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            placeholder="パスワードを再入力"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={10}
          />
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? '設定中...' : '招待を受け付ける'}
        </Button>
        <p className="text-xs text-muted-foreground">
          ※
          既にアカウントをお持ちの場合は、そのアカウントの現在のパスワードを入力してください（パスワードは変更されません）。
        </p>
      </form>
    </AuthCard>
  );
}
