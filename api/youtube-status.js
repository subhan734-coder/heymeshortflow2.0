'use strict';

const { sendJson, supaRequest, getYouTubeAccessToken, logError } = require('../_utils.js');

function cors(r) {
  r.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
  const authed = await authenticate(req);
  if (!authed) { sendJson(res, 401, { error: 'Unauthorized' }); return; }

  try {
    const token = await getYouTubeAccessToken();
    let channel = null;
    let connected = false;
    let tokenValid = false;
    if (token) {
      try {
        const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
          headers: { Authorization: 'Bearer ' + token }
        });
        const chJson = await chRes.json().catch(() => ({}));
        if (chJson.items && chJson.items[0]) {
          channel = { id: chJson.items[0].id, title: chJson.items[0].snippet.title };
          connected = true;
          tokenValid = true;
        }
      } catch (e) { tokenValid = false; }
    }
    return sendJson(res, 200, { ok: true, data: { connected, channel, tokenValid } });
  } catch (err) {
    await logError('youtube_status', err.message || 'status failed');
    return sendJson(res, 500, { error: err.message || 'Internal error' });
  }
};
