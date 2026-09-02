import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

const BOT_TOKEN =
  process.env.BOT_TOKEN ||
  process.env.TELEGRAM_BOT_TOKEN ||
  '';

const ADMIN_RAW =
  process.env.ADMIN_ID ||
  process.env.TELEGRAM_ADMIN_IDS ||
  '';

const ADMIN_IDS = new Set(
  ADMIN_RAW.split(',').map(x => x.trim()).filter(Boolean)
);

const DB = path.resolve(
  process.env.MONSTARX_DB || './licenses.json'
);

function loadDb() {
  try {
    return JSON.parse(
      fs.readFileSync(DB, 'utf8')
    );
  } catch {
    return { users: {} };
  }
}

function saveDb(db) {
  fs.writeFileSync(
    DB,
    JSON.stringify(db, null, 2),
    'utf8'
  );
}

function durationMs(value) {
  const x = String(value).toLowerCase().trim();

  if (x === 'lifetime' || x === 'life') {
    return null;
  }

  const match = x.match(/^(\d+)(m|h|d|mo|y)$/);

  if (!match) {
    return undefined;
  }

  const n = Number(match[1]);

  const units = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    mo: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000
  };

  return n * units[match[2]];
}

function grant(userId, duration) {
  const ms = durationMs(duration);

  if (ms === undefined) {
    return null;
  }

  const db = loadDb();
  const id = String(userId);
  const now = Date.now();

  db.users[id] = {
    userId: id,
    active: true,
    owner: false,
    duration: String(duration).toLowerCase(),
    grantedAt: new Date(now).toISOString(),
    expiresAt:
      ms === null
        ? null
        : new Date(now + ms).toISOString()
  };

  saveDb(db);

  return db.users[id];
}

function revoke(userId) {
  const db = loadDb();
  const id = String(userId);

  if (db.users[id]) {
    db.users[id].active = false;
    saveDb(db);
    return db.users[id];
  }

  return null;
}

function getAccess(userId) {
  const db = loadDb();
  const id = String(userId);
  const item = db.users[id];

  if (!item) {
    return {
      userId: id,
      active: false,
      owner: false,
      expiresAt: null
    };
  }

  if (
    !item.owner &&
    item.active &&
    item.expiresAt &&
    Date.now() >= Date.parse(item.expiresAt)
  ) {
    item.active = false;
    saveDb(db);
  }

  return item;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'MONSTARX access server'
  });
});

app.get('/api/access/:userId', (req, res) => {
  res.json(
    getAccess(req.params.userId)
  );
});

async function telegram(method, body) {
  if (!BOT_TOKEN) {
    throw new Error(
      'BOT_TOKEN is not configured'
    );
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  return response.json();
}

function isAdmin(userId) {
  return (
    ADMIN_IDS.size > 0 &&
    ADMIN_IDS.has(String(userId))
  );
}

function helpText() {
  return [
    'MONSTARX Access Bot',
    '',
    '/grant USER_ID DURATION',
    '/revoke USER_ID',
    '/check USER_ID',
    '',
    'Duration:',
    '15m = 15 minutes',
    '1h = 1 hour',
    '1d = 1 day',
    '7d = 7 days',
    '1mo = 1 month',
    '6mo = 6 months',
    '1y = 1 year',
    'lifetime = lifetime access'
  ].join('\n');
}

async function handleUpdate(update) {
  const msg = update.message;

  if (!msg?.text) {
    return;
  }

  const fromId = String(
    msg.from?.id || ''
  );

  if (!isAdmin(fromId)) {
    return;
  }

  const parts = msg.text
    .trim()
    .split(/\s+/);

  const command = parts[0]
    .split('@')[0]
    .toLowerCase();

  if (
    command === '/start' ||
    command === '/help'
  ) {
    await telegram('sendMessage', {
      chat_id: msg.chat.id,
      text: helpText()
    });

    return;
  }

  if (
    command === '/grant' &&
    parts.length === 3
  ) {
    const record = grant(
      parts[1],
      parts[2]
    );

    await telegram('sendMessage', {
      chat_id: msg.chat.id,
      text: record
        ? [
            'Access granted.',
            `User: ${record.userId}`,
            `Duration: ${record.duration}`,
            `Expires: ${
              record.expiresAt || 'LIFETIME'
            }`
          ].join('\n')
        : [
            'Invalid duration.',
            'Use: 15m, 1h, 1d, 7d, 1mo, 6mo, 1y, lifetime'
          ].join('\n')
    });

    return;
  }

  if (
    command === '/revoke' &&
    parts.length === 2
  ) {
    const record = revoke(parts[1]);

    await telegram('sendMessage', {
      chat_id: msg.chat.id,
      text: record
        ? `Access revoked for ${parts[1]}.`
        : `No record found for ${parts[1]}.`
    });

    return;
  }

  if (
    command === '/check' &&
    parts.length === 2
  ) {
    await telegram('sendMessage', {
      chat_id: msg.chat.id,
      text: JSON.stringify(
        getAccess(parts[1]),
        null,
        2
      )
    });

    return;
  }

  await telegram('sendMessage', {
    chat_id: msg.chat.id,
    text: helpText()
  });
}

let offset = 0;

async function poll() {
  if (!BOT_TOKEN) {
    console.error(
      'BOT_TOKEN is not configured.'
    );

    setTimeout(poll, 5000);
    return;
  }

  try {
    const result = await telegram(
      'getUpdates',
      {
        offset,
        timeout: 25,
        allowed_updates: ['message']
      }
    );

    if (result.ok) {
      for (const update of result.result) {
        offset = update.update_id + 1;

        try {
          await handleUpdate(update);
        } catch (error) {
          console.error(
            'Update error:',
            error.message
          );
        }
      }
    } else {
      console.error(
        'Telegram API error:',
        result.description || 'Unknown error'
      );
    }
  } catch (error) {
    console.error(
      'Polling error:',
      error.message
    );
  }

  setImmediate(poll);
}

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `MONSTARX access server listening on port ${PORT}`
    );
  }
);

poll();
