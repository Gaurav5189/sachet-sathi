/* SachetSathi PWA — no framework, no build step (ARCHITECTURE: vanilla JS).
 *
 * Offline model:
 *   - the shell + safety pack are precached by sw.js
 *   - the last successful /api/alerts and /api/incidents payloads are kept in
 *     IndexedDB, so a cold start with no network still shows real data (marked
 *     as cached, with its timestamp)
 *   - reports are queued in IndexedDB and flushed only when the user taps
 *     "Send now" (or when connectivity returns and the tab is open)
 */

'use strict';

const DB_NAME = 'sachetsathi';
const DB_VERSION = 1;
const FETCH_TIMEOUT_MS = 10_000;
const PHOTO_MAX_PX = 1280;
const PHOTO_QUALITY = 0.8;

const $ = (selector) => document.querySelector(selector);
const state = {
  online: navigator.onLine,
  severity: '',
  lang: 'en',
  pack: null,
  alerts: [],
  incidents: [],
};

/* ---------------------------------------------------------------- storage */

let memoryStore = null; // last-resort fallback when IndexedDB is blocked

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('queue')) {
        const queue = db.createObjectStore('queue', { keyPath: 'client_id' });
        queue.createIndex('created_at', 'created_at');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, work) {
  if (memoryStore) return work(memoryStore[storeName]);
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = work(store);
      tx.oncomplete = () => resolve(result && result.__value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function kvGet(key, fallback = null) {
  try {
    const value = await withStore('kv', 'readonly', (store) => {
      const request = store.get(key);
      request.onsuccess = () => (request.__value = request.result ?? fallback);
      return request;
    });
    return value ?? fallback;
  } catch (error) {
    console.warn('kvGet failed', error);
    return fallback;
  }
}

async function kvSet(key, value) {
  try {
    await withStore('kv', 'readwrite', (store) => {
      store.put(value, key);
    });
  } catch (error) {
    console.warn('kvSet failed', error);
  }
}

async function queueAll() {
  try {
    return (
      (await withStore('queue', 'readonly', (store) => {
        const request = store.getAll();
        request.onsuccess = () => (request.__value = request.result || []);
        return request;
      })) || []
    );
  } catch (error) {
    console.warn('queueAll failed', error);
    return [];
  }
}

async function queuePut(item) {
  await withStore('queue', 'readwrite', (store) => {
    store.put(item);
  });
}

async function queueDelete(clientId) {
  await withStore('queue', 'readwrite', (store) => {
    store.delete(clientId);
  });
}

/* ------------------------------------------------------------------ utils */

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function announce(message) {
  $('#announcer').textContent = message;
}

function timeAgo(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------- net */

function setOnline(online) {
  state.online = online;
  const status = $('#status');
  status.dataset.online = String(online);
  $('#status-text').textContent = online ? 'online' : 'offline';
  if (online) {
    announce('Back online. Tap “Send now” to flush queued reports.');
    loadAlerts();
    loadIncidents();
  } else {
    announce('Offline. Showing cached data; reports will be queued.');
  }
}

/* ---------------------------------------------------------------- alerts */

function alertCard(alert) {
  const severity = alert.severity || 'low';
  const area = alert.area || alert.event_name || '';
  return `
    <article class="card" data-severity="${escapeHtml(severity)}">
      <div class="card-top">
        <h3>${escapeHtml(alert.event_name || alert.headline || 'Alert')}</h3>
        <span class="tag sev-${escapeHtml(severity)}">${escapeHtml(severity)}</span>
      </div>
      <p class="meta">
        <span>${escapeHtml(alert.source_label || alert.source || '')}</span>
        ${area ? `<span>${escapeHtml(area)}</span>` : ''}
        <span>${escapeHtml(timeAgo(alert.observed_at || alert.updated_at))}</span>
      </p>
      ${
        alert.headline
          ? `<p class="body">${escapeHtml(alert.headline)}</p>`
          : ''
      }
      ${
        alert.url
          ? `<p class="meta"><a href="${escapeHtml(alert.url)}" rel="noopener">Official source</a></p>`
          : ''
      }
    </article>`;
}

function renderAlerts(payload, { cached = false } = {}) {
  const alerts = (payload && payload.alerts) || [];
  state.alerts = alerts;
  const list = $('#alerts');
  if (!alerts.length) {
    list.innerHTML = '<p class="empty">No alerts right now. Pull to refresh when online.</p>';
  } else {
    list.innerHTML = alerts.slice(0, 12).map(alertCard).join('');
  }
  const stamp = payload && (payload.fetched_at || payload.generated_at);
  $('#alerts-meta').textContent = cached
    ? `cached · ${timeAgo(stamp) || 'offline'}`
    : stamp
      ? `updated ${timeAgo(stamp)}`
      : '';
}

async function loadAlerts() {
  try {
    const payload = await getJson('/api/alerts?limit=12');
    renderAlerts(payload);
    await kvSet('alerts', payload);
  } catch (error) {
    console.warn('alerts fetch failed', error);
    const cached = await kvGet('alerts');
    if (cached) {
      renderAlerts(cached, { cached: true });
    } else {
      $('#alerts').innerHTML =
        '<p class="empty">Alerts are unavailable offline and no copy was saved yet.</p>';
      $('#alerts-meta').textContent = 'offline';
    }
  }
}

/* ------------------------------------------------------------- incidents */

function incidentCard(incident) {
  const severity = incident.severity || 'low';
  const label =
    incident.triage_mode === 'gemma'
      ? 'AI-assisted'
      : incident.triage_mode === 'fallback'
        ? 'rule-based fallback'
        : 'awaiting triage';
  const summary = incident.odia_summary
    ? `<p class="body odia" lang="or">${escapeHtml(incident.odia_summary)}</p>`
    : '';
  return `
    <article class="card" data-severity="${escapeHtml(severity)}">
      <div class="card-top">
        <h3>#${escapeHtml(incident.id)} ${escapeHtml(incident.caption || 'Field report')}</h3>
        <span class="tag sev-${escapeHtml(severity)}">${escapeHtml(severity)}</span>
      </div>
      <p class="meta">
        <span>${escapeHtml(incident.category || 'other')}</span>
        <span>priority ${escapeHtml(incident.priority ?? '–')}</span>
        <span>${escapeHtml(timeAgo(incident.created_at))}</span>
        <span>${escapeHtml(label)}</span>
      </p>
      ${summary}
      ${
        incident.next_action
          ? `<p class="body">${escapeHtml(incident.next_action)}</p>`
          : ''
      }
    </article>`;
}

function renderIncidents(payload, { cached = false } = {}) {
  const incidents = (payload && payload.incidents) || [];
  state.incidents = incidents;
  const filtered = state.severity
    ? incidents.filter((item) => item.severity === state.severity)
    : incidents;
  const list = $('#incidents');
  list.innerHTML = filtered.length
    ? filtered.map(incidentCard).join('')
    : `<p class="empty">${
        incidents.length
          ? 'No reports at this severity.'
          : 'No field reports yet. Tap + to file one.'
      }</p>`;
  $('#incidents-meta').textContent = cached
    ? `cached · ${filtered.length}`
    : `${filtered.length} shown`;
}

async function loadIncidents() {
  try {
    const payload = await getJson('/api/incidents?limit=30');
    renderIncidents(payload);
    await kvSet('incidents', payload);
  } catch (error) {
    console.warn('incidents fetch failed', error);
    const cached = await kvGet('incidents');
    if (cached) {
      renderIncidents(cached, { cached: true });
    } else {
      $('#incidents').innerHTML =
        '<p class="empty">Reports are unavailable offline and no copy was saved yet.</p>';
    }
  }
}

/* ------------------------------------------------------------ safety pack */

function renderPack() {
  const pack = state.pack;
  const target = $('#pack');
  if (!pack) {
    target.innerHTML =
      '<p class="empty">The safety pack is unavailable offline and no copy was saved yet.</p>';
    return;
  }
  const lang = state.lang;
  const isOdia = lang === 'or';
  const numbers = (pack.emergency || [])
    .map(
      (item) => `
        <a class="number" href="tel:${escapeHtml(item.number)}" data-lang="${lang}">
          <b>${escapeHtml(item.number)}</b>
          <span>${escapeHtml(isOdia ? item.label_or : item.label_en)}</span>
        </a>`,
    )
    .join('');
  const list = (items, kind) =>
    `<ul class="list ${kind}" data-lang="${lang}">${items
      .map((item) => `<li>${escapeHtml(isOdia ? item.or : item.en)}</li>`)
      .join('')}</ul>`;

  target.innerHTML = `
    <div class="numbers">${numbers}</div>
    <h2>Do</h2>${list(pack.do || [], 'do')}
    <h2>Don't</h2>${list(pack.dont || [], 'dont')}
    <h2>Go-bag</h2>${list(pack.checklist || [], 'do')}
    <p class="notice" data-lang="${lang}">${escapeHtml(
      isOdia ? pack.notice_or : pack.notice_en,
    )}</p>`;
}

async function loadPack() {
  try {
    state.pack = await getJson('/api/safetypack');
    await kvSet('pack', state.pack);
  } catch (error) {
    console.warn('safety pack fetch failed', error);
    state.pack = await kvGet('pack');
  }
  renderPack();
}

/* ----------------------------------------------------------------- report */

async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_MAX_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
}

async function photoPayload(file) {
  if (!file) return null;
  try {
    return await downscale(file);
  } catch (error) {
    console.warn('downscale failed, sending the original', error);
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
}

function newClientId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function refreshQueueUi() {
  const items = await queueAll();
  const hint = $('#queue-hint');
  hint.textContent = items.length
    ? `${items.length} report${items.length === 1 ? '' : 's'} waiting on this phone.`
    : 'No unsent reports.';
  $('#send-now').disabled = items.length === 0;
  return items;
}

async function saveReport(event) {
  event.preventDefault();
  const caption = $('#caption').value.trim();
  const status = $('#form-status');
  if (!caption) {
    status.textContent = 'Add a short description first.';
    return;
  }
  status.textContent = 'Saving…';
  const file = $('#photo').files[0];
  let photo = null;
  try {
    photo = await photoPayload(file);
  } catch (error) {
    status.textContent = 'Could not read that photo; saving the text only.';
    console.warn(error);
  }
  const item = {
    client_id: newClientId(),
    caption,
    photo_base64: photo,
    created_at: new Date().toISOString(),
  };
  await queuePut(item);
  await refreshQueueUi();
  $('#caption').value = '';
  $('#photo').value = '';
  $('#preview').hidden = true;
  $('#preview').removeAttribute('src');
  status.textContent = 'Saved on this phone.';
  announce('Report saved on this phone.');
  if (state.online) await flushQueue();
}

async function flushQueue() {
  const items = await queueAll();
  if (!items.length) {
    $('#form-status').textContent = 'Nothing to send.';
    return;
  }
  const status = $('#form-status');
  let sent = 0;
  let failed = 0;
  for (const item of items) {
    try {
      const response = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: item.client_id,
          caption: item.caption,
          photo_base64: item.photo_base64 || undefined,
        }),
      });
      if (response.ok) {
        await queueDelete(item.client_id);
        sent += 1;
        continue;
      }
      const body = await response.json().catch(() => ({}));
      if (response.status === 413 || response.status === 422) {
        // The server will never accept this one; keeping it would wedge the queue.
        await queueDelete(item.client_id);
        failed += 1;
        status.textContent = body.hint || 'That report was rejected; removed from the queue.';
        continue;
      }
      failed += 1;
    } catch (error) {
      console.warn('flush failed', error);
      failed += 1;
      break; // no network: stop, keep the rest queued
    }
  }
  await refreshQueueUi();
  if (sent) {
    status.textContent = `Sent ${sent} report${sent === 1 ? '' : 's'}.`;
    announce(`Sent ${sent} report${sent === 1 ? '' : 's'}.`);
    await loadIncidents();
  } else if (failed && !status.textContent) {
    status.textContent = 'Could not send yet — still queued on this phone.';
  }
}

