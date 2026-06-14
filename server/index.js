import express from 'express';
import { kv } from './db.js';
import { fsSearch, fsFood } from './fatsecret.js';

const app  = express();
const PORT = process.env.PORT || 3001;

const SERVER_URL  = process.env.SERVER_URL  || `http://localhost:${PORT}`;
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'owner@example.com';

const STORE_ID        = '62000415';
const KROGER_BASE     = 'https://api.kroger.com/v1';
const KROGER_TOKEN_KEY = 'kroger_token';
const CAL_URLS_KEY    = 'cal_urls';
const SESSION_TTL     = 7 * 24 * 60 * 60;

const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com';

const MS_ACCOUNTS      = ['bba', 'craft'];
const MS_ACCOUNT_NAMES = { bba: 'BBA', craft: 'CRAFT' };
const MS_CLIENT_IDS    = {
  bba:   'YOUR_AZURE_CLIENT_ID_BBA',
  craft: 'YOUR_AZURE_CLIENT_ID',
};
const MS_SECRET_KEYS = { bba: 'AZURE_CLIENT_SECRET_BBA', craft: 'AZURE_CLIENT_SECRET' };
const MS_TENANTS     = { bba: 'YOUR_AZURE_TENANT_ID', craft: 'common' };

// ── MIDDLEWARE ──

// Behind the nginx reverse proxy — trust the first hop so req.ip reflects the
// real client (used for rate limiting).
app.set('trust proxy', 1);

app.use(express.json());

// Static files served before session middleware so the frontend loads without auth
app.use(express.static(import.meta.dirname + '/../web'));

// Routes that don't require a session token
const UNPROTECTED = new Set([
  '/auth/login', '/auth/verify', '/auth/logout',
  '/auth', '/callback',
  '/auth/google/start', '/auth/google/callback',
  '/auth/microsoft/start', '/auth/microsoft/callback',
  '/poll-token',
]);

// Routes a non-owner (grocery family member) is allowed to reach. Everything
// else is owner-only — the data model uses global keys, so an authenticated
// family member must not be able to read or mutate the owner's data.
const GROCERY_ALLOWED = new Set([
  'GET /grocery/user-data',
  'PUT /grocery/user-data',
  'GET /grocery/family',
  'POST /search-cart',
  'GET /fatsecret/search',
  'GET /fatsecret/food',
]);

// Read-only nutritionist: macro logs only. /auth/verify & /auth/logout are UNPROTECTED already.
const NUTRITIONIST_ALLOWED = new Set([
  'GET /meal-log',
  'GET /water-log',
]);

app.use(async (req, res, next) => {
  if (UNPROTECTED.has(req.path)) return next();
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const raw = kv.get(`session_${token}`);
  if (!raw) return res.status(401).json({ error: 'Unauthorized' });
  req.session = JSON.parse(raw);
  // Deny-by-default for non-owners: each role has its own explicit allowlist.
  if (req.session.email !== OWNER_EMAIL) {
    const key = `${req.method} ${req.path}`;
    const allowed = req.session.role === 'nutritionist'
      ? NUTRITIONIST_ALLOWED.has(key)
      : GROCERY_ALLOWED.has(key);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

// ── HELPERS ──

function toMtDate(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function htmlSend(res, html) {
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── RATE LIMITING ──
// In-memory fixed-window limiter. The app runs as a single systemd process,
// so a process-local map is sufficient.
const rateBuckets = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  // Opportunistic sweep so the map can't grow unbounded across many IPs.
  if (rateBuckets.size > 5000) {
    for (const [k, b] of rateBuckets) if (now > b.reset) rateBuckets.delete(k);
  }
  const b = rateBuckets.get(key);
  if (!b || now > b.reset) {
    rateBuckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

// Express middleware factory: limit `limit` requests per `windowMs` per client IP.
function limiter(name, limit, windowMs) {
  return (req, res, next) => {
    if (!rateLimit(`${name}:${req.ip}`, limit, windowMs)) {
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    next();
  };
}

// ── OAUTH CSRF STATE ──
// Single-use, short-lived nonce that binds an OAuth start to its callback,
// mitigating login-CSRF / authorization-code injection. Value carries context
// (e.g. the provider name, or the Microsoft account) so the callback can trust it.
function makeOAuthState(value) {
  const nonce = crypto.randomUUID();
  kv.put(`oauth_state:${nonce}`, value, { expirationTtl: 600 });
  return nonce;
}

function takeOAuthState(nonce) {
  if (!nonce) return null;
  const v = kv.get(`oauth_state:${nonce}`);
  if (v !== null) kv.delete(`oauth_state:${nonce}`); // single-use
  return v;
}

async function getGoogleToken() {
  const raw = kv.get('google_token');
  if (!raw) return null;
  const data = JSON.parse(raw);
  if (Date.now() < data.expires_at - 60000) return data.access_token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: data.refresh_token,
    }),
  });
  let newData; try { newData = await r.json(); } catch { return null; }
  if (!newData.access_token) { kv.delete('google_token'); return null; }
  kv.put('google_token', JSON.stringify({
    access_token:  newData.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + (newData.expires_in || 3600) * 1000,
  }));
  return newData.access_token;
}

async function getHealthCalendarId(token) {
  const cached = kv.get('health_dashboard_cal_id');
  if (cached) return cached;
  const r = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const { items = [] } = await r.json();
  const cal = items.find(c => c.summary === 'Health Dashboard');
  if (!cal) return null;
  kv.put('health_dashboard_cal_id', cal.id, { expirationTtl: 30 * 24 * 60 * 60 });
  return cal.id;
}

async function upsertCalEvent(calId, token, existingId, body) {
  if (existingId) {
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${existingId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: body.summary, description: body.description, start: body.start, end: body.end }),
    });
    if (r.ok) return (await r.json()).id;
  }
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Google ${r.status}: ${await r.text()}`);
  return (await r.json()).id;
}

async function fetchGoogleEvents(calendarId, targetDates) {
  const token = await getGoogleToken();
  if (!token) return { id: calendarId, error: 'not_authenticated' };
  const startDate = targetDates[0];
  const endDate   = targetDates[targetDates.length - 1];
  const params = new URLSearchParams({
    timeMin:      new Date(`${startDate}T00:00:00-07:00`).toISOString(),
    timeMax:      new Date(`${endDate}T23:59:59-06:00`).toISOString(),
    singleEvents: 'true',
    orderBy:      'startTime',
    maxResults:   '100',
  });
  let res;
  try {
    res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) { return { id: calendarId, error: e.message }; }
  if (!res.ok) return { id: calendarId, error: `Google ${res.status}: ${await res.text()}` };
  let data; try { data = await res.json(); } catch { return { id: calendarId, error: 'Bad JSON from Google' }; }
  const events = [];
  for (const ev of (data.items || [])) {
    try {
      if (ev.status === 'cancelled') continue;
      const self = ev.attendees?.find(a => a.self);
      if (self?.responseStatus === 'declined') continue;
      let startISO, endISO, mtDate;
      if (ev.start?.date) {
        mtDate   = ev.start.date;
        startISO = new Date(`${ev.start.date}T00:00:00Z`).toISOString();
        endISO   = new Date(`${ev.end?.date}T00:00:00Z`).toISOString();
      } else if (ev.start?.dateTime) {
        startISO = new Date(ev.start.dateTime).toISOString();
        endISO   = new Date(ev.end?.dateTime || ev.start.dateTime).toISOString();
        mtDate   = toMtDate(new Date(startISO).getTime());
      } else { continue; }
      if (!targetDates.includes(mtDate)) continue;
      events.push({ summary: ev.summary || 'Busy', start: startISO, end: endISO, date: mtDate });
    } catch { /* skip malformed event */ }
  }
  return { id: calendarId, events };
}

async function getMicrosoftToken(account) {
  const raw = kv.get(`ms_token_${account}`);
  if (!raw) return null;
  const data = JSON.parse(raw);
  if (Date.now() < data.expires_at - 60000) return data.access_token;
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANTS[account]}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     MS_CLIENT_IDS[account],
      client_secret: process.env[MS_SECRET_KEYS[account]],
      refresh_token: data.refresh_token,
    }),
  });
  let newData; try { newData = await res.json(); } catch { return null; }
  if (!newData.access_token) return null;
  kv.put(`ms_token_${account}`, JSON.stringify({
    access_token:  newData.access_token,
    refresh_token: newData.refresh_token || data.refresh_token,
    expires_at:    Date.now() + (newData.expires_in || 3600) * 1000,
  }));
  return newData.access_token;
}

async function fetchGraphEvents(account, targetDates) {
  const token = await getMicrosoftToken(account);
  if (!token) return { id: account, error: 'not_authenticated' };
  const startDate = targetDates[0];
  const endDate   = targetDates[targetDates.length - 1];
  const params = new URLSearchParams({
    startDateTime: new Date(`${startDate}T00:00:00-07:00`).toISOString(),
    endDateTime:   new Date(`${endDate}T23:59:59-06:00`).toISOString(),
    '$select':     'subject,start,end,isAllDay,isCancelled,showAs',
    '$top':        '100',
    '$orderby':    'start/dateTime',
  });
  let res;
  try {
    res = await fetch(`https://graph.microsoft.com/v1.0/me/calendarView?${params}`, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
    });
  } catch (e) { return { id: account, error: e.message }; }
  if (!res.ok) return { id: account, error: `Graph ${res.status}: ${await res.text()}` };
  let data; try { data = await res.json(); } catch { return { id: account, error: 'Bad JSON from Graph' }; }
  const events = [];
  for (const ev of (data.value || [])) {
    try {
      if (ev.isCancelled) continue;
      let startISO, endISO, mtDate;
      if (ev.isAllDay) {
        mtDate   = ev.start?.date;
        startISO = new Date(`${ev.start.date}T00:00:00Z`).toISOString();
        endISO   = new Date(`${ev.end?.date}T00:00:00Z`).toISOString();
      } else if (ev.start?.dateTime) {
        const dt = ev.start.dateTime;
        startISO = new Date(dt.endsWith('Z') ? dt : dt + 'Z').toISOString();
        const de = ev.end?.dateTime || dt;
        endISO   = new Date(de.endsWith('Z') ? de : de + 'Z').toISOString();
        mtDate   = toMtDate(new Date(startISO).getTime());
      } else { continue; }
      if (!targetDates.includes(mtDate)) continue;
      events.push({ summary: ev.subject || 'Busy', start: startISO, end: endISO, date: mtDate });
    } catch { /* skip malformed event */ }
  }
  return { id: account, events };
}

