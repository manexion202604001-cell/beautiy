"use client";

import { useState, useEffect } from "react";
import { Store } from "lucide-react";
import { customers, type CrossStoreMatch } from "@/lib/api";

type Props = {
  phone: string | null | undefined;
  excludeStoreId: string;
};

export function CrossStoreNotice({ phone, excludeStoreId }: Props) {
  const [matches, setMatches] = useState<CrossStoreMatch[]>([]);

  useEffect(() => {
    if (!phone) return;
    customers
      .crossStoreMatches(phone, excludeStoreId)
      .then((data) => setMatches(data.matches))
      .catch(() => setMatches([]));
  }, [phone, excludeStoreId]);

  if (!phone || matches.length === 0) return null;

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 space-y-1">
      <div className="flex items-center gap-1.5 text-sm font-medium text-blue-800">
        <Store className="h-4 w-4" />
        他店舗にも登録あり
      </div>
      <div className="space-y-1">
        {matches.map((m) => (
          <div key={m.customer_id} className="text-xs text-blue-700">
            {m.store_name}: {m.customer_name}
            {m.visit_count > 0 && `（来店${m.visit_count}回）`}
          </div>
        ))}
      </div>
    </div>
  );
}
