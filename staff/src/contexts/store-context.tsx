"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { auth, type Staff } from "@/lib/api";

type StoreInfo = {
  id: string;
  name: string;
  is_primary: number;
  line_friend_url: string | null;
};

type StoreInvitation = {
  id: string;
  store_id: string;
  store_name: string;
  invited_by_name: string;
  role: string;
  created_at: string;
};

type StoreContextType = {
  currentStore: StoreInfo | null;
  stores: StoreInfo[];
  staff: Staff | null;
  pendingInvitations: StoreInvitation[];
  setCurrentStore: (store: StoreInfo) => void;
  isLoading: boolean;
  refreshStores: () => Promise<void>;
};

const STORE_KEY = "staff_current_store_id";

const StoreContext = createContext<StoreContextType | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [currentStore, setCurrentStoreState] = useState<StoreInfo | null>(null);
  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [staff, setStaff] = useState<Staff | null>(null);
  const [pendingInvitations, setPendingInvitations] = useState<StoreInvitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refreshStores = useCallback(async () => {
    try {
      const { staff: staffData, stores: storesData, pending_invitations } = await auth.me();
      setStaff(staffData);
      setStores(storesData || []);
      setPendingInvitations(pending_invitations || []);

      const savedStoreId = typeof window !== "undefined" ? localStorage.getItem(STORE_KEY) : null;

      if (storesData && storesData.length > 0) {
        const savedStore = savedStoreId ? storesData.find((s) => s.id === savedStoreId) : null;
        const primaryStore = storesData.find((s) => s.is_primary) || storesData[0];
        setCurrentStoreState(savedStore || primaryStore);
      }
    } catch (error) {
      console.error("Failed to fetch stores:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshStores();
  }, [refreshStores]);

  const setCurrentStore = useCallback((store: StoreInfo) => {
    setCurrentStoreState(store);
    if (typeof window !== "undefined") {
      localStorage.setItem(STORE_KEY, store.id);
    }
  }, []);

  return (
    <StoreContext.Provider
      value={{
        currentStore,
        stores,
        staff,
        pendingInvitations,
        setCurrentStore,
        isLoading,
        refreshStores,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const context = useContext(StoreContext);
  if (context === undefined) {
    throw new Error("useStore must be used within a StoreProvider");
  }
  return context;
}