async function getKrogerToken() {
  const raw = kv.get(KROGER_TOKEN_KEY);
  if (!raw) return null;
  const data = JSON.parse(raw);
  if (Date.now() < data.expires_at - 60000) return data.access_token;
  if (!data.refresh_token) return null;
  const credentials = btoa(`${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`);
  const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: data.refresh_token }),
  });
  const newData = await res.json();
  if (!newData.access_token) return null;
  kv.put(KROGER_TOKEN_KEY, JSON.stringify({
    access_token:  newData.access_token,
    refresh_token: newData.refresh_token || data.refresh_token,
    expires_at:    Date.now() + (newData.expires_in || 1800) * 1000,
  }));
  return newData.access_token;
}

function krogerSearchTerm(item) {
  return item
    .replace(/—.*$/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/^\d+(\.\d+)?\s*(lb|lbs|oz|g|kg|ml|l|cup|cups|tbsp|tsp|count|pack|ct)?\s*/i, '')
    .replace(/\d+(\.\d+)?\s*(lb|lbs|oz|count|pack|ct|g|kg|ml|l)\b/gi, '')
    .replace(/\b(whole|fresh|dried|medium|large|small|boneless|skinless|bag|bottle|bunch|pack|jar|box|can|roll|sheet|count|tbsp|tsp|cup|cups|clove|cloves|pinch|handful)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── KROGER AUTH ROUTES ──

app.get('/auth', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.KROGER_CLIENT_ID,
    redirect_uri:  `${SERVER_URL}/callback`,
    scope:         'cart.basic:write product.compact',
    state:         makeOAuthState('kroger'),
  });
  res.redirect(302, `${KROGER_BASE}/connect/oauth2/authorize?${params}`);
});

app.get('/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return htmlSend(res, errorPage(error || 'No code returned'));
  if (takeOAuthState(state) !== 'kroger') return htmlSend(res, errorPage('Invalid or expired state'));
  const credentials = btoa(`${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`);
  const tokenRes = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${SERVER_URL}/callback` }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) return htmlSend(res, errorPage(JSON.stringify(tokenData)));
  kv.put(KROGER_TOKEN_KEY, JSON.stringify({
    access_token:  tokenData.access_token,
    refresh_token: tokenData.refresh_token || null,
    expires_at:    Date.now() + (tokenData.expires_in || 1800) * 1000,
  }));
  htmlSend(res, successPage());
});

app.get('/poll-token', (req, res) => {
  res.json({ connected: !!kv.get(KROGER_TOKEN_KEY) });
});

app.delete('/auth/kroger/disconnect', (req, res) => {
  kv.delete(KROGER_TOKEN_KEY);
  res.json({ ok: true });
});

// ── CALENDAR URL ROUTES ──

app.get('/cal-urls', (req, res) => {
  const raw = kv.get(CAL_URLS_KEY);
  res.json({ urls: raw ? JSON.parse(raw) : [] });
});

app.post('/cal-urls', (req, res) => {
  const body = req.body;
  const raw  = kv.get(CAL_URLS_KEY);
  const urls = raw ? JSON.parse(raw) : [];
  if (body.type === 'google') {
    const { calendarId, name } = body;
    if (!calendarId) return res.status(400).json({ error: 'Missing calendarId' });
    if (!urls.find(u => u.type === 'google' && u.calendarId === calendarId)) {
      urls.push({ id: calendarId, type: 'google', calendarId, name: name || calendarId });
      kv.put(CAL_URLS_KEY, JSON.stringify(urls));
    }
  } else {
    const { url: calUrl, name } = body;
    if (!calUrl) return res.status(400).json({ error: 'Missing url' });
    urls.push({ id: Date.now().toString(), url: calUrl, name: name || `Calendar ${urls.length + 1}` });
    kv.put(CAL_URLS_KEY, JSON.stringify(urls));
  }
  res.json({ urls });
});

app.delete('/cal-urls/:id', (req, res) => {
  const id   = decodeURIComponent(req.params.id);
  const raw  = kv.get(CAL_URLS_KEY);
  const urls = raw ? JSON.parse(raw) : [];
  const filtered = urls.filter(u => u.id !== id);
  kv.put(CAL_URLS_KEY, JSON.stringify(filtered));
  res.json({ urls: filtered });
});

// ── GOOGLE OAUTH ROUTES ──

app.get('/auth/google/start', (req, res) => {
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  `${SERVER_URL}/auth/google/callback`,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events',
    access_type:   'offline',
    prompt:        'consent',
    state:         makeOAuthState('google'),
  });
  res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return htmlSend(res, errorPage(error || 'No code returned'));
  if (takeOAuthState(state) !== 'google') return htmlSend(res, errorPage('Invalid or expired state'));
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri:  `${SERVER_URL}/auth/google/callback`,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) return htmlSend(res, errorPage(JSON.stringify(tokenData)));
  kv.put('google_token', JSON.stringify({
    access_token:  tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at:    Date.now() + (tokenData.expires_in || 3600) * 1000,
  }));
  htmlSend(res, googleSuccessPage());
});

app.get('/auth/google/status', (req, res) => {
  res.json({ connected: !!kv.get('google_token') });
});

app.get('/auth/google/calendars', async (req, res) => {
  const token = await getGoogleToken();
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  const r = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return res.status(r.status).json({ error: `Google ${r.status}` });
  const data = await r.json();
  const calendars = (data.items || []).map(c => ({
    id: c.id, name: c.summary, primary: !!c.primary, color: c.backgroundColor,
  }));
  res.json({ calendars });
});

app.delete('/auth/google/disconnect', (req, res) => {
  kv.delete('google_token');
  const raw     = kv.get(CAL_URLS_KEY);
  const calUrls = raw ? JSON.parse(raw) : [];
  kv.put(CAL_URLS_KEY, JSON.stringify(calUrls.filter(u => u.type !== 'google')));
  res.json({ ok: true });
});

// ── MICROSOFT OAUTH ROUTES ──

app.get('/auth/microsoft/start', (req, res) => {
  const account = req.query.account;
  if (!MS_ACCOUNTS.includes(account)) return res.status(400).json({ error: 'Invalid account' });
  const raw     = kv.get(CAL_URLS_KEY);
  const calUrls = raw ? JSON.parse(raw) : [];
  if (!calUrls.find(u => u.type === 'microsoft' && u.account === account)) {
    calUrls.push({ id: account, type: 'microsoft', account, name: MS_ACCOUNT_NAMES[account] });
    kv.put(CAL_URLS_KEY, JSON.stringify(calUrls));
  }
  const params = new URLSearchParams({
    client_id:     MS_CLIENT_IDS[account],
    response_type: 'code',
    redirect_uri:  `${SERVER_URL}/auth/microsoft/callback`,
    scope:         'Calendars.Read offline_access',
    state:         makeOAuthState(account),
    prompt:        'select_account',
  });
  res.redirect(302, `https://login.microsoftonline.com/${MS_TENANTS[account]}/oauth2/v2.0/authorize?${params}`);
});

