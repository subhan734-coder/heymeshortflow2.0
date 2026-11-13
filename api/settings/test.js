'use strict';

const { sendJson, readBody, supaRequest, getConfig, logActivity, logError } = require('../_utils.js');

function cors(r) {
  r.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400'
  });
  r.end();
}

async function httpTest(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }

  try {
    const { component } = await readBody(req);
    const settings = await supaRequest('GET', 'settings?select=*', null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const map = {};
    for (const r of settings || []) map[r.key] = r.value_encrypted ? require('../_utils.js').decrypt(r.value_encrypted) : r.value_plain;

    const results = [];

    async function test(name, fn) {
      try {
        const r = await fn();
        results.push({ name, ok: r.ok, status: r.status, message: r.body || (r.ok ? 'OK' : 'Failed') });
        if (!r.ok) await logActivity('settings_test', name + ' test failed: ' + r.body, 'warn');
      } catch (e) {
        results.push({ name, ok: false, status: 0, message: e.message || 'Error' });
        await logActivity('settings_test', name + ' test error: ' + (e.message || 'unknown'), 'error');
      }
    }

    const supaUrl = process.env.SUPABASE_URL || map.SUPABASE_URL;
    const supaAnon = process.env.SUPABASE_ANON_KEY || map.SUPABASE_ANON_KEY;
    const supaSvc = process.env.SUPABASE_SERVICE_ROLE_KEY || map.SUPABASE_SERVICE_ROLE_KEY;

    if (component === 'supabase' || !component) {
      await test('Supabase', async () => {
        if (!supaUrl || !supaAnon) throw new Error('Supabase URL/Anon key not configured');
        const res = await fetch(supaUrl.endsWith('/') ? supaUrl + 'rest/v1/' : supaUrl + '/rest/v1/', {
          headers: { apikey: supaAnon, Authorization: 'Bearer ' + supaAnon }
        });
        return { ok: res.ok, status: res.status, body: res.ok ? 'Supabase reachable' : await res.text().catch(() => '') };
      });
    }
    if (component === 'telegram' || !component) {
      await test('Telegram', async () => {
        const token = process.env.TELEGRAM_BOT_TOKEN || map.TELEGRAM_BOT_TOKEN;
        if (!token) throw new Error('Telegram bot token not configured');
        const res = await fetch('https://api.telegram.org/bot' + encodeURIComponent(token) + '/getMe');
        const json = await res.json().catch(() => ({}));
        return { ok: res.ok && json.ok, status: res.status, body: json.ok ? 'Bot: ' + (json.result && json.result.username) : (json.description || 'Telegram error') };
      });
    }
    if (component === 'groq' || !component) {
      await test('Groq', async () => {
        const key = process.env.GROQ_API_KEY || map.GROQ_API_KEY;
        const model = process.env.GROQ_MODEL || map.GROQ_MODEL || 'llama-3.1-8b-instant';
        if (!key) throw new Error('Groq API key not configured');
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 })
        });
        const json = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, body: res.ok ? 'Groq OK' : (json.error && json.error.message || 'Groq error') };
      });
    }
    if (component === 'youtube' || !component) {
      await test('YouTube Config', async () => {
        const cid = process.env.GOOGLE_CLIENT_ID || map.GOOGLE_CLIENT_ID;
        const csec = process.env.GOOGLE_CLIENT_SECRET || map.GOOGLE_CLIENT_SECRET;
        if (!cid || !csec) throw new Error('Google OAuth credentials not configured');
        return { ok: true, status: 200, body: 'Google credentials present' };
      });
    }

    if (component) {
      const r = results.find(x => x.name.toLowerCase().includes(component));
      return sendJson(res, 200, { ok: r ? r.ok : false, data: r || { name: component, ok: false, message: 'Unknown component' } });
    }
    return sendJson(res, 200, { ok: results.every(x => x.ok), data: results });
  } catch (err) {
    await logError('settings_test', err.message || 'test failed');
    return sendJson(res, 500, { error: err.message || 'Internal error' });
  }
};
