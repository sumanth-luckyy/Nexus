/**
 * Nexus / LinkDrop — Core Client WebRTC Engine
 * Strict 1-to-1 WebRTC PeerConnection, Targeted Signaling, ICE Race-Condition Protection, DataChannels & Diagnostics
 */

// ===== Global State =====
let socket = null;
let roomCode = null;
let isHost = false;
let myDisplayName = 'User';
let peerSocketId = null;
let peerDisplayName = 'Peer';

let localStream = null;
let remoteStream = null;
let screenStream = null;
let isScreenSharing = false;

// Strict 1-to-1 WebRTC State
let pc = null; // Single RTCPeerConnection instance
let chatChannel = null;
let fileChannel = null;
let pendingIceCandidates = [];
let isNegotiating = false;

let silkBg = null;
let unreadChatCount = 0;
let statsIntervalId = null;

// Timing Instrumentation
const timing = {
  t1_socketConnected: null,
  t2_roomJoined: null,
  t3_joinRequestReceived: null,
  t4_accepted: null,
  t5_offerCreated: null,
  t6_answerCreated: null,
  t7_iceGatheringStart: null,
  t8_iceGatheringComplete: null,
  t9_webrtcConnected: null,
  t10_firstRemoteTrack: null
};

function logTimingSummary() {
  console.group('%c[LinkDrop Timing Instrumentation Summary]', 'color: #00D9FF; font-weight: bold;');
  if (timing.t1_socketConnected) console.log(`T1 (Socket Connected): ${timing.t1_socketConnected} ms`);
  if (timing.t2_roomJoined) console.log(`T2 (Room Checked/Joined): ${timing.t2_roomJoined} ms`);
  if (timing.t3_joinRequestReceived) console.log(`T3 (Guest Join Request): ${timing.t3_joinRequestReceived} ms`);
  if (timing.t4_accepted) console.log(`T4 (Host Accepted): ${timing.t4_accepted} ms`);
  if (timing.t5_offerCreated) console.log(`T5 (Offer Created): ${timing.t5_offerCreated} ms`);
  if (timing.t6_answerCreated) console.log(`T6 (Answer Created): ${timing.t6_answerCreated} ms`);
  if (timing.t7_iceGatheringStart) console.log(`T7 (ICE Gathering Started): ${timing.t7_iceGatheringStart} ms`);
  if (timing.t8_iceGatheringComplete) console.log(`T8 (ICE Gathering Completed): ${timing.t8_iceGatheringComplete} ms`);
  if (timing.t9_webrtcConnected) console.log(`T9 (WebRTC Connected): ${timing.t9_webrtcConnected} ms`);
  if (timing.t10_firstRemoteTrack) console.log(`T10 (First Remote Track Received): ${timing.t10_firstRemoteTrack} ms`);

  if (timing.t4_accepted && timing.t9_webrtcConnected) {
    console.log(`%cTotal Connection Time (Acceptance to WebRTC Connected): ${timing.t9_webrtcConnected - timing.t4_accepted} ms`, 'color: #10b981; font-weight: bold;');
  }
  console.groupEnd();
}

// Device & Quality Selection State
let selectedVideoDeviceId = null;
let selectedAudioDeviceId = null;
let selectedAudioOutputDeviceId = null;
let selectedVideoQuality = 'auto';
let isPushToTalk = false;
let isSpacePressed = false;

// Theme Shader Colors
const THEME_COLORS = {
  cyber: '#00D9FF',
  dark: '#3b82f6',
  light: '#0284c7',
  amoled: '#004466'
};

// P2P File Transfer State
const incomingFileTransfers = {};
const activeFileTransfers = {};

// Configurable File Limits
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB max file size
const CHUNK_SIZE = 32768; // 32 KB chunk size for optimal DataChannel throughput

// Dynamic WebRTC Configuration
let rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

async function fetchIceServers() {
  try {
    const res = await fetch('/api/ice-servers');
    if (res.ok) {
      const data = await res.json();
      if (data.iceServers && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        rtcConfig = { iceServers: data.iceServers };
      }
    }
  } catch (err) {
    console.warn('[LinkDrop] Dynamic ICE fetch failed, using Google STUN fallback');
  }
}

// ===== Page Initialization =====
window.addEventListener('load', async () => {
  initTheme();
  initSilk();
  await fetchIceServers();

  const storedName = sessionStorage.getItem('nexus_name');
  if (storedName) myDisplayName = storedName;

  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'room' && parts[1]) {
    roomCode = parts[1].toUpperCase();
    setRoomBadge(roomCode);
    updateConnectionStatus('connecting', 'Waiting for permissions...');
  }

  setupEventListeners();
  setupNetworkListeners();
  initVideoCallUX();
});

// ===== Theme & Silk Background Initialization =====
function initTheme() {
  const savedTheme = localStorage.getItem('nexus_theme') || localStorage.getItem('linkdrop_theme') || 'cyber';
  document.documentElement.setAttribute('data-theme', savedTheme);

  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) themeSelect.value = savedTheme;
}

function initSilk() {
  const canvas = document.getElementById('silk-canvas');
  if (typeof SilkBackground !== 'undefined' && canvas) {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'cyber';
    silkBg = new SilkBackground('silk-canvas', {
      speed: 2.5,
      scale: 1,
      color: THEME_COLORS[currentTheme] || '#00D9FF',
      noiseIntensity: 0.8,
      rotation: 0
    });
  }
}

function changeTheme(themeName) {
  document.documentElement.setAttribute('data-theme', themeName);
  localStorage.setItem('nexus_theme', themeName);
  localStorage.setItem('linkdrop_theme', themeName);

  if (silkBg && THEME_COLORS[themeName]) {
    silkBg.setColor(THEME_COLORS[themeName]);
  }
}

// ===== UI, Keyboard & Network Event Listeners =====
function setupEventListeners() {
  const dropZone = document.getElementById('dropZone');
  if (dropZone) {
    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      }, false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
      }, false);
    });
    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files && files.length > 0) processAndSendFiles(files);
    });
  }

  // Create Room Modal bindings (Index page)
  const btnCreateModal = document.getElementById('btnCreateRoomModal');
  if (btnCreateModal) btnCreateModal.onclick = openCreateModal;

  const btnModalCancelCreate = document.getElementById('btnModalCancelCreate');
  if (btnModalCancelCreate) btnModalCancelCreate.onclick = closeCreateModal;

  const btnModalSubmitCreate = document.getElementById('btnModalSubmitCreate');
  if (btnModalSubmitCreate) btnModalSubmitCreate.onclick = submitCreateRoom;

  // QR Modal bindings (Room page)
  const btnQr = document.getElementById('btnQrCode');
  if (btnQr) btnQr.onclick = openQrModal;

  const btnCopyQrLink = document.getElementById('btnCopyQrLink');
  if (btnCopyQrLink) btnCopyQrLink.onclick = copyLink;

  // Guest PIN Prompt bindings (Room page)
  const btnSubmitPin = document.getElementById('btnSubmitPin');
  if (btnSubmitPin) btnSubmitPin.onclick = submitGuestPin;

  const guestPinInput = document.getElementById('guestPinInput');
  if (guestPinInput) {
    guestPinInput.onkeydown = (e) => {
      if (e.key === 'Enter') submitGuestPin();
    };
  }

  // Screen Share button
  const btnScreen = document.getElementById('btnScreen');
  if (btnScreen) btnScreen.onclick = toggleScreenShare;

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable) return;

    if (e.code === 'Space' && isPushToTalk && !isSpacePressed) {
      isSpacePressed = true;
      const audioTrack = localStream?.getAudioTracks()?.[0];
      if (audioTrack) audioTrack.enabled = true;
      const btn = document.getElementById('btnAudio');
      if (btn) btn.classList.remove('off');
      e.preventDefault();
    } else if (!e.repeat) {
      const key = e.key.toLowerCase();
      if (key === 'm') toggleAudio();
      if (key === 'v') toggleVideo();
      if (key === 's') toggleScreenShare();
      if (key === 'f') fullscreenPage();
      if (key === 'c') toggleDrawer('chat');
      if (key === 'escape') {
        closeSettings();
        closeQrModal();
        closeCreateModal();
        const chatDrawer = document.getElementById('chatDrawer');
        if (chatDrawer && chatDrawer.classList.contains('open')) toggleDrawer('chat');
        const fileDrawer = document.getElementById('fileDrawer');
        if (fileDrawer && fileDrawer.classList.contains('open')) toggleDrawer('file');
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && isPushToTalk && isSpacePressed) {
      isSpacePressed = false;
      const audioTrack = localStream?.getAudioTracks()?.[0];
      if (audioTrack) audioTrack.enabled = false;
      const btn = document.getElementById('btnAudio');
      if (btn) btn.classList.add('off');
    }
  });

  // Clean page unload
  window.addEventListener('beforeunload', () => {
    leaveRoomSilent();
  });
}

