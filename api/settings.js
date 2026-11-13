'use strict';

const { sendJson, readBody, supaRequest, readSettings, getConfig, SENSITIVE_KEYS, encrypt, mask, logActivity, logError } = require('../_utils.js');

function cors(r) {
  r.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400'
  });
  r.end();
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); return; }

  try {
    if (req.method === 'GET') {
      const settings = await readSettings();
      const out = {};
      for (const [k, v] of Object.entries(settings)) {
        out[k] = SENSITIVE_KEYS.has(k) ? (v ? mask(v) : '') : (v || '');
      }
      return sendJson(res, 200, { ok: true, data: out });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const now = new Date().toISOString();
      const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;

      // Verify the service role key works before storing (bootstrap check)
      await supaRequest('GET', 'settings?select=key&limit=1', null, srk);

      const toSave = {};
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || v === null) continue;
        toSave[k] = String(v);
      }

      for (const [k, v] of Object.entries(toSave)) {
        const row = { key: k, updated_at: now };
        if (SENSITIVE_KEYS.has(k)) {
          row.value_encrypted = encrypt(v);
          row.value_plain = null;
        } else {
          row.value_encrypted = null;
          row.value_plain = v;
        }
        await supaRequest('POST', 'settings?on_conflict=key', row, srk);
      }

      await logActivity('settings', 'Configuration updated');
      return sendJson(res, 200, { ok: true, message: 'Configuration saved.' });
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    await logError('settings', err.message || 'settings failed');
    return sendJson(res, 500, { error: err.message || 'Internal error' });
  }
};
