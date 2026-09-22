const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');

// Initialize Express app
const app = express();
const server = http.createServer(app);

app.use(express.json());

// Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.socket.io; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss: stun: turn: https://cdn.socket.io; frame-ancestors 'none';"
  );
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: "ok" });
});

// Dynamic ICE Servers Endpoint (supports STUN_SERVER & TURN environment variables safely)
app.get('/api/ice-servers', (req, res) => {
  const stunServer = process.env.STUN_SERVER || 'stun:stun.l.google.com:19302';
  const iceServers = [
    { urls: stunServer },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  const turnUrl = process.env.TURN_SERVER || process.env.TURN_URL;
  if (turnUrl) {
    const turnUrls = turnUrl.split(',').map(u => u.trim()).filter(Boolean);
    for (const url of turnUrls) {
      const turnConfig = { urls: url };
      if (process.env.TURN_USERNAME) turnConfig.username = process.env.TURN_USERNAME;
      if (process.env.TURN_PASSWORD) turnConfig.credential = process.env.TURN_PASSWORD;
      iceServers.push(turnConfig);
    }
  }

  res.json({ iceServers });
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Configure Socket.IO with CORS
const frontendOrigin = process.env.FRONTEND_ORIGIN || "*";
const io = socketIo(server, {
  cors: {
    origin: frontendOrigin,
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000
});

/**
 * Strict 1-to-1 Room Store
 * rooms[code] = {
 *   hostId: string,
 *   guestId: string | null,
 *   pendingGuestId: string | null,
 *   status: 'waiting' | 'pending' | 'connected' | 'closed',
 *   hostDisplayName: string,
 *   guestDisplayName: string | null,
 *   pendingDisplayName: string | null,
 *   pinHash: string | null,
 *   createdAt: number,
 *   lastActive: number
 * }
 */
const rooms = {};

// In-memory rate limiters
const pinAttemptLimits = {}; // { [key]: { count: number, resetAt: number } }
const roomCreationLimits = {}; // { [key]: { count: number, resetAt: number } }
const signalingLimits = {}; // { [socketId]: { count: number, resetAt: number } }

function checkPinRateLimit(key) {
  const now = Date.now();
  const record = pinAttemptLimits[key] || { count: 0, resetAt: now + 10 * 60 * 1000 };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + 10 * 60 * 1000;
  }

  if (record.count >= 5) {
    return false; // Rate limited (5 failed attempts per 10 min window)
  }

  record.count++;
  pinAttemptLimits[key] = record;
  return true;
}

function checkRoomCreateLimit(key) {
  const now = Date.now();
  const record = roomCreationLimits[key] || { count: 0, resetAt: now + 10 * 60 * 1000 };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + 10 * 60 * 1000;
  }

  if (record.count >= 10) {
    return false; // Rate limited (10 rooms per 10 min window)
  }

  record.count++;
  roomCreationLimits[key] = record;
  return true;
}

function checkSignalingRateLimit(socketId) {
  const now = Date.now();
  const record = signalingLimits[socketId] || { count: 0, resetAt: now + 10 * 1000 };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + 10 * 1000;
  }

  if (record.count >= 100) {
    return false; // Rate limited (max 100 signaling events per 10s)
  }

  record.count++;
  signalingLimits[socketId] = record;
  return true;
}

// Input validation & Cryptographically secure room code generation helpers
function isValidRoomCode(code) {
  return typeof code === 'string' && /^[A-Z0-9]{6}$/.test(code.trim().toUpperCase());
}

function generateSecureRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

function generateUniqueRoomCode() {
  let attempts = 0;
  while (attempts < 100) {
    const code = generateSecureRoomCode();
    if (!rooms[code]) return code;
    attempts++;
  }
  throw new Error("Unable to generate unique room code");
}

function sanitizeString(val, maxLen = 64) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

function touchRoom(room) {
  if (room) {
    room.lastActive = Date.now();
  }
}

function getRoomPair(room) {
  if (!room) return [];
  const pair = [];
  if (room.hostId) pair.push(room.hostId);
  if (room.guestId) pair.push(room.guestId);
  return pair;
}

function isAuthorizedPeerPair(room, socketId1, socketId2) {
  if (!room || !socketId1 || !socketId2) return false;
  const isHostGuest = (room.hostId === socketId1 && room.guestId === socketId2) ||
                      (room.hostId === socketId2 && room.guestId === socketId1);
  return isHostGuest;
}

// Express routes
app.post('/api/create-room-code', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  if (!checkRoomCreateLimit(clientIp)) {
    return res.status(429).json({ error: "Too many room creations. Please try again later." });
  }
  try {
    const code = generateUniqueRoomCode();
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate room code" });
  }
});

