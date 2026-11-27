/* app.js — medication reminder PWA (Arabic RTL). Schedule and log live in KV via the Worker. */

const $ = (sel, root) => (root || document).querySelector(sel);
const LS_KEY = 'medapp.v1';
const TZ = 'Africa/Cairo';
const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const DAY_SHORT = ['حد', 'اتنين', 'تلات', 'أربع', 'خميس', 'جمعة', 'سبت'];

/* ---------------------------------------------------------------- state */

function newDevice() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function load() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { s = {}; }
  const base = { device: '', worker: '', token: '', lastSync: 0, meds: [], settings: { summaryTime: '22:30', enabled: true }, marks: {}, log: [], updatedAt: 0 };
  const out = Object.assign(base, s);
  out.settings = Object.assign({ summaryTime: '22:30', enabled: true }, s.settings || {});
  if (!out.device) out.device = newDevice();
  return out;
}

let S = load();
function save() { localStorage.setItem(LS_KEY, JSON.stringify(S)); }

/* ---------------------------------------------------------------- time */

function cairoNow(d) {
  const at = d || new Date();
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
    });
    const p = {};
    for (const part of fmt.formatToParts(at)) p[part.type] = part.value;
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    return { date: p.year + '-' + p.month + '-' + p.day, minutes: Number(p.hour) * 60 + Number(p.minute), hhmm: p.hour + ':' + p.minute, weekday: wd < 0 ? 0 : wd };
  } catch (e) {
    const sh = new Date(at.getTime() + 2 * 3600 * 1000);
    return { date: sh.toISOString().slice(0, 10), minutes: sh.getUTCHours() * 60 + sh.getUTCMinutes(), hhmm: String(sh.getUTCHours()).padStart(2, '0') + ':' + String(sh.getUTCMinutes()).padStart(2, '0'), weekday: sh.getUTCDay() };
  }
}

function arabicDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }).format(d);
}

function slotOf(date, med) { return date + '|' + med.id + '|' + med.time; }

/* ---------------------------------------------------------------- toast */

let toastTimer;
function toast(msg) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

/* ---------------------------------------------------------------- api */

function workerBase() { return (S.worker || '').trim().replace(/\/+$/, ''); }

function tokenValue() { return (S.token || '').trim(); }

/* Every call except /vapid-public-key carries the access token in X-App-Token. */
async function api(path, opts) {
  const base = workerBase();
  if (!base) throw new Error('مفيش رابط سيرفر متسجل');
  opts = Object.assign({}, opts);
  opts.headers = Object.assign({}, opts.headers);
  if (path !== '/vapid-public-key') {
    if (!tokenValue()) throw new Error('مفيش رمز دخول متسجل. اكتبه في الإعدادات.');
    opts.headers['X-App-Token'] = tokenValue();
  }
  const res = await fetch(base + path, opts);
  let body;
  try { body = await res.json(); } catch (e) { body = { ok: false, error: 'HTTP ' + res.status }; }
  if (!res.ok) {
    const err = new Error((body && body.error) || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return body;
}

async function pull() {
  if (!workerBase()) return;
  try {
    const d = await api('/data?device=' + encodeURIComponent(S.device));
    if (!d.ok) return;
    if (d.state && (d.state.updatedAt || 0) > (S.updatedAt || 0)) {
      S.meds = d.state.meds || [];
      S.settings = Object.assign(S.settings, d.state.settings || {});
      S.updatedAt = d.state.updatedAt || 0;
    }
    S.marks = Object.assign({}, S.marks, d.marks || {});
    const seen = new Set(S.log.map((e) => e.at + '|' + e.medId + '|' + e.status));
    for (const e of d.log || []) {
      const k = e.at + '|' + e.medId + '|' + e.status;
      if (!seen.has(k)) { S.log.push(e); seen.add(k); }
    }
    S.log.sort((a, b) => b.at - a.at);
    S.log = S.log.slice(0, 500);
    S.dirty = false;
    S.lastSync = Date.now();
    save();
  } catch (e) {
    if (e && (e.status === 401 || e.status === 503)) toast(e.message);
    /* otherwise offline: keep local copy */
  }
}

async function pushState() {
  S.updatedAt = Date.now();
  save();
  if (!workerBase()) return;
  try {
    await api('/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: S.device, meds: S.meds, settings: S.settings }) });
    S.dirty = false;
    S.lastSync = Date.now();
    save();
  } catch (e) {
    S.dirty = true;
    save();
    toast(e && e.status === 401 ? e.message : 'مش قادر أوصل للسيرفر، هحاول تاني');
  }
}

async function pushMark(med, date, status) {
  if (!workerBase()) return;
  try {
    await api('/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: S.device, medId: med.id, date, time: med.time, status, name: med.name })
    });
  } catch (e) {
    S.dirty = true;
    save();
  }
}

/* ---------------------------------------------------------------- marks */

function statusOf(med, date) { return S.marks[slotOf(date, med)] || null; }

function setMark(med, date, status) {
  const slot = slotOf(date, med);
  if (status) S.marks[slot] = status; else delete S.marks[slot];
  if (status) {
    S.log.unshift({ at: Date.now(), date, time: med.time, medId: med.id, name: med.name, status });
    S.log = S.log.slice(0, 500);
  } else {
    S.log = S.log.filter((e) => !(e.date === date && e.medId === med.id && e.time === med.time));
  }
  save();
  pushMark(med, date, status);
  render();
}

/* ---------------------------------------------------------------- view helpers */

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
function ar(n) { return String(n).replace(/\d/g, (d) => AR_DIGITS[d]); }

/* "14:00" -> "٢:٠٠ م" (Arabic-Indic numerals, 12-hour with ص / م) */
function fmtTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return esc(hhmm || '');
  const h = Number(m[1]);
  return { t: ar(h % 12 || 12) + ':' + ar(m[2]), p: h >= 12 ? 'م' : 'ص' };
}
function timeText(hhmm) { const f = fmtTime(hhmm); return typeof f === 'string' ? f : f.t + ' ' + f.p; }

function plural(n, one, two, few, many) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return ar(n) + ' ' + few;
  return ar(n) + ' ' + many;
}
function durationText(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hp = h ? plural(h, 'ساعة', 'ساعتين', 'ساعات', 'ساعة') : '';
  const mp = m ? plural(m, 'دقيقة', 'دقيقتين', 'دقايق', 'دقيقة') : '';
  return [hp, mp].filter(Boolean).join(' و') || 'دقيقة';
}

