import { requirePage } from '@/lib/server/session';
import { PageHeader, Card } from '@/components/ui';

export const metadata = { title: 'ダッシュボード' };

export default async function DashboardPage() {
  const ctx = await requirePage();
  return (
    <>
      <PageHeader title="ダッシュボード" sub={`${ctx.org.name} / ${ctx.shop.name}`} />
      <Card title="準備中">ダッシュボードは分析モジュールで実装されます。</Card>
    </>
  );
}
