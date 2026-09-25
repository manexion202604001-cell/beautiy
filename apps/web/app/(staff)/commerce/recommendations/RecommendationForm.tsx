'use client';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ActionForm, CopyButton, SubmitButton } from '@/components/client';
import { yen } from '@/lib/format';
import { commerceCustomerSearch, createRecommendationAction } from '../actions';

type Customer = { id: string; name: string; kana: string; visitCount: number };

export function RecommendationForm({ products, staff, defaultStaffId, canSend, canSearch }: {
  products: { id: string; name: string; brand: string | null; price: number }[]; staff: { id: string; name: string }[];
  defaultStaffId: string | null; canSend: boolean; canSearch: boolean;
}) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Customer[]>([]);
  const [result, setResult] = useState<{ url: string; sent: string | null } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (!term || customer) { setRows([]); return; }
    const id = ++seq.current;
    const t = setTimeout(async () => { const r = await commerceCustomerSearch(term).catch(() => []); if (id === seq.current) setRows(r); }, 250);
    return () => clearTimeout(t);
  }, [q, customer]);
  return (
    <ActionForm action={createRecommendationAction} onSuccess={(r) => { setResult(r.ok ? r.data ?? null : null); setSelected([]); }} showSuccess={false}>
      <div className="stack">
        {result && (
          <div className="alert success">
            <div style={{ fontWeight: 700 }}>おすすめリンクを作成しました{result.sent ? `（${result.sent}）` : ''}</div>
            <div className="row-wrap" style={{ marginTop: 6 }}><a className="link mono" href={result.url} target="_blank" rel="noreferrer">{result.url}</a><CopyButton text={result.url} /></div>
          </div>
        )}
        <div className="form-grid">
          <div className="field">
            <label>お客様（任意）</label>
            <input type="hidden" name="customerId" value={customer?.id ?? ''} />
            {customer ? (
              <div className="between input" style={{ padding: '6px 10px' }}><span>{customer.name} 様</span><button type="button" className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => { setCustomer(null); setQ(''); }} aria-label="解除"><X size={14} /></button></div>
            ) : canSearch ? (
              <div style={{ position: 'relative' }}>
                <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="氏名・カナ・電話番号で検索" aria-label="顧客検索" />
                {rows.length > 0 && (
                  <div className="card pad-sm" style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, top: '100%', marginTop: 4, maxHeight: 240, overflowY: 'auto' }}>
                    {rows.map((c) => <button type="button" key={c.id} className="choice" style={{ margin: '4px 0' }} onClick={() => { setCustomer(c); setRows([]); }}><span>{c.name}<br /><span className="sub">{c.kana} ・ 来店{c.visitCount}回</span></span></button>)}
                  </div>
                )}
              </div>
            ) : <div className="sub">顧客閲覧の権限がありません</div>}
          </div>
          <div className="field">
            <label htmlFor="staffId" className="req">おすすめするスタッフ</label>
            <select id="staffId" name="staffId" className="select" defaultValue={defaultStaffId ?? ''} required>
              <option value="">選択してください</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="field full">
            <label className="req">商品（{selected.length}点選択）</label>
            {products.length === 0 ? <div className="sub">オンライン販売中の商品がありません</div> : (
              <div className="pick-list">
                {products.map((p) => (
                  <label key={p.id} className="checkbox" style={{ display: 'flex', padding: '6px 0' }}>
                    <input type="checkbox" name="productIds" value={p.id} checked={selected.includes(p.id)} onChange={(e) => setSelected((s) => e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id))} />
                    <span style={{ flex: 1 }}>{p.name} <span className="sub">{p.brand ?? ''}</span></span>
                    <span className="num sub">{yen(p.price)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="field full">
            <label htmlFor="message">メッセージ</label>
            <textarea id="message" name="message" className="textarea" maxLength={1000} placeholder="例：本日のカラーの色持ちをよくするシャンプーです。毎日のケアにお使いください。" />
          </div>
          {canSend && <label className="checkbox full"><input type="checkbox" name="send" disabled={!customer} />お客様にLINE／メールで送信する{!customer && <span className="sub">（お客様を選択すると送信できます）</span>}</label>}
        </div>
        <div className="form-actions"><SubmitButton disabled={!selected.length}>リンクを作成</SubmitButton></div>
      </div>
    </ActionForm>
  );
}
