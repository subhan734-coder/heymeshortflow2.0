'use strict';

const { sendJson, readBody, supaRequest, logActivity, logError, encrypt, decrypt, getConfig } = require('../_utils.js');

function cors(r) {
  r.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400'
  });
  r.end();
}

async function tgApi(token, method, body) {
  const res = await fetch('https://api.telegram.org/bot' + encodeURIComponent(token) + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });
  return await res.json().catch(() => ({ ok: false, status: res.status }));
}

async function tgSend(token, chatId, text, opts = {}) {
  return tgApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...opts });
}

async function tgAnswer(cbQueryId, text) {
  // token not needed for answerCallbackQuery? It needs bot token. Handle via caller.
  return { ok: true };
}

async function authenticateOwner(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const cookie = req.headers['cookie'] || '';
  const m = cookie.match(/yt_short_session=([^;]+)/);
  const sessToken = token || (m ? m[1] : null);
  if (!sessToken) return false;
  const now = new Date().toISOString();
  const rows = await supaRequest('GET', 'sessions?select=id&id=eq.' + encodeURIComponent(sessToken) + '&expires_at=gt.' + now, null, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return rows && rows.length > 0;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); return; }
  if (req.method === 'GET') {
    // webhook info endpoint
    return sendJson(res, 200, { ok: true, webhook: 'telegram-webhook' });
  }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }

  try {
    const secret = req.headers['x-telegram-bot-api-secret-token'] || '';
    const settings = await supaRequest('GET', 'settings?select=*', null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const map = {};
    for (const r of settings || []) map[r.key] = r.value_encrypted ? decrypt(r.value_encrypted) : r.value_plain;

    const botToken = process.env.TELEGRAM_BOT_TOKEN || map.TELEGRAM_BOT_TOKEN;
    const ownerChatId = (process.env.TELEGRAM_CHAT_ID || map.TELEGRAM_CHAT_ID || '').toString();
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || map.TELEGRAM_WEBHOOK_SECRET || '';

    if (!botToken) {
      await logError('telegram', 'Bot token not configured');
      return sendJson(res, 500, { error: 'Bot not configured' });
    }
    if (webhookSecret && secret !== webhookSecret) {
      await logActivity('telegram', 'Webhook secret mismatch', 'warn');
      return sendJson(res, 401, { error: 'Invalid webhook secret' });
    }

    const update = await readBody(req);
    await supaRequest('POST', 'telegram_updates', { update_id: update.update_id, payload: JSON.stringify(update), received_at: new Date().toISOString() }, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const message = update.message || update.edited_message;
    const callback = update.callback_query;

    if (callback) {
      await handleCallback(update, callback, botToken, ownerChatId, map);
      return sendJson(res, 200, { ok: true });
    }

    if (message) {
      await handleMessage(update, message, botToken, ownerChatId, map);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    await logError('telegram_webhook', err.message || 'webhook failed');
    return sendJson(res, 500, { error: 'Internal error' });
  }
};

async function handleMessage(update, message, botToken, ownerChatId, map) {
  const chatId = (message.chat && message.chat.id).toString();
  if (chatId !== ownerChatId) {
    await tgSend(botToken, chatId, 'Unauthorized chat. This bot is single-owner.');
    return;
  }

  const text = message.text || '';
  const commandMatch = text.match(/^\/(\w+)(@\w+)?(?:\s+(.+))?$/);

  // Handle multi-step conversation states
  const state = await getUserState(chatId);
  if (state && state.step) {
    if (state.step === 'awaiting_schedule_confirm') {
      await clearUserState(chatId);
      if (text.trim().toLowerCase() === 'yes' || text.trim().toLowerCase() === 'confirm' || text.trim().toLowerCase() === 'y') {
        await handleScheduleConfirm(chatId, state.videoId, state.scheduledAtUtc, state.pkt, botToken);
      } else {
        await tgSend(botToken, chatId, 'Scheduling cancelled.');
      }
      return;
    }
    await clearUserState(chatId);
    if (state.step === 'awaiting_groq_key') {
      await handleGroqKeySubmit(chatId, text, botToken, map);
      return;
    }
    if (state.step === 'awaiting_groq_model') {
      await handleGroqModelSubmit(chatId, text, botToken, map);
      return;
    }
    if (state.step === 'awaiting_title') {
      await handleTitleEdit(chatId, state.videoId, text, botToken);
      return;
    }
    if (state.step === 'awaiting_description') {
      await handleDescriptionEdit(chatId, state.videoId, text, botToken);
      return;
    }
    if (state.step === 'awaiting_schedule') {
      await handleScheduleSubmit(chatId, state.videoId, text, botToken);
      return;
    }
  }

  if (!commandMatch) {
    if (message.video || message.document) {
      await handleVideoSubmission(update, message, botToken, map);
    } else {
      await tgSend(botToken, chatId, 'Send a video file, or use a command: /start /status /setgroq /groqmodel /testgroq /help');
    }
    return;
  }

  const cmd = commandMatch[1];
  const arg = commandMatch[3];

  switch (cmd) {
    case 'start':
      await tgSend(botToken, chatId, 'YouTube Shorts Automation bot.<br/>Send a video to begin. Commands: /status /setgroq /groqmodel /testgroq /help', { parse_mode: 'HTML' });
      break;
    case 'help':
      await tgSend(botToken, chatId, '<b>Commands</b>\n/start - Welcome\n/status - System status\n/setgroq - Change Groq API key\n/groqmodel - Change Groq model\n/testgroq - Test Groq connection\n/help - This help', { parse_mode: 'HTML' });
      break;
    case 'status':
      await handleStatus(chatId, botToken);
      break;
    case 'setgroq':
      await setUserState(chatId, { step: 'awaiting_groq_key' });
      await tgSend(botToken, chatId, 'Send the new Groq API key. It will be tested before replacing the current one.');
      break;
    case 'groqmodel':
      await setUserState(chatId, { step: 'awaiting_groq_model' });
      await tgSend(botToken, chatId, 'Send the new Groq model name (e.g. llama-3.1-8b-instant).');
      break;
    case 'testgroq':
      await handleTestGroq(chatId, botToken, map);
      break;
    default:
      await tgSend(botToken, chatId, 'Unknown command. Use /help');
  }
}

async function handleVideoSubmission(update, message, botToken, map) {
  const chatId = (message.chat.id).toString();
  const video = message.video || message.document;
  if (!video) return;
  if (video.mime_type && !video.mime_type.startsWith('video/') && !video.file_name.match(/\.(mp4|mov|mkv|webm)$/i)) {
    await tgSend(botToken, chatId, 'Please send a video file.');
    return;
  }

  const fileId = video.file_id;
  const fileName = video.file_name || 'video_' + Date.now() + '.mp4';
  const fileSize = video.file_size || 0;

  await tgSend(botToken, chatId, 'Video received: <b>' + escapeHtml(fileName) + '</b>\nDownloading&hellip;', { parse_mode: 'HTML' });

  try {
    // 1. Get file path from Telegram
    const fileInfo = await tgApi(botToken, 'getFile', { file_id: fileId });
    if (!fileInfo.ok || !fileInfo.result) throw new Error('getFile failed');
    const filePath = fileInfo.result.file_path;

    // 2. Download file bytes
    const dlRes = await fetch('https://api.telegram.org/file/bot' + encodeURIComponent(botToken) + '/' + encodeURIComponent(filePath));
    if (!dlRes.ok) throw new Error('File download failed (HTTP ' + dlRes.status + ')');
    const chunks = [];
    dlRes.body.on('error', () => { throw new Error('Download stream error'); });
    const reader = dlRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);

    // 3. Upload to Supabase Storage (original-videos)
    const settings = await supaRequest('GET', 'settings?select=*', null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const smap = {};
    for (const r of settings || []) smap[r.key] = r.value_encrypted ? decrypt(r.value_encrypted) : r.value_plain;
    const supaUrl = process.env.SUPABASE_URL || smap.SUPABASE_URL;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY || smap.SUPABASE_SERVICE_ROLE_KEY;
    const anonKey = process.env.SUPABASE_ANON_KEY || smap.SUPABASE_ANON_KEY;
    if (!supaUrl || !svcKey) throw new Error('Supabase not configured');

    const base = supaUrl.endsWith('/') ? supaUrl : supaUrl + '/';
    const storagePath = 'original-videos/' + Date.now() + '_' + fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const putRes = await fetch(base + 'storage/v1/object/original-videos/' + encodeURIComponent(storagePath.split('/')[1]), {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + svcKey,
        'apikey': svcKey,
        'Content-Type': video.mime_type || 'video/mp4',
        'x-upsert': 'true'
      },
      body: buffer
    });
    if (!putRes.ok) throw new Error('Storage upload failed: ' + await putRes.text().catch(() => ''));

    // 4. Save video record
    const now = new Date().toISOString();
    const created = await supaRequest('POST', 'videos', {
      filename: fileName,
      storage_path: storagePath,
      size: fileSize || buffer.length,
      status: 'pending',
      created_at: now,
      updated_at: now
    }, svcKey);
    const videoRow = (created && created[0]) || { id: 'unknown', filename: fileName, storage_path: storagePath };

    // 5. Create processing job
    await supaRequest('POST', 'processing_jobs', {
      video_id: videoRow.id,
      job_type: 'download',
      status: 'queued',
      progress: 0,
      created_at: now,
      updated_at: now
    }, svcKey);

    await logActivity('telegram', 'Video received and queued: ' + fileName);
    await tgSend(botToken, chatId, 'Video saved and queued for processing: <b>' + escapeHtml(fileName) + '</b>\nMetadata generation will start shortly.', { parse_mode: 'HTML' });

    // Kick off metadata generation (Groq) - fire and forget
    generateMetadata(videoRow.id, fileName, botToken, chatId, smap).catch(e => {
      logError('metadata', e.message || 'metadata gen failed');
    });
  } catch (err) {
    await logError('telegram_video', err.message || 'video handling failed');
    await tgSend(botToken, chatId, 'Failed to process video: ' + escapeHtml(err.message || 'unknown error'), { parse_mode: 'HTML' });
  }
}

async function generateMetadata(videoId, filename, botToken, chatId, smap) {
  const groqKey = process.env.GROQ_API_KEY || smap.GROQ_API_KEY;
  const groqModel = process.env.GROQ_MODEL || smap.GROQ_MODEL || 'llama-3.1-8b-instant';
  const now = new Date().toISOString();

  // Update job status
  await supaRequest('POST', 'processing_jobs', { video_id: videoId, job_type: 'metadata', status: 'processing', progress: 10, updated_at: now }, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!groqKey) {
    await markVideoError(videoId, 'Groq API key not configured');
    await tgSend(botToken, chatId, 'Metadata generation skipped: Groq API key not configured.');
    return;
  }

  // Infer topic from filename
  const topic = inferTopic(filename);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: groqModel,
        messages: [
          { role: 'system', content: 'You are a YouTube Shorts metadata generator. Infer the video topic from the filename only. Do not claim to have watched the video. Output JSON only with keys: title, description, hashtags (array), category, tags (array).' },
          { role: 'user', content: 'Filename: ' + filename + '\nInferred topic: ' + topic }
        ],
        max_tokens: 400,
        temperature: 0.5
      })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.choices || !json.choices[0]) throw new Error(json.error && json.error.message ? json.error.message : 'Groq response invalid');

    const content = json.choices[0].message.content || '{}';
    let parsed = {};
    try { parsed = JSON.parse(content); } catch {
      // try to extract JSON
      const m = content.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    const title = parsed.title || topic;
    const description = parsed.description || 'Shorts video: ' + filename;
    const hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags : ['#Shorts'];
    const category = parsed.category || 'Tech';
    const tags = Array.isArray(parsed.tags) ? parsed.tags : [];

    const updNow = new Date().toISOString();
    await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(videoId), {
      title, description, hashtags, category, tags,
      status: 'pending_approval',
      updated_at: updNow
    }, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await supaRequest('POST', 'processing_jobs', { video_id: videoId, job_type: 'metadata', status: 'done', progress: 100, updated_at: updNow }, process.env.SUPABASE_SERVICE_ROLE_KEY);

    await logActivity('metadata', 'Generated metadata for video ' + videoId);
    await sendApprovalToTelegram(videoId, filename, title, description, hashtags, category, tags, botToken, chatId);
  } catch (err) {
    await markVideoError(videoId, err.message || 'metadata generation failed');
    await tgSend(botToken, chatId, 'Metadata generation failed: ' + escapeHtml(err.message || 'unknown'), { parse_mode: 'HTML' });
  }
}