function setupNetworkListeners() {
  window.addEventListener('online', () => {
    toast('Network reconnected — restarting WebRTC ICE...');
    updateConnectionStatus('connecting', 'Reconnecting WebRTC...');
    if (pc) attemptIceRestart();
  });

  window.addEventListener('offline', () => {
    toast('Network connection lost');
    updateConnectionStatus('disconnected', 'Network offline');
  });
}

function setRoomBadge(code) {
  const label = document.getElementById('roomLabel');
  if (label) label.textContent = `Room — ${code}`;
  const qrBadge = document.getElementById('qrRoomBadge');
  if (qrBadge) qrBadge.textContent = `Room — ${code}`;
}

function updateConnectionStatus(state, text) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  if (dot) dot.className = `status-dot ${state}`;
  if (txt) txt.textContent = text;
}

// ===== Camera & Microphone Media Acquisition =====
async function requestMediaPermissionsAndJoin() {
  const btnAllow = document.getElementById('btnAllowJoin');
  const btnTryAgain = document.getElementById('btnTryAgainPermission');
  const errBox = document.getElementById('permErrorBox');
  const errMessage = document.getElementById('permErrorMessage');
  const camStatus = document.getElementById('camStatusText');
  const micStatus = document.getElementById('micStatusText');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (camStatus) {
      camStatus.textContent = '✕ Not Supported';
      camStatus.style.color = 'var(--danger)';
    }
    if (micStatus) {
      micStatus.textContent = '✕ Not Supported';
      micStatus.style.color = 'var(--danger)';
    }
    if (errBox && errMessage) {
      errMessage.textContent = 'Camera and microphone access is not supported in this browser context.';
      errBox.style.display = 'block';
    }
    if (btnAllow) btnAllow.style.display = 'none';
    return;
  }

  if (btnAllow) {
    btnAllow.disabled = true;
    btnAllow.textContent = 'Requesting permissions...';
  }
  if (errBox) errBox.style.display = 'none';

  let cameraTrack = null;
  let audioTrack = null;
  let cameraError = null;
  let micError = null;

  // First try combined request for optimal user experience
  try {
    const combinedStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (combinedStream) {
      cameraTrack = combinedStream.getVideoTracks()[0] || null;
      audioTrack = combinedStream.getAudioTracks()[0] || null;
    }
  } catch (err) {
    // If combined request fails, request video and audio independently to salvage working hardware
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      cameraTrack = camStream.getVideoTracks()[0] || null;
    } catch (cErr) {
      cameraError = getFriendlyMediaError('Camera', cErr);
    }

    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioTrack = micStream.getAudioTracks()[0] || null;
    } catch (mErr) {
      micError = getFriendlyMediaError('Microphone', mErr);
    }
  }

  if (camStatus) {
    if (cameraTrack) {
      camStatus.textContent = '✓ Ready';
      camStatus.style.color = 'var(--success)';
    } else {
      camStatus.textContent = '✕ ' + (cameraError ? cameraError.short : 'Unavailable');
      camStatus.style.color = 'var(--danger)';
    }
  }

  if (micStatus) {
    if (audioTrack) {
      micStatus.textContent = '✓ Ready';
      micStatus.style.color = 'var(--success)';
    } else {
      micStatus.textContent = '✕ ' + (micError ? micError.short : 'Unavailable');
      micStatus.style.color = 'var(--danger)';
    }
  }

  const tracks = [];
  if (cameraTrack) tracks.push(cameraTrack);
  if (audioTrack) tracks.push(audioTrack);

  if (tracks.length === 0) {
    if (btnAllow) btnAllow.style.display = 'none';
    if (btnTryAgain) btnTryAgain.style.display = 'inline-block';

    if (errBox && errMessage) {
      const details = [];
      if (cameraError) details.push(`Camera: ${cameraError.long}`);
      if (micError) details.push(`Microphone: ${micError.long}`);
      errMessage.textContent = details.join(' | ') || 'Could not access camera or microphone.';
      errBox.style.display = 'block';
    }

    if (btnAllow) {
      btnAllow.disabled = false;
      btnAllow.textContent = 'Allow & Join Room';
    }
    return;
  }

  localStream = new MediaStream(tracks);

  const localVideo = document.getElementById('localVideo');
  const localAvatar = document.getElementById('localAvatar');

  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.autoplay = true;
    localVideo.muted = true;
    localVideo.playsInline = true;

    try { await localVideo.play(); } catch (e) {}
  }

  if (localAvatar && cameraTrack) {
    localAvatar.style.display = 'none';
  }

  const preCallModal = document.getElementById('preCallModal');
  if (preCallModal) preCallModal.classList.remove('open');

  if (btnAllow) {
    btnAllow.disabled = false;
    btnAllow.textContent = 'Allow & Join Room';
  }

  await connectSocketAndJoinRoom();
}

function getFriendlyMediaError(deviceType, err) {
  if (!err) return { short: 'Error', long: `${deviceType} unavailable.` };

  switch (err.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return { short: 'Permission Denied', long: `Permission denied for ${deviceType.toLowerCase()}.` };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { short: 'Not Found', long: `No ${deviceType.toLowerCase()} device detected on this system.` };
    case 'NotReadableError':
    case 'TrackStartError':
      return { short: 'In Use', long: `${deviceType} is currently in use by another application.` };
    case 'OverconstrainedError':
      return { short: 'Resolution Error', long: `${deviceType} constraints cannot be satisfied.` };
    default:
      return { short: 'Access Error', long: `Unable to access ${deviceType.toLowerCase()}: ${err.message || 'unknown error'}` };
  }
}

// ===== Socket.IO Connection & Room Signaling Flow =====
function joinExistingRoom(pin) {
  const finalPin = pin || sessionStorage.getItem('nexus_pin_' + roomCode) || sessionStorage.getItem('linkdrop_pin_' + roomCode) || null;
  const storedName = sessionStorage.getItem('nexus_name') || 'User';

  if (socket) {
    socket.emit('join-room', roomCode, socket.id, finalPin, 2, storedName);
  }
}

function showPinModal() {
  updateConnectionStatus('connecting', 'PIN Required');
  const modal = document.getElementById('pinPromptModal');
  if (modal) modal.classList.add('open');
  const errBox = document.getElementById('pinErrorBox');
  if (errBox) errBox.style.display = 'none';
  const pinInput = document.getElementById('guestPinInput');
  if (pinInput) {
    pinInput.value = '';
    pinInput.focus();
  }
}

