import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { storeApi, type ShippingAddress } from '../../../api/commerce';
import { publicApi } from '../../../api/public';
import { Alert, Button, Field, Input, PageSpinner, Select, Textarea } from '../../../components/ui';
import { errorMessage, isApiError, newIdempotencyKey } from '../../../lib/api';
import { formatYen } from '../../../lib/format';
import { customerSession, type CustomerSession } from '../../../lib/session';
import { CustomerLogin } from '../CustomerLogin';
import { PublicShell } from '../PublicShell';
import {
  cartCount,
  cartSubtotal,
  clearRef,
  emptyCart,
  orderItems,
  saveCart,
  storedRef,
  useCart,
} from './cart';
import { StoreHeader } from './StoreHeader';

const PREFECTURES = [
  '北海道',
  '青森県',
  '岩手県',
  '宮城県',
  '秋田県',
  '山形県',
  '福島県',
  '茨城県',
  '栃木県',
  '群馬県',
  '埼玉県',
  '千葉県',
  '東京都',
  '神奈川県',
  '新潟県',
  '富山県',
  '石川県',
  '福井県',
  '山梨県',
  '長野県',
  '岐阜県',
  '静岡県',
  '愛知県',
  '三重県',
  '滋賀県',
  '京都府',
  '大阪府',
  '兵庫県',
  '奈良県',
  '和歌山県',
  '鳥取県',
  '島根県',
  '岡山県',
  '広島県',
  '山口県',
  '徳島県',
  '香川県',
  '愛媛県',
  '高知県',
  '福岡県',
  '佐賀県',
  '長崎県',
  '熊本県',
  '大分県',
  '宮崎県',
  '鹿児島県',
  '沖縄県',
];

