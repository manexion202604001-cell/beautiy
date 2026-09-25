import { requirePage } from '@/lib/server/session';
import { staffOptions } from '@/lib/server/crm';
import { PageHeader } from '@/components/ui';
import { CustomerForm } from '../_components/CustomerForm';

export const metadata = { title: '新規顧客' };

export default async function NewCustomerPage() {
  const ctx = await requirePage('customer.write');
  const staff = await staffOptions(ctx.org.id);
  return (
    <div style={{ maxWidth: 860 }}>
      <PageHeader title="新規顧客" back={{ href: '/customers', label: '顧客一覧' }} sub="電話番号・メールは暗号化して保存され、重複チェックに使われます。" />
      <CustomerForm
        contactEditable
        staff={staff}
        shops={ctx.shops.map((s) => ({ id: s.id, name: s.name }))}
        initial={{
          lastName: '', firstName: '', lastNameKana: '', firstNameKana: '', phone: '', email: '', address: '', birthday: '', gender: '', notes: '',
          assignedStaffId: '', primaryShopId: ctx.shop.id, lineOptIn: true, emailOptIn: true, favorite: false,
        }}
      />
    </div>
  );
}
