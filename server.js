import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(process.cwd(), { index: 'index.html' }));

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_RAW = process.env.ADMIN_ID || process.env.TELEGRAM_ADMIN_IDS || '';
const ADMIN_IDS = new Set(ADMIN_RAW.split(',').map(x => x.trim()).filter(Boolean));
const DB = path.resolve(process.env.MONSTARX_DB || './licenses.json');

const INITIAL_XR = 300;
const RESET_MS = 6 * 60 * 60 * 1000;

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB, 'utf8'));
  } catch {
    return { users: {} };
  }
}

function saveDb(db) {
  fs.writeFileSync(DB, JSON.stringify(db, null, 2), 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function newProfileCode(db) {
  for (let i = 0; i < 5000; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));

    if (!Object.values(db.users).some(u => u.profileCode === code)) {
      return code;
    }
  }

  throw new Error('Could not create unique profile code');
}

function newAuthToken() {
  return crypto.randomBytes(32).toString('hex');
}

function nextResetIso(fromMs = Date.now()) {
  return new Date(fromMs + RESET_MS).toISOString();
}

function applyTokenReset(user) {
  if (user.unlimited) return false;

  const next = Date.parse(user.nextResetAt || '');

  if (!Number.isFinite(next)) {
    user.xrToken = INITIAL_XR;
    user.nextResetAt = nextResetIso();
    return true;
  }

  if (Date.now() >= next) {
    const periods =
      Math.floor((Date.now() - next) / RESET_MS) + 1;

    user.xrToken = INITIAL_XR;

    user.nextResetAt =
      new Date(next + periods * RESET_MS).toISOString();

    user.updatedAt = nowIso();

    return true;
  }

  return false;
}

function bearer(req) {
  const h = req.headers.authorization || '';

  return h.startsWith('Bearer ')
    ? h.slice(7).trim()
    : '';
}

function currentUser(req) {
  const token = bearer(req);

  if (!token) {
    throw new Error('Login required');
  }

  const db = loadDb();

  const user = Object.values(db.users)
    .find(u => u.authToken === token);

  if (!user) {
    throw new Error('Account not found');
  }

  const changed = applyTokenReset(user);

  if (changed) {
    saveDb(db);
  }

  return { db, user };
}

function publicUser(user, authToken = '') {
  return {
    profileCode: user.profileCode,
    name: user.name,
    xrToken: Number(user.xrToken || 0),
    unlimited: !!user.unlimited,
    createdAt: user.createdAt,
    nextResetAt: user.nextResetAt || null,
    authToken
  };
}

function findByCode(db, code) {
  return Object.values(db.users)
    .find(u => u.profileCode === String(code));
}

function isAdminTelegram(id) {
  return ADMIN_IDS.has(String(id));
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'MONSTARX XR TOKEN server'
  });
});

app.post('/api/profile/create', (req, res) => {
  try {
    const name =
      String(req.body?.name || '')
        .trim()
        .replace(/\s+/g, ' ');

    if (!name) {
      return res.status(400).json({
        error: 'Name is required'
      });
    }

    if (name.length > 40) {
      return res.status(400).json({
        error: 'Name must be 40 characters or less'
      });
    }

    const db = loadDb();

    const user = {
      name,
      profileCode: newProfileCode(db),
      xrToken: INITIAL_XR,
      unlimited: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      nextResetAt: nextResetIso(),
      authToken: newAuthToken()
    };

    db.users[user.authToken] = user;

    saveDb(db);

    res.json(
      publicUser(user, user.authToken)
    );

  } catch (e) {
    res.status(500).json({
      error: e.message || 'Account create failed'
    });
  }
});

app.get('/api/profile/me', (req, res) => {
  try {
    const { user } = currentUser(req);

    res.json(
      publicUser(user)
    );

  } catch (e) {
    res.status(401).json({
      error: e.message || 'Unauthorized'
    });
  }
});

app.post('/api/credit/use', (req, res) => {
  try {
    const cost = Number(req.body?.cost || 50);

    if (cost !== 50) {
      return res.status(400).json({
        error: 'Only 50 XR TOKEN per SCAN is allowed'
      });
    }

    const { db, user } = currentUser(req);

    if (user.unlimited) {
      return res.json({
        ok: true,
        unlimited: true,
        xrToken: Number(user.xrToken || 0)
      });
    }

    if (Number(user.xrToken || 0) < 50) {
      return res.status(402).json({
        error: 'Not enough XR TOKEN',
        xrToken: Number(user.xrToken || 0),
        unlimited: false
      });
    }

    user.xrToken =
      Number(user.xrToken) - 50;

    user.updatedAt = nowIso();

    saveDb(db);

    res.json({
      ok: true,
      unlimited: false,
      xrToken: user.xrToken,
      nextResetAt: user.nextResetAt
    });

  } catch (e) {
    res.status(401).json({
      error: e.message || 'Unauthorized'
    });
  }
});

