import type { ChatMessage, MessageThread } from '../domain/types'
import * as db from './store'

export function listThreads(): MessageThread[] {
  return [...db.threads].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
}

export function listMessages(threadId: string): ChatMessage[] {
  return db.messages
    .filter((m) => m.threadId === threadId)
    .sort((a, b) => a.at.localeCompare(b.at))
}

export function sendMessage(threadId: string, body: string) {
  db.messages.push({
    id: db.nextId('ms'),
    threadId,
    from: 'salon',
    body,
    at: new Date().toISOString(),
    read: true,
  })
  const th = db.threads.find((t) => t.id === threadId)
  if (th) {
    th.lastMessageAt = new Date().toISOString()
    th.unread = 0
  }
  db.notify()
}

export function markRead(threadId: string) {
  const th = db.threads.find((t) => t.id === threadId)
  if (th && th.unread > 0) {
    th.unread = 0
    db.messages.forEach((m) => {
      if (m.threadId === threadId) m.read = true
    })
    db.notify()
  }
}
