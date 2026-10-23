import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { authApi } from '../../api/auth';
import { Button, Input, Label } from '../../components/shad';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AuthCard, AuthErrorBox } from './AuthCard';
import { PASSWORD_MIN_LENGTH } from '../../lib/password';

type OwnerType = 'individual' | 'company';

/** Passwords are at least this long (API rule) */

/**
 * 初期設定 (3 steps): business details → first shop → sign-in account. Creates the organization,
 * its first shop and the owner account in one call when the last step is submitted.
 */
export default function Signup() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { acceptTokens } = useAuth();
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [ownerType, setOwnerType] = useState<OwnerType>('individual');
  const [companyName, setCompanyName] = useState('');
  const [companyPostalCode, setCompanyPostalCode] = useState('');
  const [companyPhone, setCompanyPhone] = useState('');
  const [companyAddress, setCompanyAddress] = useState('');
  const [companyEmail, setCompanyEmail] = useState('');
  const [storeName, setStoreName] = useState('');
  const [storePostalCode, setStorePostalCode] = useState('');
  const [storeAddress, setStoreAddress] = useState('');
  const [storePhone, setStorePhone] = useState('');
  const [storeEmail, setStoreEmail] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const next = () => {
    setError('');
    if (step === 1) {
      if (ownerType === 'company' && !companyName.trim()) {
        setError('法人の場合は会社名を入力してください');
        return;
      }
      setStep(2);
    } else if (step === 2) {
      if (!storeName.trim()) {
        setError('店舗名は必須です');
        return;
      }
      setStep(3);
    }
  };

  const back = () => {
    setError('');
    setStep(step - 1);
  };

  const complete = async () => {
    setError('');
    if (!ownerName.trim()) {
      setError('お名前は必須です');
      return;
    }
    if (!email.trim()) {
      setError('メールアドレスは必須です');
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`パスワードは${PASSWORD_MIN_LENGTH}文字以上にしてください`);
      return;
    }
    if (password !== confirmPassword) {
      setError('パスワードが一致しません');
      return;
    }
    setBusy(true);
    try {
      const company = companyName.trim();
      const res = await authApi.signup({
        // a sole proprietor's business goes by the shop name
        organizationName: ownerType === 'company' && company ? company : storeName.trim(),
        shopName: storeName.trim(),
        ownerName: ownerName.trim(),
        email: email.trim(),
        password,
        phone: storePhone.trim() || undefined,
        shopPostalCode: storePostalCode.trim() || undefined,
        shopAddressLine: storeAddress.trim() || undefined,
        shopEmail: storeEmail.trim() || undefined,
        ownerProfile: {
          ownerType,
          companyName: company || undefined,
          companyPostalCode: companyPostalCode.trim() || undefined,
          companyPhone: companyPhone.trim() || undefined,
          companyAddress: companyAddress.trim() || undefined,
          companyEmail: companyEmail.trim() || undefined,
        },
      });
      if (res.auth.status === 'authenticated') {
        qc.clear();
        acceptTokens(res.auth);
        navigate('/app', { replace: true });
      } else navigate('/login');
    } catch (e) {
      setError(errorMessage(e) || 'エラーが発生しました');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      className="py-8"
      cardClassName="max-w-lg"
      description={`初期設定（ステップ ${step}/3）`}
      headerExtra={
        <div className="mt-3 flex gap-1">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className={`h-1.5 flex-1 rounded-full ${n <= step ? 'bg-primary' : 'bg-muted'}`}
            />
          ))}
        </div>
      }
    >
      {error ? <AuthErrorBox className="mb-4">{error}</AuthErrorBox> : null}

      {step === 1 ? (
        <div className="sy-4">
          <h3 className="font-medium">会社・事業者情報</h3>
          <div className="sy-2">
            <Label>事業形態</Label>
            <div className="flex gap-3">
              <Button
                type="button"
                variant={ownerType === 'individual' ? 'default' : 'outline'}
                aria-pressed={ownerType === 'individual'}
                className="flex-1"
                onClick={() => setOwnerType('individual')}
              >
                個人事業主
              </Button>
              <Button
                type="button"
                variant={ownerType === 'company' ? 'default' : 'outline'}
                aria-pressed={ownerType === 'company'}
                className="flex-1"
                onClick={() => setOwnerType('company')}
              >
                法人
              </Button>
            </div>
          </div>
          {ownerType === 'company' ? (
            <div className="sy-2">
              <Label htmlFor="companyName">会社名 *</Label>
              <Input
                id="companyName"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="株式会社サンプル"
              />
            </div>
          ) : null}
          <div className="sy-2">
            <Label htmlFor="companyPostalCode">郵便番号</Label>
            <Input
              id="companyPostalCode"
              value={companyPostalCode}
              onChange={(e) => setCompanyPostalCode(e.target.value)}
              placeholder="000-0000"
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="companyAddress">住所</Label>
            <Input
              id="companyAddress"
              value={companyAddress}
              onChange={(e) => setCompanyAddress(e.target.value)}
              placeholder="東京都渋谷区..."
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="companyPhone">電話番号</Label>
            <Input
              id="companyPhone"
              type="tel"
              value={companyPhone}
              onChange={(e) => setCompanyPhone(e.target.value)}
              placeholder="03-0000-0000"
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="companyEmail">メールアドレス</Label>
            <Input
              id="companyEmail"
              type="email"
              value={companyEmail}
              onChange={(e) => setCompanyEmail(e.target.value)}
              placeholder="info@example.com"
            />
          </div>
          <Button className="w-full" onClick={next}>
            次へ
          </Button>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="sy-4">
          <h3 className="font-medium">店舗情報</h3>
          <p className="text-sm text-muted-foreground">
            最初の店舗を登録します。後から変更・追加できます。
          </p>
          <div className="sy-2">
            <Label htmlFor="storeName">店舗名 *</Label>
            <Input
              id="storeName"
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
              placeholder="ビューティーサロン 渋谷店"
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="storePostalCode">郵便番号</Label>
            <Input
              id="storePostalCode"
              value={storePostalCode}
              onChange={(e) => setStorePostalCode(e.target.value)}
              placeholder="000-0000"
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="storeAddress">住所</Label>
            <Input
              id="storeAddress"
              value={storeAddress}
              onChange={(e) => setStoreAddress(e.target.value)}
              placeholder="東京都渋谷区..."
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="storePhone">電話番号</Label>
            <Input
              id="storePhone"
              type="tel"
              value={storePhone}
              onChange={(e) => setStorePhone(e.target.value)}
              placeholder="03-0000-0000"
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="storeEmail">メールアドレス</Label>
            <Input
              id="storeEmail"
              type="email"
              value={storeEmail}
              onChange={(e) => setStoreEmail(e.target.value)}
              placeholder="shop@example.com"
            />
          </div>
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={back}>
              戻る
            </Button>
            <Button className="flex-1" onClick={next}>
              次へ
            </Button>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="sy-4">
          <h3 className="font-medium">アカウント設定</h3>
          <p className="text-sm text-muted-foreground">
            お名前・メールアドレス・パスワードを設定します。この情報で管理画面にログインします。
          </p>
          <div className="sy-2">
            <Label htmlFor="ownerName">お名前 *</Label>
            <Input
              id="ownerName"
              autoComplete="name"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              placeholder="山田 花子"
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="email">メールアドレス *</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="password">新しいパスワード *</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`${PASSWORD_MIN_LENGTH}文字以上`}
              minLength={PASSWORD_MIN_LENGTH}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="confirmPassword">パスワード（確認） *</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="パスワードを再入力"
              minLength={PASSWORD_MIN_LENGTH}
            />
          </div>
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={back}>
              戻る
            </Button>
            <Button className="flex-1" onClick={() => void complete()} disabled={busy}>
              {busy ? '設定中...' : '設定完了'}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 text-center">
        <Link to="/login" className="text-sm text-muted-foreground hover:underline">
          アカウントをお持ちの方はログイン
        </Link>
      </div>
    </AuthCard>
  );
}
