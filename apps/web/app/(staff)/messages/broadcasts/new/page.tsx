import { requirePage } from '@/lib/server/session';
import { PageHeader } from '@/components/ui';
import { BroadcastBuilder } from '../BroadcastBuilder';
import { builderOptions } from '../data';

export const metadata = { title: '一斉配信を作成' };

export default async function NewBroadcastPage() {
  const ctx = await requirePage('message.broadcast');
  const opts = await builderOptions(ctx);
  return (
    <>
      <PageHeader title="一斉配信を作成" back={{ href: '/messages/broadcasts', label: '一斉配信' }} sub="配信停止中・連絡先のないお客様は自動的に除外されます" />
      <BroadcastBuilder {...opts} />
    </>
  );
}
