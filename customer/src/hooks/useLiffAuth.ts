"use client";

import { useEffect, useRef, useState } from "react";
import { initLiff, isInLiffBrowser, getLiffAccessToken } from "@/lib/liff";
import { tokenStorage, API_BASE_URL, getStoreId } from "@/lib/api";

export type LiffAuthState =
  | "idle"
  | "initializing"
  | "authenticating"
  | "success"
  | "failed"
  | "not-in-liff"
  | "needs-phone-match";

export function useLiffAuth(liffId: string | null | undefined) {
  const [state, setState] = useState<LiffAuthState>("idle");
  const attempted = useRef(false);

  useEffect(() => {
    // undefined = still loading store config, null = no LIFF configured
    if (liffId === undefined || liffId === null) return;
    if (attempted.current) return;
    attempted.current = true;

    (async () => {
      setState("initializing");

      // Save path before liff.init() — the SDK may change it via history.replaceState
      // (e.g., processing liff.state encoded inside the OAuth state parameter)
      const pathBefore = window.location.pathname;

      const initialized = await initLiff(liffId);

      // Check if liff.init() changed the URL (processed liff.state)
      const pathAfter = window.location.pathname;
      const urlChanged = pathAfter !== pathBefore;

      if (!initialized) {
        if (tokenStorage.get()) {
          setState("success");
        } else {
          setState("failed");
        }
        if (urlChanged) {
          window.location.replace(window.location.href);
        }
        return;
      }

      if (!isInLiffBrowser()) {
        if (tokenStorage.get()) {
          setState("success");
        } else {
          setState("not-in-liff");
        }
        if (urlChanged) {
          window.location.replace(window.location.href);
        }
        return;
      }

      // In LIFF browser — authenticate to create customer_line BEFORE redirecting

      const accessToken = getLiffAccessToken();
      if (!accessToken) {
        setState("failed");
        if (urlChanged) {
          window.location.replace(window.location.href);
        }
        return;
      }

      // Save LIFF access token for messages page (can't call liff.init() there without causing redirect loop)
      sessionStorage.setItem("liff_access_token", accessToken);

      setState("authenticating");

      try {
        const res = await fetch(`${API_BASE_URL}/api/customer/auth/liff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            liff_access_token: accessToken,
            store_id: getStoreId(),
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.token) {
            tokenStorage.set(data.token);
            if (data.isNewUser) {
              // Persist needs-phone-match across redirect
              sessionStorage.setItem("liff_needs_phone_match", "1");
              setState("needs-phone-match");
            } else {
              setState("success");
            }
          } else {
            setState("failed");
          }
        } else {
          setState("failed");
        }
      } catch {
        setState("failed");
      }

      // After auth is complete, redirect if URL changed
      if (urlChanged) {
        window.location.replace(window.location.href);
      }
    })();
  }, [liffId]);

  return state;
}
