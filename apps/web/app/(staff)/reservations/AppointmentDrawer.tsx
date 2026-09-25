'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Search, X, ExternalLink, ClipboardList, CreditCard, UserRound } from 'lucide-react';
import { minutesToHHMM } from '@salonos/core';
import { CopyButton, Drawer } from '@/components/client';
import {
  changeStatusAction, getAppointmentAction, saveAppointmentAction, searchCustomersAction,
  type AppointmentDetail, type CustomerHit, type SaveAppointmentInput,
} from './actions';
import { KIND_LABEL, SOURCE_LABEL, STATUS_ACTION, STATUS_LABEL, STATUS_TONE } from './labels';
import type { CouponOption, DrawerMode, MenuOption, Perms, ShopInfo, StaffOption } from './types';

interface Props {
  mode: DrawerMode; shop: ShopInfo; today: string; menus: MenuOption[]; coupons: CouponOption[]; staffOptions: StaffOption[]; perms: Perms;
  onClose: () => void; onDone: (message: string, warnings: string[]) => void; onChanged: () => void;
}

type Kind = 'NORMAL' | 'CONSULTATION' | 'PRIVATE';
type CustomerMode = 'existing' | 'new' | 'guest';
type StaffMode = 'staff' | 'auto' | 'none';

const CANCEL_REASONS = ['お客様のご都合', '体調不良', '日程変更のため', 'サロン都合', '連絡なし', 'その他'];

function uuid() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); });
}

const hhmm = (m: number) => minutesToHHMM(Math.max(0, Math.min(1439, m)));
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const yen = (n: number) => `¥${Math.round(n).toLocaleString('ja-JP')}`;

function discountFor(c: CouponOption | undefined, menus: MenuOption[]) {
  if (!c) return 0;
  const eligible = menus.filter((m) => c.menuIds.length === 0 || c.menuIds.includes(m.id));
  const base = eligible.reduce((s, m) => s + m.price, 0);
  if (base <= 0) return 0;
  return Math.min(base, c.discountType === 'PERCENT' ? Math.floor((base * Math.min(100, c.discountValue)) / 100) : c.discountValue);
}

