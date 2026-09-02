import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_RAW = process.env.ADMIN_ID || process.env.TELEGRAM_ADMIN_IDS || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ADMIN_IDS = new Set(ADMIN_RAW.split(',').map(x => x.trim()).filter(Boolean));
const DB = path.resolve(process.env.MONSTARX_DB || './licenses.json');

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); }
  catch { return { users: {} }; }
}
function saveDb(db) { fs.writeFileSync(DB, JSON.stringify(db, null, 2), 'utf8'); }
function nowIso() { return new Date().toISOString(); }
function newProfileCode(db) {
  for (let i = 0; i < 500; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!Object.values(db.users).some(u => u.profileCode === code)) return code;
  }
  throw new Error('Could not create unique profile code');
}

async function verifyGoogleToken(idToken) {
  if (!GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is not configured');
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  const data = await r.json();
  if (!r.ok || data.error_description || data.error) throw new Error('Invalid Google login');
  if (data.aud !== GOOGLE_CLIENT_ID) throw new Error('Google client mismatch');
  if (data.email_verified !== 'true' && data.email_verified !== true) throw new Error('Google email is not verified');
  if (!data.sub || !data.email) throw new Error('Google account data missing');
  return { sub: String(data.sub), email: String(data.email), name: String(data.name || data.email.split('@')[0]), picture: String(data.picture || '') };
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
async function currentUser(req) {
  const token = bearer(req);
  if (!token) throw new Error('Login required');
  const google = await verifyGoogleToken(token);
  const db = loadDb();
  const user = db.users[google.sub];
  if (!user) throw new Error('Profile not found');
  return { db, user, google };
}
function publicUser(user, idToken = '') {
  return { profileCode: user.profileCode, email: user.email, name: user.name, picture: user.picture, xrToken: Number(user.xrToken || 0), unlimited: !!user.unlimited, createdAt: user.createdAt, idToken };
}
function findByCode(db, code) { return Object.values(db.users).find(u => u.profileCode === String(code)); }
function isAdminTelegram(id) { return ADMIN_IDS.has(String(id)); }

app.get('/health', (_req, res) => res.json({ ok: true, service: 'MONSTARX XR TOKEN server' }));

app.post('/api/profile/google', async (req, res) => {
  try {
    const idToken = String(req.body?.credential || '');
    if (!idToken) return res.status(400).json({ error: 'Google credential missing' });
    const google = await verifyGoogleToken(idToken);
    const db = loadDb();
    let user = db.users[google.sub];
    if (!user) {
      user = { googleSub: google.sub, email: google.email, name: google.name, picture: google.picture, profileCode: newProfileCode(db), xrToken: 0, unlimited: false, createdAt: nowIso(), updatedAt: nowIso() };
      db.users[google.sub] = user;
    } else {
      user.email = google.email; user.name = google.name; user.picture = google.picture; user.updatedAt = nowIso();
    }
    saveDb(db);
    res.json(publicUser(user, idToken));
  } catch (e) { res.status(401).json({ error: e.message || 'Google login failed' }); }
});

app.get('/api/profile/me', async (req, res) => {
  try { const { user } = await currentUser(req); res.json(publicUser(user)); }
  catch (e) { res.status(401).json({ error: e.message || 'Unauthorized' }); }
});

app.post('/api/credit/use', async (req, res) => {
  try {
    const cost = Number(req.body?.cost || 50);
    if (cost !== 50) return res.status(400).json({ error: 'Only 50 XR TOKEN per SCAN is allowed' });
    const { db, user } = await currentUser(req);
    if (user.unlimited) return res.json({ ok: true, unlimited: true, xrToken: Number(user.xrToken || 0) });
    if (Number(user.xrToken || 0) < 50) return res.status(402).json({ error: 'Not enough XR TOKEN', xrToken: Number(user.xrToken || 0), unlimited: false });
    user.xrToken = Number(user.xrToken) - 50; user.updatedAt = nowIso(); saveDb(db);
    res.json({ ok: true, unlimited: false, xrToken: user.xrToken });
  } catch (e) { res.status(401).json({ error: e.message || 'Unauthorized' }); }
});

const COMMANDS = [
  { command: 'start', description: 'Show XR TOKEN commands' },
  { command: 'addcredit', description: 'Add XR TOKEN: ID amount' },
  { command: 'setcredit', description: 'Set XR TOKEN: ID amount' },
  { command: 'unlimited', description: 'Make user UNLIMITED: ID' },
  { command: 'limited', description: 'Make limited: ID amount' },
  { command: 'check', description: 'Check user balance: ID' },
  { command: 'users', description: 'List all profiles' }
];
function helpText() {
  return [
    'MONSTARX XR TOKEN BOT', '',
    '/addcredit ID 500',
    '/setcredit ID 1000',
    '/unlimited ID',
    '/limited ID 500',
    '/check ID',
    '/users', '',
    'ID = 6-digit Profile ID Number',
    'SCAN cost = 50 XR TOKEN',
    '/setcredit on an unlimited user makes the user LIMITED with that balance.'
  ].join('\n');
}
async function telegram(method, body) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is not configured');
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data;
}
async function configureTelegram() {
  if (!BOT_TOKEN) return;
  try {
    await telegram('setMyCommands', { commands: COMMANDS });
    const me = await telegram('getMe', {});
    console.log(`Telegram bot connected: @${me.result?.username || me.result?.first_name || 'unknown'}`);
  } catch (e) { console.error('Telegram setup error:', e.message); }
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text) return;
  const fromId = String(msg.from?.id || '');
  if (!isAdminTelegram(fromId)) return;
  const parts = msg.text.trim().split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const db = loadDb();

  if (command === '/start' || command === '/help') {
    await telegram('sendMessage', { chat_id: msg.chat.id, text: helpText() }); return;
  }
  if (command === '/addcredit' || command === '/setcredit') {
    if (parts.length !== 3) { await telegram('sendMessage', { chat_id: msg.chat.id, text: `Usage: ${command} 123456 500` }); return; }
    const user = findByCode(db, parts[1]); const amount = Number(parts[2]);
    if (!user || !Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount)) { await telegram('sendMessage', { chat_id: msg.chat.id, text: 'Invalid ID or credit amount.' }); return; }
    if (command === '/addcredit') {
      if (!user.unlimited) user.xrToken = Number(user.xrToken || 0) + amount;
    } else { user.xrToken = amount; user.unlimited = false; }
    user.updatedAt = nowIso(); saveDb(db);
    await telegram('sendMessage', { chat_id: msg.chat.id, text: `XR TOKEN updated.\nID: ${user.profileCode}\nBalance: ${user.unlimited ? 'UNLIMITED' : user.xrToken}` }); return;
  }
  if (command === '/unlimited') {
    if (parts.length !== 2) { await telegram('sendMessage', { chat_id: msg.chat.id, text: 'Usage: /unlimited 123456' }); return; }
    const user = findByCode(db, parts[1]);
    if (!user) { await telegram('sendMessage', { chat_id: msg.chat.id, text: 'Profile ID not found.' }); return; }
    user.unlimited = true; user.updatedAt = nowIso(); saveDb(db);
    await telegram('sendMessage', { chat_id: msg.chat.id, text: `ID ${user.profileCode} is now UNLIMITED.` }); return;
  }
  if (command === '/limited') {
    if (parts.length !== 3) { await telegram('sendMessage', { chat_id: msg.chat.id, text: 'Usage: /limited 123456 500' }); return; }
    const user = findByCode(db, parts[1]); const amount = Number(parts[2]);
    if (!user || !Number.isInteger(amount) || amount < 0) { await telegram('sendMessage', { chat_id: msg.chat.id, text: 'Invalid ID or credit amount.' }); return; }
    user.unlimited = false; user.xrToken = amount; user.updatedAt = nowIso(); saveDb(db);
    await telegram('sendMessage', { chat_id: msg.chat.id, text: `ID ${user.profileCode} is LIMITED to ${user.xrToken} XR TOKEN.` }); return;
  }
  if (command === '/check') {
    if (parts.length !== 2) { await telegram('sendMessage', { chat_id: msg.chat.id, text: 'Usage: /check 123456' }); return; }
    const user = findByCode(db, parts[1]);
    await telegram('sendMessage', { chat_id: msg.chat.id, text: user ? [`ID: ${user.profileCode}`, `Email: ${user.email}`, `XR TOKEN: ${user.unlimited ? 'UNLIMITED' : user.xrToken}`].join('\n') : 'Profile ID not found.' }); return;
  }
  if (command === '/users') {
    const users = Object.values(db.users);
    const text = users.length ? users.map(u => `${u.profileCode} • ${u.unlimited ? 'UNLIMITED' : `${u.xrToken} XR TOKEN`} • ${u.email}`).join('\n') : 'No profiles yet.';
    await telegram('sendMessage', { chat_id: msg.chat.id, text: text.slice(0, 4000) }); return;
  }
  await telegram('sendMessage', { chat_id: msg.chat.id, text: helpText() });
}

let offset = 0;
let polling = false;
async function poll() {
  if (!BOT_TOKEN) { console.error('BOT_TOKEN is not configured.'); setTimeout(poll, 5000); return; }
  if (polling) return;
  polling = true;
  try {
    const result = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
    for (const update of (result.result || [])) {
      offset = update.update_id + 1;
      try { await handleUpdate(update); } catch (e) { console.error('Update error:', e.message); }
    }
  } catch (e) { console.error('Polling error:', e.message); }
  polling = false;
  setImmediate(poll);
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`MONSTARX XR TOKEN server listening on port ${PORT}`);
  console.log(`Admin IDs configured: ${ADMIN_IDS.size}`);
  await configureTelegram();
  poll();
});
