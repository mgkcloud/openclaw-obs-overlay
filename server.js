#!/usr/bin/env node
/**
 * OpenClaw OBS Overlay Server v3
 * 
 * Fallout terminal aesthetic. Green text on black. No borders, no shadows, no icons.
 * Dashboard top-left, activity log bottom-right, status at edges.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { exec: execCb } = require('child_process');

const PORT = parseInt(process.env.PORT || '3456');
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(process.env.HOME, '.openclaw', 'agents');
const MAX_EVENTS = 200;
const DASHBOARD_INTERVAL = 60000;

const bus = new EventEmitter();
bus.setMaxListeners(50);
const recentEvents = [];

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
refreshDashboard();
setInterval(refreshDashboard, DASHBOARD_INTERVAL);

function inferChannel(filePath) {
  const parts = filePath.split(path.sep);
  const agentIdx = parts.indexOf('agents');
  const agentName = agentIdx >= 0 ? parts[agentIdx + 1] : '?';
  const filename = path.basename(filePath, '.jsonl');
  const topicMatch = filename.match(/topic-(\d+)/);
  if (topicMatch) return `${agentName}/t${topicMatch[1]}`;
  return `${agentName}/${filename.slice(0, 6)}`;
}

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
        if (block.type === 'text' && block.text) text += block.text;
        else if (block.type === 'toolCall') { hasToolCall = true; text += `${block.name}(...)`; }
      }
    }
    if (!text) return null;
    text = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;

    const isPrimary = (role === 'user' || role === 'assistant') && !hasToolCall;
    const maxLen = isPrimary ? 280 : 100;
    if (text.length > maxLen) text = text.slice(0, maxLen - 3) + '...';

    const roleTag = { user: 'USER', assistant: 'GG', toolCall: 'TOOL', toolResult: 'RES', system: 'SYS' }[role] || 'MSG';
    const roleClass = { user: 'user', assistant: 'assistant', toolCall: 'tool', toolResult: 'tool-result', system: 'system' }[role] || 'other';

    return { id: entry.id || Math.random().toString(36).slice(2), channel, role: roleClass, roleTag, text, timestamp, ts: Date.now(), primary: isPrimary };
  } catch { return null; }
}

const fileOffsets = new Map();
const watchers = new Map();

function tailFile(filePath) {
  const channel = inferChannel(filePath);
  try { fileOffsets.set(filePath, fs.statSync(filePath).size); } catch { fileOffsets.set(filePath, 0); }
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
      for (const line of buffer.split('\n').filter(Boolean)) {
        const evt = parseMessage(line, channel);
        if (evt) { recentEvents.push(evt); if (recentEvents.length > MAX_EVENTS) recentEvents.shift(); bus.emit('event', evt); }
      }
    });
  });
  watchers.set(filePath, watcher);
  console.log(`>> ${channel}`);
}

function scanSessions() {
  try {
    for (const agent of fs.readdirSync(SESSIONS_DIR)) {
      const sessDir = path.join(SESSIONS_DIR, agent, 'sessions');
      if (!fs.existsSync(sessDir)) continue;
      for (const file of fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'))) {
        const filePath = path.join(sessDir, file);
        if (!watchers.has(filePath)) {
          try { if (Date.now() - fs.statSync(filePath).mtimeMs < 86400000) tailFile(filePath); } catch {}
        }
      }
    }
  } catch {}
}
scanSessions();
setInterval(scanSessions, 30000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    if (dashboardData) res.write(`event: dashboard\ndata: ${JSON.stringify(dashboardData)}\n\n`);
    for (const evt of recentEvents.slice(-15)) res.write(`data: ${JSON.stringify(evt)}\n\n`);
    const h1 = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
    const h2 = (d) => res.write(`event: dashboard\ndata: ${JSON.stringify(d)}\n\n`);
    bus.on('event', h1); bus.on('dashboard', h2);
    req.on('close', () => { bus.off('event', h1); bus.off('dashboard', h2); });
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => clearInterval(ka));
    return;
  }
  if (url.pathname === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(dashboardData || {})); return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, watching: watchers.size, buffered: recentEvents.length })); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
  res.end(OVERLAY_HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OBS Overlay v3 :: http://localhost:${PORT} :: ${watchers.size} sessions`);
});

const OVERLAY_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>OPENCLAW TERMINAL</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: transparent;
    font-family: 'Share Tech Mono', 'VT323', 'Courier New', monospace;
    color: #33ff33;
    overflow: hidden;
    width: 100vw;
    height: 100vh;
    font-size: 13px;
  }

  /* ===== TOP-LEFT: DASHBOARD ===== */
  #dashboard {
    position: fixed;
    top: 16px;
    left: 16px;
    width: 46%;
    max-height: 46%;
    overflow: hidden;
    line-height: 1.5;
    font-size: 12px;
  }

  #dashboard .section-head {
    color: #33ff33;
    font-size: 13px;
    letter-spacing: 1px;
  }

  #dashboard .fund-pnl-big {
    font-family: 'VT323', monospace;
    font-size: 36px;
    line-height: 1.1;
  }

  #dashboard .dim { color: #1a8c1a; }
  #dashboard .bright { color: #55ff55; }
  #dashboard .warn { color: #ff5555; }
  #dashboard .ok { color: #33ff33; }

  .bot-line {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bar {
    display: inline-block;
    letter-spacing: -1px;
  }

  .separator {
    color: #1a6e1a;
    letter-spacing: 2px;
  }

  /* ===== TOP-RIGHT: STATUS ===== */
  #topRight {
    position: fixed;
    top: 16px;
    right: 16px;
    text-align: right;
    font-size: 11px;
    color: #1a8c1a;
  }
  #topRight .title {
    color: #33ff33;
    font-size: 14px;
    letter-spacing: 2px;
  }

  /* ===== BOTTOM-LEFT: META ===== */
  #bottomLeft {
    position: fixed;
    bottom: 16px;
    left: 16px;
    font-size: 10px;
    color: #1a6e1a;
  }

  /* ===== BOTTOM-RIGHT: ACTIVITY LOG ===== */
  #feed {
    position: fixed;
    bottom: 16px;
    right: 16px;
    width: 50%;
    max-height: 50%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    overflow: hidden;
  }

  .entry {
    padding: 1px 0;
    animation: typeIn 0.2s ease-out;
    opacity: 1;
    transition: opacity 3s ease-out;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11px;
    color: #1a8c1a;
  }

  .entry.primary {
    font-size: 13px;
    color: #33ff33;
  }

  .entry.primary .msg-text {
    color: #44ff44;
  }

  .entry .tag {
    color: #1a6e1a;
  }
  .entry.primary .tag {
    color: #33ff33;
  }
  .entry.primary.user .tag {
    color: #55ff55;
  }

  .entry .msg-text {
    color: #1a7a1a;
  }

  .entry.fading { opacity: 0; }

  @keyframes typeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* CRT scanline overlay */
  #crt {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 100;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0, 0, 0, 0.04) 2px,
      rgba(0, 0, 0, 0.04) 4px
    );
  }

  /* Subtle CRT flicker */
  @keyframes flicker {
    0% { opacity: 0.98; }
    50% { opacity: 1; }
    100% { opacity: 0.98; }
  }
  body { animation: flicker 4s infinite; }
