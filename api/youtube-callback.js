'use strict';

const { sendJson, supaRequest, logActivity, logError } = require('../_utils.js');

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
    const url = new URL(req.url, 'http://localhost');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    if (error) { res.writeHead(302, { Location: '/#youtube-error=' + encodeURIComponent(error) }); return res.end(); }
    if (!code || !state) { res.writeHead(302, { Location: '/#youtube-error=missing_params' }); return res.end(); }

    const settings = await supaRequest('GET', 'settings?select=*', null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const map = {};
    for (const r of settings || []) map[r.key] = r.value_encrypted ? require('../_utils.js').decrypt(r.value_encrypted) : r.value_plain;

    const clientId = process.env.GOOGLE_CLIENT_ID || map.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || map.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || map.GOOGLE_REDIRECT_URI;
    if (!clientId || !clientSecret) { res.writeHead(302, { Location: '/#youtube-error=oauth_credentials_missing' }); return res.end(); }

    // Verify state
    const rows = await supaRequest('GET', 'oauth_states?select=*&state=eq.' + encodeURIComponent(state), null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const os = (rows || [])[0];
    if (!os) { res.writeHead(302, { Location: '/#youtube-error=invalid_state' }); return res.end(); }
    if (new Date(os.expires_at) < new Date()) { res.writeHead(302, { Location: '/#youtube-error=state_expired' }); return res.end(); }

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
        code_verifier: os.code_verifier
      })
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson.access_token) {
      await supaRequest('DELETE', 'oauth_states?state=eq.' + encodeURIComponent(state), null, process.env.SUPABASE_SERVICE_ROLE_KEY);
      res.writeHead(302, { Location: '/#youtube-error=token_exchange_failed' }); return res.end();
    }

    // Identify channel
    let channel = { id: 'unknown', title: 'YouTube Channel' };
    try {
      const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: { Authorization: 'Bearer ' + tokenJson.access_token }
      });
      const chJson = await chRes.json().catch(() => ({}));
      if (chJson.items && chJson.items[0]) {
        channel = { id: chJson.items[0].id, title: chJson.items[0].snippet.title };
      }
    } catch (e) { /* channel fetch non-fatal */ }

    const now = new Date().toISOString();
    const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
    // Store tokens encrypted
    await supaRequest('POST', 'settings', { key: 'GOOGLE_ACCESS_TOKEN', value_encrypted: require('../_utils.js').encrypt(tokenJson.access_token), value_plain: null, updated_at: now }, srk);
    if (tokenJson.refresh_token) {
      await supaRequest('POST', 'settings', { key: 'GOOGLE_REFRESH_TOKEN', value_encrypted: require('../_utils.js').encrypt(tokenJson.refresh_token), value_plain: null, updated_at: now }, srk);
    }
    await supaRequest('POST', 'settings', { key: 'GOOGLE_TOKEN_EXPIRY', value_plain: new Date(Date.now() + (tokenJson.expires_in || 3600) * 1000).toISOString(), value_encrypted: null, updated_at: now }, srk);

    // Upsert channel record
    await supaRequest('POST', 'youtube_channels', {
      id: channel.id,
      title: channel.title,
      access_token_encrypted: require('../_utils.js').encrypt(tokenJson.access_token),
      refresh_token_encrypted: tokenJson.refresh_token ? require('../_utils.js').encrypt(tokenJson.refresh_token) : null,
      token_expiry: new Date(Date.now() + (tokenJson.expires_in || 3600) * 1000).toISOString(),
      connected_at: now,
      updated_at: now
    }, srk);

    await supaRequest('DELETE', 'oauth_states?state=eq.' + encodeURIComponent(state), null, srk);
    await logActivity('youtube', 'Channel connected: ' + channel.title + ' (' + channel.id + ')');

    res.writeHead(302, { Location: '/#youtube-connected=' + encodeURIComponent(channel.id) });
    return res.end();
  } catch (err) {
    await logError('youtube_callback', err.message || 'oauth callback failed');
    res.writeHead(302, { Location: '/#youtube-error=internal' }); return res.end();
  }
};
