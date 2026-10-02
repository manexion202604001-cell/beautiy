"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Store, Check, X } from "lucide-react";
import { invitations } from "@/lib/api";
import { useStore } from "@/contexts/store-context";

export function InvitationBanner() {
  const { pendingInvitations, refreshStores } = useStore();
  const [processing, setProcessing] = useState<string | null>(null);

  if (pendingInvitations.length === 0) return null;

  const handleAccept = async (id: string) => {
    setProcessing(id);
    try {
      await invitations.accept(id);
      await refreshStores();
    } catch (error) {
      console.error("Failed to accept:", error);
    } finally {
      setProcessing(null);
    }
  };

  const handleReject = async (id: string) => {
    if (!confirm("この招待を辞退しますか？")) return;
    setProcessing(id);
    try {
      await invitations.reject(id);
      await refreshStores();
    } catch (error) {
      console.error("Failed to reject:", error);
    } finally {
      setProcessing(null);
    }
  };

  return (
    <div className="space-y-3 mb-6">
      {pendingInvitations.map((inv) => (
        <Card key={inv.id} className="border-primary/30 bg-primary/5">
          <CardContent className="py-3 px-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <Store className="h-5 w-5 text-primary shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">
                    {inv.store_name}から招待が届いています
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {inv.invited_by_name}さんから招待
                  </p>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleReject(inv.id)}
                  disabled={processing === inv.id}
                >
                  <X className="h-4 w-4" />
                  <span className="hidden sm:inline ml-1">辞退</span>
                </Button>
                <Button
                  size="sm"
                  onClick={() => handleAccept(inv.id)}
                  disabled={processing === inv.id}
                >
                  <Check className="h-4 w-4" />
                  <span className="hidden sm:inline ml-1">参加</span>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
