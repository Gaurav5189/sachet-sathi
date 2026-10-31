/* SachetSathi PWA — vanilla JS, no framework, no build step.
 *
 * Preserved behaviour (unchanged contracts):
 *   - GET /api/alerts, /api/incidents, /api/safetypack; POST /api/report
 *   - shell + safety pack precached by sw.js; last good payloads kept in IndexedDB
 *   - reports queue in IndexedDB and flush on "Send now" / on reconnect
 * New behaviour: IA, hierarchy, filters, map, report sheet, i18n, theming.
 */
'use strict';

/* ============================================================ constants */
const DB_NAME = 'sachetsathi';
const DB_VERSION = 1;
const FETCH_TIMEOUT_MS = 12000;
const PHOTO_MAX_PX = 1280;
const PHOTO_QUALITY = 0.8;
const RADIUS_KM = 100;          // "near you" radius
const REGION_WATCH_KM = 500;    // secondary watch ring for big cyclones
const ONGOING_DAYS = 7;         // older than this => "Ongoing", demoted
const NEAR_REPORT_HOURS = 24;
const CHUNK = 8;                // windowed rendering
const LOC_PREFIX = '📍';
const DEFAULT_PLACE = (window.SACHET_GEO && window.SACHET_GEO.defaultPlace) || [
  'Bhubaneswar', 'ଭୁବନେଶ୍ୱର', 'Khordha', 20.2961, 85.8245,
];

const SEV_RANK = { severe: 0, moderate: 1, low: 2 };
const TYPE_ORDER = ['flood', 'cyclone', 'damage', 'medical', 'other'];

/* At ≥768px the map is a persistent grid column, and at ≥1200px so is the
 * safety pack. Those breakpoints are declared in style.css — keep in sync. */
const MAP_RAIL_MQ = window.matchMedia('(min-width: 768px)');
const SAFETY_RAIL_MQ = window.matchMedia('(min-width: 1200px)');

/* ============================================================ state */
const state = {
  online: navigator.onLine,
  lastSync: null,
  cached: false,
  demo: false,
  error: false,
  lang: 'en',
  theme: 'dark',
  view: 'home',
  filters: { sev: 'all', type: 'all', src: 'all' },
  filtersOpen: false,
  alerts: [],
  incidents: [],
  pack: null,
  packMissing: false,
  votes: {},
  ackBanner: null,
  seenIds: [],
  newCount: 0,
  showTests: false,
  loading: true,
  selectedMapId: null,
  place: {
    name: DEFAULT_PLACE[0],
    odia: DEFAULT_PLACE[1],
    district: DEFAULT_PLACE[2],
    lat: DEFAULT_PLACE[3],
    lon: DEFAULT_PLACE[4],
    source: 'default',
  },
  map: { lat: 20.2, lon: 84.6, zoom: 1.15 },
  reportType: null,
  pendingPhoto: null,
};

/* ============================================================ helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function clampText(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function t(key, vars) {
  const dict = (window.SACHET_I18N && window.SACHET_I18N[state.lang]) || {};
  const fallback = (window.SACHET_I18N && window.SACHET_I18N.en) || {};
  let out = dict[key] || fallback[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}
const otherLang = () => (state.lang === 'or' ? 'en' : 'or');
const langName = (l) => (l === 'or' ? 'ଓଡ଼ିଆ' : 'English');

function announce(msg, urgent = false) {
  const el = $(urgent ? '#announcer-urgent' : '#announcer');
  if (!el) return;
  el.textContent = '';
  window.setTimeout(() => { el.textContent = msg; }, 30);
}

function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  $('#toast-text').textContent = msg;
  el.dataset.show = 'true';
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => { el.dataset.show = 'false'; }, 2600);
}

function haptic(pattern) {
  try { navigator.vibrate?.(pattern); } catch (e) { /* unsupported */ }
}

function scrollBehavior() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function parseIso(iso) {
  if (!iso) return NaN;
  let value = Date.parse(iso);
  if (!Number.isNaN(value)) return value;
  // SQLite sometimes yields "2026-10-31 06:13:12" (space, no zone)
  value = Date.parse(String(iso).replace(' ', 'T') + 'Z');
  return value;
}

function ageDays(iso) {
  const then = parseIso(iso);
  if (Number.isNaN(then)) return null;
  return (Date.now() - then) / 86_400_000;
}

