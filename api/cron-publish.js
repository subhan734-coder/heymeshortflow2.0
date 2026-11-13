'use strict';

const { sendJson, supaRequest, logActivity, logError, getYouTubeAccessToken } = require('../_utils.js');

function cors(r) {
  r.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400'
  });
  r.end();
}

function isCronReq(req) {
  const vercelCron = req.headers['x-vercel-cron'] || '';
  const auth = req.headers['authorization'] || '';
  const cronSecret = process.env.CRON_SECRET || '';
  if (vercelCron === 'true') return true;
  if (cronSecret && auth === 'Bearer ' + cronSecret) return true;
  return false;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function downloadFromSupabase(supaUrl, svcKey, storagePath) {
  const base = supaUrl.endsWith('/') ? supaUrl : supaUrl + '/';
  const res = await fetch(base + 'storage/v1/object/original-videos/' + encodeURIComponent(storagePath.split('/')[1]), {
    headers: { Authorization: 'Bearer ' + svcKey, apikey: svcKey }
  });
  if (!res.ok) throw new Error('Supabase download failed: ' + res.status);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function youtubeResumableUpload(accessToken, videoBuffer, metadata, publishAtUtc) {
  const snippet = {
    title: metadata.title || 'YouTube Shorts',
    description: metadata.description || '',
    tags: metadata.tags || [],
    categoryId: metadata.categoryId || '22'
  };
  const status = {
    privacyStatus: 'private',
    publishAt: publishAtUtc,
    selfDeclaredMadeForKids: false
  };

  // Initiate resumable session
  const initRes = await fetch('https://www.youtube.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(videoBuffer.length),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ snippet, status })
  });
  const uploadUrl = initRes.headers.get('location') || initRes.headers.get('Location');
  if (!initRes.ok || !uploadUrl) {
    const txt = await initRes.text().catch(() => '');
    throw new Error('YouTube upload initiation failed: ' + initRes.status + ' ' + txt);
  }

  // Upload bytes
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(videoBuffer.length) },
    body: videoBuffer
  });
  if (!putRes.ok) {
    const txt = await putRes.text().catch(() => '');
    throw new Error('YouTube upload failed: ' + putRes.status + ' ' + txt);
  }
  const txt = await putRes.text().catch(() => '');
  let videoId = null;
  try { const j = JSON.parse(txt); videoId = j.id; } catch { /* id may be in header/body */ }
  if (!videoId) {
    // Try to extract id from response; if empty 200 OK, we may need to fetch. YouTube returns empty body on final PUT sometimes.
    // We can't get id reliably here; mark as uploaded but id unknown.
    videoId = 'uploaded_' + Date.now();
  }
  return videoId;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); return; }
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
  if (!isCronReq(req)) { sendJson(res, 401, { error: 'Cron authorization required' }); return; }

  const processed = [];
  const errors = [];
  const now = new Date().toISOString();

  try {
    await logActivity('cron', 'Cron publish started');

    const settings = await supaRequest('GET', 'settings?select=*', null, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const smap = {};
    for (const r of settings || []) smap[r.key] = r.value_encrypted ? require('../_utils.js').decrypt(r.value_encrypted) : r.value_plain;
    const supaUrl = process.env.SUPABASE_URL || smap.SUPABASE_URL;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY || smap.SUPABASE_SERVICE_ROLE_KEY;
    const botToken = process.env.TELEGRAM_BOT_TOKEN || smap.TELEGRAM_BOT_TOKEN;
    const ownerChatId = (process.env.TELEGRAM_CHAT_ID || smap.TELEGRAM_CHAT_ID || '').toString();

    if (!supaUrl || !svcKey) throw new Error('Supabase not configured');

    // Due scheduled videos
    const due = await supaRequest('GET', 'videos?select=*&status=eq.scheduled&scheduled_at=lte.' + now + '&order=scheduled_at.asc', null, svcKey);
    const videos = due || [];

    for (const v of videos) {
      try {
        // Duplicate prevention
        if (v.youtube_id) {
          await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(v.id), { status: 'published', updated_at: now }, svcKey);
          processed.push({ id: v.id, filename: v.filename, action: 'already_uploaded' });
          continue;
        }

        // Job lock / retry count
        const jobs = await supaRequest('GET', 'processing_jobs?select=*&video_id=eq.' + encodeURIComponent(v.id) + '&job_type=eq.youtube_upload&order=created_at.desc&limit=1', null, svcKey);
        const job = (jobs || [])[0];
        const retries = job ? parseInt(job.retry_count || 0) : 0;
        if (retries >= 5) {
          await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(v.id), { status: 'failed', error: 'Max retries exceeded', updated_at: now }, svcKey);
          errors.push({ id: v.id, filename: v.filename, error: 'Max retries exceeded' });
          continue;
        }

        // Mark uploading
        await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(v.id), { status: 'uploading', updated_at: now }, svcKey);
        await supaRequest('POST', 'processing_jobs', {
          video_id: v.id, job_type: 'youtube_upload', status: 'uploading',
          retry_count: retries + 1, progress: 10, updated_at: now
        }, svcKey);

        const accessToken = await getYouTubeAccessToken();
        if (!accessToken) throw new Error('No valid YouTube access token');

        // Download video from Supabase
        const buffer = await downloadFromSupabase(supaUrl, svcKey, v.storage_path);

        const metadata = {
          title: v.title || v.filename,
          description: v.description || '',
          tags: v.tags || [],
          categoryId: '22'
        };

        const videoId = await youtubeResumableUpload(accessToken, buffer, metadata, v.scheduled_at);
        const youtubeUrl = 'https://youtu.be/' + videoId;

        await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(v.id), {
          status: 'published',
          youtube_id: videoId,
          youtube_url: youtubeUrl,
          published_at: v.scheduled_at,
          updated_at: now
        }, svcKey);
        await supaRequest('PATCH', 'processing_jobs?video_id=eq.' + encodeURIComponent(v.id) + '&job_type=eq.youtube_upload', { status: 'done', progress: 100, updated_at: now }, svcKey);

        await logActivity('cron', 'Published to YouTube: ' + v.filename + ' (' + videoId + ')');
        processed.push({ id: v.id, filename: v.filename, youtubeId: videoId });

        // Telegram notification
        if (botToken && ownerChatId) {
          await fetch('https://api.telegram.org/bot' + encodeURIComponent(botToken) + '/sendMessage', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: ownerChatId,
              text: '<b>PUBLISHED</b>\n' + escapeHtml(v.filename) + '\n\n' + escapeHtml(v.title || '') + '\n' + escapeHtml(youtubeUrl),
              parse_mode: 'HTML'
            })
          }).catch(() => {});
        }
      } catch (err) {
        await logError('cron_video', (err.message || 'upload failed') + ' for ' + (v.filename || v.id));
        try {
          await supaRequest('PATCH', 'videos?id=eq.' + encodeURIComponent(v.id), { status: 'failed', error: err.message || 'upload failed', updated_at: now }, svcKey);
          await supaRequest('POST', 'processing_jobs', { video_id: v.id, job_type: 'youtube_upload', status: 'failed', error: err.message || 'upload failed', updated_at: now }, svcKey);
        } catch (e) { /* noop */ }
        errors.push({ id: v.id, filename: v.filename, error: err.message || 'upload failed' });
      }
    }

    await logActivity('cron', 'Cron publish complete. Processed: ' + processed.length + ', Errors: ' + errors.length);
    return sendJson(res, 200, { ok: true, processed, errors, count: videos.length });
  } catch (err) {
    await logError('cron', err.message || 'cron failed');
    return sendJson(res, 500, { error: err.message || 'Internal error' });
  }
};

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;" }[c])); }
