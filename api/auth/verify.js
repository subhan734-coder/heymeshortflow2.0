'use strict';

const { sendJson, readBody, supaRequest, logActivity, logError } = require('../_utils.js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }

  function cors(r) {
    r.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400'
    });
    r.end();
  }

  try {
    const { accessKey } = await readBody(req);
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
    const now = new Date().toISOString();

    // Load owner access key from env or settings
    let ownerKey = process.env.OWNER_ACCESS_KEY;
    try {
      const settings = await supaRequest('GET', 'settings?select=value_encrypted,value_plain&key=eq.OWNER_ACCESS_KEY', null, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const row = (settings || [])[0];
      if (row) ownerKey = row.value_encrypted ? require('../_utils.js').decrypt(row.value_encrypted) : row.value_plain;
    } catch (e) { /* use env fallback */ }

    // Rate limiting / failed attempt protection
    const rl = await supaRequest('GET', 'rate_limits?select=*&identifier=eq.auth:' + ip, null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const rec = (rl || [])[0];
    if (rec && rec.blocked_until && new Date(rec.blocked_until) > new Date()) {
      await logActivity('auth', 'Blocked login attempt from ' + ip, 'warn');
      return sendJson(res, 429, { error: 'Too many failed attempts. Try again later.' });
    }

    const ok = ownerKey && accessKey === ownerKey;

    if (!ok) {
      // record failure
      const failures = rec ? (parseInt(rec.failures || 0) + 1) : 1;
      let blockedUntil = null;
      if (failures >= 5) blockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      if (rec) {
        await supaRequest('PATCH', 'rate_limits?identifier=eq.auth:' + ip, { failures, blocked_until: blockedUntil, updated_at: now }, process.env.SUPABASE_SERVICE_ROLE_KEY);
      } else {
        await supaRequest('POST', 'rate_limits', { identifier: 'auth:' + ip, failures, blocked_until: blockedUntil, window_start: now }, process.env.SUPABASE_SERVICE_ROLE_KEY);
      }
      await logActivity('auth', 'Failed login attempt from ' + ip, 'warn');
      return sendJson(res, 401, { error: 'Invalid access key' });
    }

    // Success: reset failures, create session
    if (rec) {
      await supaRequest('PATCH', 'rate_limits?identifier=eq.auth:' + ip, { failures: 0, blocked_until: null, updated_at: now }, process.env.SUPABASE_SERVICE_ROLE_KEY);
    }

    const token = cryptoRandomToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await supaRequest('POST', 'sessions', { id: token, expires_at: expiresAt, created_at: now }, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await logActivity('auth', 'Owner login successful');

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Set-Cookie': 'yt_short_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800' + (process.env.NODE_ENV === 'production' ? '; Secure' : '')
    });
    return sendJson(res, 200, { authenticated: true, token });
  } catch (err) {
    await logError('auth', err.message || 'verify failed');
    return sendJson(res, 500, { error: err.message || 'Internal error' });
  }
};

function cryptoRandomToken() {
  return require('crypto').randomBytes(32).toString('hex');
}
