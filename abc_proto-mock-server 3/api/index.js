// Proto mock server — Delhivery (B2C) + Pine Labs (Plural v3) + 2 imagined capabilities.
// Endpoint paths and field names follow each partner's public docs. Failures are triggered
// by inputs the TEAM controls (member pincode / envelope id in the profile sheet), so every
// bad path can be reproduced on camera.

const express = require('express');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const DELHIVERY_TOKEN = process.env.DELHIVERY_TOKEN || 'proto-delhivery-token';
const PINE_CLIENT_ID = process.env.PINE_CLIENT_ID || 'proto-client';
const PINE_CLIENT_SECRET = process.env.PINE_CLIENT_SECRET || 'proto-secret';
const DELIVER_AFTER_SEC = parseInt(process.env.DELIVER_AFTER_SEC || '120', 10);


// ---------- Live event log (Upstash Redis via Vercel Marketplace; falls back to memory) ----------
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const memEvents = [];
async function redis(cmd) {
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(cmd) });
  return (await r.json()).result;
}
async function pushEvent(ev) {
  try {
    if (REDIS_URL) { await redis(['LPUSH', 'events', JSON.stringify(ev)]); await redis(['LTRIM', 'events', '0', '299']); }
    else { memEvents.unshift(ev); memEvents.length = Math.min(memEvents.length, 300); }
  } catch (e) { /* logging must never break the API */ }
}
async function listEvents() {
  if (REDIS_URL) return ((await redis(['LRANGE', 'events', '0', '299'])) || []).map((x) => JSON.parse(x));
  return memEvents;
}
const memKV = {};
const kv = {
  async get(k) { if (REDIS_URL) { const v = await redis(['GET', k]); return v ? JSON.parse(v) : null; } return memKV[k] ?? null; },
  async set(k, v) { if (REDIS_URL) return redis(['SET', k, JSON.stringify(v)]); memKV[k] = v; },
  async push(k, v) { if (REDIS_URL) return redis(['RPUSH', k, JSON.stringify(v)]); (memKV[k] = memKV[k] || []).push(v); },
  async drain(k) {
    if (REDIS_URL) { const items = (await redis(['LRANGE', k, '0', '-1'])) || []; if (items.length) await redis(['LTRIM', k, String(items.length), '-1']); return items.map((x) => JSON.parse(x)); }
    const items = memKV[k] || []; memKV[k] = []; return items;
  },
};
const clip = (v, n = 4000) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…[truncated]' : s; };
function partnerOf(path) {
  if (path.startsWith('/gnani')) return 'Gnani';
  if (path.startsWith('/telegram')) return 'Telegram';
  if (path.startsWith('/memory') || path.startsWith('/family')) return 'Memory';
  if (path.includes('/envelopes') || path.includes('/hyperlocal')) return 'Imagined';
  if (path.startsWith('/api/pay') || path.startsWith('/api/auth')) return 'Pine Labs';
  return 'Delhivery';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();


// Log every partner call (request + exact response) before it is sent, so the dashboard shows it live.
app.use((req, res, next) => {
  if (req.path === '/' || req.path.startsWith('/dashboard') || req.path.startsWith('/events') || req.path.startsWith('/gnani/audio') || req.path.startsWith('/mcp') || req.path.startsWith('/setup') || req.path === '/favicon.ico') return next();
  const t0 = Date.now();
  const origSend = res.send.bind(res);
  let done = false;
  res.send = (body) => {
    if (done) return origSend(body);
    done = true;
    const ev = { id: `${t0}-${Math.random().toString(36).slice(2, 7)}`, ts: new Date(t0).toISOString(), partner: partnerOf(req.path), method: req.method, path: req.originalUrl, request: clip(req.body && Object.keys(req.body).length ? req.body : ''), status: res.statusCode, response: clip(Buffer.isBuffer(body) ? `<binary ${body.length} bytes>` : body), ms: Date.now() - t0 };
    pushEvent(ev).finally(() => origSend(body));
    return res;
  };
  next();
});

// ---------- Scenario table (by pincode) ----------
// 000000 / anything not 6 digits -> not serviceable
// 380099 -> no rider available (shipment create fails)
// 380098 -> timeout (9s hang, then 504)
// 380097 -> malformed reply (HTTP 200, broken JSON)
// 380096 -> shipment created, delivery attempt fails (Undelivered -> RTO)
// any other 6-digit pin -> happy path
function pinScenario(pin) {
  const p = String(pin || '').trim();
  if (!/^\d{6}$/.test(p) || p === '000000') return 'not_serviceable';
  return { '380099': 'no_rider', '380098': 'timeout', '380097': 'malformed', '380096': 'undelivered' }[p] || 'ok';
}

async function applyTransportFaults(scenario, res) {
  if (scenario === 'timeout') {
    await sleep(9000);
    res.status(504).type('text/html').send('<html><body><h1>504 Gateway Time-out</h1></body></html>');
    return true;
  }
  if (scenario === 'malformed') {
    res.status(200).type('application/json').send('{"success": true, "packages": [{"waybill": "1490');
    return true;
  }
  return false;
}

// ---------- Auth ----------
function delhiveryAuth(req, res, next) {
  const h = req.get('Authorization') || '';
  if (h !== `Token ${DELHIVERY_TOKEN}`) {
    return res.status(401).json({ detail: 'Authentication credentials were not provided.' });
  }
  next();
}
function pineAuth(req, res, next) {
  const h = req.get('Authorization') || '';
  if (!h.startsWith('Bearer mock_')) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or expired access token' });
  }
  next();
}

