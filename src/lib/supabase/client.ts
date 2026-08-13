/**
 * Supabase クライアント（本番接続の入口）。
 *
 * .env.local に VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を設定すると
 * isSupabaseConfigured が true になり、リポジトリ層を実DB実装へ切り替える準備が整う。
 * 未設定の間はローカル永続化モード（lib/api/store）で動作する。
 *
 * 注意: anon key のみを使用する。service_role キーは Edge Functions 内でのみ
 * 使用し、クライアントコードへ絶対に含めない（CLAUDE.md セキュリティ規約）。
 */
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured: boolean = Boolean(url && anonKey)

let client: SupabaseClient | null = null

/** 設定済みの場合のみクライアントを返す。未設定で呼ぶとエラー */
export function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured) {
    throw new Error(
      'Supabase未設定です。.env.local に VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を設定してください。',
    )
  }
  if (!client) {
    client = createClient(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  }
  return client
}
