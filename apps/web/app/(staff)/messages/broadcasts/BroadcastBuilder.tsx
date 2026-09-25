'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users } from 'lucide-react';
import type { Segment } from '@salonos/core';
import { ActionForm, SubmitButton } from '@/components/client';
import { Field } from '@/components/ui';
import { countRecipientsAction, saveBroadcastAction } from '../actions';
import { BodyEditor, type TemplateLite } from '../ui';
import { SAMPLE_VARS, TEMPLATE_CATEGORIES } from '../labels';

export interface BuilderInitial { id: string; name: string; body: string; channel: 'LINE' | 'EMAIL'; segment: Segment; scheduledAtLocal: string | null }

type Count = Awaited<ReturnType<typeof countRecipientsAction>>;

export function BroadcastBuilder({ initial, tags, staff, shops, templates, shopName, minLocal }: {
  initial?: BuilderInitial; tags: { id: string; name: string; color: string }[]; staff: { userId: string; displayName: string }[];
  shops: { id: string; name: string }[]; templates: TemplateLite[]; shopName: string; minLocal: string;
}) {
  const router = useRouter();
  const s0 = initial?.segment ?? {};
  const [channel, setChannel] = useState<'LINE' | 'EMAIL'>(initial?.channel ?? 'LINE');
  const [tagIds, setTagIds] = useState<string[]>(s0.tagIds ?? []);
  const [min, setMin] = useState(s0.lastVisitDaysMin?.toString() ?? '');
  const [max, setMax] = useState(s0.lastVisitDaysMax?.toString() ?? '');
  const [minVisits, setMinVisits] = useState(s0.minVisits?.toString() ?? '');
  const [staffId, setStaffId] = useState(s0.staffId ?? '');
  const [favorite, setFavorite] = useState(!!s0.favorite);
  const [shopId, setShopId] = useState(s0.shopId ?? '');
  const [mode, setMode] = useState<'now' | 'schedule'>(initial?.scheduledAtLocal ? 'schedule' : 'now');
  const [seed, setSeed] = useState({ key: 0, body: initial?.body ?? '' });
  const [count, setCount] = useState<Count | null>(null);
  const [counting, setCounting] = useState(false);

  const segment = useMemo(() => ({ tagIds, lastVisitDaysMin: min, lastVisitDaysMax: max, minVisits, staffId, favorite, shopId }), [tagIds, min, max, minVisits, staffId, favorite, shopId]);
  useEffect(() => {
    let cancelled = false;
    setCounting(true);
    const t = setTimeout(async () => {
      const r = await countRecipientsAction(segment, channel).catch(() => ({ ok: false as const, error: '対象者数を計算できませんでした' }));
      if (!cancelled) { setCount(r); setCounting(false); }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [segment, channel]);

  const recipients = count && count.ok ? count.recipients : null;
  const previewVars = useMemo(() => ({ ...SAMPLE_VARS, shop_name: shops.find((s) => s.id === shopId)?.name ?? shopName }), [shops, shopId, shopName]);

  return (
    <ActionForm<{ id: string }> action={saveBroadcastAction} onSuccess={(r) => { if (r.ok && r.data?.id && r.data.id !== initial?.id) router.replace(`/messages/broadcasts/${r.data.id}`); }}>
      {initial && <input type="hidden" name="id" value={initial.id} />}
      <div className="split">
        <div className="stack">
          <section className="card">
            <div className="card-head"><h2>配信内容</h2></div>
            <div className="form-grid">
              <Field label="配信名（管理用）" required><input name="name" className="input" defaultValue={initial?.name} maxLength={80} required placeholder="例）秋のヘッドスパキャンペーン" /></Field>
              <Field label="チャネル" required>
                <div className="seg" role="radiogroup">
                  {(['LINE', 'EMAIL'] as const).map((c) => (
                    <button key={c} type="button" role="radio" aria-checked={channel === c} className={channel === c ? 'active' : ''} onClick={() => setChannel(c)}>{c === 'LINE' ? 'LINE' : 'メール'}</button>
                  ))}
                </div>
                <input type="hidden" name="channel" value={channel} />
              </Field>
              <div className="field full">
                <div className="between"><label className="req">本文</label>
                  {templates.length > 0 && (
                    <select className="select sm" style={{ width: 'auto' }} value="" aria-label="テンプレートから挿入" onChange={(e) => {
                      const t = templates.find((x) => x.id === e.target.value);
                      if (t) setSeed((s) => ({ key: s.key + 1, body: t.body }));
                    }}>
                      <option value="">テンプレートから作成…</option>
                      {templates.map((t) => <option key={t.id} value={t.id}>[{TEMPLATE_CATEGORIES[t.category] ?? t.category}] {t.name}</option>)}
                    </select>
                  )}
                </div>
                <BodyEditor key={seed.key} defaultValue={seed.body} previewVars={previewVars} rows={8} />
                <div className="hint">変数はお客様ごとに差し込まれます。予約関連の変数は次回予約がある場合のみ表示されます。</div>
              </div>
            </div>
          </section>
        </div>
        <div className="stack">
          <section className="card">
            <div className="card-head"><h2>配信対象（セグメント）</h2></div>
            <div className="stack">
              <Field label="店舗">
                <select name="segShopId" className="select" value={shopId} onChange={(e) => setShopId(e.target.value)}>
                  <option value="">すべての店舗</option>
                  {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              {tags.length > 0 && (
                <div className="field">
                  <label>タグ（いずれかを含む）</label>
                  <div className="row-wrap">
                    {tags.map((t) => (
                      <label key={t.id} className={`tag-toggle ${tagIds.includes(t.id) ? 'on' : ''}`} style={{ ['--tag' as any]: t.color }}>
                        <input type="checkbox" name="tagIds" value={t.id} checked={tagIds.includes(t.id)} onChange={(e) => setTagIds((xs) => e.target.checked ? [...xs, t.id] : xs.filter((x) => x !== t.id))} />
                        {t.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div className="field">
                <label>最終来店からの日数</label>
                <div className="row">
                  <input name="lastVisitDaysMin" type="number" min={0} max={3650} className="input" placeholder="最小" value={min} onChange={(e) => setMin(e.target.value)} aria-label="最小日数" />
                  <span className="sub">〜</span>
                  <input name="lastVisitDaysMax" type="number" min={0} max={3650} className="input" placeholder="最大" value={max} onChange={(e) => setMax(e.target.value)} aria-label="最大日数" />
                  <span className="sub nowrap">日</span>
                </div>
                <div className="hint">指定すると来店履歴のないお客様は対象外になります</div>
              </div>
              <div className="form-grid">
                <Field label="来店回数（以上）"><input name="minVisits" type="number" min={0} max={999} className="input" value={minVisits} onChange={(e) => setMinVisits(e.target.value)} /></Field>
                <Field label="担当スタッフ">
                  <select name="staffId" className="select" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                    <option value="">指定なし</option>
                    {staff.map((s) => <option key={s.userId} value={s.userId}>{s.displayName}</option>)}
                  </select>
                </Field>
              </div>
              <label className="checkbox"><input type="checkbox" name="favorite" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} />お気に入り顧客のみ</label>
              <div className="recipient-box" aria-live="polite">
                <Users size={18} />
                <div className="grow">
                  <div className="recipient-count">{counting && recipients === null ? <span className="spinner" /> : recipients ?? '—'}<small> 人に配信</small>{counting && recipients !== null && <span className="spinner" style={{ width: 12, height: 12, marginLeft: 6 }} />}</div>
                  {count && count.ok && <div className="sub">条件一致 {count.matched}人（配信停止 {count.optedOut}人・{channel === 'LINE' ? 'LINE未連携' : 'メール未登録'} {count.noContact}人を除外）</div>}
                  {count && !count.ok && <div className="form-error">{count.error}</div>}
                </div>
              </div>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>配信タイミング</h2></div>
            <div className="stack">
              <div className="seg">
                <button type="button" className={mode === 'now' ? 'active' : ''} onClick={() => setMode('now')}>今すぐ</button>
                <button type="button" className={mode === 'schedule' ? 'active' : ''} onClick={() => setMode('schedule')}>日時を指定</button>
              </div>
              {mode === 'schedule' && (
                <Field label="配信日時（店舗の時刻）" required hint="定期実行ジョブ（/api/cron）の実行時に配信されます">
                  <input name="scheduledAt" type="datetime-local" className="input" min={minLocal} defaultValue={initial?.scheduledAtLocal ?? ''} />
                </Field>
              )}
              <div className="form-actions" style={{ marginTop: 0 }}>
                <SubmitButton className="btn secondary" name="intent" value="draft" pendingText="保存中…">下書き保存</SubmitButton>
                {mode === 'schedule'
                  ? <SubmitButton name="intent" value="schedule" pendingText="保存中…">配信を予約</SubmitButton>
                  : <ConfirmSend recipients={recipients} />}
              </div>
            </div>
          </section>
        </div>
      </div>
    </ActionForm>
  );
}

function ConfirmSend({ recipients }: { recipients: number | null }) {
  return (
    <span onClickCapture={(e) => {
      const n = recipients ?? 0;
      if (!window.confirm(`${n}人に今すぐ配信します。よろしいですか？（取り消しできません）`)) { e.preventDefault(); e.stopPropagation(); }
    }}>
      <SubmitButton name="intent" value="send" pendingText="配信中…" disabled={recipients === 0}>今すぐ配信</SubmitButton>
    </span>
  );
}
