// Telegram bridge (real Telegram Bot API), family profile, agent memory, setup helpers and the MCP server
// that AgenticOrg connects to. Every MCP tool call goes through this server's own HTTP endpoints,
// so it also shows up on /dashboard.

const crypto = require('crypto');

module.exports = function extras(app, { kv }) {
  const BOT = () => process.env.TELEGRAM_BOT_TOKEN;
  const tg = async (method, body) => {
    const r = await fetch(`https://api.telegram.org/bot${BOT()}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return r.json();
  };
  const webhookSecret = () => crypto.createHash('sha256').update(String(BOT())).digest('hex').slice(0, 32);
  const baseUrl = (req) => `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;

  // ---------------- Telegram ----------------
  // Telegram pushes every message here (set up from /setup). We keep it in an inbox the agent reads.
  app.post('/telegram/webhook', async (req, res) => {
    if (req.get('X-Telegram-Bot-Api-Secret-Token') !== webhookSecret()) return res.status(401).json({ ok: false });
    const m = req.body.message || req.body.edited_message;
    if (!m) return res.json({ ok: true, ignored: true });
    const msg = {
      message_id: m.message_id,
      chat_id: m.chat.id,
      from_name: [m.from && m.from.first_name, m.from && m.from.last_name].filter(Boolean).join(' '),
      received_at_ist: new Date(m.date * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      received_at_unix: m.date,
      type: m.voice ? 'voice' : m.audio ? 'audio' : m.text ? 'text' : 'other',
      text: m.text || m.caption || null,
      voice_file_id: (m.voice && m.voice.file_id) || (m.audio && m.audio.file_id) || null,
      voice_seconds: (m.voice && m.voice.duration) || null,
    };
    await kv.push('inbox', msg);
    const contacts = (await kv.get('contacts')) || {};
    contacts[msg.chat_id] = { chat_id: msg.chat_id, name: msg.from_name, last_seen: msg.received_at_ist };
    await kv.set('contacts', contacts);
    res.json({ ok: true, queued: msg });
  });

  app.post('/telegram/inbox/read', async (req, res) => {
    const messages = await kv.drain('inbox');
    res.json({ count: messages.length, now_ist: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), now_unix: Math.floor(Date.now() / 1000), messages });
  });

  app.post('/telegram/send', async (req, res) => {
    const { chat_id, text } = req.body || {};
    if (!BOT()) return res.status(500).json({ ok: false, description: 'TELEGRAM_BOT_TOKEN not set' });
    if (!chat_id || !text) return res.status(400).json({ ok: false, description: 'chat_id and text are required' });
    const r = await tg('sendMessage', { chat_id, text });
    res.status(r.ok ? 200 : 400).json(r);
  });

  // ---------------- Day-one knowledge: family profile (filled on /setup) ----------------
  const DEFAULT_PROFILE = {
    settings: { per_order_cap_inr: 500, monthly_cap_inr: 5000, approval_reminder_minutes: 3, approval_expiry_minutes: 6, check_in_time_ist: '20:00' },
    members: [{
      member_id: 'parvatidevi', name: 'Parvatidevi', age: 72, relation: 'grandmother', language_code: 'hi-IN', voice: 'Nalini',
      telegram_chat_id: 'PASTE_CHAT_ID', daily_protein_target_g: 60, diet: 'veg',
      risk_markers: ['early fatty liver (wellness screening, July 2026)'],
      address: 'B-12, Shanti Kunj, Bopal, Ahmedabad', pincode: '380015', phone: '9000000000',
      caregiver: { name: 'Bhavya', telegram_chat_id: 'PASTE_CHAT_ID' }, envelope_id: 'ENV-OK',
    }],
  };
  app.get('/family/profile', async (req, res) => res.json((await kv.get('family_profile')) || DEFAULT_PROFILE));
  app.post('/family/profile', async (req, res) => {
    if (!req.body || !Array.isArray(req.body.members)) return res.status(400).json({ error: 'Profile must have a members array' });
    await kv.set('family_profile', req.body); res.json({ saved: true });
  });

  // ---------------- Agent notebook (state between runs) ----------------
  app.post('/memory/get', async (req, res) => {
    const id = (req.body || {}).member_id;
    if (!id) return res.status(400).json({ error: 'member_id required' });
    res.json({ member_id: id, notebook: (await kv.get(`mem:${id}`)) || { state: 'WAITING' } });
  });
  app.post('/memory/save', async (req, res) => {
    const body = req.body || {};
    const member_id = body.member_id;
    let notebook = body.notebook;
    if (typeof notebook === 'string') { try { notebook = JSON.parse(notebook); } catch (e) { notebook = { note: notebook }; } }
    if (!notebook || typeof notebook !== 'object') { const { member_id: _m, ...rest } = body; notebook = rest; }
    if (!member_id) return res.status(400).json({ error: 'member_id required' });
    notebook.updated_at_ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    await kv.set(`mem:${member_id}`, notebook); res.json({ saved: true, notebook });
  });

  // ---------------- Setup page helpers ----------------
  app.get('/setup', (req, res) => res.type('html').send(require('./setup-html.js')));
  app.get('/setup/status', async (req, res) => {
    const out = { gnani_key: !!process.env.GNANI_API_KEY, telegram_token: !!BOT(), redis: !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL), mcp_url: `${baseUrl(req)}/mcp`, dashboard_url: `${baseUrl(req)}/dashboard` };
    if (BOT()) {
      try { const me = await tg('getMe'); out.bot = me.ok ? `@${me.result.username}` : me.description; const wh = await tg('getWebhookInfo'); out.webhook = wh.result && wh.result.url; out.webhook_error = wh.result && wh.result.last_error_message; } catch (e) { out.bot = 'error: ' + e.message; }
    }
    out.contacts = Object.values((await kv.get('contacts')) || {});
    res.json(out);
  });
  app.post('/setup/reset', async (req, res) => {
    const prof = (await kv.get('family_profile')) || DEFAULT_PROFILE;
    for (const m of prof.members) await kv.set(`mem:${m.member_id}`, { state: 'WAITING' });
    await kv.drain('inbox');
    res.json({ reset: prof.members.map((m) => m.member_id) });
  });
  app.post('/setup/webhook', async (req, res) => {
    if (!BOT()) return res.status(400).json({ ok: false, description: 'Set TELEGRAM_BOT_TOKEN in Vercel first' });
    res.json(await tg('setWebhook', { url: `${baseUrl(req)}/telegram/webhook`, secret_token: webhookSecret(), allowed_updates: ['message'], drop_pending_updates: true }));
  });

  // =====================================================================
  // MCP server (Streamable HTTP, stateless JSON responses)
  // =====================================================================
  const S = (props, required = []) => ({ type: 'object', properties: props, required });
  const str = (d) => ({ type: 'string', description: d });
  const int = (d) => ({ type: 'integer', description: d });

  const TOOLS = [
    // Telegram (real)
    { name: 'telegram_read_new_messages', description: 'Telegram (real): returns every message that arrived since the last read, oldest first, then empties the inbox. Each has chat_id, from_name, type (text/voice), text, voice_file_id and received_at. Also returns the current time.', inputSchema: S({}), call: () => ['POST', '/telegram/inbox/read', {}] },
    { name: 'telegram_send_text', description: 'Telegram (real): send a text message to a chat.', inputSchema: S({ chat_id: str('Telegram chat id'), text: str('Message text') }, ['chat_id', 'text']), call: (a) => ['POST', '/telegram/send', a] },
    // Gnani (real)
    { name: 'gnani_transcribe_voice', description: 'Gnani speech-to-text (real, Prisma v2.5, POST https://api.vachana.ai/stt/v3). Pass the voice_file_id from a Telegram message. Returns Gnani\'s reply unchanged: {success, transcript}.', inputSchema: S({ telegram_file_id: str('voice_file_id from the Telegram message'), language_code: str('e.g. hi-IN, en-IN, te-IN, gu-IN') }, ['telegram_file_id', 'language_code']), call: (a) => ['POST', '/gnani/stt', { telegram_file_id: a.telegram_file_id, language_code: a.language_code, format: 'transcribe' }] },
    { name: 'gnani_speak_to_member', description: 'Gnani text-to-speech (real, POST https://api.vachana.ai/api/v1/tts/inference), delivered to Telegram as a voice message with the same text as caption.', inputSchema: S({ text: str('What to say'), language: str('e.g. hi-IN'), voice: str('Gnani voice, default Nalini'), telegram_chat_id: str('Member chat id') }, ['text', 'language', 'telegram_chat_id']), call: (a) => ['POST', '/gnani/tts', { text: a.text, language: a.language, voice: a.voice || 'Nalini', telegram_chat_id: a.telegram_chat_id, caption: a.text }] },
    // Day-one knowledge + notebook
    { name: 'family_get_profile', description: 'Day-one knowledge entered by the family on the setup form: members, targets, diet, risk markers, address, pincode, caregiver, envelope id, limits and timings.', inputSchema: S({}), call: () => ['GET', '/family/profile'] },
    { name: 'notebook_get', description: 'Read this member\'s case notebook (current state, today\'s log, pending quote/approval, order ids, counters). Read it before acting on any member.', inputSchema: S({ member_id: str('member_id from the profile') }, ['member_id']), call: (a) => ['POST', '/memory/get', a] },
    { name: 'notebook_save', description: 'Overwrite this member\'s case notebook with the full updated object. Save after every state change.', inputSchema: S({ member_id: str('member_id'), notebook: { type: 'object', description: 'Full notebook object' } }, ['member_id', 'notebook']), call: (a) => ['POST', '/memory/save', a] },
    // Delhivery (mock)
    { name: 'delhivery_check_pincode', description: 'Delhivery (mock) GET /c/api/pin-codes/json/ — is this pincode serviceable? Empty delivery_codes means not serviceable.', inputSchema: S({ pincode: str('6-digit pincode') }, ['pincode']), call: (a) => ['GET', `/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(a.pincode)}`, null, 'delhivery'] },
    { name: 'delhivery_basket_quote', description: 'IMAGINED Delhivery capability POST /api/hyperlocal/v1/basket-quote — priced basket from the nearest partner store that closes a protein gap. Use these prices only.', inputSchema: S({ pincode: str('member pincode'), protein_gap_g: int('daily gap in grams'), days: int('days to cover, default 3'), diet: str('veg or egg'), max_inr: int('budget cap in rupees') }, ['pincode', 'protein_gap_g', 'diet', 'max_inr']), call: (a) => ['POST', '/api/hyperlocal/v1/basket-quote', { days: 3, ...a }, 'delhivery'] },
    { name: 'delhivery_create_shipment', description: 'Delhivery (mock) POST /api/cmu/create.json — create the shipment from the partner store to the member. Returns waybill on success, or success:false with remarks (e.g. no rider).', inputSchema: S({ consignee_name: str('member name'), address: str('member address'), pincode: str('member pincode'), phone: str('member phone'), order_ref: str('your order reference'), pickup_location: str('store pickup_location from the quote'), total_inr: int('order value in rupees') }, ['consignee_name', 'address', 'pincode', 'order_ref', 'pickup_location']), call: (a) => ['POST', '/api/cmu/create.json', { shipments: [{ name: a.consignee_name, add: a.address, pin: a.pincode, phone: a.phone || '', order: a.order_ref, payment_mode: 'Pre-paid', total_amount: a.total_inr || 0, products_desc: 'Protein basket' }], pickup_location: { name: a.pickup_location } }, 'delhivery'] },
    { name: 'delhivery_track_shipment', description: 'Delhivery (mock) GET /api/v1/packages/json/ — current status of a waybill (Manifested, In Transit, Dispatched, Delivered, Pending, RTO).', inputSchema: S({ waybill: str('waybill') }, ['waybill']), call: (a) => ['GET', `/api/v1/packages/json/?waybill=${encodeURIComponent(a.waybill)}`, null, 'delhivery'] },
    { name: 'delhivery_cancel_shipment', description: 'Delhivery (mock) POST /api/p/edit with cancellation=true.', inputSchema: S({ waybill: str('waybill') }, ['waybill']), call: (a) => ['POST', '/api/p/edit', { waybill: a.waybill, cancellation: 'true' }, 'delhivery'] },
    // Pine Labs (mock) + imagined envelope
    { name: 'pinelabs_create_order', description: 'Pine Labs (mock) POST /api/pay/v1/orders with pre_auth true. Amount in paise.', inputSchema: S({ merchant_order_reference: str('your order reference'), amount_paise: int('amount in paise'), note: str('what it is for') }, ['merchant_order_reference', 'amount_paise']), call: (a) => ['POST', '/api/pay/v1/orders', { merchant_order_reference: a.merchant_order_reference, order_amount: { value: a.amount_paise, currency: 'INR' }, pre_auth: true, notes: a.note || '' }, 'pine'] },
    { name: 'pinelabs_envelope_balance', description: 'IMAGINED Pine Labs capability GET /api/pay/v1/envelopes/{id} — the caregiver-funded health-spend envelope: monthly limit, spent, available, per-transaction cap, allowed categories.', inputSchema: S({ envelope_id: str('from profile') }, ['envelope_id']), call: (a) => ['GET', `/api/pay/v1/envelopes/${encodeURIComponent(a.envelope_id)}`, null, 'pine'] },
    { name: 'pinelabs_envelope_authorize', description: 'IMAGINED Pine Labs capability POST /api/pay/v1/envelopes/{id}/authorize — hold the order amount against the envelope. Needs the caregiver approval message id as approver_ref.', inputSchema: S({ envelope_id: str('from profile'), order_id: str('Pine Labs order_id'), amount_paise: int('amount in paise'), category: str('grocery_protein'), approver_ref: str('caregiver YES message id') }, ['envelope_id', 'order_id', 'amount_paise', 'category', 'approver_ref']), call: (a) => ['POST', `/api/pay/v1/envelopes/${encodeURIComponent(a.envelope_id)}/authorize`, { order_id: a.order_id, amount: { value: a.amount_paise, currency: 'INR' }, category: a.category, approver_ref: a.approver_ref }, 'pine'] },
    { name: 'pinelabs_capture_order', description: 'Pine Labs (mock) PUT /api/pay/v1/orders/{order_id}/capture — take the held money after delivery.', inputSchema: S({ order_id: str('order_id'), amount_paise: int('amount in paise'), capture_reference: str('your reference') }, ['order_id', 'amount_paise']), call: (a) => ['PUT', `/api/pay/v1/orders/${encodeURIComponent(a.order_id)}/capture`, { merchant_capture_reference: a.capture_reference || `CAP-${Date.now()}`, capture_amount: { value: a.amount_paise, currency: 'INR' } }, 'pine'] },
    { name: 'pinelabs_cancel_order', description: 'Pine Labs (mock) PUT /api/pay/v1/orders/{order_id}/cancel — release the hold; the family is not charged.', inputSchema: S({ order_id: str('order_id') }, ['order_id']), call: (a) => ['PUT', `/api/pay/v1/orders/${encodeURIComponent(a.order_id)}/cancel`, {}, 'pine'] },
  ];

  async function pineToken(base) {
    const r = await fetch(`${base}/api/auth/v1/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: process.env.PINE_CLIENT_ID || 'proto-client', client_secret: process.env.PINE_CLIENT_SECRET || 'proto-secret', grant_type: 'client_credentials' }) });
    return (await r.json()).access_token;
  }

  async function runTool(base, tool, args) {
    const [method, path, body, auth] = tool.call(args || {});
    const headers = { 'Content-Type': 'application/json' };
    if (auth === 'delhivery') headers.Authorization = `Token ${process.env.DELHIVERY_TOKEN || 'proto-delhivery-token'}`;
    if (auth === 'pine') headers.Authorization = `Bearer ${await pineToken(base)}`;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(base + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}), signal: ctl.signal });
      const text = await r.text();
      return { status: r.status, text };
    } catch (e) { return { status: 599, text: `Request failed: ${e.name === 'AbortError' ? 'timed out after 20s' : e.message}` }; }
    finally { clearTimeout(t); }
  }

  async function handleRpc(msg, base, tools = TOOLS, label = 'all') {
    const { id, method, params } = msg;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return ok({ protocolVersion: (params && params.protocolVersion) || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: `proto-${label}`, version: '1.0.0' } });
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === (params && params.name));
      if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params && params.name}` } };
      const { status, text } = await runTool(base, tool, params.arguments);
      return ok({ content: [{ type: 'text', text: `HTTP ${status}\n${text}` }], isError: status >= 400 });
    }
    if (method && method.startsWith('notifications/')) return null;
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  const GROUPS = {
    gnani: (n) => n.startsWith('gnani_'),
    delhivery: (n) => n.startsWith('delhivery_'),
    pinelabs: (n) => n.startsWith('pinelabs_'),
    telegram: (n) => n.startsWith('telegram_'),
    family: (n) => n.startsWith('family_') || n.startsWith('notebook_'),
  };
  async function mcpHandler(req, res) {
    if (process.env.MCP_KEY && req.get('Authorization') !== `Bearer ${process.env.MCP_KEY}`) return res.status(401).json({ error: 'unauthorized' });
    const group = req.params.group;
    if (group && !GROUPS[group]) return res.status(404).json({ error: `Unknown MCP group ${group}` });
    const tools = group ? TOOLS.filter((t) => GROUPS[group](t.name)) : TOOLS;
    const base = baseUrl(req);
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleRpc(m, base, tools, group || 'all')))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const out = await handleRpc(body || {}, base, tools, group || 'all');
    if (!out) return res.status(202).end();
    res.json(out);
  }
  app.post('/mcp', mcpHandler);
  app.post('/mcp/:group', mcpHandler);
  app.get('/mcp/:group', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST (MCP Streamable HTTP)' }));
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST (MCP Streamable HTTP)' }));
  app.delete('/mcp', (req, res) => res.status(200).end());
};
