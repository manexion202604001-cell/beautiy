import { requirePage } from '@/lib/server/session';
import { PageHeader } from '@/components/ui';
import { ImportWizard } from '../_components/ImportWizard';

export const metadata = { title: '顧客インポート' };

export default async function ImportPage() {
  await requirePage('customer.import');
  return (
    <div style={{ maxWidth: 1100 }}>
      <PageHeader title="顧客インポート" back={{ href: '/customers', label: '顧客一覧' }} sub="他システムや表計算ソフトの顧客リストをCSVで取り込みます。取り込み前に重複チェックの結果を確認できます。" />
      <ImportWizard />
    </div>
  );
}
