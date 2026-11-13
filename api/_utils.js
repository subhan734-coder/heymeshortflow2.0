'use strict';

const crypto = require('crypto');

const SENSITIVE_KEYS = new Set([
  'SUPABASE_SERVICE_ROLE_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'GROQ_API_KEY',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'YOUTUBE_REFRESH_TOKEN',
  'OWNER_ACCESS_KEY'
]);

function encryptionKey() {
  const raw = process.env.ENCRYPTION_KEY || process.env.OWNER_ACCESS_KEY || 'default-dev-key-change-me';
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = encryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64');
}

function decrypt(cipherText) {
  if (!cipherText) return cipherText;
  if (!cipherText.includes(':')) return cipherText; // plaintext fallback
  const parts = cipherText.split(':');
  if (parts.length !== 3) return cipherText;
  const key = encryptionKey();
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const enc = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function mask(v) {
  if (!v) return '';
  return '\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf';
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function cors(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400'
  });
  res.end();
}

async function supaRequest(method, path, body, serviceRoleKey, anonKey) {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('SUPABASE_URL not configured');
  const url = base.endsWith('/') ? base + 'rest/v1/' + path : base + '/rest/v1/' + path;
  const headers = {
    'apikey': serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || anonKey || process.env.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + (serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || anonKey || process.env.SUPABASE_ANON_KEY),
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (method === 'GET') headers['Prefer'] = 'return=representation';
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let data;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  if (!res.ok) {
    const err = new Error('Supabase error ' + res.status + ': ' + (data && data.message ? data.message : text));
    err.status = res.status; err.data = data; throw err;
  }
  return data;
}

async function readSettings() {
  const rows = await supaRequest('GET', 'settings?select=*', null, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const map = {};
  for (const r of rows || []) {
    map[r.key] = r.value_encrypted ? decrypt(r.value_encrypted) : r.value_plain;
  }
  return map;
}

function getConfig(settings, key) {
  const envVal = process.env[key];
  if (envVal) return envVal;
  return settings[key];
}

async function logActivity(component, message, level = 'info') {
  try {
    await supaRequest('POST', 'activity_logs', { level, component, message }, process.env.SUPABASE_SERVICE_ROLE_KEY);
  } catch (e) { /* logging failures must not break flows */ }
}

async function getYouTubeAccessToken() {
  const settings = await readSettings();
  const accessToken = process.env.GOOGLE_ACCESS_TOKEN || settings.GOOGLE_ACCESS_TOKEN;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || settings.GOOGLE_REFRESH_TOKEN;
  const clientId = process.env.GOOGLE_CLIENT_ID || settings.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || settings.GOOGLE_CLIENT_SECRET;
  const expiry = process.env.GOOGLE_TOKEN_EXPIRY || settings.GOOGLE_TOKEN_EXPIRY;

  if (!accessToken || !refreshToken || !clientId || !clientSecret) return null;

  // If token still valid (expiry in future with 60s margin), return it
  if (expiry) {
    const exp = new Date(expiry).getTime();
    if (exp > Date.now() + 60000) return accessToken;
  }

  // Refresh
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        refresh_token: refreshToken, grant_type: 'refresh_token'
      })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) return null;
    const newExpiry = new Date(Date.now() + (json.expires_in || 3600) * 1000).toISOString();
    const now = new Date().toISOString();
    const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
    await supaRequest('POST', 'settings', { key: 'GOOGLE_ACCESS_TOKEN', value_encrypted: encrypt(json.access_token), value_plain: null, updated_at: now }, srk);
    await supaRequest('POST', 'settings', { key: 'GOOGLE_TOKEN_EXPIRY', value_plain: newExpiry, value_encrypted: null, updated_at: now }, srk);
    return json.access_token;
  } catch (e) { return null; }
}

async function logError(component, message, meta) {
  try {
    await supaRequest('POST', 'error_logs', { component, message, meta: meta || null, created_at: new Date().toISOString() }, process.env.SUPABASE_SERVICE_ROLE_KEY);
  } catch (e) { /* noop */ }
}

module.exports = { SENSITIVE_KEYS, encryptionKey, encrypt, decrypt, mask, sendJson, readBody, cors, supaRequest, readSettings, getConfig, logActivity, logError };
