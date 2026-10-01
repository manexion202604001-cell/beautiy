import nodemailer from 'nodemailer';
import { config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** In-memory outbox for the mock driver (inspected by tests / dev tooling) */
export const mockOutbox: MailMessage[] = [];

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;

export async function sendEmail(msg: MailMessage): Promise<{ id: string }> {
  if (config.EMAIL_DRIVER === 'mock') {
    mockOutbox.push(msg);
    if (mockOutbox.length > 200) mockOutbox.shift();
    if (config.NODE_ENV === 'development') console.info(`[mail:mock] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
    return { id: `mock-${Date.now()}-${mockOutbox.length}` };
  }
  transport ??= nodemailer.createTransport(process.env.SMTP_URL ?? 'smtp://localhost:1025');
  const info = await transport.sendMail({ from: process.env.MAIL_FROM ?? 'no-reply@salon-os.local', ...msg });
  return { id: info.messageId };
}

export interface SmsMessage {
  to: string;
  text: string;
}

export const mockSmsOutbox: SmsMessage[] = [];

/** SMS adapter (mock by default; live driver expects an HTTP gateway at SMS_GATEWAY_URL) */
export async function sendSms(msg: SmsMessage): Promise<{ id: string }> {
  if (config.SMS_DRIVER === 'mock') {
    mockSmsOutbox.push(msg);
    if (mockSmsOutbox.length > 200) mockSmsOutbox.shift();
    if (config.NODE_ENV === 'development') console.info(`[sms:mock] to=${msg.to} ${msg.text}`);
    return { id: `mock-sms-${Date.now()}` };
  }
  const url = process.env.SMS_GATEWAY_URL;
  if (!url) throw new Error('SMS_GATEWAY_URL is not configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SMS_GATEWAY_TOKEN ?? ''}` },
    body: JSON.stringify(msg),
  });
  if (!res.ok) throw new Error(`SMS gateway error ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return { id: body.id ?? `sms-${Date.now()}` };
}
