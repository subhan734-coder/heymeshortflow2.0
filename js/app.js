/* ========== YouTube Shorts Automation - Frontend (Vanilla JS) ========== */

const API = '/api';
const STORAGE_KEY = 'yt_short_session';

const app = {
  token: null,
  settings: {},
  videos: [],
  currentView: 'overview',

  init() {
    this.bindLogin();
    this.bindApp();
    this.restoreSession();
  },

  /* ---------- Auth ---------- */
  bindLogin() {
    const form = document.getElementById('login-form');
    const msg = document.getElementById('login-msg');
    const attempts = document.getElementById('login-attempts');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = document.getElementById('access-key').value.trim();
      if (!key) return;
      this.setBtnBusy(document.getElementById('login-btn'), true);
      try {
        const res = await this.request('POST', '/auth/verify', { accessKey: key });
        if (res.ok && res.data.authenticated) {
          this.token = res.data.token;
          this.saveSession(this.token);
          document.getElementById('login-screen').hidden = true;
          document.getElementById('app').hidden = false;
          this.loadDashboard();
          this.startHealthPoll();
        } else {
          this.show(msg, 'error', res.data.error || 'Invalid access key');
          this.recordAttempt(attempts, false);
        }
      } catch (err) {
        this.show(msg, 'error', err.message || 'Request failed');
        this.recordAttempt(attempts, false);
      } finally {
        this.setBtnBusy(document.getElementById('login-btn'), false);
      }
    });
  },
  recordAttempt(el, ok) {
    el.textContent = ok ? 'Access granted.' : 'Invalid access key.';
    el.style.color = ok ? '#86efac' : '#fca5a5';
  },
  setBtnBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? 'Verifying&hellip;' : btn.dataset.original || btn.textContent;
    if (!busy && !btn.dataset.original) btn.dataset.original = btn.textContent;
  },
  restoreSession() {
    const t = localStorage.getItem(STORAGE_KEY);
    if (t) {
      this.token = t;
      document.getElementById('login-screen').hidden = true;
      document.getElementById('app').hidden = false;
      this.loadDashboard();
      this.startHealthPoll();
    }
  },
  saveSession(t) { localStorage.setItem(STORAGE_KEY, t); },
  clearSession() { localStorage.removeItem(STORAGE_KEY); this.token = null; },

  /* ---------- App shell ---------- */
  bindApp() {
    document.getElementById('logout-btn').addEventListener('click', () => this.logout());
    document.getElementById('nav-toggle').addEventListener('click', () => {
      const s = document.getElementById('sidebar');
      s.classList.toggle('open');
    });
    document.getElementById('open-settings').addEventListener('click', () => this.openSettings());
    document.getElementById('btn-refresh').addEventListener('click', () => this.loadDashboard());
    document.getElementById('btn-new-upload').addEventListener('click', () => this.openModal('modal-upload'));

    // Sidebar nav
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const view = item.getAttribute('data-view');
        this.switchView(view);
        document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
        item.classList.add('active');
        const s = document.getElementById('sidebar');
        s.classList.remove('open');
      });
    });

    // Settings form
    const sf = document.getElementById('settings-form');
    sf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('settings-msg');
      const fd = new FormData(sf);
      const data = {};
      for (const [k, v] of fd) data[k] = v;
      try {
        const res = await this.request('POST', '/settings', data);
        if (res.ok) {
          this.show(msg, 'success', 'Configuration saved.');
          this.settings = await (await this.request('GET', '/settings')).data || {};
          this.renderSettingsMasked();
        } else {
          this.show(msg, 'error', res.data.error || 'Save failed');
        }
      } catch (err) {
        this.show(msg, 'error', err.message || 'Save failed');
      }
    });

    document.getElementById('btn-disconnect-all').addEventListener('click', async () => {
      if (!confirm('Disconnect all integrations? This clears YouTube, Telegram webhook and stored credentials.')) return;
      try {
        await this.request('POST', '/settings/disconnect');
        this.show(document.getElementById('settings-msg'), 'success', 'Integrations disconnected.');
        this.settings = {};
        this.renderSettingsMasked();
      } catch (err) {
        this.show(document.getElementById('settings-msg'), 'error', err.message || 'Disconnect failed');
      }
    });

    // Upload modal
    document.getElementById('btn-do-upload').addEventListener('click', () => this.doDirectUpload());
  },
  async logout() {
    try { await this.request('POST', '/auth/logout'); } catch (e) {}
    this.clearSession();
    location.reload();
  },
  openSettings() {
    this.switchView('api-settings');
    document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
    this.fetchSettings();
  },
  async fetchSettings() {
    try {
      const res = await this.request('GET', '/settings');
      this.settings = res.data || {};
      this.renderSettingsMasked();
    } catch (e) {
      console.error('fetchSettings', e);
    }
  },
  renderSettingsMasked() {
    const mask = (v) => (v ? '\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf' : '');
    const map = {
      SUPABASE_URL: this.settings.SUPABASE_URL || '',
      SUPABASE_ANON_KEY: this.settings.SUPABASE_ANON_KEY ? mask(this.settings.SUPABASE_ANON_KEY) : '',
      SUPABASE_SERVICE_ROLE_KEY: this.settings.SUPABASE_SERVICE_ROLE_KEY ? mask(this.settings.SUPABASE_SERVICE_ROLE_KEY) : '',
      TELEGRAM_BOT_TOKEN: this.settings.TELEGRAM_BOT_TOKEN ? mask(this.settings.TELEGRAM_BOT_TOKEN) : '',
      TELEGRAM_BOT_ID: this.settings.TELEGRAM_BOT_ID || '',
      TELEGRAM_CHAT_ID: this.settings.TELEGRAM_CHAT_ID || '',
      TELEGRAM_WEBHOOK_SECRET: this.settings.TELEGRAM_WEBHOOK_SECRET ? mask(this.settings.TELEGRAM_WEBHOOK_SECRET) : '',
      GROQ_API_KEY: this.settings.GROQ_API_KEY ? mask(this.settings.GROQ_API_KEY) : '',
      GROQ_MODEL: this.settings.GROQ_MODEL || '',
      GOOGLE_CLIENT_ID: this.settings.GOOGLE_CLIENT_ID || '',
      GOOGLE_CLIENT_SECRET: this.settings.GOOGLE_CLIENT_SECRET ? mask(this.settings.GOOGLE_CLIENT_SECRET) : '',
      GOOGLE_REDIRECT_URI: this.settings.GOOGLE_REDIRECT_URI || '',
      OWNER_ACCESS_KEY: this.settings.OWNER_ACCESS_KEY ? mask(this.settings.OWNER_ACCESS_KEY) : '',
    };
    for (const [k, v] of Object.entries(map)) {
      const el = document.querySelector(`[name="${k}"]`);
      if (el && (!el.value || el.type === 'password')) el.value = v;
    }
  },

  /* ---------- Navigation ---------- */
  switchView(view) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    const target = document.getElementById(`view-${view}`);
    if (target) target.classList.remove('hidden');
    document.getElementById('page-title').textContent = view.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    document.getElementById('btn-new-upload').style.display = (view === 'all-videos' || view === 'overview') ? 'inline-flex' : 'none';
    this.currentView = view;
    this.loadViewData(view);
  },
  async loadViewData(view) {
    try {
      switch (view) {
        case 'overview': await this.loadOverview(); break;
        case 'all-videos': await this.loadVideos('all'); break;
        case 'scheduled': await this.loadVideos('scheduled'); break;
        case 'published': await this.loadVideos('published'); break;
        case 'processing': await this.loadVideos('processing'); break;
        case 'failed': await this.loadVideos('failed'); break;
        case 'telegram': await this.loadTelegram(); break;
        case 'youtube': await this.loadYouTube(); break;
        case 'groq-ai': await this.loadGroq(); break;
        case 'supabase': await this.loadSupabase(); break;
        case 'activity-logs': await this.loadLogs(); break;
        case 'system-health': await this.loadHealth(); break;
      }
    } catch (e) { console.error('loadViewData', view, e); }
  },

  /* ---------- API request ---------- */
  async request(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (this.token) opts.headers['Authorization'] = 'Bearer ' + this.token;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API + path, opts);
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status; err.data = data; throw err;
    }
    return { ok: true, status: res.status, data };
  },
  show(el, type, text) {
    el.textContent = text;
    el.className = 'msg ' + type;
    el.style.display = 'block';
  },

  /* ---------- Dashboard / stats ---------- */
  async loadDashboard() {
    await this.loadOverview();
    await this.loadVideos('all');
    await this.loadHealth();
    await this.loadYouTube();
    await this.loadTelegram();
  },
  async loadOverview() {
    const res = await this.request('GET', '/videos?limit=1000');
    const videos = res.data.videos || [];
    this.videos = videos;
    const total = videos.length;
    const scheduled = videos.filter(v => v.status === 'scheduled').length;
    const published = videos.filter(v => v.status === 'published').length;
    const processing = videos.filter(v => v.status === 'processing').length;
    const failed = videos.filter(v => v.status === 'failed').length;
    const pending = videos.filter(v => v.status === 'pending').length;

    const grid = document.getElementById('stat-grid');
    grid.innerHTML = `
      <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Total Videos</div></div>
      <div class="stat-card"><div class="stat-value" style="color:#38bdf8">${scheduled}</div><div class="stat-label">Scheduled</div></div>
      <div class="stat-card"><div class="stat-value" style="color:#22c55e">${published}</div><div class="stat-label">Published</div></div>
      <div class="stat-card"><div class="stat-value" style="color:#38bdf8">${processing}</div><div class="stat-label">Processing</div></div>
      <div class="stat-card"><div class="stat-value" style="color:#ef4444">${failed}</div><div class="stat-label">Failed</div></div>
      <div class="stat-card"><div class="stat-value" style="color:#f59e0b">${pending}</div><div class="stat-label">Pending Jobs</div></div>
    `;

    const next = videos
      .filter(v => v.status === 'scheduled' && v.scheduled_at)
      .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
    const nextEl = document.createElement('div');
    nextEl.className = 'panel next-scheduled';
    nextEl.innerHTML = `
      <div class="panel-head"><h2>Next Scheduled Video</h2></div>
      <div class="panel-body">
        ${next ? `<div style="font-size:1.1rem;color:#fff">${this.esc(next.filename || 'video')}</div>
        <div class="muted" style="margin-top:.3rem">${this.fmtTime(next.scheduled_at)} PKT</div>
        <div class="muted" style="margin-top:.2rem">${next.youtube_url ? '<a href="'+this.esc(next.youtube_url)+'" target="_blank">YouTube</a>' : 'Not yet uploaded'}</div>` : '<p class="muted">No scheduled videos.</p>'}
      </div>`;
    // remove any previous, then insert after stat grid
    document.querySelectorAll('.next-scheduled').forEach(n => n.remove());
    grid.parentNode.insertBefore(nextEl, grid.nextSibling);

    const body = document.getElementById('overview-body');
    body.innerHTML = `
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h3>Recent Videos</h3></div>
          <div class="panel-body">
            <div class="table-wrap"><table class="data-table">
              <thead><tr><th>Filename</th><th>Status</th><th>Updated</th></tr></thead>
              <tbody id="recent-body"></tbody>
            </table></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>System Status</h3></div>
          <div class="panel-body" id="overview-status">
            <p class="muted">Checking&hellip;</p>
          </div>
        </div>
      </div>`;
    const rbody = document.getElementById('recent-body');
    videos.slice(0, 8).reverse().forEach(v => {
      rbody.appendChild(this.rowVideo(v));
    });
  },
  rowVideo(v) {
    const tr = document.createElement('tr');
    const statusClass = 'status-' + (v.status || 'unknown');
    tr.innerHTML = `
      <td>${this.esc(v.filename || 'video')}</td>
      <td><span class="status-pill ${statusClass}">${this.esc(v.status || 'unknown')}</span></td>
      <td>${this.fmtTime(v.updated_at || v.created_at)}</td>`;
    return tr;
  },

  async loadVideos(filter) {
    const res = await this.request('GET', '/videos?limit=500');
    let videos = res.data.videos || [];
    if (filter !== 'all') videos = videos.filter(v => v.status === filter);
    this.videos = videos;

    let bodyId, wrapId;
    switch (filter) {
      case 'scheduled': bodyId = 'scheduled-body'; wrapId = 'scheduled-wrap'; break;
      case 'published': bodyId = 'published-body'; wrapId = 'published-wrap'; break;
      case 'processing': bodyId = 'processing-body'; wrapId = 'processing-wrap'; break;
      case 'failed': bodyId = 'failed-body'; wrapId = 'failed-wrap'; break;
      default: bodyId = 'all-videos-body'; wrapId = 'all-videos-wrap'; break;
    }
    const body = document.getElementById(bodyId);
    body.innerHTML = '';
    if (videos.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="empty">No videos.</td></tr>';
    } else {
      videos.forEach(v => body.appendChild(this.rowVideoFull(v, filter)));
    }
  },
  rowVideoFull(v, filter) {
    const tr = document.createElement('tr');
    const statusClass = 'status-' + (v.status || 'unknown');
    let actions = '';
    if (v.youtube_url) actions += `<a href="${this.esc(v.youtube_url)}" target="_blank" class="btn-action">YouTube</a>`;
    if (filter === 'failed') actions += `<button class="btn-action" onclick="app.retryVideo('${this.escAttr(v.id)}')">Retry</button>`;
    return tr;
  },

  async retryVideo(id) {
    try {
      await this.request('POST', '/video-retry', { id });
      this.show(document.getElementById('settings-msg') || document.createElement('div'), 'success', 'Retry queued.');
      this.loadVideos('failed');
    } catch (e) { alert(e.message || 'Retry failed'); }
  },

  /* ---------- Integrations ---------- */
  async loadTelegram() {
    try {
      const res = await this.request('GET', '/telegram/status');
      const s = res.data || {};
      document.getElementById('tg-status').innerHTML = `
        <div style="font-size:1.1rem;color:#fff">${s.configured ? 'Configured' : 'Not configured'}</div>
        <div class="muted" style="margin-top:.3rem">Webhook: ${s.webhook ? 'active' : 'inactive'}</div>
        <div class="muted" style="margin-top:.2rem">Chat ID verified: ${s.chatVerified ? 'yes' : 'no'}</div>`;
      this.setDot('dot-telegram', s.configured);
      document.getElementById('txt-telegram').textContent = s.configured ? 'online' : 'offline';
    } catch (e) {
      document.getElementById('tg-status').textContent = 'Error loading status';
    }
  },
  async loadYouTube() {
    try {
      const res = await this.request('GET', '/youtube/status');
      const s = res.data || {};
      const body = document.getElementById('youtube-body');
      if (s.connected && s.tokenValid) {
        body.innerHTML = `
          <div style="font-size:1.1rem;color:#22c55e">&#10004; YouTube Connected</div>
          <div class="muted" style="margin-top:.3rem">Channel: ${this.esc(s.channel ? (s.channel.title || s.channel.id) : '&mdash;')}</div>
          <div class="muted" style="margin-top:.2rem">Channel ID: ${this.esc(s.channel ? s.channel.id : '&mdash;')}</div>
          <div class="muted" style="margin-top:.4rem">Access token: valid</div>
          <div style="margin-top:1rem">
            <button class="btn btn-danger" onclick="app.disconnectYouTube()">Disconnect Channel</button>
          </div>`;
      } else {
        body.innerHTML = `
          <div style="font-size:1.1rem;color:#ef4444">&#10006; YouTube Not Connected</div>
          <div class="muted" style="margin-top:.3rem">Connect your channel to upload and schedule videos.</div>
          <div style="margin-top:1rem">
            <button class="btn btn-primary" onclick="app.connectYouTube()">Connect YouTube Channel</button>
          </div>`;
      }
      this.setDot('dot-youtube', s.connected && s.tokenValid);
      document.getElementById('txt-youtube').textContent = (s.connected && s.tokenValid) ? 'online' : 'offline';
    } catch (e) {
      document.getElementById('youtube-body').textContent = 'Error loading YouTube status';
    }
  },
  async loadGroq() {
    try {
      const res = await this.request('GET', '/groq/status');
      const s = res.data || {};
      const body = document.getElementById('groq-body');
      body.innerHTML = `
        <div style="font-size:1.1rem;color:#fff">${s.configured ? 'Configured' : 'Not configured'}</div>
        <div class="muted" style="margin-top:.3rem">Model: ${this.esc(s.model || '&mdash;')}</div>
        <div class="muted" style="margin-top:.2rem">Last test: ${s.lastTest || '&mdash;'}</div>`;
    } catch (e) {
      document.getElementById('groq-body').textContent = 'Error loading Groq status';
    }
  },
  async loadSupabase() {
    try {
      const res = await this.request('GET', '/supabase/status');
      const s = res.data || {};
      const body = document.getElementById('supabase-body');
      body.innerHTML = `
        <div style="font-size:1.1rem;color:#fff">${s.configured ? 'Configured' : 'Not configured'}</div>
        <div class="muted" style="margin-top:.3rem">Storage buckets: ${s.buckets || '&mdash;'}</div>
        <div class="muted" style="margin-top:.2rem">Database: ${s.database ? 'reachable' : 'unreachable'}</div>`;
    } catch (e) {
      document.getElementById('supabase-body').textContent = 'Error loading Supabase status';
    }
  },
  async loadLogs() {
    try {
      const res = await this.request('GET', '/logs?limit=100');
      const logs = res.data.logs || [];
      const body = document.getElementById('logs-body');
      body.innerHTML = '';
      logs.forEach(l => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${this.fmtTime(l.created_at)}</td><td>${this.esc(l.level)}</td><td>${this.esc(l.component)}</td><td>${this.esc(l.message)}</td>`;
        body.appendChild(tr);
      });
    } catch (e) {
      document.getElementById('logs-body').innerHTML = '<tr><td colspan="4" class="empty">Unable to load logs.</td></tr>';
    }
  },
  async loadHealth() {
    try {
      const res = await this.request('GET', '/health');
      const s = res.data || {};
      const body = document.getElementById('health-body');
      body.innerHTML = `
        <div style="font-size:1.1rem;color:#fff">${s.status || 'unknown'}</div>
        <div class="muted" style="margin-top:.3rem">Database: ${s.database || '&mdash;'}</div>
        <div class="muted" style="margin-top:.2rem">Storage: ${s.storage || '&mdash;'}</div>
        <div class="muted" style="margin-top:.2rem">Automation: ${s.automation || '&mdash;'}</div>
        <div class="muted" style="margin-top:.2rem">Last cron: ${s.lastCron || '&mdash;'}</div>`;
      this.setDot('dot-automation', s.automation === 'online' || s.automation === 'healthy');
      document.getElementById('txt-automation').textContent = (s.automation === 'online' || s.automation === 'healthy') ? 'online' : 'offline';

      const os = document.getElementById('overview-status');
      if (os) os.innerHTML = `
        <div class="muted" style="margin-top:.2rem">DB: ${s.database || '&mdash;'}</div>
        <div class="muted" style="margin-top:.2rem">Storage: ${s.storage || '&mdash;'}</div>
        <div class="muted" style="margin-top:.2rem">Automation: ${s.automation || '&mdash;'}</div>`;
    } catch (e) {
      document.getElementById('health-body').textContent = 'Error loading health';
    }
  },

  /* ---------- Test connections ---------- */
  async testConnection(comp) {
    try {
      const res = await this.request('POST', '/settings/test', { component: comp });
      alert(res.data.message || (`${comp} connection OK`));
    } catch (e) {
      alert(e.message || (`${comp} test failed`));
    }
  },

  /* ---------- Direct upload ---------- */
  async doDirectUpload() {
    const input = document.getElementById('upload-file');
    const file = input.files[0];
    if (!file) { alert('Select a video file'); return; }
    const prog = document.getElementById('upload-progress');
    const bar = document.getElementById('progress-bar');
    const msg = document.getElementById('upload-msg');
    prog.hidden = false; bar.style.width = '0%'; msg.textContent = '';
    try {
      // request signed upload url
      const res = await this.request('POST', '/upload/sign', { filename: file.name, contentType: file.type });
      const { uploadUrl, videoPath } = res.data;
      // upload directly to storage via PUT
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl, true);
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { bar.style.width = Math.round(e.loaded / e.total * 100) + '%'; } };
      xhr.onload = async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          // create video record
          await this.request('POST', '/videos', { filename: file.name, storagePath: videoPath, size: file.size });
          msg.textContent = 'Uploaded and recorded.';
          this.show(msg, 'success', 'Upload complete.');
          this.closeModal('modal-upload');
          this.loadVideos('all');
          this.loadOverview();
        } else {
          throw new Error('Upload failed: ' + xhr.status);
        }
      };
      xhr.onerror = () => { throw new Error('Network error during upload'); };
      xhr.send(file);
    } catch (e) {
      this.show(msg, 'error', e.message || 'Upload failed');
    }
  },

  /* ---------- Modals ---------- */
  openModal(id) { document.getElementById(id).hidden = false; document.getElementById('modal-backdrop').hidden = false; },
  closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
    document.getElementById('modal-backdrop').hidden = true;
    // reset upload
    if (id === 'modal-upload') {
      document.getElementById('upload-file').value = '';
      document.getElementById('upload-progress').hidden = true;
      document.getElementById('upload-msg').textContent = '';
    }
  },

  /* ---------- Health poll ---------- */
  startHealthPoll() {
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._healthTimer = setInterval(() => this.loadHealth(), 30000);
  },

  /* ---------- Utils ---------- */
  esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  escAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); },
  fmtTime(iso) {
    if (!iso) return '&mdash;';
    try { return new Date(iso).toLocaleString('en-PK', { timeZone: 'Asia/Karachi', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  },
  setDot(id, online) {
    const d = document.getElementById(id);
    if (d) { d.className = 'dot ' + (online ? 'online' : 'offline'); }
  },
  async connectYouTube() {
    try {
      const res = await this.request('GET', '/youtube-auth');
      // youtube-auth redirects; open in same tab
      // Instead, fetch the auth URL by calling a lightweight endpoint. Here we just open the auth flow.
      window.location.href = '/api/youtube-auth';
    } catch (e) { alert(e.message || 'Failed to start YouTube connection'); }
  },
  async disconnectYouTube() {
    if (!confirm('Disconnect YouTube channel?')) return;
    try {
      await this.request('POST', '/youtube-disconnect');
      this.loadYouTube();
    } catch (e) { alert(e.message || 'Disconnect failed'); }
  },
  handleHash() {
    const h = location.hash;
    if (h.includes('youtube-connected')) {
      location.hash = '';
      this.loadYouTube();
    } else if (h.includes('youtube-error')) {
      location.hash = '';
      const err = h.split('=')[1] || 'unknown';
      this.show(document.getElementById('youtube-body') || document.createElement('div'), 'error', 'YouTube connection failed: ' + err);
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  app.init();
  window.addEventListener('hashchange', () => app.handleHash());
  app.handleHash();
});