const COMMANDS = [
  {
    command: 'start',
    description: 'Show XR TOKEN commands'
  },
  {
    command: 'addcredit',
    description: 'Add XR TOKEN: ID amount'
  },
  {
    command: 'setcredit',
    description: 'Set XR TOKEN: ID amount'
  },
  {
    command: 'unlimited',
    description: 'Make user UNLIMITED: ID'
  },
  {
    command: 'limited',
    description: 'Make limited: ID amount'
  },
  {
    command: 'check',
    description: 'Check user balance: ID'
  },
  {
    command: 'users',
    description: 'List all profiles'
  }
];

function helpText() {
  return [
    'MONSTARX XR TOKEN BOT',
    '',
    '/addcredit ID 500',
    '/setcredit ID 1000',
    '/unlimited ID',
    '/limited ID 500',
    '/check ID',
    '/users',
    '',
    'ID = 6-digit Profile ID Number',
    'New account = 300 XR TOKEN',
    'XR TOKEN resets to 300 every 6 hours',
    'SCAN cost = 50 XR TOKEN',
    '/setcredit on an unlimited user makes the user LIMITED with that balance.'
  ].join('\n');
}

async function telegram(method, body) {
  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN is not configured');
  }

  const r = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  const data = await r.json();

  if (!data.ok) {
    throw new Error(
      data.description ||
      `Telegram ${method} failed`
    );
  }

  return data;
}

async function configureTelegram() {
  if (!BOT_TOKEN) return;

  try {
    await telegram(
      'setMyCommands',
      { commands: COMMANDS }
    );

    const me =
      await telegram('getMe', {});

    console.log(
      `Telegram bot connected: @${me.result?.username || me.result?.first_name || 'unknown'}`
    );

  } catch (e) {
    console.error(
      'Telegram setup error:',
      e.message
    );
  }
}

async function handleUpdate(update) {
  const msg = update.message;

  if (!msg?.text) return;

  const fromId =
    String(msg.from?.id || '');

  if (!isAdminTelegram(fromId)) return;

  const parts =
    msg.text.trim().split(/\s+/);

  const command =
    parts[0]
      .split('@')[0]
      .toLowerCase();

  const db = loadDb();

  if (command === '/start' ||
      command === '/help') {

    await telegram(
      'sendMessage',
      {
        chat_id: msg.chat.id,
        text: helpText()
      }
    );

    return;
  }

  if (
    command === '/addcredit' ||
    command === '/setcredit'
  ) {

    if (parts.length !== 3) {
      await telegram(
        'sendMessage',
        {
          chat_id: msg.chat.id,
          text:
            `Usage: ${command} 123456 500`
        }
      );

      return;
    }

    const user =
      findByCode(db, parts[1]);

    const amount =
      Number(parts[2]);

    if (
      !user ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      !Number.isInteger(amount)
    ) {

      await telegram(
        'sendMessage',
        {
          chat_id: msg.chat.id,
          text:
            'Invalid ID or credit amount.'
        }
      );

      return;
    }

    applyTokenReset(user);

    if (command === '/addcredit') {

      if (!user.unlimited) {
        user.xrToken =
          Number(user.xrToken || 0)
          + amount;
      }

    } else {

      user.xrToken = amount;
      user.unlimited = false;
      user.nextResetAt =
        nextResetIso();
    }

    user.updatedAt = nowIso();

    saveDb(db);

    await telegram(
      'sendMessage',
      {
        chat_id: msg.chat.id,
        text:
          `XR TOKEN updated.\n` +
          `ID: ${user.profileCode}\n` +
          `Name: ${user.name}\n` +
          `Balance: ${user.unlimited ? 'UNLIMITED' : user.xrToken}`
      }
    );

    return;
  }

  if (command === '/unlimited') {

    if (parts.length !== 2) {

      await telegram(
        'sendMessage',
        {
          chat_id: msg.chat.id,
          text:
            'Usage: /unlimited 123456'
        }
      );

      return;
    }

    const user =
      findByCode(db, parts[1]);

    if (!user) {

      await telegram(
        'sendMessage',
        {
          chat_id: msg.chat
