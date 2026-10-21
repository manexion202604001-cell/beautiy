// Salon OS 自動枠止め — runs every 10 minutes in the salon's own Chrome.
//   1. reads the stylists on minimo (with this Chrome's minimo login)
//   2. asks Salon OS which slots to close / reopen (POST /v1/agent/plan)
//   3. changes minimo's すぐ予約 cells like the schedule screen's 変更を保存
//   4. reports the results and whether minimo is logged in (POST /v1/agent/report)
// Nothing is stored but the Salon OS address and the helper's token. No passwords.
import { applyDay, buildOps, jstDate, openCells, scheduleBody, staffOf } from './lib/minimo.js';

const VERSION = chrome.runtime.getManifest().version;
const PERIOD_MIN = 10;
const MINIMO_HOME = 'https://minimodel.jp/salontool/home';

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
  const s = await chrome.storage.local.get(['baseUrl', 'token', 'minimo']);
  return {
    baseUrl: (s.baseUrl || 'https://salon-os-web.onrender.com').replace(/\/+$/, ''),
    token: s.token || '',
    minimo: s.minimo !== false,
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
    const plan = await salonOs(s, '/agent/plan', { media });
    const results = [];
    for (const account of plan.accounts) {
      if (account.provider === 'minimo_mail' && minimoTab && status.minimo_mail?.ok) {
        status.minimo_mail.unmatchedStaff = account.unmatchedStaff;
        results.push(...(await runMinimo(minimoTab, account)));
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
        ...mediumDown.map(([, v]) => `minimo: ${v.message}`),
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

/** run fetch inside the medium's own page, so its login cookie is used exactly as the screen does */
async function inPage(tab, method, path, body) {
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
