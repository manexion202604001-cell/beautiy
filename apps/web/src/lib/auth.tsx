import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { authApi } from '../api/auth';
import { useShops } from '../api/org';
import type { LoginResult, Me, Shop, TokenPair } from '../api/types';
import { getLastRefreshFailure, refreshAccessToken, setSessionExpiredHandler } from './api';
import { session } from './session';

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'unreachable';

interface AuthContextValue {
  status: AuthStatus;
  /** retry restoring the session after a transient failure (network / rate limit) */
  retrySession: () => void;
  me: Me | undefined;
  meLoading: boolean;
  /** permission check (`can('customer.write')`) */
  can: (permission: string) => boolean;
  login: (email: string, password: string, organizationId?: string) => Promise<LoginResult>;
  verifyMfa: (challengeId: string, code: string) => Promise<void>;
  acceptTokens: (pair: TokenPair) => void;
  logout: () => Promise<void>;
  switchOrganization: (organizationId: string) => Promise<void>;
  shops: Shop[];
  currentShop: Shop | null;
  currentShopId: string | null;
  setCurrentShopId: (id: string) => void;
  timezone: string;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function useSessionSnapshot() {
  return useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  useSessionSnapshot();
  const [booting, setBooting] = useState(
    () => !session.getAccessToken() && !!session.getRefreshToken(),
  );
  const [unreachable, setUnreachable] = useState(false);

  // restore a session from the stored refresh token on first load
  useEffect(() => {
    if (!booting) return;
    let cancelled = false;
    void refreshAccessToken().then((token) => {
      if (cancelled) return;
      // keep the stored session when the API was just unreachable / rate limited
      setUnreachable(
        !token && getLastRefreshFailure() === 'transient' && !!session.getRefreshToken(),
      );
      setBooting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [booting]);

  const retrySession = useCallback(() => {
    setUnreachable(false);
    setBooting(true);
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      qc.clear();
    });
    return () => setSessionExpiredHandler(null);
  }, [qc]);

  const hasToken = !!session.getAccessToken();
  const status: AuthStatus = booting
    ? 'loading'
    : hasToken
      ? 'authenticated'
      : unreachable
        ? 'unreachable'
        : 'anonymous';

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: authApi.me,
    enabled: status === 'authenticated',
    staleTime: 5 * 60_000,
  });
  const me = meQuery.data;
  const shopsQuery = useShops(status === 'authenticated');
  const shops = useMemo(() => shopsQuery.data ?? [], [shopsQuery.data]);

  const storedShopId = session.getShopId();
  const currentShop = useMemo(() => {
    if (!shops.length) return null;
    return (
      shops.find((s) => s.id === storedShopId) ??
      shops.find((s) => me?.shopIds.includes(s.id)) ??
      shops[0] ??
      null
    );
  }, [shops, storedShopId, me]);

  // persist the resolved shop (first load / shop removed)
  useEffect(() => {
    if (currentShop && currentShop.id !== storedShopId) session.setShopId(currentShop.id);
  }, [currentShop, storedShopId]);

  const permissions = useMemo(() => new Set(me?.permissions ?? []), [me]);
  const can = useCallback((p: string) => permissions.has(p), [permissions]);

  const acceptTokens = useCallback(
    (pair: TokenPair) => {
      qc.removeQueries({ queryKey: ['me'] });
      session.setTokens(pair.accessToken, pair.refreshToken);
    },
    [qc],
  );

  const login = useCallback(
    async (email: string, password: string, organizationId?: string) => {
      const result = await authApi.login(email, password, organizationId);
      if (result.status === 'authenticated') {
        qc.clear();
        acceptTokens(result);
      }
      return result;
    },
    [acceptTokens, qc],
  );

  const verifyMfa = useCallback(
    async (challengeId: string, code: string) => {
      const pair = await authApi.verifyOtp(challengeId, code);
      qc.clear();
      acceptTokens(pair);
    },
    [acceptTokens, qc],
  );

  const logout = useCallback(async () => {
    const rt = session.getRefreshToken();
    if (rt) await authApi.logout(rt).catch(() => undefined);
    session.clear();
    qc.clear();
  }, [qc]);

  const switchOrganization = useCallback(
    async (organizationId: string) => {
      const pair = await authApi.switchOrganization(organizationId);
      session.setShopId(null);
      qc.clear();
      acceptTokens(pair);
    },
    [acceptTokens, qc],
  );

  const setCurrentShopId = useCallback(
    (id: string) => {
      session.setShopId(id);
      // shop-scoped data must refetch with the new X-Shop-Id
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] !== 'me' && q.queryKey[0] !== 'shops',
      });
    },
    [qc],
  );

  const value: AuthContextValue = {
    status,
    retrySession,
    me,
    meLoading: meQuery.isLoading,
    can,
    login,
    verifyMfa,
    acceptTokens,
    logout,
    switchOrganization,
    shops,
    currentShop,
    currentShopId: currentShop?.id ?? null,
    setCurrentShopId,
    timezone: currentShop?.timezone ?? me?.organization.timezone ?? 'Asia/Tokyo',
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Current shop id (throws away null handling for pages rendered inside the guarded layout) */
export function useCurrentShop() {
  const { currentShop, currentShopId, timezone } = useAuth();
  return { shop: currentShop, shopId: currentShopId, timezone };
}

export function useCan() {
  return useAuth().can;
}