app.get('/auth/microsoft/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return htmlSend(res, errorPage(error || 'No code returned'));
  const account = takeOAuthState(state);
  if (!account || !MS_ACCOUNTS.includes(account)) return htmlSend(res, errorPage('Invalid or expired state'));
  const tokenRes = await fetch(`https://login.microsoftonline.com/${MS_TENANTS[account]}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     MS_CLIENT_IDS[account],
      client_secret: process.env[MS_SECRET_KEYS[account]],
      code,
      redirect_uri:  `${SERVER_URL}/auth/microsoft/callback`,
      scope:         'Calendars.Read offline_access',
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) return htmlSend(res, errorPage(JSON.stringify(tokenData)));
  kv.put(`ms_token_${account}`, JSON.stringify({
    access_token:  tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at:    Date.now() + (tokenData.expires_in || 3600) * 1000,
  }));
  htmlSend(res, msSuccessPage(MS_ACCOUNT_NAMES[account]));
});

app.get('/auth/microsoft/status', async (req, res) => {
  const status = {};
  for (const account of MS_ACCOUNTS) status[account] = !!kv.get(`ms_token_${account}`);
  res.json(status);
});

app.delete('/auth/microsoft/disconnect', (req, res) => {
  const account = req.query.account;
  if (!MS_ACCOUNTS.includes(account)) return res.status(400).json({ error: 'Invalid account' });
  kv.delete(`ms_token_${account}`);
  const raw     = kv.get(CAL_URLS_KEY);
  const calUrls = raw ? JSON.parse(raw) : [];
  kv.put(CAL_URLS_KEY, JSON.stringify(calUrls.filter(u => !(u.type === 'microsoft' && u.account === account))));
  res.json({ ok: true });
});

// ── CALENDAR EVENTS ──

app.post('/fetch-calendars', async (req, res) => {
  const { dates, calendars = [] } = req.body;
  const targetDates = Array.isArray(dates) && dates.length
    ? dates
    : [toMtDate(Date.now()), toMtDate(Date.now() + 86400000)];
  if (!calendars.length) return res.status(400).json({ error: 'Missing calendars' });
  const results = [];
  for (const cal of calendars) {
    if (cal.type === 'microsoft') {
      results.push(await fetchGraphEvents(cal.account, targetDates));
    } else if (cal.type === 'google') {
      results.push(await fetchGoogleEvents(cal.calendarId, targetDates));
    }
  }
  res.json({ results });
});

// ── AUTH: SESSION ──

app.post('/auth/login', limiter('login', 10, 60_000), async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing credential' });
  const tokenRes  = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) return res.status(401).json({ error: 'Token verification failed', detail: tokenData });
  if (tokenData.email_verified !== 'true' && tokenData.email_verified !== true)
    return res.status(401).json({ error: 'Email not verified' });
  let role = null;
  if (tokenData.email === OWNER_EMAIL) {
    role = 'owner';
  } else {
    const familyRaw = kv.get('family_access');
    const family    = familyRaw ? JSON.parse(familyRaw) : [];
    if (family.find(m => m.email === tokenData.email)) role = 'grocery';
  }
  if (!role) {
    const nutriRaw = kv.get('nutritionist_access');
    const nutri    = nutriRaw ? JSON.parse(nutriRaw) : [];
    if (nutri.find(m => m.email === tokenData.email)) role = 'nutritionist';
  }
  if (!role) return res.status(401).json({ error: 'Account not allowed', email: tokenData.email });
  const token = crypto.randomUUID();
  const name  = tokenData.name || tokenData.given_name || tokenData.email.split('@')[0];
  kv.put(`session_${token}`, JSON.stringify({ email: tokenData.email, role, name }), { expirationTtl: SESSION_TTL });
  res.json({ token, email: tokenData.email, name, role });
});

app.get('/auth/verify', (req, res) => {
  const auth    = req.headers.authorization || '';
  const token   = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.json({ valid: false });
  const raw = kv.get(`session_${token}`);
  if (!raw) return res.json({ valid: false });
  const session = JSON.parse(raw);
  res.json({ valid: true, email: session.email, role: session.role || 'owner', name: session.name || '' });
});

app.delete('/auth/logout', (req, res) => {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) kv.delete(`session_${token}`);
  res.json({ ok: true });
});

// ── KROGER CART ──

app.get('/debug-search', async (req, res) => {
  const term  = req.query.term || 'ground beef';
  const token = await getKrogerToken();
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const searchRes = await fetch(
    `${KROGER_BASE}/products?filter.term=${encodeURIComponent(term)}&filter.locationId=${STORE_ID}&filter.limit=5`,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
  );
  const data = await searchRes.json();
  res.json({ status: searchRes.status, term, storeId: STORE_ID, data });
});

app.post('/search-cart', async (req, res) => {
  const { items } = req.body;
  if (!items) return res.status(400).json({ error: 'Missing items' });
  const accessToken = await getKrogerToken();
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated — reconnect City Market' });
  const results = [];
  for (const item of items) {
    try {
      const searchTerm = krogerSearchTerm(item);
      const searchRes  = await fetch(
        `${KROGER_BASE}/products?filter.term=${encodeURIComponent(searchTerm)}&filter.locationId=${STORE_ID}&filter.limit=10`,
        { headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` } }
      );
      const searchData = await searchRes.json();
      const products = (searchData?.data || []).map(p => ({
        upc: p.upc, name: p.description,
        size: p.items?.[0]?.size || '', price: p.items?.[0]?.price?.regular || null,
      }));
      results.push(products.length
        ? { item, searchTerm, status: 'found', selected: 0, products }
        : { item, searchTerm, status: 'not_found', products: [] });
    } catch (e) { results.push({ item, status: 'error', error: e.message, products: [] }); }
  }
  res.json({ results });
});

// Search FatSecret for a product/ingredient name and return a compact per-serving fsFood
// object (or null). Mirrors the client's _fsFoodFromFood shape so recipe ingredients backfilled
// server-side match those set in the UI. servingGrams is left null — the client derives scaling
// from servingDescription when needed.
const _ENRICH_STOPWORDS = new Set(['the','and','with','for','style','fresh','raw','natural','organic','plain','original','classic','premium','select','free','brand','pack','count']);
function _enrichTokens(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z]+/)
    .filter(w => w.length >= 3 && !_ENRICH_STOPWORDS.has(w)));
}

async function enrichIngredientWithFatSecret(nameOrIngredient) {
  const query = (typeof nameOrIngredient === 'string'
    ? nameOrIngredient
    : (nameOrIngredient?.krogerName || nameOrIngredient?.name || '')).trim();
  if (!query) return null;
  try {
    const search = await fsSearch(query);
    // Require name-token overlap so an unrelated first hit ("Raw Vegetable" for honey)
    // can't get attached. Rank by overlap before trying candidates.
    const qTokens = _enrichTokens(query);
    const ranked = (search.results || [])
      .map(c => {
        const cTokens = _enrichTokens(`${c.name} ${c.brand || ''}`);
        let overlap = 0;
        for (const t of cTokens) if (qTokens.has(t)) overlap++;
        return { c, s: overlap ? overlap / Math.sqrt((qTokens.size || 1) * (cTokens.size || 1)) : 0 };
      })
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map(x => x.c);
    for (const candidate of ranked.slice(0, 3)) {
      const food = await fsFood(candidate.id);
      const s = food?.servings?.[0];
      if (!s) continue;
      const n = s.nutrition || {};
      return {
        id: String(food.id ?? candidate.id),
        name: food.name ?? '',
        servingDescription: s.description ?? '',
        servingGrams: s.metricUnit === 'g' ? (s.metricAmount || null)
          : s.metricUnit === 'oz' ? (s.metricAmount ? s.metricAmount * 28.3495 : null)
          : null,
        kcal: n.kcal ?? 0, protein: n.protein ?? 0, carbs: n.carbs ?? 0, fat: n.fat ?? 0,
        fiber: n.fiber ?? 0, sugar: n.sugar ?? 0, saturatedFat: n.saturatedFat ?? 0,
        polyunsatFat: n.polyunsatFat ?? 0, cholesterol: n.cholesterol ?? 0,
        sodium: n.sodium ?? 0, potassium: n.potassium ?? 0,
      };
    }
  } catch {}
  return null;
}

