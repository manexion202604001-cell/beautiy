import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { publicMessagingApi } from '../api/messaging';

/**
 * LINE Front-end Framework (LIFF).
 *
 * One LIFF app per LINE official account. Its endpoint URL in LINE Developers is the web root
 * (`<WEB_BASE_URL>/`), so one LIFF app serves every customer page:
 *   https://liff.line.me/<liffId>/line/link?linkToken=…   LINE連携 (account link)
 *   https://liff.line.me/<liffId>/consent/<shop>?…        受付 (walk-in consent / counselling)
 *   https://liff.line.me/<liffId>/book/<shop>             予約 (LINEでログイン)
 *   https://liff.line.me/<liffId>/my/<shop>               マイページ
 * LINE first opens the endpoint with `?liff.state=<path>` (LiffEntry), liff.init() then moves on to
 * `<WEB_BASE_URL><path>`, and that page initialises the same LIFF app again. An endpoint of
 * `<WEB_BASE_URL>/liff` also works (the /liff prefix is dropped).
 *
 * The LIFF ID of a page comes from GET /v1/public/line/liff (by the shop slug of the page or the
 * account-link token), or from a `liffId` parameter of the URL.
 */
export const LIFF_SDK_URL = 'https://static.line-scdn.net/liff/edge/2/sdk.js';

export interface Liff {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  isInClient(): boolean;
  login(options?: { redirectUri?: string }): void;
  getIDToken(): string | null;
}

const LIFF_ID_RE = /^[0-9]+-[A-Za-z0-9]+$/;
export const isLiffId = (v: string | null | undefined): v is string => !!v && LIFF_ID_RE.test(v);

let sdk: Promise<Liff> | null = null;
const inits = new Map<string, Promise<Liff>>();
let ready: Liff | null = null;

function loadSdk(): Promise<Liff> {
  const existing = (window as unknown as { liff?: Liff }).liff;
  if (existing) return Promise.resolve(existing);
  sdk ??= new Promise<Liff>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = LIFF_SDK_URL;
    script.async = true;
    script.onload = () => {
      const liff = (window as unknown as { liff?: Liff }).liff;
      if (liff) resolve(liff);
      else reject(new Error('LIFF SDK を読み込めませんでした'));
    };
    script.onerror = () => {
      sdk = null;
      reject(new Error('LIFF SDK を読み込めませんでした'));
    };
    document.head.appendChild(script);
  });
  return sdk;
}

/** Load the SDK and run liff.init() once per LIFF ID */
export function initLiff(liffId: string): Promise<Liff> {
  let p = inits.get(liffId);
  if (!p) {
    p = loadSdk().then(async (liff) => {
      await liff.init({ liffId });
      ready = liff;
      return liff;
    });
    p.catch(() => inits.delete(liffId));
    inits.set(liffId, p);
  }
  return p;
}

/** The initialised LIFF SDK of this page (null outside LIFF / before init) */
export function readyLiff(): Liff | null {
  return ready;
}

/** ID token of the LINE user when the page runs in LIFF and the user is logged in (never forces a login) */
export function liffIdTokenIfLoggedIn(): string | null {
  try {
    return ready && ready.isLoggedIn() ? ready.getIDToken() : null;
  } catch {
    return null;
  }
}

/** Test hook */
export function _resetLiffForTests() {
  sdk = null;
  inits.clear();
  ready = null;
}

/** LIFF ID / 友だち追加URL of the LINE account of a shop or of an account-link token */
export function useLiffConfig(target: { shop?: string; linkToken?: string }) {
  const enabled = !!(target.shop || target.linkToken);
  return useQuery({
    queryKey: ['public', 'liff-config', target.shop ?? null, target.linkToken ?? null],
    queryFn: () =>
      publicMessagingApi.liffConfig(
        target.shop ? { shop: target.shop } : { linkToken: target.linkToken },
      ),
    enabled,
    retry: false,
    staleTime: Infinity,
  });
}

export type LiffStatus = 'none' | 'loading' | 'ready' | 'error';

/**
 * Initialise LIFF for a customer page. `liffId` (from the URL) wins over the configured one.
 * Status 'none' = no LIFF app for this shop (or the config could not be read): the page works
 * without LINE.
 */
export function useLiff(target: { shop?: string; linkToken?: string; liffId?: string | null }) {
  const config = useLiffConfig(target);
  const liffId = isLiffId(target.liffId) ? target.liffId : (config.data?.liffId ?? null);
  const [state, setState] = useState<{ id: string | null; status: LiffStatus }>({
    id: null,
    status: 'none',
  });

  useEffect(() => {
    if (!liffId) return;
    let alive = true;
    setState({ id: liffId, status: 'loading' });
    initLiff(liffId).then(
      () => alive && setState({ id: liffId, status: 'ready' }),
      () => alive && setState({ id: liffId, status: 'error' }),
    );
    return () => {
      alive = false;
    };
  }, [liffId]);

  const status: LiffStatus = !liffId
    ? config.isLoading && !isLiffId(target.liffId)
      ? 'loading'
      : 'none'
    : state.id === liffId
      ? state.status
      : 'loading';
  return {
    status,
    liffId,
    friendUrl: config.data?.friendUrl ?? null,
    liff: status === 'ready' ? readyLiff() : null,
  };
}

// ---------------------------------------------------------------- LIFF entry (endpoint URL)

/** Same-origin path of liff.state (null when it is not a plain path of this site) */
export function liffStateTarget(state: string | null): string | null {
  if (!state) return null;
  let target = state.trim();
  if (target.startsWith('?') || target.startsWith('#')) target = `/${target}`;
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) return null;
  // the LIFF app's endpoint may be <WEB_BASE_URL>/liff
  if (target === '/liff' || target.startsWith('/liff/') || target.startsWith('/liff?'))
    target = target.slice(5) || '/';
  // a query-only link (https://liff.line.me/<id>?linkToken=…) is the account link
  if (target.startsWith('/?') && /[?&](linkToken|token)=/.test(target))
    target = `/line/link${target.slice(1)}`;
  return target;
}

/** What tells which LIFF app a target page belongs to */
export function liffTargetLookup(target: string): {
  liffId?: string;
  shop?: string;
  linkToken?: string;
} {
  const url = new URL(target, 'https://x.invalid');
  const liffId = url.searchParams.get('liffId');
  if (isLiffId(liffId)) return { liffId };
  const m = /^\/(?:consent|book|my|s|store|shop)\/([^/]+)/.exec(url.pathname);
  if (m) return { shop: decodeURIComponent(m[1]!) };
  const linkToken = url.searchParams.get('linkToken') ?? url.searchParams.get('token');
  if (linkToken) return { linkToken };
  return {};
}