async function connectSocketAndJoinRoom() {
  const serverUrl = window.location.origin;

  socket = io(serverUrl, {
    transports: ["websocket", "polling"]
  });

  socket.on('connect', () => {
    timing.t1_socketConnected = Date.now();
    console.log('[LinkDrop Timing] T1 - Socket Connected:', timing.t1_socketConnected);
    updateConnectionStatus('connecting', 'Signaling Connected...');

    socket.emit('check-room', { roomId: roomCode }, (result) => {
      timing.t2_roomJoined = Date.now();
      console.log('[LinkDrop Timing] T2 - Room Checked:', timing.t2_roomJoined);

      if (!result || !result.exists) {
        const savedPin = sessionStorage.getItem('nexus_pin_' + roomCode) || sessionStorage.getItem('linkdrop_pin_' + roomCode) || null;
        joinExistingRoom(savedPin);
        return;
      }

      if (result.isFull) {
        toast('This room is full');
        updateConnectionStatus('disconnected', 'Room is full');
        setTimeout(() => location.href = '/', 2000);
        return;
      }

      if (result.protected) {
        const isHostSession = sessionStorage.getItem('nexus_host_' + roomCode) === 'true' || sessionStorage.getItem('linkdrop_host_' + roomCode) === 'true';
        const savedPin = sessionStorage.getItem('nexus_pin_' + roomCode) || sessionStorage.getItem('linkdrop_pin_' + roomCode);

        if (isHostSession && savedPin) {
          socket.emit('verify-room-pin', { roomId: roomCode, pin: savedPin }, (res) => {
            if (res && res.success) {
              joinExistingRoom(savedPin);
            } else {
              showPinModal();
            }
          });
        } else {
          showPinModal();
        }
      } else {
        joinExistingRoom();
      }
    });
  });

  socket.on('room-joined', (data) => {
    if (data) {
      isHost = !!data.isHost;
      updateRoomSummaryInfo(data);

      if (isHost) {
        updateConnectionStatus('connecting', 'Waiting for guest to join...');
      } else {
        updateConnectionStatus('connecting', 'Waiting for host approval...');
      }
    }
  });

  socket.on('pin-required', () => {
    showPinModal();
  });

  socket.on('room-full', () => {
    toast('This room is full');
    updateConnectionStatus('disconnected', 'Room is full');
    setTimeout(() => location.href = '/', 2000);
  });

  // Host receives join request from Guest
  socket.on('request-join', (data) => {
    timing.t3_joinRequestReceived = Date.now();
    console.log('[LinkDrop Timing] T3 - Join Request Received by Host:', timing.t3_joinRequestReceived);
    isHost = true;
    peerSocketId = data?.socketId || null;
    peerDisplayName = data?.displayName || 'Guest';

    const approvalPopup = document.getElementById('approvalPopup');
    if (approvalPopup) {
      const msgText = approvalPopup.querySelector('p');
      if (msgText) msgText.textContent = `${peerDisplayName} wants to join your room.`;
      approvalPopup.dataset.targetId = peerSocketId;
      approvalPopup.classList.add('open');
    }
  });

  socket.on('guest-canceled', () => {
    toast('Guest canceled join request');
    const approvalPopup = document.getElementById('approvalPopup');
    if (approvalPopup) approvalPopup.classList.remove('open');
    updateConnectionStatus('connecting', 'Waiting for guest to join...');
  });

  // Guest receives host acceptance notification
  socket.on('accepted', async (data) => {
    timing.t4_accepted = Date.now();
    console.log('[LinkDrop Timing] T4 - Host Accepted Guest:', timing.t4_accepted);
    toast('Host accepted join request!');
    updateConnectionStatus('connecting', 'Establishing WebRTC P2P...');

    if (data && data.hostId) {
      peerSocketId = data.hostId;
      peerDisplayName = data.hostDisplayName || 'Host';
    }

    startStatsMonitoring();
  });

  socket.on('rejected', () => {
    toast('Host rejected join request');
    updateConnectionStatus('disconnected', 'Join request rejected');
    setTimeout(() => location.href = '/', 1500);
  });

  // Host receives notice that guest has joined after acceptance
  socket.on('user-joined', async (data) => {
    if (data && data.socketId) {
      peerSocketId = data.socketId;
      peerDisplayName = data.displayName || 'Guest';
    }
    toast(`${peerDisplayName} joined the room`);
    updateConnectionStatus('connecting', 'Connecting WebRTC...');

    // Host initiates WebRTC Offer
    if (isHost && peerSocketId) {
      await initiateOfferAsHost();
    }
  });

  socket.on('user-left', (data) => {
    toast(`${peerDisplayName} left the room`);
    cleanupPeerConnection();
    updateConnectionStatus('disconnected', 'Peer left');
  });

  socket.on('peer-disconnected', (data) => {
    toast(`${peerDisplayName} disconnected`);
    cleanupPeerConnection();
    updateConnectionStatus('disconnected', 'Peer disconnected');
  });

  // Targeted WebRTC Signaling Listeners
  socket.on('offer', async (data) => {
    const offer = data.offer || data;
    const senderId = data.senderId;
    if (senderId) peerSocketId = senderId;
    if (data.senderName) peerDisplayName = data.senderName;

    console.log('[LinkDrop WebRTC] Received Offer from Host:', senderId);
    await handleOfferAsGuest(offer, senderId);
  });

  socket.on('answer', async (data) => {
    const answer = data.answer || data;
    console.log('[LinkDrop WebRTC] Received Answer from Guest');
    await handleAnswerAsHost(answer);
  });

  socket.on('ice-candidate', async (data) => {
    const candidate = data.candidate || data;
    await handleRemoteIceCandidate(candidate);
  });

  socket.on('screen-share-state', (isSharing) => {
    const banner = document.getElementById('screenShareBanner');
    const txt = document.getElementById('screenShareText');
    if (banner && txt) {
      txt.textContent = isSharing ? `${peerDisplayName} is sharing their screen` : 'Screen Share Active';
      banner.style.display = isSharing ? 'flex' : 'none';
    }
  });

  // Host Approval Popup Buttons
  const acceptBtn = document.getElementById('acceptBtn');
  const rejectBtn = document.getElementById('rejectBtn');
  const approvalPopup = document.getElementById('approvalPopup');

  if (acceptBtn) acceptBtn.onclick = () => {
    const targetId = approvalPopup?.dataset?.targetId || peerSocketId;
    if (approvalPopup) approvalPopup.classList.remove('open');
    socket.emit('accept', roomCode, targetId);
  };

  if (rejectBtn) rejectBtn.onclick = () => {
    const targetId = approvalPopup?.dataset?.targetId || peerSocketId;
    if (approvalPopup) approvalPopup.classList.remove('open');
    socket.emit('reject', roomCode, targetId);
  };
}

// ===== Strict 1-to-1 WebRTC PeerConnection Pipeline =====

function createPeerConnection() {
  if (pc) {
    try { pc.close(); } catch (e) {}
  }

  pc = new RTCPeerConnection(rtcConfig);
  pendingIceCandidates = [];

  // Attach local media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  // ICE Candidate Event
  pc.onicecandidate = (e) => {
    if (e.candidate && socket && peerSocketId) {
      if (!timing.t7_iceGatheringStart) {
        timing.t7_iceGatheringStart = Date.now();
        console.log('[LinkDrop Timing] T7 - ICE Gathering Started:', timing.t7_iceGatheringStart);
      }
      socket.emit('ice-candidate', roomCode, e.candidate, peerSocketId);
    }
  };

  pc.onicegatheringstatechange = () => {
    console.log('[LinkDrop WebRTC] iceGatheringState:', pc.iceGatheringState);
    if (pc.iceGatheringState === 'complete') {
      timing.t8_iceGatheringComplete = Date.now();
      console.log('[LinkDrop Timing] T8 - ICE Gathering Complete:', timing.t8_iceGatheringComplete);
    }
  };

  // Remote Media Track Event
  pc.ontrack = (e) => {
    if (!timing.t10_firstRemoteTrack) {
      timing.t10_firstRemoteTrack = Date.now();
      console.log('[LinkDrop Timing] T10 - First Remote Media Track Received:', timing.t10_firstRemoteTrack);
      logTimingSummary();
    }

    if (!remoteStream) {
      remoteStream = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream();
    }
    if (!remoteStream.getTracks().some(t => t.id === e.track.id)) {
      remoteStream.addTrack(e.track);
    }

    const remoteVideo = document.getElementById('remoteVideo');
    const remoteAvatar = document.getElementById('remoteAvatar');

    if (remoteVideo) {
      remoteVideo.srcObject = remoteStream;
      if (remoteAvatar) remoteAvatar.style.display = 'none';
      try { remoteVideo.play().catch(e => {}); } catch(e) {}
    }
  };

  // Connection State Monitor
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log('[LinkDrop WebRTC] connectionState:', state);

    if (state === 'connected') {
      timing.t9_webrtcConnected = Date.now();
      console.log('[LinkDrop Timing] T9 - WebRTC Connection Established:', timing.t9_webrtcConnected);
      updateConnectionStatus('connected', 'WebRTC Connected');
      toast('WebRTC Connected!');
    } else if (state === 'connecting') {
      updateConnectionStatus('connecting', 'WebRTC Connecting...');
    } else if (state === 'disconnected') {
      updateConnectionStatus('disconnected', 'WebRTC Disconnected');
      toast('WebRTC Disconnected — attempting recovery...');
      attemptIceRestart();
    } else if (state === 'failed') {
      updateConnectionStatus('disconnected', 'WebRTC Connection Failed');
      toast('WebRTC Connection Failed — restarting ICE...');
      attemptIceRestart();
    }
  };

  return pc;
}

// Host initiates offer
async function initiateOfferAsHost() {
  if (isNegotiating) return;
  isNegotiating = true;

  try {
    createPeerConnection();

    // Host creates DataChannels before createOffer
    const chatCh = pc.createDataChannel('chat');
    setupChatChannelListeners(chatCh);
    chatChannel = chatCh;

    const fileCh = pc.createDataChannel('file-transfer');
    setupFileChannelListeners(fileCh);
    fileChannel = fileCh;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    timing.t5_offerCreated = Date.now();
    console.log('[LinkDrop Timing] T5 - Host Offer Created:', timing.t5_offerCreated);

    socket.emit('offer', roomCode, pc.localDescription, peerSocketId);
  } catch (err) {
    console.error('[LinkDrop WebRTC] Host offer initiation error:', err);
  } finally {
    isNegotiating = false;
  }
}