app.post('/push-cart-confirmed', async (req, res) => {
  const { confirmed, recipeId } = req.body;
  if (!confirmed) return res.status(400).json({ error: 'Missing confirmed items' });
  const accessToken = await getKrogerToken();
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated — reconnect City Market' });
  const results = [];
  for (const c of confirmed) {
    try {
      const cartRes = await fetch(`${KROGER_BASE}/cart/add`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ items: [{ upc: c.upc, quantity: c.quantity || 1 }] }),
      });
      results.push({ item: c.item, productName: c.name, status: cartRes.ok ? 'added' : 'cart_error' });
    } catch (e) { results.push({ item: c.item, status: 'error', error: e.message }); }
  }
  const added = results.filter(r => r.status === 'added').length;

  // Backfill recipe ingredients with the purchased product's Kroger data + FatSecret nutrition.
  // The client may already have written fsFood from cart review; this fills any gaps server-side.
  if (recipeId) {
    try {
      const recipes = JSON.parse(kv.get('recipes') || '[]');
      const recipe = recipes.find(r => r.id === recipeId);
      if (recipe && Array.isArray(recipe.ingredients)) {
        let changed = false;
        for (const c of confirmed) {
          const ing = recipe.ingredients.find(i => c.item.toLowerCase().includes((i.name || '').toLowerCase()));
          if (!ing) continue;
          if (c.upc)  { ing.krogerUpc  = c.upc;  changed = true; }
          if (c.name) { ing.krogerName = c.name; changed = true; }
          if (!ing.fsFood) {
            const fs = await enrichIngredientWithFatSecret(ing.krogerName || ing.name);
            if (fs) { ing.fsFood = fs; changed = true; }
          }
        }
        if (changed) kv.put('recipes', JSON.stringify(recipes));
      }
    } catch {}
  }

  res.json({ results, summary: { added, failed: results.length - added, total: results.length } });
});