function bucketOf(time) {
  const h = Number(String(time).split(':')[0]);
  if (h < 12) return 'الصبح';
  if (h < 17) return 'الضهر';
  return 'بالليل';
}
const BUCKETS = ['الصبح', 'الضهر', 'بالليل'];

/* Pill icons from the design: taken = green filled with check, skipped = tan with dash, pending = outline */
function pillIcon(kind, size, color) {
  size = size || 30;
  const base = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 30 30" fill="none" aria-hidden="true" style="flex:none">';
  if (kind === 'taken') return base + '<rect x="3" y="10" width="24" height="10" rx="5" transform="rotate(-45 15 15)" fill="#4F6B3A"/><path d="m11 15.5 3 3 5-6" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  if (kind === 'skipped') return base + '<rect x="3" y="10" width="24" height="10" rx="5" transform="rotate(-45 15 15)" fill="#BDB09A"/><path d="M11.5 15h7" stroke="#2B1F17" stroke-width="2.4" stroke-linecap="round"/></svg>';
  if (kind === 'next') return base + '<rect x="3" y="10" width="24" height="10" rx="5" transform="rotate(-45 15 15)" fill="#B5472A"/></svg>';
  return base + '<rect x="4" y="11" width="22" height="8" rx="4" transform="rotate(-45 15 15)" stroke="' + (color || '#6E5D50') + '" stroke-width="2"/></svg>';
}

function sectionHead(title, count) {
  return '<div class="sec"><h2>' + esc(title) + '</h2><span class="line"></span>' + (count == null ? '' : '<span class="cnt">' + count + '</span>') + '</div>';
}

function pageHeader(small, title, right) {
  return '<header class="ph"><div><div class="small">' + small + '</div><h1>' + esc(title) + '</h1></div>' + (right || '') + '</header>';
}

function emptyBox(title, text, buttons) {
  return '<div class="empty"><h3>' + title + '</h3><div>' + text + '</div>' + (buttons || '') + '</div>';
}

function statusSub(med, st) {
  const note = med.note ? esc(med.note) + ' · ' : '';
  if (st === 'taken') return note + '<b class="ok">تم</b>';
  if (st === 'skipped') return note + '<b>متخطي</b>';
  return note + 'لسه';
}

function medRow(med, date) {
  const st = statusOf(med, date);
  return '<button class="row ' + (st ? 'done' : '') + '" data-med="' + esc(med.id) + '">' +
    pillIcon(st || 'pending') +
    '<span class="mid"><span class="nm">' + esc(med.name) + '</span><span class="sub">' + statusSub(med, st) + '</span></span>' +
    '<span class="tm">' + timeText(med.time) + '</span></button>';
}

function nextCard(med, date, n) {
  const mm = minutesOfClock(med.time) - n.minutes;
  const when = mm >= 0 ? 'الجاي · كمان ' + durationText(mm) : 'متأخر · من ' + durationText(-mm);
  const f = fmtTime(med.time);
  return '<button class="next" data-med="' + esc(med.id) + '">' +
    '<span class="top"><span class="when">' + when + '</span><span class="tag">لسه</span></span>' +
    '<span class="mid"><span class="who">' + pillIcon('next', 34) +
      '<span style="display:flex;flex-direction:column;min-width:0"><span class="nm">' + esc(med.name) + '</span>' +
      (med.note ? '<span class="sub">' + esc(med.note) + '</span>' : '') + '</span></span>' +
      '<span class="big">' + f.t + '<small> ' + f.p + '</small></span></span>' +
    '<span class="cta">سجّل الدوا</span></button>';
}

function minutesOfClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function wireRows(el, handler) {
  el.querySelectorAll('[data-med]').forEach((b) => {
    b.onclick = () => {
      const med = S.meds.find((x) => x.id === b.dataset.med);
      if (med) handler(med);
    };
  });
}

/* ---------------------------------------------------------------- render */

let tab = 'today';

function todayMeds() {
  const n = cairoNow();
  return S.meds
    .filter((m) => m.active !== false && Array.isArray(m.days) && m.days.indexOf(n.weekday) >= 0)
    .sort((a, b) => a.time.localeCompare(b.time));
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function headerDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(d);
}
function headerWeekday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return new Intl.DateTimeFormat('ar-EG', { weekday: 'long', timeZone: TZ }).format(d);
}

function renderToday() {
  const n = cairoNow();
  const list = todayMeds();
  const el = $('#tab-today');

  if (!S.meds.length) {
    el.innerHTML = pageHeader(headerDate(n.date), headerWeekday(n.date)) +
      emptyBox('أهلاً بيك', 'لسه مفيش أدوية. ضيف أول دواء، أو استورد الجدول بتاعك من الإعدادات.',
        '<button class="btn" id="firstAdd">ضيف دواء</button><button class="btn ghost" id="firstImport">استورد جدولي</button>');
    $('#firstAdd').onclick = () => openEditor(null);
    $('#firstImport').onclick = () => openImportSheet();
    return;
  }

  const pending = list.filter((m) => !statusOf(m, n.date));
  const badge = pending.length
    ? '<div class="badge static"><span class="n">' + ar(pending.length) + '</span><span class="l">' + (pending.length === 1 ? 'فاضل' : 'فاضلين') + '</span></div>'
    : '<div class="badge static done"><span class="n">' + ar(0) + '</span><span class="l">خلصت</span></div>';

  let html = pageHeader(headerDate(n.date), headerWeekday(n.date), list.length ? badge : '');
  html += '<section style="margin-top:8px">';

  if (!list.length) {
    html += emptyBox('يوم فاضي', 'مفيش أدوية متجدولة النهاردة.');
  }

  /* next card: first pending med still ahead, otherwise the earliest overdue one */
  let next = pending.find((m) => minutesOfClock(m.time) >= n.minutes) || pending[0] || null;

  for (const b of BUCKETS) {
    const items = list.filter((m) => bucketOf(m.time) === b);
    if (!items.length) continue;
    const taken = items.filter((m) => statusOf(m, n.date) === 'taken').length;
    html += sectionHead(b, ar(taken) + ' من ' + ar(items.length));
    html += '<div class="list">' + items.map((m) => (next && m.id === next.id ? nextCard(m, n.date, n) : medRow(m, n.date))).join('') + '</div>';
  }
  html += '</section>';
  el.innerHTML = html;
  wireRows(el, (med) => openMarkSheet(med, n.date));
}

const DAY_ORDER = [6, 0, 1, 2, 3, 4, 5]; // Saturday first; stored day numbers unchanged (0 = Sunday)
const DAY_LETTER = ['ح', 'ن', 'ث', 'ر', 'خ', 'ج', 'س'];
const DAY_CHIP = ['حد', 'تنين', 'تلات', 'أربع', 'خميس', 'جمعة', 'سبت'];

function daysCircles(med) {
  return '<span style="display:flex;gap:4px">' + DAY_ORDER.map((d) => {
    const on = med.days.indexOf(d) >= 0;
    return '<span class="dc ' + (on ? 'on' : '') + '">' + DAY_LETTER[d] + '</span>';
  }).join('') + '</span>';
}

function renderMeds() {
  const el = $('#tab-meds');
  const n = S.meds.length;
  const small = n ? ar(n) + ' ' + (n === 1 ? 'دوا' : n === 2 ? 'دوائين' : n <= 10 ? 'أدوية' : 'دوا') : 'لسه فاضية';
  let html = '<header class="ph s end"><div><div class="small">' + small + '</div><h1>الأدوية</h1></div>' +
    '<button class="addbtn" id="addMed"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>إضافة</span></button></header>';
  if (!n) {
    el.innerHTML = html + emptyBox('مفيش أدوية', 'دوس إضافة وسجّل أول دواء.');
    $('#addMed').onclick = () => openEditor(null);
    return;
  }
  html += '<section class="mlist">';
  const sorted = S.meds.slice().sort((a, b) => a.time.localeCompare(b.time));
  html += sorted.map((m) =>
    '<button class="mrow" data-med="' + esc(m.id) + '"><span class="mid2">' +
    '<span class="l1"><span class="nm">' + esc(m.name) + '</span><span class="tm">' + timeText(m.time) + '</span></span>' +
    '<span class="l2"><span class="nt">' + esc(m.note || '') + '</span>' + daysCircles(m) + '</span></span>' +
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6E5D50" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/></svg></button>').join('');
  html += '</section>';
  el.innerHTML = html;
  $('#addMed').onclick = () => openEditor(null);
  wireRows(el, (med) => openEditor(med));
}

/* ------------------------------------------------------------ history */

function weekdayOfDate(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); }
function shortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const f = (o) => new Intl.DateTimeFormat('ar-EG', Object.assign({ timeZone: TZ }, o)).format(d);
  return f({ weekday: 'long' }) + ' ' + f({ day: 'numeric' }) + ' ' + f({ month: 'long' });
}

