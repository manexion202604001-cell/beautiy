import type { ShopInput } from '../../../api/org';
import type { Shop } from '../../../api/types';

/** Shops keep the address in three columns; the 店舗設定 screen edits it as one line */
export function addressOf(shop: Pick<Shop, 'prefecture' | 'city' | 'address_line'>): string {
  return [shop.prefecture, shop.city, shop.address_line].filter(Boolean).join('');
}

/** Split the edited one-line address back, keeping the prefecture / city parts it still starts with */
export function splitAddress(
  text: string,
  shop: Pick<Shop, 'prefecture' | 'city'>,
): Required<Pick<ShopInput, 'prefecture' | 'city' | 'addressLine'>> {
  const value = text.trim();
  const prefecture = shop.prefecture ?? '';
  const city = shop.city ?? '';
  if (prefecture && value.startsWith(prefecture + city)) {
    return {
      prefecture,
      city: city || null,
      addressLine: value.slice((prefecture + city).length) || null,
    };
  }
  if (prefecture && value.startsWith(prefecture)) {
    return { prefecture, city: null, addressLine: value.slice(prefecture.length) || null };
  }
  return { prefecture: null, city: null, addressLine: value || null };
}