app.post('/push-cart', async (req, res) => {
  const { items } = req.body;
  if (!items) return res.status(400).json({ error: 'Missing items' });
  const accessToken = await getKrogerToken();
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated — reconnect City Market' });
  const results = [];
  for (const item of items) {
    try {
      const searchTerm = krogerSearchTerm(item);
      const searchRes  = await fetch(
        `${KROGER_BASE}/products?filter.term=${encodeURIComponent(searchTerm)}&filter.locationId=${STORE_ID}&filter.limit=1`,
        { headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` } }
      );
      const searchData = await searchRes.json();
      const product = searchData?.data?.[0];
      if (!product) { results.push({ item, searchTerm, status: 'not_found' }); continue; }
      const cartRes = await fetch(`${KROGER_BASE}/cart/add`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ items: [{ upc: product.upc, quantity: 1 }] }),
      });
      if (cartRes.ok) {
        results.push({ item, searchTerm, status: 'added', productName: product.description, upc: product.upc });
      } else {
        const err = await cartRes.json();
        results.push({ item, searchTerm, status: 'cart_error', productName: product.description, error: err });
      }
    } catch (e) { results.push({ item, status: 'error', error: e.message }); }
  }
  const added = results.filter(r => r.status === 'added').length;
  res.json({ results, summary: { added, failed: results.length - added, total: items.length } });
});

// ── PREFS ──

app.get('/prefs', (req, res) => {
  const raw = kv.get('user_prefs');
  res.json(raw ? JSON.parse(raw) : {});
});

app.put('/prefs', (req, res) => {
  kv.put('user_prefs', JSON.stringify(req.body));
  res.json({ ok: true });
});

// ── WORKOUT ──

app.get('/workout-start', (req, res) => {
  const raw = kv.get('workout_overrides');
  res.json({ workoutOverrides: raw ? JSON.parse(raw) : {} });
});

app.put('/workout-start', (req, res) => {
  kv.put('workout_overrides', JSON.stringify(req.body.workoutOverrides || {}));
  res.json({ ok: true });
});

app.post('/push-workout-event', async (req, res) => {
  const token = await getGoogleToken();
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  const { silent, workoutStart, date: reqDate } = req.body;
  const calId = await getHealthCalendarId(token);
  if (!calId) return res.status(404).json({ error: 'No "Health Dashboard" calendar found in your Google Calendar.' });

  const ws   = Math.max(360, Math.min(1380, +workoutStart || 960));
  const date = reqDate || toMtDate(Date.now());
  const pad  = n => String(n).padStart(2, '0');

  const [yr, mo, dy] = date.split('-').map(Number);
  const marchFirst = new Date(Date.UTC(yr, 2, 1));
  const dstStart   = new Date(Date.UTC(yr, 2, 8 + (7 - marchFirst.getUTCDay()) % 7, 9));
  const novFirst   = new Date(Date.UTC(yr, 10, 1));
  const dstEnd     = new Date(Date.UTC(yr, 10, 1 + (7 - novFirst.getUTCDay()) % 7, 8));
  const offsetHours = new Date(Date.UTC(yr, mo - 1, dy, 12)) >= dstStart &&
                      new Date(Date.UTC(yr, mo - 1, dy, 12)) < dstEnd ? -6 : -7;
  const offsetStr = `${offsetHours < 0 ? '-' : '+'}${pad(Math.abs(offsetHours))}:00`;
  const dt = m => `${date}T${pad(Math.floor(m / 60))}:${pad(m % 60)}:00${offsetStr}`;

  const kvKey  = `health:cal:events:${date}`;
  const existing = JSON.parse(kv.get(kvKey) || '{}');
  if (silent && !Object.keys(existing).length) return res.json({ ok: true, skipped: true });

  const eventDefs = {
    zynStop:    { summary: 'Zyn Hard Stop',       description: '90 min pre-decompression cutoff · REM protection',              start: { dateTime: dt(ws - 90) }, end: { dateTime: dt(ws - 75) } },
    preWorkout: { summary: 'Pre-Workout Fuel',    description: 'Banana + walnuts · 60 min buffer before decompression stack',    start: { dateTime: dt(ws - 60) }, end: { dateTime: dt(ws) } },
    decomp:     { summary: 'Decompression Stack', description: 'BetterMe calisthenics (25m) → Peloton Zone 2–3 (30m) → Stretching (15m)', start: { dateTime: dt(ws) }, end: { dateTime: dt(ws + 70) } },
    postShake:  { summary: 'Post-Workout Shake',  description: 'ON Whey + Fairlife · ~40g protein',                             start: { dateTime: dt(ws + 70) }, end: { dateTime: dt(ws + 85) } },
  };

  const ids = {};
  for (const [key, evt] of Object.entries(eventDefs)) {
    try { ids[key] = await upsertCalEvent(calId, token, existing[key], evt); }
    catch (err) { return res.status(500).json({ error: err.message }); }
  }
  kv.put(kvKey, JSON.stringify(ids), { expirationTtl: 7 * 24 * 60 * 60 });
  res.json({ ok: true });
});

// ── WAKE TIMES ──

app.get('/wake-times', (req, res) => {
  const raw = kv.get('wake_times');
  let wakeOverrides = {}, wfhDays = {};
  if (raw) {
    const d = JSON.parse(raw);
    if (d.wakeOverrides !== undefined || d.wfhDays !== undefined) {
      wakeOverrides = d.wakeOverrides || {};
      wfhDays       = d.wfhDays || {};
    } else {
      wakeOverrides = d;
    }
  }
  res.json({ wakeOverrides, wfhDays });
});

app.put('/wake-times', (req, res) => {
  kv.put('wake_times', JSON.stringify({
    wakeOverrides: req.body.wakeOverrides || {},
    wfhDays:       req.body.wfhDays || {},
  }));
  res.json({ ok: true });
});

// ── MEAL LOG ──

app.get('/meal-log', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const raw  = kv.get(`meal-log:${date}`);
  res.json({ meals: raw ? JSON.parse(raw) : [] });
});

app.put('/meal-log', (req, res) => {
  const { date, meals } = req.body;
  if (!date || !Array.isArray(meals)) return res.status(400).json({ error: 'bad request' });
  kv.put(`meal-log:${date}`, JSON.stringify(meals));
  res.json({ ok: true });
});

// ── WATER LOG ──
// Per-day water intake in fluid ounces, broken out by distribution window, stored
// alongside the meal log under water-log:YYYY-MM-DD as { windows: { [id]: oz } }.
// Legacy entries were a bare numeric daily total; those are returned as empty
// windows (no per-window breakdown to recover).

app.get('/water-log', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const raw  = kv.get(`water-log:${date}`);
  if (!raw) return res.json({ windows: {} });
  const data = JSON.parse(raw);
  if (typeof data === 'number') return res.json({ windows: {}, legacyTotal: data });
  res.json({ windows: data.windows || {} });
});

app.put('/water-log', (req, res) => {
  const { date, windows } = req.body;
  if (!date || typeof windows !== 'object' || windows === null || Array.isArray(windows))
    return res.status(400).json({ error: 'bad request' });
  // Sanitize: keep only positive, finite, integer ounce values keyed by window id.
  const clean = {};
  for (const [id, v] of Object.entries(windows)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) clean[id] = Math.round(n);
  }
  kv.put(`water-log:${date}`, JSON.stringify({ windows: clean }));
  res.json({ ok: true });
});

// ── RECIPES ──

app.get('/recipes', (req, res) => {
  const raw = kv.get('recipes');
  res.json({ recipes: raw ? JSON.parse(raw) : [] });
});

app.post('/recipes', (req, res) => {
  const recipe  = req.body;
  const raw     = kv.get('recipes');
  const recipes = raw ? JSON.parse(raw) : [];
  if (!recipe.id) recipe.id = crypto.randomUUID();
  recipe.savedAt = new Date().toISOString();
  recipes.push(recipe);
  kv.put('recipes', JSON.stringify(recipes));
  res.json({ ok: true, recipe });
});

app.post('/admin/normalize-recipes', (req, res) => {
  if (!req.session || req.session.email !== OWNER_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  const VOL = new Set(['tsp','teaspoon','teaspoons','tbsp','tablespoon','tablespoons','cup','cups']);
  const WT  = new Set(['oz','ounce','ounces','lb','lbs','pound','pounds','g','gram','grams','ml']);
  function normalizeIngredient(ing) {
    const name = ((ing.name || '')
      .replace(/\(.*?\)/g, '').replace(/,.*$/, '')
      .replace(/^\s*(large|small|medium|extra-?large|xl|ripe|whole)\s+/i, '')
      .replace(/\s+/g, ' ').trim()) || ing.name;
    const u = (ing.unit || '').toLowerCase().trim();
    let unit = ing.unit;
    if (u && !VOL.has(u) && !WT.has(u)) {
      if (/^(large|small|medium|extra-?large|xl|ripe|whole|count|piece|pieces|each)$/i.test(u)) {
        unit = '';
      } else {
        const bn = name.toLowerCase(), uSing = u.replace(/s$/, '');
        if (bn === u || bn === uSing || bn.startsWith(uSing + ' ') || bn.startsWith(u + ' ')) unit = '';
      }
    }
    return { ...ing, name, unit };
  }
  const raw     = kv.get('recipes');
  const recipes = raw ? JSON.parse(raw) : [];
  let modified  = 0;
  const normalized = recipes.map(recipe => {
    const newIngs = (recipe.ingredients || []).map(ing => normalizeIngredient(ing));
    const changed = newIngs.some((ing, i) =>
      ing.name !== recipe.ingredients[i].name || ing.unit !== recipe.ingredients[i].unit);
    if (changed) modified++;
    return { ...recipe, ingredients: newIngs };
  });
  kv.put('recipes', JSON.stringify(normalized));
  res.json({ ok: true, total: recipes.length, modified });
});

// Backfill the `components` array onto legacy recipes saved before that field existed.
// Owner-only. Asks Haiku for components only (no full regeneration), processes recipes
// sequentially, persists after each success (resumable), and never aborts on a single
// bad response.
app.post('/admin/backfill-components', limiter('backfill', 3, 600_000), async (req, res) => {
  if (!req.session || req.session.email !== OWNER_EMAIL) return res.status(403).json({ error: 'Forbidden' });

  const backfillSystem = `You are analyzing a recipe to identify its logical storage components.

Given this recipe, return ONLY a JSON array of components — no other fields, no markdown.

Component rules:
- A component boundary only exists where a cook would store food in a separate container in the fridge
- If ingredients are combined in the same pan, pot, or bowl during cooking they belong in the same component — even if they started separate
- The test: after cooking, could this component be refrigerated and reheated independently? If no, it belongs with whatever it was combined with
- Ingredients added at serving time only (bread, tortillas, raw toppings, garnishes, condiments never heated with the main dish) go in a separate component
- Every ingredient must appear in exactly one component — no omissions or duplicates
- Use 1 to 4 components. A SINGLE component is correct when everything is mixed or cooked together (e.g. a hash, scramble, soup, or casserole). Only split into 2-4 when parts are genuinely stored separately. Maximum 4.
- Component names should be practical and fridge-storage descriptive
- Each component's perServing macros must sum exactly to the recipe's total perServing across all four fields

Respond with ONLY a valid JSON array — no markdown, no explanation:
[{"name":"string","ingredients":["ingredient names"],"perServing":{"kcal":number,"protein":number,"carbs":number,"fat":number}}]`;

  // Validate + normalize a parsed Haiku response. Tolerant of two common quirks:
  // the array wrapped in an object ({components:[...]}), and macros returned as
  // numeric strings. Returns { components } on success or { error: <reason> }.
  function normalizeComponents(comps) {
    if (comps && !Array.isArray(comps) && Array.isArray(comps.components)) comps = comps.components;
    if (!Array.isArray(comps)) return { error: `not a JSON array (got ${comps === null ? 'null' : typeof comps})` };
    if (comps.length < 1 || comps.length > 4) return { error: `got ${comps.length} component(s), need 1-4` };
    const out = [];
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i] || {};
      if (typeof c.name !== 'string' || !c.name.trim()) return { error: `component ${i + 1} missing name` };
      if (!Array.isArray(c.ingredients)) return { error: `component ${i + 1} (${c.name}) missing ingredients array` };
      const ps = c.perServing || {};
      const perServing = {};
      for (const k of ['kcal', 'protein', 'carbs', 'fat']) {
        const n = Number(ps[k]);
        if (!isFinite(n)) return { error: `component ${i + 1} (${c.name}) has invalid ${k}` };
        perServing[k] = n;
      }
      out.push({ name: c.name.trim(), ingredients: c.ingredients, perServing });
    }
    return { components: out };
  }

  const recipes = JSON.parse(kv.get('recipes') || '[]');
  let updated = 0, skipped = 0;
  const errors = [];

  for (const recipe of recipes) {
    if (Array.isArray(recipe.components) && recipe.components.length > 0) { skipped++; continue; }
    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, system: backfillSystem, messages: [{ role: 'user', content: `Recipe: ${JSON.stringify(recipe)}` }] }),
      });
      if (!aiRes.ok) { errors.push({ id: recipe.id, name: recipe.name, error: `AI ${aiRes.status}` }); continue; }
      const aiData = await aiRes.json();
      const text = aiData.content?.[0]?.text || '';
      const truncated = aiData.stop_reason === 'max_tokens';
      let comps;
      try { comps = JSON.parse(text); }
      catch { const m = text.match(/\[[\s\S]*\]/); try { comps = m ? JSON.parse(m[0]) : null; } catch { comps = null; } }
      const result = normalizeComponents(comps);
      if (result.error) {
        errors.push({ id: recipe.id, name: recipe.name, error: truncated ? `${result.error} (response truncated — raise max_tokens)` : result.error });
        continue;
      }
      recipe.components = result.components;
      kv.put('recipes', JSON.stringify(recipes)); // persist after each success — resumable
      updated++;
    } catch (e) {
      errors.push({ id: recipe.id, name: recipe.name, error: e.message });
    }
  }

  res.json({ total: recipes.length, updated, skipped, errors });
});

app.post('/recipes/generate', limiter('ai', 20, 300_000), async (req, res) => {
  const { cuisine, cookTime, servings: reqServings, notes = '', existingNames = [], mealType = 'dinner' } = req.body;
  const isSolo = mealType === 'breakfast' || mealType === 'lunch' || mealType === 'snack';
  const servings = reqServings || (isSolo ? 1 : 4);
  const mealContext = {
    breakfast: `BREAKFAST for one person. Must be quick (under 15 min) or no-cook. High protein to start the day. Does not need to be a traditional breakfast food — can be a protein bowl, overnight oats, eggs, Greek yogurt parfait, etc. Target ~400-500 kcal and 35-45g protein for this single serving.`,
    lunch:     `LUNCH for one person. Quick (under 20 min) or no-cook/assembly only. High protein, satisfying, won't weigh you down. Target ~450-550 kcal and 40-50g protein for this single serving.`,
    dinner:    `DINNER for a family of 4 (wife + adult son eat anything; daughter is 8 and picky — note how to adapt for her). Target 400-500 kcal and 35-50g protein per serving.`,
    snack:     `SNACK for one person. Quick or no-prep (under 10 min). Something portable or simple — Greek yogurt, protein shake, rice cakes with nut butter, cottage cheese, string cheese + fruit, trail mix, etc. Target ~200-300 kcal and 15-25g protein. Keep it simple; snacks should not require real cooking.`,
  }[mealType] || '';
  const system = `You are a personal recipe assistant for a health-conscious 43-year-old male doing body recomposition in Craig, Colorado. Daily targets: 1900 kcal / 150g protein / 160g carbs / 73g fat.

This recipe is a ${mealContext}

Rules:
- Use ingredients available at a rural City Market grocery store
- Never include salmon
- Bold, satisfying flavors — not diet food
- Filling within the calorie budget

Avoid these already-saved recipe names: ${existingNames.length ? existingNames.join(', ') : 'none'}.

Ingredient format rules — follow exactly:
- ALL amounts are TOTALS for all servings combined — NOT per-serving amounts. If servings=4, list enough for all 4 people.
- "amount": plain number string only (e.g. "4", "1.5", "0.25") — never include the unit in this field
- "unit": a standard cooking measurement (tsp, tbsp, cup, oz, lb, g) OR empty string "" for whole countable items (eggs, avocados, tortillas, patties, apples, cloves, muffins, pork chops, chicken breasts, etc.)
- For whole protein items (pork chops, chicken breasts, steaks, fish fillets) use COUNT as amount with unit="" — NOT weight. E.g. for 4 people: {"name":"pork chops","amount":"4","unit":""}
- For ground/bulk proteins use weight: {"name":"ground beef","amount":"1.5","unit":"lb"}
- "name": the base ingredient name only — no size descriptors (large, small, ripe, whole)
- NEVER put a food noun in the unit field
- NEVER put a size descriptor in the unit field
- Correct dinner examples (4 servings): {"name":"pork chops","amount":"4","unit":""}, {"name":"chicken breasts","amount":"4","unit":""}, {"name":"ground beef","amount":"1.5","unit":"lb"}, {"name":"olive oil","amount":"3","unit":"tbsp"}, {"name":"garlic","amount":"6","unit":""}, {"name":"eggs","amount":"2","unit":""}

Component rules — follow exactly:
- Group the ingredients into 1-4 logical "components" based on how they are physically prepared or assembled (minimum 1, maximum 4). Use a SINGLE component when everything is mixed or cooked together (e.g. a hash, scramble, soup, or casserole); only split when parts are genuinely stored separately.
- A component boundary only exists where a cook would store the food in a separate container in the fridge. If two ingredients are combined in the same pan, pot, or bowl during cooking, they belong in the same component — even if they started separate. The test is: after cooking, could this component be refrigerated and reheated independently without the other components? If no, it belongs with whatever it was combined with.
- Mixed/cooked ingredients that are combined together during cooking go in ONE component.
- Ingredients added at serving time that are NOT mixed in go in a SEPARATE component (bread, tortillas, buns, raw toppings, garnishes, condiments).
- Component names should be practical and fridge-storage descriptive, e.g. "Tuna Filling", "Bread & Assembly", "Seasoned Beef", "Toppings".
- Each component's "ingredients" is an array of ingredient NAME strings copied verbatim from the main "ingredients" array.
- Every ingredient must appear in exactly ONE component — no omissions, no duplicates. EXCEPTION: a shared cooking fat (e.g. olive oil, butter) used in more than one component may be listed in each component that uses it. When a fat is shared this way, split its macros across those components (or count them in only one) so the component "perServing" values still sum exactly to the recipe total.
- Each component has its own "perServing" macros. Across all components, these MUST sum exactly to the recipe's total "perServing" for all four fields (kcal, protein, carbs, fat). Verify the sums before responding.
- Worked example — a "Skillet Beef & Cheddar Gnocchi" recipe (ingredients: ground beef, onion, garlic, beef broth, Worcestershire, hot sauce, pepper, salt, gnocchi, butter, sharp cheddar, heavy cream, fresh thyme, olive oil, broccoli) has EXACTLY TWO components: "Beef & Gnocchi Skillet" = ground beef, onion, garlic, beef broth, Worcestershire, hot sauce, pepper, salt, gnocchi, butter, sharp cheddar, heavy cream, fresh thyme, olive oil (everything cooked together in the one pan); and "Roasted Broccoli" = broccoli, olive oil (roasted separately as a side — olive oil is a shared cooking fat, so it is listed in both components with its macros split between them). It is WRONG to split the skillet into separate beef / sauce / cheese / gnocchi components — they cook and are stored together as one dish.

Respond with ONLY valid JSON — no markdown, no explanation — matching this schema exactly:
{"name":"string","mealType":"breakfast|lunch|dinner|snack","cuisine":"Mexican|Asian|American|Italian","cookTime":number,"servings":number,"weekendOnly":boolean,"kidPlate":"string or null","ingredients":[{"name":"string","amount":"string","unit":"string"}],"steps":["string"],"perServing":{"kcal":number,"protein":number,"carbs":number,"fat":number},"components":[{"name":"string","ingredients":["string"],"perServing":{"kcal":number,"protein":number,"carbs":number,"fat":number}}],"tags":["string"],"notes":"string or null"}`;

  const userMsg = `Generate a${cuisine ? ' ' + cuisine : ''} ${mealType} recipe${cookTime ? ' under ' + cookTime + ' minutes' : ''}${notes ? '. Notes: ' + notes : ''}.`;
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, system, messages: [{ role: 'user', content: userMsg }] }),
  });
  if (!aiRes.ok) return res.status(500).json({ error: 'AI generation failed' });
  const aiData = await aiRes.json();
  const text   = aiData.content?.[0]?.text || '';
  let recipe;
  try { recipe = JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); if (!m) return res.status(500).json({ error: 'Bad AI response' }); recipe = JSON.parse(m[0]); }
  recipe.id = crypto.randomUUID();
  res.json({ recipe });
});

