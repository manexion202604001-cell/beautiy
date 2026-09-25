import Link from 'next/link';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { PageHeader, Card, Field, Badge, Empty, Tabs } from '@/components/ui';
import { ConfirmAction } from '@/components/client';
import { fmtDate, yen } from '@/lib/format';
import { FormModal } from '../_components/client';
import { deleteCouponAction, deleteMenuAction, saveCouponAction, saveMenuAction, setMenuActiveAction } from './actions';

export const metadata = { title: 'メニュー・クーポン' };

type MenuRow = Awaited<ReturnType<typeof prisma.menu.findMany>>[number];
type CouponRow = Awaited<ReturnType<typeof prisma.coupon.findMany>>[number];

export default async function MenusPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requirePage('settings.menu');
  const sp = await searchParams;
  const tab = sp.tab === 'coupons' ? 'coupons' : 'menus';
  const tz = ctx.shop.timezone;
  const [menus, coupons] = await Promise.all([
    prisma.menu.findMany({ where: { shopId: ctx.shop.id, organizationId: ctx.org.id }, orderBy: [{ active: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.coupon.findMany({ where: { shopId: ctx.shop.id, organizationId: ctx.org.id }, orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] }),
  ]);
  const categories = [...new Set(menus.map((m) => m.category))];
  const menuName = new Map(menus.map((m) => [m.id, m.name]));
  const now = new Date();
  const dateVal = (d: Date | null, endOfDay = false) => (d ? fmtDate(endOfDay ? new Date(d.getTime()) : d, tz).replaceAll('/', '-') : '');

  const menuFields = (m?: MenuRow) => (
    <>
      {m && <input type="hidden" name="id" value={m.id} />}
      <datalist id="menu-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="form-grid">
        <Field label="カテゴリ" htmlFor={`cat-${m?.id ?? 'new'}`} required><input id={`cat-${m?.id ?? 'new'}`} name="category" list="menu-cats" className="input" defaultValue={m?.category ?? ''} required maxLength={30} placeholder="例：カット" /></Field>
        <Field label="メニュー名" htmlFor={`nm-${m?.id ?? 'new'}`} required><input id={`nm-${m?.id ?? 'new'}`} name="name" className="input" defaultValue={m?.name ?? ''} required maxLength={80} /></Field>
        <Field label="所要時間（分）" htmlFor={`du-${m?.id ?? 'new'}`} required hint="5分単位。予約枠の長さになります"><input id={`du-${m?.id ?? 'new'}`} name="durationMin" type="number" min={5} max={600} step={5} className="input" defaultValue={m?.durationMin ?? 60} required /></Field>
        <Field label="料金（税込・円）" htmlFor={`pr-${m?.id ?? 'new'}`} required><input id={`pr-${m?.id ?? 'new'}`} name="price" type="number" min={0} max={1000000} step={10} className="input" defaultValue={m?.price ?? 0} required /></Field>
        <Field label="説明（予約ページに表示）" htmlFor={`de-${m?.id ?? 'new'}`} full><textarea id={`de-${m?.id ?? 'new'}`} name="description" className="textarea" defaultValue={m?.description ?? ''} maxLength={500} /></Field>
        <Field label="表示順" htmlFor={`so-${m?.id ?? 'new'}`}><input id={`so-${m?.id ?? 'new'}`} name="sortOrder" type="number" className="input" defaultValue={m?.sortOrder ?? menus.length} /></Field>
        <div className="field full stack-sm">
          <label className="checkbox"><input type="checkbox" name="publicBookable" defaultChecked={m?.publicBookable ?? true} />ネット予約で選択できる</label>
          <label className="checkbox"><input type="checkbox" name="isConsultation" defaultChecked={m?.isConsultation ?? false} />相談・カウンセリング予約として扱う</label>
          <label className="checkbox"><input type="checkbox" name="active" defaultChecked={m?.active ?? true} />受付中（オフにすると予約・POSの選択肢から外れます）</label>
        </div>
      </div>
    </>
  );

  const couponFields = (c?: CouponRow) => (
    <>
      {c && <input type="hidden" name="id" value={c.id} />}
      <div className="form-grid">
        <Field label="クーポン名" htmlFor={`cn-${c?.id ?? 'new'}`} required full><input id={`cn-${c?.id ?? 'new'}`} name="name" className="input" defaultValue={c?.name ?? ''} required maxLength={80} /></Field>
        <Field label="割引の種類" htmlFor={`ct-${c?.id ?? 'new'}`} required>
          <select id={`ct-${c?.id ?? 'new'}`} name="discountType" className="select" defaultValue={c?.discountType ?? 'AMOUNT'}><option value="AMOUNT">金額（円引き）</option><option value="PERCENT">割合（%引き）</option></select>
        </Field>
        <Field label="割引額 / 割引率" htmlFor={`cv-${c?.id ?? 'new'}`} required><input id={`cv-${c?.id ?? 'new'}`} name="discountValue" type="number" min={1} max={1000000} className="input" defaultValue={c?.discountValue ?? 1000} required /></Field>
        <Field label="利用開始日" htmlFor={`cf-${c?.id ?? 'new'}`}><input id={`cf-${c?.id ?? 'new'}`} name="validFrom" type="date" className="input" defaultValue={dateVal(c?.validFrom ?? null)} /></Field>
        <Field label="利用終了日" htmlFor={`cto-${c?.id ?? 'new'}`}><input id={`cto-${c?.id ?? 'new'}`} name="validTo" type="date" className="input" defaultValue={dateVal(c?.validTo ?? null, true)} /></Field>
        <Field label="クーポンコード（任意）" htmlFor={`cc-${c?.id ?? 'new'}`} hint="店頭で入力する場合のコード"><input id={`cc-${c?.id ?? 'new'}`} name="code" className="input mono" defaultValue={c?.code ?? ''} maxLength={30} /></Field>
        <Field label="説明・利用条件" htmlFor={`cd-${c?.id ?? 'new'}`} full><textarea id={`cd-${c?.id ?? 'new'}`} name="description" className="textarea" defaultValue={c?.description ?? ''} maxLength={500} /></Field>
        <div className="field full">
          <span className="label">対象メニュー（未選択なら全メニュー）</span>
          <div className="row-wrap">{menus.filter((m) => m.active || c?.menuIds.includes(m.id)).map((m) => <label key={m.id} className="checkbox"><input type="checkbox" name="menuIds" value={m.id} defaultChecked={c?.menuIds.includes(m.id)} />{m.name}</label>)}</div>
        </div>
        <div className="field full stack-sm">
          <label className="checkbox"><input type="checkbox" name="newCustomerOnly" defaultChecked={c?.newCustomerOnly ?? false} />新規のお客様限定</label>
          <label className="checkbox"><input type="checkbox" name="publicBookable" defaultChecked={c?.publicBookable ?? true} />ネット予約ページに掲載する</label>
          <label className="checkbox"><input type="checkbox" name="active" defaultChecked={c?.active ?? true} />有効</label>
        </div>
      </div>
    </>
  );

  return (
    <>
      <PageHeader
        title="メニュー・クーポン" back={{ href: '/settings', label: '設定' }} sub={`${ctx.shop.name}（店舗ごとに設定します）`}
        actions={tab === 'menus'
          ? <FormModal label="メニューを追加" title="メニューを追加" action={saveMenuAction} wide>{menuFields()}</FormModal>
          : <FormModal label="クーポンを追加" title="クーポンを追加" action={saveCouponAction} wide>{couponFields()}</FormModal>}
      />
      <Tabs active={tab} items={[{ key: 'menus', href: '/settings/menus', label: `メニュー（${menus.length}）` }, { key: 'coupons', href: '/settings/menus?tab=coupons', label: `クーポン（${coupons.length}）` }]} />

      {tab === 'menus' ? (
        menus.length === 0 ? <Card><Empty title="メニューがありません" action={<FormModal label="最初のメニューを追加" title="メニューを追加" action={saveMenuAction} wide>{menuFields()}</FormModal>}>ネット予約とPOSで使うメニューを登録しましょう。</Empty></Card> : (
          <div className="stack">
            {categories.map((cat) => (
              <Card key={cat} flush title={cat}>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>メニュー</th><th className="num">時間</th><th className="num">料金</th><th>ネット予約</th><th>状態</th><th /></tr></thead>
                    <tbody>
                      {menus.filter((m) => m.category === cat).map((m) => (
                        <tr key={m.id} className={m.active ? '' : 'row-muted'}>
                          <td><b>{m.name}</b>{m.isConsultation && <> <Badge tone="violet">相談</Badge></>}{m.description && <div className="sub" style={{ maxWidth: 420 }}>{m.description}</div>}</td>
                          <td className="num">{m.durationMin}分</td>
                          <td className="num">{yen(m.price)}</td>
                          <td>{m.publicBookable ? <Badge tone="blue">掲載</Badge> : <span className="sub">非掲載</span>}</td>
                          <td>{m.active ? <Badge tone="green">受付中</Badge> : <Badge>停止</Badge>}</td>
                          <td className="right nowrap">
                            <FormModal label="編集" className="btn secondary sm" title="メニューを編集" action={saveMenuAction} wide>{menuFields(m)}</FormModal>{' '}
                            {m.active
                              ? <ConfirmAction action={setMenuActiveAction} fields={{ id: m.id, active: '0' }} className="btn ghost sm">受付停止</ConfirmAction>
                              : <ConfirmAction action={setMenuActiveAction} fields={{ id: m.id, active: '1' }} className="btn ghost sm">再開</ConfirmAction>}{' '}
                            <ConfirmAction action={deleteMenuAction} fields={{ id: m.id }} confirm={`「${m.name}」を削除しますか？`} className="btn ghost sm">削除</ConfirmAction>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : (
        <Card flush>
          {coupons.length === 0 ? <Empty title="クーポンがありません">新規向けや平日限定などのクーポンを作成できます。</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>クーポン</th><th>割引</th><th>対象</th><th>期間</th><th>条件</th><th>状態</th><th /></tr></thead>
                <tbody>
                  {coupons.map((c) => {
                    const expired = c.validTo && c.validTo < now;
                    return (
                      <tr key={c.id} className={c.active && !expired ? '' : 'row-muted'}>
                        <td><b>{c.name}</b>{c.code && <div className="mono sub">{c.code}</div>}{c.description && <div className="sub">{c.description}</div>}</td>
                        <td className="nowrap">{c.discountType === 'PERCENT' ? `${c.discountValue}%OFF` : `${yen(c.discountValue)}引き`}</td>
                        <td>{c.menuIds.length ? <div className="pill-list">{c.menuIds.map((id) => <Badge key={id}>{menuName.get(id) ?? '（削除済み）'}</Badge>)}</div> : <span className="sub">全メニュー</span>}</td>
                        <td className="nowrap sub">{c.validFrom || c.validTo ? `${c.validFrom ? fmtDate(c.validFrom, tz) : ''} 〜 ${c.validTo ? fmtDate(c.validTo, tz) : ''}` : '無期限'}</td>
                        <td><div className="pill-list">{c.newCustomerOnly && <Badge tone="green">新規限定</Badge>}{c.publicBookable ? <Badge tone="blue">ネット掲載</Badge> : <Badge>店頭のみ</Badge>}</div></td>
                        <td>{!c.active ? <Badge>無効</Badge> : expired ? <Badge tone="amber">期限切れ</Badge> : <Badge tone="green">有効</Badge>}</td>
                        <td className="right nowrap">
                          <FormModal label="編集" className="btn secondary sm" title="クーポンを編集" action={saveCouponAction} wide>{couponFields(c)}</FormModal>{' '}
                          <ConfirmAction action={deleteCouponAction} fields={{ id: c.id }} confirm={`「${c.name}」を削除しますか？`} className="btn ghost sm">削除</ConfirmAction>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      <p className="sub section">他店舗のメニューは、ヘッダーの店舗切替で店舗を切り替えて編集してください。{' '}<Link className="link" href="/reports/menus">メニュー別の売上ランキング →</Link></p>
    </>
  );
}
