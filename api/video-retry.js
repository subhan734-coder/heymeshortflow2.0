'use strict';

const { sendJson, readBody, supaRequest, logActivity, logError } = require('../_utils.js');

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
  const authed = await authenticate(req);
  if (!authed) { sendJson(res, 401, { error: 'Unauthorized' }); return; }

  try {
    const body = await readBody(req);
    const id = body.id;
    if (!id) return sendJson(res, 400, { error: 'Missing video id' });
    const now = new Date().toISOString();
    await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(id), { status: 'pending', error: null, updated_at: now }, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await logActivity('videos', 'Manual retry queued for video ' + id);
    return sendJson(res, 200, { ok: true, message: 'Retry queued.' });
  } catch (err) {
    await logError('video_retry', err.message || 'retry failed');
    return sendJson(res, 500, { error: err.message || 'Internal error' });
  }
};