function historyDays(n) {
  const dates = new Set([n.date]);
  for (const k of Object.keys(S.marks)) dates.add(k.slice(0, 10));
  for (const e of S.log) if (e.date) dates.add(e.date);
  let first = [...dates].sort()[0];
  // fill gaps between the first recorded day and today so a fully missed day shows up
  const out = [];
  let d = n.date;
  let guard = 0;
  while (d >= first && guard++ < 30) { out.push(d); d = shiftDate(d, -1); }
  return out;
}
function shiftDate(dateStr, delta) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daySlots(date) {
  const wd = weekdayOfDate(date);
  const map = new Map();
  for (const m of S.meds) {
    if (m.active !== false && m.days.indexOf(wd) >= 0) map.set(m.id + '|' + m.time, { id: m.id, name: m.name, time: m.time });
  }
  const names = {};
  for (const e of S.log) names[e.medId] = e.name;
  for (const k of Object.keys(S.marks)) {
    if (k.slice(0, 10) !== date) continue;
    const parts = k.split('|');
    const key = parts[1] + '|' + parts[2];
    if (!map.has(key)) {
      const med = S.meds.find((x) => x.id === parts[1]);
      map.set(key, { id: parts[1], name: (med && med.name) || names[parts[1]] || 'دوا', time: parts[2] });
    }
  }
  return [...map.values()].sort((a, b) => a.time.localeCompare(b.time));
}

function renderLog() {
  const el = $('#tab-log');
  const n = cairoNow();
  let html = '<header class="ph s"><div><div class="small">الأحدث الأول</div><h1>السجل</h1></div></header>';
  const hasAny = S.log.length || Object.keys(S.marks).length;
  if (!hasAny) {
    el.innerHTML = html + emptyBox('السجل فاضي', 'أول ما تسجل دواء هيظهر هنا.');
    return;
  }
  html += '<section class="hist">';
  for (const date of historyDays(n)) {
    const slots = daySlots(date);
    if (!slots.length) continue;
    const isToday = date === n.date;
    const rows = [];
    let taken = 0;
    let later = 0;
    for (const s of slots) {
      const st = S.marks[date + '|' + s.id + '|' + s.time] || null;
      if (st === 'taken') taken++;
      if (!st && isToday && minutesOfClock(s.time) > n.minutes) { later++; continue; }
      rows.push({ s, st });
    }
    const title = (isToday ? 'النهاردة · ' : date === shiftDate(n.date, -1) ? 'امبارح · ' : '') + shortDate(date);
    const cnt = isToday ? 'تم ' + ar(taken) + ' من ' + ar(slots.length) : ar(taken) + ' من ' + ar(slots.length);
    const cntColor = isToday ? 'var(--muted)' : taken === slots.length ? 'var(--green)' : 'var(--rust)';
    html += '<div class="hday"><div class="hh"><h2>' + esc(title) + '</h2><span style="color:' + cntColor + '">' + cnt + '</span></div>';
    for (const r of rows) {
      const kind = r.st === 'taken' ? 'taken' : r.st === 'skipped' ? 'skipped' : 'pending';
      const label = r.st === 'taken' ? '<span style="color:var(--green)">تم</span>' : r.st === 'skipped' ? '<span>متخطي</span>' : '<span style="color:var(--rust)">ما اتسجلش</span>';
      html += '<div class="hrow">' + pillIcon(kind) + '<span class="hn">' + esc(r.s.name) + '</span><span class="ht">' + timeText(r.s.time) + '</span><span class="hs">' + label + '</span></div>';
    }
    if (later) html += '<div class="hnote">لسه ' + (later === 1 ? 'دوا' : later === 2 ? 'دوائين' : ar(later) + ' ' + (later <= 10 ? 'أدوية' : 'دوا')) + ' ما جاش ' + (later === 1 ? 'وقته' : later === 2 ? 'وقتهم' : 'وقتهم') + '</div>';
    html += '</div>';
  }
  html += '</section>';
  el.innerHTML = html;
}

/* ------------------------------------------------------------ settings */

function settingsCard(inner, plain) { return '<div class="box' + (plain ? ' plain' : '') + '">' + inner + '</div>'; }
function setHead(t) { return '<h2 class="sh">' + t + '<span class="line"></span></h2>'; }

