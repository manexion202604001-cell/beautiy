// n8n → 本システム 受信ゲートウェイ (F-09-06)
// APIキー認証付き。LINEメッセージ受信の保存、Web予約フォーム等の外部書き込みを受ける。
// デプロイ: supabase functions deploy n8n-gateway --no-verify-jwt
// 環境変数: N8N_GATEWAY_KEY（supabase secrets set N8N_GATEWAY_KEY=...）

import { createClient } from 'npm:@supabase/supabase-js@2'

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }
  const apiKey = req.headers.get('x-api-key')
  if (!apiKey || apiKey !== Deno.env.get('N8N_GATEWAY_KEY')) {
    return new Response('unauthorized', { status: 401 })
  }

  // service_role はこの Edge Function 内でのみ使用（クライアントへは絶対に出さない）
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const payload = await req.json()

  switch (payload.type) {
    // n8n が受信した LINE メッセージを履歴として保存
    case 'line_message': {
      const { tenant_id, thread_id, body } = payload
      const { error } = await supabase.from('messages').insert({
        tenant_id,
        thread_id,
        sender: 'customer',
        body,
        read: false,
      })
      if (error) return json({ ok: false, error: error.message }, 500)
      await supabase
        .from('message_threads')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', thread_id)
      return json({ ok: true })
    }
    // 顧客事前記入カウンセリングシートの保存（公開フォーム → n8n → 本Function）
    case 'counseling_response': {
      const { tenant_id, form_id, customer_id, reservation_id, answers } = payload
      const { error } = await supabase.from('counseling_responses').insert({
        tenant_id,
        form_id,
        customer_id,
        reservation_id,
        answers,
      })
      if (error) return json({ ok: false, error: error.message }, 500)
      return json({ ok: true })
    }
    default:
      return json({ ok: false, error: `unknown type: ${payload.type}` }, 400)
  }
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
