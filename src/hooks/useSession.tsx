import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionUser } from '../lib/domain/types'
import { salon, staffList } from '../lib/api/store'

interface SessionContextValue {
  user: SessionUser | null
  login: (staffId: string) => void
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

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setUser(null)
  }, [])

  const value = useMemo(() => ({ user, login, logout }), [user, login, logout])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within SessionProvider')
  return ctx
}
