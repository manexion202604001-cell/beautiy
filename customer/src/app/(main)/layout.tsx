"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { BottomNav } from "@/components/bottom-nav";
import { PhoneMatchScreen } from "@/components/phone-match-screen";
import { authApi, storeApi, setStoreId, type Customer } from "@/lib/api";
import { useLiffAuth } from "@/hooks/useLiffAuth";

function isPublicPath(path: string): boolean {
  return path.startsWith("/reserve") || path.startsWith("/messages");
}

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPhoneMatch, setShowPhoneMatch] = useState(false);
  const [liffId, setLiffId] = useState<string | null | undefined>(undefined); // undefined = loading
  const [liffRedirecting, setLiffRedirecting] = useState(false);
  const authHandled = useRef(false);
  const isLiffRedirect = useRef(false);

  // Step 0: Extract store_id from URL and track LIFF redirect
  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);

    // Extract store_id from direct URL query parameter (e.g. /mypage?store_id=...)
    const directStoreId = params.get("store_id");
    if (directStoreId) {
      setStoreId(directStoreId);
    }

    // Track if this is a LIFF auth redirect (has code param from OAuth)
    if (params.has("code") || params.has("liff.state")) {
      isLiffRedirect.current = true;

      // Extract store_id from liff.state (overrides direct query param)
      const liffState = params.get("liff.state");
      if (liffState) {
        try {
          const decoded = decodeURIComponent(liffState);
          const qIdx = decoded.indexOf("?");
          if (qIdx !== -1) {
            const stateParams = new URLSearchParams(decoded.slice(qIdx + 1));
            const storeId = stateParams.get("store_id");
            if (storeId) {
              setStoreId(storeId);
            }
          }
        } catch {
          // Ignore decode errors
        }
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Determine if this is a public page (messages, reserve — accessible without login)
  const currentPath =
    typeof window !== "undefined" ? window.location.pathname : pathname;
  const isPublicPage = isPublicPath(pathname) || isPublicPath(currentPath);

  // Step 1: Fetch store config to get LIFF ID (skip on public pages — not needed)
  useEffect(() => {
    if (isPublicPage) return;
    storeApi
      .get()
      .then((data) => setLiffId(data.store?.line_liff_id || null))
      .catch(() => setLiffId(null));
  }, [isPublicPage]);

  // Step 2: Attempt LIFF auto-login (only on non-public pages to avoid redirect loops)
  const liffState = useLiffAuth(isPublicPage ? null : liffId);

  // Step 3: Handle auth
  useEffect(() => {
    if (authHandled.current) return;

    if (isPublicPage) {
      authHandled.current = true;
      setLoading(false);

      // Check if LIFF auth completed before redirect and needs phone match
      if (typeof window !== "undefined") {
        const needsPhoneMatch = sessionStorage.getItem("liff_needs_phone_match");
        if (needsPhoneMatch) {
          sessionStorage.removeItem("liff_needs_phone_match");
          setShowPhoneMatch(true);
          return;
        }
      }

      // バックグラウンドで顧客情報を取得（失敗してもOK）
      authApi
        .me()
        .then((data) => setCustomer(data.customer))
        .catch(() => {});
      return;
    }

    // Non-public pages: wait for LIFF auth to complete
    if (liffId === undefined) return;
    if (liffId && liffState === "idle") return;
    if (liffId && liffState === "initializing") return;
    if (liffId && liffState === "authenticating") return;

    authHandled.current = true;

    if (liffState === "needs-phone-match") {
      setShowPhoneMatch(true);
      setLoading(false);
      return;
    }

    authApi
      .me()
      .then((data) => {
        setCustomer(data.customer);
        setLoading(false);
      })
      .catch(() => {
        if (isLiffRedirect.current) {
          // LIFF SDK already restored the target URL from liff.state (e.g. /reserve).
          // Redirect there — public pages work without auth, others will redirect to login on next load.
          window.location.replace(window.location.href);
          return;
        }
        // Normal auth failure — use window.location to avoid RSC payload issue
        window.location.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
      });
  }, [router, pathname, isPublicPage, liffId, liffState]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (showPhoneMatch) {
    return (
      <PhoneMatchScreen
        onComplete={() => {
          setShowPhoneMatch(false);
          authApi
            .me()
            .then((data) => setCustomer(data.customer))
            .catch(() => {});
        }}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col pb-16">
      <main className="flex-1">{children}</main>
      <BottomNav />
    </div>
  );
}
