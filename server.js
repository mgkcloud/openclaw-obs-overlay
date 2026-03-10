#!/usr/bin/env node
/**
 * OpenClaw OBS Overlay Server v4
 * 
 * Fallout terminal green monochrome + iMessage bubbles for user/assistant.
 * SVG tails work on transparent OBS backgrounds.
 * System/tool/cron messages stay as terminal text.
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
    try { dashboardData = JSON.parse(stdout); dashboardLastUpdate = Date.now(); bus.emit('dashboard', dashboardData); } catch {}
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
    if (!isPrimary && text.length > 120) text = text.slice(0, 117) + '...';

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
  console.log(`OBS Overlay v4 :: http://localhost:${PORT} :: ${watchers.size} sessions`);
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
    font-family: 'Share Tech Mono', 'Courier New', monospace;
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
    width: 44%;
    max-height: 44%;
    overflow: hidden;
    line-height: 1.5;
    font-size: 12px;
  }

  .fund-pnl-big {
    font-family: 'VT323', monospace;
    font-size: 36px;
    line-height: 1.1;
  }

  .dim { color: #1a8c1a; }
  .bright { color: #55ff55; }
  .warn { color: #ff5555; }
  .ok { color: #33ff33; }
  .separator { color: #1a6e1a; letter-spacing: 2px; }
  .bar { display: inline-block; letter-spacing: -1px; }
  .bot-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* ===== TOP-RIGHT: STATUS ===== */
  #topRight {
    position: fixed;
    top: 16px;
    right: 16px;
    text-align: right;
    font-size: 11px;
    color: #1a8c1a;
  }
  #topRight .title { color: #33ff33; font-size: 14px; letter-spacing: 2px; }

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
    width: 52%;
    max-height: 54%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    overflow: hidden;
  }

  /* --- Terminal lines (tools, system, cron) --- */
  .entry {
    padding: 1px 0;
    animation: fadeIn 0.3s ease-out;
    opacity: 1;
    transition: opacity 3s ease-out;
    font-size: 11px;
    color: #1a8c1a;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .entry .tag { color: #1a6e1a; }
  .entry .msg-text { color: #1a7a1a; }
  .entry.fading { opacity: 0; }

  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  /* ===== iMESSAGE BUBBLES ===== */

  .bubble-row {
    display: flex;
    margin: 3px 0;
    animation: bubbleSlide 0.35s cubic-bezier(0.22, 1, 0.36, 1);
    transition: opacity 3s ease-out;
  }
  .bubble-row.fading { opacity: 0; }

  .bubble-row.from-user { justify-content: flex-end; }
  .bubble-row.from-assistant { justify-content: flex-start; }

  .bubble-col { max-width: 82%; position: relative; }

  /* The bubble itself */
  .bubble {
    position: relative;
    padding: 8px 14px;
    font-size: 13px;
    line-height: 1.4;
    word-wrap: break-word;
    white-space: normal;
    border-radius: 18px;
    font-family: 'Share Tech Mono', monospace;
  }

  /* User: bright green bubble, dark text */
  .bubble.sent {
    background: #33ff33;
    color: #0a0f0a;
    border-bottom-right-radius: 4px;
    margin-right: 8px;
  }

  /* Assistant: dark green bubble, green text */
  .bubble.received {
    background: #0d2b0d;
    color: #33ff33;
    border-bottom-left-radius: 4px;
    margin-left: 8px;
  }

  /* SVG tails - works on transparent backgrounds */
  .tail {
    position: absolute;
    bottom: 0;
    width: 12px;
    height: 20px;
  }

  .tail-sent {
    right: -4px;
  }

  .tail-received {
    left: -4px;
  }

  .bubble-meta {
    font-size: 9px;
    margin-top: 1px;
    color: #1a6e1a;
    font-family: 'Share Tech Mono', monospace;
  }
  .bubble-row.from-user .bubble-meta { text-align: right; padding-right: 10px; }
  .bubble-row.from-assistant .bubble-meta { text-align: left; padding-left: 10px; }

  @keyframes bubbleSlide {
    from { transform: translateY(10px) scale(0.96); opacity: 0; }
    to { transform: translateY(0) scale(1); opacity: 1; }
  }

  /* CRT scanlines */
  #crt {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 100;
    background: repeating-linear-gradient(
      0deg, transparent, transparent 2px,
      rgba(0, 0, 0, 0.04) 2px, rgba(0, 0, 0, 0.04) 4px
    );
  }
  @keyframes flicker { 0% { opacity: 0.98; } 50% { opacity: 1; } 100% { opacity: 0.98; } }
  body { animation: flicker 4s infinite; }
</style>
</head>
<body>

<div id="topRight">
  <div class="title">OPENCLAW v4</div>
  <div id="connStatus">CONNECTING...</div>
  <div id="eventCount">0 EVENTS</div>
</div>

<div id="dashboard"><div id="dashContent">AWAITING DATA...</div></div>

<div id="bottomLeft">
  <div id="sessionCount"></div>
  <div id="uptimeDisplay">UPTIME 0M</div>
</div>

<div id="feed"></div>
<div id="crt"></div>

<!-- SVG tail templates (hidden, cloned via JS) -->
<svg style="display:none">
  <!-- Sent tail (right side, bright green) - iMessage curve -->
  <symbol id="tail-sent" viewBox="0 0 12 20">
    <path d="M0,0 C0,10 4,16 12,20 C8,16 4,10 2,0 Z" fill="#33ff33"/>
  </symbol>
  <!-- Received tail (left side, dark green) - mirrored -->
  <symbol id="tail-received" viewBox="0 0 12 20">
    <path d="M12,0 C12,10 8,16 0,20 C4,16 8,10 10,0 Z" fill="#0d2b0d"/>
  </symbol>
</svg>

<script>
const feed = document.getElementById('feed');
const MAX_VISIBLE = 16;
const FADE_MS = 60000;
let total = 0;
const t0 = Date.now();

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function pnl(v) { return (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(2); }
function pc(v) { return v >= 0 ? 'ok' : 'warn'; }
function wrBar(wr, w) {
  const f = Math.round(wr / 100 * w);
  return '<span class="bar">' + '|'.repeat(f) + '<span class="dim">' + '.'.repeat(w - f) + '</span></span>';
}

function updateDashboard(data) {
  if (!data || !data.fund) return;
  const f = data.fund;
  const t = data.generated_at ? new Date(data.generated_at) : new Date();
  const utc = t.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', timeZone:'UTC' });

  let h = 'FUND OVERVIEW ' + utc + ' UTC<br>';
  h += '<div class="fund-pnl-big ' + pc(f.pnl) + '">' + pnl(f.pnl) + '</div>';
  h += f.trades + 'T ' + (f.win_rate||0).toFixed(1) + '%WR | BE: ' + (f.breakeven_wr||0).toFixed(1) + '%<br>';
  h += '24H: <span class="' + pc(f.daily_pnl||0) + '">' + pnl(f.daily_pnl||0) + '</span> (' + (f.daily_trades||0) + 'T)<br>';
  h += '<div class="separator">- - - - - - - - - - - - - - -</div>';

  const bots = data.bots || {};
  const active = Object.entries(bots)
    .filter(([_, b]) => b.trades > 0 || (b.status && b.status !== 'dead'))
    .sort((a, b) => Math.abs(b[1].pnl||0) - Math.abs(a[1].pnl||0));

  for (const [name, b] of active) {
    const st = b.status === 'active' ? 'LIVE' : b.status === 'paper' ? 'PAPER' : 'DEAD';
    const wr = b.win_rate || 0;
    h += '<div class="bot-line">' + name.toUpperCase() + ' [' + st + '] ';
    h += '<span class="' + pc(b.pnl) + '">' + pnl(b.pnl) + '</span> ';
    h += wr.toFixed(1) + '% ' + wrBar(wr, 10) + ' ' + (b.trades||0) + 'T';
    if (b.daily_pnl) h += ' 24h:<span class="' + pc(b.daily_pnl) + '">' + pnl(b.daily_pnl) + '</span>';
    h += '</div>';
  }
  document.getElementById('dashContent').innerHTML = h;
}

function makeTailSvg(type) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('tail', 'tail-' + type);
  svg.setAttribute('viewBox', '0 0 12 20');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '20');

  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#tail-' + type);
  svg.appendChild(use);
  return svg;
}

