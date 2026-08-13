import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionUser, Staff } from '../lib/domain/types'
import { salon, staffList } from '../lib/api/store'
import { getSupabase, isSupabaseConfigured } from '../lib/supabase/client'

interface SessionContextValue {
  user: SessionUser | null
  login: (staffId: string) => void
  /** リモート接続時: Supabase Auth で確立した staff 行からセッションを張る */
  loginWithStaff: (staff: Staff) => void
  logout: () => void
}

const SessionContext = createContext<SessionContextValue | null>(null)
const STORAGE_KEY = 'beautiy.session'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as SessionUser) : null
  })

  const login = useCallback((staffId: string) => {
    const staff = staffList.find((s) => s.id === staffId)
    if (!staff) return
    const session: SessionUser = {
      staffId: staff.id,
      name: staff.name,
      role: staff.role,
      salonName: salon.name,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    setUser(session)
  }, [])

  const loginWithStaff = useCallback((staff: Staff) => {
    const session: SessionUser = {
      staffId: staff.id,
      name: staff.name,
      role: staff.role,
      salonName: salon.name,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    setUser(session)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    if (isSupabaseConfigured) {
      void getSupabase().auth.signOut()
    }
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ user, login, loginWithStaff, logout }),
    [user, login, loginWithStaff, logout],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within SessionProvider')
  return ctx
}