function timeAgo(iso) {
  const then = parseIso(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return t('time.just_now');
  if (minutes < 60) return t('time.ago', { v: t('time.min', { n: minutes }) });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('time.ago', { v: t('time.hour', { n: hours }) });
  const days = Math.round(hours / 24);
  return t('time.ago', { v: t('time.day', { n: days }) });
}

function fmtKm(km) {
  if (km == null) return '';
  const n = km < 10 ? km.toFixed(1) : String(Math.round(km));
  return t('units.km', { n });
}

function distTo(lat, lon) {
  if (lat == null || lon == null || !window.SACHET_GEO) return null;
  return window.SACHET_GEO.distanceKm(state.place.lat, state.place.lon, lat, lon);
}

function severityMeta(sev) {
  if (sev === 'severe') return { icon: 'triangle-alert', key: 'sev.severe' };
  if (sev === 'moderate') return { icon: 'alert-circle', key: 'sev.moderate' };
  return { icon: 'info', key: 'sev.low' };
}

/* ============================================================ icons (Lucide, stroke 1.75) */
const ICON_PATHS = {
  'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'alert-circle': '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  waves: '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
  wind: '<path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/>',
  'hard-hat': '<path d="M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1Z"/><path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5"/><path d="M4 15v-3a6 6 0 0 1 6-6"/><path d="M14 6a6 6 0 0 1 6 6v3"/>',
  'heart-pulse': '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  mountain: '<path d="m8 3 4 8 5-5 5 15H2L8 3Z"/>',
  'map-pin': '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/><path d="m9 12 2 2 4-4"/>',
  'shield-alert': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  bell: '<path d="M10.27 21a2 2 0 0 0 3.46 0"/><path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33"/>',
  wifi: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/>',
  'wifi-off': '<path d="M12 20h.01"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/><path d="M5 12.86a10 10 0 0 1 5.17-2.69"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="m2 2 20 20"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'share-2': '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>',
  navigation: '<path d="M3 11 22 2l-9 19-2-8-8-2Z"/>',
  'external-link': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3"/>',
  send: '<path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.64l-19 6.5a.5.5 0 0 0-.02.94l7.93 3.18a2 2 0 0 1 1.11 1.11z"/><path d="m21.85 2.15-10.94 10.94"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'volume-2': '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.36 18.36a9 9 0 0 0 0-12.73"/>',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  map: '<path d="M14.1 5.55a2 2 0 0 0 1.79 0l3.66-1.83A1 1 0 0 1 21 4.62v12.76a1 1 0 0 1-.55.9l-4.56 2.27a2 2 0 0 1-1.79 0l-4.21-2.1a2 2 0 0 0-1.79 0l-3.66 1.83A1 1 0 0 1 3 19.38V6.62a1 1 0 0 1 .55-.9l4.56-2.27a2 2 0 0 1 1.79 0z"/><path d="M15 5.76v15"/><path d="M9 3.24v15"/>',
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .71-1.53l7-6a2 2 0 0 1 2.58 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  backpack: '<path d="M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M8 21v-5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v5"/><path d="M8 10h8"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  phone: '<path d="M13.83 16.57a1 1 0 0 0 1.21-.3l.36-.47A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.47.35a1 1 0 0 0-.29 1.24 14 14 0 0 0 6.39 6.38"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  contrast: '<circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12Z"/>',
  'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  'thumbs-up': '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  'thumbs-down': '<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
  sparkles: '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/>',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  message: '<path d="M22 17a2 2 0 0 1-2 2H6l-4 4V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2Z"/>',
  'zoom-in': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>',
  'zoom-out': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/>',
  crosshair: '<circle cx="12" cy="12" r="10"/><path d="M22 12h-4"/><path d="M6 12H2"/><path d="M12 6V2"/><path d="M12 22v-4"/>',
  locate: '<path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.5"/>',
  'triangle': '<path d="M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>',
  'check-circle': '<path d="M21.8 10A10 10 0 1 1 17 3.34"/><path d="m9 11 3 3L22 4"/>',
  'x-circle': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  'lightbulb': '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1.3.5 2.6 1.5 3.5.8.8 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  'printer': '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  'shield': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/>',
  'history': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  'circle-dot': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
};

function icon(name, size = 20, extra = '') {
  const path = ICON_PATHS[name] || ICON_PATHS['circle-help'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${path}</svg>`;
}

const TYPE_ICON = {
  flood: 'waves', cyclone: 'wind', damage: 'hard-hat', medical: 'heart-pulse',
  supply: 'package', drought: 'sun', earthquake: 'activity', wildfire: 'flame',
  volcano: 'mountain', storm: 'wind', other: 'circle-help',
};
const typeIcon = (type) => TYPE_ICON[type] || 'circle-help';
const typeLabel = (type) => t(`type.${TYPE_ICON[type] ? type : 'other'}`);

/* ============================================================ storage (IndexedDB, memory fallback) */
let memoryStore = null;

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
  } catch (error) { console.warn('kvGet failed', error); return fallback; }
}
async function kvSet(key, value) {
  try { await withStore('kv', 'readwrite', (store) => { store.put(value, key); }); }
  catch (error) { console.warn('kvSet failed', error); }
}
async function queueAll() {
  try {
    return (await withStore('queue', 'readonly', (store) => {
      const request = store.getAll();
      request.onsuccess = () => (request.__value = request.result || []);
      return request;
    })) || [];
  } catch (error) { console.warn('queueAll failed', error); return []; }
}
async function queuePut(item) { await withStore('queue', 'readwrite', (s) => { s.put(item); }); }
async function queueDelete(clientId) { await withStore('queue', 'readwrite', (s) => { s.delete(clientId); }); }

/* ============================================================ network */
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function setOnline(online) {
  state.online = online;
  const pill = $('#conn-pill');
  if (pill) pill.dataset.online = String(online);
  if (online) announce(t('a11y.online'));
  else { announce(t('a11y.offline')); haptic(20); }
  renderChrome();
  if (online) { loadAll({ silent: true }); flushQueue(); }
}

/* ============================================================ normalization */
function cleanHeadline(text) {
  let out = String(text || '').replace(/\s+/g, ' ').trim();
  // GDACS boilerplate: "Population affected by …" is noise on a card. Drop the
  // whole trailing clause (it contains decimals, so match to end-of-string).
  out = out.replace(/\s*Population affected by[\s\S]*$/i, '').trim();
  return out;
}

function splitCountries(area) {
  const raw = String(area || '').trim();
  if (!raw || /unknown/i.test(raw)) return [];
  return raw.split(/,|;|\band\b/gi).map((s) => s.trim()).filter(Boolean).slice(0, 8);
}

function alertToItem(a) {
  const sev = SEV_RANK[a.severity] != null ? a.severity : 'low';
  const type = ({ TC: 'cyclone', FL: 'flood', DR: 'drought', WF: 'wildfire', VO: 'volcano', EQ: 'earthquake', ST: 'storm' })[a.event_type] || 'other';
  const dist = distTo(a.lat, a.lon);
  const days = ageDays(a.observed_at || a.updated_at || a.fetched_at);
  const headline = cleanHeadline(a.headline || a.event_name || '');
  const title = headline || (a.event_name ? `${typeLabel(type)} — ${a.event_name}` : typeLabel(type));
  const countries = splitCountries(a.area);
  const action = a.severity === 'low' ? t('action.low') : t(`action.${sev}.${type === 'cyclone' || type === 'flood' ? type : 'generic'}`);
  return {
    kind: 'alert',
    id: a.id,
    severity: sev,
    type,
    title,
    eventName: a.event_name || '',
    bodyText: cleanHeadline(a.body || ''),
    bodyIsOdia: false,
    action,
    source: 'official',
    sourceLabel: a.source_label || 'GDACS',
    url: a.url || '',
    lat: a.lat, lon: a.lon,
    distance: dist,
    distanceApprox: false,
    time: a.observed_at || a.updated_at || a.fetched_at || '',
    timeIso: a.updated_at || a.observed_at || a.fetched_at || '',
    ageDays: days == null ? 999 : days,
    ongoing: days != null && days >= ONGOING_DAYS,
    stale: !!a.stale,
    isTest: false,
    region: a.area || '',
    countries,
    relevant: !!a.is_relevant,
    priority: null,
    triageMode: null,
    photo: false,
  };
}

function reportTitle(caption) {
  let text = String(caption || '').trim();
  const urls = text.match(/https?:\/\/\S+/g) || [];
  text = text.replace(/https?:\/\/\S+/g, ' ').replace(new RegExp(`^\\s*${LOC_PREFIX}\\s*[^\\n]*`, 'u'), ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/^#\d+\s*/, '');
  if (!text || text.length < 3) {
    return { title: t('card.untitled'), url: urls[0] || '', empty: true };
  }
  return { title: clampText(text, 120), url: urls[0] || '', empty: false };
}

function extractLocation(caption) {
  const match = String(caption || '').match(new RegExp(`${LOC_PREFIX}\\s*([^\\n]+)`, 'u'));
  return match ? match[1].trim() : '';
}

function incidentToItem(i) {
  const sev = SEV_RANK[i.severity] != null ? i.severity : 'low';
  const type = ({ flood: 'flood', cyclone: 'cyclone', damage: 'damage', medical: 'medical', supply: 'supply' })[i.category] || 'other';
  const { title, url, empty } = reportTitle(i.caption);
  const isTest = /^(test|testing|testtest|test test|demo|asdf|dummy)\b/i.test(String(i.caption || '').trim()) || (empty && !url);
  const explicitLoc = extractLocation(i.caption);
  const inferred = explicitLoc ? (window.SACHET_GEO?.matchPlace(explicitLoc) || null) : (window.SACHET_GEO?.matchPlace(i.caption) || null);
  const dist = inferred ? distTo(inferred.lat, inferred.lon) : null;
  const days = ageDays(i.created_at);
  const odiaSummary = (i.odia_summary || '').trim();
  const nextAction = (i.next_action || '').trim();
  return {
    kind: 'report',
    id: `report-${i.id}`,
    reportId: i.id,
    severity: sev,
    type,
    title,
    bodyText: nextAction,
    bodyIsOdia: false,
    odiaSummary,
    action: nextAction || '',
    source: i.reporter_tg_id ? 'telegram' : 'community',
    sourceLabel: i.reporter_tg_id ? t('src.telegram') : t('src.community'),
    url: url || '',
    lat: inferred ? inferred.lat : null,
    lon: inferred ? inferred.lon : null,
    distance: dist,
    distanceApprox: !!inferred && !explicitLoc,
    explicitLoc,
    time: i.created_at,
    timeIso: i.created_at,
    ageDays: days == null ? 999 : days,
    ongoing: days != null && days >= ONGOING_DAYS,
    stale: false,
    isTest,
    region: inferred ? `${inferred.name}, ${inferred.district}` : '',
    countries: [],
    relevant: true,
    priority: i.priority,
    category: i.category || 'other',
    triageMode: i.triage_mode || null,
    photo: !!i.photo_path,
  };
}

function allItems() {
  return [...state.alerts.map(alertToItem), ...state.incidents.map(incidentToItem)];
}

/* ============================================================ filters / sort */
function passesFilters(item) {
  const f = state.filters;
  if (!state.showTests && item.isTest) return false;
  if (f.sev !== 'all' && item.severity !== f.sev) return false;
  if (f.src === 'official' && item.source !== 'official') return false;
  if (f.src === 'community' && item.source === 'official') return false;
  if (f.type !== 'all') {
    const bucket = TYPE_ORDER.includes(item.type) ? item.type : 'other';
    if (bucket !== f.type) return false;
  }
  return true;
}

function sortItems(items) {
  return items.slice().sort((a, b) => {
    const s = (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3);
    if (s) return s;
    const da = a.distance == null ? Infinity : a.distance;
    const db = b.distance == null ? Infinity : b.distance;
    if (da !== db) return da - db;
    return (a.ageDays ?? 0) - (b.ageDays ?? 0);
  });
}

function countsFor() {
  const base = allItems().filter((it) => (state.showTests ? true : !it.isTest));
  const bySrcType = base.filter((it) => {
    if (state.filters.src === 'official' && it.source !== 'official') return false;
    if (state.filters.src === 'community' && it.source === 'official') return false;
    return true;
  });
  const sevCounts = { all: bySrcType.length, severe: 0, moderate: 0, low: 0 };
  for (const it of bySrcType) sevCounts[it.severity] = (sevCounts[it.severity] || 0) + 1;
  const bySev = base.filter((it) => state.filters.sev === 'all' || it.severity === state.filters.sev);
  const typeCounts = { all: bySev.length };
  for (const it of bySev) {
    const bucket = TYPE_ORDER.includes(it.type) ? it.type : 'other';
    typeCounts[bucket] = (typeCounts[bucket] || 0) + 1;
  }
  const src = {
    all: base.length,
    official: base.filter((it) => it.source === 'official').length,
    community: base.filter((it) => it.source !== 'official').length,
  };
  return { sev: sevCounts, type: typeCounts, src };
}

/* ============================================================ area status */
function computeStatus() {
  const items = allItems().filter((it) => !it.isTest);
  const nearAlerts = items.filter((it) => it.kind === 'alert' && it.distance != null && it.distance <= RADIUS_KM);
  const nearReports = items.filter((it) => it.kind === 'report' &&
    ((it.distance != null && it.distance <= RADIUS_KM) || (it.ageDays != null && it.ageDays <= 1)));
  const near = [...nearAlerts, ...nearReports];
  const worst = (list) => list.reduce((acc, it) => ((SEV_RANK[it.severity] ?? 3) < (SEV_RANK[acc] ?? 3) ? it.severity : acc), 'low');
  const nearWorst = near.length ? worst(near) : null;

  let status = 'safe';
  if (nearWorst === 'severe') status = 'danger';
  else if (nearWorst === 'moderate') status = 'watch';

  const nearestRelevant = sortItems(items.filter((it) => it.kind === 'alert' && it.relevant && it.distance != null))[0];
  if (status === 'safe' && nearestRelevant && (SEV_RANK[nearestRelevant.severity] ?? 3) <= 1 && nearestRelevant.distance <= REGION_WATCH_KM) {
    status = 'watch';
  }
  return { status, near, nearAlerts, nearReports, nearestRelevant, nearWorst };
}

/* ============================================================ card renderers */
function sourceBadge(item) {
  if (item.source === 'official') {
    return `<span class="badge badge--official" title="${escapeHtml(t('src.tooltip'))}">${icon('shield-check', 13)}${escapeHtml(t('src.official'))} ✓</span>`;
  }
  if (item.source === 'telegram') {
    return `<span class="badge badge--telegram">${icon('message', 13)}${escapeHtml(t('src.telegram'))}</span>`;
  }
  return `<span class="badge badge--community">${icon('users', 13)}${escapeHtml(t('src.community'))}</span>`;
}

function triageBadge(item) {
  if (item.kind !== 'report') return '';
  if (item.triageMode === 'gemma') {
    return `<button type="button" class="badge badge--ai badge--btn" data-tip="${escapeHtml(t('triage.ai_tip'))}" aria-label="${escapeHtml(t('triage.ai_tip'))}">${icon('sparkles', 12)}${escapeHtml(t('triage.ai'))}</button>`;
  }
  if (item.triageMode === 'fallback') {
    return `<button type="button" class="badge badge--review badge--btn" data-tip="${escapeHtml(t('triage.review_tip'))}" aria-label="${escapeHtml(t('triage.review_tip'))}">${icon('triangle-alert', 12)}${escapeHtml(t('triage.review'))}</button>`;
  }
  return `<span class="badge badge--ongoing">${icon('clock', 12)}${escapeHtml(t('triage.awaiting'))}</span>`;
}

function metaLine(item) {
  const bits = [];
  if (item.distance != null) {
    bits.push(`<span class="card__dist">${item.distanceApprox ? '≈ ' : ''}${escapeHtml(fmtKm(item.distance))}</span>`);
  } else if (item.kind === 'report') {
    bits.push(`<span class="card__dist">${escapeHtml(t('card.no_location'))}</span>`);
  }
  bits.push(`<span>${escapeHtml(timeAgo(item.timeIso || item.time))}</span>`);
  if (item.ongoing) bits.push(`<span class="badge badge--ongoing">${icon('history', 11)}${escapeHtml(t('time.ongoing', { d: Math.round(item.ageDays) }))}</span>`);
  return bits.join('<span class="card__dotsep" aria-hidden="true"></span>');
}

function countriesHtml(item) {
  if (!item.countries || item.countries.length <= 1) return '';
  const first = item.countries.slice(0, 3);
  const rest = item.countries.slice(3);
  const chips = first.map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join('');
  if (!rest.length) return `<div class="countrychips">${chips}</div>`;
  return `<div class="countrychips" data-countrychips>${chips}<button type="button" class="tag" data-more-countries aria-label="${escapeHtml(t('card.more_countries', { n: rest.length }))}">${escapeHtml(t('card.more_countries', { n: rest.length }))}</button><span hidden data-rest-countries style="display:contents">${rest.map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join('')}</span></div>`;
}

function langBlocks(item) {
  // Body in the user's language first, the other language collapsed.
  const primary = [];
  const alt = [];
  if (item.kind === 'report') {
    const odia = item.odiaSummary;
    const eng = item.title && item.bodyText ? item.bodyText : '';
    if (state.lang === 'or') {
      if (odia) primary.push(`<p class="langblock__primary odia" lang="or">${escapeHtml(odia)}</p>`);
      if (eng) alt.push({ lang: 'en', text: eng });
    } else {
      if (eng) primary.push(`<p class="langblock__primary" lang="en">${escapeHtml(eng)}</p>`);
      if (odia) alt.push({ lang: 'or', text: odia });
    }
  } else {
    if (item.bodyText) primary.push(`<p class="langblock__primary" lang="en">${escapeHtml(item.bodyText)}</p>`);
  }
  let html = primary.length ? `<div class="langblock">${primary.join('')}` : '<div class="langblock">';
  for (const block of alt) {
    html += `<details class="langblock__alt" lang="${block.lang}"><summary>${icon('chevron-right', 13)}${escapeHtml(t('card.show_other', { lang: langName(block.lang) }))}</summary><p>${escapeHtml(block.text)}</p></details>`;
  }
  return `${html}</div>`;
}

function actionBox(item) {
  if (!item.action) return '';
  const isOdia = state.lang === 'or' && item.kind === 'report' && item.odiaSummary;
  return `<div class="actionbox">
    <span class="actionbox__icon">${icon('lightbulb', 20)}</span>
    <div>
      <p class="actionbox__label">${escapeHtml(t('card.what_to_do'))}</p>
      <p class="actionbox__text${isOdia ? ' odia' : ''}"${isOdia ? ' lang="or"' : ''}>${escapeHtml(item.action)}</p>
    </div>
  </div>`;
}

function actionsRow(item, { readAloud = false } = {}) {
  const voted = state.votes[item.id];
  const navUrl = item.lat != null && item.lon != null
    ? `https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lon}` : '';
  const sourceUrl = item.url ? escapeHtml(item.url) : '';
  return `<div class="card__actions">
    <button type="button" class="btn btn--sm" data-act="share" data-id="${escapeHtml(item.id)}">${icon('share-2', 16)}${escapeHtml(t('card.share'))}</button>
    ${navUrl ? `<a class="btn btn--sm" href="${escapeHtml(navUrl)}" target="_blank" rel="noopener">${icon('navigation', 16)}${escapeHtml(t('card.navigate'))}</a>` : ''}
    ${readAloud ? `<button type="button" class="btn btn--sm" data-act="speak" data-id="${escapeHtml(item.id)}">${icon('volume-2', 16)}${escapeHtml(t('card.read_aloud'))}</button>` : ''}
    ${sourceUrl ? `<a class="btn btn--sm" href="${sourceUrl}" target="_blank" rel="noopener" title="${escapeHtml(t('src.verified'))}">${icon('external-link', 16)}${escapeHtml(t('card.official_source'))}</a>` : ''}
    <span class="vote">
      <button type="button" class="btn btn--sm" data-act="vote" data-vote="confirm" data-id="${escapeHtml(item.id)}" aria-pressed="${voted === 'confirm'}" title="${escapeHtml(t('card.vote_hint'))}">${icon('thumbs-up', 16)}<span class="sr-only">${escapeHtml(t('card.confirm'))}</span></button>
      <button type="button" class="btn btn--sm" data-act="vote" data-vote="deny" data-id="${escapeHtml(item.id)}" aria-pressed="${voted === 'deny'}" title="${escapeHtml(t('card.vote_hint'))}">${icon('thumbs-down', 16)}<span class="sr-only">${escapeHtml(t('card.not_accurate'))}</span></button>
    </span>
  </div>`;
}

function cardHtml(item, { variant, expanded, idPrefix = 'card' } = {}) {
  const sevClass = item.severity === 'severe' ? 'card--severe' : item.severity === 'moderate' ? 'card--moderate' : 'card--low';
  const sev = severityMeta(item.severity);
  const bodyId = `${idPrefix}-body-${escapeHtml(item.id)}`;
  const isSevere = item.severity === 'severe';
  const open = expanded || isSevere; // severe is always expanded
  const countryHtml = countriesHtml(item);
  const pressedIds = item.kind === 'alert' ? '' : '';
  const testBadge = item.isTest ? `<span class="badge badge--test">${escapeHtml(t('card.test'))}</span>` : '';
  const photoBadge = item.photo ? `<span class="badge badge--community">${icon('camera', 12)}${escapeHtml(t('card.photo'))}</span>` : '';
  const compact = variant === 'low' || item.severity === 'low';
  return `<article class="card ${sevClass}${variant === 'low' ? ' card--compact' : ''}${item.stale || item.ongoing ? ' card--stale' : ''}"
      data-id="${escapeHtml(item.id)}" data-kind="${item.kind}" data-sev="${escapeHtml(item.severity)}" data-expanded="${open}">
    <span class="card__edge" aria-hidden="true"></span>
    <div class="card__main">
      <div class="card__head">
        <span class="card__sevicon" aria-hidden="true">${icon(sev.icon, isSevere ? 20 : 18)}</span>
        <div class="card__titlewrap">
          <h3 class="card__title">${escapeHtml(item.title)}</h3>
          <p class="card__meta">
            <span class="card__type">${icon(typeIcon(item.type), 13)}${escapeHtml(typeLabel(item.type))}</span>
            <span class="card__dotsep" aria-hidden="true"></span>
            ${metaLine(item)}
          </p>
          <p class="card__meta" style="margin-top:6px">
            ${sourceBadge(item)}
            ${triageBadge(item)}
            ${testBadge}${photoBadge}
          </p>
        </div>
        ${isSevere ? '' : `<button type="button" class="card__toggle" aria-expanded="${open}" aria-controls="${bodyId}" data-act="toggle" data-id="${escapeHtml(item.id)}">
          <span class="sr-only">${escapeHtml(open ? t('card.collapse') : t('card.expand'))}</span>${icon('chevron-down', 20)}
        </button>`}
      </div>
    </div>
    <div class="card__body" id="${bodyId}" ${open ? '' : 'hidden'} data-body-for="${escapeHtml(item.id)}">
      ${langBlocks(item)}
      ${countryHtml}
      ${actionBox(item)}
      ${actionsRow(item, { readAloud: isSevere })}
    </div>
  </article>`;
}

/* ============================================================ filter bar */
function filterBarHtml() {
  const counts = countsFor();
  const sevChips = [
    ['all', t('filters.all'), counts.sev.all, null],
    ['severe', t('filters.severe'), counts.sev.severe || 0, 'severe'],
    ['moderate', t('filters.moderate'), counts.sev.moderate || 0, 'moderate'],
    ['low', t('filters.low'), counts.sev.low || 0, 'low'],
  ].map(([val, label, count, sev]) => `
    <button type="button" class="chip chip--sev" data-filter="sev" data-value="${val}" data-sev="${sev || ''}" aria-pressed="${state.filters.sev === val}">
      ${sev ? '<span class="chip__dot" aria-hidden="true"></span>' : ''}${escapeHtml(label)}<span class="chip__count">${count}</span>
    </button>`).join('');

  const types = TYPE_ORDER.filter((ty) => (counts.type[ty] || 0) > 0 || state.filters.type === ty);
  const typeChips = types.map((ty) => `
    <button type="button" class="chip" data-filter="type" data-value="${ty}" aria-pressed="${state.filters.type === ty}">
      ${icon(typeIcon(ty), 14)}${escapeHtml(typeLabel(ty))}<span class="chip__count">${counts.type[ty] || 0}</span>
    </button>`).join('');

  const srcChips = [
    ['all', t('filters.everything'), counts.src.all],
    ['official', t('filters.official'), counts.src.official],
    ['community', t('filters.community'), counts.src.community],
  ].map(([val, label, count]) => `
    <button type="button" class="chip" data-filter="src" data-value="${val}" aria-pressed="${state.filters.src === val}">
      ${escapeHtml(label)}<span class="chip__count">${count}</span>
    </button>`).join('');

  const secondary = (state.filters.type !== 'all' ? 1 : 0) + (state.filters.src !== 'all' ? 1 : 0);
  const open = !!state.filtersOpen;
  const moreLabel = open ? t('filters.less') : t('filters.more');

  return `
    <div class="filterbar__row" role="group" aria-label="${escapeHtml(t('filters.label'))}">
      ${sevChips}
      <button type="button" class="chip chip--more" data-act="toggle-filters" aria-expanded="${open}">
        ${icon('sliders-horizontal', 14)}${escapeHtml(moreLabel)}${secondary ? `<span class="chip__count">${secondary}</span>` : ''}
      </button>
    </div>
    <div class="filterbar__extra"${open ? '' : ' hidden'}>
      <div class="filterbar__row" role="group" aria-label="${escapeHtml(t('filters.type'))}">
        <span class="filterbar__label">${escapeHtml(t('filters.type'))}</span>${typeChips}
      </div>
      <div class="filterbar__row" role="group" aria-label="${escapeHtml(t('filters.label'))}">
        ${srcChips}
      </div>
      <div class="filterbar__foot">
        <span>${escapeHtml(t('filters.applies'))}</span>
        <button type="button" class="link-btn" data-act="clear-filters">${escapeHtml(t('filters.clear'))}</button>
      </div>
    </div>`;
}

function renderFilters() {
  for (const bar of $$('[data-filterbar]')) {
    bar.innerHTML = filterBarHtml();
  }
}

/* ============================================================ sections */
function sectionHead(id, iconName, title, sub, count) {
  return `<div class="feed__head">
    <div class="feed__heading">
      ${icon(iconName, 20)}
      <div>
        <h2 class="feed__title" id="${id}">${escapeHtml(title)}</h2>
        ${sub ? `<p class="feed__sub">${escapeHtml(sub)}</p>` : ''}
      </div>
    </div>
    ${count != null ? `<span class="feed__count">${count}</span>` : ''}
  </div>`;
}

function emptyState(iconName, title, body) {
  return `<div class="emptystate">${icon(iconName, 28)}<p class="emptystate__title">${escapeHtml(title)}</p>${body ? `<p class="emptystate__body">${escapeHtml(body)}</p>` : ''}</div>`;
}

function errorState() {
  return `<div class="errstate">${icon('wifi-off', 28)}<p class="errstate__title">${escapeHtml(t('state.error_title'))}</p><p class="errstate__body">${escapeHtml(t('state.error_body'))}</p><button type="button" class="btn btn--solid" data-act="retry">${icon('refresh-cw', 16)}${escapeHtml(t('state.retry'))}</button></div>`;
}

function skeletonCards(n = 3) {
  return Array.from({ length: n }, () => `<div class="skel"><div class="skel__line skel__line--title"></div><div class="skel__line"></div><div class="skel__line skel__line--short"></div></div>`).join('');
}

/** Windowed rendering: shows CHUNK items, appends more on scroll. */
function mountList(container, items, opts = {}) {
  container._items = items;
  container._shown = Math.min(items.length, opts.chunk || CHUNK);
  container._opts = opts;
  renderWindow(container);
}

function renderWindow(container) {
  const items = container._items || [];
  const opts = container._opts || {};
  const shown = container._shown || 0;
  const slice = items.slice(0, shown);
  const html = slice.map((it) => cardHtml(it, {
    variant: it.severity === 'low' ? 'low' : it.severity === 'moderate' ? 'moderate' : 'severe',
    expanded: opts.expanded,
    idPrefix: opts.idPrefix || 'c',
  })).join('');
  const more = items.length - shown;
  container.innerHTML = html + (more > 0
    ? `<div class="cards__more" data-more="${more}"><button type="button" class="btn" data-act="more">${icon('chevron-down', 16)}${escapeHtml(t('card.more_items', { n: more }))}</button></div>`
    : '');
}

/* ============================================================ hero */
function heroHtml() {
  const { status, nearReports, nearestRelevant, nearWorst } = computeStatus();
  const label = status === 'danger' ? t('hero.danger') : status === 'watch' ? t('hero.watch') : t('hero.safe');
  const action = status === 'danger' ? t('hero.danger_action') : status === 'watch' ? t('hero.watch_action') : t('hero.safe_action');
  const heroIcon = status === 'danger' ? 'shield-alert' : status === 'watch' ? 'bell' : 'shield-check';
  const chips = [];
  if (nearestRelevant && nearestRelevant.distance != null) {
    chips.push(`<span class="hero__chip">${icon('map-pin', 14)}${escapeHtml(t('hero.nearest'))}: ${escapeHtml(nearestRelevant.eventName || typeLabel(nearestRelevant.type))} · ${escapeHtml(t('hero.away', { km: Math.round(nearestRelevant.distance) }))}</span>`);
  }
  if (nearReports.length) {
    chips.push(`<span class="hero__chip">${icon('users', 14)}${escapeHtml(t('hero.reports_near', { n: nearReports.length }))}</span>`);
  }
  const updated = state.lastSync ? t('hero.updated', { when: timeAgo(state.lastSync) }) : '';
  return `<section class="hero hero--${status}" aria-label="${escapeHtml(t('hero.your_area'))}">
    <p class="hero__eyebrow">${icon('map-pin', 14)}${escapeHtml(t('hero.your_area'))} · ${escapeHtml(state.place.name)}, ${escapeHtml(state.place.district)} <span class="badge badge--ongoing">${escapeHtml(t('hero.radius', { km: RADIUS_KM }))}</span></p>
    <div class="hero__top">
      <span class="hero__icon" aria-hidden="true">${icon(heroIcon, 28)}</span>
      <div>
        <p class="hero__status">${escapeHtml(label)}</p>
        <p class="sr-only" role="status" aria-live="assertive">${escapeHtml(t('a11y.hero', { status: label }))}</p>
      </div>
    </div>
    <p class="hero__action">${escapeHtml(action)}</p>
    ${chips.length ? `<div class="hero__chips">${chips.join('')}</div>` : ''}
    <p class="hero__verify">${icon('info', 16)}${escapeHtml(t('hero.verify'))}${updated ? `<span class="hero__updated">${escapeHtml(updated)}</span>` : ''}</p>
  </section>`;
}

/* ============================================================ safety prompt card */
function safetyPromptHtml() {
  const { status } = computeStatus();
  if (status !== 'danger' && status !== 'watch') return '';
  const pack = state.pack;
  const quick = (pack?.emergency || []).slice(0, 3);
  const numbers = quick.map((n) => `<a class="btn btn--sm" href="tel:${escapeHtml(n.number)}">${icon('phone', 15)}${escapeHtml(n.number)}</a>`).join('');
  return `<div class="safetycard">
    <span class="safetycard__icon">${icon('backpack', 26)}</span>
    <div class="safetycard__body">
      <p class="safetycard__title">${escapeHtml(t(status === 'danger' ? 'safety.when_danger' : 'safety.when_watch'))}</p>
      <p class="safetycard__sub">${escapeHtml(t('safety.subtitle'))}</p>
      <div class="safetycard__numbers">
        <button type="button" class="btn btn--sm btn--warn" data-act="go-safety">${icon('backpack', 15)}${escapeHtml(t('safety.open'))}</button>
        ${numbers}
      </div>
    </div>
  </div>`;
}

/* ============================================================ severe banner */
function renderBanner() {
  const el = $('#severe-banner');
  if (!el) return;
  const { status } = computeStatus();
  const severe = status === 'danger'
    ? allItems()
      .filter((it) => it.severity === 'severe' && !it.isTest && it.distance != null && it.distance <= RADIUS_KM)
      .sort((a, b) => a.distance - b.distance)[0]
    : null;
  if (!severe || state.ackBanner === severe.id) { el.hidden = true; return; }
  el.hidden = false;
  const iconSlot = el.querySelector('.severe-banner__icon');
  if (iconSlot) iconSlot.innerHTML = icon('triangle-alert', 24);
  $('#severe-banner-msg').textContent = `${severe.title}${severe.distance != null ? ` · ${fmtKm(severe.distance)}` : ''}`;
  $('#severe-banner').dataset.sevId = severe.id;
}

/* ============================================================ home sections */
function renderHome() {
  const home = $('#view-home');
  const hero = $('#hero-slot');
  if (hero) hero.innerHTML = heroHtml();
  const safetySlot = $('#safety-prompt-slot');
  if (safetySlot) safetySlot.innerHTML = safetyPromptHtml();

  const items = allItems();
  const visible = items.filter(passesFilters);

  // (1) Near you
  const near = visible.filter((it) => {
    if (it.kind === 'alert') return it.distance != null && it.distance <= RADIUS_KM;
    return (it.distance != null && it.distance <= RADIUS_KM) || (it.ageDays != null && it.ageDays <= 1);
  });
  const nearList = $('#list-near');
  if (nearList) {
    $('#count-near') && ($('#count-near').textContent = String(near.length));
    if (!state.loading && !near.length) {
      nearList.innerHTML = emptyState('shield-check', t('hero.no_alerts'), t('sec.none_near'));
    } else if (near.length) {
      mountList(nearList, sortItems(near), { idPrefix: 'near' });
    } else {
      nearList.innerHTML = skeletonCards(2);
    }
  }

  // (2) Official alerts (regional, not near) — active + ongoing
  const officialAll = visible.filter((it) => it.kind === 'alert' && it.relevant &&
    !(it.distance != null && it.distance <= RADIUS_KM));
  const officialActive = sortItems(officialAll.filter((it) => !it.ongoing));
  const officialOngoing = sortItems(officialAll.filter((it) => it.ongoing));
  const officialList = $('#list-official');
  if (officialList) {
    if (!state.loading && !officialActive.length) {
      officialList.innerHTML = emptyState('shield-check', t('state.empty_alerts'), state.filters.src === 'community' ? t('sec.no_match') : '');
    } else if (officialActive.length) {
      mountList(officialList, officialActive, { idPrefix: 'off' });
    } else if (state.loading) {
      officialList.innerHTML = skeletonCards(2);
    }
  }
  const ongoing = $('#details-ongoing');
  if (ongoing) {
    ongoing.hidden = officialOngoing.length === 0;
    $('#ongoing-count') && ($('#ongoing-count').textContent = String(officialOngoing.length));
    const list = $('#list-ongoing');
    if (list && officialOngoing.length) mountList(list, officialOngoing, { idPrefix: 'ong' });
  }

  // (3) Elsewhere / global (collapsed)
  const globalItems = sortItems(visible.filter((it) => it.kind === 'alert' && !it.relevant));
  const globalDetails = $('#details-global');
  if (globalDetails) {
    globalDetails.hidden = globalItems.length === 0;
    $('#global-count') && ($('#global-count').textContent = String(globalItems.length));
    const list = $('#list-global');
    if (list && globalItems.length) mountList(list, globalItems, { idPrefix: 'glob' });
  }

  // tests note
  const testCount = allItems().filter((it) => it.isTest).length;
  const testsNote = $('#tests-note');
  if (testsNote) {
    if (!testCount) { testsNote.hidden = true; testsNote.innerHTML = ''; }
    else {
      testsNote.hidden = false;
      testsNote.innerHTML = `<span class="collapse__sub">${escapeHtml(t('sec.tests_hidden', { n: testCount }))}</span><button type="button" class="link-btn" data-act="toggle-tests">${escapeHtml(state.showTests ? t('sec.hide_tests') : t('sec.show_tests'))}</button>`;
    }
  }

  renderFilters();
  renderNewPill();
  return home;
}

/* ============================================================ reports view */
function renderReports() {
  const view = $('#view-reports');
  const items = allItems().filter((it) => it.kind === 'report' && passesFilters(it));
  const list = $('#list-reports');
  const count = $('#count-reports');
  if (count) count.textContent = String(items.length);
  if (list) {
    if (!items.length) list.innerHTML = emptyState('message', t('state.empty_reports'), state.filters.src === 'official' ? t('sec.no_match') : '');
    else mountList(list, sortItems(items), { idPrefix: 'rep' });
  }
  renderFilters();
}

/* ============================================================ new items pill */
function renderNewPill() {
  const slot = $('#newpill-slot');
  if (!slot) return;
  if (state.newCount > 0) {
    slot.innerHTML = `<div class="newpill"><button type="button" class="newpill__btn" data-act="jump-new">${icon('arrow-up', 16)}${escapeHtml(t('newitems.pill', { n: state.newCount }))}</button></div>`;
  } else slot.innerHTML = '';
}

/* ============================================================ safety pack */
function renderSafety() {
  const el = $('#safety-content');
  if (!el) return;
  el.dataset.lang = state.lang;
  if (state.packMissing || (!state.pack && !state.loading)) {
    el.innerHTML = `<div class="emptystate">${icon('backpack', 28)}<p class="emptystate__title">${escapeHtml(t('safety.title'))}</p><p class="emptystate__body">${escapeHtml(t('safety.offline_missing'))}</p></div>`;
    return;
  }
  if (!state.pack) { el.innerHTML = `<p class="feed__sub">${escapeHtml(t('safety.loading'))}</p>`; return; }
  const pack = state.pack;
  const isOdia = state.lang === 'or';
  const pick = (o) => escapeHtml(isOdia ? o.or : o.en);
  const numbers = (pack.emergency || []).map((n) => `
    <a class="number" href="tel:${escapeHtml(n.number)}">
      <b>${escapeHtml(n.number)}</b>
      <span${isOdia ? ' lang="or"' : ''}>${escapeHtml(isOdia ? n.label_or : n.label_en)}</span>
      <span class="number__call"${isOdia ? ' lang="or"' : ''}>${icon('phone', 13)}${escapeHtml(t('safety.call', { n: n.number }))}</span>
    </a>`).join('');
  const list = (items, kind) => `<ul class="list ${kind}"${isOdia ? ' lang="or"' : ''}>${items.map((it) => `<li>${pick(it)}</li>`).join('')}</ul>`;

  el.innerHTML = `
    <div class="safety">
      <div class="safety__banner">
        <span>${icon('backpack', 26)}</span>
        <div>
          <p><strong>${escapeHtml(t('safety.title'))}</strong></p>
          <p class="feed__sub">${escapeHtml(t('safety.subtitle'))}</p>
        </div>
      </div>
      <section class="safety__section" aria-labelledby="safety-helplines">
        <h2 class="safety__h" id="safety-helplines">${icon('phone', 20)}${escapeHtml(t('safety.helplines'))}</h2>
        <div class="numbers">${numbers}</div>
      </section>
      <section class="safety__section" aria-labelledby="safety-do">
        <h2 class="safety__h" id="safety-do">${icon('check-circle', 20)}${escapeHtml(t('safety.do'))}</h2>
        ${list(pack.do || [], 'do')}
      </section>
      <section class="safety__section" aria-labelledby="safety-dont">
        <h2 class="safety__h" id="safety-dont">${icon('x-circle', 20)}${escapeHtml(t('safety.dont'))}</h2>
        ${list(pack.dont || [], 'dont')}
      </section>
      <section class="safety__section" aria-labelledby="safety-gobag">
        <h2 class="safety__h" id="safety-gobag">${icon('backpack', 20)}${escapeHtml(t('safety.gobag'))}</h2>
        ${list(pack.checklist || [], 'do')}
      </section>
      <p class="notice"${isOdia ? ' lang="or"' : ''}>${escapeHtml((isOdia ? pack.notice_or : pack.notice_en) || t('safety.notice_fallback'))}</p>
    </div>`;
}

/* ============================================================ map */
const MAP = { W: 360, H: 430, SCALE: 42 };

function project(lat, lon) {
  const k = Math.cos((state.map.lat * Math.PI) / 180);
  const x = (lon - state.map.lon) * MAP.SCALE * k * state.map.zoom + MAP.W / 2;
  const y = -(lat - state.map.lat) * MAP.SCALE * state.map.zoom + MAP.H / 2;
  return [x, y];
}
function unprojectDelta(dx, dy) {
  const k = Math.cos((state.map.lat * Math.PI) / 180);
  return [(-dy / (MAP.SCALE * state.map.zoom)), (dx / (MAP.SCALE * k * state.map.zoom))];
}

function renderMap() {
  const svg = $('#map-svg');
  if (!svg) return;
  const geo = window.SACHET_GEO;
  const parts = [];
  parts.push(`<rect x="0" y="0" width="${MAP.W}" height="${MAP.H}" class="mapcanvas__sea"/>`);

  // graticule
  const graticule = [];
  for (let lat = 14; lat <= 24; lat += 2) {
    const [, y] = project(lat, state.map.lon);
    if (y > -10 && y < MAP.H + 10) graticule.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${MAP.W}" y2="${y.toFixed(1)}" class="mapcanvas__grid"/>`);
  }
  for (let lon = 78; lon <= 92; lon += 2) {
    const [x] = project(state.map.lat, lon);
    if (x > -10 && x < MAP.W + 10) graticule.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${MAP.H}" class="mapcanvas__grid"/>`);
  }
  parts.push(graticule.join(''));

  // coastline / outline
  if (geo?.outline) {
    const pts = geo.outline.map(([lat, lon]) => project(lat, lon).map((n) => n.toFixed(1)).join(',')).join(' ');
    parts.push(`<polygon class="mapcanvas__land" points="${pts}"/>`);
  }
  if (geo?.seaLabel) {
    // fixed corner caption in the sea — never collides with the pin rail or labels
    parts.push(`<text class="mapcanvas__sealabel" x="${MAP.W / 2}" y="${MAP.H - 10}" text-anchor="middle">${escapeHtml(geo.seaLabel.name)}</text>`);
  }

  // cities
  if (geo?.cities && state.map.zoom >= 1) {
    for (const [name, , lat, lon] of geo.cities) {
      const [x, y] = project(lat, lon);
      if (x < 4 || x > MAP.W - 4 || y < 4 || y > MAP.H - 4) continue;
      parts.push(`<circle class="mapcanvas__citydot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.6"/>`);
      if (state.map.zoom >= 1.6) parts.push(`<text class="mapcanvas__city" x="${(x + 4).toFixed(1)}" y="${(y + 2).toFixed(1)}">${escapeHtml(name)}</text>`);
    }
  }

  // "near you" radius ring
  const [ux, uy] = project(state.place.lat, state.place.lon);
  const ringR = ((RADIUS_KM / 111) * MAP.SCALE * state.map.zoom);
  parts.push(`<circle class="mapcanvas__radius" cx="${ux.toFixed(1)}" cy="${uy.toFixed(1)}" r="${ringR.toFixed(1)}"/>`);

  // items
  const visible = allItems().filter(passesFilters);
  const pins = [];
  let outOfView = 0;
  const clusters = new Map();
  const zoomedOut = state.map.zoom < 1.5;
  for (const it of visible) {
    if (it.lat == null || it.lon == null) continue;
    const [x, y] = project(it.lat, it.lon);
    if (x < -8 || x > MAP.W + 8 || y < -8 || y > MAP.H + 8) { outOfView += 1; continue; }
    // cyclone impact circle
    if (it.type === 'cyclone' && (it.severity === 'severe' || it.severity === 'moderate')) {
      const r = it.severity === 'severe' ? 96 : 62;
      parts.push(`<circle class="mapcanvas__cone" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/>`);
    }
    if (zoomedOut) {
      const key = `${Math.round(x / 40)}:${Math.round(y / 40)}`;
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push({ it, x, y });
    } else {
      pins.push({ it, x, y });
    }
  }
  const color = (sev) => (sev === 'severe' ? 'var(--sev-severe)' : sev === 'moderate' ? 'var(--sev-moderate)' : 'var(--sev-low)');
  for (const [, group] of clusters) {
    if (group.length === 1) { pins.push(group[0]); continue; }
    const cx = group.reduce((s, g) => s + g.x, 0) / group.length;
    const cy = group.reduce((s, g) => s + g.y, 0) / group.length;
    const worst = group.map((g) => g.it.severity).sort((a, b) => (SEV_RANK[a] ?? 3) - (SEV_RANK[b] ?? 3))[0];
    parts.push(`<g class="mapcanvas__pin" data-cluster="${group.length}" data-lat="${(group[0].it.lat).toFixed(3)}" data-lon="${(group[0].it.lon).toFixed(3)}">
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="13" fill="${color(worst)}" stroke="#fff" stroke-width="1.6"/>
      <text class="mapcanvas__pinlabel" x="${cx.toFixed(1)}" y="${(cy + 3).toFixed(1)}" text-anchor="middle" fill="#fff">${group.length}</text>
    </g>`);
  }
  for (const { it, x, y } of pins) {
    const official = it.source === 'official';
    pins.length; // noop
    parts.push(`<g class="mapcanvas__pin" data-pin="${escapeHtml(it.id)}" role="button" tabindex="0" aria-label="${escapeHtml(t('a11y.sev', { sev: t(`sev.${it.severity}_short`) }) + ': ' + it.title)}">
      ${official ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" class="mapcanvas__pinring" stroke="${color(it.severity)}"/>` : ''}
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="${color(it.severity)}" stroke="#fff" stroke-width="1.4"/>
      ${official ? '' : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.8" fill="#fff"/>`}
    </g>`);
  }

  // user marker on top
  parts.push(`<circle class="mapcanvas__youhalo" cx="${ux.toFixed(1)}" cy="${uy.toFixed(1)}" r="7"/>
    <circle class="mapcanvas__you" cx="${ux.toFixed(1)}" cy="${uy.toFixed(1)}" r="4.5"/>`);

  svg.setAttribute('viewBox', `0 0 ${MAP.W} ${MAP.H}`);
  svg.innerHTML = parts.join('');

  const legend = $('#map-legend');
  if (legend) {
    legend.innerHTML = `
      <span class="map-legend__item"><span class="map-legend__swatch" style="background:var(--sev-severe)"></span>${escapeHtml(t('sev.severe_short'))}</span>
      <span class="map-legend__item"><span class="map-legend__swatch" style="background:var(--sev-moderate)"></span>${escapeHtml(t('sev.moderate_short'))}</span>
      <span class="map-legend__item"><span class="map-legend__swatch" style="background:var(--sev-low)"></span>${escapeHtml(t('sev.low_short'))}</span>
      <span class="map-legend__item" style="color:var(--accent)"><span class="map-legend__swatch map-legend__swatch--ring"></span>${escapeHtml(t('map.you'))}</span>`;
  }
  const note = $('#map-note');
  if (note) {
    const bits = [t('map.stylized'), t('map.tap_pin')];
    if (outOfView) bits.push(t('map.out_of_view', { n: outOfView }));
    const hiddenByFilters = allItems().filter((it) => !passesFilters(it) && it.lat != null).length;
    if (hiddenByFilters) bits.push(t('map.filtered', { n: hiddenByFilters }));
    note.textContent = bits.join(' · ');
  }

  // selected pin sheet
  renderMapSheet();
}

function renderMapSheet() {
  const sheet = $('#map-sheet');
  if (!sheet) return;
  const item = allItems().find((it) => it.id === state.selectedMapId);
  if (!item) { sheet.hidden = true; sheet.innerHTML = ''; return; }
  sheet.hidden = false;
  sheet.innerHTML = `
    <div class="map-sheet__head"><span>${icon('map-pin', 14)}${escapeHtml(t('map.details'))}</span>
      <button type="button" class="iconbtn iconbtn--sm" data-act="close-map-sheet" aria-label="${escapeHtml(t('report.close'))}">${icon('x', 18)}</button></div>
    ${cardHtml(item, { expanded: true, idPrefix: 'mapsel' })}`;
}

/* ============================================================ chrome / i18n */
function applyStaticI18n(root = document) {
  for (const el of $$('[data-i18n]', root)) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of $$('[data-i18n-aria]', root)) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
  for (const el of $$('[data-i18n-ph]', root)) {
    el.setAttribute('placeholder', t(el.dataset.i18nPh));
  }
  for (const el of $$('[data-i18n-alt]', root)) {
    el.setAttribute('alt', t(el.dataset.i18nAlt));
  }
  document.documentElement.lang = state.lang;
}

function renderChrome() {
  const pill = $('#conn-pill');
  const text = $('#conn-text');
  if (pill && text) {
    if (state.online) {
      pill.dataset.online = 'true';
      const when = state.lastSync ? t('conn.last_synced', { when: timeAgo(state.lastSync) }) : '';
      text.innerHTML = `${escapeHtml(t('conn.online'))}${when ? `<span class="connpill__when"> · ${escapeHtml(when)}</span>` : ''}`;
      pill.title = t('conn.tap_refresh');
      pill.setAttribute('aria-label', `${t('conn.online')}. ${t('conn.tap_refresh')}`);
    } else {
      pill.dataset.online = 'false';
      text.textContent = state.cached ? t('conn.offline') : t('conn.offline');
      pill.title = t('conn.offline_body', { when: state.lastSync ? timeAgo(state.lastSync) : t('conn.never') });
      pill.setAttribute('aria-label', pill.title);
    }
  }
  const strip = $('#offline-strip');
  if (strip) {
    strip.hidden = state.online;
    if (!state.online) {
      $('#offline-strip-text').textContent = state.lastSync
        ? t('conn.cached', { when: timeAgo(state.lastSync) })
        : t('conn.offline_no_data');
    }
  }
  const locText = $('#loc-text');
  if (locText) {
    locText.innerHTML = `${escapeHtml(state.place.name)}, ${escapeHtml(state.place.district)}`;
  }
  const themeBtn = $('#theme-btn');
  if (themeBtn) {
    const themeIcon = state.theme === 'dark' ? 'moon' : state.theme === 'light' ? 'sun' : 'contrast';
    themeBtn.innerHTML = icon(themeIcon, 20);
    themeBtn.title = t('theme.toggle', { mode: t(`theme.${state.theme}`) });
    themeBtn.setAttribute('aria-label', themeBtn.title);
  }
  for (const btn of $$('[data-lang-btn]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.langBtn === state.lang));
  }
  const langToggle = $('#lang-toggle');
  if (langToggle) {
    const next = otherLang();
    langToggle.textContent = langName(next);
    langToggle.setAttribute('aria-label', t('lang.switch_to', { lang: langName(next) }));
    langToggle.title = langToggle.getAttribute('aria-label');
    if (next === 'or') langToggle.setAttribute('lang', 'or');
    else langToggle.removeAttribute('lang');
  }
  for (const btn of $$('[data-nav]')) {
    const active = (btn.dataset.nav === 'report') ? false : btn.dataset.nav === state.view;
    if (active) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  }
  for (const btn of $$('[data-view-btn]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.viewBtn === state.view));
  }
  const demo = $('#demo-note');
  if (demo) { demo.hidden = !state.demo; if (state.demo) demo.textContent = t('state.demo'); }
  for (const badge of $$('[data-tip]')) badge.setAttribute('title', badge.dataset.tip);
}

/* ============================================================ render orchestrator */
function render() {
  renderChrome();
  renderBanner();
  renderHome();
  renderReports();
  renderSafety();
  renderMap();
  applyStaticI18n(document);
  const nearSub = $('#sec-near-sub');
  if (nearSub) nearSub.textContent = t('sec.near_sub', { km: RADIUS_KM });
  measureTopbar();
  renderChrome();
}

function measureTopbar() {
  const top = document.querySelector('.topbar');
  if (top) document.documentElement.style.setProperty('--appbar-h', `${top.offsetHeight}px`);
}

/* ============================================================ data loading */
async function loadAll({ silent = false, refresh = false } = {}) {
  if (!silent) {
    state.loading = true;
    const near = $('#list-near'); if (near && !near.children.length) near.innerHTML = skeletonCards(2);
  }
  if (refresh) {
    const pill = $('#conn-text');
    if (pill && state.online) pill.textContent = t('conn.refreshing');
  }
  const jobs = [
    getJson(`/api/alerts?limit=100${refresh ? '&refresh=true' : ''}`),
    getJson('/api/incidents?limit=200'),
    getJson('/api/safetypack'),
  ];
  const results = await Promise.allSettled(jobs);

  let ok = false;
  if (results[0].status === 'fulfilled') {
    state.alerts = results[0].value.alerts || [];
    state.demo = !!results[0].value.demo;
    state.lastSync = results[0].value.fetched_at || new Date().toISOString();
    await kvSet('alerts', results[0].value); ok = true;
  } else {
    const cached = await kvGet('alerts');
    if (cached) { state.alerts = cached.alerts || []; state.cached = true; state.lastSync = cached.fetched_at || state.lastSync; ok = true; }
  }
  if (results[1].status === 'fulfilled') {
    state.incidents = results[1].value.incidents || [];
    await kvSet('incidents', results[1].value); ok = true;
  } else {
    const cached = await kvGet('incidents');
    if (cached) { state.incidents = cached.incidents || []; state.cached = true; ok = true; }
  }
  if (results[2].status === 'fulfilled') {
    state.pack = results[2].value; state.packMissing = false;
    await kvSet('pack', results[2].value);
  } else {
    state.pack = await kvGet('pack');
    state.packMissing = !state.pack;
  }

  state.error = !ok;
  state.loading = false;
  if (ok) { detectNewItems(); await kvSet('lastSync', state.lastSync); }
  render();
}

function detectNewItems() {
  const fresh = allItems()
    .filter((it) => (SEV_RANK[it.severity] ?? 3) <= 1 && !it.isTest)
    .map((it) => it.id);
  const unseen = fresh.filter((id) => !state.seenIds.includes(id));
  if (state.seenIds.length && unseen.length) {
    state.newCount = unseen.length;
    const top = allItems().find((it) => it.id === unseen[0]);
    if (top && top.severity === 'severe') { haptic([30, 40, 30]); announce(t('a11y.new_severe', { title: top.title }), true); }
  }
}

async function commitSeen() {
  state.seenIds = allItems().filter((it) => (SEV_RANK[it.severity] ?? 3) <= 1).map((it) => it.id).slice(0, 100);
  state.newCount = 0;
  await kvSet('seenIds', state.seenIds);
  renderNewPill();
}

/* ============================================================ interactions: filters/cards */
function wireMain() {
  $('#main').addEventListener('click', (event) => {
    const filterBtn = event.target.closest('[data-filter]');
    if (filterBtn) {
      const key = filterBtn.dataset.filter; // sev | type | src
      state.filters[key] = filterBtn.dataset.value;
      announce(t('a11y.filters', { summary: `${state.filters.sev}/${state.filters.type}/${state.filters.src}` }));
      renderHome(); renderReports(); renderMap();
      return;
    }
    const act = event.target.closest('[data-act]');
    if (act) { handleAction(act, event); return; }
    const more = event.target.closest('[data-more-countries]');
    if (more) { toggleCountries(more); return; }
    const cluster = event.target.closest('[data-cluster]');
    if (cluster) { zoomTo(parseFloat(cluster.dataset.lat), parseFloat(cluster.dataset.lon), 2.4); return; }
    const pin = event.target.closest('[data-pin]');
    if (pin) { state.selectedMapId = pin.dataset.pin; renderMapSheet(); haptic(10); return; }
  });

  // keyboard for map pins / clusters
  $('#main').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const pin = event.target.closest?.('[data-pin]');
    if (pin) { event.preventDefault(); state.selectedMapId = pin.dataset.pin; renderMapSheet(); }
    const cluster = event.target.closest?.('[data-cluster]');
    if (cluster) { event.preventDefault(); zoomTo(parseFloat(cluster.dataset.lat), parseFloat(cluster.dataset.lon), 2.4); }
  });
}

function toggleCountries(btn) {
  const wrap = btn.closest('[data-countrychips]');
  const rest = wrap?.querySelector('[data-rest-countries]');
  if (!rest) return;
  const hidden = rest.hidden;
  rest.hidden = !hidden;
  btn.textContent = hidden ? t('card.less_countries') : t('card.more_countries', { n: rest.children.length });
}

function handleAction(btn) {
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const item = id ? allItems().find((it) => it.id === id) : null;
  switch (act) {
    case 'toggle': toggleCard(btn, item); break;
    case 'share': shareItem(item); break;
    case 'speak': speakItem(item, btn); break;
    case 'vote': voteItem(btn, id); break;
    case 'more': {
      const container = btn.closest('[data-more]')?.parentElement || btn.parentElement.parentElement;
      if (container) { container._shown = (container._shown || CHUNK) + CHUNK; renderWindow(container); }
      break;
    }
    case 'retry': loadAll({ refresh: true }); break;
    case 'go-safety': setView('safety'); break;
    case 'toggle-tests': state.showTests = !state.showTests; renderHome(); renderReports(); renderMap(); break;
    case 'toggle-filters': {
      state.filtersOpen = !state.filtersOpen;
      renderFilters();
      const trigger = $(`#view-${state.view} [data-act="toggle-filters"]`) || $('[data-act="toggle-filters"]');
      trigger?.focus({ preventScroll: true });
      break;
    }
    case 'clear-filters':
      state.filters = { sev: 'all', type: 'all', src: 'all' };
      renderHome(); renderReports(); renderMap();
      announce(t('a11y.filters', { summary: `${state.filters.sev}/${state.filters.type}/${state.filters.src}` }));
      break;
    case 'jump-new': window.scrollTo({ top: 0, behavior: scrollBehavior() }); commitSeen(); break;
    case 'close-map-sheet': state.selectedMapId = null; renderMapSheet(); break;
    case 'ack-banner': ackBanner(); break;
    default: break;
  }
}

