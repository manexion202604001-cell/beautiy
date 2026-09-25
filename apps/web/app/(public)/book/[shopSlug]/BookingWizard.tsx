'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { Check, ChevronLeft, Clock, Ticket, UserRound, Sparkles, MessageCircle } from 'lucide-react';
import { holdSlotAction, releaseHoldAction, submitBookingAction } from './actions';
import { SlotPicker, type Day, type SlotItem } from './SlotPicker';

interface MenuItem { id: string; category: string; name: string; description: string | null; durationMin: number; price: number; isConsultation: boolean }
interface CouponItem { id: string; name: string; description: string | null; discountType: string; discountValue: number; menuIds: string[]; newCustomerOnly: boolean; validTo: string | null; label: string }
interface StaffItem { userId: string; name: string; imageUrl: string | null; bio: string | null; specialties: string | null; nominationFee: number }

interface Props {
  shop: { name: string; slug: string; phone: string | null; bookingMode: 'INSTANT' | 'REQUEST'; cancelDeadlineHours: number; address: string | null };
  menus: MenuItem[]; coupons: CouponItem[]; staff: StaffItem[]; days: Day[];
  formToken: string; lk: string | null; lineLinked: boolean; src: string | null; preStaffId: string | null;
}

const STEPS = ['メニュー', 'スタッフ', '日時', 'お客様情報', '確認'];
const yen = (n: number) => `¥${Math.round(n).toLocaleString('ja-JP')}`;
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const kanaRe = /^[\p{Script=Katakana}\p{Script=Hiragana}ー\s・ｰ　]+$/u;

function uuid() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
function digits(s: string) {
  let d = s.normalize('NFKC').replace(/[^\d+]/g, '');
  if (d.startsWith('+81')) d = '0' + d.slice(3);
  return d.replace(/\D/g, '');
}
function fmtDate(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return `${y}年${m}月${d}日(${WD[new Date(date + 'T00:00:00Z').getUTCDay()]})`;
}

