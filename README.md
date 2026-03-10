# OpenClaw OBS Overlay 🦞

Twitch-style live feed overlay for OBS that shows real-time OpenClaw agent activity across all channels.

![overlay-preview](https://img.shields.io/badge/OBS-Browser_Source-green?style=flat-square)

## Features

- **Real-time streaming** of all OpenClaw session activity via SSE
- **Twitch-style green highlight flash** on new messages
- **Auto-fading entries** (30s fade, 60s remove)
- **Color-coded roles**: 🤖 assistant (green), 👤 user (purple), ⚡ tool calls (orange), 📦 tool results (blue), ⚙️ system (red)
- **Channel labels** showing agent/session source
- **Infinite scroll** with smooth entry/exit animations
- **Auto-reconnect** on connection loss
- **Zero config** - auto-discovers active sessions from `~/.openclaw/agents/`

## Quick Start

```bash
cd openclaw-obs-overlay
npm install
npm start
```

Then in OBS:
1. Sources → Add → **Browser**
2. URL: `http://localhost:3456`
3. Width: 500, Height: 800 (or whatever fits your layout)
4. ✅ Shutdown source when not visible
5. Background: **transparent** (it's already transparent)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `SESSIONS_DIR` | `~/.openclaw/agents` | Path to OpenClaw agent sessions |

## Endpoints

- `GET /` - Overlay HTML (browser source)
- `GET /events` - SSE event stream
- `GET /health` - Health check JSON

## How It Works

1. Server watches all `.jsonl` session files modified in the last 24h
2. New lines are parsed, filtered to displayable messages, and emitted via SSE
3. Browser source renders entries with slide-in animation and green flash highlight
4. Old entries fade out and are removed after 60s
5. Re-scans for new sessions every 30s

## License

MIT
