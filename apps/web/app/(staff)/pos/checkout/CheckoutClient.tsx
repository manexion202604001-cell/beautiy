'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Minus, Plus, Search, Trash2, UserRound, X } from 'lucide-react';
import { computeTicket, settle, type CouponRule } from '@salonos/core';
import { Modal, CopyButton } from '@/components/client';
import { yen } from '@/lib/format';
import { LINE_KIND_LABEL, METHOD_LABEL, METHOD_SHORT, PAYMENT_METHODS, type DraftLine, type PaymentMethodName } from '@/lib/pos-shared';
import { checkoutAction, saveDraftAction, searchCustomersAction, startProviderPaymentAction, voidAction } from '../actions';

export interface CustomerLite { id: string; name: string; kana: string; visitCount: number; points: number }
export interface CheckoutInitial {
  transactionId: string | null; number: number | null; shopId: string; appointmentId: string | null; appointmentLabel: string | null;
  customer: CustomerLite | null; guestName?: string; staffId: string | null; defaultStaffId?: string;
  couponId: string | null; manualDiscount: number; pointsToUse: number; note: string; lines: DraftLine[];
}
type MenuOpt = { id: string; name: string; category: string; price: number; durationMin: number };
type ProductOpt = { id: string; name: string; brand: string | null; price: number; stock: number; sku: string | null };
type CouponOpt = { id: string; name: string; discountType: 'AMOUNT' | 'PERCENT'; discountValue: number; menuIds: string[]; newCustomerOnly: boolean };
type Line = DraftLine & { key: string };
type Tender = { key: string; method: PaymentMethodName; amount: number; label: string; reference: string };

let seq = 0;
const k = () => `k${++seq}`;
const num = (v: string) => { const n = Math.floor(Number(v.replace(/[^\d]/g, ''))); return Number.isFinite(n) ? n : 0; };

