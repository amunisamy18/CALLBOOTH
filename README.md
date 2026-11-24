# TogetherBooth 📸

Private two-person virtual photo booth with video calling, chat, games, drawing, and photo gallery.

## Features
- **Video Call** — WebRTC peer-to-peer video/audio with camera flip, mute, and fullscreen
- **Photo Booth** — Synchronized remote photo booth with 30+ templates, filters, and customizable captions
- **Photo Editor** — Stickers, text, drawing, and filters on photo strips
- **Chat** — Real-time messaging with emoji picker, reactions, and typing indicators
- **Gallery** — Save, favorite, download, and share photo memories
- **Games** — Truth or Dare, Spin the Wheel, Pose Challenge, Emoji Expression, Bingo, Drawing Duel, and more
- **Drawing Board** — Real-time collaborative drawing canvas
- **Dark/Light Theme** — Toggle with persistent preference
- **Mobile-Friendly** — Responsive design for all devices

## Quick Start

```bash
cd tb
npm install
copy .env.example .env    # Windows
# cp .env.example .env    # Linux/Mac
npm start                  # → http://localhost:3000
npm test                   # Run integration tests
```

The first account created becomes the room owner and receives a single-use invite code. The second account registers using that code. A third account is always rejected (private two-person booth).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `STUN_URL` | `stun:stun.l.google.com:19302` | STUN server for WebRTC |
| `TURN_URL` | _(empty)_ | TURN server URL (needed for cross-network calls) |
| `TURN_USER` | _(empty)_ | TURN server username |
| `TURN_PASS` | _(empty)_ | TURN server credential |
| `SECURE_COOKIE` | `0` | Set to `1` behind HTTPS (required in production) |
| `MAX_ROUNDS` | `6` | Maximum photo rounds per session (1–6) |
| `DATA_FILE` | `./data.json` | Path to flat-file database |
| `MEDIA_DIR` | `./media` | Path to uploaded media directory |

## Production Deployment

Browsers require **HTTPS** for camera/mic access (localhost is excepted). Put the app behind a TLS reverse proxy (Caddy/nginx/Cloudflare Tunnel) or deploy to a platform like **Railway** that provides HTTPS automatically, then set `SECURE_COOKIE=1`.

For video calls across different networks, you need a **TURN server** (e.g., coturn or [Open Relay](https://www.metered.ca/tools/openrelay/)).

### Deploy to Railway
The project includes a `railway.toml` for one-click deployment:
1. Connect your GitHub repo to Railway
2. Set environment variables in Railway dashboard
3. Deploy — Railway handles build and start automatically

## Architecture
- **Backend**: Express.js + Socket.IO (Node.js ≥ 18)
- **Frontend**: Single-page vanilla HTML/CSS/JS (no build step needed)
- **Storage**: JSON flat-file + media folder (single-room design)
- **Auth**: bcrypt password hashing, session cookies, 2-user limit with invite codes
- **Real-time**: Socket.IO for chat, presence, game sync, photo booth coordination, and drawing
- **Video**: WebRTC peer-to-peer with STUN/TURN ICE servers
