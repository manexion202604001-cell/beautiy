'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Package, Trash2 } from 'lucide-react';
import { yen } from '@/lib/format';
import { STORE_FREE_SHIPPING_FROM, shippingFeeFor } from '@/lib/pos-shared';
import { useCart } from '../_components/cart';
import { placeOrderAction } from '../actions';

type P = { id: string; name: string; brand: string | null; price: number; stock: number; imageUrl: string | null; subscriptionIntervalDays: number | null };

export function CartClient({ slug, products, onlinePayment }: { slug: string; products: P[]; onlinePayment: boolean }) {
  const [cart, save] = useCart(slug);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const lines = useMemo(() => (cart?.items ?? []).map((i) => ({ ...i, product: products.find((p) => p.id === i.productId) })), [cart, products]);
  const unavailable = lines.filter((l) => !l.product);
  const valid = lines.filter((l) => l.product) as (typeof lines[number] & { product: P })[];
  const subtotal = valid.reduce((a, l) => a + l.product.price * l.quantity, 0);
  const shipping = shippingFeeFor(subtotal);
  const subscribable = valid.filter((l) => l.product.subscriptionIntervalDays);
  const stockIssue = valid.find((l) => l.quantity > l.product.stock);

  if (!cart) return <div className="card"><div className="skeleton" style={{ height: 120 }} /></div>;
  if (!lines.length) return (
    <div className="card empty">
      <div className="empty-icon"><Package size={20} /></div>
      <h3>カートは空です</h3>
      <div className="sub" style={{ marginBottom: 10 }}>気になる商品をカートに追加してください。</div>
      <Link className="btn" href={`/store/${slug}`}>商品一覧へ</Link>
    </div>
  );

  const setQty = (productId: string, q: number) => save({ ...cart, items: cart.items.map((i) => (i.productId === productId ? { ...i, quantity: Math.max(1, Math.min(99, q)) } : i)) });
  const remove = (productId: string) => save({ ...cart, items: cart.items.filter((i) => i.productId !== productId) });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!cart) return;
    const fd = new FormData(e.currentTarget);
    setBusy(true); setError(null); setFieldErrors({});
    try {
      const r = await placeOrderAction({
        shopSlug: slug, items: valid.map((l) => ({ productId: l.productId, quantity: l.quantity })),
        name: String(fd.get('name') ?? ''), email: String(fd.get('email') ?? ''), phone: String(fd.get('phone') ?? ''),
        postalCode: String(fd.get('postalCode') ?? ''), address: String(fd.get('address') ?? ''),
        subscribe: fd.get('subscribe') === 'on', rec: cart.rec ?? null, website: String(fd.get('website') ?? ''),
      });
      if (!r.ok) { setError(r.error); setFieldErrors(r.fieldErrors ?? {}); setBusy(false); return; }
      save({ items: [] });
      window.location.href = r.data!.url;
    } catch {
      setError('通信に失敗しました。時間をおいて再度お試しください。'); setBusy(false);
    }
  }

  const fe = (k: string) => fieldErrors[k] ? <div className="error">{fieldErrors[k]}</div> : null;
  return (
    <div className="stack">
      <div className="card">
        {unavailable.length > 0 && <div className="alert warn" style={{ marginBottom: 8 }}>販売を終了した商品がカートから除外されています。<button type="button" className="link" style={{ border: 0, background: 'none' }} onClick={() => save({ ...cart, items: cart.items.filter((i) => products.some((p) => p.id === i.productId)) })}>削除する</button></div>}
        {valid.map((l) => (
          <div key={l.productId} className="cart-line">
            <span className="product-thumb" style={{ width: 56, height: 56 }}>{l.product.imageUrl ? <img src={l.product.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Package size={18} />}</span>
            <div style={{ minWidth: 0 }}>
              <Link href={`/store/${slug}/p/${l.productId}`} style={{ fontWeight: 700 }}>{l.product.name}</Link>
              <div className="sub">{yen(l.product.price)}{l.quantity > l.product.stock && <span className="form-error"> ・ 在庫 {Math.max(0, l.product.stock)}点のみ</span>}</div>
              <div className="row" style={{ gap: 6, marginTop: 4 }}>
                <select className="select sm" style={{ width: 72 }} value={l.quantity} onChange={(e) => setQty(l.productId, Number(e.target.value))} aria-label="数量">
                  {Array.from({ length: Math.max(10, l.quantity) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <button type="button" className="icon-btn" onClick={() => remove(l.productId)} aria-label="削除"><Trash2 size={15} /></button>
              </div>
            </div>
            <strong className="num">{yen(l.product.price * l.quantity)}</strong>
          </div>
        ))}
        <dl className="kv" style={{ marginTop: 12, gridTemplateColumns: '1fr auto' }}>
          <dt>小計</dt><dd className="num right">{yen(subtotal)}</dd>
          <dt>送料{shipping > 0 && <span className="sub">（あと{yen(STORE_FREE_SHIPPING_FROM - subtotal)}で無料）</span>}</dt><dd className="num right">{shipping ? yen(shipping) : '無料'}</dd>
          <dt style={{ fontWeight: 800, color: 'var(--ink)' }}>合計（税込）</dt><dd className="num right" style={{ fontWeight: 800, fontSize: 18 }}>{yen(subtotal + shipping)}</dd>
        </dl>
      </div>

      <form className="card" onSubmit={submit} noValidate>
        <h2 style={{ marginBottom: 12 }}>ご注文者・お届け先</h2>
        <div className="form-grid">
          <div className="field"><label htmlFor="name" className="req">お名前</label><input id="name" name="name" className="input" autoComplete="name" required maxLength={60} />{fe('name')}</div>
          <div className="field"><label htmlFor="phone" className="req">電話番号</label><input id="phone" name="phone" className="input" type="tel" autoComplete="tel" required inputMode="tel" />{fe('phone')}</div>
          <div className="field full"><label htmlFor="email" className="req">メールアドレス</label><input id="email" name="email" className="input" type="email" autoComplete="email" required />{fe('email')}</div>
          <div className="field"><label htmlFor="postalCode">郵便番号</label><input id="postalCode" name="postalCode" className="input" autoComplete="postal-code" inputMode="numeric" placeholder="150-0001" />{fe('postalCode')}</div>
          <div className="field full"><label htmlFor="address" className="req">お届け先住所</label><input id="address" name="address" className="input" autoComplete="street-address" required maxLength={200} placeholder="都道府県・市区町村・番地・建物名" />{fe('address')}</div>
          <input type="text" name="website" tabIndex={-1} autoComplete="off" style={{ position: 'absolute', left: -9999, width: 1, height: 1 }} aria-hidden="true" />
          {subscribable.length > 0 && (
            <label className="checkbox full" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" name="subscribe" defaultChecked={!!cart.subscribe} />
              <span>定期便で購入する<br /><span className="sub">{subscribable.map((l) => `${l.product.name}：${l.product.subscriptionIntervalDays}日ごと`).join(' / ')}。次回以降のお届け日はサロンからご連絡します。いつでも停止できます。</span></span>
            </label>
          )}
        </div>
        <div className="alert info" style={{ marginTop: 12 }}>
          {onlinePayment ? 'お支払い方法：クレジットカード（次の画面で安全に決済します）' : 'お支払い方法：店頭受け取り時にお支払い（デモ）'}
        </div>
        {error && <div className="alert error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
        {stockIssue && <div className="alert warn" style={{ marginTop: 12 }}>「{stockIssue.product.name}」の在庫が不足しています。数量を変更してください。</div>}
        <button className="btn lg block" style={{ marginTop: 14 }} disabled={busy || !valid.length || !!stockIssue}>
          {busy ? <><span className="spinner" /> 送信中…</> : onlinePayment ? `お支払いへ進む（${yen(subtotal + shipping)}）` : `注文を確定する（${yen(subtotal + shipping)}）`}
        </button>
        <div className="sub center" style={{ marginTop: 8 }}>ご入力いただいた個人情報は暗号化して保存し、注文の処理・配送のためにのみ利用します。</div>
      </form>
    </div>
  );
}