/** /store/:shopSlug/checkout — customer login (LINE / OTP) → shipping → order + online payment */
export default function CheckoutPage() {
  const { shopSlug = '' } = useParams();
  const navigate = useNavigate();
  const shop = useQuery({
    queryKey: ['public', 'shop', shopSlug],
    queryFn: () => publicApi.shop(shopSlug),
    retry: false,
  });
  const [session, setSession] = useState<CustomerSession | null>(() =>
    customerSession.get(shopSlug),
  );
  const { cart, update } = useCart(shopSlug);
  const me = useQuery({
    queryKey: ['public', 'me', session?.token ?? ''],
    queryFn: () => publicApi.me(session!.token),
    enabled: !!session,
    retry: false,
  });
  const [addr, setAddr] = useState<ShippingAddress>({
    postalCode: '',
    prefecture: '東京都',
    city: '',
    line1: '',
    line2: '',
    name: '',
    phone: '',
  });
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (me.data) {
      setAddr((a) => ({
        ...a,
        name: a.name || `${me.data.last_name} ${me.data.first_name}`.trim(),
        phone: a.phone || me.data.phone || '',
      }));
      setEmail((e) => e || me.data.email || '');
    }
  }, [me.data]);
  useEffect(() => {
    if (me.error && isApiError(me.error) && me.error.status === 401) {
      customerSession.clear(shopSlug);
      setSession(null);
    }
  }, [me.error, shopSlug]);

  if (shop.isLoading) return <PageSpinner />;
  if (!cart.items.length && !busy) return <Navigate to={`/store/${shopSlug}/cart`} replace />;
  const name = shop.data?.shop.name ?? 'オンラインストア';
  const set = (k: keyof ShippingAddress, v: string) => {
    setAddr((a) => ({ ...a, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: '' }));
  };

  const submit = async () => {
    if (!session) return;
    const errs: Record<string, string> = {};
    if (!/^\d{3}-?\d{4}$/.test(addr.postalCode.trim()))
      errs.postalCode = '郵便番号は7桁で入力してください';
    if (!addr.city.trim()) errs.city = '市区町村を入力してください';
    if (!addr.line1.trim()) errs.line1 = '番地を入力してください';
    if (!addr.name.trim()) errs.name = 'お名前を入力してください';
    if (!/^[0-9+\-() ]{10,20}$/.test(addr.phone.trim()))
      errs.phone = '電話番号を正しく入力してください';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      errs.email = 'メールアドレスの形式が正しくありません';
    setErrors(errs);
    if (Object.keys(errs).length) {
      window.setTimeout(
        () => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
        0,
      );
      return;
    }
    // keep the idempotency key with the cart so a reload / double tap never creates two orders
    const key = cart.pendingOrderKey ?? newIdempotencyKey();
    if (!cart.pendingOrderKey) update((c) => ({ ...c, pendingOrderKey: key }));
    setBusy(true);
    setError(null);
    try {
      const ref = storedRef();
      const res = await storeApi.createOrder(session.token, {
        shopSlug,
        items: orderItems(cart),
        shippingAddress: {
          postalCode: addr.postalCode.trim(),
          prefecture: addr.prefecture,
          city: addr.city.trim(),
          line1: addr.line1.trim(),
          ...(addr.line2?.trim() ? { line2: addr.line2.trim() } : {}),
          name: addr.name.trim(),
          phone: addr.phone.trim(),
        },
        ...(email.trim() ? { contactEmail: email.trim() } : {}),
        ...(ref ? { referralCode: ref } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        channel: /Line\//i.test(navigator.userAgent) ? 'line' : 'online',
        idempotencyKey: key,
      });
      saveCart(shopSlug, emptyCart());
      clearRef();
      navigate(`/store/${shopSlug}/orders/${res.order.id}`, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      if (isApiError(e) && e.status > 0) update((c) => ({ ...c, pendingOrderKey: null }));
      if (isApiError(e) && e.status === 401) {
        customerSession.clear(shopSlug);
        setSession(null);
      }
      setBusy(false);
    }
  };

  return (
    <PublicShell
      header={<StoreHeader slug={shopSlug} name={name} sub="ご購入手続き" />}
      footer={
        session ? (
          <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
            <div className="mx-auto max-w-xl">
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                loading={busy}
                onClick={() => void submit()}
                data-testid="place-order"
              >
                注文を確定してお支払いへ
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      <h1 className="mb-4 text-lg font-semibold">ご購入手続き</h1>
      <section className="mb-5 rounded-2xl border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold">ご注文内容</h2>
        <ul className="divide-y divide-border text-[13px]">
          {cart.items.map((i) => (
            <li key={i.productId} className="flex justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate">
                {i.name} × {i.quantity}
              </span>
              <span className="tabular">{formatYen(i.price * i.quantity)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 flex justify-between border-t border-border pt-2 text-sm font-semibold">
          <span>小計（{cartCount(cart)}点・税込）</span>
          <span className="tabular">{formatYen(cartSubtotal(cart))}</span>
        </p>
        <p className="mt-1 text-xs text-muted">
          送料はご注文確定時に計算し、次の画面でお支払い金額をご案内します。
        </p>
      </section>

      {!session ? (
        <section className="rounded-2xl border border-border bg-surface p-4">
          <h2 className="mb-1 text-sm font-semibold">ログイン</h2>
          <p className="mb-3 text-[13px] text-muted">
            ご購入にはログインが必要です（LINE または 電話番号・メール）。
          </p>
          <CustomerLogin
            slug={shopSlug}
            compact
            onLoggedIn={(r) =>
              setSession({
                token: r.token,
                customerId: r.customerId,
                via: r.via,
                shopSlug,
                savedAt: Date.now(),
              })
            }
          />
        </section>
      ) : (
        <section className="space-y-4 rounded-2xl border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold">お届け先</h2>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Field label="お名前" required error={errors.name}>
            <Input
              value={addr.name}
              onChange={(e) => set('name', e.target.value)}
              autoComplete="name"
              inputSize="lg"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="郵便番号" required error={errors.postalCode}>
              <Input
                value={addr.postalCode}
                onChange={(e) => set('postalCode', e.target.value)}
                inputMode="numeric"
                autoComplete="postal-code"
                placeholder="150-0001"
                inputSize="lg"
              />
            </Field>
            <Field label="都道府県" required>
              <Select
                value={addr.prefecture}
                onChange={(e) => set('prefecture', e.target.value)}
                autoComplete="address-level1"
              >
                {PREFECTURES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="市区町村" required error={errors.city}>
            <Input
              value={addr.city}
              onChange={(e) => set('city', e.target.value)}
              autoComplete="address-level2"
              inputSize="lg"
            />
          </Field>
          <Field label="番地" required error={errors.line1}>
            <Input
              value={addr.line1}
              onChange={(e) => set('line1', e.target.value)}
              autoComplete="address-line1"
              inputSize="lg"
            />
          </Field>
          <Field label="建物名・部屋番号" optional>
            <Input
              value={addr.line2 ?? ''}
              onChange={(e) => set('line2', e.target.value)}
              autoComplete="address-line2"
              inputSize="lg"
            />
          </Field>
          <Field label="電話番号" required error={errors.phone}>
            <Input
              value={addr.phone}
              onChange={(e) => set('phone', e.target.value)}
              inputMode="tel"
              autoComplete="tel"
              inputSize="lg"
            />
          </Field>
          <Field label="メールアドレス" optional hint="注文確認をお送りします" error={errors.email}>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              inputMode="email"
              autoComplete="email"
              inputSize="lg"
            />
          </Field>
          <Field label="備考" optional>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={1000}
            />
          </Field>
        </section>
      )}
    </PublicShell>
  );
}