app.get('/room/:code', (req, res) => {
  const code = sanitizeString(req.params.code, 6).toUpperCase();
  if (!isValidRoomCode(code)) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Production Express Error Handler Middleware (never expose stack traces)
app.use((err, req, res, next) => {
  console.error('[Nexus Server Error]:', err.message);
  res.status(500).json({ error: "Internal Server Error" });
});

// Socket.IO Connection & Room Management
io.on("connection", (socket) => {
  const clientIp = socket.handshake.address || socket.id;

  // Check if room exists and whether it is PIN protected
  socket.on("check-room", ({ roomId }, callback) => {
    if (typeof callback !== 'function') return;
    if (!roomId || typeof roomId !== 'string') {
      return callback({ exists: false, protected: false, status: 'closed' });
    }
    const cleanCode = sanitizeString(roomId, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) {
      return callback({ exists: false, protected: false, status: 'closed' });
    }

    const room = rooms[cleanCode];
    if (!room || room.status === 'closed') {
      return callback({ exists: false, protected: false, status: 'closed' });
    }

    touchRoom(room);
    const memberCount = (room.hostId ? 1 : 0) + (room.guestId ? 1 : 0);
    const isFull = memberCount >= 2 || (room.pendingGuestId && room.pendingGuestId !== socket.id);

    callback({
      exists: true,
      protected: !!room.pinHash,
      status: room.status,
      maxMembers: 2,
      currentMembers: memberCount,
      isFull
    });
  });

  // Verify Room PIN securely on server
  socket.on("verify-room-pin", ({ roomId, pin }, callback) => {
    if (typeof callback !== 'function') return;
    if (!roomId || typeof roomId !== 'string') {
      return callback({ success: false, error: "ROOM_NOT_FOUND" });
    }

    const cleanCode = sanitizeString(roomId, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) {
      return callback({ success: false, error: "ROOM_NOT_FOUND" });
    }

    const rateLimitKey = `${clientIp}_${socket.id}`;
    if (!checkPinRateLimit(rateLimitKey)) {
      console.warn(`⚠️ Rate limited PIN verification for socket ${socket.id}`);
      return callback({ success: false, error: "TOO_MANY_ATTEMPTS" });
    }

    const room = rooms[cleanCode];
    if (!room || room.status === 'closed') {
      return callback({ success: false, error: "ROOM_NOT_FOUND" });
    }

    touchRoom(room);

    if (!room.pinHash) {
      if (!socket.validatedRooms) socket.validatedRooms = new Set();
      socket.validatedRooms.add(cleanCode);
      return callback({ success: true });
    }

    if (!pin || typeof pin !== 'string') {
      return callback({ success: false, error: "INVALID_PIN" });
    }

    const cleanPin = sanitizeString(pin, 32);
    const hash = crypto.createHash('sha256').update(cleanPin).digest('hex');

    if (hash !== room.pinHash) {
      return callback({ success: false, error: "INVALID_PIN" });
    }

    if (!socket.validatedRooms) socket.validatedRooms = new Set();
    socket.validatedRooms.add(cleanCode);

    callback({ success: true });
  });

  // Join / Create Room (Strict 1-to-1)
  socket.on("join-room", (roomCode, userId, pin, maxMembersInput, displayNameInput) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const displayName = sanitizeString(displayNameInput, 32) || 'User';

    if (!rooms[cleanCode]) {
      // Room creation
      if (!checkRoomCreateLimit(clientIp)) {
        socket.emit("error-message", "Too many rooms created. Please try again later.");
        return;
      }

      const now = Date.now();
      const roomData = {
        hostId: socket.id,
        guestId: null,
        pendingGuestId: null,
        status: 'waiting',
        hostDisplayName: displayName,
        guestDisplayName: null,
        pendingDisplayName: null,
        createdAt: now,
        lastActive: now
      };

      if (pin && typeof pin === 'string' && pin.trim().length > 0) {
        const cleanPin = sanitizeString(pin, 32);
        roomData.pinHash = crypto.createHash('sha256').update(cleanPin).digest('hex');
      }

      rooms[cleanCode] = roomData;
      socket.join(cleanCode);
      console.log(`👑 Host created 1-to-1 room: ${cleanCode} ${roomData.pinHash ? '[PIN Protected]' : ''}`);

      socket.emit("room-joined", {
        isHost: true,
        role: 'host',
        maxMembers: 2,
        members: [{ socketId: socket.id, displayName, isHost: true }]
      });
    } else {
      // Room exists
      const room = rooms[cleanCode];
      touchRoom(room);

      if (socket.id === room.hostId) {
        // Host rejoining
        room.hostDisplayName = displayName;
        socket.join(cleanCode);
        const members = [{ socketId: socket.id, displayName, isHost: true }];
        if (room.guestId) {
          members.push({ socketId: room.guestId, displayName: room.guestDisplayName || 'Guest', isHost: false });
        }
        socket.emit("room-joined", {
          isHost: true,
          role: 'host',
          maxMembers: 2,
          members
        });
        return;
      }

      if (socket.id === room.guestId) {
        // Guest rejoining
        room.guestDisplayName = displayName;
        socket.join(cleanCode);
        const members = [
          { socketId: room.hostId, displayName: room.hostDisplayName || 'Host', isHost: true },
          { socketId: socket.id, displayName, isHost: false }
        ];
        socket.emit("room-joined", {
          isHost: false,
          role: 'guest',
          maxMembers: 2,
          members
        });
        return;
      }

      // Check if room already has guest or pending guest
      if (room.guestId || (room.pendingGuestId && room.pendingGuestId !== socket.id)) {
        console.log(`⚠️ Room ${cleanCode} is full (Strict 1-to-1). Rejecting third user ${socket.id}`);
        socket.emit("room-full");
        return;
      }

      // Security check: Guest must be validated if PIN is set
      if (room.pinHash) {
        const isValidated = socket.validatedRooms && socket.validatedRooms.has(cleanCode);
        const cleanPin = pin ? sanitizeString(String(pin), 32) : '';
        const isPinMatch = cleanPin && crypto.createHash('sha256').update(cleanPin).digest('hex') === room.pinHash;

        if (!isValidated && !isPinMatch) {
          console.warn(`🔒 Room ${cleanCode} PIN protected. Rejecting unauthorized join-room from ${socket.id}`);
          socket.emit("pin-required");
          return;
        }

        if (isPinMatch && !isValidated) {
          if (!socket.validatedRooms) socket.validatedRooms = new Set();
          socket.validatedRooms.add(cleanCode);
        }
      }

      // Guest requesting entry (Pending status)
      room.pendingGuestId = socket.id;
      room.pendingDisplayName = displayName;
      room.status = 'pending';
      socket.join(cleanCode);

      console.log(`👤 Guest (${displayName} / ${socket.id}) requesting entry in room ${cleanCode}`);

      // Forward join request to host
      io.to(room.hostId).emit("request-join", { socketId: socket.id, displayName });
    }
  });

  // Host accepts guest
  socket.on("accept", (roomCode, targetSocketId) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const room = rooms[cleanCode];
    if (!room || room.hostId !== socket.id) return; // Strict Host validation

    touchRoom(room);

    const guestId = targetSocketId || room.pendingGuestId;
    if (!guestId || (room.pendingGuestId && room.pendingGuestId !== guestId)) return;

    room.guestId = guestId;
    room.guestDisplayName = room.pendingDisplayName || 'Guest';
    room.pendingGuestId = null;
    room.pendingDisplayName = null;
    room.status = 'connected';

    const members = [
      { socketId: room.hostId, displayName: room.hostDisplayName, isHost: true },
      { socketId: room.guestId, displayName: room.guestDisplayName, isHost: false }
    ];

    console.log(`🤝 Host ${socket.id} accepted Guest ${guestId} in room ${cleanCode}`);

    // Notify Guest of acceptance
    io.to(guestId).emit("accepted", {
      members,
      maxMembers: 2,
      hostId: room.hostId,
      hostDisplayName: room.hostDisplayName
    });

    // Notify Host that user joined
    socket.emit("user-joined", {
      socketId: guestId,
      displayName: room.guestDisplayName,
      members
    });
  });

  // Host rejects guest
  socket.on("reject", (roomCode, targetSocketId) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const room = rooms[cleanCode];
    if (!room || room.hostId !== socket.id) return;

    touchRoom(room);
    const guestId = targetSocketId || room.pendingGuestId;
    if (guestId) {
      console.log(`🚫 Host ${socket.id} rejected Guest ${guestId} in room ${cleanCode}`);
      io.to(guestId).emit("rejected");
      if (room.pendingGuestId === guestId) {
        room.pendingGuestId = null;
        room.pendingDisplayName = null;
        room.status = 'waiting';
      }
    }
  });

  // Targeted & Validated WebRTC Signaling
  socket.on("offer", (roomCode, offer, targetSocketId) => {
    if (!roomCode || typeof roomCode !== 'string' || !offer || typeof offer !== 'object') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;
    if (!checkSignalingRateLimit(socket.id)) return;

    const room = rooms[cleanCode];
    if (!room) return;

    // Strict validation: must be room's host or guest, and target must be the counter-peer
    const targetId = targetSocketId || (socket.id === room.hostId ? room.guestId : room.hostId);
    if (!targetId || !isAuthorizedPeerPair(room, socket.id, targetId)) {
      return;
    }

    touchRoom(room);
    const senderName = socket.id === room.hostId ? room.hostDisplayName : room.guestDisplayName;
    io.to(targetId).emit("offer", { offer, senderId: socket.id, senderName });
  });

  socket.on("answer", (roomCode, answer, targetSocketId) => {
    if (!roomCode || typeof roomCode !== 'string' || !answer || typeof answer !== 'object') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;
    if (!checkSignalingRateLimit(socket.id)) return;

    const room = rooms[cleanCode];
    if (!room) return;

    const targetId = targetSocketId || (socket.id === room.hostId ? room.guestId : room.hostId);
    if (!targetId || !isAuthorizedPeerPair(room, socket.id, targetId)) {
      return;
    }

    touchRoom(room);
    io.to(targetId).emit("answer", { answer, senderId: socket.id });
  });

  socket.on("ice-candidate", (roomCode, candidate, targetSocketId) => {
    if (!roomCode || typeof roomCode !== 'string' || !candidate) return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;
    if (!checkSignalingRateLimit(socket.id)) return;

    const room = rooms[cleanCode];
    if (!room) return;

    const targetId = targetSocketId || (socket.id === room.hostId ? room.guestId : room.hostId);
    if (!targetId || !isAuthorizedPeerPair(room, socket.id, targetId)) {
      return;
    }

    touchRoom(room);
    io.to(targetId).emit("ice-candidate", { candidate, senderId: socket.id });
  });

  // Media state signaling (mic, cam, screen share)
  socket.on("peer-state-change", (roomCode, state) => {
    if (!roomCode || typeof roomCode !== 'string' || !state || typeof state !== 'object') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const room = rooms[cleanCode];
    if (!room) return;

    const targetId = socket.id === room.hostId ? room.guestId : room.hostId;
    if (targetId) {
      touchRoom(room);
      io.to(targetId).emit("peer-state-change", {
        socketId: socket.id,
        ...state
      });
    }
  });

  socket.on("screen-share-state", (roomCode, isSharing) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const room = rooms[cleanCode];
    if (!room) return;

    const targetId = socket.id === room.hostId ? room.guestId : room.hostId;
    if (targetId) {
      touchRoom(room);
      io.to(targetId).emit("screen-share-state", !!isSharing);
    }
  });

  // Disconnect Cleanup
  socket.on("disconnect", () => {
    delete pinAttemptLimits[socket.id];
    delete signalingLimits[socket.id];

    for (const code in rooms) {
      const room = rooms[code];

      // Case 1: Pending guest canceled / disconnected
      if (room.pendingGuestId === socket.id) {
        room.pendingGuestId = null;
        room.pendingDisplayName = null;
        room.status = room.guestId ? 'connected' : 'waiting';
        io.to(room.hostId).emit("guest-canceled", { socketId: socket.id });
      }

      // Case 2: Host disconnected
      if (room.hostId === socket.id) {
        console.log(`🧹 Host disconnected from room ${code}`);
        if (room.guestId) {
          io.to(room.guestId).emit("peer-disconnected", { socketId: socket.id, role: 'host' });
          io.to(room.guestId).emit("user-left", { socketId: socket.id });
        }
        delete rooms[code];
      }
      // Case 3: Guest disconnected
      else if (room.guestId === socket.id) {
        console.log(`🧹 Guest disconnected from room ${code}`);
        room.guestId = null;
        room.guestDisplayName = null;
        room.status = 'waiting';
        io.to(room.hostId).emit("peer-disconnected", { socketId: socket.id, role: 'guest' });
        io.to(room.hostId).emit("user-left", { socketId: socket.id });
      }
    }
  });
});

