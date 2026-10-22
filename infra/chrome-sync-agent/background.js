// Salon OS 自動枠止め — runs every 10 minutes in the salon's own Chrome.
//   1. reads the stylists on minimo / SALON BOARD (with this Chrome's logins)
//   2. asks Salon OS which slots to close / reopen (POST /v1/agent/plan)
//   3. minimo: changes the すぐ予約 cells like the schedule screen's 変更を保存
//      SALON BOARD: adds / deletes 予定 like the schedule screen's 予定 button and 予定変更 page
//   4. reports the results and whether each medium is logged in (POST /v1/agent/report)
// Nothing is stored but the Salon OS address, the helper's token and the stylist list. No passwords.
import { applyDay, buildOps, jstDate, openCells, scheduleBody, staffOf } from './lib/minimo.js';
import { buildSbOps, coversPlan, createBody, findQuery, isOurs } from './lib/salonboard.js';

const VERSION = chrome.runtime.getManifest().version;
const PERIOD_MIN = 10;
const MINIMO_HOME = 'https://minimodel.jp/salontool/home';
const SB_SCHEDULE = 'https://salonboard.com/KLP/schedule/salonSchedule/';
/** the SALON BOARD stylist list is read again after this long (reading it reloads the schedule) */
const SB_STAFF_TTL_MS = 6 * 3600_000;

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'cycle') runCycle('timer');
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'run-now') {
    runCycle('manual').then(reply);
    return true;
  }
  return false;
});

function schedule() {
  chrome.alarms.create('cycle', { periodInMinutes: PERIOD_MIN, delayInMinutes: 0.2 });
}

async function settings() {
  const s = await chrome.storage.local.get(['baseUrl', 'token', 'minimo', 'salonboard']);
  return {
    baseUrl: (s.baseUrl || 'https://salon-os-web.onrender.com').replace(/\/+$/, ''),
    token: s.token || '',
    minimo: s.minimo !== false,
    salonboard: s.salonboard !== false,
  };
}