// Strip an HTML document down to readable text for recipe extraction: drop
// non-content elements (and their contents) entirely, remove remaining tags,
// decode the handful of common entities, collapse whitespace, and cap length —
// recipe content always lives in the first portion of the page.
function htmlToText(html) {
  return html
    .replace(/<(script|style|nav|header|footer|aside|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

const RECIPE_IMPORT_SYSTEM = `You are a recipe extraction assistant. Extract the recipe from the provided webpage text and return it formatted to match this exact schema. If the page contains no recipe, return {"error":"no_recipe_found"}.

Rules:
- Infer mealType from context: breakfast/lunch/dinner/snack
- Infer cuisine: Mexican/Asian/American/Italian — pick closest match
- cookTime: total time in minutes as a number
- servings: number as provided, default 4 if not specified
- weekendOnly: false unless recipe is clearly elaborate/time-consuming (over 60 min)
- kidPlate: note any kid-friendly adaptations mentioned, otherwise null
- ingredients: extract all ingredients following these rules exactly:
  - amount: plain number string only, TOTALS for all servings combined
  - unit: standard cooking measurement (tsp, tbsp, cup, oz, lb, g) OR empty string for whole countable items
  - name: base ingredient name only, no size descriptors
- steps: array of instruction strings
- perServing: estimate kcal/protein/carbs/fat per serving based on ingredients — these are estimates
- tags: relevant tags inferred from the recipe
- notes: any useful tips or notes from the recipe, otherwise null

Respond with ONLY valid JSON — no markdown, no explanation:
{"name":"string","mealType":"breakfast|lunch|dinner|snack","cuisine":"Mexican|Asian|American|Italian","cookTime":number,"servings":number,"weekendOnly":boolean,"kidPlate":"string or null","ingredients":[{"name":"string","amount":"string","unit":"string"}],"steps":["string"],"perServing":{"kcal":number,"protein":number,"carbs":number,"fat":number},"tags":["string"],"notes":"string or null"}`;

// Import a recipe from any cooking-site URL: fetch the page, strip it to text,
// have Haiku extract a schema-matching recipe, and return it for client-side
// review (not auto-saved). Owner-only; rate-limited (imports are expensive).
app.post('/recipes/import-url', limiter('import', 10, 3_600_000), async (req, res) => {
  if (!req.session || req.session.email !== OWNER_EMAIL) return res.status(403).json({ error: 'Forbidden' });

  const { url } = req.body || {};
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return res.status(400).json({ error: 'URL must start with http:// or https://' });

  let pageRes;
  try {
    pageRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
  } catch (e) {
    const msg = (e.name === 'TimeoutError' || e.name === 'AbortError')
      ? "That site took too long to respond — try again or use a different URL."
      : `Couldn't reach that page (${e.message}).`;
    return res.status(400).json({ error: msg });
  }
  if (!pageRes.ok) return res.status(400).json({ error: `That page returned an error (HTTP ${pageRes.status}).` });

  let html;
  try { html = await pageRes.text(); } catch { return res.status(400).json({ error: "Couldn't read that page's content." }); }
  const text = htmlToText(html);
  if (!text) return res.status(422).json({ error: 'No recipe found on that page' });

  let aiRes;
  try {
    aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, system: RECIPE_IMPORT_SYSTEM, messages: [{ role: 'user', content: text }] }),
    });
  } catch { return res.status(500).json({ error: 'Recipe extraction failed' }); }
  if (!aiRes.ok) return res.status(500).json({ error: 'Recipe extraction failed' });

  const aiData = await aiRes.json();
  const out    = aiData.content?.[0]?.text || '';
  let recipe;
  try { recipe = JSON.parse(out); }
  catch { const m = out.match(/\{[\s\S]*\}/); if (!m) return res.status(500).json({ error: 'Bad AI response' }); try { recipe = JSON.parse(m[0]); } catch { return res.status(500).json({ error: 'Bad AI response' }); } }
  if (recipe?.error === 'no_recipe_found') return res.status(422).json({ error: 'No recipe found on that page' });

  recipe.id = crypto.randomUUID();
  res.json({ recipe });
});