export function BookingWizard({ shop, menus, coupons, staff, days, formToken, lk, lineLinked, src, preStaffId }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [menuIds, setMenuIds] = useState<string[]>([]);
  const [couponId, setCouponId] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<string | null | undefined>(preStaffId ?? undefined);
  const [slot, setSlot] = useState<(SlotItem & { date: string }) | null>(null);
  const [hold, setHold] = useState<{ token: string; expiresAt: string } | null>(null);
  const [holding, setHolding] = useState<string | null>(null);
  const [slotError, setSlotError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState({ name: '', kana: '', phone: '', email: '', note: '', consent: false, website: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();
  const [idem] = useState(uuid);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [step]);
  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hold]);

  const selMenus = useMemo(() => menuIds.map((id) => menus.find((m) => m.id === id)).filter((m): m is MenuItem => !!m), [menuIds, menus]);
  const coupon = coupons.find((c) => c.id === couponId) ?? null;
  const stylist = staffId ? staff.find((s) => s.userId === staffId) ?? null : null;
  const consultation = selMenus.some((m) => m.isConsultation);
  const duration = Math.max(15, selMenus.reduce((s, m) => s + m.durationMin, 0));
  const gross = selMenus.reduce((s, m) => s + m.price, 0) + (stylist?.nominationFee ?? 0);
  const discount = useMemo(() => {
    if (!coupon) return 0;
    const base = selMenus.filter((m) => coupon.menuIds.length === 0 || coupon.menuIds.includes(m.id)).reduce((s, m) => s + m.price, 0);
    if (base <= 0) return 0;
    return Math.min(base, coupon.discountType === 'PERCENT' ? Math.floor((base * Math.min(100, coupon.discountValue)) / 100) : coupon.discountValue);
  }, [coupon, selMenus]);
  const couponUnusable = !!coupon && discount === 0 && coupon.discountValue > 0;
  const total = Math.max(0, gross - discount);

  const grouped = useMemo(() => {
    const g = new Map<string, MenuItem[]>();
    for (const m of menus.filter((x) => !x.isConsultation)) g.set(m.category, [...(g.get(m.category) ?? []), m]);
    return [...g.entries()];
  }, [menus]);
  const consultMenus = menus.filter((m) => m.isConsultation);

  const dropHold = useCallback(() => {
    if (hold) void releaseHoldAction(hold.token).catch(() => undefined);
    setHold(null); setSlot(null);
  }, [hold]);

  const toggleMenu = (m: MenuItem) => {
    dropHold();
    setMenuIds((ids) => {
      if (ids.includes(m.id)) return ids.filter((x) => x !== m.id);
      // consultation bookings are made on their own
      if (m.isConsultation) return [m.id];
      return [...ids.filter((id) => !menus.find((x) => x.id === id)?.isConsultation), m.id];
    });
    if (m.isConsultation) setCouponId(null);
  };

  const toggleCoupon = (c: CouponItem) => {
    dropHold();
    if (couponId === c.id) { setCouponId(null); return; }
    setCouponId(c.id);
    if (c.menuIds.length) {
      const eligible = menus.filter((m) => c.menuIds.includes(m.id) && !m.isConsultation);
      const has = menuIds.some((id) => c.menuIds.includes(id));
      if (!has && eligible[0]) setMenuIds((ids) => [...ids.filter((id) => !menus.find((x) => x.id === id)?.isConsultation), eligible[0].id]);
    } else {
      setMenuIds((ids) => ids.filter((id) => !menus.find((x) => x.id === id)?.isConsultation));
    }
  };

  const buildUrl = useCallback((date: string) => {
    const p = new URLSearchParams({ shop: shop.slug, date, menus: menuIds.join(',') });
    if (staffId) p.set('staff', staffId);
    if (hold) p.set('hold', hold.token);
    return `/api/availability?${p.toString()}`;
  }, [shop.slug, menuIds, staffId, hold]);

  const pickSlot = async (s: SlotItem, date: string) => {
    setSlotError(null); setHolding(s.start);
    try {
      const r = await holdSlotAction({ shopSlug: shop.slug, menuIds, staffId: staffId ?? null, startAt: s.start, previousToken: hold?.token ?? null });
      if (!r.ok || !r.data) {
        setSlotError(r.ok ? '時間を確保できませんでした' : r.error);
        setReloadKey((k) => k + 1);
        return;
      }
      setHold(r.data); setSlot({ ...s, date }); setNow(Date.now());
      setStep(4);
    } catch {
      setSlotError('通信に失敗しました。もう一度お試しください。');
    } finally {
      setHolding(null);
    }
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'お名前を入力してください';
    if (!form.kana.trim()) e.kana = 'フリガナを入力してください';
    else if (!kanaRe.test(form.kana.trim())) e.kana = 'フリガナはカタカナまたはひらがなで入力してください';
    const d = digits(form.phone);
    if (!form.phone.trim()) e.phone = '電話番号を入力してください';
    else if (d.length < 10 || d.length > 11) e.phone = '電話番号の形式が正しくありません（例：090-1234-5678）';
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) e.email = 'メールアドレスの形式が正しくありません';
    if (!form.consent) e.consent = 'プライバシーポリシーへの同意が必要です';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = () => {
    if (!slot) { setStep(3); return; }
    setSubmitError(null);
    startSubmit(async () => {
      try {
        const r = await submitBookingAction({
          shopSlug: shop.slug, menuIds, couponId, staffId: staffId ?? null, startAt: slot.start, holdToken: hold?.token ?? null,
          name: form.name, kana: form.kana, phone: form.phone, email: form.email, note: form.note, consent: form.consent as true,
          idempotencyKey: idem, formToken, website: form.website, lk, src,
        });
        if (r.ok && r.data) {
          router.push(`/book/${shop.slug}/complete?t=${encodeURIComponent(r.data.manageToken)}`);
          return;
        }
        if (!r.ok) {
          if (r.code) {
            // slot lost (or hours changed) → back to time selection
            setHold(null); setSlot(null); setSlotError(r.error); setReloadKey((k) => k + 1); setStep(3);
            return;
          }
          if (r.fieldErrors && Object.keys(r.fieldErrors).length) {
            setErrors(r.fieldErrors); setStep(4);
          }
          setSubmitError(r.error);
        }
      } catch {
        setSubmitError('通信に失敗しました。電波の良い場所で再度お試しください（二重に予約されることはありません）。');
      }
    });
  };

  const holdLeft = hold ? Math.max(0, Math.floor((new Date(hold.expiresAt).getTime() - now) / 1000)) : 0;
  const back = () => setStep((s) => (s === 3 && staff.length === 0 ? 1 : Math.max(1, s - 1)));

  const bar = (label: string, onNext: () => void, disabled = false) => (
    <div className="bk-bar">
      <div className="grow">
        {selMenus.length > 0 ? <>合計 <b>{yen(total)}</b>{discount > 0 && <> （−{yen(discount)}）</>}<br />所要 約{duration}分</> : 'メニューを選択してください'}
      </div>
      <button type="button" className="btn lg" onClick={onNext} disabled={disabled}>{label}</button>
    </div>
  );

  return (
    <div>
      <div className="steps" aria-label={`ステップ ${step} / ${STEPS.length}`}>{STEPS.map((s, i) => <span key={s} className={i < step ? 'on' : ''} title={s} />)}</div>
      <div className="between" style={{ marginBottom: 10 }}>
        <div>
          <div className="sub">STEP {step} / {STEPS.length}</div>
          <h2 style={{ fontSize: 19 }}>{['メニューを選ぶ', 'スタッフを選ぶ', '日時を選ぶ', 'お客様情報の入力', '予約内容の確認'][step - 1]}</h2>
        </div>
        {step > 1 && <button type="button" className="btn ghost sm" onClick={back}><ChevronLeft size={15} />戻る</button>}
      </div>
      {lineLinked && step === 1 && <div className="alert success" style={{ marginBottom: 12 }}><MessageCircle size={14} style={{ verticalAlign: -2 }} /> LINEと連携してご予約いただけます。予約確認はLINEでお届けします。</div>}

      {/* ── STEP 1: menus & coupons ── */}
      {step === 1 && (
        <>
          {coupons.length > 0 && (
            <>
              <div className="bk-section-title"><Ticket size={14} style={{ verticalAlign: -2 }} /> クーポン</div>
              {coupons.map((c) => (
                <button key={c.id} type="button" className={`choice bk-coupon ${couponId === c.id ? 'selected' : ''}`} onClick={() => toggleCoupon(c)} aria-pressed={couponId === c.id}>
                  <span className="bk-choice-main">
                    <span><span className="badge red">{c.label}</span>{c.newCustomerOnly && <span className="badge amber">初回限定</span>}</span>
                    <b style={{ display: 'block', marginTop: 4 }}>{c.name}</b>
                    {c.description && <span className="sub">{c.description}</span>}
                    {c.validTo && <span className="sub">有効期限：{new Date(c.validTo).toLocaleDateString('ja-JP')}</span>}
                  </span>
                  <span className="bk-check">{couponId === c.id && <Check size={14} />}</span>
                </button>
              ))}
            </>
          )}
          {grouped.map(([cat, list]) => (
            <div key={cat}>
              <div className="bk-section-title">{cat}</div>
              {list.map((m) => {
                const on = menuIds.includes(m.id);
                return (
                  <button key={m.id} type="button" className={`choice ${on ? 'selected' : ''}`} onClick={() => toggleMenu(m)} aria-pressed={on}>
                    <span className="bk-choice-main">
                      <b>{m.name}</b>
                      {m.description && <span className="sub">{m.description}</span>}
                      <span className="sub"><Clock size={11} style={{ verticalAlign: -1 }} /> 約{m.durationMin}分</span>
                    </span>
                    <span className="bk-price">{yen(m.price)}</span>
                    <span className="bk-check">{on && <Check size={14} />}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {consultMenus.length > 0 && (
            <div>
              <div className="bk-section-title"><Sparkles size={14} style={{ verticalAlign: -2 }} /> 相談予約</div>
              <p className="sub" style={{ margin: 0 }}>施術前のご相談・カウンセリングのみのご予約です（他のメニューとは同時に選べません）。</p>
              {consultMenus.map((m) => {
                const on = menuIds.includes(m.id);
                return (
                  <button key={m.id} type="button" className={`choice ${on ? 'selected' : ''}`} onClick={() => toggleMenu(m)} aria-pressed={on}>
                    <span className="bk-choice-main"><b>{m.name}</b>{m.description && <span className="sub">{m.description}</span>}<span className="sub">約{m.durationMin}分</span></span>
                    <span className="bk-price">{m.price ? yen(m.price) : '無料'}</span>
                    <span className="bk-check">{on && <Check size={14} />}</span>
                  </button>
                );
              })}
            </div>
          )}
          {couponUnusable && <div className="alert warn" style={{ marginTop: 10 }}>選択中のクーポンの対象メニューが選ばれていません。</div>}
          {bar('スタッフを選ぶ', () => setStep(staff.length ? 2 : 3), selMenus.length === 0 || couponUnusable)}
        </>
      )}

      {/* ── STEP 2: staff ── */}
      {step === 2 && (
        <>
          <button type="button" className={`choice ${staffId === null ? 'selected' : ''}`} onClick={() => { dropHold(); setStaffId(null); }} aria-pressed={staffId === null}>
            <span className="avatar"><UserRound size={16} /></span>
            <span className="bk-choice-main"><b>指名なし</b><span className="sub">空いているスタイリストが担当します（選べる時間が多くなります）</span></span>
            <span className="bk-check">{staffId === null && <Check size={14} />}</span>
          </button>
          {staff.map((s) => (
            <button key={s.userId} type="button" className={`choice ${staffId === s.userId ? 'selected' : ''}`} onClick={() => { dropHold(); setStaffId(s.userId); }} aria-pressed={staffId === s.userId}>
              <span className="avatar lg">{s.imageUrl ? <img src={s.imageUrl} alt="" /> : s.name.slice(0, 1)}</span>
              <span className="bk-choice-main">
                <b>{s.name}</b>
                {s.specialties && <span className="sub">得意：{s.specialties}</span>}
                {s.bio && <span className="bk-staff-bio">{s.bio}</span>}
              </span>
              <span className="bk-price">{s.nominationFee > 0 ? <>指名料<br />{yen(s.nominationFee)}</> : <span className="sub">指名料なし</span>}</span>
              <span className="bk-check">{staffId === s.userId && <Check size={14} />}</span>
            </button>
          ))}
          {bar('日時を選ぶ', () => setStep(3), staffId === undefined)}
        </>
      )}

      {/* ── STEP 3: date & time ── */}
      {step === 3 && (
        <div className="card">
          <p className="sub" style={{ marginTop: 0 }}>
            {selMenus.map((m) => m.name).join('・')}（約{duration}分）／ {stylist ? `${stylist.name}` : '指名なし'}
          </p>
          {slotError && <div className="alert error" role="alert" style={{ marginBottom: 12 }}>{slotError}</div>}
          <SlotPicker
            days={days} buildUrl={buildUrl} selected={slot?.start ?? null} onSelect={pickSlot} busyStart={holding}
            initialDate={slot?.date ?? null} reloadKey={reloadKey}
            emptyHint={stylist ? <> 「指名なし」にすると空きが見つかる場合があります。</> : null}
          />
          {shop.phone && <p className="sub" style={{ marginTop: 12, marginBottom: 0 }}>ご希望の時間がない場合はお電話（<a className="link" href={`tel:${shop.phone}`}>{shop.phone}</a>）でもお問い合わせいただけます。</p>}
        </div>
      )}

      {/* ── STEP 4: customer details ── */}
      {step === 4 && (
        <form className="card stack" noValidate onSubmit={(e) => { e.preventDefault(); if (validate()) setStep(5); }}>
          {hold && slot && <HoldNotice left={holdLeft} slot={slot} />}
          <div className="field">
            <label htmlFor="bk-name" className="req">お名前</label>
            <input id="bk-name" className="input" autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="山田 花子" maxLength={60} aria-invalid={!!errors.name} />
            {errors.name && <div className="error">{errors.name}</div>}
          </div>
          <div className="field">
            <label htmlFor="bk-kana" className="req">フリガナ</label>
            <input id="bk-kana" className="input" value={form.kana} onChange={(e) => setForm({ ...form, kana: e.target.value })} placeholder="ヤマダ ハナコ" maxLength={60} aria-invalid={!!errors.kana} />
            {errors.kana && <div className="error">{errors.kana}</div>}
          </div>
          <div className="field">
            <label htmlFor="bk-phone" className="req">電話番号</label>
            <input id="bk-phone" className="input" type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="090-1234-5678" maxLength={30} aria-invalid={!!errors.phone} />
            {errors.phone ? <div className="error">{errors.phone}</div> : <div className="hint">ご予約の確認でご連絡する場合があります</div>}
          </div>
          <div className="field">
            <label htmlFor="bk-email">メールアドレス（任意）</label>
            <input id="bk-email" className="input" type="email" inputMode="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="example@mail.com" maxLength={200} aria-invalid={!!errors.email} />
            {errors.email ? <div className="error">{errors.email}</div> : <div className="hint">{lineLinked ? '予約確認はLINEでお届けします' : '入力いただくと予約確認メールをお送りします'}</div>}
          </div>
          <div className="field">
            <label htmlFor="bk-note">ご要望・ご質問（任意）</label>
            <textarea id="bk-note" className="textarea" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} placeholder="髪の長さ、気になることなど" />
            {errors.note && <div className="error">{errors.note}</div>}
          </div>
          {/* honeypot: hidden from people, filled by naive bots */}
          <div className="bk-hp" aria-hidden="true">
            <label htmlFor="bk-website">Website</label>
            <input id="bk-website" tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
          </div>
          <div className="field">
            <label className="checkbox">
              <input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} />
              <span>ご入力いただいた個人情報を、ご予約の管理・ご連絡のために利用することに同意します（プライバシーポリシー）</span>
            </label>
            {errors.consent && <div className="error">{errors.consent}</div>}
          </div>
          <div className="bk-bar">
            <div className="grow">合計 <b>{yen(total)}</b><br />所要 約{duration}分</div>
            <button type="submit" className="btn lg">確認へ進む</button>
          </div>
        </form>
      )}

      {/* ── STEP 5: confirm ── */}
      {step === 5 && slot && (
        <div className="stack">
          {hold && <HoldNotice left={holdLeft} slot={slot} />}
          <div className="card">
            <dl className="bk-summary">
              <dt>日時</dt><dd><b>{fmtDate(slot.date)} {slot.time}〜</b><br /><span className="sub">所要 約{duration}分</span></dd>
              <dt>メニュー</dt><dd>{selMenus.map((m) => <div key={m.id}>{m.name}　<span className="sub">{yen(m.price)}</span></div>)}</dd>
              <dt>スタッフ</dt><dd>{stylist ? <>{stylist.name}{stylist.nominationFee > 0 && <span className="sub">（指名料 {yen(stylist.nominationFee)}）</span>}</> : '指名なし'}</dd>
              {coupon && <><dt>クーポン</dt><dd>{coupon.name}<br /><span className="sub">−{yen(discount)}</span></dd></>}
              <dt>お支払い目安</dt><dd><b style={{ fontSize: 17 }}>{yen(total)}</b><div className="sub">お支払いは当日店頭にて承ります</div></dd>
              <dt>お名前</dt><dd>{form.name}（{form.kana}）</dd>
              <dt>電話番号</dt><dd>{form.phone}</dd>
              {form.email && <><dt>メール</dt><dd>{form.email}</dd></>}
              {form.note && <><dt>ご要望</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{form.note}</dd></>}
              <dt>店舗</dt><dd>{shop.name}{shop.address && <div className="sub">{shop.address}</div>}</dd>
            </dl>
          </div>
          <div className="alert info">
            {shop.bookingMode === 'REQUEST'
              ? 'こちらはご予約リクエストです。サロンから確定のご連絡をもって予約完了となります。'
              : 'このまま確定するとご予約が完了します。'}
            {` 変更・キャンセルはご予約の${shop.cancelDeadlineHours}時間前まで、完了画面・確認メッセージのURLから行えます。`}
            {consultation && ' 相談予約の内容をもとに、当日メニューをご提案します。'}
          </div>
          {submitError && <div className="alert error" role="alert">{submitError}</div>}
          <div className="bk-bar">
            <button type="button" className="btn secondary lg" onClick={() => setStep(4)} disabled={submitting}>修正する</button>
            <button type="button" className="btn lg" style={{ flex: 1 }} onClick={submit} disabled={submitting} aria-busy={submitting}>
              {submitting ? <><span className="spinner" /> 送信中…</> : shop.bookingMode === 'REQUEST' ? 'リクエストを送信する' : '予約を確定する'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HoldNotice({ left, slot }: { left: number; slot: SlotItem & { date: string } }) {
  if (left <= 0) return <div className="alert warn">{fmtDate(slot.date)} {slot.time} の仮押さえ期限が切れました。このままお進みいただけますが、埋まっている場合は時間を選び直していただきます。</div>;
  return (
    <div className="bk-hold" role="status">
      <Clock size={14} />
      <span>{fmtDate(slot.date)} {slot.time}〜 を確保しています（残り {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}）</span>
    </div>
  );
}
