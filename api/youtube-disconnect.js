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

async function authenticate(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const cookie = req.headers['cookie'] || '';
  const m = cookie.match(/yt_short_session=([^;]+)/);
  const sessToken = token || (m ? m[1] : null);
  if (!sessToken) return null;
  const now = new Date().toISOString();
  const rows = await supaRequest('GET', 'sessions?select=id&id=eq.' + encodeURIComponent(sessToken) + '&expires_at=gt.' + now, null, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return rows && rows.length > 0;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
  const authed = await authenticate(req);
  if (!authed) { sendJson(res, 401, { error: 'Unauthorized' }); return; }

  try {
    const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const keys = ['GOOGLE_ACCESS_TOKEN', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_TOKEN_EXPIRY'];
    const now = new Date().toISOString();
    for (const key of keys) {
      await supaRequest('DELETE', 'settings?key=eq.' + encodeURIComponent(key), null, srk);
    }
    await supaRequest('DELETE', 'youtube_channels', null, srk); // clear all channels (single owner)
    await logActivity('youtube', 'Channel disconnected');
    return sendJson(res, 200, { ok: true, message: 'YouTube channel disconnected.' });
  } catch (err) {
    await logError('youtube_disconnect', err.message || 'disconnect failed');
    return sendJson(res, 500, { error: err.message || 'Internal error' });
  }
};