/* ------------------------------------------------------------------- wire */

function wireFilters() {
  $('#filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-severity]');
    if (!button) return;
    state.severity = button.dataset.severity;
    for (const chip of $('#filters').querySelectorAll('[data-severity]')) {
      chip.setAttribute('aria-pressed', String(chip === button));
    }
    renderIncidents({ incidents: state.incidents });
  });
}

function wireLanguage() {
  for (const button of document.querySelectorAll('[data-lang-btn]')) {
    button.addEventListener('click', async () => {
      state.lang = button.dataset.langBtn;
      for (const chip of document.querySelectorAll('[data-lang-btn]')) {
        chip.setAttribute('aria-pressed', String(chip === button));
      }
      await kvSet('lang', state.lang);
      renderPack();
    });
  }
}

function wireReport() {
  const dialog = $('#report-dialog');
  $('#open-report').addEventListener('click', () => dialog.showModal());
  $('#close-report').addEventListener('click', () => dialog.close());
  $('#report-form').addEventListener('submit', saveReport);
  $('#send-now').addEventListener('click', flushQueue);
  $('#photo').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    const preview = $('#preview');
    if (!file) {
      preview.hidden = true;
      return;
    }
    try {
      preview.src = await photoPayload(file);
      preview.hidden = false;
    } catch (error) {
      console.warn('preview failed', error);
    }
  });
}

async function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (error) {
    console.warn('service worker registration failed', error);
  }
}

async function boot() {
  state.lang = (await kvGet('lang', 'en')) || 'en';
  for (const chip of document.querySelectorAll('[data-lang-btn]')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.langBtn === state.lang));
  }
  wireFilters();
  wireLanguage();
  wireReport();
  setOnline(navigator.onLine);
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));

  await Promise.all([loadAlerts(), loadIncidents(), loadPack()]);
  await refreshQueueUi();
  if (state.online) await flushQueue();
  await registerWorker();
}

boot().catch((error) => {
  console.error('boot failed', error);
  announce('The app could not start; reload when you have network.');
});
