'use strict';

const { sendJson, supaRequest, logActivity, logError } = require('../_utils.js');
const crypto = require('crypto');

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

function baseUrl(req) {
  // Detect public URL for redirect
  const forwarded = req.headers['x-forwarded-host'] || '';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = forwarded.split(',')[0].trim() || req.headers['host'] || 'localhost';
  return proto + '://' + host;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); return; }
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }

  try {
    const authed = await authenticate(req);
    if (!authed) { res.writeHead(401); return res.end('Unauthorized'); }

    const settings = await supaRequest('GET', 'settings?select=*', null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const map = {};
    for (const r of settings || []) map[r.key] = r.value_encrypted ? require('../_utils.js').decrypt(r.value_encrypted) : r.value_plain;

    const clientId = process.env.GOOGLE_CLIENT_ID || map.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || map.GOOGLE_REDIRECT_URI || baseUrl(req) + '/api/youtube-callback';
    if (!clientId) { res.writeHead(500); return res.end('Google Client ID not configured'); }

    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    const now = new Date().toISOString();
    await supaRequest('POST', 'oauth_states', { state, code_verifier: verifier, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), created_at: now }, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const scope = 'https://www.googleapis.com/auth/youtube.upload';
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
      'client_id=' + encodeURIComponent(clientId) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&response_type=code' +
      '&scope=' + encodeURIComponent(scope) +
      '&access_type=offline' +
      '&prompt=consent' +
      '&state=' + encodeURIComponent(state) +
      '&code_challenge=' + encodeURIComponent(challenge) +
      '&code_challenge_method=S256';

    await logActivity('youtube', 'OAuth authorization started');
    res.writeHead(302, { Location: authUrl });
    return res.end();
  } catch (err) {
    await logError('youtube_auth', err.message || 'oauth start failed');
    res.writeHead(500); return res.end('Internal error');
  }
};
