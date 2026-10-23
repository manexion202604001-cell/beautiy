import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router';
import { publicMessagingApi } from '../../api/messaging';
import { PageSpinner } from '../../components/ui';
import { initLiff, isLiffId, liffStateTarget, liffTargetLookup } from '../../lib/liff';

/**
 * The LIFF app's endpoint URL (`/`, or `/liff`). LINE opens it as `/?liff.state=<path>`: find the
 * LIFF app of the target page, run liff.init() (which continues to `<path>`), and fall back to
 * opening the page directly. Without liff.state, `/` is the staff app and `/liff/<path>` is `<path>`.
 */
export default function LiffEntry() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const state = params.get('liff.state');
  const target = liffStateTarget(state);

  useEffect(() => {
    if (!target) return;
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      window.location.replace(target);
    };
    void (async () => {
      try {
        const lookup = liffTargetLookup(target);
        const liffId = isLiffId(lookup.liffId)
          ? lookup.liffId
          : lookup.shop || lookup.linkToken
            ? (
                await publicMessagingApi.liffConfig(
                  lookup.shop ? { shop: lookup.shop } : { linkToken: lookup.linkToken },
                )
              ).liffId
            : null;
        if (!liffId) return go();
        // liff.init() moves on to the target page itself; open it directly if it has not after a moment
        await initLiff(liffId);
        window.setTimeout(go, 1500);
      } catch {
        go();
      }
    })();
  }, [target]);

  if (target) return <PageSpinner />;
  if (location.pathname === '/liff' || location.pathname.startsWith('/liff/')) {
    const rest = location.pathname.slice(5) || '/';
    return <Navigate to={`${rest === '/' ? '/app' : rest}${location.search}`} replace />;
  }
  // a query-only account link (https://liff.line.me/<id>?linkToken=…) opened without liff.state
  if (params.get('linkToken')) return <Navigate to={`/line/link${location.search}`} replace />;
  return <Navigate to="/app" replace />;
}
