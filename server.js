const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

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
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.socket.io; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob: http: https:; connect-src 'self' ws: wss: stun: turn: https: http: https://cdn.socket.io; frame-ancestors 'none';"
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

// Helper to inspect HTTP/HTTPS media response headers without downloading file
function inspectRemoteMediaHeaders(targetUrl, redirectCount = 0) {
  return new Promise((resolve) => {
    if (redirectCount > 5) {
      return resolve({ success: false, error: 'Too many HTTP redirects.' });
    }

    try {
      const parsedUrl = new URL(targetUrl);
      const httpModule = parsedUrl.protocol === 'https:' ? https : http;

      const reqOptions = {
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Range': 'bytes=0-2048'
        },
        timeout: 8000
      };

      const req = httpModule.request(targetUrl, reqOptions, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, targetUrl).toString();
          return resolve(inspectRemoteMediaHeaders(redirectUrl, redirectCount + 1));
        }

        const statusCode = res.statusCode;
        const contentType = res.headers['content-type'] || '';
        const contentLength = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
        const acceptRanges = res.headers['accept-ranges'] || '';
        const contentRange = res.headers['content-range'] || '';

        if (statusCode === 405 || (statusCode === 403 && redirectCount === 0)) {
          const getReqOptions = {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              'Range': 'bytes=0-1024'
            },
            timeout: 8000
          };
          const getReq = httpModule.request(targetUrl, getReqOptions, (gRes) => {
            const gStatus = gRes.statusCode;
            const gType = gRes.headers['content-type'] || '';
            const gLen = gRes.headers['content-length'] ? parseInt(gRes.headers['content-length'], 10) : null;
            const gRanges = gRes.headers['accept-ranges'] || '';
            gRes.destroy();

            resolve({
              success: gStatus >= 200 && gStatus < 400,
              statusCode: gStatus,
              contentType: gType,
              contentLength: gLen,
              acceptRanges: gRanges,
              url: targetUrl
            });
          });
          getReq.on('error', (err) => resolve({ success: false, error: err.message }));
          getReq.end();
          return;
        }

        res.destroy();

        if (statusCode === 403 || statusCode === 410) {
          return resolve({ success: false, statusCode, error: 'Stream URL expired. Please provide a new URL.' });
        }
        if (statusCode === 404) {
          return resolve({ success: false, statusCode, error: 'Media stream not found (404). Please verify the URL.' });
        }

        resolve({
          success: statusCode >= 200 && statusCode < 400,
          statusCode,
          contentType,
          contentLength,
          acceptRanges,
          contentRange,
          url: targetUrl
        });
      });

      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Network timeout connecting to media server.' });
      });
      req.end();
    } catch (err) {
      resolve({ success: false, error: 'Invalid URL format.' });
    }
  });
}

// Media Header Inspection Endpoint
app.post('/api/detect-media', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
    return res.status(400).json({ success: false, error: 'Invalid HTTP/HTTPS media URL' });
  }

  try {
    const result = await inspectRemoteMediaHeaders(url.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to inspect media headers' });
  }
});

