import { requirePage } from '@/lib/server/session';
import { Card, PageHeader } from '@/components/ui';
import { ProductForm } from '../ProductForm';

export const metadata = { title: '商品を登録' };

export default async function NewProductPage() {
  await requirePage('commerce.manage');
  return (
    <>
      <PageHeader title="商品を登録" back={{ href: '/commerce', label: '商品一覧' }} />
      <div style={{ maxWidth: 820 }}><Card><ProductForm /></Card></div>
    </>
  );
}