// ---------- Health ----------
app.get('/', (req, res) => {
  res.json({
    service: 'proto-mock-server',
    time: nowIso(),
    delhivery: ['GET /c/api/pin-codes/json/', 'POST /api/cmu/create.json', 'GET /api/v1/packages/json/', 'POST /api/p/edit', 'POST /fm/request/new/'],
    pinelabs: ['POST /api/auth/v1/token', 'POST /api/pay/v1/orders', 'PUT /api/pay/v1/orders/:order_id/capture', 'PUT /api/pay/v1/orders/:order_id/cancel'],
    imagined: ['POST /api/hyperlocal/v1/basket-quote (Delhivery)', 'GET /api/pay/v1/envelopes/:envelope_id (Pine Labs)', 'POST /api/pay/v1/envelopes/:envelope_id/authorize (Pine Labs)'],
  });
});

// =====================================================================
// DELHIVERY
// =====================================================================

// Pincode serviceability
app.get('/c/api/pin-codes/json/', delhiveryAuth, async (req, res) => {
  const pin = req.query.filter_codes;
  const sc = pinScenario(pin);
  if (await applyTransportFaults(sc, res)) return;
  if (sc === 'not_serviceable') return res.json({ delivery_codes: [] });
  res.json({
    delivery_codes: [{
      postal_code: {
        pin: Number(pin), district: 'Ahmedabad', state_code: 'GJ', country_code: 'IN',
        pre_paid: 'Y', cash: 'Y', cod: 'Y', pickup: 'Y', repl: 'Y', is_oda: 'N',
        max_amount: 0, max_weight: 0, sort_code: 'AMD/BOP', inc: 'Ahmedabad_Bopal_D (Gujarat)',
        remarks: '',
      },
    }],
  });
});

// Shipment creation — accepts Delhivery's form style (format=json&data=...) or plain JSON
app.post('/api/cmu/create.json', delhiveryAuth, async (req, res) => {
  let payload = req.body;
  try {
    if (typeof req.body.data === 'string') payload = JSON.parse(req.body.data);
  } catch (e) {
    return res.status(400).json({ success: false, rmk: 'Invalid JSON in data field', packages: [], package_count: 0 });
  }
  const shipment = (payload.shipments || [])[0];
  if (!shipment || !shipment.pin || !shipment.name || !shipment.add) {
    return res.status(400).json({ success: false, rmk: 'Mandatory fields missing: name, add, pin', packages: [], package_count: 0 });
  }
  const sc = pinScenario(shipment.pin);
  if (await applyTransportFaults(sc, res)) return;
  if (sc === 'not_serviceable') {
    return res.json({ success: false, package_count: 1, packages: [{ status: 'Fail', waybill: '', refnum: shipment.order || '', remarks: ['Non serviceable pincode'] }], rmk: 'Non serviceable pincode' });
  }
  if (sc === 'no_rider') {
    return res.json({ success: false, package_count: 1, packages: [{ status: 'Fail', waybill: '', refnum: shipment.order || '', remarks: ['No rider available for pickup in the requested slot. Next available slot: tomorrow 09:00-11:00'] }], rmk: 'No rider available' });
  }
  const digit = sc === 'undelivered' ? '6' : '0';
  const waybill = `149${digit}${Math.floor(Date.now() / 1000)}`; // 14 digits, encodes creation time
  res.json({
    success: true, package_count: 1, cod_count: 0, prepaid_count: 1, replacement_count: 0, pickups_count: 0, cash_pickups_count: 0, cod_amount: 0,
    upload_wbn: `UPL${Date.now()}`,
    packages: [{ status: 'Success', waybill, refnum: shipment.order || '', client: 'PROTO-SURFACE', sort_code: 'AMD/BOP', remarks: [], cod_amount: 0, payment: shipment.payment_mode || 'Pre-paid', serviceable: true }],
    rmk: '',
  });
});

