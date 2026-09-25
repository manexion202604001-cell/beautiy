import { forbidden } from 'next/navigation';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { PageHeader, Card, Field, Badge, Stat } from '@/components/ui';
import { ConfirmAction } from '@/components/client';
import { yen } from '@/lib/format';
import { resolvePeriod, salesByShop } from '@/lib/server/analytics';
import { FormModal } from '../_components/client';
import { createShopAction, setShopActiveAction } from './actions';

export const metadata = { title: '店舗管理' };

export default async function ShopsPage() {
  const ctx = await requirePage('settings.shop');
  if (ctx.role !== 'OWNER' && ctx.role !== 'DIRECTOR') forbidden();
  const shops = await prisma.shop.findMany({
    where: { organizationId: ctx.org.id }, orderBy: { createdAt: 'asc' },
    include: { _count: { select: { staff: true, menus: { where: { active: true } } } } },
  });
  const p = resolvePeriod({ range: 'thisMonth' }, ctx.shop.timezone);
  const rows = await salesByShop(ctx.org.id, shops.map((s) => s.id), p);
  const total = rows.reduce((a, r) => ({ net: a.net + r.net, tx: a.tx + r.tx }), { net: 0, tx: 0 });
  const activeCount = shops.filter((s) => s.active).length;

  return (
    <>
      <PageHeader
        title="店舗管理"
        back={{ href: '/settings', label: '設定' }}
        sub={`${ctx.org.name} ・ ${activeCount}店舗が稼働中`}
        actions={
          <FormModal label="店舗を追加" title="新しい店舗を追加" action={createShopAction} submitLabel="作成">
            <div className="form-grid">
              <Field label="店舗名" htmlFor="ns-name" required full><input id="ns-name" name="name" className="input" required maxLength={80} placeholder="例：表参道店" /></Field>
              <Field label="席数" htmlFor="ns-seat" required><input id="ns-seat" name="seatCount" type="number" min={1} max={100} defaultValue={3} className="input" required /></Field>
              <Field label="電話番号" htmlFor="ns-phone"><input id="ns-phone" name="phone" className="input" maxLength={30} /></Field>
              <Field label="住所" htmlFor="ns-addr" full><input id="ns-addr" name="address" className="input" maxLength={200} /></Field>
            </div>
            <p className="sub" style={{ marginTop: 10 }}>営業時間（火〜日 10:00–20:00）と基本メニューが初期設定されます。作成後、ヘッダーの店舗切替から各設定を調整してください。</p>
          </FormModal>
        }
      />
      <div className="grid-3">
        <Stat label="今月の全店舗売上（純売上）" value={yen(total.net)} sub={`${p.fromDate.replaceAll('-', '/')} 〜 本日`} />
        <Stat label="今月の会計件数" value={`${total.tx.toLocaleString('ja-JP')}件`} sub={`客単価 ${total.tx ? yen(Math.round(rows.reduce((s, r) => s + r.sales, 0) / total.tx)) : '—'}`} />
        <Stat label="稼働中の店舗" value={`${activeCount}店舗`} sub={`停止中 ${shops.length - activeCount}店舗`} />
      </div>
      <Card className="section" flush title="店舗一覧">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>店舗</th><th>公開URL</th><th className="num">席数</th><th className="num">スタッフ</th><th className="num">メニュー</th><th className="num">今月の純売上</th><th className="num">構成比</th><th className="num">会計数</th><th>状態</th><th /></tr></thead>
            <tbody>
              {shops.map((s) => {
                const r = rows.find((x) => x.shopId === s.id);
                return (
                  <tr key={s.id} className={s.active ? '' : 'row-muted'}>
                    <td><b>{s.name}</b>{s.id === ctx.shop.id && <> <Badge tone="blue">選択中</Badge></>}<div className="sub">{s.address ?? ''}</div></td>
                    <td className="mono">/book/{s.slug}</td>
                    <td className="num">{s.seatCount}</td>
                    <td className="num">{s._count.staff}</td>
                    <td className="num">{s._count.menus}</td>
                    <td className="num">{yen(r?.net ?? 0)}</td>
                    <td className="num">{total.net ? `${(((r?.net ?? 0) / total.net) * 100).toFixed(1)}%` : '—'}</td>
                    <td className="num">{(r?.tx ?? 0).toLocaleString('ja-JP')}</td>
                    <td>{s.active ? <Badge tone="green">稼働中</Badge> : <Badge>停止中</Badge>}</td>
                    <td className="right">
                      {s.active
                        ? <ConfirmAction action={setShopActiveAction} fields={{ id: s.id, active: '0' }} confirm={`「${s.name}」を停止しますか？ネット予約ページは表示されなくなり、店舗切替からも外れます（データは保持されます）。`} className="btn danger-outline sm">停止</ConfirmAction>
                        : <ConfirmAction action={setShopActiveAction} fields={{ id: s.id, active: '1' }} className="btn secondary sm">再開</ConfirmAction>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="sub section">店舗別の詳細な比較は <a className="link" href="/reports?scope=compare">分析・レポート（店舗別比較）</a> で確認できます。顧客情報は組織内の全店舗で共有されます。</p>
    </>
  );
}