</style>
</head>
<body>

<!-- TOP-RIGHT -->
<div id="topRight">
  <div class="title">OPENCLAW v3</div>
  <div id="connStatus">CONNECTING...</div>
  <div id="eventCount">0 EVENTS</div>
</div>

<!-- TOP-LEFT: DASHBOARD -->
<div id="dashboard">
  <div id="dashContent">AWAITING DATA...</div>
</div>

<!-- BOTTOM-LEFT -->
<div id="bottomLeft">
  <div id="sessionCount">-- SESSIONS</div>
  <div id="uptimeDisplay">UPTIME 0M</div>
</div>

<!-- BOTTOM-RIGHT: FEED -->
<div id="feed"></div>

<div id="crt"></div>

<script>
const feed = document.getElementById('feed');
const MAX_VISIBLE = 18;
const FADE_MS = 45000;
let total = 0;
const t0 = Date.now();

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function pnl(v) { return (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(2); }
function pnlColor(v) { return v >= 0 ? 'ok' : 'warn'; }

function wrBar(wr, width) {
  const filled = Math.round(wr / 100 * width);
  const empty = width - filled;
  return '<span class="bar">' + '|'.repeat(filled) + '<span class="dim">' + '.'.repeat(empty) + '</span></span>';
}

function updateDashboard(data) {
  if (!data || !data.fund) return;
  const f = data.fund;
  const genAt = data.generated_at ? new Date(data.generated_at) : new Date();
  const utc = genAt.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', timeZone:'UTC' });

  let html = '';
  html += '<div class="section-head">FUND OVERVIEW ' + utc + ' UTC</div>';
  html += '<div class="fund-pnl-big ' + pnlColor(f.pnl) + '">' + pnl(f.pnl) + '</div>';
  html += '<div>' + f.trades + 'T ' + (f.win_rate||0).toFixed(1) + '%WR | BE: ' + (f.breakeven_wr||0).toFixed(1) + '%</div>';
  html += '<div>24H: <span class="' + pnlColor(f.daily_pnl||0) + '">' + pnl(f.daily_pnl||0) + '</span> (' + (f.daily_trades||0) + 'T)</div>';
  html += '<div class="separator">- - - - - - - - - - - - - - - -</div>';

  const bots = data.bots || {};
  const active = Object.entries(bots)
    .filter(([_, b]) => b.trades > 0 || (b.status && b.status !== 'dead'))
    .sort((a, b) => Math.abs(b[1].pnl||0) - Math.abs(a[1].pnl||0));

  for (const [name, b] of active) {
    const status = b.status === 'active' ? 'LIVE' : b.status === 'paper' ? 'PAPER' : 'DEAD';
    const wr = b.win_rate || 0;
    html += '<div class="bot-line">';
    html += name.toUpperCase() + ' [' + status + '] ';
    html += '<span class="' + pnlColor(b.pnl) + '">' + pnl(b.pnl) + '</span> ';
    html += wr.toFixed(1) + '% ' + wrBar(wr, 12) + ' ';
    html += (b.trades||0) + 'T';
    if (b.daily_pnl) html += ' 24h:<span class="' + pnlColor(b.daily_pnl) + '">' + pnl(b.daily_pnl) + '</span>';
    html += '</div>';
  }

  document.getElementById('dashContent').innerHTML = html;
}

function addEntry(evt) {
  const el = document.createElement('div');
  const cls = ['entry', evt.role || 'other'];
  if (evt.primary) cls.push('primary');
  el.className = cls.join(' ');
  el.dataset.ts = evt.ts || Date.now();

  const t = new Date(evt.timestamp);
  const ts = t.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });

  el.innerHTML = '<span class="tag">[' + ts + ' ' + esc(evt.roleTag || '?') + ']</span> <span class="msg-text">' + esc(evt.text) + '</span>';

  feed.appendChild(el);
  total++;
  document.getElementById('eventCount').textContent = total + ' EVENTS';

  while (feed.children.length > MAX_VISIBLE) {
    const old = feed.firstElementChild;
    old.style.opacity = '0';
    setTimeout(() => old.remove(), 300);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const el of feed.children) {
    const age = now - parseInt(el.dataset.ts || '0');
    if (age > FADE_MS && !el.classList.contains('fading')) el.classList.add('fading');
  }
  for (const el of [...feed.children]) {
    if (now - parseInt(el.dataset.ts || '0') > 90000 && el.classList.contains('fading')) el.remove();
  }
  const m = Math.floor((now - t0) / 60000);
  document.getElementById('uptimeDisplay').textContent = 'UPTIME ' + (m < 60 ? m + 'M' : Math.floor(m/60) + 'H' + (m%60) + 'M');
}, 5000);

function connect() {
  const es = new EventSource('/events');
  es.onopen = () => {
    document.getElementById('connStatus').textContent = 'CONNECTED';
    document.getElementById('connStatus').style.color = '#33ff33';
  };
  es.onmessage = (e) => { try { addEntry(JSON.parse(e.data)); } catch {} };
  es.addEventListener('dashboard', (e) => { try { updateDashboard(JSON.parse(e.data)); } catch {} });
  es.onerror = () => {
    document.getElementById('connStatus').textContent = 'DISCONNECTED';
    document.getElementById('connStatus').style.color = '#ff5555';
    es.close();
    setTimeout(connect, 3000);
  };
}
connect();
</script>
</body>
</html>`;