// Guest handles offer from Host
async function handleOfferAsGuest(offer, senderId) {
  try {
    createPeerConnection();

    // Guest listens for DataChannels created by Host
    pc.ondatachannel = (e) => {
      const channel = e.channel;
      if (channel.label === 'chat') {
        chatChannel = channel;
        setupChatChannelListeners(channel);
      } else if (channel.label === 'file-transfer') {
        fileChannel = channel;
        setupFileChannelListeners(channel);
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await flushQueuedIceCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    timing.t6_answerCreated = Date.now();
    console.log('[LinkDrop Timing] T6 - Guest Answer Created:', timing.t6_answerCreated);

    socket.emit('answer', roomCode, answer, senderId);
  } catch (err) {
    console.error('[LinkDrop WebRTC] Guest offer handling error:', err);
  }
}

// Host handles answer from Guest
async function handleAnswerAsHost(answer) {
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    await flushQueuedIceCandidates();
  } catch (err) {
    console.error('[LinkDrop WebRTC] Host setRemoteDescription answer error:', err);
  }
}

// ICE Candidate Handler with strict queueing
async function handleRemoteIceCandidate(candidate) {
  if (!candidate) return;

  if (pc && pc.remoteDescription && pc.remoteDescription.type) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[LinkDrop ICE] Add candidate error:', err.message);
    }
  } else {
    pendingIceCandidates.push(candidate);
  }
}

async function flushQueuedIceCandidates() {
  while (pendingIceCandidates.length > 0) {
    const cand = pendingIceCandidates.shift();
    try {
      if (pc) await pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch (err) {
      console.warn('[LinkDrop ICE] Flushed candidate add error:', err.message);
    }
  }
}

async function attemptIceRestart() {
  if (!pc) return;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    if (socket && peerSocketId) {
      socket.emit('offer', roomCode, offer, peerSocketId);
    }
  } catch (err) {
    console.error('[LinkDrop WebRTC] ICE restart failed:', err);
  }
}

function cleanupPeerConnection() {
  if (pc) {
    try { pc.close(); } catch (e) {}
    pc = null;
  }
  chatChannel = null;
  fileChannel = null;
  remoteStream = null;
  pendingIceCandidates = [];

  const remoteVideo = document.getElementById('remoteVideo');
  if (remoteVideo) remoteVideo.srcObject = null;
  const remoteAvatar = document.getElementById('remoteAvatar');
  if (remoteAvatar) remoteAvatar.style.display = 'flex';
}

// ===== Screen Sharing & Restoration =====
async function toggleScreenShare() {
  const btnScreen = document.getElementById('btnScreen');
  const screenBanner = document.getElementById('screenShareBanner');
  const screenText = document.getElementById('screenShareText');
  const localVideo = document.getElementById('localVideo');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('Screen sharing is not supported in this browser');
    return;
  }

  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];

      if (localVideo) localVideo.srcObject = screenStream;

      if (pc) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          await sender.replaceTrack(screenTrack);
        }
      }

      screenTrack.onended = () => { stopScreenShare(); };

      isScreenSharing = true;
      if (btnScreen) btnScreen.classList.add('active-danger');
      if (screenBanner && screenText) {
        screenText.textContent = 'You are sharing your screen';
        screenBanner.style.display = 'flex';
      }

      if (socket) socket.emit('screen-share-state', roomCode, true);
    } catch (err) {
      console.warn('Screen share cancelled or failed:', err);
    }
  } else {
    stopScreenShare();
  }
}

function stopScreenShare() {
  if (!isScreenSharing) return;

  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  const cameraTrack = localStream?.getVideoTracks()[0];
  const localVideo = document.getElementById('localVideo');
  if (localVideo && localStream) localVideo.srcObject = localStream;

  if (cameraTrack && pc) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) {
      sender.replaceTrack(cameraTrack);
      cameraTrack.enabled = true;
    }
  }

  isScreenSharing = false;
  const btnScreen = document.getElementById('btnScreen');
  const screenBanner = document.getElementById('screenShareBanner');

  if (btnScreen) btnScreen.classList.remove('active-danger');
  if (screenBanner) screenBanner.style.display = 'none';

  if (socket) socket.emit('screen-share-state', roomCode, false);
}

// ===== P2P Text Chat DataChannel =====
function setupChatChannelListeners(channel) {
  if (!channel) return;

  channel.onopen = () => { console.log('[LinkDrop] Chat DataChannel opened'); };
  channel.onclose = () => { console.log('[LinkDrop] Chat DataChannel closed'); };
  channel.onerror = (err) => { console.warn('[LinkDrop] Chat DataChannel error:', err); };

  channel.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data && data.type === 'chat' && typeof data.text === 'string') {
        const cleanText = data.text.slice(0, 2000);
        renderChatMessage(cleanText, 'them', data.timestamp, data.sender || peerDisplayName);

        const chatDrawer = document.getElementById('chatDrawer');
        if (!chatDrawer || !chatDrawer.classList.contains('open')) {
          unreadChatCount++;
          updateChatBadge();
        }
      }
    } catch (err) {}
  };
}

function sendChatMessage() {
  const input = document.getElementById('chatInput');
  if (!input) return;
  let text = input.value.trim();
  if (!text) return;

  if (text.length > 2000) text = text.substring(0, 2000);

  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const payload = JSON.stringify({ type: 'chat', text, sender: myDisplayName, timestamp });

  if (chatChannel && chatChannel.readyState === 'open') {
    try {
      chatChannel.send(payload);
      renderChatMessage(text, 'me', timestamp, myDisplayName);
      input.value = '';
    } catch (err) {
      toast('Failed to send chat message');
    }
  } else {
    toast('Chat channel not open');
  }
}

function handleChatKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

