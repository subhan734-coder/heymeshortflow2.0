'use strict';

const { sendJson, supaRequest, logActivity, logError } = require('../_utils.js');

function cors(r) {
  r.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400'
  });
  r.end();
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }

  try {
    const token = extractToken(req);
    if (token) {
      await supaRequest('DELETE', 'sessions?id=eq.' + encodeURIComponent(token), null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    }
    await logActivity('auth', 'Owner logout');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Set-Cookie': 'yt_short_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    });
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    await logError('auth', err.message || 'logout failed');
    return sendJson(res, 500, { error: err.message || 'Internal error' });
  }
};

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const cookie = req.headers['cookie'] || '';
  const m = cookie.match(/yt_short_session=([^;]+)/);
  return m ? m[1] : null;
}
