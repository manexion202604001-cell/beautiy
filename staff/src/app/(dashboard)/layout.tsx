"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { MobileHeader } from "@/components/mobile-header";
import { BottomNav } from "@/components/bottom-nav";
import { InvitationBanner } from "@/components/invitation-banner";
import { tokenStorage } from "@/lib/api";
import { StoreProvider, useStore } from "@/contexts/store-context";

function DashboardContent({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { staff, isLoading } = useStore();
  const [tokenChecked, setTokenChecked] = useState(false);

  useEffect(() => {
    const token = tokenStorage.get();
    if (!token) {
      router.push("/login");
      return;
    }
    setTokenChecked(true);
  }, [router]);

  useEffect(() => {
    if (!isLoading && !staff && tokenChecked) {
      router.push("/login");
    }
  }, [isLoading, staff, tokenChecked, router]);

  // Register service worker for push notifications
  useEffect(() => {
    if (!staff) return;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.error("SW registration failed:", err);
      });
    }
  }, [staff]);

  // プッシュ通知タップ時、SW からの遷移依頼（アプリ起動中）を受けてクライアント側で遷移
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "notification-navigate" && event.data.url) {
        router.push(event.data.url);
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, [router]);

  if (isLoading || !tokenChecked) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  if (!staff) {
    return null;
  }

  return (
    <div className="flex h-screen flex-col md:flex-row">
      <MobileHeader staff={staff} />
      <Sidebar staff={staff} />
      <main className="flex-1 overflow-auto bg-muted/30 pb-20 md:pb-0">
        <div className="p-4 md:p-6">
          <InvitationBanner />
          {children}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <StoreProvider>
      <DashboardContent>{children}</DashboardContent>
    </StoreProvider>
  );
}
