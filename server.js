const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');

// Initialize Express app
const app = express();
const server = http.createServer(app);

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

// Dynamic ICE Servers Endpoint (supports TURN environment variables safely)
app.get('/api/ice-servers', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  if (process.env.TURN_URL) {
    const turnUrls = process.env.TURN_URL.split(',').map(u => u.trim()).filter(Boolean);
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
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// In-memory room tracking: { [code]: { hostId: string, guestId?: string, pendingId?: string, createdAt: number, lastActive: number, pinHash?: string } }
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

  if (record.count >= 60) {
    return false; // Rate limited (max 60 signaling events per 10s)
  }

  record.count++;
  signalingLimits[socketId] = record;
  return true;
}

// Input validation helpers
function isValidRoomCode(code) {
  return typeof code === 'string' && /^[A-Z0-9]{6}$/.test(code.trim().toUpperCase());
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

// Helper for socket membership check
function isSocketInRoom(socket, roomCode) {
  return socket.rooms && socket.rooms.has(roomCode);
}

// Express routes
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

  // Check if room exists and whether it is PIN protected (Without exposing PIN)
  socket.on("check-room", ({ roomId }, callback) => {
    if (typeof callback !== 'function') return;
    if (!roomId || typeof roomId !== 'string') {
      return callback({ exists: false, protected: false });
    }
    const cleanCode = sanitizeString(roomId, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) {
      return callback({ exists: false, protected: false });
    }

    const room = rooms[cleanCode];
    if (!room) {
      return callback({ exists: false, protected: false });
    }

    touchRoom(room);
    callback({
      exists: true,
      protected: !!room.pinHash
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
    if (!room) {
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

  // Join / Create Room with optional PIN
  socket.on("join-room", (roomCode, userId, pin) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    if (!rooms[cleanCode]) {
      // Creation Rate Limit Check
      if (!checkRoomCreateLimit(clientIp)) {
        socket.emit("error-message", "Too many rooms created. Please try again later.");
        return;
      }

      // Host creates room
      const now = Date.now();
      const roomData = {
        hostId: socket.id,
        createdAt: now,
        lastActive: now
      };

      if (pin && typeof pin === 'string' && pin.trim().length > 0) {
        const cleanPin = sanitizeString(pin, 32);
        roomData.pinHash = crypto.createHash('sha256').update(cleanPin).digest('hex');
      }

      rooms[cleanCode] = roomData;
      socket.join(cleanCode);
      console.log(`👑 Host created room: ${cleanCode} ${roomData.pinHash ? '[PIN Protected]' : ''}`);
    } else {
      // Room exists
      const room = rooms[cleanCode];
      touchRoom(room);

      // Server-Side Capacity Check: Exactly 1 host + 1 guest max
      const isHost = socket.id === room.hostId;
      const isExistingGuest = socket.id === room.guestId;
      const isPendingGuest = socket.id === room.pendingId;

      if (!isHost && !isExistingGuest && !isPendingGuest) {
        if (room.guestId || room.pendingId) {
          console.log(`⚠️ Room ${cleanCode} is full. Rejecting socket ${socket.id}`);
          socket.emit("room-full");
          return;
        }
      }

      // Security check: Guest must be validated if PIN is set
      if (room.pinHash && !isHost) {
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

      if (isHost) {
        // Host rejoining
        socket.join(cleanCode);
      } else {
        // Guest joining
        room.pendingId = socket.id;
        socket.join(cleanCode);
        console.log(`👤 Guest pending in room ${cleanCode}`);

        // Notify host
        io.to(room.hostId).emit("request-join");
      }
    }
  });

  // Validate Guest PIN
  socket.on("validate-pin", (roomCode, pin) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const rateLimitKey = `${clientIp}_${socket.id}`;
    if (!checkPinRateLimit(rateLimitKey)) {
      socket.emit("incorrect-pin", "TOO_MANY_ATTEMPTS");
      return;
    }

    const room = rooms[cleanCode];
    if (!room) {
      socket.emit("room-not-found");
      return;
    }

    touchRoom(room);

    // Capacity Check
    if (room.guestId || (room.pendingId && room.pendingId !== socket.id)) {
      socket.emit("room-full");
      return;
    }

    if (!room.pinHash) {
      if (!socket.validatedRooms) socket.validatedRooms = new Set();
      socket.validatedRooms.add(cleanCode);
      socket.emit("pin-valid");
      return;
    }

    if (!pin || typeof pin !== 'string') {
      socket.emit("incorrect-pin");
      return;
    }

    const cleanPin = sanitizeString(pin, 32);
    const hash = crypto.createHash('sha256').update(cleanPin).digest('hex');

    if (hash === room.pinHash) {
      if (!socket.validatedRooms) socket.validatedRooms = new Set();
      socket.validatedRooms.add(cleanCode);
      socket.emit("pin-valid");

      room.pendingId = socket.id;
      socket.join(cleanCode);
      io.to(room.hostId).emit("request-join");
    } else {
      socket.emit("incorrect-pin");
    }
  });

  // Host accepts guest
  socket.on("accept", (roomCode) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const room = rooms[cleanCode];
    if (room && room.hostId === socket.id && room.pendingId) {
      touchRoom(room);
      room.guestId = room.pendingId;
      const guestSocketId = room.pendingId;
      delete room.pendingId;

      io.to(guestSocketId).emit("accepted");
    }
  });

  // Host rejects guest
  socket.on("reject", (roomCode) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const room = rooms[cleanCode];
    if (room && room.hostId === socket.id && room.pendingId) {
      touchRoom(room);
      io.to(room.pendingId).emit("rejected");
      delete room.pendingId;
    }
  });

  // WebRTC Signaling Forwarding (With Room Membership & Rate Limit Check)
  socket.on("offer", (roomCode, offer) => {
    if (!roomCode || typeof roomCode !== 'string' || !offer || typeof offer !== 'object') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    if (!checkSignalingRateLimit(socket.id)) return;

    const room = rooms[cleanCode];
    if (room && isSocketInRoom(socket, cleanCode)) {
      touchRoom(room);
      socket.broadcast.to(cleanCode).emit("offer", offer);
    }
  });

  socket.on("answer", (roomCode, answer) => {
    if (!roomCode || typeof roomCode !== 'string' || !answer || typeof answer !== 'object') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    if (!checkSignalingRateLimit(socket.id)) return;

    const room = rooms[cleanCode];
    if (room && isSocketInRoom(socket, cleanCode)) {
      touchRoom(room);
      socket.broadcast.to(cleanCode).emit("answer", answer);
    }
  });

  socket.on("ice-candidate", (roomCode, candidate) => {
    if (!roomCode || typeof roomCode !== 'string' || !candidate) return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    if (!checkSignalingRateLimit(socket.id)) return;

    const room = rooms[cleanCode];
    if (room && isSocketInRoom(socket, cleanCode)) {
      touchRoom(room);
      socket.broadcast.to(cleanCode).emit("ice-candidate", candidate);
    }
  });

  // Screen share state signaling
  socket.on("screen-share-state", (roomCode, isSharing) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const room = rooms[cleanCode];
    if (room && isSocketInRoom(socket, cleanCode)) {
      touchRoom(room);
      socket.broadcast.to(cleanCode).emit("screen-share-state", !!isSharing);
    }
  });

  // Cleanup on disconnect
  socket.on("disconnect", () => {
    delete pinAttemptLimits[socket.id];
    delete signalingLimits[socket.id];

    for (const code in rooms) {
      const room = rooms[code];
      if (room.hostId === socket.id) {
        if (room.pendingId) io.to(room.pendingId).emit("rejected");
        if (room.guestId) io.to(room.guestId).emit("peer-disconnected");
        delete rooms[code];
      } else if (room.pendingId === socket.id) {
        delete room.pendingId;
        io.to(room.hostId).emit("guest-canceled");
      } else if (room.guestId === socket.id) {
        delete room.guestId;
        io.to(room.hostId).emit("peer-disconnected");
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

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Signaling server running on port ${PORT}`);
});