app.put('/recipes/:id', (req, res) => {
  const raw     = kv.get('recipes');
  const recipes = raw ? JSON.parse(raw) : [];
  const idx     = recipes.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  recipes[idx] = { ...recipes[idx], ...req.body };
  kv.put('recipes', JSON.stringify(recipes));
  res.json({ ok: true, recipe: recipes[idx] });
});

app.delete('/recipes/:id', (req, res) => {
  const raw     = kv.get('recipes');
  const recipes = raw ? JSON.parse(raw) : [];
  kv.put('recipes', JSON.stringify(recipes.filter(r => r.id !== req.params.id)));
  res.json({ ok: true });
});

app.post('/recipes/:id/remix', limiter('ai', 20, 300_000), async (req, res) => {
  const raw      = kv.get('recipes');
  const recipes  = raw ? JSON.parse(raw) : [];
  const original = recipes.find(r => r.id === req.params.id);
  if (!original) return res.status(404).json({ error: 'Recipe not found' });
  const { direction = '' } = req.body;
  const system  = `You are a personal recipe assistant. Create a fresh variation of the provided recipe.
Keep similar per-serving macros (~${original.perServing.kcal} kcal, ~${original.perServing.protein}g protein).
Ingredients must be available at a rural Colorado City Market. Never include salmon.

Component rules — follow exactly:
- Group the ingredients into 1-4 logical "components" based on how they are physically prepared or assembled (minimum 1, maximum 4). Use a SINGLE component when everything is mixed or cooked together (e.g. a hash, scramble, soup, or casserole); only split when parts are genuinely stored separately.
- A component boundary only exists where a cook would store the food in a separate container in the fridge. If two ingredients are combined in the same pan, pot, or bowl during cooking, they belong in the same component — even if they started separate. The test is: after cooking, could this component be refrigerated and reheated independently without the other components? If no, it belongs with whatever it was combined with.
- Mixed/cooked ingredients that are combined together during cooking go in ONE component.
- Ingredients added at serving time that are NOT mixed in go in a SEPARATE component (bread, tortillas, buns, raw toppings, garnishes, condiments).
- Component names should be practical and fridge-storage descriptive, e.g. "Tuna Filling", "Bread & Assembly", "Seasoned Beef", "Toppings".
- Each component's "ingredients" is an array of ingredient NAME strings copied verbatim from the main "ingredients" array.
- Every ingredient must appear in exactly ONE component — no omissions, no duplicates. EXCEPTION: a shared cooking fat (e.g. olive oil, butter) used in more than one component may be listed in each component that uses it. When a fat is shared this way, split its macros across those components (or count them in only one) so the component "perServing" values still sum exactly to the recipe total.
- Each component has its own "perServing" macros. Across all components, these MUST sum exactly to the recipe's total "perServing" for all four fields (kcal, protein, carbs, fat). Verify the sums before responding.
- Worked example — a "Skillet Beef & Cheddar Gnocchi" recipe (ingredients: ground beef, onion, garlic, beef broth, Worcestershire, hot sauce, pepper, salt, gnocchi, butter, sharp cheddar, heavy cream, fresh thyme, olive oil, broccoli) has EXACTLY TWO components: "Beef & Gnocchi Skillet" = ground beef, onion, garlic, beef broth, Worcestershire, hot sauce, pepper, salt, gnocchi, butter, sharp cheddar, heavy cream, fresh thyme, olive oil (everything cooked together in the one pan); and "Roasted Broccoli" = broccoli, olive oil (roasted separately as a side — olive oil is a shared cooking fat, so it is listed in both components with its macros split between them). It is WRONG to split the skillet into separate beef / sauce / cheese / gnocchi components — they cook and are stored together as one dish.

Respond with ONLY valid JSON — no markdown — matching this schema exactly:
{"name":"string","cuisine":"Mexican|Asian|American|Italian","cookTime":number,"servings":number,"weekendOnly":boolean,"kidPlate":"string or null","ingredients":[{"name":"string","amount":"string","unit":"string"}],"steps":["string"],"perServing":{"kcal":number,"protein":number,"carbs":number,"fat":number},"components":[{"name":"string","ingredients":["string"],"perServing":{"kcal":number,"protein":number,"carbs":number,"fat":number}}],"tags":["string"],"notes":"string or null"}`;
  const userMsg = `Original: ${JSON.stringify(original)}\n\nCreate a variation${direction ? ': ' + direction : ' with a different flavor profile or technique'}.`;
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, system, messages: [{ role: 'user', content: userMsg }] }),
  });
  if (!aiRes.ok) return res.status(500).json({ error: 'AI remix failed' });
  const aiData = await aiRes.json();
  const text   = aiData.content?.[0]?.text || '';
  let recipe;
  try { recipe = JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); if (!m) return res.status(500).json({ error: 'Bad AI response' }); recipe = JSON.parse(m[0]); }
  recipe.id = crypto.randomUUID();
  res.json({ recipe });
});

// ── FATSECRET ──