function renderSettings() {
  const el = $('#tab-settings');
  el.innerHTML = '<header class="ph s"><h1>الإعدادات</h1></header><section class="setp">' +
    '<div class="sg">' + setHead('السيرفر') + settingsCard(
      '<label class="fl" for="wurl">رابط السيرفر</label>' +
      '<input id="wurl" class="sin" type="url" inputmode="url" placeholder="https://xxxx.workers.dev" autocapitalize="off" autocomplete="off" spellcheck="false" value="' + esc(workerBase()) + '">' +
      '<label class="fl" for="wtoken" style="margin-top:2px">رمز الدخول</label>' +
      '<input id="wtoken" class="sin" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(tokenValue()) + '">' +
      '<div id="srvStatus" class="srv"></div>') + '</div>' +
    '<div class="sg">' + setHead('الإشعارات') + '<div class="box nopad">' +
      '<div class="trow"><span style="display:flex;flex-direction:column"><span class="tt">تفعيل الإشعارات</span><span class="ts" id="permLine"></span></span>' +
      '<button class="tog" id="pushTog" role="switch" aria-checked="false" aria-label="تفعيل الإشعارات"><span class="knob"></span></button></div>' +
      '<button class="tbtn" id="testPush"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4"/></svg><span>إشعار تجريبي</span></button></div></div>' +
    '<div class="sg">' + setHead('ملخص الليل') + settingsCard(
      '<div class="trow2"><span style="display:flex;flex-direction:column"><span class="tt">وقت الملخص</span><span class="ts">يفكرك باللي لسه ما اتاخدش</span></span>' +
      '<span class="sumpill"><span id="sumLabel">' + timeText(S.settings.summaryTime) + '</span><input id="sumTime" type="time" aria-label="وقت الملخص" value="' + esc(S.settings.summaryTime) + '"></span></div>', true) + '</div>' +
    '<div class="sg">' + setHead('الجدول') + '<div style="display:flex;gap:10px">' +
      '<button class="sbtn" id="openImport"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2B1F17" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg><span>استيراد</span></button>' +
      '<button class="sbtn" id="openExport"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2B1F17" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg><span>تصدير</span></button></div></div>' +
    '<div class="devline">معرّف الجهاز (على الموبايل بس): <span dir="ltr">' + esc(S.device) + '</span></div>' +
    '</section>';

  const saveConn = async () => {
    S.worker = $('#wurl').value.trim().replace(/\/+$/, '');
    S.token = $('#wtoken').value.trim();
    if (S.worker && !/^https?:\/\//i.test(S.worker)) { toast('الرابط لازم يبدأ بـ https://'); return; }
    save();
    await refreshServerStatus();
    await pull();
    refreshServerStatus();
  };
  $('#wurl').onchange = saveConn;
  $('#wtoken').onchange = saveConn;
  $('#pushTog').onclick = () => (S.pushOn ? disablePush() : enablePush());
  $('#testPush').onclick = testPush;
  $('#sumTime').onchange = () => {
    const v = $('#sumTime').value;
    if (!/^\d{2}:\d{2}$/.test(v)) return toast('وقت غير صحيح');
    S.settings.summaryTime = v;
    $('#sumLabel').textContent = timeText(v);
    pushState();
    toast('اتحفظ وقت الملخص');
  };
  $('#openImport').onclick = openImportSheet;
  $('#openExport').onclick = openExportSheet;
  refreshServerStatus();
  refreshPermLine();
}

async function refreshPermLine() {
  const line = $('#permLine');
  const tog = $('#pushTog');
  if (!line || !tog) return;
  let on = false;
  let msg;
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (!window.Notification || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    msg = standalone ? 'المتصفح ده مش بيدعم الإشعارات' : 'ثبّت التطبيق من Safari الأول';
  } else if (Notification.permission === 'denied') {
    msg = 'مرفوضة من إعدادات الآيفون';
  } else {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      on = !!sub && Notification.permission === 'granted';
    } catch (e) { on = false; }
    msg = on ? 'شغّالة على الآيفون ده' : 'مقفولة · دوس عشان تفعّلها';
  }
  S.pushOn = on;
  line.textContent = msg + (S.dirty ? ' · فيه تغييرات لسه ما وصلتش' : '');
  tog.classList.toggle('on', on);
  tog.setAttribute('aria-checked', on ? 'true' : 'false');
}

