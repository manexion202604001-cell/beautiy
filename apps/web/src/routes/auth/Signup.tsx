import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';
import { authApi } from '../../api/auth';
import { Alert, Button, Field, Input } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useZodForm } from '../../lib/form';
import { AuthShell } from './AuthShell';

const slug = z
  .string()
  .min(3, '3文字以上で入力してください')
  .max(50)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, '英小文字・数字・ハイフンのみ（先頭と末尾は英数字）');

const schema = z.object({
  organizationName: z.string().trim().min(1, '法人名を入力してください').max(100),
  organizationSlug: slug,
  shopName: z.string().trim().min(1, '店舗名を入力してください').max(100),
  shopSlug: slug,
  ownerName: z.string().trim().min(1, 'お名前を入力してください').max(100),
  email: z.string().trim().email('メールアドレスの形式が正しくありません'),
  password: z.string().min(10, '10文字以上で入力してください').max(200),
  phone: z.string().max(30).optional(),
});

function toSlug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export default function Signup() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { acceptTokens } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const f = useZodForm(schema, {
    organizationName: '',
    organizationSlug: '',
    shopName: '',
    shopSlug: '',
    ownerName: '',
    email: '',
    password: '',
    phone: '',
  });

  const submit = f.handleSubmit(async (data) => {
    setError(null);
    setBusy(true);
    try {
      const res = await authApi.signup({ ...data, phone: data.phone || undefined });
      if (res.auth.status === 'authenticated') {
        qc.clear();
        acceptTokens(res.auth);
        navigate('/app/settings?welcome=1', { replace: true });
      } else navigate('/login');
    } catch (e) {
      f.applyServerError(e);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  });

  return (
    <AuthShell
      title="新規法人登録"
      subtitle="法人・最初の店舗・オーナーアカウントを作成します。30秒で始められます。"
      footer={
        <>
          アカウントをお持ちですか？{' '}
          <Link to="/login" className="font-medium text-primary hover:underline">
            ログイン
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5" noValidate>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <fieldset className="space-y-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-subtle">
            法人
          </legend>
          <Field label="法人名・屋号" required error={f.errors.organizationName}>
            <Input
              value={f.values.organizationName}
              onChange={(e) => f.set('organizationName', e.target.value)}
              placeholder="株式会社サロン"
              autoFocus
            />
          </Field>
          <Field
            label="法人ID（URL用）"
            required
            error={f.errors.organizationSlug}
            hint="英小文字・数字・ハイフン"
          >
            <Input
              value={f.values.organizationSlug}
              onChange={(e) => f.set('organizationSlug', toSlug(e.target.value))}
              placeholder="my-salon"
            />
          </Field>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-subtle">
            最初の店舗
          </legend>
          <Field label="店舗名" required error={f.errors.shopName}>
            <Input
              value={f.values.shopName}
              onChange={(e) => f.set('shopName', e.target.value)}
              placeholder="サロン 渋谷店"
            />
          </Field>
          <Field
            label="店舗ID（予約URL）"
            required
            error={f.errors.shopSlug}
            hint={
              f.values.shopSlug
                ? `予約ページ: /book/${f.values.shopSlug}`
                : '予約ページのURLになります'
            }
          >
            <Input
              value={f.values.shopSlug}
              onChange={(e) => f.set('shopSlug', toSlug(e.target.value))}
              placeholder="shibuya"
            />
          </Field>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-subtle">
            オーナー
          </legend>
          <Field label="お名前" required error={f.errors.ownerName}>
            <Input
              value={f.values.ownerName}
              onChange={(e) => f.set('ownerName', e.target.value)}
              autoComplete="name"
            />
          </Field>
          <Field label="メールアドレス" required error={f.errors.email}>
            <Input
              type="email"
              value={f.values.email}
              onChange={(e) => f.set('email', e.target.value)}
              autoComplete="email"
            />
          </Field>
          <Field label="パスワード" required error={f.errors.password} hint="10文字以上">
            <Input
              type="password"
              value={f.values.password}
              onChange={(e) => f.set('password', e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="電話番号" optional error={f.errors.phone}>
            <Input
              type="tel"
              value={f.values.phone ?? ''}
              onChange={(e) => f.set('phone', e.target.value)}
              autoComplete="tel"
            />
          </Field>
        </fieldset>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          登録してはじめる
        </Button>
      </form>
    </AuthShell>
  );
}
