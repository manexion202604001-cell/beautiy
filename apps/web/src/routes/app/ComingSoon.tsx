import { useParams } from 'react-router';
import { NAV } from '../../components/layout/nav';
import { ButtonLink, EmptyState } from '../../components/ui';

/** Placeholder for modules delivered in a later pass (POS, kartes, messaging, ...) */
export default function ComingSoon() {
  const { feature = '' } = useParams();
  const item = NAV.flatMap((s) => s.items).find((i) => i.to.endsWith(`/${feature}`));
  return (
    <div className="py-10">
      <EmptyState
        icon={item?.icon ?? 'sparkle'}
        title={`${item?.label ?? 'この機能'}は準備中です`}
        description="次回のアップデートで利用できるようになります。"
        action={<ButtonLink to="/app">ダッシュボードへ</ButtonLink>}
      />
    </div>
  );
}
