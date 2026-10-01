import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { manageUrlToPath, publicApi } from '../../api/public';
import type {
  AvailabilitySlot,
  CustomerAuthResult,
  PublicBookingResult,
  PublicShopInfo,
} from '../../api/types';
import { SlotPicker } from '../../components/appointments/Pickers';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  PageSpinner,
  Textarea,
} from '../../components/ui';
import { errorMessage, isApiError, newIdempotencyKey } from '../../lib/api';
import { cn } from '../../lib/cn';
import { WEEKDAYS_JA, formatDateJa, formatDuration, formatTime, formatYen } from '../../lib/format';
import { useStableKey } from '../../lib/hooks';
import { downloadIcs } from '../../lib/ics';
import { customerSession, type CustomerSession } from '../../lib/session';
import { addDays, todayIn, weekdayOf, zonedParts } from '../../lib/time';
import { CustomerLogin } from './CustomerLogin';
import { PublicShell, ShopHeader } from './PublicShell';
import { ShopReviewsSummary } from './reviews/ReviewList';

type Step = 'menu' | 'staff' | 'datetime' | 'info' | 'confirm' | 'done';
type Menu = PublicShopInfo['menus'][number];
type Coupon = PublicShopInfo['coupons'][number];

const STRIP_DAYS = 14;

function couponDiscount(c: Coupon, menus: Menu[]): number | null {
  const lines = c.applicableMenuIds.length
    ? menus.filter((m) => c.applicableMenuIds.includes(m.id))
    : menus;
  if (!lines.length) return null;
  const base = lines.reduce((s, m) => s + m.price, 0);
  if (base < c.minAmount) return null;
  if (c.discountType === 'amount') return Math.min(c.discountValue, base);
  if (c.discountType === 'percent') return Math.floor((base * c.discountValue) / 100);
  return Math.max(0, base - c.discountValue);
}

function captureTracking(search: string) {
  const p = new URLSearchParams(search);
  const utm: Record<string, string> = {};
  for (const [k, v] of p.entries()) if (k.startsWith('utm_') && v) utm[k] = v.slice(0, 200);
  const ref = p.get('ref') ?? p.get('referral') ?? undefined;
  return { utm: Object.keys(utm).length ? utm : undefined, referralCode: ref?.slice(0, 50) };
}

const inLine = () => typeof navigator !== 'undefined' && /Line\//i.test(navigator.userAgent);

export default function Book() {
  const { shopSlug = '' } = useParams();
  const location = useLocation();
  const tracking = useMemo(() => captureTracking(location.search), [location.search]);
  const info = useQuery({
    queryKey: ['public', 'shop', shopSlug],
    queryFn: () => publicApi.shop(shopSlug),
    retry: false,
  });

  if (info.isLoading) return <PageSpinner />;
  if (info.error) {
    return (
      <PublicShell>
        {isApiError(info.error) && info.error.status === 404 ? (
          <EmptyState
            className="mt-10"
            icon="store"
            title="予約ページが見つかりません"
            description="URLをご確認いただくか、店舗へ直接お問い合わせください。"
          />
        ) : (
          <ErrorState className="mt-10" error={info.error} onRetry={() => void info.refetch()} />
        )}
      </PublicShell>
    );
  }
  return <BookingFlow slug={shopSlug} info={info.data!} tracking={tracking} />;
}