function addEntry(evt) {
  if (evt.primary) {
    const isUser = evt.role === 'user';
    const row = document.createElement('div');
    row.className = 'bubble-row ' + (isUser ? 'from-user' : 'from-assistant');
    row.dataset.ts = evt.ts || Date.now();

    const col = document.createElement('div');
    col.className = 'bubble-col';

    const bubble = document.createElement('div');
    bubble.className = 'bubble ' + (isUser ? 'sent' : 'received');
    bubble.textContent = evt.text;

    // Add SVG tail
    const tail = makeTailSvg(isUser ? 'sent' : 'received');
    bubble.appendChild(tail);

    const meta = document.createElement('div');
    meta.className = 'bubble-meta';
    const ts = new Date(evt.timestamp);
    meta.textContent = (isUser ? 'USER' : 'GG') + ' ' + ts.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', hour12:false });

    col.appendChild(bubble);
    col.appendChild(meta);
    row.appendChild(col);
    feed.appendChild(row);
  } else {
    const el = document.createElement('div');
    el.className = 'entry';
    el.dataset.ts = evt.ts || Date.now();
    const ts = new Date(evt.timestamp);
    const t = ts.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
    el.innerHTML = '<span class="tag">[' + t + ' ' + esc(evt.roleTag||'?') + ']</span> <span class="msg-text">' + esc(evt.text) + '</span>';
    feed.appendChild(el);
  }

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
    if (now - parseInt(el.dataset.ts||'0') > 120000 && el.classList.contains('fading')) el.remove();
  }
  const m = Math.floor((now - t0) / 60000);
  document.getElementById('uptimeDisplay').textContent = 'UPTIME ' + (m < 60 ? m + 'M' : Math.floor(m/60) + 'H' + (m%60) + 'M');
}, 5000);

function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { document.getElementById('connStatus').textContent = 'CONNECTED'; document.getElementById('connStatus').style.color = '#33ff33'; };
  es.onmessage = (e) => { try { addEntry(JSON.parse(e.data)); } catch {} };
  es.addEventListener('dashboard', (e) => { try { updateDashboard(JSON.parse(e.data)); } catch {} });
  es.onerror = () => { document.getElementById('connStatus').textContent = 'DISCONNECTED'; document.getElementById('connStatus').style.color = '#ff5555'; es.close(); setTimeout(connect, 3000); };
}
connect();
</script>
</body>
</html>`;