// Progressive Server-Side Streaming Compatibility Pipeline
app.get('/api/stream-pipeline', (req, res) => {
  const mediaUrl = req.query.url;
  if (!mediaUrl || typeof mediaUrl !== 'string' || !/^https?:\/\//i.test(mediaUrl.trim())) {
    return res.status(400).json({ error: 'Invalid HTTP/HTTPS media URL' });
  }

  const cleanUrl = mediaUrl.trim();

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'keep-alive');

  const ffmpegArgs = [
    '-re',
    '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
    '-i', cleanUrl,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  ];

  let ffmpegProc = null;
  try {
    ffmpegProc = spawn('ffmpeg', ffmpegArgs);
  } catch (err) {
    return res.status(501).json({ error: 'FFmpeg compatibility pipeline is not available on server.' });
  }

  ffmpegProc.stdout.pipe(res);

  ffmpegProc.on('error', (err) => {
    console.warn('[Nexus Stream Pipeline] FFmpeg spawn error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Media compatibility processing error.' });
    }
  });

  req.on('close', () => {
    if (ffmpegProc) {
      try { ffmpegProc.kill('SIGKILL'); } catch (e) {}
    }
  });
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
 * Multi-Participant Room Store
 * rooms[code] = {
 *   hostId: string,
 *   maxParticipants: number,
 *   pinHash: string | null,
 *   status: 'waiting' | 'active' | 'closed',
 *   participants: Map<socketId, { socketId: string, displayName: string, joinedAt: number, isHost: boolean }>,
 *   pendingParticipants: Map<socketId, { socketId: string, displayName: string, requestedAt: number }>,
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

function getRoomMembers(room) {
  if (!room || !room.participants) return [];
  return Array.from(room.participants.values());
}

function isRoomMember(room, socketId) {
  return !!(room && room.participants && room.participants.has(socketId));
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
    const memberCount = room.participants.size;
    const isFull = memberCount >= room.maxParticipants;

    callback({
      exists: true,
      protected: !!room.pinHash,
      status: room.status,
      maxMembers: room.maxParticipants,
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

  // Join / Create Multi-Participant Room
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

      let parsedMax = parseInt(maxMembersInput, 10);
      if (isNaN(parsedMax) || parsedMax < 2) parsedMax = 2;
      if (parsedMax > 50) parsedMax = 50;

      const now = Date.now();
      const roomData = {
        hostId: socket.id,
        maxParticipants: parsedMax,
        pinHash: null,
        status: 'waiting',
        participants: new Map(),
        pendingParticipants: new Map(),
        createdAt: now,
        lastActive: now
      };

      if (pin && typeof pin === 'string' && pin.trim().length > 0) {
        const cleanPin = sanitizeString(pin, 32);
        roomData.pinHash = crypto.createHash('sha256').update(cleanPin).digest('hex');
      }

      roomData.participants.set(socket.id, {
        socketId: socket.id,
        displayName,
        joinedAt: now,
        isHost: true
      });

      rooms[cleanCode] = roomData;
      socket.join(cleanCode);
      console.log(`👑 Host created room: ${cleanCode} (Max: ${parsedMax}) ${roomData.pinHash ? '[PIN Protected]' : ''}`);

      socket.emit("room-joined", {
        isHost: true,
        role: 'host',
        maxMembers: parsedMax,
        members: getRoomMembers(roomData),
        socketId: socket.id
      });
    } else {
      // Room exists
      const room = rooms[cleanCode];
      touchRoom(room);

      // Rejoining participant
      if (room.participants.has(socket.id)) {
        const member = room.participants.get(socket.id);
        member.displayName = displayName;
        socket.join(cleanCode);

        socket.emit("room-joined", {
          isHost: member.isHost,
          role: member.isHost ? 'host' : 'participant',
          maxMembers: room.maxParticipants,
          members: getRoomMembers(room),
          socketId: socket.id
        });
        return;
      }

      // Check if room is locked
      if (room.isLocked) {
        console.log(`🔒 Room ${cleanCode} is locked. Rejecting join-room from ${socket.id}`);
        socket.emit("room-locked");
        return;
      }

      // Check capacity
      if (room.participants.size >= room.maxParticipants) {
        console.log(`⚠️ Room ${cleanCode} is full (${room.participants.size}/${room.maxParticipants}). Rejecting ${socket.id}`);
        socket.emit("room-full");
        return;
      }

      // Security check: Participant must be validated if PIN is set
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

      // Participant requesting entry (Pending status)
      room.pendingParticipants.set(socket.id, {
        socketId: socket.id,
        displayName,
        requestedAt: Date.now()
      });
      socket.join(cleanCode);

      console.log(`👤 Participant (${displayName} / ${socket.id}) requesting entry in room ${cleanCode}`);

      // Forward request to host
      io.to(room.hostId).emit("request-join", { socketId: socket.id, displayName });
    }
  });

  // Host accepts pending participant
  socket.on("accept", (roomCode, targetSocketId) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const room = rooms[cleanCode];
    if (!room || room.hostId !== socket.id) return; // Strict Host validation

    touchRoom(room);

    if (!targetSocketId || !room.pendingParticipants.has(targetSocketId)) return;

    if (room.participants.size >= room.maxParticipants) {
      io.to(targetSocketId).emit("room-full");
      return;
    }

    const pendingUser = room.pendingParticipants.get(targetSocketId);
    room.pendingParticipants.delete(targetSocketId);

    const newMember = {
      socketId: targetSocketId,
      displayName: pendingUser.displayName || 'Participant',
      joinedAt: Date.now(),
      isHost: false
    };

    room.participants.set(targetSocketId, newMember);
    room.status = 'active';

    const allMembers = getRoomMembers(room);

    console.log(`🤝 Host ${socket.id} accepted Participant ${targetSocketId} (${newMember.displayName}) in room ${cleanCode}`);

    // Notify Accepted Participant
    io.to(targetSocketId).emit("accepted", {
      members: allMembers,
      maxMembers: room.maxParticipants,
      hostId: room.hostId,
      socketId: targetSocketId
    });

    // Notify all existing room participants about the new joiner
    room.participants.forEach((m, sid) => {
      if (sid !== targetSocketId) {
        io.to(sid).emit("user-joined", {
          socketId: targetSocketId,
          displayName: newMember.displayName,
          members: allMembers
        });
      }
    });
  });

  // Host rejects pending participant
  socket.on("reject", (roomCode, targetSocketId) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const room = rooms[cleanCode];
    if (!room || room.hostId !== socket.id) return;

    touchRoom(room);

    if (targetSocketId && room.pendingParticipants.has(targetSocketId)) {
      room.pendingParticipants.delete(targetSocketId);
      console.log(`🚫 Host ${socket.id} rejected Participant ${targetSocketId} in room ${cleanCode}`);
      io.to(targetSocketId).emit("rejected");
    }
  });

  // Host kicks participant
  socket.on("kick-participant", (roomCode, targetSocketId) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const room = rooms[cleanCode];
    if (!room || room.hostId !== socket.id) return;

    if (targetSocketId && room.participants.has(targetSocketId) && targetSocketId !== room.hostId) {
      room.participants.delete(targetSocketId);
      console.log(`🥾 Host ${socket.id} kicked participant ${targetSocketId} from room ${cleanCode}`);

      io.to(targetSocketId).emit("kicked");

      const allMembers = getRoomMembers(room);
      room.participants.forEach((m, sid) => {
        io.to(sid).emit("user-left", { socketId: targetSocketId, members: allMembers });
      });
    }
  });

  // Host changes max participants
  socket.on("change-max-participants", (roomCode, newMaxInput) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    if (!isValidRoomCode(cleanCode)) return;

    const room = rooms[cleanCode];
    if (!room || room.hostId !== socket.id) return;

    let newMax = parseInt(newMaxInput, 10);
    if (isNaN(newMax) || newMax < 2) newMax = 2;
    if (newMax > 50) newMax = 50;

    room.maxParticipants = newMax;
    touchRoom(room);

    console.log(`⚙️ Host ${socket.id} updated room ${cleanCode} capacity to ${newMax}`);

    const allMembers = getRoomMembers(room);
    room.participants.forEach((m, sid) => {
      io.to(sid).emit("room-settings-updated", { maxMembers: newMax, members: allMembers });
    });
  });

  // Targeted & Validated WebRTC Signaling
  socket.on("offer", (roomCode, offer, targetSocketId) => {
    if (!roomCode || !offer || !targetSocketId || !checkSignalingRateLimit(socket.id)) return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || !isRoomMember(room, socket.id) || !isRoomMember(room, targetSocketId)) return;

    touchRoom(room);
    const sender = room.participants.get(socket.id);
    io.to(targetSocketId).emit("offer", { offer, senderId: socket.id, senderName: sender.displayName });
  });

  socket.on("answer", (roomCode, answer, targetSocketId) => {
    if (!roomCode || !answer || !targetSocketId || !checkSignalingRateLimit(socket.id)) return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || !isRoomMember(room, socket.id) || !isRoomMember(room, targetSocketId)) return;

    touchRoom(room);
    io.to(targetSocketId).emit("answer", { answer, senderId: socket.id });
  });

  socket.on("ice-candidate", (roomCode, candidate, targetSocketId) => {
    if (!roomCode || !candidate || !targetSocketId || !checkSignalingRateLimit(socket.id)) return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || !isRoomMember(room, socket.id) || !isRoomMember(room, targetSocketId)) return;

    touchRoom(room);
    io.to(targetSocketId).emit("ice-candidate", { candidate, senderId: socket.id });
  });

  // Media state signaling (mic, cam, screen share)
  socket.on("peer-state-change", (roomCode, state, targetSocketId) => {
    if (!roomCode || typeof roomCode !== 'string' || !state) return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || !isRoomMember(room, socket.id)) return;

    touchRoom(room);
    if (targetSocketId && isRoomMember(room, targetSocketId)) {
      io.to(targetSocketId).emit("peer-state-change", { socketId: socket.id, ...state });
    } else {
      room.participants.forEach((m, sid) => {
        if (sid !== socket.id) {
          io.to(sid).emit("peer-state-change", { socketId: socket.id, ...state });
        }
      });
    }
  });

  socket.on("screen-share-state", (roomCode, isSharing) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || !isRoomMember(room, socket.id)) return;

    touchRoom(room);
    room.participants.forEach((m, sid) => {
      if (sid !== socket.id) {
        io.to(sid).emit("screen-share-state", { socketId: socket.id, isSharing: !!isSharing });
      }
    });
  });

  // Host toggles room lock state
  socket.on("room-lock-state", (roomCode, isLocked) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || room.hostId !== socket.id) return;

    room.isLocked = !!isLocked;
    touchRoom(room);

    console.log(`🔒 Host ${socket.id} set room ${cleanCode} lock state: ${room.isLocked}`);

    const allMembers = getRoomMembers(room);
    room.participants.forEach((m, sid) => {
      io.to(sid).emit("room-lock-state", { isLocked: room.isLocked, members: allMembers });
    });
  });

  // Participant raises / lowers hand
  socket.on("raise-hand-state", (roomCode, isRaised) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || !isRoomMember(room, socket.id)) return;

    touchRoom(room);
    room.participants.forEach((m, sid) => {
      if (sid !== socket.id) {
        io.to(sid).emit("raise-hand-state", { socketId: socket.id, isRaised: !!isRaised });
      }
    });
  });

  // Participant sends reaction emoji
  socket.on("reaction", (roomCode, emoji) => {
    if (!roomCode || typeof roomCode !== 'string' || !emoji) return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || !isRoomMember(room, socket.id)) return;

    const cleanEmoji = sanitizeString(String(emoji), 8);
    touchRoom(room);
    room.participants.forEach((m, sid) => {
      if (sid !== socket.id) {
        io.to(sid).emit("reaction", { socketId: socket.id, emoji: cleanEmoji });
      }
    });
  });

  // Media stream URL sharing (MP4, WebM, HLS)
  socket.on("stream-share-start", (roomCode, payload) => {
    if (!roomCode || typeof roomCode !== 'string' || !payload) return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || !isRoomMember(room, socket.id)) return;

    touchRoom(room);
    room.participants.forEach((m, sid) => {
      if (sid !== socket.id) {
        io.to(sid).emit("stream-share-start", { senderId: socket.id, ...payload });
      }
    });
  });

  socket.on("stream-share-stop", (roomCode) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || !isRoomMember(room, socket.id)) return;

    touchRoom(room);
    room.participants.forEach((m, sid) => {
      if (sid !== socket.id) {
        io.to(sid).emit("stream-share-stop", { senderId: socket.id });
      }
    });
  });

  socket.on("stream-share-action", (roomCode, actionData) => {
    if (!roomCode || typeof roomCode !== 'string' || !actionData) return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || !isRoomMember(room, socket.id)) return;

    touchRoom(room);
    room.participants.forEach((m, sid) => {
      if (sid !== socket.id) {
        io.to(sid).emit("stream-share-action", { senderId: socket.id, ...actionData });
      }
    });
  });

  // Host mutes all participants
  socket.on("mute-all", (roomCode) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || room.hostId !== socket.id) return;

    touchRoom(room);
    room.participants.forEach((m, sid) => {
      if (sid !== socket.id) {
        io.to(sid).emit("muted-by-host");
      }
    });
  });

  socket.on("chat-message", (roomCode, payload, targetSocketId) => {
    if (!roomCode || !payload) return;
    const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
    const room = rooms[cleanCode];
    if (!room || !isRoomMember(room, socket.id)) return;

    touchRoom(room);
    if (targetSocketId && isRoomMember(room, targetSocketId)) {
      io.to(targetSocketId).emit("chat-message", { senderId: socket.id, ...payload });
    } else {
      room.participants.forEach((m, sid) => {
        if (sid !== socket.id) {
          io.to(sid).emit("chat-message", { senderId: socket.id, ...payload });
        }
      });
    }
  });

  // Disconnect Cleanup
  socket.on("disconnect", () => {
    delete pinAttemptLimits[socket.id];
    delete signalingLimits[socket.id];

    for (const code in rooms) {
      const room = rooms[code];

      // Case 1: Pending participant canceled / disconnected
      if (room.pendingParticipants.has(socket.id)) {
        room.pendingParticipants.delete(socket.id);
        io.to(room.hostId).emit("guest-canceled", { socketId: socket.id });
      }

      // Case 2: Accepted participant disconnected
      if (room.participants.has(socket.id)) {
        const leavingMember = room.participants.get(socket.id);
        room.participants.delete(socket.id);
        console.log(`🧹 Participant ${socket.id} (${leavingMember.displayName}) left room ${code}`);

        // If Host disconnected
        if (room.hostId === socket.id) {
          if (room.participants.size > 0) {
            // Transfer host role to oldest remaining participant
            const nextHost = Array.from(room.participants.values())[0];
            nextHost.isHost = true;
            room.hostId = nextHost.socketId;
            console.log(`👑 Transferred host role to ${nextHost.socketId} (${nextHost.displayName}) in room ${code}`);

            const remainingMembers = getRoomMembers(room);
            room.participants.forEach((m, sid) => {
              io.to(sid).emit("host-changed", {
                newHostId: nextHost.socketId,
                newHostName: nextHost.displayName,
                members: remainingMembers
              });
              io.to(sid).emit("user-left", { socketId: socket.id, members: remainingMembers });
            });
          } else {
            console.log(`🧹 Deleting empty room ${code}`);
            delete rooms[code];
          }
        } else {
          // Non-host left
          const remainingMembers = getRoomMembers(room);
          room.participants.forEach((m, sid) => {
            io.to(sid).emit("user-left", { socketId: socket.id, members: remainingMembers });
          });
        }
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

// Start server with automatic fallback if default port is in use
let PORT = process.env.PORT || 3000;

function listen(port) {
  server.listen(port, () => {
    console.log(`✅ Nexus Multi-Participant WebRTC Server running on http://localhost:${port}`);
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


