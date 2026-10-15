import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRoutes, routeFor, webhookBody } from './forward.js';

const URL = 'https://salon.example.jp/v1/webhooks/inbound_email/abcdefghijklmnopqrstuvwx';

test('routes by the local part of the recipient', () => {
  const routes = { 'hpb-omotesando': URL };
  assert.equal(routeFor(routes, 'hpb-omotesando@in.example.jp'), URL);
  assert.equal(routeFor(routes, 'HPB-Omotesando+test@in.example.jp'), URL);
  assert.equal(routeFor(routes, 'hpb-aoyama@in.example.jp'), null);
});

test('refuses anything that is not a Salon OS inbound URL', () => {
  assert.deepEqual(parseRoutes(JSON.stringify({ a: URL })), { a: URL });
  assert.throws(() => parseRoutes(JSON.stringify({ a: 'http://salon.example.jp/v1/webhooks/inbound_email/abcdefghijklmnopqrstuvwx' })));
  assert.throws(() => parseRoutes(JSON.stringify({ a: 'https://evil.example/collect' })));
});

test('builds the body the inbound webhook understands', () => {
  const body = webhookBody(
    { from: { name: 'SALON BOARD', address: 'noreply@salonboard.com' }, subject: '【SALON BOARD】予約連絡', text: '予約番号：BE1', html: null, messageId: '<m1@x>', date: '2026-10-15T00:00:00Z' },
    { from: 'bounce@salonboard.com', to: 'hpb-omotesando@in.example.jp' },
  );
  assert.deepEqual(body, {
    from: 'SALON BOARD <noreply@salonboard.com>',
    to: 'hpb-omotesando@in.example.jp',
    subject: '【SALON BOARD】予約連絡',
    text: '予約番号：BE1',
    html: null,
    messageId: '<m1@x>',
    date: '2026-10-15T00:00:00Z',
  });
});
