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
    const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
    await supaRequest('GET', 'settings?select=key&limit=1', null, srk);

    const sensitive = ['TELEGRAM_BOT_TOKEN','TELEGRAM_BOT_ID','TELEGRAM_CHAT_ID','TELEGRAM_WEBHOOK_SECRET',
      'SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY',
      'GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REDIRECT_URI',
      'YOUTUBE_REFRESH_TOKEN','GOOGLE_REFRESH_TOKEN'];

    const now = new Date().toISOString();
    for (const key of sensitive) {
      await supaRequest('DELETE', 'settings?key=eq.' + encodeURIComponent(key), null, srk);
    }
    await logActivity('settings', 'Integrations disconnected (credentials cleared)');
    return sendJson(res, 200, { ok: true, message: 'Integrations disconnected.' });
  } catch (err) {
    await logError('settings_disconnect', err.message || 'disconnect failed');
    return sendJson(res, 500, { error: err.message || 'Internal error' });
  }
};