// Periodic inactive room cleanup (checks every 15 minutes)
setInterval(() => {
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const FOUR_HOURS = 4 * 60 * 60 * 1000;

  for (const code in rooms) {
    const room = rooms[code];
    const isInactive = now - (room.lastActive || room.createdAt) > TWO_HOURS;
    const isExpired = now - room.createdAt > FOUR_HOURS;

    if (isInactive || isExpired) {
      console.log(`🧹 Cleaning up inactive/expired room: ${code}`);
      delete rooms[code];
    }
  }
}, 15 * 60 * 1000);

// Handle server errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`⚠️ Port ${process.env.PORT || 3000} is already in use.`);
  } else {
    console.error('Server error:', err.message);
  }
});

// Start server with automatic fallback if default port is in use
let PORT = process.env.PORT || 3000;

function listen(port) {
  server.listen(port, () => {
    console.log(`✅ Nexus 1-to-1 WebRTC Signaling server running on http://localhost:${port}`);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !process.env.PORT) {
    console.warn(`⚠️ Port ${PORT} is in use, trying port ${PORT + 1}...`);
    PORT++;
    listen(PORT);
  } else if (err.code === 'EADDRINUSE') {
    console.error(`⚠️ Port ${PORT} is already in use.`);
  } else {
    console.error('Server error:', err.message);
  }
});

listen(PORT);

