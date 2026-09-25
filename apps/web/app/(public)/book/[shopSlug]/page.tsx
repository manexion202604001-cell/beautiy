import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { CalendarX2 } from 'lucide-react';
import { loadPublicShop, signFormToken } from '@/lib/server/reservations';
import { verifyLineLink } from '@/lib/server/line-link';
import { Empty } from '@/components/ui';
import { BookingWizard } from './BookingWizard';
import { PublicFooter, PublicHeader } from './PublicHeader';

type Params = Promise<{ shopSlug: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { shopSlug } = await params;
  const data = await loadPublicShop(shopSlug);
  return { title: data ? `${data.shop.name} ネット予約` : 'ネット予約' };
}

export default async function BookPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const { shopSlug } = await params;
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : null);
  const data = await loadPublicShop(shopSlug);
  if (!data) notFound();
  const { shop } = data;
  const lk = str('lk');
  const link = verifyLineLink(lk);
  const lineLinked = !!link && link.orgId === shop.orgId;
  const src = str('src');
  const preStaff = str('staff');

  return (
    <>
      <PublicHeader name={shop.name} slug={shop.slug} phone={shop.phone} imageUrl={shop.imageUrl} sub={shop.bookingMode === 'REQUEST' ? 'ネット予約（リクエスト制）' : 'ネット予約'} />
      <main className="public-body">
        {data.menus.length === 0 ? (
          <div className="card">
            <Empty title="現在ネット予約を受け付けていません" icon={<CalendarX2 size={20} />}>
              {shop.phone ? <>お手数ですがお電話（<a className="link" href={`tel:${shop.phone}`}>{shop.phone}</a>）でご予約ください。</> : 'お手数ですが店舗へ直接お問い合わせください。'}
            </Empty>
          </div>
        ) : (
          <BookingWizard
            shop={{ name: shop.name, slug: shop.slug, phone: shop.phone, bookingMode: shop.bookingMode, cancelDeadlineHours: shop.cancelDeadlineHours, address: shop.address }}
            menus={data.menus}
            coupons={data.coupons}
            staff={data.staff}
            days={data.days}
            formToken={signFormToken()}
            lk={lineLinked ? lk : null}
            lineLinked={lineLinked}
            src={src === 'instagram' || src === 'google' ? src : null}
            preStaffId={preStaff && data.staff.some((s) => s.userId === preStaff) ? preStaff : null}
          />
        )}
        <PublicFooter />
      </main>
    </>
  );
}
