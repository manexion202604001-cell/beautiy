/**
 * Salon OS — 予約お知らせメールの取り込み（Gmail + Google Apps Script）
 *
 * 予約受付専用の Gmail に届いたサロンボード / LiME の通知メールを、店舗ごとの Salon OS 受信URLへ送ります。
 * 店舗はアドレスの「+」以降で見分けます（例: fein.yoyaku+omotesando@gmail.com → "omotesando"）。
 *
 * 設定（スクリプト プロパティ）
 *   ROUTES  {"omotesando": "https://<Salon OS>/v1/webhooks/inbound_email/<表参道の連携トークン>"}
 *   SENDER_SHOPS（任意） minimo のように「+」を外して登録する媒体用。差出人ドメインと本文の店舗名で振り分ける
 *           {"minimodel.jp": {"表参道": "minimo-omotesando", "青山": "minimo-aoyama"}}
 *           店舗が1つだけなら ROUTES に "minimo-…" が1件あれば自動でそこへ送る
 * 受信URLには連携のトークンが入っているので、コードには書かずプロパティに入れてください。
 *
 * 使い方: docs/go-live.md 「D. メール受信」。setup() を一度実行すると1分ごとの実行が登録されます。
 */

// in:anywhere = the spam folder too: Gmail sometimes files the media's notifications as spam, and only
// mails to a shop's +address are sent on (they are read where they are; nothing is moved or deleted)
var SEARCH = 'newer_than:2d in:anywhere -in:trash';
var DONE_KEY = 'DONE_IDS';
var DONE_KEEP = 3000;

/** "Name <fein.yoyaku+omotesando@gmail.com>, other@x" → "omotesando" (first address with a +tag) */
function tagOf(addresses) {
  var list = String(addresses || '').split(/[,;]/);
  for (var i = 0; i < list.length; i++) {
    var m = list[i].match(/<?([^<>\s@]+)@[^<>\s]+>?\s*$/);
    if (!m) continue;
    var plus = m[1].indexOf('+');
    if (plus >= 0) return m[1].slice(plus + 1).toLowerCase();
  }
  return null;
}

function parseRoutes(json) {
  if (!json) throw new Error('スクリプト プロパティ ROUTES が未設定です');
  var routes = JSON.parse(json);
  Object.keys(routes).forEach(function (key) {
    if (!/^https:\/\/[^\/]+\/v1\/webhooks\/inbound_email\/[A-Za-z0-9_-]{16,100}$/.test(routes[key])) {
      throw new Error('ROUTES["' + key + '"] が Salon OS の受信URLではありません');
    }
  });
  return routes;
}

/**
 * Mail without a shop +tag (minimo stores the address without it): the sender's domain and a shop
 * name in the subject / body pick the route; with a single route for that medium, that one.
 */
function routeBySender(routes, senderShops, from, text) {
  var domain = (String(from || '').match(/@([\w.-]+)/) || [])[1];
  if (!domain) return null;
  domain = domain.toLowerCase();
  var medium = domain.indexOf('minimodel.jp') >= 0 || domain.indexOf('minimo') >= 0 ? 'minimo-' : null;
  var shops = null;
  Object.keys(senderShops || {}).forEach(function (d) {
    if (domain === d.toLowerCase() || domain.slice(-(d.length + 1)) === '.' + d.toLowerCase()) shops = senderShops[d];
  });
  if (shops) {
    var keys = Object.keys(shops);
    for (var i = 0; i < keys.length; i++) if (String(text || '').indexOf(keys[i]) >= 0) return routes[shops[keys[i]]] || null;
  }
  if (!medium) return null;
  var candidates = Object.keys(routes).filter(function (k) { return k.indexOf(medium) === 0; });
  return candidates.length === 1 ? routes[candidates[0]] : null;
}

function routeFor(routes, tag) {
  if (!tag) return null;
  var keys = Object.keys(routes);
  for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === tag) return routes[keys[i]];
  return null;
}

/** the JSON body Salon OS's inbound_email webhook reads (apps/api/src/modules/integrations/mail/inbound.ts) */
function webhookBody(m) {
  return {
    from: m.from || '',
    to: m.to || '',
    subject: m.subject || '',
    text: m.text || null,
    html: m.html || null,
    messageId: m.messageId || null,
    date: m.date ? new Date(m.date).toISOString() : null,
  };
}

/** keep the newest ids only, so the property stays small */
function remember(done, id) {
  done.push(id);
  return done.length > DONE_KEEP ? done.slice(done.length - DONE_KEEP) : done;
}

// ------------------------------------------------------------------ Apps Script entry points

/** Runs every minute: sends every new mail with a known +tag to its shop, once. */
function forwardNewMails() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // the previous run is still going
  try {
    var props = PropertiesService.getScriptProperties();
    var routes = parseRoutes(props.getProperty('ROUTES'));
    var senderShops = JSON.parse(props.getProperty('SENDER_SHOPS') || '{}');
    var done = JSON.parse(props.getProperty(DONE_KEY) || '[]');
    var seen = {};
    done.forEach(function (id) { seen[id] = true; });
    var threads = GmailApp.search(SEARCH, 0, 50);
    for (var t = 0; t < threads.length; t++) {
      var messages = threads[t].getMessages();
      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        var id = msg.getId();
        if (seen[id]) continue;
        var to = [msg.getHeader('Delivered-To'), msg.getTo(), msg.getCc()].join(',');
        var url = routeFor(routes, tagOf(to)) || routeBySender(routes, senderShops, msg.getFrom(), msg.getSubject() + '\n' + msg.getPlainBody());
        if (!url) {
          done = remember(done, id); // not for Salon OS (no +tag of a shop)
          continue;
        }
        var res = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'application/json',
          muteHttpExceptions: true,
          payload: JSON.stringify(webhookBody({
            from: msg.getFrom(),
            to: msg.getTo(),
            subject: msg.getSubject(),
            text: msg.getPlainBody(),
            html: msg.getBody(),
            messageId: msg.getHeader('Message-ID'),
            date: msg.getDate(),
          })),
        });
        var code = res.getResponseCode();
        if (code >= 200 && code < 300) {
          done = remember(done, id);
        } else {
          // retried on the next run; Salon OS ignores a mail it already has (same Message-ID)
          console.error('Salon OS answered ' + code + ' for "' + msg.getSubject() + '": ' + res.getContentText().slice(0, 200));
        }
      }
    }
    props.setProperty(DONE_KEY, JSON.stringify(done));
  } finally {
    lock.releaseLock();
  }
}

/** Run once by hand: registers the 1-minute trigger (and removes older copies of it). */
function setup() {
  parseRoutes(PropertiesService.getScriptProperties().getProperty('ROUTES'));
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'forwardNewMails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('forwardNewMails').timeBased().everyMinutes(1).create();
  forwardNewMails();
}

if (typeof module !== 'undefined') module.exports = { tagOf: tagOf, parseRoutes: parseRoutes, routeFor: routeFor, routeBySender: routeBySender, webhookBody: webhookBody, remember: remember };
