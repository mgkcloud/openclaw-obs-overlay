#!/usr/bin/env node
/**
 * OpenClaw OBS Overlay Server v2
 * 
 * Real-time agent activity feed + live trading dashboard.
 * Tails OpenClaw session JSONL files and polls fund_truth.json from Hermes.
 * 
 * Layout: Dashboard (top-left), Activity log (bottom-right), status edges.
 * 
 * Usage:
 *   node server.js [--port 3456]
 *   OBS > Sources > Browser > URL: http://localhost:3456
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { execSync, exec: execCb } = require('child_process');

// --- Config ---
const PORT = parseInt(process.env.PORT || '3456');
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(process.env.HOME, '.openclaw', 'agents');
const MAX_EVENTS = 200;
const DASHBOARD_INTERVAL = 60000; // poll fund_truth every 60s

// --- Event Bus ---
const bus = new EventEmitter();
bus.setMaxListeners(50);
const recentEvents = [];

// --- Dashboard State ---
let dashboardData = null;
let dashboardLastUpdate = 0;

function refreshDashboard() {
  execCb('ssh hermes "cat /home/ubuntu/trading/fund_truth.json" 2>/dev/null', { timeout: 15000 }, (err, stdout) => {
    if (err || !stdout) return;
    try {
      dashboardData = JSON.parse(stdout);
      dashboardLastUpdate = Date.now();
      bus.emit('dashboard', dashboardData);
    } catch {}
  });
}

// Initial + periodic dashboard refresh
refreshDashboard();
setInterval(refreshDashboard, DASHBOARD_INTERVAL);

// --- Channel Inference ---
function inferChannel(filePath) {
  const parts = filePath.split(path.sep);
  const agentIdx = parts.indexOf('agents');
  const agentName = agentIdx >= 0 ? parts[agentIdx + 1] : 'unknown';
  const filename = path.basename(filePath, '.jsonl');
  const topicMatch = filename.match(/topic-(\d+)/);
  if (topicMatch) return `${agentName}/t${topicMatch[1]}`;
  return `${agentName}/${filename.slice(0, 6)}`;
}

// --- JSONL Parser ---
function parseMessage(line, channel) {
  try {
    const entry = JSON.parse(line);
    if (entry.type !== 'message') return null;
    const msg = entry.message;
    if (!msg) return null;

    const role = msg.role;
    const timestamp = entry.timestamp || new Date().toISOString();

    let text = '';
    let hasToolCall = false;
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          text += block.text;
        } else if (block.type === 'toolCall') {
          hasToolCall = true;
          text += `⚡ ${block.name}(...)`;
        }
      }
    }

    if (!text) return null;
    text = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;

    // Determine display priority
    const isPrimary = (role === 'user' || role === 'assistant') && !hasToolCall;
    const maxLen = isPrimary ? 300 : 120;
    if (text.length > maxLen) text = text.slice(0, maxLen - 3) + '...';

    const roleIcon = { user: '👤', assistant: '🤖', toolCall: '⚡', toolResult: '📦', system: '⚙️' }[role] || '💬';
    const roleClass = { user: 'user', assistant: 'assistant', toolCall: 'tool', toolResult: 'tool-result', system: 'system' }[role] || 'other';

    return {
      id: entry.id || Math.random().toString(36).slice(2),
      channel,
      role: roleClass,
      roleIcon,
      text,
      timestamp,
      ts: Date.now(),
      primary: isPrimary,
    };
  } catch {
    return null;
  }
}

// --- File Watcher ---
const fileOffsets = new Map();
const watchers = new Map();

function tailFile(filePath) {
  const channel = inferChannel(filePath);
  try {
    const stat = fs.statSync(filePath);
    fileOffsets.set(filePath, stat.size);
  } catch {
    fileOffsets.set(filePath, 0);
  }

  const watcher = fs.watch(filePath, (eventType) => {
    if (eventType !== 'change') return;
    const offset = fileOffsets.get(filePath) || 0;
    let stat;
    try { stat = fs.statSync(filePath); } catch { return; }
    if (stat.size <= offset) return;

    const stream = fs.createReadStream(filePath, { start: offset, encoding: 'utf8' });
    let buffer = '';
    stream.on('data', (chunk) => { buffer += chunk; });
    stream.on('end', () => {
      fileOffsets.set(filePath, stat.size);
      const lines = buffer.split('\n').filter(Boolean);
      for (const line of lines) {
        const evt = parseMessage(line, channel);
        if (evt) {
          recentEvents.push(evt);
          if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
          bus.emit('event', evt);
        }
      }
    });
  });

  watchers.set(filePath, watcher);
  console.log(`👁️  Watching: ${channel}`);
}

function scanSessions() {
  try {
    const agents = fs.readdirSync(SESSIONS_DIR);
    for (const agent of agents) {
      const sessDir = path.join(SESSIONS_DIR, agent, 'sessions');
      if (!fs.existsSync(sessDir)) continue;
      const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(sessDir, file);
        if (!watchers.has(filePath)) {
          try {
            const stat = fs.statSync(filePath);
            if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) tailFile(filePath);
          } catch {}
        }
      }
    }
  } catch (err) {
    console.error('Scan error:', err.message);
  }
}

scanSessions();
setInterval(scanSessions, 30000);

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send dashboard first
    if (dashboardData) {
      res.write(`event: dashboard\ndata: ${JSON.stringify(dashboardData)}\n\n`);
    }

    // Send recent log events
    for (const evt of recentEvents.slice(-20)) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }

    const handler = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
    const dashHandler = (d) => res.write(`event: dashboard\ndata: ${JSON.stringify(d)}\n\n`);
    bus.on('event', handler);
    bus.on('dashboard', dashHandler);

    req.on('close', () => {
      bus.off('event', handler);
      bus.off('dashboard', dashHandler);
    });

    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => clearInterval(ka));
    return;
  }

  if (url.pathname === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(dashboardData || {}));
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, watching: watchers.size, buffered: recentEvents.length, dashboardAge: dashboardLastUpdate ? Date.now() - dashboardLastUpdate : null }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
  res.end(OVERLAY_HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎬 OpenClaw OBS Overlay v2 on http://localhost:${PORT}`);
  console.log(`   Watching ${watchers.size} sessions | Dashboard polling every ${DASHBOARD_INTERVAL / 1000}s\n`);
});

// --- Overlay HTML ---
const OVERLAY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OpenClaw OBS Overlay</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap');
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

  :root {
    --green: #00ff88;
    --red: #ff4444;
    --yellow: #ffaa33;
    --blue: #00bfff;
    --purple: #9d7ce0;
    --dim: #555;
    --text: #e0e0e0;
    --bg-panel: rgba(10, 12, 16, 0.85);
    --bg-card: rgba(20, 24, 32, 0.9);
    --border: rgba(255,255,255,0.06);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: transparent;
    font-family: 'JetBrains Mono', monospace;
    color: var(--text);
    overflow: hidden;
    width: 100vw;
    height: 100vh;
  }

  /* ===== LAYOUT: 4 quadrants ===== */
  
  /* TOP-LEFT: Dashboard metrics */
  #dashboard {
    position: fixed;
    top: 12px;
    left: 12px;
    width: 48%;
    max-height: 48%;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* TOP-RIGHT: Status bar / header */
  #header {
    position: fixed;
    top: 12px;
    right: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    z-index: 200;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  #header .logo { font-size: 16px; }
  #header .label { color: var(--green); opacity: 0.7; }
  #header .count { color: var(--dim); font-weight: 400; }

  #statusDot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 6px rgba(0,255,136,0.5);
    transition: background 0.3s;
  }
  #statusDot.disconnected {
    background: var(--red);
    box-shadow: 0 0 6px rgba(255,68,68,0.5);
  }

  /* BOTTOM-RIGHT: Activity log */
  #feed {
    position: fixed;
    bottom: 12px;
    right: 12px;
    width: 52%;
    max-height: 52%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    overflow: hidden;
    z-index: 10;
  }

  /* BOTTOM-LEFT: Session info */
  #sessionInfo {
    position: fixed;
    bottom: 12px;
    left: 12px;
    font-size: 9px;
    color: var(--dim);
    letter-spacing: 0.5px;
    z-index: 200;
  }

  /* ===== DASHBOARD CARDS ===== */

  .dash-card {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    backdrop-filter: blur(8px);
  }

  .dash-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .dash-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .dash-time {
    font-size: 9px;
    color: var(--dim);
  }

  .fund-pnl {
    font-family: 'Inter', sans-serif;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.5px;
    line-height: 1;
  }
  .fund-pnl.positive { color: var(--green); }
  .fund-pnl.negative { color: var(--red); }

  .fund-stats {
    display: flex;
    gap: 16px;
    margin-top: 4px;
    font-size: 10px;
    color: #aaa;
  }

  .fund-stats .stat-value { font-weight: 600; color: var(--text); }

  .bot-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 10px;
    border-top: 1px solid var(--border);
  }
  .bot-row:first-child { border-top: none; }

  .bot-name {
    font-weight: 600;
    min-width: 70px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .bot-status {
    width: 6px; height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .bot-status.live { background: var(--red); box-shadow: 0 0 4px rgba(255,68,68,0.6); }
  .bot-status.paper { background: var(--green); box-shadow: 0 0 4px rgba(0,255,136,0.4); }
  .bot-status.dead { background: #444; }

  .bot-pnl { font-weight: 600; min-width: 55px; text-align: right; }
  .bot-pnl.positive { color: var(--green); }
  .bot-pnl.negative { color: var(--red); }

  .bot-wr { color: #aaa; min-width: 40px; }
  .bot-trades { color: var(--dim); }

  .wr-bar {
    width: 50px; height: 4px;
    background: rgba(255,255,255,0.08);
    border-radius: 2px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .wr-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.5s ease;
  }

  /* ===== ACTIVITY LOG ===== */

  .entry {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 3px 8px;
    margin-bottom: 1px;
    border-radius: 3px;
    animation: slideIn 0.3s cubic-bezier(0.22, 1, 0.36, 1);
    opacity: 1;
    transition: opacity 2s ease-out;
    position: relative;
    font-size: 11px;
  }

  /* Primary messages (user/assistant) are bigger and brighter */
  .entry.primary {
    font-size: 13px;
    padding: 5px 10px;
    margin-bottom: 3px;
    background: rgba(255,255,255,0.03);
    border-left: 2px solid transparent;
  }
  .entry.primary.user { border-left-color: var(--purple); }
  .entry.primary.assistant { border-left-color: var(--green); }

  /* Secondary messages (tools) are smaller and dimmer */
  .entry:not(.primary) {
    opacity: 0.5;
    font-size: 10px;
  }
  .entry:not(.primary):hover {
    opacity: 0.8;
  }

  .entry::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 3px;
    opacity: 0;
    animation: flashHighlight 1.2s ease-out;
    pointer-events: none;
  }
  .entry.primary.assistant::before { background: linear-gradient(90deg, rgba(0,255,136,0.2) 0%, transparent 60%); }
  .entry.primary.user::before { background: linear-gradient(90deg, rgba(100,65,165,0.2) 0%, transparent 60%); }

  .entry.fading { opacity: 0; }

  @keyframes slideIn {
    from { transform: translateX(20px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes flashHighlight {
    0% { opacity: 1; }
    100% { opacity: 0; }
  }

  .entry .icon {
    font-size: 11px;
    flex-shrink: 0;
    line-height: 1.3;
  }
  .entry.primary .icon { font-size: 13px; }

  .entry .ch {
    font-size: 8px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    padding: 1px 4px;
    border-radius: 2px;
    white-space: nowrap;
    flex-shrink: 0;
    color: var(--dim);
    background: rgba(255,255,255,0.04);
  }

  .entry .text {
    line-height: 1.3;
    word-break: break-word;
    text-shadow: 0 1px 2px rgba(0,0,0,0.6);
  }

  .entry.user .text { color: #d4c5f9; }
  .entry.assistant .text { color: #c0ffc0; }
  .entry.tool .text { color: #997a44; }
  .entry.tool-result .text { color: #5599aa; }
  .entry.system .text { color: #994444; }

  .entry.primary.user .text { color: #e0d4ff; }
  .entry.primary.assistant .text { color: #b0ffb0; }

  .entry .time {
    font-size: 8px;
    color: #444;
    flex-shrink: 0;
    margin-left: auto;
    padding-left: 6px;
  }

  /* Scanlines */
  #scanlines {
    position: fixed;
    inset: 0;
    pointer-events: none;
    background: repeating-linear-gradient(
      0deg, transparent, transparent 3px,
      rgba(0,0,0,0.015) 3px, rgba(0,0,0,0.015) 6px
    );
    z-index: 100;
  }

  /* Fade gradient on feed top */
  #feed::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 40px;
    background: linear-gradient(to bottom, rgba(0,0,0,0.3), transparent);
    pointer-events: none;
    z-index: 5;
  }
</style>
</head>
<body>

<!-- TOP-RIGHT: Header -->
<div id="header">
  <span class="logo">🦞</span>
  <span class="label">OpenClaw Live</span>
  <span class="count" id="msgCount">0</span>
  <div id="statusDot"></div>
</div>

<!-- TOP-LEFT: Dashboard -->
<div id="dashboard">
  <div class="dash-card" id="fundCard">
    <div class="dash-header">
      <span class="dash-title">💰 Fund</span>
      <span class="dash-time" id="fundTime">--:-- UTC</span>
    </div>
    <div class="fund-pnl" id="fundPnl">$--</div>
    <div class="fund-stats">
      <span><span class="stat-value" id="fundTrades">--</span>T</span>
      <span><span class="stat-value" id="fundWR">--</span>% WR</span>
      <span>BE: <span class="stat-value" id="fundBE">--</span>%</span>
      <span>24h: <span class="stat-value" id="fundDaily">--</span></span>
    </div>
  </div>
  <div class="dash-card" id="botsCard">
    <div class="dash-header">
      <span class="dash-title">🤖 Fleet</span>
    </div>
    <div id="botsList"></div>
  </div>
</div>

<!-- BOTTOM-LEFT: Session info -->
<div id="sessionInfo">
  <span id="watchCount">-- sessions</span> · <span id="uptime">0m</span>
</div>

<!-- BOTTOM-RIGHT: Activity log -->
<div id="feed"></div>

<div id="scanlines"></div>

<script>
const feed = document.getElementById('feed');
const statusDot = document.getElementById('statusDot');
const msgCountEl = document.getElementById('msgCount');
const MAX_VISIBLE = 20;
const FADE_AFTER_MS = 45000;
let totalCount = 0;
const startTime = Date.now();

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function pnlClass(val) { return val >= 0 ? 'positive' : 'negative'; }
function pnlStr(val) { return (val >= 0 ? '+' : '') + '$' + Math.abs(val).toFixed(2); }
function wrColor(wr) {
  if (wr >= 90) return 'var(--green)';
  if (wr >= 85) return '#88cc44';
  if (wr >= 80) return 'var(--yellow)';
  return 'var(--red)';
}

// ===== Dashboard =====
function updateDashboard(data) {
  if (!data || !data.fund) return;
  const f = data.fund;

  // Fund card
  const genAt = data.generated_at ? new Date(data.generated_at) : new Date();
  document.getElementById('fundTime').textContent = genAt.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

  const pnlEl = document.getElementById('fundPnl');
  pnlEl.textContent = pnlStr(f.pnl);
  pnlEl.className = 'fund-pnl ' + pnlClass(f.pnl);

  document.getElementById('fundTrades').textContent = f.trades;
  document.getElementById('fundWR').textContent = f.win_rate?.toFixed(1) || '--';
  document.getElementById('fundBE').textContent = f.breakeven_wr?.toFixed(1) || '--';
  document.getElementById('fundDaily').textContent = pnlStr(f.daily_pnl || 0);
  document.getElementById('fundDaily').style.color = f.daily_pnl >= 0 ? 'var(--green)' : 'var(--red)';

  // Bots
  const botsList = document.getElementById('botsList');
  botsList.innerHTML = '';

  const bots = data.bots || {};
  const activeBots = Object.entries(bots)
    .filter(([_, b]) => b.trades > 0 || (b.status && b.status !== 'dead'))
    .sort((a, b) => Math.abs(b[1].pnl || 0) - Math.abs(a[1].pnl || 0));

  for (const [name, b] of activeBots) {
    const row = document.createElement('div');
    row.className = 'bot-row';

    const statusClass = b.status === 'active' ? 'live' : b.status === 'paper' ? 'paper' : 'dead';
    const wr = b.win_rate || 0;

    row.innerHTML =
      '<div class="bot-status ' + statusClass + '"></div>' +
      '<span class="bot-name">' + escHtml(name) + '</span>' +
      '<span class="bot-pnl ' + pnlClass(b.pnl) + '">' + pnlStr(b.pnl) + '</span>' +
      '<span class="bot-wr">' + wr.toFixed(1) + '%</span>' +
      '<div class="wr-bar"><div class="wr-fill" style="width:' + Math.min(wr, 100) + '%;background:' + wrColor(wr) + '"></div></div>' +
      '<span class="bot-trades">' + (b.trades || 0) + 'T</span>';

    botsList.appendChild(row);
  }
}

// ===== Activity Log =====
function addEntry(evt) {
  const el = document.createElement('div');
  const classes = ['entry', evt.role || 'other'];
  if (evt.primary) classes.push('primary');
  el.className = classes.join(' ');
  el.dataset.ts = evt.ts || Date.now();

  el.innerHTML =
    '<span class="icon">' + (evt.roleIcon || '💬') + '</span>' +
    '<span class="ch">' + escHtml(evt.channel || '') + '</span>' +
    '<span class="text">' + escHtml(evt.text) + '</span>' +
    '<span class="time">' + formatTime(evt.timestamp) + '</span>';

  feed.appendChild(el);
  totalCount++;
  msgCountEl.textContent = totalCount + ' events';

  while (feed.children.length > MAX_VISIBLE) {
    const old = feed.firstElementChild;
    old.style.transition = 'opacity 0.4s, transform 0.4s';
    old.style.opacity = '0';
    old.style.transform = 'translateX(20px)';
    setTimeout(() => old.remove(), 400);
  }
}

// Fade old entries
setInterval(() => {
  const now = Date.now();
  for (const el of feed.children) {
    const age = now - parseInt(el.dataset.ts || '0');
    if (age > FADE_AFTER_MS && !el.classList.contains('fading')) {
      el.classList.add('fading');
    }
  }
  for (const el of [...feed.children]) {
    const age = now - parseInt(el.dataset.ts || '0');
    if (age > 90000 && el.classList.contains('fading')) {
      el.remove();
    }
  }

  // Update uptime
  const mins = Math.floor((Date.now() - startTime) / 60000);
  document.getElementById('uptime').textContent = mins < 60 ? mins + 'm' : Math.floor(mins/60) + 'h' + (mins%60) + 'm';
}, 5000);

// ===== SSE =====
function connect() {
  const evtSource = new EventSource('/events');

  evtSource.onopen = () => {
    statusDot.className = '';
  };

  evtSource.onmessage = (e) => {
    try {
      const evt = JSON.parse(e.data);
      addEntry(evt);
    } catch {}
  };

  evtSource.addEventListener('dashboard', (e) => {
    try {
      updateDashboard(JSON.parse(e.data));
    } catch {}
  });

  evtSource.onerror = () => {
    statusDot.className = 'disconnected';
    evtSource.close();
    setTimeout(connect, 3000);
  };
}

connect();
</script>
</body>
</html>`;
