import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getStaffContext } from '@/lib/server/session';
import { env } from '@/lib/server/env';
import { safeNextPath } from '@/lib/safe-redirect';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'ログイン' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getStaffContext()) redirect('/dashboard');
  const { next } = await searchParams;
  return (
    <div className="auth-card">
      <h1>ログイン</h1>
      <p className="sub" style={{ marginBottom: 20 }}>スタッフアカウントでログインしてください</p>
      <div className="card"><LoginForm next={safeNextPath(next, '') || undefined} demo={env.demoMode} /></div>
      {env.demoMode && <div className="alert info" style={{ marginTop: 14 }}>デモ環境：owner@demo.salon / demo1234（stylist1@demo.salon なども利用可）</div>}
      <p className="sub center" style={{ marginTop: 18 }}>はじめての方は <Link href="/signup" className="link">サロンを新規登録</Link></p>
    </div>
  );
}