function renderChatMessage(text, sender, timestamp, senderName) {
  const container = document.getElementById('chatMessages');
  if (!container) return;

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${sender}`;

  if (senderName && sender === 'them') {
    const nameNode = document.createElement('div');
    nameNode.style.cssText = 'font-weight:600; font-size:11px; margin-bottom:2px; color:var(--accent);';
    nameNode.textContent = senderName;
    bubble.appendChild(nameNode);
  }

  const textNode = document.createElement('div');
  textNode.textContent = text;

  const metaNode = document.createElement('div');
  metaNode.className = 'msg-meta';
  metaNode.textContent = timestamp || '';

  bubble.appendChild(textNode);
  bubble.appendChild(metaNode);

  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function clearChat() {
  const container = document.getElementById('chatMessages');
  if (container) container.innerHTML = '';
}

function updateChatBadge() {
  const badge = document.getElementById('badgeChat');
  if (!badge) return;
  if (unreadChatCount > 0) {
    badge.textContent = unreadChatCount;
    badge.style.display = 'grid';
  } else {
    badge.style.display = 'none';
  }
}

// ===== P2P File Transfer DataChannel =====
function setupFileChannelListeners(channel) {
  if (!channel) return;
  channel.binaryType = 'arraybuffer';

  channel.onopen = () => { console.log('[LinkDrop] File DataChannel opened'); };
  channel.onclose = () => {
    console.log('[LinkDrop] File DataChannel closed');
    cleanupIncompleteTransfers('Channel closed');
  };
  channel.onerror = (err) => {
    console.warn('[LinkDrop] File DataChannel error:', err);
    cleanupIncompleteTransfers('Channel error');
  };

  channel.onmessage = (e) => {
    if (typeof e.data === 'string') {
      try {
        const meta = JSON.parse(e.data);
        if (meta.type === 'file-start') {
          if (meta.size > MAX_FILE_SIZE) {
            toast('File exceeds 500MB size limit');
            return;
          }

          incomingFileTransfers[meta.id] = {
            meta,
            chunks: [],
            receivedBytes: 0,
            startTime: Date.now()
          };
          createFileProgressUI(meta.id, meta.name, meta.size, false);
        } else if (meta.type === 'file-cancel') {
          delete incomingFileTransfers[meta.id];
          const status = document.getElementById(`status_${meta.id}`);
          if (status) {
            status.textContent = 'Cancelled by peer';
            status.style.color = 'var(--danger)';
          }
          toast('Peer cancelled file transfer');
        } else if (meta.type === 'file-end') {
          const fileData = incomingFileTransfers[meta.id];
          if (fileData) {
            const blob = new Blob(fileData.chunks, { type: fileData.meta.mime || 'application/octet-stream' });
            const downloadUrl = URL.createObjectURL(blob);
            finishFileDownload(meta.id, fileData.meta.name, downloadUrl);
            delete incomingFileTransfers[meta.id];
          }
        }
      } catch (err) {}
    } else if (e.data instanceof ArrayBuffer) {
      const activeId = Object.keys(incomingFileTransfers).pop();
      if (!activeId) return;

      const fileData = incomingFileTransfers[activeId];
      fileData.chunks.push(e.data);
      fileData.receivedBytes += e.data.byteLength;

      const elapsedSec = Math.max(0.1, (Date.now() - fileData.startTime) / 1000);
      const speedMBs = (fileData.receivedBytes / (1024 * 1024)) / elapsedSec;
      const remainingBytes = Math.max(0, fileData.meta.size - fileData.receivedBytes);
      const etaSec = speedMBs > 0 ? Math.round((remainingBytes / (1024 * 1024)) / speedMBs) : 0;

      const pct = Math.min(100, Math.round((fileData.receivedBytes / fileData.meta.size) * 100));
      updateFileProgress(activeId, pct, fileData.receivedBytes, fileData.meta.size, speedMBs, etaSec);
    }
  };
}

function cleanupIncompleteTransfers(reason) {
  for (const id in incomingFileTransfers) {
    const status = document.getElementById(`status_${id}`);
    if (status) {
      status.textContent = `Failed (${reason})`;
      status.style.color = 'var(--danger)';
    }
    delete incomingFileTransfers[id];
  }

  for (const id in activeFileTransfers) {
    activeFileTransfers[id].cancelled = true;
    const status = document.getElementById(`status_${id}`);
    if (status) {
      status.textContent = `Failed (${reason})`;
      status.style.color = 'var(--danger)';
    }
    delete activeFileTransfers[id];
  }
}

function handleFileSelect(e) {
  const files = e.target.files;
  if (files && files.length > 0) processAndSendFiles(files);
}

async function processAndSendFiles(files) {
  if (!fileChannel || fileChannel.readyState !== 'open') {
    toast('P2P File channel not ready');
    return;
  }

  const fileList = Array.from(files);
  for (const file of fileList) {
    if (file.size > MAX_FILE_SIZE) {
      toast(`File ${file.name} exceeds 500MB limit`);
      continue;
    }
    await sendSingleFile(file, fileChannel);
  }
}

async function sendSingleFile(file, channel) {
  const fileId = 'file_' + Math.random().toString(36).substr(2, 9);
  activeFileTransfers[fileId] = { cancelled: false, startTime: Date.now() };

  try {
    channel.send(JSON.stringify({
      type: 'file-start',
      id: fileId,
      name: file.name,
      size: file.size,
      mime: file.type
    }));
  } catch (err) {
    toast('Failed to start file transfer');
    delete activeFileTransfers[fileId];
    return;
  }

  createFileProgressUI(fileId, file.name, file.size, true);

  let offset = 0;
  channel.bufferedAmountLowThreshold = 64 * 1024;

  while (offset < file.size) {
    if (activeFileTransfers[fileId]?.cancelled || channel.readyState !== 'open') {
      break;
    }

    if (channel.bufferedAmount > 128 * 1024) {
      await new Promise(resolve => {
        let timeout = setTimeout(() => {
          channel.onbufferedamountlow = null;
          resolve();
        }, 1000);

        channel.onbufferedamountlow = () => {
          clearTimeout(timeout);
          channel.onbufferedamountlow = null;
          resolve();
        };
      });
    }

    if (activeFileTransfers[fileId]?.cancelled || channel.readyState !== 'open') {
      break;
    }

    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await slice.arrayBuffer();

    try {
      channel.send(buffer);
    } catch (err) {
      console.warn('[LinkDrop] Send chunk error:', err);
      break;
    }

    offset += buffer.byteLength;

    const elapsedSec = Math.max(0.1, (Date.now() - activeFileTransfers[fileId].startTime) / 1000);
    const speedMBs = (offset / (1024 * 1024)) / elapsedSec;
    const remainingBytes = Math.max(0, file.size - offset);
    const etaSec = speedMBs > 0 ? Math.round((remainingBytes / (1024 * 1024)) / speedMBs) : 0;

    const pct = Math.min(100, Math.round((offset / file.size) * 100));
    updateFileProgress(fileId, pct, offset, file.size, speedMBs, etaSec);
  }

  if (activeFileTransfers[fileId]?.cancelled || offset < file.size) {
    const status = document.getElementById(`status_${fileId}`);
    if (status) {
      status.textContent = activeFileTransfers[fileId]?.cancelled ? 'Cancelled' : 'Transfer Failed';
      status.style.color = 'var(--danger)';
    }
    delete activeFileTransfers[fileId];
    return;
  }

  delete activeFileTransfers[fileId];
  try {
    channel.send(JSON.stringify({ type: 'file-end', id: fileId }));
    toast(`Sent file: ${file.name}`);
  } catch (err) {}
}

function createFileProgressUI(id, filename, size, isSender) {
  const container = document.getElementById('fileProgressArea');
  if (!container) return;

  const item = document.createElement('div');
  item.className = 'file-item';
  item.id = `item_${id}`;

  const cleanName = escapeHtml(filename);
  const sizeFormatted = formatBytes(size);

  item.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; font-weight:600; gap:8px;">
      <span style="max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${cleanName}">${cleanName}</span>
      <span style="font-size:11px; color:var(--muted);">${sizeFormatted}</span>
      <button onclick="cancelFileTransfer('${id}')" style="background:none; border:none; color:var(--danger); font-size:12px; cursor:pointer; padding:2px 4px;" title="Cancel transfer" aria-label="Cancel transfer">✕</button>
    </div>
    <div class="progress-bar-wrap" style="margin-top:4px;">
      <div id="bar_${id}" class="progress-bar-fill"></div>
    </div>
    <div id="status_${id}" style="font-size:11px; color:var(--muted); text-align:right; margin-top:2px;">
      ${isSender ? 'Sending...' : 'Receiving...'} 0%
    </div>
  `;

  container.prepend(item);
}

function cancelFileTransfer(id) {
  if (activeFileTransfers[id]) {
    activeFileTransfers[id].cancelled = true;
    delete activeFileTransfers[id];
  }
  if (incomingFileTransfers[id]) {
    delete incomingFileTransfers[id];
  }
  if (fileChannel && fileChannel.readyState === 'open') {
    try {
      fileChannel.send(JSON.stringify({ type: 'file-cancel', id }));
    } catch (e) {}
  }
  const status = document.getElementById(`status_${id}`);
  if (status) {
    status.textContent = 'Cancelled';
    status.style.color = 'var(--danger)';
  }
  toast('File transfer cancelled');
}

function updateFileProgress(id, pct, current, total, speedMBs, etaSec) {
  const bar = document.getElementById(`bar_${id}`);
  const status = document.getElementById(`status_${id}`);
  if (bar) bar.style.width = `${pct}%`;
  if (status) {
    const speedStr = speedMBs ? `${speedMBs.toFixed(1)} MB/s` : '';
    const etaStr = etaSec ? `ETA ${etaSec}s` : '';
    const extra = [speedStr, etaStr].filter(Boolean).join(' • ');
    status.textContent = `${pct}% (${formatBytes(current)} / ${formatBytes(total)}) ${extra ? '— ' + extra : ''}`;
  }
}

function finishFileDownload(id, filename, downloadUrl) {
  const status = document.getElementById(`status_${id}`);
  if (status) {
    const safeName = escapeHtml(filename);
    status.innerHTML = `<a href="${downloadUrl}" download="${safeName}" class="btn-primary" style="display:inline-block; padding:4px 10px; font-size:11px; margin-top:4px; text-decoration:none;">Download File</a>`;
  }
}

// ===== Audio & Video Controls =====
function toggleAudio() {
  if (!localStream) {
    toast('Media stream not active');
    return;
  }
  const audioTrack = localStream.getAudioTracks()?.[0];
  const btn = document.getElementById('btnAudio');
  if (!audioTrack) {
    toast('No audio track available');
    return;
  }

  audioTrack.enabled = !audioTrack.enabled;
  if (btn) btn.classList.toggle('off', !audioTrack.enabled);
  toast(audioTrack.enabled ? 'Mic Unmuted' : 'Mic Muted');

  if (socket && roomCode) {
    socket.emit('peer-state-change', roomCode, { audioEnabled: audioTrack.enabled });
  }
}