function BookingFlow({
  slug,
  info,
  tracking,
}: {
  slug: string;
  info: PublicShopInfo;
  tracking: { utm?: Record<string, string>; referralCode?: string };
}) {
  const tz = info.shop.timezone;
  const today = todayIn(tz);
  const allowStaff = info.booking.allowStaffSelection && info.staff.length > 0;
  const steps: { key: Step; label: string }[] = [
    { key: 'menu', label: 'メニュー' },
    ...(allowStaff ? [{ key: 'staff' as Step, label: 'スタッフ' }] : []),
    { key: 'datetime', label: '日時' },
    { key: 'info', label: 'お客様情報' },
    { key: 'confirm', label: '確認' },
  ];
  const [step, setStep] = useState<Step>('menu');
  const [menuIds, setMenuIds] = useState<string[]>([]);
  const [category, setCategory] = useState<string>('all');
  const [staffId, setStaffId] = useState<string | null>(() => {
    const q = new URLSearchParams(window.location.search).get('staff');
    return q && info.staff.some((x) => x.id === q) ? q : null;
  });
  const [date, setDate] = useState(today);
  const [windowStart, setWindowStart] = useState(today);
  const [slot, setSlot] = useState<AvailabilitySlot | null>(null);
  const [slotError, setSlotError] = useState<string | null>(null);
  const [session, setSession] = useState<CustomerSession | null>(() => customerSession.get(slug));
  const [form, setForm] = useState({
    lastName: '',
    firstName: '',
    lastNameKana: '',
    firstNameKana: '',
    phone: '',
    email: '',
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [couponId, setCouponId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<PublicBookingResult | null>(null);
  const [clientRequestId, regenRequestId] = useStableKey(newIdempotencyKey);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => customerSession.rememberSlug(slug), [slug]);

  // move focus to the step heading for screen readers / keyboard users (not on first render)
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    headingRef.current?.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step]);

  const profile = useQuery({
    queryKey: ['public', 'me', session?.token],
    queryFn: () => publicApi.me(session!.token),
    enabled: !!session,
    retry: false,
  });
  useEffect(() => {
    if (profile.error && isApiError(profile.error) && profile.error.status === 401) {
      customerSession.clear(slug);
      setSession(null);
    }
  }, [profile.error, slug]);
  const profileComplete = !!(profile.data?.last_name && profile.data?.phone);
  // LINE-first customers: prefill what LINE already gave us (display name) so they only add the rest
  useEffect(() => {
    const p = profile.data;
    if (!p || profileComplete) return;
    setForm((f) =>
      f.lastName || f.firstName || f.phone
        ? f
        : {
            ...f,
            lastName: p.last_name ?? '',
            firstName: p.first_name ?? '',
            lastNameKana: p.last_name_kana ?? '',
            firstNameKana: p.first_name_kana ?? '',
            phone: p.phone ?? '',
            email: p.email ?? '',
          },
    );
  }, [profile.data, profileComplete]);

  const selectedMenus = menuIds
    .map((id) => info.menus.find((m) => m.id === id))
    .filter((m): m is Menu => !!m);
  const totalPrice = selectedMenus.reduce((s, m) => s + m.price, 0);
  const totalDuration = selectedMenus.reduce((s, m) => s + m.durationMin, 0);
  const staff = info.staff.find((s) => s.id === staffId) ?? null;
  const nominationFee = staff?.nomination_fee ?? 0;
  const eligibleStaff = info.staff.filter((s) =>
    selectedMenus.every((m) => !m.staffIds.length || m.staffIds.includes(s.id)),
  );
  const isRepeat = (profile.data?.visit_count ?? 0) > 0;
  const coupons = info.coupons
    .filter((c) => !(c.newCustomerOnly && isRepeat))
    .map((c) => ({ c, discount: couponDiscount(c, selectedMenus) }))
    .filter((x) => x.discount !== null);
  const coupon = coupons.find((x) => x.c.id === couponId);
  const estimate = Math.max(0, totalPrice - (coupon?.discount ?? 0)) + nominationFee;

  const horizonEnd = addDays(today, info.booking.horizonDays);
  const windowEnd = addDays(windowStart, STRIP_DAYS - 1);
  const availability = useQuery({
    queryKey: ['public', 'availability', slug, menuIds, staffId, windowStart],
    queryFn: () =>
      publicApi.availability(slug, {
        menuIds,
        staffId: staffId ?? undefined,
        from: windowStart,
        to: windowEnd < horizonEnd ? windowEnd : horizonEnd,
      }),
    enabled: (step === 'datetime' || step === 'confirm') && menuIds.length > 0,
  });
  const slotsByDay = useMemo(
    () => new Map((availability.data?.days ?? []).map((d) => [d.date, d.slots])),
    [availability.data],
  );
  const daySlots = slotsByDay.get(date) ?? [];

  const isClosed = (d: string) => {
    const ex = info.exceptions.find((e) => e.date === d);
    if (ex) return ex.is_closed;
    return !info.businessHours.some((h) => h.weekday === weekdayOf(d));
  };

  const go = (s: Step) => {
    setSubmitError(null);
    setStep(s);
  };
  const idx = steps.findIndex((s) => s.key === step);
  const next = () => {
    const n = steps[idx + 1];
    if (n) go(n.key);
  };
  const back = () => {
    const p = steps[idx - 1];
    if (p) go(p.key);
  };

  const validateInfo = () => {
    const needForm = !session || !profileComplete;
    if (!needForm) return true;
    const e: Record<string, string> = {};
    if (!form.lastName.trim()) e.lastName = '姓を入力してください';
    if (!form.firstName.trim()) e.firstName = '名を入力してください';
    const digits = form.phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11)
      e.phone = '電話番号を正しく入力してください（10〜11桁）';
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email))
      e.email = 'メールアドレスの形式が正しくありません';
    if (
      form.lastNameKana &&
      !/^[゠-ヿ぀-ゟ\s\u3000ー]*$/.test(form.lastNameKana + form.firstNameKana)
    )
      e.lastNameKana = 'フリガナはカタカナで入力してください';
    setFormErrors(e);
    if (Object.keys(e).length)
      window.setTimeout(
        () => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
        0,
      );
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!slot) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (session && !profileComplete) {
        // the booking endpoint only fills *empty* profile fields; update the profile explicitly first
        await publicApi.updateMe(session.token, {
          lastName: form.lastName.trim(),
          firstName: form.firstName.trim(),
          ...(form.lastNameKana.trim() ? { lastNameKana: form.lastNameKana.trim() } : {}),
          ...(form.firstNameKana.trim() ? { firstNameKana: form.firstNameKana.trim() } : {}),
          phone: form.phone.trim(),
        });
      }
      const res = await publicApi.book(
        slug,
        {
          menuIds,
          staffId,
          startAt: slot.start,
          couponId: couponId || null,
          customerNote: note.trim() || null,
          channel: session?.via === 'line' || inLine() ? 'line' : 'web',
          clientRequestId,
          utm: tracking.utm,
          referralCode: tracking.referralCode,
          customer: !session
            ? {
                lastName: form.lastName.trim(),
                firstName: form.firstName.trim(),
                lastNameKana: form.lastNameKana.trim() || undefined,
                firstNameKana: form.firstNameKana.trim() || undefined,
                phone: form.phone.trim(),
                email: form.email.trim() || null,
              }
            : undefined,
        },
        session?.token,
      );
      setResult(res);
      regenRequestId();
      go('done');
    } catch (e) {
      if (
        isApiError(e) &&
        (e.code === 'SLOT_UNAVAILABLE' ||
          e.code === 'APPOINTMENT_OVERLAP' ||
          e.code === 'RESOURCE_OVERLAP')
      ) {
        // the slot was taken meanwhile: refresh slots and let the customer pick again
        regenRequestId();
        setSlot(null);
        setSlotError(
          `申し訳ありません。選択した時間はちょうど埋まってしまいました（${e.message}）。別の時間をお選びください。`,
        );
        void availability.refetch();
        go('datetime');
      } else {
        setSubmitError(errorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onLoggedIn = (r: CustomerAuthResult & { via: 'line' | 'otp' }) => {
    setSession({
      token: r.token,
      customerId: r.customerId,
      via: r.via,
      shopSlug: slug,
      savedAt: Date.now(),
    });
  };

  const address = [info.shop.prefecture, info.shop.city, info.shop.address_line]
    .filter(Boolean)
    .join('');
  const header = (
    <ShopHeader
      name={info.shop.name}
      sub={address || info.shop.phone || 'オンライン予約'}
      right={
        <Link
          to={`/my/${slug}`}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-primary hover:bg-primary-soft"
        >
          <Icon name="user" size={16} />
          マイページ
        </Link>
      }
    />
  );

  if (step === 'done' && result) {
    return (
      <PublicShell header={header}>
        <Done result={result} info={info} tz={tz} loggedIn={!!session} slug={slug} />
      </PublicShell>
    );
  }

  const footerAction = (() => {
    if (step === 'menu')
      return {
        label: '次へ',
        disabled: !menuIds.length,
        onClick: () => {
          if (staffId && !eligibleStaff.some((s) => s.id === staffId)) setStaffId(null);
          setSlot(null);
          next();
        },
      };
    if (step === 'staff')
      return {
        label: '日時を選ぶ',
        disabled: false,
        onClick: () => {
          setSlot(null);
          next();
        },
      };
    if (step === 'datetime') return { label: 'この日時で進む', disabled: !slot, onClick: next };
    if (step === 'info')
      return { label: '確認へ進む', disabled: false, onClick: () => validateInfo() && next() };
    return {
      label: info.booking.requireApproval ? '予約をリクエストする' : '予約を確定する',
      disabled: !slot || submitting,
      onClick: submit,
    };
  })();

  return (
    <PublicShell
      header={header}
      footer={
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur">
          <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {idx > 0 ? (
              <Button
                variant="secondary"
                size="lg"
                onClick={back}
                aria-label="前のステップへ戻る"
                className="!px-3"
              >
                <Icon name="chevron-left" size={20} />
              </Button>
            ) : null}
            <div className="min-w-0 flex-1">
              {selectedMenus.length ? (
                <>
                  <p className="truncate text-xs text-muted">
                    {selectedMenus.length}件 ・ {formatDuration(totalDuration)}
                    {slot
                      ? ` ・ ${formatDateJa(zonedParts(slot.start, tz).date)} ${formatTime(slot.start, tz)}`
                      : ''}
                  </p>
                  <p className="text-base font-semibold tabular">{formatYen(estimate)}</p>
                </>
              ) : (
                <p className="text-[13px] text-muted">メニューを選択してください</p>
              )}
            </div>
            <Button
              variant="primary"
              size="lg"
              disabled={footerAction.disabled}
              loading={step === 'confirm' && submitting}
              onClick={footerAction.onClick}
              data-testid="book-next"
            >
              {footerAction.label}
            </Button>
          </div>
        </div>
      }
    >
      {step === 'menu' ? <ShopReviewsSummary slug={slug} /> : null}
      {info.shop.description && step === 'menu' ? (
        <p className="mb-4 text-[13px] leading-relaxed text-muted">{info.shop.description}</p>
      ) : null}

      <ol className="mb-5 flex items-center gap-1" aria-label="予約の進み具合">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className="flex flex-1 flex-col items-center gap-1"
            aria-current={s.key === step ? 'step' : undefined}
          >
            <span
              className={cn('h-1.5 w-full rounded-full', i <= idx ? 'bg-primary' : 'bg-surface-3')}
            />
            <span
              className={cn(
                'text-[11px]',
                s.key === step ? 'font-semibold text-fg' : 'text-subtle',
              )}
            >
              {s.label}
            </span>
          </li>
        ))}
      </ol>

      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mb-4 text-lg font-semibold tracking-tight outline-none"
      >
        {
          {
            menu: 'メニューを選択',
            staff: 'スタッフを選択',
            datetime: 'ご希望の日時',
            info: 'お客様情報',
            confirm: 'ご予約内容の確認',
            done: '',
          }[step]
        }
      </h1>

      {step === 'menu' ? (
        <MenuStep
          info={info}
          menuIds={menuIds}
          setMenuIds={setMenuIds}
          category={category}
          setCategory={setCategory}
        />
      ) : null}

      {step === 'staff' ? (
        <div className="space-y-2.5" role="radiogroup" aria-label="スタッフ">
          <StaffCard
            selected={staffId === null}
            onSelect={() => setStaffId(null)}
            name="指名なし（おまかせ）"
            title="空いているスタッフが担当します"
          />
          {eligibleStaff.map((s) => (
            <div key={s.id}>
              <StaffCard
                selected={staffId === s.id}
                onSelect={() => setStaffId(s.id)}
                name={s.display_name}
                title={s.title}
                fee={s.nomination_fee}
                bio={s.public_profile?.bio}
                specialties={s.public_profile?.specialties}
                years={s.public_profile?.yearsOfExperience}
              />
              <Link
                to={`/book/${slug}/staff/${s.id}`}
                className="ml-4 mt-1 inline-block text-xs font-medium text-primary hover:underline"
              >
                {s.display_name}のプロフィール・口コミ ›
              </Link>
            </div>
          ))}
          {eligibleStaff.length < info.staff.length ? (
            <p className="text-xs text-muted">
              ※ 選択したメニューを担当できるスタッフのみ表示しています。
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 'datetime' ? (
        <div className="space-y-5">
          {slotError ? (
            <Alert tone="warning" title="時間を選び直してください">
              {slotError}
            </Alert>
          ) : null}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[13px] font-medium">
                {Number(windowStart.slice(5, 7))}月
                {windowStart.slice(5, 7) !== windowEnd.slice(5, 7)
                  ? `〜${Number(windowEnd.slice(5, 7))}月`
                  : ''}
              </p>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={windowStart <= today}
                  onClick={() => {
                    const w =
                      addDays(windowStart, -STRIP_DAYS) < today
                        ? today
                        : addDays(windowStart, -STRIP_DAYS);
                    setWindowStart(w);
                    setDate(w);
                    setSlot(null);
                  }}
                  aria-label="前の2週間"
                >
                  <Icon name="chevron-left" size={16} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={addDays(windowStart, STRIP_DAYS) > horizonEnd}
                  onClick={() => {
                    const w = addDays(windowStart, STRIP_DAYS);
                    setWindowStart(w);
                    setDate(w);
                    setSlot(null);
                  }}
                  aria-label="次の2週間"
                >
                  <Icon name="chevron-right" size={16} />
                </Button>
              </div>
            </div>
            <div
              className="scrollbar-thin -mx-4 flex gap-2 overflow-x-auto px-4 pb-2"
              role="radiogroup"
              aria-label="日付"
            >
              {Array.from({ length: STRIP_DAYS }, (_, i) => addDays(windowStart, i))
                .filter((d) => d <= horizonEnd)
                .map((d) => {
                  const wd = weekdayOf(d);
                  const closed = isClosed(d);
                  const slots = slotsByDay.get(d);
                  const none = !!availability.data && (!slots || !slots.length);
                  const sel = d === date;
                  return (
                    <button
                      key={d}
                      type="button"
                      role="radio"
                      aria-checked={sel}
                      aria-label={`${formatDateJa(d)} ${closed ? '定休日' : none ? '空きなし' : slots ? `空き${slots.length}枠` : ''}`}
                      disabled={closed}
                      onClick={() => {
                        setDate(d);
                        setSlot(null);
                        setSlotError(null);
                      }}
                      className={cn(
                        'flex w-14 shrink-0 flex-col items-center rounded-xl border py-2 transition-colors disabled:opacity-40',
                        sel
                          ? 'border-primary bg-primary text-primary-fg'
                          : 'border-border bg-surface hover:border-primary',
                      )}
                    >
                      <span
                        className={cn(
                          'text-[11px]',
                          !sel &&
                            (wd === 0 ? 'text-danger' : wd === 6 ? 'text-info' : 'text-muted'),
                        )}
                      >
                        {WEEKDAYS_JA[wd]}
                      </span>
                      <span className="text-lg font-semibold leading-tight tabular">
                        {Number(d.slice(8))}
                      </span>
                      <span
                        className={cn(
                          'text-[10px]',
                          sel
                            ? 'text-primary-fg/90'
                            : none || closed
                              ? 'text-subtle'
                              : 'text-success',
                        )}
                      >
                        {closed ? '休' : none ? '×' : slots ? '○' : '・'}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
          <div>
            <p className="mb-2 text-[13px] font-medium">{formatDateJa(date)} の空き時間</p>
            {availability.error ? (
              <ErrorState error={availability.error} onRetry={() => void availability.refetch()} />
            ) : (
              <SlotPicker
                slots={date < windowStart || date > windowEnd ? [] : daySlots}
                value={slot?.start ?? null}
                onChange={(_iso, s) => {
                  setSlot(s);
                  setSlotError(null);
                }}
                tz={tz}
                size="lg"
                loading={availability.isLoading}
                emptyText={
                  isClosed(date)
                    ? 'この日は定休日です'
                    : 'この日は空きがありません。別の日をお選びください'
                }
              />
            )}
          </div>
          <p className="text-xs text-muted">
            {staff
              ? `${staff.display_name} の空き時間を表示しています。`
              : '指名なしの場合、空いているスタッフが担当します。'}
            受付は開始
            {info.booking.leadTimeMin >= 60
              ? `${Math.round(info.booking.leadTimeMin / 60)}時間`
              : `${info.booking.leadTimeMin}分`}
            前までです。
          </p>
        </div>
      ) : null}

      {step === 'info' ? (
        <div className="space-y-5">
          {session ? (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4">
              <div className="min-w-0">
                <p className="text-xs text-muted">
                  {session.via === 'line' ? 'LINEでログイン中' : 'ログイン中'}
                </p>
                <p className="truncate text-[15px] font-semibold">
                  {profile.data
                    ? `${profile.data.last_name} ${profile.data.first_name}`.trim() ||
                      'お名前未登録'
                    : '…'}
                </p>
                {profile.data?.phone ? (
                  <p className="text-xs text-muted">{profile.data.phone}</p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  customerSession.clear(slug);
                  setSession(null);
                }}
              >
                ログアウト
              </Button>
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="mb-3 text-[13px] font-medium">ログインして入力を省略</p>
              <CustomerLogin slug={slug} onLoggedIn={onLoggedIn} compact />
            </div>
          )}

          {!session || (profile.data && !profileComplete) ? (
            <div className="space-y-4 rounded-2xl border border-border bg-surface p-4">
              <p className="text-[13px] font-medium">
                {session ? 'お名前と電話番号をご入力ください' : 'ゲストとして予約'}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="姓" required error={formErrors.lastName}>
                  <Input
                    value={form.lastName}
                    onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                    autoComplete="family-name"
                    inputSize="lg"
                  />
                </Field>
                <Field label="名" required error={formErrors.firstName}>
                  <Input
                    value={form.firstName}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                    autoComplete="given-name"
                    inputSize="lg"
                  />
                </Field>
                <Field label="セイ" error={formErrors.lastNameKana}>
                  <Input
                    value={form.lastNameKana}
                    onChange={(e) => setForm({ ...form, lastNameKana: e.target.value })}
                    inputSize="lg"
                  />
                </Field>
                <Field label="メイ">
                  <Input
                    value={form.firstNameKana}
                    onChange={(e) => setForm({ ...form, firstNameKana: e.target.value })}
                    inputSize="lg"
                  />
                </Field>
              </div>
              <Field
                label="電話番号"
                required
                error={formErrors.phone}
                hint="予約の確認でご連絡する場合があります"
              >
                <Input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  autoComplete="tel"
                  inputMode="tel"
                  inputSize="lg"
                  placeholder="09012345678"
                />
              </Field>
              {!session ? (
                <Field
                  label="メールアドレス"
                  optional
                  error={formErrors.email}
                  hint="予約確認メールをお送りします"
                >
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    autoComplete="email"
                    inputSize="lg"
                  />
                </Field>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-4 rounded-2xl border border-border bg-surface p-4">
            <Field label="ご要望・ご質問" optional>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="髪の長さ、気になること、ご質問など"
              />
            </Field>
            {coupons.length ? (
              <fieldset>
                <legend className="mb-2 text-[13px] font-medium">クーポン</legend>
                <div className="space-y-2">
                  <label
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-xl border p-3',
                      !couponId ? 'border-primary bg-primary-soft/40' : 'border-border',
                    )}
                  >
                    <input
                      type="radio"
                      name="coupon"
                      className="accent-[var(--primary)]"
                      checked={!couponId}
                      onChange={() => setCouponId('')}
                    />
                    <span className="text-[13px]">使用しない</span>
                  </label>
                  {coupons.map(({ c, discount }) => (
                    <label
                      key={c.id}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-xl border p-3',
                        couponId === c.id ? 'border-primary bg-primary-soft/40' : 'border-border',
                      )}
                    >
                      <input
                        type="radio"
                        name="coupon"
                        className="mt-1 accent-[var(--primary)]"
                        checked={couponId === c.id}
                        onChange={() => setCouponId(c.id)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium">{c.name}</span>
                        {c.description ? (
                          <span className="block text-xs text-muted">{c.description}</span>
                        ) : null}
                        {c.newCustomerOnly ? (
                          <Badge size="sm" tone="info" className="mt-1">
                            新規限定
                          </Badge>
                        ) : null}
                      </span>
                      <span className="text-[13px] font-semibold text-accent tabular">
                        -{formatYen(discount)}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
          </div>
        </div>
      ) : null}

      {step === 'confirm' && slot ? (
        <div className="space-y-4">
          {submitError ? (
            <Alert tone="danger" title="予約できませんでした">
              {submitError}
            </Alert>
          ) : null}
          <div className="overflow-hidden rounded-2xl border border-border bg-surface">
            <div className="bg-primary-soft/60 px-4 py-3">
              <p className="text-xs text-muted">ご予約日時</p>
              <p className="text-lg font-semibold">
                {formatDateJa(zonedParts(slot.start, tz).date, { year: true })}{' '}
                {formatTime(slot.start, tz)}〜
              </p>
              <p className="text-xs text-muted">
                終了予定 {formatTime(slot.end, tz)}（{formatDuration(totalDuration)}）
              </p>
            </div>
            <dl className="divide-y divide-border text-[13px]">
              <div className="flex justify-between gap-4 px-4 py-3">
                <dt className="text-muted">店舗</dt>
                <dd className="text-right font-medium">{info.shop.name}</dd>
              </div>
              <div className="flex justify-between gap-4 px-4 py-3">
                <dt className="text-muted">担当</dt>
                <dd className="text-right font-medium">
                  {staff ? staff.display_name : '指名なし'}
                </dd>
              </div>
              <div className="px-4 py-3">
                <dt className="mb-1 text-muted">メニュー</dt>
                {selectedMenus.map((m) => (
                  <dd key={m.id} className="flex justify-between gap-4">
                    <span>{m.name}</span>
                    <span className="tabular">{formatYen(m.price)}</span>
                  </dd>
                ))}
                {nominationFee ? (
                  <dd className="flex justify-between gap-4 text-muted">
                    <span>指名料</span>
                    <span className="tabular">{formatYen(nominationFee)}</span>
                  </dd>
                ) : null}
                {coupon ? (
                  <dd className="flex justify-between gap-4 text-accent">
                    <span>{coupon.c.name}</span>
                    <span className="tabular">-{formatYen(coupon.discount)}</span>
                  </dd>
                ) : null}
              </div>
              <div className="flex justify-between gap-4 px-4 py-3">
                <dt className="font-medium">お支払い目安（税込）</dt>
                <dd className="text-base font-semibold tabular">{formatYen(estimate)}</dd>
              </div>
              <div className="flex justify-between gap-4 px-4 py-3">
                <dt className="text-muted">お名前</dt>
                <dd className="text-right font-medium">
                  {session && profileComplete
                    ? `${profile.data?.last_name} ${profile.data?.first_name}`
                    : `${form.lastName} ${form.firstName}`}
                  <span className="block text-xs font-normal text-muted">
                    {session && profileComplete ? profile.data?.phone : form.phone}
                  </span>
                </dd>
              </div>
              {note ? (
                <div className="px-4 py-3">
                  <dt className="text-muted">ご要望</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap">{note}</dd>
                </div>
              ) : null}
            </dl>
          </div>
          <Alert tone="info" title="キャンセル・変更について">
            ご予約の変更・キャンセルは開始{info.booking.cancelDeadlineHours}
            時間前まで、予約完了後に表示される管理ページまたはマイページから行えます。
            {info.booking.requireApproval ? ' 本予約は店舗の承認後に確定します。' : ''}
          </Alert>
          <p className="text-center text-xs text-muted">
            料金は目安です。施術内容により変わる場合があります。
          </p>
        </div>
      ) : null}
    </PublicShell>
  );
}

function MenuStep({
  info,
  menuIds,
  setMenuIds,
  category,
  setCategory,
}: {
  info: PublicShopInfo;
  menuIds: string[];
  setMenuIds: (ids: string[]) => void;
  category: string;
  setCategory: (c: string) => void;
}) {
  const cats = [
    ...new Map(
      info.menus.map((m) => [m.categoryId ?? 'none', m.categoryName ?? 'その他']),
    ).entries(),
  ];
  const max = info.booking.maxServicesPerBooking;
  const list = info.menus.filter(
    (m) => category === 'all' || (m.categoryId ?? 'none') === category,
  );
  if (!info.menus.length)
    return <EmptyState icon="scissors" title="現在オンラインで予約できるメニューはありません" />;
  return (
    <div className="space-y-4">
      <div
        className="scrollbar-thin -mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
        role="tablist"
        aria-label="カテゴリ"
      >
        {[['all', 'すべて'] as const, ...cats].map(([id, name]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={category === id}
            onClick={() => setCategory(id)}
            className={cn(
              'shrink-0 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors',
              category === id
                ? 'border-fg bg-fg text-bg'
                : 'border-border bg-surface text-fg hover:bg-surface-2',
            )}
          >
            {name}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">最大{max}つまで選べます（選択した順に施術します）</p>
      <ul className="space-y-2.5">
        {list.map((m) => {
          const checked = menuIds.includes(m.id);
          const disabled = !checked && menuIds.length >= max;
          return (
            <li key={m.id}>
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-2xl border bg-surface p-4 transition-colors',
                  checked
                    ? 'border-primary ring-1 ring-primary'
                    : 'border-border hover:border-border-strong',
                  disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5 shrink-0 accent-[var(--primary)]"
                  checked={checked}
                  disabled={disabled}
                  onChange={() =>
                    setMenuIds(checked ? menuIds.filter((x) => x !== m.id) : [...menuIds, m.id])
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[15px] font-semibold text-fg">{m.name}</span>
                    {m.newCustomerOnly ? (
                      <Badge size="sm" tone="info">
                        新規限定
                      </Badge>
                    ) : null}
                    {m.isConsultation ? (
                      <Badge size="sm" tone="primary">
                        相談のみ
                      </Badge>
                    ) : null}
                  </span>
                  {m.description ? (
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                      {m.description}
                    </span>
                  ) : null}
                  <span className="mt-1.5 flex items-center gap-1 text-xs text-muted">
                    <Icon name="clock" size={13} />
                    {formatDuration(m.durationMin)}
                  </span>
                </span>
                <span className="shrink-0 text-[15px] font-semibold tabular">
                  {m.price ? formatYen(m.price) : '無料'}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StaffCard({
  selected,
  onSelect,
  name,
  title,
  fee,
  bio,
  specialties,
  years,
}: {
  selected: boolean;
  onSelect: () => void;
  name: string;
  title?: string | null;
  fee?: number;
  bio?: string;
  specialties?: string[];
  years?: number;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-2xl border bg-surface p-4 text-left transition-colors',
        selected
          ? 'border-primary ring-1 ring-primary'
          : 'border-border hover:border-border-strong',
      )}
    >
      <span
        className={cn(
          'flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-lg font-semibold',
          fee === undefined ? 'bg-surface-2 text-muted' : 'bg-primary-soft text-primary',
        )}
        aria-hidden
      >
        {fee === undefined ? <Icon name="users" size={22} /> : name.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[15px] font-semibold">{name}</span>
          {title ? <span className="text-xs text-muted">{title}</span> : null}
        </span>
        {years ? <span className="block text-xs text-muted">経験 {years}年</span> : null}
        {bio ? (
          <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-muted">{bio}</span>
        ) : null}
        {specialties?.length ? (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {specialties.map((s) => (
              <Badge key={s} size="sm">
                {s}
              </Badge>
            ))}
          </span>
        ) : null}
      </span>
      {fee !== undefined ? (
        <span className="shrink-0 text-xs text-muted">
          {fee ? `指名料 +${formatYen(fee)}` : '指名料なし'}
        </span>
      ) : null}
    </button>
  );
}

function Done({
  result,
  info,
  tz,
  loggedIn,
  slug,
}: {
  result: PublicBookingResult;
  info: PublicShopInfo;
  tz: string;
  loggedIn: boolean;
  slug: string;
}) {
  const a = result.appointment;
  const managePath = manageUrlToPath(result.manageUrl);
  const tentative = a.status === 'tentative';
  const address = [info.shop.prefecture, info.shop.city, info.shop.address_line]
    .filter(Boolean)
    .join('');
  return (
    <div className="space-y-5 pt-2">
      <div className="flex flex-col items-center text-center">
        <span
          className={cn(
            'flex h-16 w-16 items-center justify-center rounded-full',
            tentative ? 'bg-warning-soft text-warning' : 'bg-success-soft text-success',
          )}
        >
          <Icon name={tentative ? 'clock' : 'check'} size={32} />
        </span>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">
          {tentative ? '予約リクエストを受け付けました' : 'ご予約が完了しました'}
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          {tentative
            ? '店舗が内容を確認後、予約が確定します。'
            : 'ご来店を心よりお待ちしております。'}
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-surface p-4">
        <p className="text-xs text-muted">予約番号</p>
        <p
          className="font-mono text-2xl font-semibold tracking-wider"
          data-testid="booking-reference"
        >
          {a.bookingReference}
        </p>
        <dl className="mt-3 space-y-1.5 text-[13px]">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">日時</dt>
            <dd className="text-right font-medium">
              {formatDateJa(zonedParts(a.startAt, tz).date, { year: true })}{' '}
              {formatTime(a.startAt, tz)}〜{formatTime(a.endAt, tz)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">担当</dt>
            <dd className="text-right">
              {a.isNominated ? a.staffName : `${a.staffName ?? '当日決定'}（指名なし）`}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">メニュー</dt>
            <dd className="text-right">{a.services.map((s) => s.name).join('、')}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">お支払い目安</dt>
            <dd className="text-right font-medium tabular">{formatYen(a.estimatedTotal)}</dd>
          </div>
        </dl>
      </div>
      <div className="grid gap-2.5">
        <Button
          variant="secondary"
          size="lg"
          icon="calendar"
          onClick={() =>
            downloadIcs(
              {
                uid: `${a.id}@salon-os`,
                start: a.startAt,
                end: a.endAt,
                summary: `${info.shop.name} ご予約`,
                description: `予約番号: ${a.bookingReference}\nメニュー: ${a.services.map((s) => s.name).join('、')}${managePath ? `\n予約の確認・キャンセル: ${window.location.origin}${managePath}` : ''}`,
                location: address || undefined,
                url: managePath ? `${window.location.origin}${managePath}` : undefined,
              },
              `reservation-${a.bookingReference}.ics`,
            )
          }
        >
          カレンダーに追加
        </Button>
        {managePath ? (
          <ButtonLink to={managePath} variant="secondary" size="lg" icon="external">
            予約の確認・キャンセル
          </ButtonLink>
        ) : null}
        {loggedIn ? (
          <ButtonLink to={`/my/${slug}`} variant="ghost" size="lg">
            マイページで予約を見る
          </ButtonLink>
        ) : null}
      </div>
      {managePath ? (
        <p className="text-center text-xs text-muted">
          「予約の確認・キャンセル」のページをブックマークしておくと便利です。
        </p>
      ) : null}
      {info.shop.phone ? (
        <p className="text-center text-[13px] text-muted">
          お問い合わせ:{' '}
          <a href={`tel:${info.shop.phone}`} className="font-medium text-primary">
            {info.shop.phone}
          </a>
        </p>
      ) : null}
    </div>
  );
}