app.get('/fatsecret/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const branded  = req.query.branded || '0';
  const cacheKey = `fs:search:${q.toLowerCase()}${branded === '1' ? ':b' : ''}`;
  const cached   = kv.get(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const data = await fsSearch(q);
  if (!data._fs_error) kv.put(cacheKey, JSON.stringify(data), { expirationTtl: 86400 });
  res.json(data);
});

app.get('/fatsecret/food', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing food ID' });
  const cacheKey = `fs:food:${id}`;
  const cached   = kv.get(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const data = await fsFood(id);
  if (!data) return res.status(404).json({ error: 'Not found' });
  kv.put(cacheKey, JSON.stringify(data), { expirationTtl: 604800 });
  res.json(data);
});

app.get('/fatsecret/test', async (req, res) => {
  const q    = req.query.q || 'chicken breast';
  const data = await fsSearch(q);
  res.json({ stage: data.results?.length ? 'ok' : 'no_results', resultCount: data.results?.length ?? 0, first: data.results?.[0]?.name ?? null });
});

// ── FAMILY ACCESS ──

app.get('/family-access', (req, res) => {
  if (!req.session || req.session.email !== OWNER_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  const raw = kv.get('family_access');
  res.json({ members: raw ? JSON.parse(raw) : [] });
});

app.post('/family-access', (req, res) => {
  if (!req.session || req.session.email !== OWNER_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const raw     = kv.get('family_access');
  const members = raw ? JSON.parse(raw) : [];
  if (!members.find(m => m.email === email)) {
    members.push({ email, name: name || email.split('@')[0] });
    kv.put('family_access', JSON.stringify(members));
  }
  res.json({ members });
});

app.delete('/family-access/:email', (req, res) => {
  if (!req.session || req.session.email !== OWNER_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  const email   = decodeURIComponent(req.params.email);
  const raw     = kv.get('family_access');
  const members = (raw ? JSON.parse(raw) : []).filter(m => m.email !== email);
  kv.put('family_access', JSON.stringify(members));
  res.json({ members });
});

// ── NUTRITIONIST ACCESS ──

app.get('/nutritionist-access', (req, res) => {
  if (!req.session || req.session.email !== OWNER_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  const raw = kv.get('nutritionist_access');
  res.json({ members: raw ? JSON.parse(raw) : [] });
});

app.post('/nutritionist-access', (req, res) => {
  if (!req.session || req.session.email !== OWNER_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const raw     = kv.get('nutritionist_access');
  const members = raw ? JSON.parse(raw) : [];
  if (!members.find(m => m.email === email)) {
    members.push({ email, name: name || email.split('@')[0] });
    kv.put('nutritionist_access', JSON.stringify(members));
  }
  res.json({ members });
});

app.delete('/nutritionist-access/:email', (req, res) => {
  if (!req.session || req.session.email !== OWNER_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  const email   = decodeURIComponent(req.params.email);
  const raw     = kv.get('nutritionist_access');
  const members = (raw ? JSON.parse(raw) : []).filter(m => m.email !== email);
  kv.put('nutritionist_access', JSON.stringify(members));
  res.json({ members });
});

// ── GROCERY ──

app.get('/grocery/user-data', (req, res) => {
  const raw = kv.get(`grocery:user:${req.session.email}`);
  res.json(raw ? JSON.parse(raw) : { staples: [], items: [] });
});

app.put('/grocery/user-data', (req, res) => {
  const { staples = [], items = [] } = req.body;
  kv.put(`grocery:user:${req.session.email}`, JSON.stringify({ staples, items }));
  res.json({ ok: true });
});

app.get('/grocery/family', (req, res) => {
  const familyRaw = kv.get('family_access');
  const members   = familyRaw ? JSON.parse(familyRaw) : [];
  const results   = members.map(m => {
    const raw = kv.get(`grocery:user:${m.email}`);
    return { email: m.email, name: m.name, ...(raw ? JSON.parse(raw) : { staples: [], items: [] }) };
  });
  res.json({ users: results });
});

app.post('/grocery/family-item-remove', (req, res) => {
  if (req.session.email !== OWNER_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  const { email, idx, type } = req.body;
  if (!email || idx === undefined) return res.status(400).json({ error: 'Missing fields' });
  const raw = kv.get(`grocery:user:${email}`);
  const data = raw ? JSON.parse(raw) : { items: [], staples: [] };
  const arr = type === 'staple' ? (data.staples = data.staples || []) : (data.items = data.items || []);
  if (idx >= 0 && idx < arr.length) arr.splice(idx, 1);
  kv.put(`grocery:user:${email}`, JSON.stringify(data));
  res.json({ ok: true });
});

// ── PANTRY ──

app.get('/pantry', (req, res) => {
  const raw = kv.get('pantry');
  res.json({ pantry: raw ? JSON.parse(raw) : [] });
});

app.put('/pantry', (req, res) => {
  const { pantry } = req.body;
  if (!Array.isArray(pantry)) return res.status(400).json({ error: 'bad request' });
  kv.put('pantry', JSON.stringify(pantry));
  res.json({ ok: true });
});

// ── PREPARED MEALS ──

app.get('/prepared-meals', (req, res) => {
  const raw = kv.get('prepared-meals');
  res.json({ preparedMeals: raw ? JSON.parse(raw) : [] });
});

app.put('/prepared-meals', (req, res) => {
  const { preparedMeals } = req.body;
  if (!Array.isArray(preparedMeals)) return res.status(400).json({ error: 'bad request' });
  kv.put('prepared-meals', JSON.stringify(preparedMeals));
  res.json({ ok: true });
});

app.post('/prepared-meals/:id/consume', (req, res) => {
  const { portions = 1 } = req.body;
  const raw = kv.get('prepared-meals');
  const meals = raw ? JSON.parse(raw) : [];
  const idx = meals.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  meals[idx].portionsRemaining = Math.max(0, meals[idx].portionsRemaining - portions);
  if (meals[idx].portionsRemaining === 0) meals.splice(idx, 1);
  kv.put('prepared-meals', JSON.stringify(meals));
  res.json({ ok: true, preparedMeals: meals });
});

// ── SPA FALLBACK ──

app.get('*', (req, res) => res.sendFile(import.meta.dirname + '/../web/index.html'));

// ── START ──

app.listen(PORT, () => console.log(`Health Dashboard running on port ${PORT} — ${SERVER_URL}`));

// ── HTML PAGES ──

function successPage() {
  return `<!DOCTYPE html><html><head><title>Connected</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f0f}.card{text-align:center;padding:40px;background:#1a1a1a;border-radius:16px;border:1px solid #2e2e2e}h2{color:#1D9E75;margin-bottom:8px}p{color:#a0a0a0;margin:0;font-size:14px}</style>
</head><body><div class="card"><h2>✓ Connected!</h2><p>City Market authorized.</p><p style="margin-top:12px;color:#666">You can close this window.</p></div></body></html>`;
}

function googleSuccessPage() {
  return `<!DOCTYPE html><html><head><title>Connected</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f0f}.card{text-align:center;padding:40px;background:#1a1a1a;border-radius:16px;border:1px solid #2e2e2e}h2{color:#1D9E75;margin-bottom:8px}p{color:#a0a0a0;margin:0;font-size:14px}</style>
</head><body><div class="card"><h2>✓ Connected!</h2><p>Google Calendar authorized.</p><p style="margin-top:12px;color:#666">You can close this window and select your calendars in the app.</p></div></body></html>`;
}

function msSuccessPage(name) {
  return `<!DOCTYPE html><html><head><title>Connected</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f0f}.card{text-align:center;padding:40px;background:#1a1a1a;border-radius:16px;border:1px solid #2e2e2e}h2{color:#1D9E75;margin-bottom:8px}p{color:#a0a0a0;margin:0;font-size:14px}</style>
</head><body><div class="card"><h2>✓ Connected!</h2><p>${name} calendar authorized.</p><p style="margin-top:12px;color:#666">You can close this window.</p></div></body></html>`;
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><title>Auth Error</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f0f}.card{text-align:center;padding:40px;background:#1a1a1a;border-radius:16px;border:1px solid #2e2e2e}h2{color:#E24B4A;margin-bottom:8px}p{color:#a0a0a0;margin:0;font-size:14px}</style>
</head><body><div class="card"><h2>Authorization failed</h2><p>${escapeHtml(msg)}</p><p style="margin-top:12px;color:#666">Close this window and try again.</p></div></body></html>`;
}
