'use strict';

const { sendJson, supaRequest, logError } = require('../_utils.js');

function cors(r) {
  r.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400'
  });
  r.end();
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); return; }
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }

  try {
    const token = extractToken(req);
    if (!token) return sendJson(res, 401, { authenticated: false });

    const now = new Date().toISOString();
    const rows = await supaRequest('GET', 'sessions?select=id&id=eq.' + encodeURIComponent(token) + '&expires_at=gt.' + now, null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    if (!rows || rows.length === 0) return sendJson(res, 401, { authenticated: false });

    return sendJson(res, 200, { authenticated: true, token });
  } catch (err) {
    await logError('auth', err.message || 'me failed');
    return sendJson(res, 401, { authenticated: false });
  }
};

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const cookie = req.headers['cookie'] || '';
  const m = cookie.match(/yt_short_session=([^;]+)/);
  return m ? m[1] : null;
}
