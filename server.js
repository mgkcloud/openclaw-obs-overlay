#!/usr/bin/env node
/**
 * OpenClaw OBS Overlay Server
 * 
 * Tails all active OpenClaw session JSONL files and streams
 * parsed events to a browser source overlay via SSE.
 * 
 * Usage:
 *   node server.js [--port 3456] [--sessions-dir ~/.openclaw/agents]
 *   OBS > Sources > Browser > URL: http://localhost:3456
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

// --- Config ---
const PORT = parseInt(process.env.PORT || '3456');
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(process.env.HOME, '.openclaw', 'agents');
const MAX_EVENTS = 200;  // keep in memory for new connections

// --- Event Bus ---
const bus = new EventEmitter();
bus.setMaxListeners(50);
const recentEvents = [];

// Channel name extraction from session filename/path
function inferChannel(filePath) {
  const parts = filePath.split(path.sep);
  // agents/<agentName>/sessions/<sessionId>.jsonl
  const agentIdx = parts.indexOf('agents');
  const agentName = agentIdx >= 0 ? parts[agentIdx + 1] : 'unknown';
  const filename = path.basename(filePath, '.jsonl');
  
  // topic-based sessions
  const topicMatch = filename.match(/topic-(\d+)/);
  if (topicMatch) return `${agentName}/topic-${topicMatch[1]}`;
  
  return `${agentName}/${filename.slice(0, 8)}`;
}

// Parse a JSONL message line into a display event
function parseMessage(line, channel) {
  try {
    const entry = JSON.parse(line);
    if (entry.type !== 'message') return null;
    
    const msg = entry.message;
    if (!msg) return null;
    
    const role = msg.role;
    const timestamp = entry.timestamp || new Date().toISOString();
    
    // Extract text content
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          text += block.text;
        } else if (block.type === 'toolCall') {
          text += `⚡ ${block.name}(${JSON.stringify(block.arguments || {}).slice(0, 80)})`;
        }
      }
    }
    
    if (!text) return null;
    
    // Truncate long messages
    if (text.length > 200) text = text.slice(0, 197) + '...';
    
    // Clean up
    text = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    
    // Role emoji
    const roleIcon = {
      user: '👤',
      assistant: '🤖',
      toolCall: '⚡',
      toolResult: '📦',
      system: '⚙️',
    }[role] || '💬';
    
    // Role color class
    const roleClass = {
      user: 'user',
      assistant: 'assistant',
      toolCall: 'tool',
      toolResult: 'tool-result',
      system: 'system',
    }[role] || 'other';
    
    return {
      id: entry.id || Math.random().toString(36).slice(2),
      channel,
      role: roleClass,
      roleIcon,
      text,
      timestamp,
      ts: Date.now(),
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
  
  // Get current size as offset (only read new lines)
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
    
    // Read new bytes
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
  console.log(`👁️  Watching: ${channel} (${path.basename(filePath)})`);
}

function scanSessions() {
  // Find all agent session directories
  try {
    const agents = fs.readdirSync(SESSIONS_DIR);
    for (const agent of agents) {
      const sessDir = path.join(SESSIONS_DIR, agent, 'sessions');
      if (!fs.existsSync(sessDir)) continue;
      
      const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(sessDir, file);
        if (!watchers.has(filePath)) {
          // Only watch recently modified files (last 24h)
          try {
            const stat = fs.statSync(filePath);
            const age = Date.now() - stat.mtimeMs;
            if (age < 24 * 60 * 60 * 1000) {
              tailFile(filePath);
            }
          } catch {}
        }
      }
    }
  } catch (err) {
    console.error('Scan error:', err.message);
  }
}

// Initial scan + periodic re-scan for new sessions
scanSessions();
setInterval(scanSessions, 30000);

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  if (url.pathname === '/events') {
    // SSE endpoint
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    
    // Send recent events as initial batch
    for (const evt of recentEvents.slice(-30)) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }
    
    // Stream new events
    const handler = (evt) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };
    bus.on('event', handler);
    
    req.on('close', () => {
      bus.off('event', handler);
    });
    
    // Keepalive
    const ka = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);
    req.on('close', () => clearInterval(ka));
    
    return;
  }
  
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      watching: watchers.size,
      buffered: recentEvents.length,
    }));
    return;
  }
  
  // Serve the overlay HTML
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'Cache-Control': 'no-cache',
  });
  res.end(OVERLAY_HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎬 OpenClaw OBS Overlay running on http://localhost:${PORT}`);
  console.log(`   Add as OBS Browser Source: http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Watching ${watchers.size} session files\n`);
});

// --- Overlay HTML ---
const OVERLAY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>OpenClaw Live Feed</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap');
  
  * { margin: 0; padding: 0; box-sizing: border-box; }
  
  body {
    background: transparent;
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 13px;
    overflow: hidden;
    width: 100vw;
    height: 100vh;
  }
  
  #feed {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    padding: 12px 16px;
    max-height: 100vh;
    overflow: hidden;
  }
  
  .entry {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 10px;
    margin-bottom: 2px;
    border-radius: 4px;
    animation: slideIn 0.3s cubic-bezier(0.22, 1, 0.36, 1);
    opacity: 1;
    transition: opacity 2s ease-out;
    position: relative;
    overflow: hidden;
  }
  
  .entry::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 4px;
    opacity: 0;
    animation: flashHighlight 1.5s ease-out;
  }
  
  /* Twitch-style green flash highlight */
  .entry.assistant::before {
    background: linear-gradient(90deg, #00ff8855 0%, #00ff8822 40%, transparent 100%);
  }
  .entry.user::before {
    background: linear-gradient(90deg, #6441a555 0%, #6441a522 40%, transparent 100%);
  }
  .entry.tool::before {
    background: linear-gradient(90deg, #ff990055 0%, #ff990022 40%, transparent 100%);
  }
  .entry.tool-result::before {
    background: linear-gradient(90deg, #00bfff55 0%, #00bfff22 40%, transparent 100%);
  }
  .entry.system::before {
    background: linear-gradient(90deg, #ff444455 0%, #ff444422 40%, transparent 100%);
  }
  
  .entry.fading {
    opacity: 0;
  }
  
  @keyframes slideIn {
    from {
      transform: translateY(20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
  
  @keyframes flashHighlight {
    0% { opacity: 1; }
    100% { opacity: 0; }
  }
  
  .channel {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 6px;
    border-radius: 3px;
    white-space: nowrap;
    flex-shrink: 0;
    min-width: 90px;
    text-align: center;
  }
  
  .entry.assistant .channel { background: #00ff8830; color: #00ff88; border: 1px solid #00ff8840; }
  .entry.user .channel { background: #6441a530; color: #9d7ce0; border: 1px solid #6441a540; }
  .entry.tool .channel { background: #ff990030; color: #ffaa33; border: 1px solid #ff990040; }
  .entry.tool-result .channel { background: #00bfff30; color: #00bfff; border: 1px solid #00bfff40; }
  .entry.system .channel { background: #ff444430; color: #ff6666; border: 1px solid #ff444440; }
  
  .icon {
    font-size: 14px;
    line-height: 1.4;
    flex-shrink: 0;
  }
  
  .text {
    color: #e0e0e0;
    line-height: 1.4;
    word-break: break-word;
    text-shadow: 0 1px 3px rgba(0,0,0,0.8);
  }
  
  .entry.assistant .text { color: #b0ffb0; }
  .entry.user .text { color: #d4c5f9; }
  .entry.tool .text { color: #ffd699; }
  .entry.tool-result .text { color: #99e5ff; }
  .entry.system .text { color: #ff9999; }
  
  .time {
    font-size: 9px;
    color: #666;
    flex-shrink: 0;
    margin-left: auto;
    padding-left: 8px;
  }
  
  /* Scanline overlay effect */
  #scanlines {
    position: fixed;
    inset: 0;
    pointer-events: none;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0, 0, 0, 0.03) 2px,
      rgba(0, 0, 0, 0.03) 4px
    );
    z-index: 100;
  }
  
  /* Bottom fade gradient */
  #feed::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 80px;
    background: linear-gradient(to bottom, transparent, transparent);
    pointer-events: none;
    z-index: 10;
  }
  
  /* Connection status dot */
  #status {
    position: fixed;
    top: 8px;
    right: 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #00ff88;
    box-shadow: 0 0 6px #00ff8880;
    z-index: 200;
    transition: background 0.3s;
  }
  #status.disconnected {
    background: #ff4444;
    box-shadow: 0 0 6px #ff444480;
  }
  
  /* Header bar */
  #header {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    padding: 6px 16px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: #00ff8880;
    display: flex;
    align-items: center;
    gap: 8px;
    z-index: 200;
  }
  
  #header .logo {
    font-size: 12px;
  }
  
  #header .count {
    margin-left: auto;
    color: #666;
    font-weight: 400;
  }
</style>
</head>
<body>

<div id="header">
  <span class="logo">🦞</span>
  <span>OpenClaw Live</span>
  <span class="count" id="msgCount">0 events</span>
</div>

<div id="status"></div>
<div id="scanlines"></div>
<div id="feed"></div>

<script>
const feed = document.getElementById('feed');
const status = document.getElementById('status');
const msgCount = document.getElementById('msgCount');
const MAX_VISIBLE = 25;
const FADE_AFTER_MS = 30000;  // fade entries after 30s
let totalCount = 0;

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function addEntry(evt) {
  const el = document.createElement('div');
  el.className = 'entry ' + (evt.role || 'other');
  el.dataset.ts = evt.ts || Date.now();
  
  el.innerHTML = 
    '<span class="channel">' + escHtml(evt.channel || '?') + '</span>' +
    '<span class="icon">' + (evt.roleIcon || '💬') + '</span>' +
    '<span class="text">' + escHtml(evt.text) + '</span>' +
    '<span class="time">' + formatTime(evt.timestamp) + '</span>';
  
  feed.appendChild(el);
  totalCount++;
  msgCount.textContent = totalCount + ' events';
  
  // Remove excess entries (keep scrolling)
  while (feed.children.length > MAX_VISIBLE) {
    const old = feed.firstElementChild;
    old.style.transition = 'opacity 0.5s, transform 0.5s';
    old.style.opacity = '0';
    old.style.transform = 'translateY(-10px)';
    setTimeout(() => old.remove(), 500);
  }
  
  // Auto-scroll
  feed.scrollTop = feed.scrollHeight;
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
  // Remove fully faded entries older than 60s
  for (const el of [...feed.children]) {
    const age = now - parseInt(el.dataset.ts || '0');
    if (age > 60000 && el.classList.contains('fading')) {
      el.remove();
    }
  }
}, 5000);

// SSE connection with auto-reconnect
function connect() {
  const evtSource = new EventSource('/events');
  
  evtSource.onopen = () => {
    status.className = '';
    console.log('Connected to OpenClaw feed');
  };
  
  evtSource.onmessage = (e) => {
    try {
      const evt = JSON.parse(e.data);
      addEntry(evt);
    } catch {}
  };
  
  evtSource.onerror = () => {
    status.className = 'disconnected';
    evtSource.close();
    setTimeout(connect, 3000);
  };
}

connect();
</script>
</body>
</html>`;
