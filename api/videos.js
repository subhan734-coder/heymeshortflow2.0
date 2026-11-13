'use strict';

const { sendJson, readBody, supaRequest, logActivity, logError } = require('../_utils.js');

function cors(r) {
  r.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
    const url = new URL(req.url, 'http://localhost');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const status = url.searchParams.get('status');

    if (req.method === 'GET') {
      let q = 'videos?select=*&order=created_at.desc&limit=' + limit;
      if (status) q += '&status=eq.' + encodeURIComponent(status);
      const rows = await supaRequest('GET', q, null, process.env.SUPABASE_SERVICE_ROLE_KEY);
      return sendJson(res, 200, { ok: true, data: { videos: rows || [] } });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const now = new Date().toISOString();
      const row = {
        filename: body.filename || 'video.mp4',
        storage_path: body.storagePath || null,
        size: body.size || null,
        title: body.title || null,
        description: body.description || null,
        hashtags: body.hashtags || null,
        category: body.category || null,
        tags: body.tags || null,
        status: body.status || 'pending',
        created_at: now,
        updated_at: now
      };
      const created = await supaRequest('POST', 'videos', row, process.env.SUPABASE_SERVICE_ROLE_KEY);
      await logActivity('videos', 'Video record created: ' + row.filename);
      return sendJson(res, 201, { ok: true, data: created && created[0] ? created[0] : row });
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    await logError('videos', err.message || 'videos failed');
    return sendJson(res, 500, { error: err.message || 'Internal error' });
  }
};
