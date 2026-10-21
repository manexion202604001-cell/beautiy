const $ = (id) => document.getElementById(id);
const DEFAULT_BASE = 'https://salon-os-web.onrender.com';

async function load() {
  const s = await chrome.storage.local.get(['baseUrl', 'token', 'minimo', 'history']);
  $('baseUrl').value = s.baseUrl || DEFAULT_BASE;
  $('token').value = s.token || '';
  $('minimo').checked = s.minimo !== false;
  render(s.history || []);
}

function render(history) {
  const last = history[0];
  $('status').innerHTML = last
    ? `<span class="${last.ok ? 'ok' : 'ng'}">${last.ok ? '正常' : '要確認'}</span>　${new Date(last.at).toLocaleString('ja-JP')}<br><small></small>`
    : 'まだ実行していません';
  if (last) $('status').querySelector('small').textContent = last.message || '';
  $('history').replaceChildren(
    ...history.slice(1, 10).map((h) => {
      const li = document.createElement('li');
      li.textContent = `${new Date(h.at).toLocaleString('ja-JP')} ${h.ok ? '正常' : '要確認'} ${h.message || ''}`;
      return li;
    }),
  );
}

$('save').addEventListener('click', async () => {
  const baseUrl = ($('baseUrl').value.trim() || DEFAULT_BASE).replace(/\/+$/, '');
  if (baseUrl !== DEFAULT_BASE) {
    const granted = await chrome.permissions.request({ origins: [`${new URL(baseUrl).origin}/*`] });
    if (!granted) return alert('このアドレスへの接続が許可されませんでした');
  }
  await chrome.storage.local.set({
    baseUrl,
    token: $('token').value.trim(),
    minimo: $('minimo').checked,
  });
  $('status').textContent = '保存しました';
});

$('run').addEventListener('click', async () => {
  $('status').textContent = '実行中…';
  await chrome.runtime.sendMessage({ type: 'run-now' });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.history) render(changes.history.newValue || []);
});

load();