async function ackBanner() {
  const banner = $('#severe-banner');
  state.ackBanner = banner?.dataset.sevId || null;
  await kvSet('ackBanner', state.ackBanner);
  renderBanner();
}

function toggleCard(btn, item) {
  const card = btn.closest('.card');
  if (!card) return;
  const open = card.dataset.expanded !== 'true';
  card.dataset.expanded = String(open);
  btn.setAttribute('aria-expanded', String(open));
  const body = card.querySelector('.card__body');
  if (body) body.hidden = !open;
  announce(t(open ? 'a11y.expanded' : 'a11y.collapsed', { title: item?.title || '' }));
}

async function shareItem(item) {
  if (!item) return;
  const text = `${item.title}${item.distance != null ? ` · ${fmtKm(item.distance)}` : ''} — ${item.source === 'official' ? t('src.official') : t('src.community')}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'SachetSathi', text, url: item.url || undefined }); return; }
    await navigator.clipboard.writeText(`${text}${item.url ? ` ${item.url}` : ''}`);
    toast(t('card.share') + ' ✓');
  } catch (error) { if (error?.name !== 'AbortError') console.warn('share failed', error); }
}

function speakItem(item, btn) {
  if (!item || !('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  if (synth.speaking) { synth.cancel(); btn.innerHTML = `${icon('volume-2', 16)}${escapeHtml(t('card.read_aloud'))}`; return; }
  const parts = [item.title];
  if (item.kind === 'report' && state.lang === 'or' && item.odiaSummary) parts.push(item.odiaSummary);
  else if (item.bodyText) parts.push(item.bodyText);
  parts.push(`${t('card.what_to_do')}: ${item.action}`);
  const clean = (s) => String(s || '').trim().replace(/[.!?…।]+$/, '');
  const utter = new SpeechSynthesisUtterance(parts.map(clean).filter(Boolean).join('. '));
  utter.lang = state.lang === 'or' ? 'or-IN' : 'en-IN';
  synth.speak(utter);
  btn.innerHTML = `${icon('volume-2', 16)}${escapeHtml(t('card.stop'))}`;
  utter.onend = () => { btn.innerHTML = `${icon('volume-2', 16)}${escapeHtml(t('card.read_aloud'))}`; };
}

async function voteItem(btn, id) {
  const vote = btn.dataset.vote;
  const current = state.votes[id];
  state.votes[id] = current === vote ? undefined : vote;
  if (state.votes[id] === undefined) delete state.votes[id];
  await kvSet('votes', state.votes);
  const group = btn.closest('.vote');
  if (group) for (const b of group.querySelectorAll('[data-vote]')) b.setAttribute('aria-pressed', String(state.votes[id] === b.dataset.vote));
  toast(t('card.thanks'));
}

/* ============================================================ navigation */
/* Views that are pinned as their own column at the current width. Asking to
 * "go" to one of them must scroll the existing column into view; switching
 * views instead would hide the primary column and blank that pane. */
function railIdForView(view) {
  if (view === 'map' && MAP_RAIL_MQ.matches) return 'view-map';
  if (view === 'safety' && SAFETY_RAIL_MQ.matches) return 'view-safety';
  return null;
}

let railFlashTimer = null;
function revealRail(id, { focus = true } = {}) {
  const rail = document.getElementById(id);
  if (!rail) return;
  rail.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  if (focus) {
    rail.setAttribute('tabindex', '-1');
    rail.focus({ preventScroll: true });
  }
  rail.classList.remove('view--rail-flash');
  void rail.offsetWidth; // reflow so a repeated press re-triggers the flash
  rail.classList.add('view--rail-flash');
  window.clearTimeout(railFlashTimer);
  railFlashTimer = window.setTimeout(() => rail.classList.remove('view--rail-flash'), 1000);
}

/* Keep the primary column populated: if a resize turns the current view into a
 * pinned column (or that view no longer exists at this width), fall back. */
function normalizeView() {
  if (railIdForView(state.view)) setView('home', { focus: false });
}

function setView(view, { focus = true } = {}) {
  const railId = railIdForView(view);
  if (railId) { revealRail(railId, { focus }); return; }
  state.view = view;
  document.body.dataset.view = view;
  for (const el of $$('.view')) el.setAttribute('aria-hidden', 'false');
  renderChrome();
  if (view === 'map') renderMap();
  if (view === 'safety') renderSafety();
  if (focus) {
    const target = { home: '#view-home', map: '#view-map', reports: '#view-reports', safety: '#view-safety' }[view];
    const el = target && $(target);
    if (el) { el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); }
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  }
  // Clear any stale flash left on a rail column we have moved away from.
  for (const el of $$('.view--rail-flash')) el.classList.remove('view--rail-flash');
}

function wireNav() {
  $('#bottomnav').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-nav]');
    if (!btn) return;
    if (btn.dataset.nav === 'report') { openReportSheet(); return; }
    setView(btn.dataset.nav);
  });
}

async function setLang(lang) {
  if (!lang || lang === state.lang) return;
  state.lang = lang;
  await kvSet('lang', state.lang);
  render();
}

/* ============================================================ header wiring */
function wireHeader() {
  for (const btn of $$('[data-lang-btn]')) {
    btn.addEventListener('click', () => setLang(btn.dataset.langBtn));
  }
  $('#lang-toggle')?.addEventListener('click', () => setLang(otherLang()));
  $('#theme-btn').addEventListener('click', async () => {
    const order = ['dark', 'light', 'sunlight'];
    state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
    document.documentElement.dataset.theme = state.theme;
    await kvSet('theme', state.theme);
    renderChrome();
  });
  $('#about-btn').addEventListener('click', openAbout);
  $('#report-btn')?.addEventListener('click', openReportSheet);
  for (const btn of $$('[data-view-btn]')) {
    btn.addEventListener('click', () => setView(btn.dataset.viewBtn, true));
  }
  const banner = $('#severe-banner');
  if (banner) banner.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-act]');
    if (btn) handleAction(btn);
  });
  $('#conn-pill').addEventListener('click', () => {
    if (state.online) loadAll({ refresh: true });
    else openAbout('conn');
  });
  $('#loc-chip').addEventListener('click', openLocationSheet);
}

/* ============================================================ location sheet */
async function openLocationSheet() {
  const dlg = $('#sheet-loc');
  const list = $('#loc-list');
  const render = (term = '') => {
    const results = term ? window.SACHET_GEO.search(term) : window.SACHET_GEO.districts.map(([n, o, lat, lon]) => ({ name: n, odia: o, district: n, lat, lon, kind: 'district' }));
    if (!results.length) { list.innerHTML = `<p class="feed__sub">${escapeHtml(t('loc.no_results'))}</p>`; return; }
    list.innerHTML = results.map((r) => `
      <button type="button" class="loclist__btn" data-place="${escapeHtml(r.name)}" data-district="${escapeHtml(r.district)}" data-lat="${r.lat}" data-lon="${r.lon}" data-odia="${escapeHtml(r.odia)}" aria-pressed="${state.place.name === r.name && state.place.district === r.district}">
        <span><span class="loclist__name">${escapeHtml(state.lang === 'or' ? r.odia : r.name)}</span>${r.kind === 'district' || r.district === r.name ? '' : ` <span class="loclist__meta">${escapeHtml(r.district)}</span>`}</span>
        ${state.place.name === r.name ? icon('check', 18) : ''}
      </button>`).join('');
  };
  render('');
  $('#loc-search').value = '';
  $('#loc-search').oninput = (e) => render(e.target.value);
  $('#loc-list').onclick = (e) => {
    const b = e.target.closest('[data-place]');
    if (!b) return;
    state.place = { name: b.dataset.place, district: b.dataset.district, odia: b.dataset.odia, lat: parseFloat(b.dataset.lat), lon: parseFloat(b.dataset.lon), source: 'manual' };
    persistPlace();
    announce(t('a11y.loc_set', { place: `${state.place.name}, ${state.place.district}` }));
    dlg.close(); render(); renderHome(); renderMap(); renderChrome();
  };
  $('#loc-gps').onclick = () => requestGps(dlg);
  dlg.showModal();
}
function persistPlace() { kvSet('place', state.place); }
function requestGps(dlg) {
  const status = $('#loc-gps-status');
  if (!navigator.geolocation) { status.textContent = t('loc.gps_fail'); return; }
  status.textContent = t('loc.locating');
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude, longitude } = pos.coords;
    const near = window.SACHET_GEO.nearestPlace(latitude, longitude);
    state.place = { name: near.place.name, district: near.place.district, odia: near.place.odia, lat: latitude, lon: longitude, source: 'gps' };
    persistPlace();
    status.textContent = t('loc.gps_ok');
    announce(t('a11y.loc_set', { place: state.place.name }));
    if (dlg?.open) dlg.close();
    renderHome(); renderMap(); renderChrome();
  }, () => { status.textContent = t('loc.gps_fail'); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 300000 });
}

/* ============================================================ about sheet */
function openAbout(section) {
  const body = $('#about-content');
  body.innerHTML = `
    <section class="about__section"><h3>${escapeHtml(t('about.data_title'))}</h3><p>${escapeHtml(t('about.data_body'))}</p></section>
    <section class="about__section"><h3>${escapeHtml(t('about.ai_title'))}</h3><p>${escapeHtml(t('about.ai_body'))}</p></section>
    <section class="about__section"><h3>${escapeHtml(t('about.offline_title'))}</h3><p>${escapeHtml(t('about.offline_body'))}</p></section>
    <section class="about__section"><h3>${escapeHtml(t('about.numbers_title'))}</h3><p>${escapeHtml(t('about.numbers_body'))}</p></section>
    <p class="about__version">${escapeHtml(t('about.version', { v: '2.0' }))}</p>`;
  const dlg = $('#sheet-about');
  dlg.showModal();
  if (section === 'conn') {
    const info = document.createElement('p');
    info.className = 'notice';
    info.textContent = state.lastSync
      ? t('conn.offline_body', { when: timeAgo(state.lastSync) })
      : t('conn.offline_no_data');
    body.prepend(info);
  }
}

/* ============================================================ report sheet */
function openReportSheet() {
  state.reportType = null;
  state.pendingPhoto = null;
  $('#caption').value = '';
  $('#photo').value = '';
  $('#preview').hidden = true;
  $('#report-msg').textContent = '';
  $('#add-location').checked = true;
  renderTypeGrid();
  renderLocHint();
  refreshQueueUi();
  $('#sheet-report').showModal();
}

function renderTypeGrid() {
  const grid = $('#report-types');
  grid.innerHTML = TYPE_ORDER.map((ty) => `
    <button type="button" class="typebtn" data-rtype="${ty}" aria-pressed="${state.reportType === ty}">
      ${icon(typeIcon(ty), 22)}<span>${escapeHtml(typeLabel(ty))}</span>
    </button>`).join('');
}
function renderLocHint() {
  const hint = $('#report-loc-hint');
  if (hint) hint.textContent = t('report.location_default', { place: `${state.place.name}, ${state.place.district}` });
}

function wireReportSheet() {
  $('#report-types').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rtype]');
    if (!b) return;
    state.reportType = state.reportType === b.dataset.rtype ? null : b.dataset.rtype;
    renderTypeGrid();
  });
  $('#report-close').addEventListener('click', () => $('#sheet-report').close());
  $('#photo').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    const preview = $('#preview');
    if (!file) { preview.hidden = true; state.pendingPhoto = null; return; }
    try {
      state.pendingPhoto = await photoPayload(file);
      preview.src = state.pendingPhoto;
      preview.hidden = false;
    } catch (error) { console.warn('preview failed', error); }
  });
  $('#voice-btn').addEventListener('click', toggleVoice);
  $('#loc-chip-report').addEventListener('click', (e) => { e.preventDefault(); openLocationSheet(); });
  $('#report-form').addEventListener('submit', saveReport);
  $('#send-now').addEventListener('click', flushQueue);
}

let recognizer = null;
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const status = $('#report-msg');
  if (!SR) { status.textContent = t('report.voice_unsupported'); return; }
  if (recognizer) { recognizer.stop(); return; }
  recognizer = new SR();
  recognizer.lang = state.lang === 'or' ? 'or-IN' : 'en-IN';
  recognizer.interimResults = false;
  recognizer.continuous = false;
  const btn = $('#voice-btn');
  btn.setAttribute('aria-pressed', 'true');
  status.textContent = t('report.listening');
  recognizer.onresult = (event) => {
    const text = Array.from(event.results).map((r) => r[0].transcript).join(' ');
    const caption = $('#caption');
    caption.value = `${caption.value}${caption.value ? ' ' : ''}${text}`.trim();
  };
  recognizer.onerror = () => { status.textContent = t('report.voice_unsupported'); };
  recognizer.onend = () => { recognizer = null; btn.setAttribute('aria-pressed', 'false'); status.textContent = ''; };
  recognizer.start();
}

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
  try { return await downscale(file); }
  catch (error) {
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
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function refreshQueueUi() {
  const items = await queueAll();
  const hint = $('#queue-hint');
  const list = $('#queue-list');
  if (hint) hint.textContent = items.length ? t('report.queue_count', { n: items.length }) : t('report.queue_none');
  if (list) {
    list.classList.toggle('queue--empty', !items.length);
    list.innerHTML = items.map((it) => `<div class="queue__item"><span>${escapeHtml(clampText(it.caption, 60))}</span><button type="button" class="link-btn" data-remove="${escapeHtml(it.client_id)}">${escapeHtml(t('report.remove'))}</button></div>`).join('');
    list.onclick = async (e) => {
      const b = e.target.closest('[data-remove]');
      if (!b) return;
      await queueDelete(b.dataset.remove);
      refreshQueueUi();
    };
  }
  const sendBtn = $('#send-now');
  if (sendBtn) sendBtn.disabled = items.length === 0;
  return items;
}

async function saveReport(event) {
  event.preventDefault();
  const caption = $('#caption').value.trim();
  const status = $('#report-msg');
  if (!state.reportType) { status.textContent = t('report.need_type'); return; }
  if (!caption) { status.textContent = t('report.need_text'); return; }
  status.textContent = t('report.sending');
  const withLoc = $('#add-location').checked;
  const body = withLoc ? `${LOC_PREFIX} ${state.place.name}, ${state.place.district}\n${caption}` : caption;
  const item = {
    client_id: newClientId(),
    caption: body,
    type: state.reportType,
    photo_base64: state.pendingPhoto || null,
    created_at: new Date().toISOString(),
  };
  await queuePut(item);
  await refreshQueueUi();
  state.pendingPhoto = null;
  $('#caption').value = '';
  $('#photo').value = '';
  $('#preview').hidden = true;
  $('#report-msg').textContent = t('report.saved');
  toast(t('report.queued'));
  announce(t('a11y.queued'));
  if (state.online) await flushQueue();
}

async function flushQueue() {
  const items = await queueAll();
  const status = $('#report-msg');
  if (!items.length) { if (status) status.textContent = t('report.queue_none'); return; }
  if (!navigator.onLine) { if (status) status.textContent = t('report.failed'); return; }
  if (status) status.textContent = t('report.sending');
  let sent = 0, failed = 0;
  for (const item of items) {
    try {
      const response = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: item.client_id, caption: item.caption, photo_base64: item.photo_base64 || undefined }),
      });
      if (response.ok) { await queueDelete(item.client_id); sent += 1; continue; }
      const payload = await response.json().catch(() => ({}));
      if (response.status === 413 || response.status === 422) { await queueDelete(item.client_id); failed += 1; if (status) status.textContent = payload.hint || t('report.failed'); continue; }
      failed += 1;
    } catch (error) { console.warn('flush failed', error); failed += 1; break; }
  }
  await refreshQueueUi();
  if (sent) { if (status) status.textContent = t('report.sent', { n: sent }); announce(t('report.sent', { n: sent })); await loadAll({ silent: true }); }
  else if (failed && status && !status.textContent) status.textContent = t('report.failed');
}

/* ============================================================ map interactions */
function wireMap() {
  const svg = $('#map-svg');
  if (!svg) return;
  let dragging = false, last = null, moved = 0;
  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-pin],[data-cluster]')) return;
    dragging = true; last = { x: e.clientX, y: e.clientY }; moved = 0;
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);
    const rect = svg.getBoundingClientRect();
    const sx = MAP.W / rect.width, sy = MAP.H / rect.height;
    const [dLat, dLon] = unprojectDelta((e.clientX - last.x) * sx, (e.clientY - last.y) * sy);
    state.map.lat = Math.max(4, Math.min(28, state.map.lat + dLat));
    state.map.lon = Math.max(70, Math.min(98, state.map.lon + dLon));
    last = { x: e.clientX, y: e.clientY };
    renderMap();
  });
  const end = (e) => { dragging = false; try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ } };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    state.map.zoom = Math.max(0.7, Math.min(6, state.map.zoom * factor));
    renderMap();
  }, { passive: false });

  $('#map-zoom-in').addEventListener('click', () => { state.map.zoom = Math.min(6, state.map.zoom * 1.3); renderMap(); });
  $('#map-zoom-out').addEventListener('click', () => { state.map.zoom = Math.max(0.7, state.map.zoom / 1.3); renderMap(); });
  $('#map-locate').addEventListener('click', () => zoomTo(state.place.lat, state.place.lon, 3));
  $('#map-fit').addEventListener('click', () => { state.map = { lat: 20.2, lon: 84.6, zoom: 1.15 }; renderMap(); });
}
function zoomTo(lat, lon, zoom) {
  state.map = { lat, lon, zoom };
  renderMap();
}

/* ============================================================ pull to refresh */
function wirePull() {
  let startY = null, pulling = false;
  const indicator = $('#pull-indicator');
  window.addEventListener('touchstart', (e) => {
    if (window.scrollY > 4 || state.view === 'map') { startY = null; return; }
    startY = e.touches[0].clientY; pulling = false;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 70) { pulling = true; if (indicator) { indicator.hidden = false; indicator.textContent = t('state.pull'); } }
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (pulling) {
      if (indicator) { indicator.textContent = t('state.updating'); }
      loadAll({ refresh: true }).finally(() => { if (indicator) indicator.hidden = true; });
    } else if (indicator) indicator.hidden = true;
    startY = null; pulling = false;
  });
}

/* ============================================================ boot */
async function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('/sw.js'); }
  catch (error) { console.warn('service worker registration failed', error); }
}

function restoreTheme() {
  document.documentElement.dataset.theme = state.theme;
}
function restoreLangChips() {
  for (const btn of $$('[data-lang-btn]')) btn.setAttribute('aria-pressed', String(btn.dataset.langBtn === state.lang));
}

async function boot() {
  if (!window.SACHET_GEO || !window.SACHET_I18N) {
    console.warn('i18n/geo modules missing; continuing with reduced features');
  }
  // detect IndexedDB availability up front (some private modes block it)
  try { await openDb(); } catch (error) {
    console.warn('IndexedDB unavailable, using memory fallback', error);
    memoryStore = { kv: { put: (v, k) => { memoryStore.kv._m = memoryStore.kv._m || {}; memoryStore.kv._m[k] = v; }, get: (k) => ({ set onsuccess(f) { f(); }, result: (memoryStore.kv._m || {})[k] }) }, queue: { put: () => {}, getAll: () => ({ set onsuccess(f) { f(); }, result: [] }), delete: () => {} } };
  }

  state.lang = (await kvGet('lang', 'en')) || 'en';
  state.theme = (await kvGet('theme', 'dark')) || 'dark';
  const savedPlace = await kvGet('place');
  if (savedPlace) state.place = savedPlace;
  state.votes = (await kvGet('votes', {})) || {};
  state.seenIds = (await kvGet('seenIds', [])) || [];
  state.ackBanner = (await kvGet('ackBanner', null)) || null;

  restoreTheme();
  document.documentElement.lang = state.lang;
  document.body.dataset.view = state.view;

  // static chrome strings
  applyStaticI18n(document);
  restoreLangChips();

  wireHeader();
  wireNav();
  wireMain();
  wireMap();
  wireReportSheet();
  wirePull();
  $('#sheet-about')?.addEventListener('close', () => $('#about-btn')?.focus());
  $('#sheet-loc')?.addEventListener('close', () => $('#loc-chip')?.focus());
  $('#sheet-report')?.addEventListener('close', () => {
    const visible = $('#report-btn');
    const target = visible && visible.offsetParent ? visible : $('[data-nav="report"]');
    target?.focus();
  });

  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));
  window.addEventListener('resize', measureTopbar);
  // A view can become a pinned column (or stop being one) when the window
  // crosses a breakpoint: recover so the primary pane is never left empty.
  const onLayoutChange = () => { measureTopbar(); normalizeView(); };
  for (const mq of [MAP_RAIL_MQ, SAFETY_RAIL_MQ]) {
    if (mq.addEventListener) mq.addEventListener('change', onLayoutChange);
    else if (mq.addListener) mq.addListener(onLayoutChange);
  }
  if ('ResizeObserver' in window) new ResizeObserver(measureTopbar).observe(document.querySelector('.topbar'));

  render();
  await loadAll();
  await refreshQueueUi();
  if (state.online) await flushQueue();
  await registerWorker();
  window.setTimeout(measureTopbar, 300);
}

boot().catch((error) => {
  console.error('boot failed', error);
  announce(window.SACHET_I18N ? t('a11y.boot_failed') : 'The app could not start. Reload when you have network.');
});
