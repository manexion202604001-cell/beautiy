import type { Tx } from './db';

export function slugify(s: string): string {
  const ascii = s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii.slice(0, 40);
}

export async function uniqueShopSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name) || 'shop';
  let slug = base;
  for (let i = 0; await tx.shop.findUnique({ where: { slug } }); i++) slug = `${base}-${Math.random().toString(36).slice(2, 7)}`;
  return slug;
}

/** Sensible defaults so a new shop can take bookings immediately. */
export async function createDefaultShopSetup(tx: Tx, orgId: string, shopId: string) {
  // Tue–Sun 10:00–20:00, Monday closed
  await tx.businessHour.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ shopId, weekday, openMin: 600, closeMin: weekday === 0 ? 1080 : 1200, closed: weekday === 1 })),
    skipDuplicates: true,
  });
  const menus = [
    { category: 'カット', name: 'カット', durationMin: 60, price: 5500 },
    { category: 'カラー', name: 'カラー', durationMin: 90, price: 8800 },
    { category: 'セット', name: 'カット＋カラー', durationMin: 120, price: 13200 },
    { category: 'トリートメント', name: 'トリートメント', durationMin: 30, price: 3300 },
    { category: '相談', name: 'カウンセリング（無料相談）', durationMin: 30, price: 0, isConsultation: true },
  ];
  await tx.menu.createMany({ data: menus.map((m, i) => ({ ...m, organizationId: orgId, shopId, sortOrder: i })) });
}