async function refreshServerStatus() {
  const el = $('#srvStatus');
  if (!el) return;
  const dot = (c) => '<span class="dot" style="background:' + c + '"></span>';
  if (!workerBase()) { el.innerHTML = dot('#BDB09A') + '<span>مفيش رابط متسجل</span>'; return; }
  if (!tokenValue()) { el.innerHTML = dot('#B5472A') + '<b style="color:var(--rust)">مفيش رمز دخول</b>'; return; }
  el.innerHTML = dot('#BDB09A') + '<span>بيفحص السيرفر…</span>';
  try {
    const s = await api('/status');
    const mins = S.lastSync ? Math.max(0, Math.floor((Date.now() - S.lastSync) / 60000)) : null;
    el.innerHTML = dot('#4F6B3A') + '<b style="color:var(--green)">متصل</b><span>· ' +
      (mins === null ? 'لسه مفيش مزامنة' : mins === 0 ? 'اتزامن دلوقتي' : 'آخر مزامنة من ' + durationText(mins)) + '</span>' +
      '<span class="cron">المؤقت: ' + (s.lastCronCairo ? esc(ar(s.lastCronCairo)) : 'لسه') + '</span>';
  } catch (e) {
    el.innerHTML = dot('#B5472A') + '<b style="color:var(--rust)">مش متصل</b><span>· ' + esc(e.message) + '</span>';
  }
}

/* ------------------------------------------------------------ render + sheets */

function render() {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  for (const t of ['today', 'meds', 'log', 'settings']) $('#tab-' + t).classList.toggle('hidden', tab !== t);
  if (tab === 'today') renderToday();
  if (tab === 'meds') renderMeds();
  if (tab === 'log') renderLog();
  if (tab === 'settings') renderSettings();
}

function setTab(t) { tab = t; render(); window.scrollTo(0, 0); }

function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#sheetBody').innerHTML = '';
  closeEditor();
}
function closeEditor() { const e = $('#editor'); e.classList.add('hidden'); e.innerHTML = ''; document.body.classList.remove('noscroll'); }

const ICON_CHECK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const ICON_DASH = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2B1F17" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 12h10"/><circle cx="12" cy="12" r="9"/></svg>';
const ICON_TRASH = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#B5472A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

function openMarkSheet(med, date) {
  const st = statusOf(med, date);
  const body = $('#sheetBody');
  const f = fmtTime(med.time);
  body.className = 'panel';
  body.innerHTML =
    '<div class="grab" aria-hidden="true"></div>' +
    '<header class="shd"><span class="who">' + pillIcon('next', 34) +
      '<span style="display:flex;flex-direction:column;min-width:0"><span class="sm">سجّل الجرعة دي</span><h2>' + esc(med.name) + '</h2></span></span>' +
      '<span class="when"><span class="big">' + f.t + '<small> ' + f.p + '</small></span>' +
      '<span class="sm">' + (med.note ? esc(med.note) : '') + (date !== cairoNow().date ? (med.note ? ' · ' : '') + esc(arabicDate(date)) : '') + '</span></span></header>' +
    '<div class="acts">' +
    '<button class="act main" data-act="taken">' + ICON_CHECK + '<span>خدته</span></button>' +
    '<button class="act mid" data-act="skipped">' + ICON_DASH + '<span>مش هاخده</span></button>' +
    (st ? '<button class="act clr" data-act="clear">' + ICON_TRASH + '<span>امسح التسجيل</span></button>' : '') +
    '</div>';
  $('#sheet').classList.remove('hidden');
  body.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.act;
      setMark(med, date, act === 'clear' ? null : act);
      closeSheet();
    };
  });
}

function openTextSheet(title, sub, innerHtml) {
  const body = $('#sheetBody');
  body.className = 'panel';
  body.innerHTML = '<div class="grab" aria-hidden="true"></div><header class="shd"><span style="display:flex;flex-direction:column"><span class="sm">' + sub + '</span><h2>' + title + '</h2></span></header>' + innerHtml;
  $('#sheet').classList.remove('hidden');
}

function openImportSheet() {
  openTextSheet('استيراد الجدول', 'الزق الجدول هنا', '<textarea id="importBox" rows="7" class="ta" placeholder=\'{"meds":[...]}\'></textarea><div class="acts"><button class="act main" id="doImport"><span>استيراد</span></button><button class="act clr" id="impCancel"><span>إلغاء</span></button></div>');
  $('#impCancel').onclick = closeSheet;
  $('#doImport').onclick = () => {
    const raw = $('#importBox').value.trim();
    if (!raw) return toast('الصق النص الأول');
    try {
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { data = null; }
      let meds;
      if (data) {
        meds = Array.isArray(data) ? data : data.meds;
      } else {
        meds = parseLines(raw);
      }
      if (!Array.isArray(meds) || !meds.length) throw new Error('مفيش أدوية في النص');
      S.meds = meds.map((m, i) => ({
        id: (m.id || 'm' + i + Math.random().toString(36).slice(2, 6)).replace(/[^A-Za-z0-9_-]/g, ''),
        name: String(m.name || '').slice(0, 60),
        time: /^\d{2}:\d{2}$/.test(m.time) ? m.time : '09:00',
        days: Array.isArray(m.days) && m.days.length ? [...new Set(m.days.map(Number).filter((d) => d >= 0 && d <= 6))] : [0, 1, 2, 3, 4, 5, 6],
        note: String(m.note || '').slice(0, 80),
        active: true
      })).filter((m) => m.name);
      if (data && data.settings && data.settings.summaryTime) S.settings.summaryTime = data.settings.summaryTime;
      pushState();
      closeSheet();
      toast('اتسجل ' + ar(S.meds.length) + ' دواء');
      setTab('today');
    } catch (e) {
      toast('النص مش صالح: ' + e.message);
    }
  };
}

