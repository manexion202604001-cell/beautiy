/**
 * 「ID確認」: a staff member who wants booking notifications on LINE (スタッフ編集 › LINE通知) needs
 * their LINE User ID, which the LINE app does not show. Sending the text 「ID確認」 to the shop's
 * official account answers with it.
 */
import { enqueue, registerJob } from '../../jobs/queue.js';
import { onEvent } from '../../lib/events.js';
import { channelById } from './channels.js';
import { linePush, textMessage } from './providers/line.js';

export const LINE_ID_CHECK_TEXT = 'ID確認';

onEvent<{ messageId: string; channel: string }>('message.received', async (ctx, event) => {
  if (event.payload.channel !== 'line') return;
  const msg = await ctx.trx
    .selectFrom('messages')
    .select(['id', 'body', 'message_type', 'recipient', 'line_channel_id'])
    .where('id', '=', event.payload.messageId)
    .executeTakeFirst();
  if (!msg || msg.message_type !== 'text' || (msg.body ?? '').trim() !== LINE_ID_CHECK_TEXT) return;
  if (!msg.recipient || !msg.line_channel_id) return;
  await enqueue(ctx, { type: 'line.id_check_reply', payload: { lineChannelId: msg.line_channel_id, userId: msg.recipient }, dedupeKey: `line-id-check:${msg.id}` });
});

registerJob<{ lineChannelId: string; userId: string }>('line.id_check_reply', async (payload, jc) => {
  const token = await jc.tx(async (ctx) => (await channelById(ctx, payload.lineChannelId))?.accessToken() ?? null);
  if (!token) return;
  const text = `あなたの LINE User ID は次のとおりです。\n${payload.userId}\n\nスタッフ編集の「LINE User ID」に登録すると、新規予約の通知をこのLINEで受け取れます。`;
  await linePush(token, payload.userId, [textMessage(text)], jc.job.id);
});