function inferTopic(filename) {
  const name = filename.replace(/\.[^/.]+$/, '').replace(/[_\-]+/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  return name || 'Video';
}

async function sendApprovalToTelegram(videoId, filename, title, description, hashtags, category, tags, botToken, chatId) {
  const msg = '<b>NEW VIDEO READY</b>\n\nFilename: ' + escapeHtml(filename) +
    '\n\n<b>Title:</b>\n' + escapeHtml(title) +
    '\n\n<b>Description:</b>\n' + escapeHtml(description) +
    '\n\n<b>Hashtags:</b>\n' + (hashtags && hashtags.join ? hashtags.join(' ') : escapeHtml(String(hashtags))) +
    '\n\n<b>Category:</b> ' + escapeHtml(category) +
    '\n\nThe video will <b>not</b> be uploaded until you approve.';

  const keyboard = {
    inline_keyboard: [
      [{ text: 'Approve', callback_data: 'approve:' + videoId }],
      [{ text: 'Edit Title', callback_data: 'edit_title:' + videoId }, { text: 'Edit Description', callback_data: 'edit_desc:' + videoId }],
      [{ text: 'Regenerate', callback_data: 'regen:' + videoId }, { text: 'Cancel', callback_data: 'cancel:' + videoId }]
    ]
  };

  await tgApi(botToken, 'sendMessage', { chat_id: chatId, text: msg, parse_mode: 'HTML', reply_markup: keyboard });
}

async function handleCallback(update, callback, botToken, ownerChatId, map) {
  const chatId = (callback.message && callback.message.chat && callback.message.chat.id).toString();
  if (chatId !== ownerChatId) {
    await tgApi(botToken, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Unauthorized.', show_alert: true });
    return;
  }
  const data = callback.data || '';
  const parts = data.split(':');
  const action = parts[0];
  const videoId = parts[1];

  await tgApi(botToken, 'answerCallbackQuery', { callback_query_id: callback.id });

  if (action === 'approve') {
    await approveVideo(videoId, botToken, chatId);
  } else if (action === 'regen') {
    await regenerateMetadata(videoId, botToken, chatId, map);
  } else if (action === 'cancel') {
    await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(videoId), { status: 'cancelled', updated_at: new Date().toISOString() }, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await tgSend(botToken, chatId, 'Video cancelled: ' + videoId);
  } else if (action === 'edit_title') {
    await setUserState(chatId, { step: 'awaiting_title', videoId });
    await tgSend(botToken, chatId, 'Send the new title for video ' + videoId);
  } else if (action === 'edit_desc') {
    await setUserState(chatId, { step: 'awaiting_description', videoId });
    await tgSend(botToken, chatId, 'Send the new description for video ' + videoId);
  }
}

async function approveVideo(videoId, botToken, chatId) {
  const rows = await supaRequest('GET', 'videos?select=*&id=eq.' + encodeURIComponent(videoId), null, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const v = (rows || [])[0];
  if (!v) { await tgSend(botToken, chatId, 'Video not found.'); return; }

  const now = new Date().toISOString();
  await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(videoId), { status: 'awaiting_schedule', updated_at: now }, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await tgSend(botToken, chatId, 'Video approved: <b>' + escapeHtml(v.filename) + '</b>\n\nWhen should this video be published?\nExamples: "Tomorrow at 8 PM", "15 November 2026 at 8:30 PM".\nDefault timezone: Asia/Karachi.\nReply with the date and time.', { parse_mode: 'HTML' });
  await setUserState(chatId, { step: 'awaiting_schedule', videoId });
}

async function handleTitleEdit(chatId, videoId, text, botToken) {
  await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(videoId), { title: text, updated_at: new Date().toISOString() }, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await tgSend(botToken, chatId, 'Title updated.');
}

async function handleDescriptionEdit(chatId, videoId, text, botToken) {
  await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(videoId), { description: text, updated_at: new Date().toISOString() }, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await tgSend(botToken, chatId, 'Description updated.');
}

async function regenerateMetadata(videoId, botToken, chatId, map) {
  const rows = await supaRequest('GET', 'videos?select=filename&id=eq.' + encodeURIComponent(videoId), null, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const v = (rows || [])[0];
  if (!v) { await tgSend(botToken, chatId, 'Video not found.'); return; }
  await tgSend(botToken, chatId, 'Regenerating metadata for ' + escapeHtml(v.filename) + '&hellip;');
  await generateMetadata(videoId, v.filename, botToken, chatId, map);
}

async function handleStatus(chatId, botToken) {
  try {
    const rows = await supaRequest('GET', 'videos?select=status&limit=1000', null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const counts = {};
    for (const r of rows || []) counts[r.status] = (counts[r.status] || 0) + 1;
    let txt = '<b>System Status</b>\n';
    txt += 'Total: ' + (rows || []).length + '\n';
    for (const [k, v] of Object.entries(counts)) txt += k + ': ' + v + '\n';
    await tgSend(botToken, chatId, txt, { parse_mode: 'HTML' });
  } catch (e) {
    await tgSend(botToken, chatId, 'Status check failed.');
  }
}

async function handleTestGroq(chatId, botToken, map) {
  const groqKey = process.env.GROQ_API_KEY || map.GROQ_API_KEY;
  const groqModel = process.env.GROQ_MODEL || map.GROQ_MODEL || 'llama-3.1-8b-instant';
  if (!groqKey) { await tgSend(botToken, chatId, 'Groq API key not configured.'); return; }
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: groqModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 })
    });
    const json = await res.json().catch(() => ({}));
    await tgSend(botToken, chatId, res.ok ? 'Groq connection OK.' : 'Groq test failed: ' + (json.error && json.error.message ? json.error.message : 'unknown'));
  } catch (e) {
    await tgSend(botToken, chatId, 'Groq test error: ' + escapeHtml(e.message || 'unknown'));
  }
}