function openExportSheet() {
  openTextSheet('تصدير الجدول', 'خد النص ده واحفظه', '<textarea id="exportBox" rows="9" class="ta" readonly></textarea><div class="acts"><button class="act main" id="copyExp"><span>نسخ</span></button><button class="act clr" id="expClose"><span>إغلاق</span></button></div>');
  $('#exportBox').value = JSON.stringify({ meds: S.meds, settings: S.settings }, null, 1);
  $('#expClose').onclick = closeSheet;
  $('#copyExp').onclick = async () => {
    const box = $('#exportBox');
    try { await navigator.clipboard.writeText(box.value); toast('اتنسخ'); } catch (e) { box.focus(); box.select(); toast('حدّد النص وانسخه'); }
  };
}

/* Accepts either JSON or simple lines:
   07:30 بخاخ الصبح | كل يوم | على الدقن
   08:00 القرصين | خميس,جمعة | بعد الفطار
*/
function parseLines(text) {
  const map = { 'حد': 0, 'الأحد': 0, 'اتنين': 1, 'الاثنين': 1, 'تلات': 2, 'الثلاثاء': 2, 'أربع': 3, 'الأربعاء': 3, 'خميس': 4, 'الخميس': 4, 'جمعة': 5, 'الجمعة': 5, 'سبت': 6, 'السبت': 6 };
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split('|').map((x) => x.trim());
    const m = /^(\d{1,2}):(\d{2})\s+(.+)$/.exec(parts[0]);
    if (!m) continue;
    const time = String(m[1]).padStart(2, '0') + ':' + m[2];
    const name = m[3].trim();
    if (!name) continue;
    let days = [0, 1, 2, 3, 4, 5, 6];
    const dayTxt = parts[1] || 'كل يوم';
    if (!/كل يوم|كل الأيام|daily/i.test(dayTxt)) {
      const parsed = dayTxt.split(/[,،\s]+/).map((d) => (map[d] !== undefined ? map[d] : (/^\d$/.test(d) ? Number(d) : null))).filter((d) => d !== null);
      if (parsed.length) days = [...new Set(parsed)].sort((a, b) => a - b);
    }
    out.push({ id: 'm' + out.length + Date.now().toString(36).slice(-4), name: name.slice(0, 60), time, days, note: (parts[2] || '').slice(0, 80), active: true });
  }
  return out;
}

function openEditor(med) {
  const editing = !!med;
  const m = med || { id: '', name: '', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6], note: '' };
  const ed = $('#editor');
  let time = m.time;
  const chosen = new Set(m.days);
  const dayBtns = DAY_ORDER.map((i) => '<button type="button" class="dchip ' + (chosen.has(i) ? 'on' : '') + '" data-d="' + i + '">' + DAY_CHIP[i] + '</button>').join('');
  ed.innerHTML =
    '<header class="eh"><button class="back" id="eBack" aria-label="رجوع"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2B1F17" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button><h1>' + (editing ? 'تعديل الدوا' : 'دوا جديد') + '</h1></header>' +
    '<section class="ef">' +
      '<div class="eg"><label for="fName">الاسم</label><input id="fName" class="ein" value="' + esc(m.name) + '" placeholder="مثلاً: بخاخ الصبح" maxlength="60"></div>' +
      '<div class="eg"><label>الوقت</label><div class="ein timebox"><span class="tv" id="tShow">' + timeText(time) + '</span>' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6E5D50" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
        '<input id="fTime" type="time" value="' + esc(time) + '" aria-label="الوقت"></div></div>' +
      '<div class="eg"><span class="dl"><label style="margin:0">الأيام</label><button type="button" class="alld" id="allDays"></button></span><div class="dchips" id="fDays">' + dayBtns + '</div></div>' +
      '<div class="eg"><label for="fNote">ملاحظة</label><input id="fNote" class="ein" value="' + esc(m.note) + '" maxlength="80" placeholder="بعد الفطار / مع الغدا / قبل النوم">' +
        '<div class="sugs"><button type="button" class="sug">قبل الأكل</button><button type="button" class="sug">بعد الأكل</button><button type="button" class="sug">على الريق</button></div></div>' +
    '</section>' +
    '<section class="eb"><button class="save" id="fSave">حفظ</button>' +
      (editing ? '<button class="del" id="fDel">' + ICON_TRASH + '<span>امسح الدوا</span></button>' : '') + '</section>';
  ed.classList.remove('hidden');
  document.body.classList.add('noscroll');
  ed.scrollTop = 0;

  const syncAll = () => { $('#allDays').textContent = chosen.size === 7 ? 'كل الأيام' : chosen.size ? ar(chosen.size) + ' أيام' : 'اختار يوم'; };
  syncAll();
  ed.querySelectorAll('#fDays .dchip').forEach((d) => {
    d.onclick = () => {
      const i = Number(d.dataset.d);
      if (chosen.has(i)) { chosen.delete(i); d.classList.remove('on'); } else { chosen.add(i); d.classList.add('on'); }
      syncAll();
    };
  });
  $('#allDays').onclick = () => {
    const all = chosen.size !== 7;
    ed.querySelectorAll('#fDays .dchip').forEach((d) => {
      const i = Number(d.dataset.d);
      if (all) chosen.add(i); else chosen.delete(i);
      d.classList.toggle('on', all);
    });
    syncAll();
  };
  $('#fTime').onchange = () => { time = $('#fTime').value || time; $('#tShow').textContent = timeText(time); };
  ed.querySelectorAll('.sug').forEach((b) => { b.onclick = () => { $('#fNote').value = b.textContent; }; });
  $('#eBack').onclick = closeEditor;
  $('#fSave').onclick = () => {
    const name = $('#fName').value.trim();
    if (!name) return toast('اكتب اسم الدواء');
    const days = [...chosen].sort((a, b) => a - b);
    if (!days.length) return toast('اختار يوم واحد على الأقل');
    const rec = {
      id: m.id || 'm' + Date.now().toString(36),
      name: name.slice(0, 60),
      time: $('#fTime').value || time || '09:00',
      days,
      note: $('#fNote').value.trim().slice(0, 80),
      active: true
    };
    if (editing) S.meds = S.meds.map((x) => (x.id === rec.id ? rec : x));
    else S.meds.push(rec);
    pushState();
    closeEditor();
    toast(editing ? 'اتعدل' : 'اتضاف');
    render();
  };
  if (editing) {
    $('#fDel').onclick = () => {
      S.meds = S.meds.filter((x) => x.id !== m.id);
      pushState();
      closeEditor();
      toast('اتمسح');
      render();
    };
  }
}

