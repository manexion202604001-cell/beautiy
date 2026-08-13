import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Field, Input } from '../components/ui'
import { useSession } from '../hooks/useSession'
import { initRemote } from '../lib/api/remote'
import { staffList } from '../lib/api/store'
import { getSupabase, isSupabaseConfigured } from '../lib/supabase/client'

/** S-01 ログイン（Supabase接続時: メール+パスワード認証 / 未接続時: デモログイン） */
export function Login() {
  const { login, loginWithStaff } = useSession()
  const navigate = useNavigate()
  const [staffId, setStaffId] = useState(staffList[0].id)
  const [email, setEmail] = useState(isSupabaseConfigured ? '' : 'demo@beautiy.jp')
  const [password, setPassword] = useState(isSupabaseConfigured ? '' : 'password')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError('')
    if (!isSupabaseConfigured) {
      login(staffId)
      navigate('/')
      return
    }
    setBusy(true)
    try {
      const { error: authError } = await getSupabase().auth.signInWithPassword({ email, password })
      if (authError) {
        setError('メールアドレスまたはパスワードが正しくありません')
        return
      }
      const staff = await initRemote()
      if (!staff) {
        setError('サインインに失敗しました。もう一度お試しください。')
        return
      }
      loginWithStaff(staff)
      navigate('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ログインに失敗しました')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-night px-6">
      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <h1 className="font-display text-[34px] tracking-[0.34em] text-paper-warm">BEAUTIY</h1>
          <p className="mt-2 text-[10px] uppercase tracking-[0.3em] text-gold">
            Karte · Reservation · POS
          </p>
          <div className="mx-auto mt-6 h-px w-10 bg-gold/60" />
        </div>

        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Field label="メールアドレス">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="border-white/15 bg-night-soft text-paper-warm"
              autoComplete="username"
            />
          </Field>
          <Field label="パスワード">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="border-white/15 bg-night-soft text-paper-warm"
              autoComplete="current-password"
            />
          </Field>
          {!isSupabaseConfigured ? (
            <Field label="スタッフ（デモ切替）">
              <select
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                className="w-full rounded-md border border-white/15 bg-night-soft px-3 py-2.5 text-[14px] text-paper-warm focus:border-gold focus:outline-none"
              >
                {staffList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {roleLabel(s.role)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {error ? (
            <p className="rounded-md bg-clay-tint px-4 py-3 text-[13px] text-clay">{error}</p>
          ) : null}
          <Button
            type="submit"
            disabled={busy}
            className="w-full !bg-gold !text-night hover:!bg-gold-deep hover:!text-paper-warm"
          >
            {busy ? 'サインイン中…' : 'サインイン'}
          </Button>
          <p className="text-center text-[11px] leading-relaxed text-paper-warm/40">
            {isSupabaseConfigured
              ? 'Supabase Auth（メール + パスワード）で認証します。'
              : 'デモ環境のため任意の資格情報でサインインできます。'}
          </p>
        </form>
      </div>
    </div>
  )
}

export function roleLabel(role: string): string {
  return (
    {
      owner: 'オーナー',
      manager: '店長',
      stylist: 'スタイリスト',
      assistant: 'アシスタント',
      freelance: 'フリーランス',
    }[role] ?? role
  )
}
