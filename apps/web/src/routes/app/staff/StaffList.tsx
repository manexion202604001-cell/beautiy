import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useRoles, useStaffList } from '../../../api/org';
import {
  Avatar,
  Badge,
  ButtonLink,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  InlineLoading,
  PageHeader,
  Select,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatYen } from '../../../lib/format';
import { StaffCreateDialog } from './StaffCreateDialog';
import { EMPLOYMENT_LABEL, STAFF_STATUS } from './shared';

export default function StaffList() {
  const { can, shops, currentShopId } = useAuth();
  const navigate = useNavigate();
  const [shopFilter, setShopFilter] = useState<string>(currentShopId ?? '');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const staff = useStaffList({ shopId: shopFilter || undefined, includeInactive });
  useRoles();
  const shopName = (id: string) => shops.find((s) => s.id === id)?.name ?? '他店舗';

  return (
    <div>
      <PageHeader
        title="スタッフ"
        description="スタッフの招待・権限・所属店舗・勤務パターンを管理します。"
        actions={
          <>
            {can('role.manage') || can('staff.read') ? (
              <ButtonLink to="/app/staff/roles" icon="shield" variant="ghost">
                権限ロール
              </ButtonLink>
            ) : null}
            {can('staff.manage') ? (
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                スタッフを追加
              </Button>
            ) : null}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="w-56">
          <label htmlFor="staff-shop" className="sr-only">
            店舗
          </label>
          <Select
            id="staff-shop"
            value={shopFilter}
            onChange={(e) => setShopFilter(e.target.value)}
          >
            <option value="">すべての店舗</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <Checkbox
          label="退職・休止中のスタッフも表示"
          checked={includeInactive}
          onChange={(e) => setIncludeInactive(e.target.checked)}
        />
      </div>
      {staff.isLoading ? <InlineLoading /> : null}
      {staff.error ? <ErrorState error={staff.error} onRetry={() => void staff.refetch()} /> : null}
      {staff.data && !staff.data.length ? (
        <EmptyState icon="user" title="スタッフがいません" />
      ) : null}
      {staff.data?.length ? (
        <Table caption="スタッフ一覧">
          <THead>
            <tr>
              <Th>スタッフ</Th>
              <Th>権限</Th>
              <Th>所属店舗</Th>
              <Th>予約</Th>
              <Th className="text-right">指名料</Th>
              <Th>状態</Th>
            </tr>
          </THead>
          <TBody>
            {staff.data.map((s) => (
              <Tr key={s.id} interactive onClick={() => navigate(`/app/staff/${s.id}`)}>
                <Td>
                  <div className="flex items-center gap-3">
                    <Avatar name={s.display_name} color={s.color} size={34} />
                    <div className="min-w-0">
                      <a
                        href={`/app/staff/${s.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`/app/staff/${s.id}`);
                        }}
                        className="font-medium hover:text-primary hover:underline"
                      >
                        {s.display_name}
                      </a>
                      <p className="text-xs text-muted">
                        {[s.title, EMPLOYMENT_LABEL[s.employment_type]]
                          .filter(Boolean)
                          .join(' ・ ')}
                      </p>
                    </div>
                  </div>
                </Td>
                <Td>
                  {s.role ? (
                    <Badge tone={s.role.key === 'owner' ? 'primary' : 'neutral'}>
                      {s.role.name}
                    </Badge>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td className="text-[13px]">
                  {s.shops.length
                    ? s.shops.map((a) => (
                        <span key={a.shop_id} className="mr-2 inline-block">
                          {shopName(a.shop_id)}
                          {a.is_primary && s.shops.length > 1 ? (
                            <span className="text-xs text-muted">（主）</span>
                          ) : null}
                        </span>
                      ))
                    : '—'}
                </Td>
                <Td>
                  {s.is_bookable ? <Badge tone="success">受付可</Badge> : <Badge>受付なし</Badge>}
                </Td>
                <Td className="text-right tabular">
                  {s.nomination_fee ? formatYen(s.nomination_fee) : '—'}
                </Td>
                <Td>
                  <Badge tone={STAFF_STATUS[s.status]?.tone ?? 'neutral'}>
                    {STAFF_STATUS[s.status]?.label ?? s.status}
                  </Badge>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
      {creating ? <StaffCreateDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