// Tracking — status derived from time elapsed since the waybill was created
app.get('/api/v1/packages/json/', delhiveryAuth, (req, res) => {
  const wb = String(req.query.waybill || '');
  if (!/^149\d\d{10}$/.test(wb)) {
    return res.json({ ShipmentData: [], Error: 'No such waybill or Order Id found' });
  }
  const failing = wb[3] === '6';
  const created = parseInt(wb.slice(4), 10) * 1000;
  const elapsed = (Date.now() - created) / 1000;
  const scans = [];
  const scan = (Status, StatusType, Instructions, t) => scans.push({ ScanDetail: { Scan: Status, ScanType: StatusType, ScanDateTime: new Date(t).toISOString(), ScannedLocation: 'Ahmedabad_Bopal_D (Gujarat)', Instructions } });
  scan('Manifested', 'UD', 'Consignment manifested', created);
  let status = { Status: 'Manifested', StatusType: 'UD', Instructions: 'Consignment manifested' };
  if (elapsed > DELIVER_AFTER_SEC * 0.33) { scan('In Transit', 'UD', 'Picked up from partner store', created + DELIVER_AFTER_SEC * 330); status = { Status: 'In Transit', StatusType: 'UD', Instructions: 'Picked up from partner store' }; }
  if (elapsed > DELIVER_AFTER_SEC * 0.66) { scan('Dispatched', 'UD', 'Out for delivery', created + DELIVER_AFTER_SEC * 660); status = { Status: 'Dispatched', StatusType: 'UD', Instructions: 'Out for delivery' }; }
  if (elapsed > DELIVER_AFTER_SEC) {
    if (failing) {
      scan('Pending', 'UD', 'Consignee unavailable. Door locked', created + DELIVER_AFTER_SEC * 1000);
      status = { Status: 'Pending', StatusType: 'UD', Instructions: 'Consignee unavailable. Door locked' };
      if (elapsed > DELIVER_AFTER_SEC * 1.5) { scan('RTO', 'RT', 'Return initiated after failed attempt', created + DELIVER_AFTER_SEC * 1500); status = { Status: 'RTO', StatusType: 'RT', Instructions: 'Return initiated after failed attempt' }; }
    } else {
      scan('Delivered', 'DL', 'Delivered to consignee', created + DELIVER_AFTER_SEC * 1000);
      status = { Status: 'Delivered', StatusType: 'DL', Instructions: 'Delivered to consignee' };
    }
  }
  res.json({
    ShipmentData: [{
      Shipment: {
        AWB: wb, Origin: 'Ahmedabad_Bopal_D (Gujarat)', Destination: 'Ahmedabad', OrderType: 'Pre-paid',
        PickUpDate: new Date(created).toISOString(),
        Status: { ...status, StatusDateTime: nowIso(), StatusLocation: 'Ahmedabad_Bopal_D (Gujarat)' },
        Scans: scans,
      },
    }],
  });
});

// Cancel shipment
app.post('/api/p/edit', delhiveryAuth, (req, res) => {
  const { waybill, cancellation } = req.body || {};
  if (!waybill || String(cancellation) !== 'true') {
    return res.status(400).json({ status: false, error: 'waybill and cancellation=true required' });
  }
  res.json({ status: true, waybill, remark: 'Shipment has been cancelled.' });
});

// Pickup request
app.post('/fm/request/new/', delhiveryAuth, (req, res) => {
  const { pickup_location, pickup_date, pickup_time, expected_package_count } = req.body || {};
  if (!pickup_location || !pickup_date || !pickup_time) {
    return res.status(400).json({ error: 'pickup_location, pickup_date and pickup_time are required' });
  }
  res.json({ pickup_id: Math.floor(Date.now() / 1000), pickup_location_name: pickup_location, pickup_date, pickup_time, expected_package_count: expected_package_count || 1, incoming_center_name: 'Ahmedabad_Bopal_D' });
});

