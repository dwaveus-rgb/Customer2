let isLoggedIn = false;

// --- Auth ---
async function checkAuth() {
  const res = await fetch('/api/auth');
  const data = await res.json();
  if (data.authenticated) {
    isLoggedIn = true;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    loadAll();
  } else {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }
}

async function doLogin() {
  const pw = document.getElementById('login-password').value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  });
  const data = await res.json();
  if (data.success) {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    isLoggedIn = true;
    loadAll();
  } else {
    document.getElementById('login-error').textContent = 'Wrong password';
  }
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  isLoggedIn = false;
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

document.getElementById('login-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

// --- Tabs ---
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// --- Theme ---
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  document.querySelector('.theme-toggle').textContent = next === 'dark' ? '☀' : '☾';
  localStorage.setItem('theme', next);
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: next })
  });
}

function loadTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  document.querySelector('.theme-toggle').textContent = saved === 'dark' ? '☀' : '☾';
}

// --- Data Loading ---
async function loadAll() {
  loadTheme();
  loadDashboard();
  loadBots();
  loadSettings();
  loadLogs();
}

async function loadDashboard() {
  const analytics = await fetch('/api/analytics').then(r => r.json());
  document.getElementById('stat-total-bots').textContent = analytics.totalBots;
  document.getElementById('stat-active-bots').textContent = analytics.activeBots;
  document.getElementById('stat-total-messages').textContent = analytics.totalMessages;

  const badge = document.getElementById('status-badge');
  if (analytics.activeBots > 0) {
    badge.textContent = 'Online';
    badge.className = 'badge badge-on';
  } else {
    badge.textContent = 'Offline';
    badge.className = 'badge badge-off';
  }

  // Messages by bot chart
  const container = document.getElementById('messages-by-bot');
  if (analytics.messagesByBot.length === 0) {
    container.innerHTML = '<div class="empty-state">No messages yet</div>';
  } else {
    const max = Math.max(...analytics.messagesByBot.map(b => b.count));
    container.innerHTML = analytics.messagesByBot.map(b => `
      <div class="bot-bar">
        <div class="bot-bar-name">${esc(b.bot_name)}</div>
        <div class="bot-bar-track">
          <div class="bot-bar-fill" style="width: ${max > 0 ? (b.count / max * 100) : 0}%"></div>
        </div>
        <div class="bot-bar-count">${b.count}</div>
      </div>
    `).join('');
  }

  const settings = await fetch('/api/settings').then(r => r.json());
  document.getElementById('current-topic').textContent = settings.topic || 'Not set';
}

async function loadBots() {
  const bots = await fetch('/api/bots').then(r => r.json());
  const container = document.getElementById('bot-list');
  if (bots.length === 0) {
    container.innerHTML = '<div class="empty-state">No bots added yet</div>';
    return;
  }
  container.innerHTML = bots.map(b => `
    <div class="bot-item">
      <div class="bot-info">
        <div class="bot-name">${esc(b.name)}</div>
        <div class="bot-tag">${b.is_running ? '🟢 ' + esc(b.tag || 'Running') : '🔴 Offline'} &middot; Token: ${esc(b.token)}</div>
        <div class="bot-personality">${esc(b.personality)} &middot; Channel: ${esc(b.channel_id)}</div>
      </div>
      <div class="bot-actions">
        ${b.is_running
          ? `<button class="btn-small-danger" onclick="stopBot(${b.id})">Stop</button>`
          : `<button class="btn-success" onclick="startBot(${b.id})">Start</button>`
        }
        <button class="btn-small-danger" onclick="deleteBot(${b.id})">Delete</button>
      </div>
    </div>
  `).join('');
}

async function loadSettings() {
  const settings = await fetch('/api/settings').then(r => r.json());
  for (const [key, value] of Object.entries(settings)) {
    const el = document.getElementById('set-' + key);
    if (el) el.value = value;
  }
}

async function loadLogs() {
  const logs = await fetch('/api/logs?limit=50').then(r => r.json());
  const container = document.getElementById('log-list');
  if (logs.length === 0) {
    container.innerHTML = '<div class="empty-state">No logs yet</div>';
    return;
  }
  container.innerHTML = logs.map(l => `
    <div class="log-item">
      <span class="log-bot">${esc(l.bot_name)}</span>
      <span>${esc(l.message)}</span>
      <div class="log-meta">${l.timestamp}</div>
    </div>
  `).join('');
}

// --- Actions ---
async function addBot() {
  const name = document.getElementById('bot-name').value.trim();
  const token = document.getElementById('bot-token').value.trim();
  const channel_id = document.getElementById('bot-channel').value.trim();
  const server_id = document.getElementById('bot-server').value.trim();
  const personality = document.getElementById('bot-personality').value;

  if (!name || !token || !channel_id || !server_id) {
    alert('Fill all fields');
    return;
  }

  const res = await fetch('/api/bots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, token, channel_id, server_id, personality })
  });
  const data = await res.json();
  if (data.success) {
    document.getElementById('bot-name').value = '';
    document.getElementById('bot-token').value = '';
    document.getElementById('bot-channel').value = '';
    document.getElementById('bot-server').value = '';
    loadBots();
    loadDashboard();
  } else {
    alert(data.error || 'Failed to add bot');
  }
}

async function deleteBot(id) {
  if (!confirm('Delete this bot?')) return;
  await fetch('/api/bots/' + id, { method: 'DELETE' });
  loadBots();
  loadDashboard();
}

async function startBot(id) {
  await fetch('/api/bots/' + id + '/start', { method: 'POST' });
  setTimeout(() => { loadBots(); loadDashboard(); }, 2000);
}

async function stopBot(id) {
  await fetch('/api/bots/' + id + '/stop', { method: 'POST' });
  loadBots();
  loadDashboard();
}

async function startAllBots() {
  await fetch('/api/bots/start-all', { method: 'POST' });
  setTimeout(() => { loadBots(); loadDashboard(); }, 3000);
}

async function stopAllBots() {
  await fetch('/api/bots/stop-all', { method: 'POST' });
  setTimeout(() => { loadBots(); loadDashboard(); }, 1000);
}

function refreshDashboard() {
  loadDashboard();
  loadBots();
}

async function updateTopic() {
  const topic = document.getElementById('new-topic').value.trim();
  if (!topic) return;
  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic })
  });
  document.getElementById('current-topic').textContent = topic;
  document.getElementById('new-topic').value = '';
}

async function saveSettings() {
  const fields = [
    'ai_api_key', 'topic', 'min_delay', 'max_delay',
    'typing_min', 'typing_max', 'max_length', 'topic_change_interval', 'admin_password'
  ];
  const payload = {};
  for (const f of fields) {
    const el = document.getElementById('set-' + f);
    if (el && el.value) payload[f] = el.value;
  }
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.success) {
    alert('Settings saved!');
  }
}

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Auto refresh
setInterval(() => {
  if (isLoggedIn) {
    loadDashboard();
  }
}, 10000);

checkAuth();