async function handleGroqKeySubmit(chatId, text, botToken, map) {
  const key = text.trim();
  if (!key) { await tgSend(botToken, chatId, 'Empty key. Aborted.'); return; }
  // Validate with test request before replacing
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: map.GROQ_MODEL || 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 })
    });
    if (!res.ok) throw new Error('Key validation failed (HTTP ' + res.status + ')');
    // Replace existing key
    const now = new Date().toISOString();
    const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
    await supaRequest('POST', 'settings', { key: 'GROQ_API_KEY', value_encrypted: encrypt(key), value_plain: null, updated_at: now }, srk);
    await logActivity('telegram', 'Groq API key updated via Telegram');
    await tgSend(botToken, chatId, 'Groq API key updated and validated.');
  } catch (e) {
    await tgSend(botToken, chatId, 'Invalid Groq key. Not replaced: ' + escapeHtml(e.message || 'unknown'));
  }
}

async function handleGroqModelSubmit(chatId, text, botToken, map) {
  const model = text.trim();
  if (!model) { await tgSend(botToken, chatId, 'Empty model. Aborted.'); return; }
  const now = new Date().toISOString();
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await supaRequest('POST', 'settings', { key: 'GROQ_MODEL', value_encrypted: encrypt(model), value_plain: null, updated_at: now }, srk);
  await logActivity('telegram', 'Groq model updated via Telegram');
  await tgSend(botToken, chatId, 'Groq model updated to: ' + model);
}