// =====================================================================
// PINE LABS (Plural v3 shapes)
// =====================================================================

app.post('/api/auth/v1/token', (req, res) => {
  const { client_id, client_secret, grant_type } = req.body || {};
  if (client_id !== PINE_CLIENT_ID || client_secret !== PINE_CLIENT_SECRET || grant_type !== 'client_credentials') {
    return res.status(401).json({ code: 'INVALID_CLIENT', message: 'Invalid client credentials' });
  }
  res.json({ access_token: `mock_${Date.now()}`, expires_at: new Date(Date.now() + 3600e3).toISOString() });
});

// Create order (pre_auth true -> funds will be held, captured after delivery)
app.post('/api/pay/v1/orders', pineAuth, (req, res) => {
  const b = req.body || {};
  const amt = b.order_amount || {};
  if (!b.merchant_order_reference || !Number.isInteger(amt.value) || amt.value <= 0 || amt.currency !== 'INR') {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'merchant_order_reference and order_amount {value (paise, integer), currency: INR} are required' });
  }
  const order_id = `v1-${Date.now()}-${amt.value}`;
  res.json({
    data: {
      order_id, merchant_order_reference: b.merchant_order_reference, type: 'CHARGE', status: 'CREATED',
      merchant_id: '111077', order_amount: amt, pre_auth: !!b.pre_auth, notes: b.notes || '',
      purchase_details: b.purchase_details || {}, created_at: nowIso(), updated_at: nowIso(),
    },
  });
});

app.put('/api/pay/v1/orders/:order_id/capture', pineAuth, (req, res) => {
  const { order_id } = req.params;
  const b = req.body || {};
  const held = parseInt(order_id.split('-')[2] || '0', 10);
  const cap = (b.capture_amount || {}).value;
  if (!b.merchant_capture_reference || !Number.isInteger(cap)) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'merchant_capture_reference and capture_amount {value, currency} are required' });
  }
  if (cap > held) return res.status(422).json({ code: 'CAPTURE_AMOUNT_EXCEEDED', message: `Capture ${cap} exceeds authorised ${held}` });
  res.json({ data: { order_id, status: 'PROCESSED', captured_amount: { value: cap, currency: 'INR' }, merchant_capture_reference: b.merchant_capture_reference, updated_at: nowIso() } });
});

app.put('/api/pay/v1/orders/:order_id/cancel', pineAuth, (req, res) => {
  res.json({ data: { order_id: req.params.order_id, status: 'CANCELLED', message: 'Authorisation released; payer not charged', updated_at: nowIso() } });
});

// =====================================================================
// IMAGINED CAPABILITY 1 — Pine Labs: delegated health-spend envelope
// The adult child funds it; the agent may draw on it only for the beneficiary's flagged needs.
// envelope ids: ENV-LOW (balance too low), ENV-SLOW (timeout), anything else = healthy
// =====================================================================
function envelope(id) {
  const base = { envelope_id: id, funded_by: 'caregiver', beneficiary: 'member', currency: 'INR', monthly_limit: 500000, per_txn_cap: 50000, allowed_categories: ['grocery_protein', 'diagnostics', 'pharmacy'], period: '2026-10' };
  if (id === 'ENV-LOW') return { ...base, spent_this_month: 495000, available: 5000 };
  return { ...base, spent_this_month: 24700, available: 475300 };
}

app.get('/api/pay/v1/envelopes/:envelope_id', pineAuth, async (req, res) => {
  if (req.params.envelope_id === 'ENV-SLOW') { await sleep(9000); return res.status(504).send('Gateway Timeout'); }
  res.json({ data: envelope(req.params.envelope_id) });
});

app.post('/api/pay/v1/envelopes/:envelope_id/authorize', pineAuth, async (req, res) => {
  const id = req.params.envelope_id;
  if (id === 'ENV-SLOW') { await sleep(9000); return res.status(504).send('Gateway Timeout'); }
  const b = req.body || {};
  const v = (b.amount || {}).value;
  const env = envelope(id);
  if (!b.order_id || !Number.isInteger(v) || !b.category || !b.approver_ref) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'order_id, amount {value, currency}, category and approver_ref are required' });
  }
  if (!env.allowed_categories.includes(b.category)) return res.status(422).json({ code: 'CATEGORY_NOT_ALLOWED', message: `Category ${b.category} is outside this envelope` });
  if (v > env.per_txn_cap) return res.status(422).json({ code: 'PER_TXN_CAP_EXCEEDED', message: `Amount ${v} exceeds per-transaction cap ${env.per_txn_cap}` });
  if (v > env.available) return res.status(402).json({ code: 'INSUFFICIENT_BALANCE', message: `Envelope has ${env.available} paise available; ${v} requested`, available: env.available });
  res.json({ data: { order_id: b.order_id, envelope_id: id, status: 'AUTHORIZED', hold_id: `HOLD-${Date.now()}`, amount: b.amount, available_after: env.available - v, approver_ref: b.approver_ref, authorized_at: nowIso() } });
});