async function log(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift({ at: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ history: history.slice(0, 50), last: history[0] });
  chrome.action.setBadgeText({ text: entry.ok ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#d33' });
}

async function salonOs(s, path, body) {
  const res = await fetch(`${s.baseUrl}/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message || `Salon OS が応答しません（${res.status}）`);
  return json;
}

let running = false;

export async function runCycle(trigger) {
  if (running) return { ok: false, message: '実行中です' };
  running = true;
  try {
    const s = await settings();
    if (!s.token) {
      await log({
        ok: false,
        trigger,
        message: 'トークンが未設定です（設定画面で貼り付けてください）',
      });
      return { ok: false };
    }
    const media = {};
    const status = {};
    let minimoTab = null;
    if (s.minimo) {
      try {
        minimoTab = await mediumTab('https://minimodel.jp/salontool/*', MINIMO_HOME);
        const today = await minimoGet(minimoTab, jstDate(new Date().toISOString()));
        media.minimo_mail = { staff: staffOf(today.entries) };
        status.minimo_mail = { ok: true };
      } catch (e) {
        status.minimo_mail = { ok: false, message: e.message };
      }
    }
    let sbTab = null;
    if (s.salonboard) {
      try {
        sbTab = await ownTab('sbTabId', SB_SCHEDULE);
        if (!(await inPage(sbTab, sbLoggedIn)).ok) throw new Error('ログインが切れています');
        media.hotpepper_mail = { staff: await sbStaff(sbTab) };
        status.hotpepper_mail = { ok: true };
      } catch (e) {
        status.hotpepper_mail = { ok: false, message: e.message };
      }
    }
    const plan = await salonOs(s, '/agent/plan', { media });
    const results = [];
    for (const account of plan.accounts) {
      if (account.provider === 'minimo_mail' && minimoTab && status.minimo_mail?.ok) {
        status.minimo_mail.unmatchedStaff = account.unmatchedStaff;
        results.push(...(await runMinimo(minimoTab, account)));
      }
      if (account.provider === 'hotpepper_mail' && sbTab && status.hotpepper_mail?.ok) {
        status.hotpepper_mail.unmatchedStaff = account.unmatchedStaff;
        results.push(...(await runSalonBoard(sbTab, account)));
      }
    }
    const summary = await salonOs(s, '/agent/report', { agentVersion: VERSION, status, results });
    const failed = results.filter((r) => !r.ok);
    const mediumDown = Object.entries(status).filter(([, v]) => !v.ok);
    const ok = !failed.length && !mediumDown.length;
    await log({
      ok,
      trigger,
      message: [
        `処理 ${results.length} 件（完了 ${summary.done}・失敗 ${summary.failed}）`,
        ...mediumDown.map(
          ([p, v]) => `${p === 'minimo_mail' ? 'minimo' : 'サロンボード'}: ${v.message}`,
        ),
        ...failed.slice(0, 5).map((r) => r.error),
      ].join(' / '),
    });
    return { ok };
  } catch (e) {
    await log({ ok: false, trigger, message: e.message });
    return { ok: false };
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------- tabs

/** a tab of the medium in this Chrome (opened in the background and pinned when there is none) */
async function mediumTab(pattern, home) {
  let [tab] = await chrome.tabs.query({ url: pattern });
  if (!tab) tab = await chrome.tabs.create({ url: home, active: false, pinned: true });
  for (let i = 0; i < 60 && tab.status !== 'complete'; i++) {
    await new Promise((r) => setTimeout(r, 500));
    tab = await chrome.tabs.get(tab.id);
  }
  return tab;
}

/** this helper's own tab of a medium (pinned, in the background): staff's tabs are never moved */
async function ownTab(key, url) {
  const stored = (await chrome.storage.session.get(key))[key];
  let tab = stored ? await chrome.tabs.get(stored).catch(() => null) : null;
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false, pinned: true });
    await chrome.storage.session.set({ [key]: tab.id });
  }
  return waitLoaded(tab);
}

async function waitLoaded(tab) {
  for (let i = 0; i < 60; i++) {
    tab = await chrome.tabs.get(tab.id);
    if (tab.status === 'complete') return tab;
    await new Promise((r) => setTimeout(r, 500));
  }
  return tab;
}

async function navigate(tab, url) {
  await chrome.tabs.update(tab.id, { url });
  await new Promise((r) => setTimeout(r, 300));
  return waitLoaded(tab);
}

/** run a function inside the medium's own page (its login, its security tokens) */
async function inPage(tab, func, ...args) {
  if (typeof func !== 'function') return fetchInPage(tab, func, ...args);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args,
    func,
  });
  return result;
}

/** run fetch inside the medium's own page, so its login cookie is used exactly as the screen does */
async function fetchInPage(tab, method, path, body) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [method, path, body ?? null],
    func: async (m, p, b) => {
      const res = await fetch(p, {
        method: m,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'X-From': location.href,
          ...(b ? { 'Content-Type': 'application/json' } : {}),
        },
        body: b ? JSON.stringify(b) : undefined,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* login page or error page */
      }
      return { status: res.status, json };
    },
  });
  return result;
}

// ---------------------------------------------------------------- minimo

async function minimoGet(tab, date) {
  const r = await inPage(tab, 'GET', `/api/v1/salontool/schedule?date=${date}`);
  if (r.status === 401 || r.status === 403 || (r.status === 200 && !r.json))
    throw new Error('ログインが切れています');
  if (r.status !== 200 || !Array.isArray(r.json?.entries))
    throw new Error(`スケジュールを読めません（${r.status}）`);
  return r.json;
}

async function runMinimo(tab, account) {
  const { ops, results } = buildOps(account);
  const out = [];
  const failedTasks = new Map();
  const days = [...new Set(ops.map((o) => o.date))].sort();
  for (const date of days) {
    const dayOps = ops.filter((o) => o.date === date);
    try {
      const day = await minimoGet(tab, date);
      const open = openCells(day.entries);
      if (applyDay(open, dayOps, account.busy)) {
        const saved = await inPage(
          tab,
          'POST',
          '/api/v1/salontool/schedule',
          scheduleBody(date, day.entries, open),
        );
        if (saved.status < 200 || saved.status >= 300)
          throw new Error(
            `minimo に保存できません（${saved.status}${saved.json?._error?.message ? `: ${saved.json._error.message}` : ''}）`,
          );
        // read back: the closed cells must be gone
        const check = openCells((await minimoGet(tab, date)).entries);
        for (const op of dayOps.filter((o) => o.kind === 'close')) {
          if (op.done.some((c) => check.get(op.staff)?.has(c)))
            throw new Error('保存後も枠が開いたままです');
        }
      }
    } catch (e) {
      for (const op of dayOps) failedTasks.set(op.taskId, e.message);
    }
  }
  for (const t of account.tasks) {
    const base = { blockId: t.id, state: t.state, start: t.start, end: t.end };
    if (results.has(t.id)) {
      out.push({ ...base, ...results.get(t.id) });
      continue;
    }
    if (failedTasks.has(t.id)) {
      out.push({ ...base, ok: false, error: failedTasks.get(t.id) });
      continue;
    }
    const close = ops.find((o) => o.taskId === t.id && o.kind === 'close');
    out.push({
      ...base,
      ok: true,
      record: close ? { date: close.date, staff: close.staff, cells: close.done ?? [] } : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- SALON BOARD
// The functions handed to inPage run inside the SALON BOARD tab and must be self-contained.

function sbLoggedIn() {
  return fetch('/KLP/top/', { credentials: 'include' })
    .then((r) => r.text())
    .then((h) => ({ ok: /SALON BOARD : TOP/.test(h) && /ログアウト/.test(h) }))
    .catch(() => ({ ok: false }));
}

async function sbReadStaff() {
  for (let i = 0; i < 30; i++) {
    const heads = [...document.querySelectorAll('.jscScheduleMainHeadListStaff > li[id^=STAFF_]')];
    if (heads.length)
      return heads.map((h) => ({
        id: h.id.split('_')[1],
        name: h.innerText.split('\n')[0].trim(),
      }));
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function sbFind(q) {
  const r = await fetch('/KLP/set/scheduleChange/?' + new URLSearchParams(q), {
    credentials: 'include',
  });
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const f = doc.forms.scheduleChange;
  if (!f) return { exists: false, pageTitle: doc.title };
  const v = (n) => f.elements[n]?.value ?? null;
  return {
    exists: true,
    title: v('schTitle'),
    memo: v('schMemo'),
    staffId: v('staffId'),
    startHour: v('schStartHour'),
    startMinute: v('schStartMinute'),
    endHour: v('schEndHour'),
    endMinute: v('schEndMinute'),
  };
}

async function sbDelete(q) {
  const r = await fetch('/KLP/set/scheduleChange/?' + new URLSearchParams(q), {
    credentials: 'include',
  });
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const f = doc.forms.scheduleChange;
  if (!f) return { status: 0, message: '予定が見つかりません' };
  const body = new URLSearchParams();
  for (const e of f.elements) {
    if (!e.name || e.type === 'button' || e.type === 'submit') continue;
    if ((e.type === 'checkbox' || e.type === 'radio') && !e.checked) continue;
    body.append(e.name, e.value);
  }
  const res = await fetch('/KLP/set/scheduleChange/doDelete', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const page = new DOMParser().parseFromString(await res.text(), 'text/html');
  return { status: res.status, pageTitle: page.title };
}

async function sbCreate(fields) {
  const params = document.forms.params;
  if (!params) return { status: 0, message: 'スケジュール画面ではありません' };
  const body = new URLSearchParams(fields);
  for (const n of ['org.apache.struts.taglib.html.TOKEN', 'storeIdForMultipleTabCheck']) {
    if (params.elements[n]) body.append(n, params.elements[n].value);
  }
  const res = await fetch('/KLP/schedule/salonSchedule/updateStaffShift/', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-HTTP-Method-Override': 'PUT',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
    body,
  });
  const text = await res.text();
  // keep only what explains a refusal (no tokens, no customer data in the schedule screen's answer)
  let message = null;
  try {
    const j = JSON.parse(text);
    message = JSON.stringify(j.errors ?? j.warnings ?? j.message ?? j.errorMessages ?? null);
  } catch {
    message = /エラー|error/i.test(text) ? 'エラー画面が返されました' : null;
  }
  return { status: res.status, message: message ? message.slice(0, 200) : null };
}

/** the stylists on SALON BOARD (kept for a while: reading them reloads this helper's schedule tab) */
async function sbStaff(tab) {
  const { sbStaffCache } = await chrome.storage.local.get('sbStaffCache');
  if (sbStaffCache?.list?.length && Date.now() - sbStaffCache.at < SB_STAFF_TTL_MS)
    return sbStaffCache.list;
  await navigate(tab, SB_SCHEDULE);
  const list = await inPage(tab, sbReadStaff);
  if (!list?.length) throw new Error('スタッフ一覧を読めません');
  await chrome.storage.local.set({ sbStaffCache: { at: Date.now(), list } });
  return list;
}

async function runSalonBoard(tab, account) {
  const { ops, results } = buildSbOps(account);
  const outcome = new Map();
  const fail = (taskId, error) => outcome.set(taskId, { ok: false, error });
  for (const op of ops) {
    if (outcome.get(op.taskId)?.ok === false) continue;
    const q = findQuery(op.plan);
    try {
      if (op.kind === 'delete') {
        const found = await inPage(tab, sbFind, q);
        // gone already, or not ours (staff changed it by hand): nothing to delete
        if (!isOurs(found, op.plan)) continue;
        await inPage(tab, sbDelete, q);
        if (isOurs(await inPage(tab, sbFind, q), op.plan))
          fail(op.taskId, 'サロンボードの予定を削除できませんでした');
        continue;
      }
      const found = await inPage(tab, sbFind, q);
      if (coversPlan(found, op.plan)) {
        outcome.set(op.taskId, { ok: true, record: op.plan });
        continue;
      }
      if (found?.exists && !isOurs(found, op.plan)) {
        // the salon's own 予定 starts then already (the slot is held): adding a second one at the
        // same start would make the two impossible to tell apart on the 予定変更 page
        outcome.set(op.taskId, {
          ok: true,
          record: { skipped: 'サロンボードに同じ時間の予定があります' },
        });
        continue;
      }
      if (isOurs(found, op.plan)) await inPage(tab, sbDelete, q);
      // a fresh schedule page of that day gives the security token the save needs
      await navigate(tab, `${SB_SCHEDULE}?date=${op.plan.date}`);
      const res = await inPage(tab, sbCreate, createBody(op.plan));
      if (coversPlan(await inPage(tab, sbFind, q), op.plan))
        outcome.set(op.taskId, { ok: true, record: op.plan });
      else
        fail(
          op.taskId,
          `サロンボードに予定を追加できませんでした（${res.status}${res.message ? `: ${res.message}` : ''}）`,
        );
    } catch (e) {
      fail(op.taskId, e.message);
    }
  }
  return account.tasks.map((t) => {
    const base = { blockId: t.id, state: t.state, start: t.start, end: t.end };
    if (results.has(t.id)) return { ...base, ...results.get(t.id) };
    if (outcome.has(t.id)) return { ...base, ...outcome.get(t.id) };
    // only deletes (cancelled booking), all done
    return { ...base, ok: true, record: null };
  });
}
