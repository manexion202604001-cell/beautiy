import { useSyncExternalStore } from 'react'
import { getVersion, subscribe } from '../lib/api/store'

/**
 * モックストアの変更を購読する。セレクタは毎レンダー評価される軽量前提。
 * Supabase 移行時は Realtime 購読 + React Query 等に置き換える。
 */
export function useStoreVersion(): number {
  return useSyncExternalStore(subscribe, getVersion)
}