function toggleVideo() {
  if (!localStream) {
    toast('Media stream not active');
    return;
  }
  const videoTrack = localStream.getVideoTracks()?.[0];
  const btn = document.getElementById('btnVideo');
  const localAvatar = document.getElementById('localAvatar');

  if (!videoTrack) {
    toast('No video track available');
    return;
  }

  videoTrack.enabled = !videoTrack.enabled;
  if (btn) btn.classList.toggle('off', !videoTrack.enabled);
  if (localAvatar) localAvatar.style.display = videoTrack.enabled ? 'none' : 'flex';
  toast(videoTrack.enabled ? 'Camera Enabled' : 'Camera Disabled');

  if (socket && roomCode) {
    socket.emit('peer-state-change', roomCode, { videoEnabled: videoTrack.enabled });
  }
}

function toggleMirrorVideo(mirror) {
  const localVideoWrap = document.getElementById('localVideoWrap');
  if (localVideoWrap) {
    localVideoWrap.classList.toggle('mirror', mirror);
  }
}

function toggleVolumeSlider() {
  const popup = document.getElementById('volumePopup');
  if (popup) popup.classList.toggle('open');
}

function setRemoteVolume(val) {
  const volVal = document.getElementById('volVal');
  const settingsVolVal = document.getElementById('settingsVolVal');
  const volumeSlider = document.getElementById('volumeSlider');
  const settingsVolumeSlider = document.getElementById('settingsVolumeSlider');

  if (volVal) volVal.textContent = `${val}%`;
  if (settingsVolVal) settingsVolVal.textContent = `${val}%`;
  if (volumeSlider) volumeSlider.value = val;
  if (settingsVolumeSlider) settingsVolumeSlider.value = val;

  const remoteVideo = document.getElementById('remoteVideo');
  if (remoteVideo) {
    remoteVideo.volume = val / 100;
  }
}

// ===== WhatsApp-Style Video Call UX & Free Position Drag/Swap Engine =====
let isLocalFullscreen = false;
let miniPos = { left: null, top: null };
let dragPointerId = null;
let dragStartX = 0;
let dragStartY = 0;
let dragInitialLeft = 0;
let dragInitialTop = 0;
let isDraggingMini = false;
let hasMovedExceedingThreshold = false;
const DRAG_THRESHOLD_PX = 8;
let controlsTimeoutId = null;

function getMiniVideoElement() {
  const localWrap = document.getElementById('localVideoWrap');
  const remoteWrap = document.getElementById('remoteVideoWrap');
  return isLocalFullscreen ? remoteWrap : localWrap;
}

function getPrimaryVideoElement() {
  const localWrap = document.getElementById('localVideoWrap');
  const remoteWrap = document.getElementById('remoteVideoWrap');
  return isLocalFullscreen ? localWrap : remoteWrap;
}

function updateVideoLayout() {
  const localWrap = document.getElementById('localVideoWrap');
  const remoteWrap = document.getElementById('remoteVideoWrap');
  const container = document.getElementById('videoContainer');
  if (!localWrap || !remoteWrap || !container) return;

  const primaryEl = getPrimaryVideoElement();
  const miniEl = getMiniVideoElement();

  // Configure Primary Video Role (fills call viewport)
  primaryEl.classList.add('video-primary');
  primaryEl.classList.remove('video-mini', 'draggable-preview', 'dragging');
  primaryEl.style.left = '';
  primaryEl.style.top = '';
  primaryEl.style.right = '';
  primaryEl.style.bottom = '';
  primaryEl.removeAttribute('tabindex');
  primaryEl.setAttribute('role', 'region');
  primaryEl.setAttribute('aria-label', isLocalFullscreen ? 'Local video stream (fullscreen)' : 'Remote video stream (fullscreen)');

  // Configure Mini Video Role (floating preview)
  miniEl.classList.add('video-mini', 'draggable-preview');
  miniEl.classList.remove('video-primary');
  miniEl.setAttribute('tabindex', '0');
  miniEl.setAttribute('role', 'button');
  miniEl.setAttribute('aria-label', isLocalFullscreen ? 'Remote video preview (Tap to swap, Drag to move)' : 'Local video preview (Tap to swap, Drag to move)');

  const containerRect = container.getBoundingClientRect();
  const miniWidth = miniEl.offsetWidth || (window.innerWidth <= 600 ? 150 : 240);
  const miniHeight = miniEl.offsetHeight || (window.innerWidth <= 600 ? 84 : 135);

  // Initialize default position (bottom-right area with 16px margin) if uninitialized
  if (miniPos.left === null || miniPos.top === null) {
    miniPos.left = Math.max(16, containerRect.width - miniWidth - 16);
    miniPos.top = Math.max(16, containerRect.height - miniHeight - 16);
  }

  // Ensure mini element inherits existing continuous X/Y coordinates
  clampMiniVideoPosition(miniPos.left, miniPos.top);
}

function clampMiniVideoPosition(targetLeft = miniPos.left, targetTop = miniPos.top) {
  const container = document.getElementById('videoContainer');
  const miniEl = getMiniVideoElement();
  if (!container || !miniEl) return;

  const containerRect = container.getBoundingClientRect();
  const miniWidth = miniEl.offsetWidth || (window.innerWidth <= 600 ? 150 : 240);
  const miniHeight = miniEl.offsetHeight || (window.innerWidth <= 600 ? 84 : 135);

  const containerW = containerRect.width || window.innerWidth;
  const containerH = containerRect.height || window.innerHeight;

  // Strict viewport boundary clamping (0 <= X <= containerW - miniWidth, 0 <= Y <= containerH - miniHeight)
  const maxLeft = Math.max(0, containerW - miniWidth);
  const maxTop = Math.max(0, containerH - miniHeight);

  let clampedLeft = Math.min(Math.max(0, targetLeft), maxLeft);
  let clampedTop = Math.min(Math.max(0, targetTop), maxTop);

  // Persist exact continuous X/Y coordinates
  miniPos.left = clampedLeft;
  miniPos.top = clampedTop;

  // Apply continuous inline X/Y positioning without corner snapping
  miniEl.style.left = `${clampedLeft}px`;
  miniEl.style.top = `${clampedTop}px`;
  miniEl.style.right = 'auto';
  miniEl.style.bottom = 'auto';
}

function swapVideoLayout() {
  isLocalFullscreen = !isLocalFullscreen;
  updateVideoLayout();
  toast(isLocalFullscreen ? 'Swapped: Your camera in main view' : 'Swapped: Peer camera in main view');
}

// Pointer Events Drag & Tap Engine
function initDraggableMiniVideo() {
  const container = document.getElementById('videoContainer');
  if (!container) return;

  container.addEventListener('pointerdown', (e) => {
    const miniEl = getMiniVideoElement();
    if (!miniEl || !miniEl.contains(e.target)) return;

    dragPointerId = e.pointerId;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    // Use offsetLeft / offsetTop relative to #videoContainer for exact X/Y
    dragInitialLeft = miniEl.offsetLeft;
    dragInitialTop = miniEl.offsetTop;

    isDraggingMini = true;
    hasMovedExceedingThreshold = false;

    miniEl.classList.add('dragging');
    try {
      miniEl.setPointerCapture(e.pointerId);
    } catch (err) {}
  });

  container.addEventListener('pointermove', (e) => {
    if (!isDraggingMini || e.pointerId !== dragPointerId) return;

    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;

    if (!hasMovedExceedingThreshold && Math.hypot(deltaX, deltaY) > DRAG_THRESHOLD_PX) {
      hasMovedExceedingThreshold = true;
    }

    if (hasMovedExceedingThreshold) {
      const newLeft = dragInitialLeft + deltaX;
      const newTop = dragInitialTop + deltaY;
      clampMiniVideoPosition(newLeft, newTop);
    }
  });

  const endDrag = (e) => {
    if (!isDraggingMini || e.pointerId !== dragPointerId) return;

    const miniEl = getMiniVideoElement();
    if (miniEl) {
      miniEl.classList.remove('dragging');
      try {
        miniEl.releasePointerCapture(e.pointerId);
      } catch (err) {}
    }

    if (!hasMovedExceedingThreshold) {
      // Tap / Click threshold met -> Swap layout
      swapVideoLayout();
    }

    isDraggingMini = false;
    dragPointerId = null;
  };

  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointercancel', endDrag);

  // Accessibility key bindings
  container.addEventListener('keydown', (e) => {
    const miniEl = getMiniVideoElement();
    if (document.activeElement === miniEl && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      swapVideoLayout();
    }
  });

  // Double-Click / Double-Tap Fullscreen
  container.addEventListener('dblclick', (e) => {
    const primaryEl = getPrimaryVideoElement();
    if (primaryEl && primaryEl.contains(e.target)) {
      fullscreenPage();
    }
  });
}