async function handleScheduleSubmit(chatId, videoId, text, botToken) {
  const parsed = parseSchedulePKT(text);
  if (!parsed) {
    await tgSend(botToken, chatId, 'Invalid or past date/time. Examples: "Tomorrow at 8 PM", "15 November 2026 at 8:30 PM". Timezone: Asia/Karachi.');
    return;
  }
  const pktStr = parsed.pkt.toLocaleString('en-PK', { timeZone: 'Asia/Karachi', month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  await setUserState(chatId, { step: 'awaiting_schedule_confirm', videoId, scheduledAtUtc: parsed.utc.toISOString(), pkt: pktStr });
  await tgSend(botToken, chatId, 'Confirm scheduling for <b>' + escapeHtml(pktStr) + ' PKT</b>?\nReply <b>YES</b> to confirm, or anything else to cancel.', { parse_mode: 'HTML' });
}

async function handleScheduleConfirm(chatId, videoId, scheduledAtUtc, pkt, botToken) {
  const now = new Date().toISOString();
  await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(videoId), {
    status: 'scheduled',
    scheduled_at: scheduledAtUtc,
    updated_at: now
  }, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await supaRequest('POST', 'processing_jobs', {
    video_id: videoId,
    job_type: 'youtube_upload',
    status: 'scheduled',
    progress: 0,
    created_at: now,
    updated_at: now
  }, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await logActivity('scheduling', 'Video ' + videoId + ' scheduled for ' + scheduledAtUtc + ' UTC (' + pkt + ' PKT)');
  await tgSend(botToken, chatId, 'Video scheduled for <b>' + escapeHtml(pkt) + ' PKT</b>. It will be uploaded to YouTube and published automatically.', { parse_mode: 'HTML' });
}

// ---- scheduling text parsing (shared) ----
function parseSchedulePKT(text) {
  // Very flexible: accepts "Tomorrow at 8 PM", "15 November 2026 at 8:30 PM", etc.
  const now = new Date();
  const pktOffset = 5 * 60; // UTC+5
  const pktNow = new Date(now.getTime() + pktOffset * 60000);

  let t = text.trim().toLowerCase();
  let target = null;

  const tomorrow = t.includes('tomorrow');
  const dayMatch = t.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
  const timeMatch = t.match(/(\d{1,2})\s*:\s*(\d{2})\s*(am|pm)?/i) || t.match(/(\d{1,2})\s*(am|pm)/i);

  if (dayMatch) {
    const months = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
    const d = parseInt(dayMatch[1], 10);
    const mo = months[dayMatch[2].toLowerCase()];
    const y = parseInt(dayMatch[3], 10);
    let h = 20, mi = 0;
    if (timeMatch) { h = parseInt(timeMatch[1], 10); mi = parseInt(timeMatch[2] || 0, 10); if (timeMatch[3] && timeMatch[3].toLowerCase() === 'pm' && h < 12) h += 12; if (timeMatch[3] && timeMatch[3].toLowerCase() === 'am' && h === 12) h = 0; }
    target = new Date(Date.UTC(y, mo, d, h, mi));
  } else if (tomorrow) {
    target = new Date(pktNow.getFullYear(), pktNow.getMonth(), pktNow.getDate() + 1, 20, 0);
    const tm = t.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (tm) {
      let h = parseInt(tm[1], 10); const mi = parseInt(tm[2] || 0, 10);
      if (tm[3] && tm[3].toLowerCase() === 'pm' && h < 12) h += 12;
      if (tm[3] && tm[3].toLowerCase() === 'am' && h === 12) h = 0;
      target = new Date(pktNow.getFullYear(), pktNow.getMonth(), pktNow.getDate() + 1, h, mi);
    }
  } else {
    // Try generic date parse
    const parsed = new Date(text);
    if (!isNaN(parsed.getTime())) target = parsed;
  }

  if (!target || isNaN(target.getTime())) return null;
  // Reject past dates (compare in PKT)
  if (target.getTime() <= pktNow.getTime()) return null;
  return { pkt: target, utc: new Date(target.getTime() - pktOffset * 60000) };
}

module.exports.parseSchedulePKT = parseSchedulePKT;

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;" }[c])); }

// User state (simple in-memory would vanish across serverless invocations; use a table)
async function getUserState(chatId) {
  try {
    const rows = await supaRequest('GET', 'user_states?select=*&chat_id=eq.' + encodeURIComponent(chatId), null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    return (rows || [])[0] || null;
  } catch (e) { return null; }
}
async function setUserState(chatId, state) {
  try {
    const now = new Date().toISOString();
    await supaRequest('POST', 'user_states', { chat_id: chatId, state_json: JSON.stringify(state), updated_at: now }, process.env.SUPABASE_SERVICE_ROLE_KEY);
  } catch (e) { /* non-critical */ }
}
async function clearUserState(chatId) {
  try { await supaRequest('DELETE', 'user_states?chat_id=eq.' + encodeURIComponent(chatId), null, process.env.SUPABASE_SERVICE_ROLE_KEY); } catch (e) { /* non-critical */ }
}
async function markVideoError(videoId, errMsg) {
  const now = new Date().toISOString();
  await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(videoId), { status: 'failed', error: errMsg, updated_at: now }, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await supaRequest('POST', 'processing_jobs', { video_id: videoId, job_type: 'metadata', status: 'failed', error: errMsg, updated_at: now }, process.env.SUPABASE_SERVICE_ROLE_KEY);
}
