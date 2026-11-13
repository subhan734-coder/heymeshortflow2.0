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
    const filename = body.filename || 'upload.mp4';
    const contentType = body.contentType || 'video/mp4';
    const now = new Date().toISOString();
    const safeName = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const path = 'original-videos/' + now.replace(/[:.]/g, '-') + '_' + safeName;

    const base = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !anonKey) throw new Error('Supabase not configured');

    const baseClean = base.endsWith('/') ? base : base + '/';

    // Try Supabase signed upload URL first
    let uploadUrl = null;
    try {
      const sr = await fetch(baseClean + 'storage/v1/signedUploadUrl', {
        method: 'POST',
        headers: {
          'apikey': svcKey, 'Authorization': 'Bearer ' + svcKey, 'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path, expiresIn: 3600 })
      });
      const sj = await sr.json().catch(() => ({}));
      if (sr.ok && sj.signedUrl) uploadUrl = sj.signedUrl;
    } catch (e) { /* fallback */ }

    if (!uploadUrl) {
      // Fallback: direct object PUT with anon key (publishable key)
      uploadUrl = baseClean + 'storage/v1/object/original-videos/' + encodeURIComponent(path.split('/')[1]);
    }

    await logActivity('upload', 'Signed upload URL issued for ' + filename);
    return sendJson(res, 200, { ok: true, uploadUrl, videoPath: path, contentType });
  } catch (err) {
    await logError('upload', err.message || 'upload sign failed');
    return sendJson(res, 500, { error: err.message || 'Internal error' });
  }
};
