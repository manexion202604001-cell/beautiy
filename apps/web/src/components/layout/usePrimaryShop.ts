import { useStaffMember } from '../../api/org';
import { useAuth } from '../../lib/auth';

/** The signed-in staff member's main shop (marked 「主」 in the shop switcher and on 設定 › 店舗一覧) */
export function usePrimaryShopId(): string | undefined {
  const { me, can } = useAuth();
  const mine = useStaffMember(can('staff.read') ? me?.staff.id : undefined);
  return mine.data?.shops.find((s) => s.is_primary)?.shop_id;
}