/* ---------------------------------------------------------------- push */

function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function enablePush() {
  if (!workerBase()) return toast('حط رابط السيرفر الأول');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('المتصفح ده مش بيدعم الإشعارات (لازم iOS 16.4+)');
  if (Notification.permission === 'denied') return toast('الإشعارات مرفوضة. فعّلها من إعدادات الموبايل، وبعدين اقفل التطبيق وافتحه');
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('الإذن: ' + perm);
    const keyRes = await api('/vapid-public-key');
    if (!keyRes.publicKey) throw new Error('السيرفر مردّش مفتاح');
    const wanted = urlB64ToUint8Array(keyRes.publicKey);
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const cur = new Uint8Array(sub.options.applicationServerKey || new ArrayBuffer(0));
      const same = cur.length === wanted.length && cur.every((b, i) => b === wanted[i]);
      if (!same) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
      } catch (err) {
        if (err && err.name === 'InvalidStateError') {
          const old = await reg.pushManager.getSubscription();
          if (old) await old.unsubscribe();
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
        } else { throw err; }
      }
    }
    const out = await api('/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: S.device, subscription: sub.toJSON(), ua: navigator.userAgent })
    });
    if (out.ok) toast('تم الاشتراك ✅');
    else toast('السيرفر رفض: ' + (out.error || ''));
    refreshPermLine();
  } catch (e) {
    toast('فشل: ' + (e.message || e));
  }
}

async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await sub.unsubscribe();
    if (workerBase() && tokenValue()) await api('/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: S.device }) });
    toast('الإشعارات اتقفلت');
  } catch (e) {
    toast('فشل: ' + (e.message || e));
  }
  refreshPermLine();
}

async function testPush() {
  if (!workerBase()) return toast('حط رابط السيرفر الأول');
  try {
    const out = await api('/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: S.device }) });
    if (out.ok) toast('اتبعت إشعار تجريبي ✅ اقفل التطبيق وشوف');
    else toast('مفيش إشعار اتبعت: ' + (out.note || JSON.stringify(out.results || out).slice(0, 120)));
  } catch (e) {
    toast('فشل: ' + e.message);
  }
}

/* ---------------------------------------------------------------- boot */

document.querySelectorAll('nav button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
$('#sheet').onclick = (e) => { if (e.target.id === 'sheet') closeSheet(); };

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open-med') openFromParams('?med=' + encodeURIComponent(e.data.medId) + '&d=' + e.data.date);
  });
}

function openFromParams(search) {
  const p = new URLSearchParams(search);
  const medId = p.get('med');
  const d = p.get('d');
  if (!medId) { setTab('today'); return; }
  const med = S.meds.find((m) => m.id === medId);
  setTab('today');
  if (!med) return;
  setTimeout(() => openMarkSheet(med, d || cairoNow().date), 120);
}

render();
openFromParams(location.search);
pull().then(() => render());
window.addEventListener('online', () => { pull().then(() => render()); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) pull().then(() => render()); });
