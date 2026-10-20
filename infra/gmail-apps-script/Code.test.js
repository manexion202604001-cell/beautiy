// node --test infra/gmail-apps-script/Code.test.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const m = new Module(path.join(__dirname, 'Code.gs'));
m.paths = module.paths;
m._compile(require('node:fs').readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), path.join(__dirname, 'Code.gs'));
const { tagOf, parseRoutes, routeFor, routeBySender, webhookBody, remember } = m.exports;

const URL = 'https://salon-os-web.onrender.com/v1/webhooks/inbound_email/abcdefghijklmnopqrstuvwx';

test('finds the shop from the +tag of the recipient', () => {
  assert.equal(tagOf('fein.yoyaku+omotesando@gmail.com'), 'omotesando');
  assert.equal(tagOf('"予約" <fein.yoyaku+Omotesando@gmail.com>'), 'omotesando');
  assert.equal(tagOf('fein.yoyaku@gmail.com, fein.yoyaku+aoyama@gmail.com'), 'aoyama');
  assert.equal(tagOf('fein.yoyaku@gmail.com'), null);
  assert.equal(tagOf(''), null);
});

test('routes only to Salon OS inbound URLs', () => {
  const routes = parseRoutes(JSON.stringify({ omotesando: URL }));
  assert.equal(routeFor(routes, 'omotesando'), URL);
  assert.equal(routeFor(routes, 'aoyama'), null);
  assert.equal(routeFor(routes, null), null);
  assert.throws(() => parseRoutes(''), /ROUTES/);
  assert.throws(() => parseRoutes(JSON.stringify({ a: 'https://evil.example/collect' })));
});

test('builds the webhook body and keeps a bounded list of sent mails', () => {
  assert.deepEqual(
    webhookBody({ from: 'SALON BOARD <noreply@salonboard.com>', to: 'x+omotesando@gmail.com', subject: '【SALON BOARD】予約連絡', text: '予約番号：BE1', html: '<p>x</p>', messageId: '<m1@x>', date: new Date('2026-10-19T00:00:00Z') }),
    { from: 'SALON BOARD <noreply@salonboard.com>', to: 'x+omotesando@gmail.com', subject: '【SALON BOARD】予約連絡', text: '予約番号：BE1', html: '<p>x</p>', messageId: '<m1@x>', date: '2026-10-19T00:00:00.000Z' },
  );
  let done = [];
  for (let i = 0; i < 3005; i++) done = remember(done, `id${i}`);
  assert.equal(done.length, 3000);
  assert.equal(done[0], 'id5');
  assert.equal(done.at(-1), 'id3004');
});

test('routes mails without a +tag by sender (minimo stores the address without it)', () => {
  const MIN = URL.replace('abcdefghijklmnopqrstuvwx', 'minimominimominimomini12');
  const one = { omotesando: URL, 'minimo-omotesando': MIN };
  assert.equal(routeBySender(one, {}, 'minimo <noreply@minimodel.jp>', '予約が入りました'), MIN);
  assert.equal(routeBySender(one, {}, 'someone@example.com', '表参道'), null);
  const two = { ...one, 'minimo-aoyama': URL.replace('abcdefghijklmnopqrstuvwx', 'aoyamaaoyamaaoyamaaoya12') };
  assert.equal(routeBySender(two, {}, 'noreply@minimodel.jp', 'x'), null);
  const shops = { 'minimodel.jp': { 表参道: 'minimo-omotesando', 青山: 'minimo-aoyama' } };
  assert.equal(routeBySender(two, shops, 'noreply@mail.minimodel.jp', 'fein.表参道店 様'), MIN);
});