// Inactivity Control Auto-Hide logic
function isAnyModalOrDrawerOpen() {
  const modals = document.querySelectorAll('.modal.open');
  const drawers = document.querySelectorAll('.drawer.open');
  const volumePopup = document.getElementById('volumePopup');
  return modals.length > 0 || drawers.length > 0 || (volumePopup && volumePopup.classList.contains('open'));
}

function showControls() {
  const controls = document.querySelector('.controls-bar');
  if (controls) {
    controls.classList.remove('hidden');
  }
  resetControlsTimeout();
}

function resetControlsTimeout() {
  if (controlsTimeoutId) clearTimeout(controlsTimeoutId);
  controlsTimeoutId = setTimeout(() => {
    if (!isAnyModalOrDrawerOpen()) {
      const controls = document.querySelector('.controls-bar');
      if (controls) controls.classList.add('hidden');
    }
  }, 4000);
}

function initControlsAutoHide() {
  const events = ['mousemove', 'touchstart', 'pointermove', 'keydown', 'click'];
  events.forEach(evt => {
    window.addEventListener(evt, () => showControls(), { passive: true });
  });
  resetControlsTimeout();
}

// Main Fullscreen Handler
function fullscreenPage() {
  const stage = document.getElementById('roomStage') || document.documentElement;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    if (stage.requestFullscreen) {
      stage.requestFullscreen().catch(() => toast('Fullscreen not supported'));
    } else if (stage.webkitRequestFullscreen) {
      stage.webkitRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

// Init Video Call UX
function initVideoCallUX() {
  updateVideoLayout();
  initDraggableMiniVideo();
  initControlsAutoHide();

  const handleResize = () => clampMiniVideoPosition();
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', handleResize);
  document.addEventListener('fullscreenchange', handleResize);
  document.addEventListener('webkitfullscreenchange', handleResize);
}

// ===== Device & Quality Switchers =====
async function switchVideoDevice(deviceId) {
  selectedVideoDeviceId = deviceId;
  if (!localStream) return;

  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } }
    });
    const newVideoTrack = newStream.getVideoTracks()[0];
    const oldTrack = localStream.getVideoTracks()[0];

    if (oldTrack) {
      localStream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    localStream.addTrack(newVideoTrack);

    const localVideo = document.getElementById('localVideo');
    if (localVideo) localVideo.srcObject = localStream;

    if (pc) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newVideoTrack);
    }
    toast('Camera updated');
  } catch (err) {
    toast('Failed to switch camera device');
  }
}

async function switchAudioDevice(deviceId) {
  selectedAudioDeviceId = deviceId;
  if (!localStream) return;

  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } }
    });
    const newAudioTrack = newStream.getAudioTracks()[0];
    const oldTrack = localStream.getAudioTracks()[0];

    if (oldTrack) {
      localStream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    localStream.addTrack(newAudioTrack);

    if (pc) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) await sender.replaceTrack(newAudioTrack);
    }
    toast('Microphone updated');
  } catch (err) {
    toast('Failed to switch microphone device');
  }
}

async function switchAudioOutputDevice(deviceId) {
  selectedAudioOutputDeviceId = deviceId;
  const audioElements = document.querySelectorAll('video, audio');
  audioElements.forEach(el => {
    if (typeof el.setSinkId === 'function') {
      el.setSinkId(deviceId).catch(err => console.warn('setSinkId failed:', err));
    }
  });
  toast('Audio output updated');
}

async function changeVideoQuality(resolution) {
  selectedVideoQuality = resolution;
  if (!localStream) return;

  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;

  let idealHeight = 720;
  let idealWidth = 1280;

  if (resolution === '1080') { idealWidth = 1920; idealHeight = 1080; }
  else if (resolution === '720') { idealWidth = 1280; idealHeight = 720; }
  else if (resolution === '480') { idealWidth = 854; idealHeight = 480; }
  else if (resolution === '360') { idealWidth = 640; idealHeight = 360; }

  try {
    if (resolution !== 'auto') {
      await videoTrack.applyConstraints({
        width: { ideal: idealWidth },
        height: { ideal: idealHeight }
      });
    } else {
      await videoTrack.applyConstraints({ width: { ideal: 1280 }, height: { ideal: 720 } });
    }
    toast(`Video quality set to ${resolution.toUpperCase()}`);
  } catch (err) {
    console.warn('[LinkDrop] Quality constraint application error:', err);
  }
}

function togglePushToTalk(enabled) {
  isPushToTalk = enabled;
  const audioTrack = localStream?.getAudioTracks()?.[0];
  const btn = document.getElementById('btnAudio');

  if (isPushToTalk) {
    if (audioTrack) audioTrack.enabled = false;
    if (btn) btn.classList.add('off');
    toast('Push-to-Talk ON (Hold Space to talk)');
  } else {
    if (audioTrack) audioTrack.enabled = true;
    if (btn) btn.classList.remove('off');
    toast('Push-to-Talk OFF');
  }
}

// ===== Connection Diagnostics & Stats Monitoring =====
function startStatsMonitoring() {
  if (statsIntervalId) clearInterval(statsIntervalId);
  statsIntervalId = setInterval(() => {
    updateDiagnosticsOutput();
  }, 2500);
}

async function updateDiagnosticsOutput() {
  const output = document.getElementById('diagnosticsOutput');
  if (!output) return;

  if (!pc) {
    output.innerHTML = '<div>No active WebRTC peer connection.</div>';
    return;
  }

  try {
    const stats = await pc.getStats();
    let rtt = null;
    let packetsLost = 0;
    let fps = null;
    let resHeight = null;
    let bytesReceived = 0;
    let bytesSent = 0;

    stats.forEach(report => {
      if (report.type === 'remote-inbound-rtp' && report.roundTripTime) {
        rtt = Math.round(report.roundTripTime * 1000);
      }
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        packetsLost = report.packetsLost || 0;
        fps = report.framesPerSecond;
        bytesReceived = report.bytesReceived || 0;
      }
      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        bytesSent = report.bytesSent || 0;
      }
      if (report.type === 'track' && report.kind === 'video') {
        resHeight = report.frameHeight;
      }
    });

    const quality = (!rtt || rtt < 60) ? 'excellent' : (rtt < 130 ? 'good' : (rtt < 260 ? 'fair' : 'poor'));

    const html = `
      <div style="border-bottom: 1px solid var(--border); padding-bottom: 4px; margin-bottom: 4px;">
        <div><strong>Peer (${escapeHtml(peerDisplayName)}):</strong> <span class="quality-dot ${quality}"></span> ${quality.toUpperCase()}</div>
        <div>Signaling State: ${pc.signalingState}</div>
        <div>Connection State: ${pc.connectionState}</div>
        <div>ICE State: ${pc.iceConnectionState}</div>
        <div>Latency (RTT): ${rtt !== null ? rtt + ' ms' : 'N/A'}</div>
        <div>Packets Lost: ${packetsLost}</div>
        <div>Video Resolution: ${resHeight ? resHeight + 'p' : 'N/A'} ${fps ? '· ' + fps + ' FPS' : ''}</div>
        <div>Data Transferred: ${formatBytes(bytesReceived)} RX / ${formatBytes(bytesSent)} TX</div>
      </div>
    `;
    output.innerHTML = html;
  } catch (err) {
    output.innerHTML = '<div>Error fetching WebRTC diagnostics.</div>';
  }
}

// ===== Settings Tabs Navigation =====
function switchSettingsTab(tabName) {
  const navBtns = document.querySelectorAll('.settings-nav .tab-btn');
  navBtns.forEach(btn => btn.classList.remove('active'));

  const activeBtn = Array.from(navBtns).find(btn => btn.getAttribute('onclick')?.includes(tabName));
  if (activeBtn) activeBtn.classList.add('active');

  const tabContents = document.querySelectorAll('.tab-content');
  tabContents.forEach(tab => tab.style.display = 'none');

  const targetTab = document.getElementById(`tab-${tabName}`);
  if (targetTab) targetTab.style.display = 'flex';

  if (tabName === 'devices') populateDeviceLists();
  if (tabName === 'diagnostics') updateDiagnosticsOutput();
}

