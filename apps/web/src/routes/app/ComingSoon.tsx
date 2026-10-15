import { ButtonLink, EmptyState } from '../../components/ui';

/** Placeholder for modules delivered in a later pass (POS, kartes, messaging, ...) */
export default function ComingSoon() {
  return (
    <div className="py-10">
      <EmptyState
        icon="sparkle"
        title="この機能は準備中です"
        description="次回のアップデートで利用できるようになります。"
        action={<ButtonLink to="/app">ダッシュボードへ</ButtonLink>}
      />
    </div>
  );
}
