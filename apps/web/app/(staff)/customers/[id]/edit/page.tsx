import { notFound } from 'next/navigation';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { liveWhere, staffOptions } from '@/lib/server/crm';
import { readCustomerContact } from '@/lib/server/pii';
import { fullName } from '@/lib/server/customers';
import { PageHeader } from '@/components/ui';
import { CustomerForm } from '../../_components/CustomerForm';

export const metadata = { title: '顧客情報の編集' };

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage('customer.write');
  const { id } = await params;
  const c = await prisma.customer.findFirst({ where: { id, ...liveWhere(ctx.org.id) } });
  if (!c) notFound();
  const [staff, contact] = await Promise.all([staffOptions(ctx.org.id), readCustomerContact(ctx, c, 'edit')]);
  return (
    <div style={{ maxWidth: 860 }}>
      <PageHeader title={`${fullName(c)} 様の編集`} back={{ href: `/customers/${c.id}`, label: '顧客詳細' }} />
      <CustomerForm
        contactEditable={!contact.masked}
        maskedHints={contact.masked ? { phone: contact.phone ?? '', email: contact.email ?? '', address: contact.address } : undefined}
        staff={staff}
        shops={ctx.shops.map((s) => ({ id: s.id, name: s.name }))}
        initial={{
          id: c.id, lastName: c.lastName, firstName: c.firstName, lastNameKana: c.lastNameKana ?? '', firstNameKana: c.firstNameKana ?? '',
          phone: contact.masked ? '' : contact.phone ?? '', email: contact.masked ? '' : contact.email ?? '', address: contact.masked ? '' : contact.address ?? '',
          birthday: c.birthday ?? '', gender: c.gender ?? '', notes: c.notes ?? '', assignedStaffId: c.assignedStaffId ?? '', primaryShopId: c.primaryShopId ?? '',
          lineOptIn: c.lineOptIn, emailOptIn: c.emailOptIn, favorite: c.favorite,
        }}
      />
    </div>
  );
}
