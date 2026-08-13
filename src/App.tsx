import type { ReactNode } from 'react'
import { BrowserRouter, HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { SessionProvider, useSession } from './hooks/useSession'
import { Calendar } from './pages/Calendar'
import { Checkout } from './pages/Checkout'
import { CustomerDetail } from './pages/CustomerDetail'
import { CustomerForm } from './pages/CustomerForm'
import { Customers } from './pages/Customers'
import { Dashboard } from './pages/Dashboard'
import { KarteNew } from './pages/KarteNew'
import { Login } from './pages/Login'
import { Messages } from './pages/Messages'
import { Receipt } from './pages/Receipt'
import { RegisterClose } from './pages/RegisterClose'
import { Reports } from './pages/Reports'
import { ReservationDetail } from './pages/ReservationDetail'
import { ReservationNew } from './pages/ReservationNew'
import { Settings } from './pages/Settings'
import { Booking } from './pages/booking/Booking'
import { BookingManage } from './pages/booking/BookingManage'
import { Counseling } from './pages/booking/Counseling'

function Protected({ children }: { children: ReactNode }) {
  const { user } = useSession()
  if (!user) return <Navigate to="/login" replace />
  return <AppShell>{children}</AppShell>
}

/** 認証必須だがナビゲーションを持たない画面（印刷用など） */
function ProtectedBare({ children }: { children: ReactNode }) {
  const { user } = useSession()
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

// 静的ホスティングでのデモ配信時のみハッシュルーティングを使用（本番はBrowserRouter）
const Router = import.meta.env.VITE_DEMO_HASH_ROUTER === '1' ? HashRouter : BrowserRouter

export function App() {
  return (
    <SessionProvider>
      <Router>
        <Routes>
          {/* S-01 */}
          <Route path="/login" element={<Login />} />

          {/* 顧客向け公開ページ C-01〜C-03 */}
          <Route path="/booking" element={<Booking />} />
          <Route path="/booking/counseling" element={<Counseling />} />
          <Route path="/booking/manage" element={<BookingManage />} />

          {/* スタッフ向け S-02〜S-12 */}
          <Route path="/" element={<Protected><Dashboard /></Protected>} />
          <Route path="/calendar" element={<Protected><Calendar /></Protected>} />
          <Route path="/reservations/new" element={<Protected><ReservationNew /></Protected>} />
          <Route path="/reservations/:id" element={<Protected><ReservationDetail /></Protected>} />
          <Route path="/customers" element={<Protected><Customers /></Protected>} />
          <Route path="/customers/new" element={<Protected><CustomerForm /></Protected>} />
          <Route path="/customers/:id" element={<Protected><CustomerDetail /></Protected>} />
          <Route path="/customers/:id/edit" element={<Protected><CustomerForm /></Protected>} />
          <Route path="/customers/:id/karte/new" element={<Protected><KarteNew /></Protected>} />
          <Route path="/checkout" element={<Protected><Checkout /></Protected>} />
          <Route path="/receipts/:id" element={<ProtectedBare><Receipt /></ProtectedBare>} />
          <Route path="/register-close" element={<Protected><RegisterClose /></Protected>} />
          <Route path="/messages" element={<Protected><Messages /></Protected>} />
          <Route path="/reports" element={<Protected><Reports /></Protected>} />
          <Route path="/settings" element={<Protected><Settings /></Protected>} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </SessionProvider>
  )
}