// =====================================================================
// IMAGINED CAPABILITY 2 — Delhivery: hyperlocal basket quote
// Given a pincode + a nutrient gap, returns a priced basket from the nearest partner store.
// Prices come from here, never from the model.
// =====================================================================
const CATALOG = [
  { sku: 'CURD-400', name: 'Dahi (curd) 400 g', price_inr: 45, protein_g: 14, diet: 'veg' },
  { sku: 'PANEER-200', name: 'Paneer 200 g', price_inr: 92, protein_g: 36, diet: 'veg' },
  { sku: 'SOYA-200', name: 'Soya chunks 200 g', price_inr: 42, protein_g: 104, diet: 'veg' },
  { sku: 'CHANA-500', name: 'Roasted chana 500 g', price_inr: 68, protein_g: 90, diet: 'veg' },
  { sku: 'MILK-1L', name: 'Toned milk 1 L', price_inr: 56, protein_g: 31, diet: 'veg' },
  { sku: 'EGG-6', name: 'Eggs, 6 pack', price_inr: 48, protein_g: 36, diet: 'egg' },
];

app.post('/api/hyperlocal/v1/basket-quote', delhiveryAuth, async (req, res) => {
  const b = req.body || {};
  const sc = pinScenario(b.pincode);
  if (await applyTransportFaults(sc, res)) return;
  if (sc === 'not_serviceable') return res.json({ success: false, error: 'No partner store serves this pincode' });
  const diet = b.diet || 'veg';
  const pool = CATALOG.filter((i) => diet === 'egg' || i.diet === 'veg');
  let items;
  if (Array.isArray(b.items) && b.items.length) {
    items = b.items.map((r) => {
      const c = CATALOG.find((i) => i.sku === r.sku);
      return c ? { ...c, qty: r.qty || 1 } : { sku: r.sku, error: 'SKU not stocked' };
    });
  } else {
    const gap = Number(b.protein_gap_g || 0) * Number(b.days || 3);
    const budget = Number(b.max_inr || 500);
    const ranked = [...pool].sort((a, c) => c.protein_g / c.price_inr - a.protein_g / a.price_inr);
    items = []; let p = 0, cost = 0;
    for (const it of [...ranked, ...ranked]) {
      if (p >= gap) break;
      if (cost + it.price_inr > budget) continue;
      const ex = items.find((x) => x.sku === it.sku);
      if (ex) ex.qty += 1; else items.push({ ...it, qty: 1 });
      p += it.protein_g; cost += it.price_inr;
    }
  }
  const ok = items.filter((i) => !i.error);
  const total = ok.reduce((s, i) => s + i.price_inr * i.qty, 0);
  res.json({
    success: true, quote_id: `Q-${Date.now()}`, valid_until: new Date(Date.now() + 30 * 60e3).toISOString(),
    store: { name: 'Shree Krishna Provision Store', pickup_location: 'PROTO-PARTNER-STORE-BOPAL', pincode: '380058', distance_km: 1.8 },
    items: items.map((i) => (i.error ? i : { sku: i.sku, name: i.name, qty: i.qty, unit_price_inr: i.price_inr, protein_g: i.protein_g * i.qty })),
    total_inr: total, total_protein_g: ok.reduce((s, i) => s + i.protein_g * i.qty, 0),
    estimated_delivery_minutes: 45,
  });
});

// =====================================================================
// GNANI (REAL) — thin proxy so AgenticOrg can call Gnani with plain JSON.
// Gnani STT needs multipart file upload; most agent connectors only send JSON. This bridges that.
// Responses from Gnani are returned unchanged.
// =====================================================================
const GNANI_API_KEY = process.env.GNANI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GNANI_BASE = 'https://api.vachana.ai';

