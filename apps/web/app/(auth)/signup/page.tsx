import Link from 'next/link';
import { SignupForm } from './SignupForm';

export const metadata = { title: 'サロン新規登録' };

export default function SignupPage() {
  return (
    <div className="auth-card">
      <h1>サロンを新規登録</h1>
      <p className="sub" style={{ marginBottom: 20 }}>組織・店舗・オーナーアカウントを作成します</p>
      <div className="card"><SignupForm /></div>
      <p className="sub center" style={{ marginTop: 18 }}>アカウントをお持ちの方は <Link href="/login" className="link">ログイン</Link></p>
    </div>
  );
}
