'use strict';

const { sendJson, supaRequest, logError, getYouTubeAccessToken } = require('../_utils.js');

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
    const settings = await supaRequest('GET', 'settings?select=*', null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const smap = {};
    for (const r of settings || []) smap[r.key] = r.value_encrypted ? require('../_utils.js').decrypt(r.value_encrypted) : r.value_plain;

    const supaUrl = process.env.SUPABASE_URL || smap.SUPABASE_URL;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY || smap.SUPABASE_SERVICE_ROLE_KEY;
    const botToken = process.env.TELEGRAM_BOT_TOKEN || smap.TELEGRAM_BOT_TOKEN;
    const ownerChatId = process.env.TELEGRAM_CHAT_ID || smap.TELEGRAM_CHAT_ID;
    const groqKey = process.env.GROQ_API_KEY || smap.GROQ_API_KEY;

    let database = 'unreachable', storage = 'unreachable', automation = 'offline';
    let telegram = 'not_configured', youtube = 'not_connected', groq = 'not_configured', supabase = 'not_configured';
    let lastCron = null;

    if (supaUrl && svcKey) {
      supabase = 'configured';
      try {
        await supaRequest('GET', 'videos?select=count&limit=1', null, svcKey);
        database = 'reachable';
        storage = 'reachable';
      } catch (e) { database = 'error'; }
    }

    if (botToken) {
      telegram = 'configured';
    }
    if (ownerChatId) telegram = telegram === 'configured' ? 'configured' : 'configured';

    const ytToken = await getYouTubeAccessToken();
    if (ytToken) {
      youtube = 'connected';
    } else if (process.env.GOOGLE_CLIENT_ID || smap.GOOGLE_CLIENT_ID) {
      youtube = 'not_connected';
    }

    if (groqKey) groq = 'configured';

    automation = (supabase === 'configured' && database === 'reachable') ? 'online' : 'degraded';

    // last cron from activity logs
    try {
      const logs = await supaRequest('GET', 'activity_logs?select=created_at&component=eq.cron&order=created_at.desc&limit=1', null, svcKey);
      if (logs && logs[0]) lastCron = logs[0].created_at;
    } catch (e) { /* noop */ }

    const status = (database === 'reachable') ? 'healthy' : 'degraded';

    return sendJson(res, 200, {
      ok: true, data: {
        status, database, storage, automation,
        telegram, youtube, groq, supabase, lastCron
      }
    });
  } catch (err) {
    await logError('health', err.message || 'health failed');
    return sendJson(res, 200, { ok: true, data: { status: 'degraded', database: 'error', automation: 'offline' } });
  }
};