export function AppointmentDrawer({ mode, shop, today, menus, coupons, staffOptions, perms, onClose, onDone, onChanged }: Props) {
  const isEdit = mode.kind === 'edit';
  const preset = mode.kind === 'create' ? mode.preset : null;
  const [idem] = useState(uuid);
  const [detail, setDetail] = useState<AppointmentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(isEdit);

  // form state
  const [kind, setKind] = useState<Kind>('NORMAL');
  const [customerMode, setCustomerMode] = useState<CustomerMode>(preset?.customer ? 'existing' : preset?.newName ? 'new' : perms.customerRead ? 'existing' : 'guest');
  const [customer, setCustomer] = useState<CustomerHit | null>(preset?.customer ?? null);
  const [newName, setNewName] = useState(preset?.newName ?? '');
  const [newKana, setNewKana] = useState('');
  const [newPhone, setNewPhone] = useState(preset?.newPhone ?? '');
  const [guestName, setGuestName] = useState(preset?.guestName ?? '');
  const [guestPhone, setGuestPhone] = useState('');
  const [menuIds, setMenuIds] = useState<string[]>([]);
  const [couponId, setCouponId] = useState('');
  const [staffMode, setStaffMode] = useState<StaffMode>(preset?.staffMode ?? 'auto');
  const [staffId, setStaffId] = useState(preset?.staffId ?? '');
  const [nominated, setNominated] = useState(false);
  const [date, setDate] = useState(preset?.date ?? today);
  const [start, setStart] = useState(hhmm(preset?.startMin ?? 600));
  const [durationOverride, setDurationOverride] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState(preset?.note ?? '');
  const [source, setSource] = useState('STAFF');
  const [requestStatus, setRequestStatus] = useState<'CONFIRMED' | 'REQUESTED'>('CONFIRMED');
  const [notify, setNotify] = useState(false);
  const [notifyChange, setNotifyChange] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string> | null>(null);
  const [saving, startSaving] = useTransition();
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState(CANCEL_REASONS[0]);
  const [cancelNote, setCancelNote] = useState('');
  const [cancelNotify, setCancelNotify] = useState(true);

  // load for edit
  useEffect(() => {
    if (mode.kind !== 'edit') return;
    let alive = true;
    (async () => {
      try {
        const r = await getAppointmentAction(mode.id);
        if (!alive) return;
        if (!r.ok || !r.data) { setLoadError(r.ok ? '予約が見つかりません' : r.error); return; }
        const d = r.data;
        setDetail(d);
        setKind(d.kind);
        if (d.customer) { setCustomerMode('existing'); setCustomer({ id: d.customer.id, name: d.customer.name, kana: d.customer.kana, phone: d.customer.phone, visitCount: d.customer.visitCount, lastVisitAt: d.customer.lastVisitAt }); }
        else { setCustomerMode('guest'); setGuestName(d.guestName ?? ''); }
        setMenuIds(d.menus.map((m) => m.menuId).filter((x): x is string => !!x && menus.some((mm) => mm.id === x)));
        setCouponId(d.couponId ?? '');
        setStaffMode(d.staffId ? 'staff' : 'none');
        setStaffId(d.staffId ?? '');
        setNominated(d.nominated);
        setDate(d.date);
        setStart(hhmm(d.startMin));
        const auto = d.menus.reduce((s, m) => s + (menus.find((x) => x.id === m.menuId)?.durationMin ?? m.durationMin), 0);
        setDurationOverride(d.durationMin !== Math.max(15, auto) || d.kind === 'PRIVATE' ? String(d.durationMin) : '');
        setTitle(d.title ?? '');
        setNote(d.note ?? '');
      } catch {
        if (alive) setLoadError('予約の読み込みに失敗しました');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [mode, menus]);

  // derived
  const selectedMenus = useMemo(() => menuIds.map((id) => menus.find((m) => m.id === id)).filter((m): m is MenuOption => !!m), [menuIds, menus]);
  const coupon = coupons.find((c) => c.id === couponId);
  // Lines the picker can't show (指名料, retired menus) — kept by the server on save.
  const extraLines = kind === 'PRIVATE' ? [] : detail?.menus.filter((m) => !m.menuId || !menus.some((x) => x.id === m.menuId)) ?? [];
  const autoDuration = kind === 'PRIVATE' ? 60 : Math.max(15, selectedMenus.reduce((s, m) => s + m.durationMin, 0) + extraLines.reduce((s, m) => s + m.durationMin, 0) || 30);
  const duration = durationOverride ? Number(durationOverride) : autoDuration;
  const gross = selectedMenus.reduce((s, m) => s + m.price, 0);
  const discount = discountFor(coupon, selectedMenus);
  const grouped = useMemo(() => {
    const g = new Map<string, MenuOption[]>();
    for (const m of menus) g.set(m.category, [...(g.get(m.category) ?? []), m]);
    return [...g.entries()];
  }, [menus]);
  const locked = !!detail && ['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(detail.status);
  const readOnly = !perms.write || locked;

  // customer search (debounced)
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<CustomerHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits(null); return; }
    const my = ++seq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await searchCustomersAction(term);
        if (my !== seq.current) return;
        if (r.ok) { setHits(r.data ?? []); setSearchError(null); } else setSearchError(r.error);
      } catch { if (my === seq.current) setSearchError('検索に失敗しました'); }
      finally { if (my === seq.current) setSearching(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const toggleMenu = (m: MenuOption) => {
    setMenuIds((ids) => {
      if (ids.includes(m.id)) return ids.filter((x) => x !== m.id);
      return [...ids, m.id];
    });
    if (m.isConsultation && !menuIds.includes(m.id) && kind === 'NORMAL') setKind('CONSULTATION');
  };

  const payload = (allowOverCapacity: boolean): SaveAppointmentInput => ({
    id: detail?.id ?? null,
    idempotencyKey: isEdit ? null : idem,
    date, startMin: toMin(start),
    durationMin: durationOverride ? Number(durationOverride) : kind === 'PRIVATE' ? 60 : null,
    staffMode, staffId: staffMode === 'staff' ? staffId : null, nominated: staffMode === 'staff' && nominated,
    kind, title: kind === 'PRIVATE' ? title : null,
    customerMode, customerId: customerMode === 'existing' ? customer?.id ?? null : null,
    newName, newKana, newPhone, guestName, guestPhone,
    menuIds: kind === 'PRIVATE' ? [] : menuIds, couponId: kind === 'PRIVATE' ? null : couponId || null,
    note, source: source as SaveAppointmentInput['source'], status: requestStatus,
    notify: isEdit ? notifyChange : notify, allowOverCapacity,
    waitlistId: preset?.waitlistId ?? null,
  });

  const save = (allowOverCapacity = false) => {
    setError(null); setFieldErrors(null);
    if (!/^\d{2}:\d{2}$/.test(start)) { setError('開始時刻を入力してください'); return; }
    startSaving(async () => {
      try {
        const r = await saveAppointmentAction(payload(allowOverCapacity));
        if (!r.ok) {
          if (r.code === 'SEAT_CAPACITY' && !allowOverCapacity && window.confirm('席数を超えますが登録しますか？')) { save(true); return; }
          setError(r.error); setFieldErrors(r.fieldErrors ?? null);
          return;
        }
        onDone(r.message ?? '保存しました', r.data?.warnings ?? []);
      } catch {
        setError('通信に失敗しました。もう一度お試しください。');
      }
    });
  };

  const setStatus = async (status: string, extra: { reason?: string; notify?: boolean } = {}) => {
    if (!detail) return;
    if (status === 'NO_SHOW' && !window.confirm('無断キャンセルとして記録しますか？')) return;
    setStatusBusy(status); setError(null);
    try {
      const r = await changeStatusAction({ id: detail.id, status: status as any, reason: extra.reason, notify: extra.notify ?? true });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onDone(status === 'CANCELLED' ? '予約をキャンセルしました' : `ステータスを「${STATUS_LABEL[status]}」に変更しました`, []);
    } catch {
      setError('通信に失敗しました。もう一度お試しください。');
    } finally {
      setStatusBusy(null);
    }
  };

  const titleText = isEdit ? (detail ? `${detail.date.replace(/-/g, '/')} ${hhmm(detail.startMin)} の予約` : '予約の詳細') : '新規予約';
  const endMin = toMin(start || '00:00') + (Number.isFinite(duration) ? duration : 0);

  const footer = loading || loadError ? (
    <button type="button" className="btn secondary" onClick={onClose}>閉じる</button>
  ) : (
    <>
      <div className="grow rsv-total">
        {kind !== 'PRIVATE' && <>合計 <b>{yen(Math.max(0, gross + extraLines.reduce((s, m) => s + m.price, 0) - discount))}</b>{discount > 0 && <span className="sub">（割引 −{yen(discount)}）</span>}</>}
      </div>
      <button type="button" className="btn secondary" onClick={onClose}>閉じる</button>
      {!readOnly && (
        <button type="button" className="btn" onClick={() => save(false)} disabled={saving} aria-busy={saving}>
          {saving ? <><span className="spinner" /> 保存中…</> : isEdit ? '変更を保存' : '予約を登録'}
        </button>
      )}
    </>
  );

  return (
    <Drawer open onClose={onClose} title={titleText} footer={footer}>
      {loading && (
        <div className="stack" aria-busy="true" aria-label="読み込み中">
          <div className="skeleton" style={{ height: 28, width: '60%' }} />
          <div className="skeleton" style={{ height: 90 }} />
          <div className="skeleton" style={{ height: 160 }} />
        </div>
      )}
      {loadError && <div className="alert error">{loadError}</div>}
      {!loading && !loadError && (
        <div className="stack rsv-drawer">
          {error && (
            <div className="alert error" role="alert">
              {error}
              {fieldErrors && Object.keys(fieldErrors).length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{Object.entries(fieldErrors).map(([k, v]) => <li key={k}>{v}</li>)}</ul>}
            </div>
          )}

          {/* status + meta (edit) */}
          {detail && (
            <section className="rsv-section">
              <div className="between">
                <div className="row-wrap">
                  <span className={`badge ${STATUS_TONE[detail.status]}`}>{STATUS_LABEL[detail.status]}</span>
                  <span className="badge">{SOURCE_LABEL[detail.source] ?? detail.source}{detail.externalProvider ? `（${detail.externalProvider}）` : ''}</span>
                  {detail.kind !== 'NORMAL' && <span className="badge violet">{KIND_LABEL[detail.kind]}</span>}
                  {detail.nominated && <span className="badge blue">指名</span>}
                  {detail.transaction && <span className={`badge ${detail.transaction.status === 'PAID' ? 'green' : ''}`}>{detail.transaction.status === 'PAID' ? '会計済み' : detail.transaction.status === 'DRAFT' ? '会計中' : '会計あり'}</span>}
                </div>
              </div>
              {perms.write && detail.transitions.filter((s) => s !== 'CANCELLED').length > 0 && (
                <div className="row-wrap" style={{ marginTop: 10 }}>
                  {detail.transitions.filter((s) => s !== 'CANCELLED').map((s) => (
                    <button key={s} type="button" className={`btn sm ${s === 'NO_SHOW' ? 'danger-outline' : s === 'CONFIRMED' && detail.status === 'REQUESTED' ? '' : 'secondary'}`} disabled={!!statusBusy} onClick={() => setStatus(s)}>
                      {statusBusy === s ? <span className="spinner" /> : (detail.status === 'CANCELLED' || detail.status === 'NO_SHOW') && s === 'CONFIRMED' ? '予約を復元（確定）' : detail.status === 'REQUESTED' && s === 'CONFIRMED' ? 'リクエストを承認' : STATUS_ACTION[s]}
                    </button>
                  ))}
                </div>
              )}
              {detail.status === 'CANCELLED' && (
                <p className="sub" style={{ marginTop: 8 }}>キャンセル日時：{detail.cancelledAt ? new Date(detail.cancelledAt).toLocaleString('ja-JP', { timeZone: shop.timezone }) : '—'}　理由：{detail.cancelReason ?? '—'}</p>
              )}
              {detail.customerNote && <div className="alert info" style={{ marginTop: 10 }}><b>お客様からのご要望：</b>{detail.customerNote}</div>}
              <div className="row-wrap rsv-links" style={{ marginTop: 10 }}>
                {detail.customer && <Link className="btn secondary sm" href={`/customers/${detail.customer.id}`}><UserRound size={14} />顧客詳細</Link>}
                {detail.customer && detail.kind !== 'PRIVATE' && <Link className="btn secondary sm" href={`/karte/new?appointmentId=${detail.id}`}><ClipboardList size={14} />{detail.karteId ? 'カルテを開く' : 'カルテ作成'}</Link>}
                {detail.kind !== 'PRIVATE' && detail.status !== 'CANCELLED' && detail.status !== 'NO_SHOW' && <Link className="btn secondary sm" href={`/pos/checkout?appointmentId=${detail.id}`}><CreditCard size={14} />{detail.transaction?.status === 'PAID' ? '会計を確認' : '会計へ'}</Link>}
                {detail.kind !== 'PRIVATE' && <CopyButton text={detail.manageUrl} label="変更・キャンセルURLをコピー" />}
              </div>
              {locked && <p className="sub" style={{ marginTop: 8 }}>この予約は{STATUS_LABEL[detail.status]}のため編集できません。{detail.status !== 'COMPLETED' && '「予約を復元」で元に戻せます。'}</p>}
            </section>
          )}

          <fieldset disabled={readOnly} className="rsv-fieldset stack">
            {/* kind */}
            <div className="field">
              <span className="label">種別</span>
              <div className="seg" role="radiogroup" aria-label="種別">
                {(['NORMAL', 'CONSULTATION', 'PRIVATE'] as Kind[]).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'active' : ''} onClick={() => {
                    setKind(k);
                    if (k === 'PRIVATE' && staffMode !== 'staff') { setStaffMode('staff'); if (!staffId && staffOptions[0]) setStaffId(staffOptions[0].userId); }
                  }}>{KIND_LABEL[k]}</button>
                ))}
              </div>
              {kind === 'PRIVATE' && <span className="hint">休憩・研修・外出などスタッフの予定を登録します（席数にはカウントされません）。</span>}
            </div>

            {kind === 'PRIVATE' ? (
              <div className="field">
                <label htmlFor="rsv-title" className="req">タイトル</label>
                <input id="rsv-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：休憩、ミーティング" maxLength={80} />
              </div>
            ) : (
              <>
                {/* customer */}
                <div className="field">
                  <span className="label">お客様</span>
                  <div className="seg" role="radiogroup" aria-label="お客様の指定方法">
                    {perms.customerRead && <button type="button" className={customerMode === 'existing' ? 'active' : ''} onClick={() => setCustomerMode('existing')}>既存のお客様</button>}
                    {perms.customerWrite && <button type="button" className={customerMode === 'new' ? 'active' : ''} onClick={() => setCustomerMode('new')}>新規登録</button>}
                    <button type="button" className={customerMode === 'guest' ? 'active' : ''} onClick={() => setCustomerMode('guest')}>ゲスト（登録しない）</button>
                  </div>
                </div>
                {customerMode === 'existing' && (
                  customer ? (
                    <div className="rsv-customer">
                      <span className="avatar">{customer.name.slice(0, 1)}</span>
                      <div className="grow">
                        <div><b>{customer.name}</b> <span className="sub">{customer.kana}</span></div>
                        <div className="sub">{customer.phone || '電話未登録'}・来店 {customer.visitCount}回{customer.lastVisitAt ? `・前回 ${new Date(customer.lastVisitAt).toLocaleDateString('ja-JP', { timeZone: shop.timezone })}` : ''}
                          {detail?.customer && (detail.customer.noShowCount > 0 || detail.customer.cancelCount > 0) && <span className="badge red" style={{ marginLeft: 6 }}>無断{detail.customer.noShowCount}・キャンセル{detail.customer.cancelCount}</span>}
                        </div>
                      </div>
                      {!readOnly && <button type="button" className="icon-btn" aria-label="お客様を変更" onClick={() => { setCustomer(null); setQ(''); }}><X size={14} /></button>}
                    </div>
                  ) : (
                    <div className="field">
                      <div className="rsv-search">
                        <Search size={15} />
                        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="氏名・フリガナ・電話番号で検索" aria-label="お客様を検索" autoFocus={!isEdit} />
                        {searching && <span className="spinner" />}
                      </div>
                      {searchError && <div className="form-error">{searchError}</div>}
                      {hits && hits.length === 0 && !searching && <div className="sub">該当するお客様がいません。{perms.customerWrite && <button type="button" className="link rsv-linkbtn" onClick={() => { setCustomerMode('new'); setNewName(q); }}>「{q}」を新規登録</button>}</div>}
                      {hits && hits.length > 0 && (
                        <div className="rsv-hits" role="listbox">
                          {hits.map((h) => (
                            <button type="button" key={h.id} className="rsv-hit" role="option" aria-selected={false} onClick={() => { setCustomer(h); setHits(null); }}>
                              <b>{h.name}</b> <span className="sub">{h.kana}</span>
                              <span className="sub" style={{ marginLeft: 'auto' }}>{h.phone}・{h.visitCount}回</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                )}
                {customerMode === 'new' && (
                  <div className="form-grid">
                    <div className="field"><label className="req" htmlFor="rsv-nn">お名前</label><input id="rsv-nn" className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="山田 花子" maxLength={60} /></div>
                    <div className="field"><label htmlFor="rsv-nk">フリガナ</label><input id="rsv-nk" className="input" value={newKana} onChange={(e) => setNewKana(e.target.value)} placeholder="ヤマダ ハナコ" maxLength={60} /></div>
                    <div className="field full"><label htmlFor="rsv-np">電話番号</label><input id="rsv-np" className="input" type="tel" inputMode="tel" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="090-1234-5678" maxLength={30} /><span className="hint">同じ電話番号のお客様が既に登録されている場合はその方に紐づけます。</span></div>
                  </div>
                )}
                {customerMode === 'guest' && (
                  isEdit && detail && !detail.customer ? (
                    <p className="sub">ゲスト：{detail.guestName ?? '—'}{detail.guestPhone ? `（${detail.guestPhone}）` : ''}</p>
                  ) : (
                    <div className="form-grid">
                      <div className="field"><label htmlFor="rsv-gn">お名前（任意）</label><input id="rsv-gn" className="input" value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="ゲスト" maxLength={60} /></div>
                      <div className="field"><label htmlFor="rsv-gp">電話番号（任意）</label><input id="rsv-gp" className="input" type="tel" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} maxLength={30} /></div>
                    </div>
                  )
                )}

                {/* menus */}
                <div className="field">
                  <span className="label">メニュー</span>
                  {menus.length === 0 ? <div className="sub">有効なメニューがありません（設定 &gt; メニューで登録してください）</div> : (
                    <div className="rsv-menu-list">
                      {grouped.map(([cat, list]) => (
                        <div key={cat} className="rsv-menu-group">
                          <div className="rsv-menu-cat">{cat}</div>
                          {list.map((m) => (
                            <label key={m.id} className={`rsv-menu ${menuIds.includes(m.id) ? 'on' : ''}`}>
                              <input type="checkbox" checked={menuIds.includes(m.id)} onChange={() => toggleMenu(m)} />
                              <span className="grow">{m.name}{m.isConsultation && <span className="badge violet" style={{ marginLeft: 6 }}>相談</span>}</span>
                              <span className="sub num">{m.durationMin}分</span>
                              <span className="num">{yen(m.price)}</span>
                            </label>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  {extraLines.length > 0 && <span className="hint">そのほか：{extraLines.map((m) => `${m.name} ${yen(m.price)}`).join('、')}（変更後も保持されます）</span>}
                </div>

                {coupons.length > 0 && (
                  <div className="field">
                    <label htmlFor="rsv-coupon">クーポン</label>
                    <select id="rsv-coupon" className="select" value={couponId} onChange={(e) => setCouponId(e.target.value)}>
                      <option value="">使用しない</option>
                      {coupons.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.label}）</option>)}
                      {detail?.couponId && !coupons.some((c) => c.id === detail.couponId) && <option value={detail.couponId}>（期限切れのクーポン）</option>}
                    </select>
                    {coupon && discount === 0 && <span className="hint">対象メニューが選択されていません</span>}
                  </div>
                )}
              </>
            )}

            {/* staff */}
            <div className="form-grid">
              <div className="field">
                <label htmlFor="rsv-staff">担当スタッフ</label>
                <select
                  id="rsv-staff" className="select"
                  value={staffMode === 'staff' ? staffId : `__${staffMode}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '__auto') setStaffMode('auto');
                    else if (v === '__none') setStaffMode('none');
                    else { setStaffMode('staff'); setStaffId(v); }
                  }}
                >
                  {kind !== 'PRIVATE' && !isEdit && <option value="__auto">指名なし（空いているスタッフを自動割当）</option>}
                  {kind !== 'PRIVATE' && <option value="__none">未割当</option>}
                  {staffOptions.map((s) => <option key={s.userId} value={s.userId}>{s.name}{s.bookable ? '' : '（台帳非表示）'}</option>)}
                </select>
              </div>
              {staffMode === 'staff' && kind !== 'PRIVATE' && (
                <div className="field" style={{ justifyContent: 'flex-end' }}>
                  <label className="checkbox"><input type="checkbox" checked={nominated} onChange={(e) => setNominated(e.target.checked)} />指名予約</label>
                </div>
              )}
            </div>

            {/* time */}
            <div className="form-grid rsv-timegrid">
              <div className="field"><label htmlFor="rsv-date" className="req">日付</label><input id="rsv-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
              <div className="field"><label htmlFor="rsv-start" className="req">開始</label><input id="rsv-start" type="time" step={300} className="input" value={start} onChange={(e) => setStart(e.target.value)} /></div>
              <div className="field">
                <label htmlFor="rsv-dur">所要時間（分）</label>
                <input id="rsv-dur" type="number" min={5} max={720} step={5} className="input" value={durationOverride} onChange={(e) => setDurationOverride(e.target.value)} placeholder={`自動：${autoDuration}`} />
              </div>
              <div className="field"><span className="label">終了</span><div className="rsv-end num">{Number.isFinite(endMin) ? hhmm(endMin) : '—'}{durationOverride && <button type="button" className="link rsv-linkbtn" onClick={() => setDurationOverride('')} style={{ marginLeft: 8 }}>自動に戻す</button>}</div></div>
            </div>

            {!isEdit && kind !== 'PRIVATE' && (
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="rsv-src">予約経路</label>
                  <select id="rsv-src" className="select" value={source} onChange={(e) => setSource(e.target.value)}>
                    {['STAFF', 'PHONE', 'LINE', 'WEB', 'INSTAGRAM', 'GOOGLE', 'OTHER'].map((s) => <option key={s} value={s}>{s === 'STAFF' ? '店頭・スタッフ' : SOURCE_LABEL[s]}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="rsv-st">ステータス</label>
                  <select id="rsv-st" className="select" value={requestStatus} onChange={(e) => setRequestStatus(e.target.value as 'CONFIRMED' | 'REQUESTED')}>
                    <option value="CONFIRMED">確定</option>
                    <option value="REQUESTED">仮予約（リクエスト）</option>
                  </select>
                </div>
              </div>
            )}

            <div className="field">
              <label htmlFor="rsv-note">スタッフメモ</label>
              <textarea id="rsv-note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} placeholder="施術の注意点、ご要望など（お客様には表示されません）" />
            </div>

            {kind !== 'PRIVATE' && !isEdit && (customerMode !== 'guest') && (
              <label className="checkbox"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />お客様に予約内容を通知する（LINE / メール）</label>
            )}
            {kind !== 'PRIVATE' && isEdit && detail?.customer && (
              <label className="checkbox"><input type="checkbox" checked={notifyChange} onChange={(e) => setNotifyChange(e.target.checked)} />日時を変更した場合はお客様に通知する</label>
            )}
          </fieldset>

          {/* cancel */}
          {detail && perms.write && detail.transitions.includes('CANCELLED') && (
            <section className="rsv-section rsv-cancel">
              {!cancelOpen ? (
                <button type="button" className="btn danger-outline sm" onClick={() => setCancelOpen(true)}>この予約をキャンセル</button>
              ) : (
                <div className="stack-sm">
                  <b>予約のキャンセル</b>
                  <div className="form-grid">
                    <div className="field">
                      <label htmlFor="rsv-cr">理由</label>
                      <select id="rsv-cr" className="select" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}>{CANCEL_REASONS.map((r) => <option key={r}>{r}</option>)}</select>
                    </div>
                    <div className="field"><label htmlFor="rsv-cn">補足</label><input id="rsv-cn" className="input" value={cancelNote} onChange={(e) => setCancelNote(e.target.value)} maxLength={200} /></div>
                  </div>
                  {detail.customer && <label className="checkbox"><input type="checkbox" checked={cancelNotify} onChange={(e) => setCancelNotify(e.target.checked)} />お客様にキャンセルを通知する</label>}
                  <div className="row">
                    <button type="button" className="btn danger sm" disabled={!!statusBusy} onClick={() => setStatus('CANCELLED', { reason: cancelNote ? `${cancelReason}：${cancelNote}` : cancelReason, notify: cancelNotify })}>
                      {statusBusy === 'CANCELLED' ? <span className="spinner" /> : 'キャンセルを確定'}
                    </button>
                    <button type="button" className="btn ghost sm" onClick={() => setCancelOpen(false)}>やめる</button>
                  </div>
                </div>
              )}
            </section>
          )}

          {detail && (
            <p className="sub">
              登録：{new Date(detail.createdAt).toLocaleString('ja-JP', { timeZone: shop.timezone })}{detail.createdByName ? `（${detail.createdByName}）` : ''}
              {detail.kind !== 'PRIVATE' && <> ・ <a className="link" href={detail.manageUrl} target="_blank" rel="noreferrer">お客様用ページ <ExternalLink size={11} /></a></>}
            </p>
          )}
        </div>
      )}
    </Drawer>
  );
}
