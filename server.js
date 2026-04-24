const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HEARTBEAT_INTERVAL = 30_000;      // 30s ping/pong
const ROOM_CLEANUP_INTERVAL = 60_000;   // check every 60s
const ROOM_EMPTY_TTL = 60_000;          // delete room after 60s empty

// ──────────────────────────────────────────────
// Express – serve static frontend
// ──────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ── File uploads ──
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${req.params.roomId}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB max
});

app.post('/upload/:roomId', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/${req.file.filename}`;
  console.log(`[Upload] File saved: ${req.file.filename} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);
  res.json({ url, filename: req.file.originalname, size: req.file.size });
});

app.use('/uploads', express.static(UPLOADS_DIR));

const server = http.createServer(app);

// ──────────────────────────────────────────────
// Room store
// ──────────────────────────────────────────────
// rooms: Map<roomId, { hostId: string|null, peers: Map<peerId, WebSocket>, emptySince: number|null }>
const rooms = new Map();

function createRoom() {
  const roomId = uuidv4().slice(0, 8); // short 8-char ID
  rooms.set(roomId, {
    hostId: null,
    peers: new Map(),
    emptySince: null,
  });
  return roomId;
}

function getRoomInfo(roomId) {
  return rooms.get(roomId) || null;
}

function broadcastToRoom(roomId, message, excludePeerId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const [peerId, ws] of room.peers) {
    if (peerId !== excludePeerId && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function sendTo(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function sendToPeer(roomId, targetPeerId, message) {
  const room = rooms.get(roomId);
  if (!room) return;
  const ws = room.peers.get(targetPeerId);
  if (ws) sendTo(ws, message);
}

function removePeerFromRoom(peerId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.peers.delete(peerId);

  // If host left, notify everyone
  if (room.hostId === peerId) {
    room.hostId = null;
    broadcastToRoom(roomId, { type: 'host-left' });
  } else {
    broadcastToRoom(roomId, { type: 'peer-left', peerId });
  }

  // Mark room as empty if no peers remain
  if (room.peers.size === 0) {
    room.emptySince = Date.now();
  }

  console.log(`[Room ${roomId}] Peer ${peerId} removed. Remaining: ${room.peers.size}`);
}

// ──────────────────────────────────────────────
// WebSocket signaling server
// ──────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const peerId = uuidv4().slice(0, 12);
  ws._peerId = peerId;
  ws._roomId = null;
  ws._isAlive = true;

  console.log(`[WS] New connection: ${peerId}`);

  // Heartbeat pong handler
  ws.on('pong', () => {
    ws._isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendTo(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    console.log(`[WS] Disconnected: ${peerId}`);
    if (ws._roomId) {
      removePeerFromRoom(peerId, ws._roomId);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error for ${peerId}:`, err.message);
  });
});

function handleMessage(ws, msg) {
  const { type } = msg;

  switch (type) {
    // ── Room creation ──
    case 'create-room': {
      const roomId = createRoom();
      const room = rooms.get(roomId);
      room.hostId = ws._peerId;
      room.peers.set(ws._peerId, ws);
      room.emptySince = null;
      ws._roomId = roomId;

      sendTo(ws, { type: 'room-created', roomId, peerId: ws._peerId });
      console.log(`[Room ${roomId}] Created by host ${ws._peerId}`);
      break;
    }

    // ── Join existing room ──
    case 'join-room': {
      const { roomId, role } = msg;
      let room = getRoomInfo(roomId);

      // Auto-create room if host is rejoining after navigation
      if (!room && role === 'host') {
        rooms.set(roomId, {
          hostId: null,
          peers: new Map(),
          emptySince: null,
        });
        room = rooms.get(roomId);
        console.log(`[Room ${roomId}] Auto-created for host rejoin`);
      }

      if (!room) {
        sendTo(ws, { type: 'error', message: 'Room not found. It may have expired.' });
        return;
      }

      if (room.peers.size >= 6) {
        sendTo(ws, { type: 'error', message: 'Room is full (max 6 participants)' });
        return;
      }

      room.peers.set(ws._peerId, ws);
      room.emptySince = null;
      ws._roomId = roomId;

      // Auto-assign host if role=host or no host exists yet
      if (role === 'host' || !room.hostId) {
        room.hostId = ws._peerId;
      }

      const isHostPeer = room.hostId === ws._peerId;

      // Notify the joiner
      sendTo(ws, {
        type: 'room-joined',
        roomId,
        peerId: ws._peerId,
        hostId: room.hostId,
        isHost: isHostPeer,
        peerCount: room.peers.size,
      });

      // Notify the host that a new viewer joined (if joiner is not the host)
      if (!isHostPeer && room.hostId) {
        sendToPeer(roomId, room.hostId, {
          type: 'peer-joined',
          peerId: ws._peerId,
          peerCount: room.peers.size,
        });
      }

      // Notify other peers of updated count
      broadcastToRoom(roomId, {
        type: 'peer-count-update',
        peerCount: room.peers.size,
      }, ws._peerId);

      console.log(`[Room ${roomId}] Peer ${ws._peerId} joined as ${isHostPeer ? 'HOST' : 'viewer'}. Total: ${room.peers.size}`);
      break;
    }

    // ── WebRTC signaling: Offer ──
    case 'offer': {
      const { targetPeerId, sdp } = msg;
      if (!ws._roomId) return;
      console.log(`[Room ${ws._roomId}] Offer: ${ws._peerId} → ${targetPeerId}`);
      sendToPeer(ws._roomId, targetPeerId, {
        type: 'offer',
        peerId: ws._peerId,
        sdp,
      });
      break;
    }

    // ── WebRTC signaling: Answer ──
    case 'answer': {
      const { targetPeerId, sdp } = msg;
      if (!ws._roomId) return;
      console.log(`[Room ${ws._roomId}] Answer: ${ws._peerId} → ${targetPeerId}`);
      sendToPeer(ws._roomId, targetPeerId, {
        type: 'answer',
        peerId: ws._peerId,
        sdp,
      });
      break;
    }

    // ── WebRTC signaling: ICE Candidate ──
    case 'ice-candidate': {
      const { targetPeerId, candidate } = msg;
      if (!ws._roomId) return;
      sendToPeer(ws._roomId, targetPeerId, {
        type: 'ice-candidate',
        peerId: ws._peerId,
        candidate,
      });
      break;
    }

    // ── Host stopped sharing ──
    case 'sharing-stopped': {
      if (!ws._roomId) return;
      console.log(`[Room ${ws._roomId}] Host ${ws._peerId} stopped sharing`);
      broadcastToRoom(ws._roomId, {
        type: 'sharing-stopped',
        peerId: ws._peerId,
      }, ws._peerId);
      break;
    }

    // ── Watch Party: video sync ──
    case 'video-load':
    case 'video-play':
    case 'video-pause':
    case 'video-seek':
    case 'video-time-sync': {
      if (!ws._roomId) return;
      broadcastToRoom(ws._roomId, { ...msg, peerId: ws._peerId }, ws._peerId);
      break;
    }

    // ── Chat message ──
    case 'chat-message': {
      if (!ws._roomId) return;
      broadcastToRoom(ws._roomId, {
        type: 'chat-message',
        peerId: ws._peerId,
        nickname: msg.nickname || 'Anonymous',
        text: msg.text,
        timestamp: Date.now(),
      }, ws._peerId);
      break;
    }

    // ── Set nickname ──
    case 'set-nickname': {
      ws._nickname = msg.nickname;
      break;
    }

    default:
      sendTo(ws, { type: 'error', message: `Unknown message type: ${type}` });
  }
}

// ──────────────────────────────────────────────
// Heartbeat – detect stale connections
// ──────────────────────────────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws._isAlive) {
      console.log(`[WS] Terminating stale connection: ${ws._peerId}`);
      if (ws._roomId) removePeerFromRoom(ws._peerId, ws._roomId);
      return ws.terminate();
    }
    ws._isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// ──────────────────────────────────────────────
// Room cleanup – remove empty rooms
// ──────────────────────────────────────────────
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.peers.size === 0 && room.emptySince && now - room.emptySince > ROOM_EMPTY_TTL) {
      rooms.delete(roomId);
      console.log(`[Room ${roomId}] Cleaned up (empty for >${ROOM_EMPTY_TTL / 1000}s)`);
    }
  }
}, ROOM_CLEANUP_INTERVAL);

// ──────────────────────────────────────────────
// Graceful shutdown
// ──────────────────────────────────────────────
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('\n[Server] Shutting down...');
  clearInterval(heartbeat);
  clearInterval(cleanup);
  wss.close(() => {
    server.close(() => {
      console.log('[Server] Stopped.');
      process.exit(0);
    });
  });
}

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  🖥️  ScreenSync server running at http://localhost:${PORT}\n`);
});