async function populateDeviceLists() {
  const videoSelect = document.getElementById('videoInputSelect');
  const audioInputSelect = document.getElementById('audioInputSelect');
  const audioOutputSelect = document.getElementById('audioOutputSelect');

  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (videoSelect) videoSelect.innerHTML = '';
    if (audioInputSelect) audioInputSelect.innerHTML = '';
    if (audioOutputSelect) audioOutputSelect.innerHTML = '';

    devices.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `${device.kind} (${device.deviceId.slice(0, 5)}...)`;

      if (device.kind === 'videoinput' && videoSelect) {
        if (selectedVideoDeviceId && device.deviceId === selectedVideoDeviceId) option.selected = true;
        videoSelect.appendChild(option);
      } else if (device.kind === 'audioinput' && audioInputSelect) {
        if (selectedAudioDeviceId && device.deviceId === selectedAudioDeviceId) option.selected = true;
        audioInputSelect.appendChild(option);
      } else if (device.kind === 'audiooutput' && audioOutputSelect) {
        if (selectedAudioOutputDeviceId && device.deviceId === selectedAudioOutputDeviceId) option.selected = true;
        audioOutputSelect.appendChild(option);
      }
    });
  } catch (err) {
    console.warn('[LinkDrop] Device enumeration failed:', err);
  }
}

function updateRoomSummaryInfo(data) {
  const infoCode = document.getElementById('infoRoomCode');
  const infoMax = document.getElementById('infoMaxMembers');
  const infoPin = document.getElementById('infoPinStatus');

  if (infoCode && roomCode) infoCode.textContent = roomCode;
  if (infoMax) infoMax.textContent = `Strict 1-to-1 (Max 2)`;
  if (infoPin && data) infoPin.textContent = data.protected ? 'Protected (PIN)' : 'Unprotected';
}

// ===== Drawer & Modal Visibility Handlers =====
function toggleDrawer(type) {
  const chatDrawer = document.getElementById('chatDrawer');
  const fileDrawer = document.getElementById('fileDrawer');

  if (type === 'chat') {
    if (fileDrawer) fileDrawer.classList.remove('open');
    if (chatDrawer) {
      chatDrawer.classList.toggle('open');
      if (chatDrawer.classList.contains('open')) {
        unreadChatCount = 0;
        updateChatBadge();
        const chatInput = document.getElementById('chatInput');
        if (chatInput) setTimeout(() => chatInput.focus(), 100);
      }
    }
  } else if (type === 'file') {
    if (chatDrawer) chatDrawer.classList.remove('open');
    if (fileDrawer) fileDrawer.classList.toggle('open');
  }
}

function openSettings() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.classList.add('open');
  switchSettingsTab('general');
}

function closeSettings() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.classList.remove('open');
}

function confirmEndCall() {
  const modal = document.getElementById('endCallModal');
  if (modal) modal.classList.add('open');
}

function closeEndCallModal() {
  const modal = document.getElementById('endCallModal');
  if (modal) modal.classList.remove('open');
}

function leaveRoomSilent() {
  if (statsIntervalId) clearInterval(statsIntervalId);
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  cleanupPeerConnection();
  if (socket) {
    try { socket.disconnect(); } catch(e) {}
    socket = null;
  }
}

function leaveRoom() {
  leaveRoomSilent();
  location.href = '/';
}

// ===== Helper Functions =====
async function copyLink() {
  const text = location.href;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast('Link copied to clipboard!');
    } else {
      const dummy = document.createElement('input');
      document.body.appendChild(dummy);
      dummy.value = text;
      dummy.select();
      document.execCommand('copy');
      document.body.removeChild(dummy);
      toast('Link copied!');
    }
  } catch (err) {
    toast('Copy failed');
  }
}

function toast(msg) {
  let toastEl = document.getElementById('nexusToast') || document.getElementById('linkdropToast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'nexusToast';
    toastEl.style.cssText = `
      position: fixed; top: 64px; left: 50%; transform: translateX(-50%);
      background: var(--surface-solid); border: 1px solid var(--accent);
      color: var(--text); padding: 8px 16px; border-radius: 20px; font-size: 12px;
      z-index: 200; backdrop-filter: blur(8px); box-shadow: 0 4px 15px rgba(0,0,0,0.5);
      transition: opacity 0.3s ease; pointer-events: none;
    `;
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  setTimeout(() => { toastEl.style.opacity = '0'; }, 2000);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ===== Create Room Modal & Password Protection =====
function openCreateModal() {
  const modal = document.getElementById('createRoomModal');
  if (modal) {
    modal.classList.add('open');
    const pinInput = document.getElementById('createPinInput');
    if (pinInput) pinInput.value = '';
    const errBox = document.getElementById('createPinError');
    if (errBox) errBox.style.display = 'none';
  }
}

function closeCreateModal() {
  const modal = document.getElementById('createRoomModal');
  if (modal) modal.classList.remove('open');
}

function togglePinInput(showPin) {
  const pinWrap = document.getElementById('createPinWrap') || document.getElementById('pinInputGroup');
  if (pinWrap) {
    if (typeof showPin === 'boolean') {
      pinWrap.style.display = showPin ? 'block' : 'none';
    } else {
      const radioProtected = document.querySelector('input[name="roomPinOption"][value="pin"]');
      pinWrap.style.display = (radioProtected && radioProtected.checked) ? 'block' : 'none';
    }
  }
}

function generateSecureRoomCodeClient() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const array = new Uint8Array(6);
  window.crypto.getRandomValues(array);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[array[i] % chars.length];
  }
  return code;
}

async function submitCreateRoom() {
  const radioProtected = document.getElementById('radioPinProtected') || document.querySelector('input[name="roomPinOption"][value="pin"]');
  const pinInput = document.getElementById('createPinInput');
  const nameInput = document.getElementById('createDisplayName');
  const errBox = document.getElementById('createPinError');

  let pinVal = null;
  if (radioProtected && radioProtected.checked) {
    pinVal = pinInput ? pinInput.value.trim() : '';
    if (!pinVal || pinVal.length < 4) {
      if (errBox) {
        errBox.textContent = 'PIN must be at least 4 digits.';
        errBox.style.display = 'block';
      }
      return;
    }
  }

  const displayName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : 'Host';

  let code = null;
  try {
    const res = await fetch('/api/create-room-code', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.code) code = data.code;
    }
  } catch (err) {}

  if (!code) code = generateSecureRoomCodeClient();

  sessionStorage.setItem('nexus_host_' + code, 'true');
  sessionStorage.setItem('linkdrop_host_' + code, 'true');
  sessionStorage.setItem('nexus_name', displayName);

  if (pinVal) {
    sessionStorage.setItem('nexus_pin_' + code, pinVal);
    sessionStorage.setItem('linkdrop_pin_' + code, pinVal);
  }

  window.location.href = `/room/${code}`;
}

function submitGuestPin() {
  const pinInput = document.getElementById('guestPinInput');
  const errBox = document.getElementById('pinErrorBox');
  const btn = document.getElementById('btnSubmitPin');

  const pinVal = pinInput ? pinInput.value.trim() : '';
  if (!pinVal) {
    if (errBox) {
      errBox.textContent = 'Please enter a PIN code.';
      errBox.style.display = 'block';
    }
    return;
  }

  if (errBox) errBox.style.display = 'none';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Validating...';
  }

  if (socket) {
    socket.emit('verify-room-pin', { roomId: roomCode, pin: pinVal }, (result) => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Unlock & Join';
      }

      if (!result || !result.success) {
        if (errBox) {
          errBox.textContent = result?.error === 'TOO_MANY_ATTEMPTS'
            ? 'Too many incorrect attempts. Please wait a few minutes.'
            : 'Incorrect PIN code. Please try again.';
          errBox.style.display = 'block';
        }
        if (pinInput) pinInput.focus();
        return;
      }

      const modal = document.getElementById('pinPromptModal');
      if (modal) modal.classList.remove('open');
      toast('PIN Verified!');
      updateConnectionStatus('connecting', 'Joining Room...');

      joinExistingRoom(pinVal);
    });
  }
}

// ===== Client-Side QR Code Modal Generator =====
function openQrModal() {
  const modal = document.getElementById('qrModal');
  const codeSpan = document.getElementById('qrRoomCodeDisplay');
  const container = document.getElementById('qrCanvasContainer');

  if (!roomCode) return;
  if (codeSpan) codeSpan.textContent = roomCode;

  if (container) {
    container.innerHTML = '';
    const fullUrl = `${window.location.origin}/room/${roomCode}`;
    if (typeof QRCode !== 'undefined') {
      new QRCode(container, {
        text: fullUrl,
        width: 180,
        height: 180,
        colorDark: '#ffffff',
        colorLight: '#0f172a',
        correctLevel: QRCode.CorrectLevel.H
      });
    } else {
      container.textContent = fullUrl;
    }
  }

  if (modal) modal.classList.add('open');
}

function closeQrModal() {
  const modal = document.getElementById('qrModal');
  if (modal) modal.classList.remove('open');
}
