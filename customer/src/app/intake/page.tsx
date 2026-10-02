"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { API_BASE_URL } from "@/lib/api";
import { Loader2, UserPlus, RotateCcw, FileText } from "lucide-react";
import liff from "@line/liff";

export default function IntakePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#b8936a] border-t-transparent" />
        </div>
      }
    >
      <IntakePageInner />
    </Suspense>
  );
}

function IntakePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [resolvedStaffId, setResolvedStaffId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [customerExists, setCustomerExists] = useState(false);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [hasConsent, setHasConsent] = useState(false);
  const [isFriend, setIsFriend] = useState(true);
  const [friendUrl, setFriendUrl] = useState<string | null>(null);

  useEffect(() => {
    // Get staff_id - try multiple sources
    let staffId = searchParams.get("staff_id");
    if (!staffId) {
      // LIFF puts original query in liff.state (URL-encoded)
      const liffState = searchParams.get("liff.state");
      if (liffState) {
        const decoded = decodeURIComponent(liffState);
        const stateParams = new URLSearchParams(decoded.startsWith("?") ? decoded : `?${decoded}`);
        staffId = stateParams.get("staff_id");
      }
    }
    if (!staffId) {
      // Fallback: search full URL
      const match = window.location.href.match(/staff_id[=%3D]+([^&#%]+)/i);
      if (match) staffId = decodeURIComponent(match[1]);
    }

    // Save to sessionStorage if found, or restore from it
    if (staffId) {
      sessionStorage.setItem("intake_staff_id", staffId);
    } else {
      staffId = sessionStorage.getItem("intake_staff_id");
    }

    if (!staffId) {
      setError("スタッフIDが指定されていません");
      setLoading(false);
      return;
    }
    setResolvedStaffId(staffId);

    (async () => {
      try {
        // Check for existing session in URL
        const existingSession = searchParams.get("session_id");
        if (existingSession) {
          const res = await fetch(`${API_BASE_URL}/api/public/intake/${existingSession}`);
          if (res.ok) {
            const data = await res.json();
            setSessionId(existingSession);
            setStoreId(data.session.store_id);
            setCustomerExists(!!data.session.customer_id);
            setLoading(false);
            return;
          }
        }

        // Initialize LIFF
        // Determine LIFF ID from URL or known mapping
        // LINE login channel client_id -> LIFF ID (one entry per store/environment).
        // Configure via NEXT_PUBLIC_INTAKE_LIFF_MAP as JSON: {"<client_id>":"<liff_id>", ...}
        let LIFF_MAP: Record<string, string> = {};
        try {
          LIFF_MAP = JSON.parse(process.env.NEXT_PUBLIC_INTAKE_LIFF_MAP || "{}");
        } catch {
          console.error("[Intake] NEXT_PUBLIC_INTAKE_LIFF_MAP is not valid JSON");
        }
        const urlParams = new URLSearchParams(window.location.search);
        // Check client_id, liffClientId, or saved value
        const clientId = urlParams.get("client_id") || urlParams.get("liffClientId") || sessionStorage.getItem("intake_liff_client_id") || "";
        if (clientId) {
          sessionStorage.setItem("intake_liff_client_id", clientId);
        }
        const liffId = LIFF_MAP[clientId] || process.env.NEXT_PUBLIC_INTAKE_DEFAULT_LIFF_ID || "";

        try {
          await liff.init({ liffId });
        } catch (e) {
          console.error("LIFF init error:", e);
          // May already be initialized
        }

        // Wait for login if needed
        if (!liff.isLoggedIn()) {
          liff.login();
          return;
        }

        const accessToken = liff.getAccessToken();
        if (!accessToken) {
          setError("LINEでログインしてください");
          setLoading(false);
          return;
        }

        // Check friendship
        try {
          const friendship = await liff.getFriendship();
          setIsFriend(friendship.friendFlag);
        } catch {
          // If fails, assume friend (getFriendship requires linked official account)
          setIsFriend(true);
        }

        // Initialize intake session
        const res = await fetch(`${API_BASE_URL}/api/public/intake/init`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            liff_access_token: accessToken,
            staff_id: staffId,
          }),
        });

        if (!res.ok) {
          const err = await res.json();
          setError(err.error || "初期化に失敗しました");
          setLoading(false);
          return;
        }

        const data = await res.json();
        setSessionId(data.session_id);
        setStoreId(data.store_id);
        setCustomerExists(data.customer_exists);
        setCustomerName(data.customer_name);
        setHasConsent(data.has_consent);
        setFriendUrl(data.line_friend_url);
        setLoading(false);
      } catch (err) {
        console.error("Intake init error:", err);
        setError("初期化に失敗しました");
        setLoading(false);
      }
    })();
  }, [searchParams]);

  const handleSelectType = async (type: "new" | "returning") => {
    if (!sessionId) return;

    try {
      await fetch(`${API_BASE_URL}/api/public/intake/${sessionId}/type`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });

      // Pass friend_url if user needs to add friend after completion (blocked case)
      const needsFriendAdd = !isFriend && friendUrl;
      const friendParam = needsFriendAdd ? `&friend_url=${encodeURIComponent(friendUrl)}` : "";

      if (type === "new") {
        router.push(`/intake/new?session_id=${sessionId}&store_id=${storeId}${friendParam}`);
      } else {
        // Returning: skip name input, go to consent
        router.push(`/consent?intake_session_id=${sessionId}&store_id=${storeId}${friendParam}`);
      }
    } catch (err) {
      console.error("Type selection error:", err);
      setError("エラーが発生しました");
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-8 w-8 animate-spin text-[#b8936a]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-red-500">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Returning customer
  if (customerExists && customerName) {
    // Already has consent → show consent confirmation
    if (hasConsent) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
          <Card className="w-full max-w-md">
            <CardContent className="pt-6 space-y-4 text-center">
              <h2 className="text-lg font-bold">ようこそ {customerName}様</h2>
              <p className="text-sm text-gray-500">
                同意書のご確認をお願いいたします
              </p>
              <Button
                onClick={() => handleSelectType("returning")}
                className="w-full h-14 text-base bg-[#b8936a] hover:bg-[#a68059]"
              >
                <FileText className="h-5 w-5 mr-2" />
                同意書の確認
              </Button>
            </CardContent>
          </Card>
        </div>
      );
    }

    // No consent yet → go to consent first
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 space-y-4 text-center">
            <h2 className="text-lg font-bold">ようこそ {customerName}様</h2>
            <p className="text-sm text-gray-500">
              同意書のご記入にご協力ください
            </p>
            <Button
              onClick={() => handleSelectType("returning")}
              className="w-full h-14 text-base bg-[#b8936a] hover:bg-[#a68059]"
            >
              <FileText className="h-5 w-5 mr-2" />
              同意書を書く
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // New customer: show type selection
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6 space-y-4">
          <h2 className="text-lg font-bold text-center">ようこそ</h2>
          <p className="text-sm text-gray-500 text-center">
            当サロンのご利用は初めてですか？
          </p>

          <div className="space-y-3 pt-2">
            <Button
              onClick={() => handleSelectType("new")}
              className="w-full h-16 text-base bg-[#b8936a] hover:bg-[#a68059]"
            >
              <UserPlus className="h-5 w-5 mr-2" />
              初めての方（新規）
            </Button>

            <Button
              onClick={() => handleSelectType("returning")}
              variant="outline"
              className="w-full h-16 text-base border-[#b8936a] text-[#b8936a] hover:bg-[#b8936a]/10"
            >
              <RotateCcw className="h-5 w-5 mr-2" />
              以前ご利用の方（リピーター）
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