async function resolveAudio(b) {
  if (b.audio_base64) return Buffer.from(b.audio_base64, 'base64');
  let url = b.audio_url;
  if (!url && b.telegram_file_id) {
    if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set on the server');
    const f = await (await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(b.telegram_file_id)}`)).json();
    if (!f.ok) throw new Error(`Telegram getFile failed: ${f.description}`);
    url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${f.result.file_path}`;
  }
  if (!url) throw new Error('Send one of: telegram_file_id, audio_url, audio_base64');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not download audio (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

app.post('/gnani/stt', async (req, res) => {
  if (!GNANI_API_KEY) return res.status(500).json({ success: false, error: { type: 'CONFIG', message: 'GNANI_API_KEY not set on the server' } });
  const b = req.body || {};
  let audio;
  try { audio = await resolveAudio(b); } catch (e) { return res.status(400).json({ success: false, error: { type: 'AUDIO_INPUT', message: e.message } }); }
  const form = new FormData();
  form.append('audio_file', new Blob([audio]), b.filename || 'voice.ogg');
  form.append('language_code', b.language_code || 'hi-IN');
  form.append('format', b.format || 'transcribe');
  try {
    const r = await fetch(`${GNANI_BASE}/stt/v3`, { method: 'POST', headers: { 'X-API-Key-ID': GNANI_API_KEY }, body: form });
    const text = await r.text();
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    res.status(502).json({ success: false, error: { type: 'UPSTREAM', message: `Gnani unreachable: ${e.message}` } });
  }
});

async function gnaniTTS({ text, language = 'hi-IN', voice = 'Nalini' }) {
  const r = await fetch(`${GNANI_BASE}/api/v1/tts/inference`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key-ID': GNANI_API_KEY },
    body: JSON.stringify({ text, voice, model: 'timbre-v2.5', language, speed: 1.0, audio_config: { sample_rate: 48000, num_channels: 1, sample_width: 2, encoding: 'linear_pcm', container: 'wav' } }),
  });
  if (!r.ok) throw Object.assign(new Error(await r.text()), { status: r.status });
  return Buffer.from(await r.arrayBuffer());
}

// Synthesise and (optionally) deliver to Telegram as an audio message.
app.post('/gnani/tts', async (req, res) => {
  if (!GNANI_API_KEY) return res.status(500).json({ success: false, error: { type: 'CONFIG', message: 'GNANI_API_KEY not set on the server' } });
  const b = req.body || {};
  if (!b.text) return res.status(400).json({ success: false, error: { type: 'INVALID_REQUEST', message: 'text is required' } });
  let wav;
  try { wav = await gnaniTTS(b); } catch (e) { return res.status(e.status || 502).json({ success: false, error: { type: 'GNANI_TTS', message: String(e.message).slice(0, 500) } }); }
  const base = `https://${req.get('host')}`;
  const audio_url = `${base}/gnani/audio?${new URLSearchParams({ text: b.text, language: b.language || 'hi-IN', voice: b.voice || 'Nalini' })}`;
  let telegram = null;
  if (b.telegram_chat_id) {
    if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ success: false, error: { type: 'CONFIG', message: 'TELEGRAM_BOT_TOKEN not set' } });
    const form = new FormData();
    form.append('chat_id', String(b.telegram_chat_id));
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'reply.wav');
    if (b.caption) form.append('caption', b.caption.slice(0, 1000));
    const t = await (await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAudio`, { method: 'POST', body: form })).json();
    telegram = { ok: t.ok, message_id: t.result && t.result.message_id, description: t.description };
  }
  res.json({ success: true, bytes: wav.length, audio_url, telegram });
});

// Replays a TTS clip (used by the dashboard's play button)
app.get('/gnani/audio', async (req, res) => {
  try { const wav = await gnaniTTS(req.query); res.type('audio/wav').send(wav); }
  catch (e) { res.status(502).send('TTS failed'); }
});

// =====================================================================
// LIVE DASHBOARD
// =====================================================================
app.get('/events', async (req, res) => res.json(await listEvents()));
app.post('/events/clear', async (req, res) => {
  if (REDIS_URL) await redis(['DEL', 'events']); else memEvents.length = 0;
  res.json({ cleared: true });
});
app.get('/dashboard', (req, res) => res.type('html').send(require('../lib/dashboard-html.js')));

require('../lib/extras.js')(app, { kv, redis, REDIS_URL, pushEvent });

app.use((req, res) => res.status(404).json({ detail: 'Not found.' }));

module.exports = app;