export function CheckoutClient({ initial, shop, menus, products, staff, coupons, registerOpen, providers, canSearchCustomers }: {
  initial: CheckoutInitial;
  shop: { id: string; name: string; taxRatePct: number; pointRatePct: number };
  menus: MenuOpt[]; products: ProductOpt[]; staff: { id: string; name: string }[]; coupons: CouponOpt[];
  registerOpen: boolean; providers: { stripe: 'live' | 'sandbox'; square: 'live' | 'sandbox' }; canSearchCustomers: boolean;
}) {
  const router = useRouter();
  const defaultStaff = initial.staffId ?? initial.defaultStaffId ?? null;
  const [txId, setTxId] = useState(initial.transactionId);
  const [lines, setLines] = useState<Line[]>(() => initial.lines.map((l) => ({ ...l, key: k() })));
  const [customer, setCustomer] = useState<CustomerLite | null>(initial.customer);
  const [couponId, setCouponId] = useState(initial.couponId ?? '');
  const [manualDiscount, setManualDiscount] = useState(initial.manualDiscount);
  const [pointsToUse, setPointsToUse] = useState(initial.pointsToUse);
  const [note, setNote] = useState(initial.note);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [busy, setBusy] = useState<null | 'save' | 'checkout' | 'provider' | 'discard'>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [custOpen, setCustOpen] = useState(false);
  const [providerLink, setProviderLink] = useState<{ provider: string; url: string | null; reference: string; sandbox: boolean } | null>(null);
  const [dirty, setDirty] = useState(false);

  const coupon = coupons.find((c) => c.id === couponId) ?? null;
  const rule: CouponRule | null = coupon ? { discountType: coupon.discountType, discountValue: coupon.discountValue } : null;
  const balance = customer?.points ?? 0;
  const totals = useMemo(() => computeTicket({
    lines, coupon: rule, manualDiscount, pointsToUse: customer ? pointsToUse : 0, pointsBalance: balance,
    taxRatePct: shop.taxRatePct, pointRatePct: shop.pointRatePct,
  }), [lines, rule?.discountType, rule?.discountValue, manualDiscount, pointsToUse, balance, customer, shop.taxRatePct, shop.pointRatePct]); // eslint-disable-line react-hooks/exhaustive-deps
  const settlement = settle(totals.total, tenders);
  const nonCash = tenders.filter((t) => t.method !== 'CASH').reduce((a, t) => a + t.amount, 0);
  const cashIn = tenders.filter((t) => t.method === 'CASH').reduce((a, t) => a + t.amount, 0);
  const cashDue = Math.max(0, totals.total - nonCash);
  const maxPoints = Math.min(balance, totals.subtotal - totals.discountTotal);
  const pointsOver = customer ? pointsToUse > balance : false;

  useEffect(() => { setDirty(true); }, [lines, customer, couponId, manualDiscount, pointsToUse, note]);
  useEffect(() => { setDirty(false); }, []); // initial mount is clean
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty && lines.length && busy !== 'checkout') { e.preventDefault(); } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty, lines.length, busy]);

  const payload = useCallback(() => ({
    transactionId: txId, shopId: initial.shopId, appointmentId: initial.appointmentId,
    draft: {
      customerId: customer?.id ?? null, staffId: initial.staffId,
      lines: lines.map(({ key: _k, ...l }) => l),
      couponId: couponId || null, manualDiscount, pointsToUse: customer ? pointsToUse : 0, note: note || null,
    },
  }), [txId, initial.shopId, initial.appointmentId, initial.staffId, customer, lines, couponId, manualDiscount, pointsToUse, note]);

  const rememberId = (id: string) => {
    if (id === txId) return;
    setTxId(id);
    window.history.replaceState(null, '', `/pos/checkout?transactionId=${id}`);
  };

  const fail = (r: { error: string; fieldErrors?: Record<string, string> }) =>
    setError([r.error, ...Object.values(r.fieldErrors ?? {})].join(' / '));

  async function save() {
    setBusy('save'); setError(null); setMessage(null);
    try {
      const r = await saveDraftAction(payload());
      if (!r.ok) return fail(r);
      rememberId(r.data!.id);
      setDirty(false);
      setMessage('下書きを保存しました');
    } catch { setError('保存に失敗しました。通信状況を確認して再試行してください。'); } finally { setBusy(null); }
  }

  async function confirm() {
    setBusy('checkout'); setError(null); setMessage(null);
    try {
      const r = await checkoutAction({
        ...payload(), expectedTotal: totals.total,
        tenders: tenders.map((t) => ({ method: t.method, amount: t.amount, label: t.label || null, reference: t.reference || null })),
      });
      if (!r.ok) { setBusy(null); return fail(r); }
      setDirty(false);
      router.push(`/pos/receipt/${r.data!.id}?done=1`);
    } catch { setBusy(null); setError('会計処理の結果を確認できませんでした。取引履歴で状態を確認してください。'); }
  }

  async function startProvider(provider: 'STRIPE' | 'SQUARE') {
    setBusy('provider'); setError(null); setMessage(null);
    try {
      const r = await startProviderPaymentAction({ ...payload(), provider });
      if (!r.ok) return fail(r);
      rememberId(r.data!.id);
      setDirty(false);
      setProviderLink({ provider, url: r.data!.url, reference: r.data!.reference, sandbox: r.data!.sandbox });
    } catch { setError('決済の開始に失敗しました。再試行してください。'); } finally { setBusy(null); }
  }

  async function discard() {
    if (!txId) { router.push('/pos'); return; }
    if (!window.confirm('この下書きを破棄しますか？')) return;
    setBusy('discard');
    const fd = new FormData(); fd.set('transactionId', txId);
    const r = await voidAction(fd);
    if (!r.ok) { setBusy(null); return fail(r); }
    setDirty(false);
    router.push('/pos');
  }

  // ── line editing ──
  const patch = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const remove = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));
  const addMenu = (m: MenuOpt) => setLines((ls) => [...ls, { key: k(), kind: 'SERVICE', menuId: m.id, productId: null, name: m.name, unitPrice: m.price, quantity: 1, discount: 0, staffId: defaultStaff, nominated: ls.some((l) => l.nominated && l.kind === 'SERVICE') }]);
  const addProduct = (p: ProductOpt) => setLines((ls) => {
    const ex = ls.find((l) => l.productId === p.id);
    if (ex) return ls.map((l) => (l === ex ? { ...l, quantity: Math.min(999, l.quantity + 1) } : l));
    return [...ls, { key: k(), kind: 'RETAIL', menuId: null, productId: p.id, name: p.name, unitPrice: p.price, quantity: 1, discount: 0, staffId: defaultStaff, nominated: false }];
  });
  const addCustom = (name: string, price: number) => setLines((ls) => [...ls, { key: k(), kind: 'OTHER', menuId: null, productId: null, name, unitPrice: price, quantity: 1, discount: 0, staffId: defaultStaff, nominated: false }]);

  // ── tenders ──
  const addTender = (method: PaymentMethodName) => setTenders((ts) => {
    const paidOther = ts.reduce((a, t) => a + t.amount, 0);
    const remaining = Math.max(0, totals.total - paidOther);
    const ex = method !== 'CUSTOM' ? ts.find((t) => t.method === method) : undefined;
    if (ex) return ts.map((t) => (t === ex ? { ...t, amount: t.amount + remaining } : t));
    return [...ts, { key: k(), method, amount: remaining, label: '', reference: '' }];
  });
  const setCash = (fn: (current: number) => number) => setTenders((ts) => {
    const ex = ts.find((t) => t.method === 'CASH');
    if (ex) return ts.map((t) => (t === ex ? { ...t, amount: Math.max(0, fn(t.amount)) } : t));
    return [...ts, { key: k(), method: 'CASH', amount: Math.max(0, fn(0)), label: '', reference: '' }];
  });
  const patchTender = (key: string, p: Partial<Tender>) => setTenders((ts) => ts.map((t) => (t.key === key ? { ...t, ...p } : t)));

  const hasCash = tenders.some((t) => t.method === 'CASH' && t.amount > 0);
  const needsLabel = tenders.some((t) => t.method === 'CUSTOM' && t.amount > 0 && !t.label.trim());
  const liveProviderMissingRef = tenders.some((t) => (t.method === 'STRIPE' || t.method === 'SQUARE') && t.amount > 0 && providers[t.method === 'STRIPE' ? 'stripe' : 'square'] === 'live' && !t.reference.trim());
  const canConfirm = lines.length > 0 && settlement.ok && !pointsOver && !(hasCash && !registerOpen) && !needsLabel && !liveProviderMissingRef && busy === null;
  const blockReason = !lines.length ? '明細を追加してください'
    : pointsOver ? 'ポイント残高を超えています'
    : hasCash && !registerOpen ? 'レジが開いていないため現金会計はできません'
    : needsLabel ? '「その他」の支払い名称を入力してください'
    : liveProviderMissingRef ? 'オンライン決済の決済IDを入力するか、決済リンク／端末決済を使用してください'
    : !settlement.ok ? settlement.error : null;

  return (
    <div className="pos-grid">
      <div className="stack">
        <Picker menus={menus} products={products} onMenu={addMenu} onProduct={addProduct} onCustom={addCustom} />

        <section className="card flush">
          <div className="card-head" style={{ padding: '14px 18px 0' }}><h2>明細 <span className="sub">{lines.length}件</span></h2></div>
          {lines.length === 0 ? (
            <div className="empty"><h3>明細がありません</h3><div className="sub">上のメニュー・商品から追加してください</div></div>
          ) : (
            <div className="pos-lines">
              {lines.map((l) => {
                const gross = l.unitPrice * l.quantity;
                const product = l.productId ? products.find((p) => p.id === l.productId) : null;
                return (
                  <div className="pos-line" key={l.key}>
                    <div className="pos-line-main">
                      <span className={`badge ${l.kind === 'RETAIL' ? 'violet' : l.kind === 'SERVICE' ? 'blue' : ''}`}>{LINE_KIND_LABEL[l.kind]}</span>
                      <input className="input sm" value={l.name} maxLength={100} onChange={(e) => patch(l.key, { name: e.target.value })} aria-label="品目名" />
                      <button type="button" className="icon-btn" onClick={() => remove(l.key)} aria-label="削除"><Trash2 size={15} /></button>
                    </div>
                    <div className="pos-line-fields">
                      <label className="mini">単価<input className="input sm num" inputMode="numeric" value={l.unitPrice} onChange={(e) => patch(l.key, { unitPrice: num(e.target.value) })} /></label>
                      <label className="mini">数量
                        <span className="qty">
                          <button type="button" className="icon-btn" onClick={() => patch(l.key, { quantity: Math.max(1, l.quantity - 1) })} aria-label="減らす"><Minus size={14} /></button>
                          <input className="input sm num" inputMode="numeric" value={l.quantity} onChange={(e) => patch(l.key, { quantity: Math.min(999, Math.max(1, num(e.target.value))) })} />
                          <button type="button" className="icon-btn" onClick={() => patch(l.key, { quantity: Math.min(999, l.quantity + 1) })} aria-label="増やす"><Plus size={14} /></button>
                        </span>
                      </label>
                      <label className="mini">値引き<input className="input sm num" inputMode="numeric" value={l.discount} onChange={(e) => patch(l.key, { discount: Math.min(gross, num(e.target.value)) })} /></label>
                      <label className="mini">担当
                        <select className="select sm" value={l.staffId ?? ''} onChange={(e) => patch(l.key, { staffId: e.target.value || null })}>
                          <option value="">未設定</option>
                          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </label>
                      {l.kind !== 'RETAIL' ? (
                        <label className="checkbox mini-check"><input type="checkbox" checked={l.nominated} onChange={(e) => patch(l.key, { nominated: e.target.checked })} />指名</label>
                      ) : <span className="sub mini-check">{product ? `在庫 ${product.stock}` : ''}</span>}
                      <div className="pos-line-amount num">{yen(Math.max(0, gross - l.discount))}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <aside className="pos-side stack">
        <section className="card">
          <div className="between">
            <div className="row" style={{ minWidth: 0 }}>
              <UserRound size={18} className="muted" />
              {customer ? (
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 800 }}>{customer.name} 様</div>
                  <div className="sub">{customer.kana && `${customer.kana} ・ `}来店{customer.visitCount}回 ・ 保有 {customer.points.toLocaleString()}pt</div>
                </div>
              ) : <div><div style={{ fontWeight: 700 }}>{initial.guestName ? `${initial.guestName} 様（未登録）` : 'ゲスト'}</div><div className="sub">顧客未選択のためポイントは付与されません</div></div>}
            </div>
            <div className="row" style={{ gap: 6 }}>
              {canSearchCustomers && <button type="button" className="btn sm secondary" onClick={() => setCustOpen(true)}>{customer ? '変更' : '顧客を選択'}</button>}
              {customer && <button type="button" className="icon-btn" aria-label="顧客を外す" onClick={() => { setCustomer(null); setPointsToUse(0); }}><X size={15} /></button>}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="form-grid">
            <div className="field full">
              <label htmlFor="coupon">クーポン</label>
              <select id="coupon" className="select" value={couponId} onChange={(e) => setCouponId(e.target.value)}>
                <option value="">なし</option>
                {coupons.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.discountType === 'PERCENT' ? `${c.discountValue}%OFF` : `${yen(c.discountValue)}引`}{c.newCustomerOnly ? '・新規限定' : ''}）</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="manual">割引（円）</label>
              <input id="manual" className="input num" inputMode="numeric" value={manualDiscount} onChange={(e) => setManualDiscount(num(e.target.value))} />
            </div>
            <div className="field">
              <label htmlFor="points">ポイント利用</label>
              <div className="row" style={{ gap: 6 }}>
                <input id="points" className="input num" inputMode="numeric" disabled={!customer || balance <= 0} value={customer ? pointsToUse : 0} onChange={(e) => setPointsToUse(num(e.target.value))} />
                <button type="button" className="btn sm secondary" disabled={!customer || maxPoints <= 0} onClick={() => setPointsToUse(Math.max(0, maxPoints))}>全て</button>
              </div>
              {pointsOver && <div className="error">残高 {balance.toLocaleString()}pt を超えています</div>}
            </div>
          </div>
        </section>

        <section className="card pos-totals">
          <dl>
            <dt>小計</dt><dd>{yen(totals.subtotal)}</dd>
            {totals.lineDiscounts > 0 && <><dt>明細値引き</dt><dd>−{yen(totals.lineDiscounts)}</dd></>}
            {totals.couponDiscount > 0 && <><dt>クーポン</dt><dd>−{yen(totals.couponDiscount)}</dd></>}
            {totals.manualDiscount > 0 && <><dt>割引</dt><dd>−{yen(totals.manualDiscount)}</dd></>}
            {totals.pointsUsed > 0 && <><dt>ポイント利用</dt><dd>−{yen(totals.pointsUsed)}</dd></>}
          </dl>
          <div className="pos-total-big"><span>合計（税込）</span><strong className="num">{yen(totals.total)}</strong></div>
          <div className="sub between"><span>うち消費税（{shop.taxRatePct}%）</span><span className="num">{yen(totals.taxTotal)}</span></div>
          <div className="sub between"><span>施術 / 店販</span><span className="num">{yen(totals.serviceTotal)} / {yen(totals.retailTotal)}</span></div>
          {customer && <div className="sub between"><span>付与予定ポイント</span><span className="num">{totals.pointsEarned.toLocaleString()}pt</span></div>}
        </section>

        <section className="card">
          <div className="card-head"><h2>お支払い</h2>{tenders.length > 0 && <button type="button" className="btn sm ghost" onClick={() => setTenders([])}>クリア</button>}</div>
          <div className="method-grid">
            {PAYMENT_METHODS.map((m) => <button key={m} type="button" className="btn secondary sm" onClick={() => addTender(m)} disabled={totals.total <= 0}>{METHOD_SHORT[m]}</button>)}
          </div>
          {!registerOpen && <div className="alert warn" style={{ marginTop: 10 }}>レジが開いていません。現金を扱う場合は <a className="link" href="/pos/register">レジ開け</a> を行ってください。</div>}

          {tenders.length > 0 && (
            <div className="stack-sm" style={{ marginTop: 12 }}>
              {tenders.map((t) => {
                const prov = t.method === 'STRIPE' ? providers.stripe : t.method === 'SQUARE' ? providers.square : null;
                return (
                  <div key={t.key} className="tender-row">
                    <div className="between">
                      <strong>{METHOD_LABEL[t.method]}</strong>
                      <div className="row" style={{ gap: 6 }}>
                        <input className="input sm num" style={{ width: 120 }} inputMode="numeric" aria-label={`${METHOD_LABEL[t.method]}の金額`} value={t.amount} onChange={(e) => patchTender(t.key, { amount: num(e.target.value) })} />
                        <button type="button" className="icon-btn" aria-label="支払いを削除" onClick={() => setTenders((ts) => ts.filter((x) => x.key !== t.key))}><X size={14} /></button>
                      </div>
                    </div>
                    {t.method === 'CUSTOM' && <input className="input sm" placeholder="支払い方法の名称（例：商品券）" value={t.label} maxLength={60} onChange={(e) => patchTender(t.key, { label: e.target.value })} />}
                    {(t.method === 'CARD' || t.method === 'EMONEY' || t.method === 'QR') && (
                      <input className="input sm" placeholder="承認番号・伝票番号（任意）" value={t.reference} maxLength={120} onChange={(e) => patchTender(t.key, { reference: e.target.value })} />
                    )}
                    {prov && (
                      prov === 'live' ? (
                        <div className="stack-sm">
                          <input className="input sm" placeholder={t.method === 'STRIPE' ? '決済ID（pi_…）' : 'Square 支払いID'} value={t.reference} onChange={(e) => patchTender(t.key, { reference: e.target.value })} />
                          <button type="button" className="btn sm secondary" disabled={busy !== null || !lines.length} onClick={() => startProvider(t.method as 'STRIPE' | 'SQUARE')}>
                            {t.method === 'STRIPE' ? '決済リンクを発行' : '端末に金額を送信'}
                          </button>
                        </div>
                      ) : <div className="sub">サンドボックス：模擬決済として記録されます</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="cash-quick">
            <span className="sub">現金</span>
            <button type="button" className="btn sm secondary" disabled={cashDue <= 0} onClick={() => setCash(() => cashDue)}>ちょうど</button>
            <button type="button" className="btn sm secondary" disabled={cashDue <= 0} onClick={() => setCash(() => Math.ceil(cashDue / 1000) * 1000)}>千円単位</button>
            {[1000, 5000, 10000].map((v) => <button key={v} type="button" className="btn sm secondary" onClick={() => setCash((c) => c + v)}>+{yen(v)}</button>)}
          </div>

          <div className="pos-settle">
            <div className="between"><span>お預り合計</span><strong className="num">{yen(settlement.paid)}</strong></div>
            {settlement.remaining > 0 && <div className="between red"><span>不足</span><strong className="num">{yen(settlement.remaining)}</strong></div>}
            {settlement.ok && <div className="between change"><span>お釣り</span><strong className="num">{yen(settlement.change)}</strong></div>}
            {cashIn > 0 && <div className="sub">現金 {yen(cashIn)} お預り</div>}
          </div>

          {providerLink && (
            <div className="alert info" style={{ marginTop: 10 }}>
              {providerLink.url ? (
                <div className="stack-sm">
                  <div>決済リンクをお客様に共有してください。お支払い完了後、自動で会計が確定します。</div>
                  <div className="row-wrap"><a className="link mono" href={providerLink.url} target="_blank" rel="noreferrer">{providerLink.url.slice(0, 48)}…</a><CopyButton text={providerLink.url} /></div>
                </div>
              ) : <div>{providerLink.provider === 'SQUARE' ? '端末に金額を送信しました。' : '決済を開始しました。'}{providerLink.sandbox ? '（サンドボックス）' : ''} 完了後に自動で会計が確定します。</div>}
              <button type="button" className="btn sm secondary" style={{ marginTop: 8 }} onClick={() => router.refresh()}>状態を確認</button>
            </div>
          )}
        </section>

        <section className="card">
          <div className="field">
            <label htmlFor="note">メモ</label>
            <textarea id="note" className="textarea" style={{ minHeight: 56 }} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="会計メモ（レシートには印字されません）" />
          </div>
        </section>

        {error && <div className="alert error" role="alert">{error}</div>}
        {message && !error && <div className="alert success" role="status">{message}</div>}
        {blockReason && lines.length > 0 && !error && <div className="sub">{blockReason}</div>}

        <div className="pos-actions">
          <button type="button" className="btn ghost" onClick={discard} disabled={busy !== null}>{txId ? '破棄' : 'キャンセル'}</button>
          <button type="button" className="btn secondary" onClick={save} disabled={busy !== null || !lines.length}>{busy === 'save' ? <span className="spinner" /> : null}下書き保存</button>
          <button type="button" className="btn lg success" onClick={confirm} disabled={!canConfirm}>{busy === 'checkout' ? <><span className="spinner" /> 処理中…</> : `会計確定 ${yen(totals.total)}`}</button>
        </div>
      </aside>

      <CustomerPicker open={custOpen} onClose={() => setCustOpen(false)} onPick={(c) => { setCustomer(c); setPointsToUse(0); setCustOpen(false); }} />
    </div>
  );
}

function Picker({ menus, products, onMenu, onProduct, onCustom }: { menus: MenuOpt[]; products: ProductOpt[]; onMenu: (m: MenuOpt) => void; onProduct: (p: ProductOpt) => void; onCustom: (name: string, price: number) => void }) {
  const [tab, setTab] = useState<'menu' | 'product' | 'custom'>('menu');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [cName, setCName] = useState('');
  const [cPrice, setCPrice] = useState('');
  const cats = useMemo(() => tab === 'menu' ? [...new Set(menus.map((m) => m.category))] : [...new Set(products.map((p) => p.brand ?? 'その他'))], [tab, menus, products]);
  const s = q.trim().toLowerCase();
  const shownMenus = menus.filter((m) => (!cat || m.category === cat) && (!s || m.name.toLowerCase().includes(s)));
  const shownProducts = products.filter((p) => (!cat || (p.brand ?? 'その他') === cat) && (!s || p.name.toLowerCase().includes(s) || (p.sku ?? '').toLowerCase().includes(s) || (p.brand ?? '').toLowerCase().includes(s)));
  return (
    <section className="card">
      <div className="between" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <div className="seg" role="tablist">
          {(['menu', 'product', 'custom'] as const).map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); setCat(null); }}>{t === 'menu' ? '施術メニュー' : t === 'product' ? '店販商品' : 'その他'}</button>)}
        </div>
        {tab !== 'custom' && (
          <div className="row" style={{ gap: 6, flex: '1 1 200px', maxWidth: 280 }}>
            <Search size={16} className="muted" />
            <input className="input sm" placeholder={tab === 'menu' ? 'メニュー名で検索' : '商品名・SKU・ブランド'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="検索" />
          </div>
        )}
      </div>
      {tab !== 'custom' && cats.length > 1 && (
        <div className="chips">
          <button type="button" className={`chip ${cat === null ? 'on' : ''}`} onClick={() => setCat(null)}>すべて</button>
          {cats.map((c) => <button type="button" key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>)}
        </div>
      )}
      {tab === 'menu' && (shownMenus.length === 0 ? <div className="sub" style={{ padding: 12 }}>該当するメニューがありません</div> : (
        <div className="pos-pick-grid">
          {shownMenus.map((m) => <button type="button" key={m.id} className="pos-pick" onClick={() => onMenu(m)}><span>{m.name}</span><small className="num">{yen(m.price)} ・ {m.durationMin}分</small></button>)}
        </div>
      ))}
      {tab === 'product' && (shownProducts.length === 0 ? <div className="sub" style={{ padding: 12 }}>該当する商品がありません</div> : (
        <div className="pos-pick-grid">
          {shownProducts.map((p) => <button type="button" key={p.id} className="pos-pick" onClick={() => onProduct(p)}><span>{p.name}</span><small className="num">{yen(p.price)} ・ 在庫 {p.stock}{p.stock <= 0 ? '（在庫切れ）' : ''}</small></button>)}
        </div>
      ))}
      {tab === 'custom' && (
        <form className="row-wrap" onSubmit={(e) => { e.preventDefault(); const price = num(cPrice); if (!cName.trim()) return; onCustom(cName.trim(), price); setCName(''); setCPrice(''); }}>
          <input className="input" style={{ flex: '2 1 180px' }} placeholder="品目名（例：指名料、キャンセル料）" value={cName} onChange={(e) => setCName(e.target.value)} maxLength={100} />
          <input className="input num" style={{ flex: '1 1 100px' }} placeholder="金額" inputMode="numeric" value={cPrice} onChange={(e) => setCPrice(e.target.value)} />
          <button className="btn" disabled={!cName.trim()}><Plus size={16} />追加</button>
          <div className="row-wrap" style={{ width: '100%' }}>
            {['指名料', 'キャンセル料', 'ロング料金', '延長料金'].map((n) => <button type="button" key={n} className="chip" onClick={() => setCName(n)}>{n}</button>)}
          </div>
        </form>
      )}
    </section>
  );
}

function CustomerPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (c: CustomerLite) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Awaited<ReturnType<typeof searchCustomersAction>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqId = useRef(0);
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) { setRows(null); return; }
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      setLoading(true); setErr(null);
      try {
        const r = await searchCustomersAction(term);
        if (id === reqId.current) setRows(r);
      } catch { if (id === reqId.current) setErr('検索に失敗しました'); } finally { if (id === reqId.current) setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]);
  return (
    <Modal open={open} onClose={onClose} title="お客様を選択">
      <input className="input" autoFocus placeholder="氏名・カナ・電話番号で検索" value={q} onChange={(e) => setQ(e.target.value)} aria-label="顧客検索" />
      <div className="list" style={{ marginTop: 8, minHeight: 80 }}>
        {loading && <div className="sub" style={{ padding: 10 }}><span className="spinner" /> 検索中…</div>}
        {err && <div className="alert error">{err}</div>}
        {!loading && rows && rows.length === 0 && <div className="sub" style={{ padding: 10 }}>該当するお客様が見つかりません</div>}
        {!loading && !rows && <div className="sub" style={{ padding: 10 }}>2文字以上入力すると候補が表示されます</div>}
        {rows?.map((c) => (
          <button type="button" key={c.id} className="choice" onClick={() => onPick({ id: c.id, name: c.name, kana: c.kana, visitCount: c.visitCount, points: c.points })}>
            <span><strong>{c.name}</strong><br /><span className="sub">{c.kana} ・ 来店{c.visitCount}回</span></span>
            <span className="badge blue">{c.points.toLocaleString()}pt</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
