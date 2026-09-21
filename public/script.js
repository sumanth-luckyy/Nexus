/**
 * Nexus — Core Client Logic
 * WebRTC Multi-Participant Mesh Signaling, Media Management, DataChannels, Device & Quality Controls
 */

// ===== Global State =====
let socket = null;
let roomCode = null;
let isHost = false;
let myDisplayName = 'User';
let maxRoomMembers = 2;

let localStream = null;
let remoteStream = null;
let screenStream = null;
let isScreenSharing = false;

// Multi-Peer State (Mesh Architecture)
const peers = {}; // { [socketId]: { socketId, displayName, pc, chatChannel, fileChannel, stream, quality, stats } }
let pc = null; // Legacy single-peer fallback reference
let chatChannel = null;
let fileChannel = null;

let queuedCandidates = [];
let silkBg = null;
let unreadChatCount = 0;
let reconnectAttempts = 0;
let isRestartingIce = false;
const MAX_RECONNECT_ATTEMPTS = 3;

// Device & Quality Selection State
let selectedVideoDeviceId = null;
let selectedAudioDeviceId = null;
let selectedAudioOutputDeviceId = null;
let selectedVideoQuality = 'auto';
let isPushToTalk = false;
let isSpacePressed = false;
let statsIntervalId = null;
let focusedSocketId = null;

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
const MAX_SIMULTANEOUS_TRANSFERS = 3;
const CHUNK_SIZE = 16384; // 16 KB

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
    console.warn('[Nexus] Dynamic ICE fetch failed, using default STUN fallback');
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

  const radioNone = document.getElementById('radioNoPin');
  const radioProtected = document.getElementById('radioPinProtected');
  if (radioNone) radioNone.onchange = togglePinInput;
  if (radioProtected) radioProtected.onchange = togglePinInput;

  // QR Modal bindings (Room page)
  const btnQr = document.getElementById('btnQrCode');
  if (btnQr) btnQr.onclick = openQrModal;

  const btnSettingsQr = document.getElementById('btnSettingsQr');
  if (btnSettingsQr) btnSettingsQr.onclick = () => { closeSettings(); openQrModal(); };

  const btnModalCancelQr = document.getElementById('btnModalCancelQr');
  if (btnModalCancelQr) btnModalCancelQr.onclick = closeQrModal;

  const btnCopyQrLink = document.getElementById('btnCopyQrLink');
  if (btnCopyQrLink) btnCopyQrLink.onclick = copyLink;

  // Guest PIN Prompt bindings (Room page)
  const btnSubmitPin = document.getElementById('btnSubmitPin');
  if (btnSubmitPin) btnSubmitPin.onclick = submitGuestPin;

  const btnCancelPin = document.getElementById('btnCancelPin');
  if (btnCancelPin) btnCancelPin.onclick = () => { location.href = '/'; };

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
}

function setupNetworkListeners() {
  window.addEventListener('online', () => {
    toast('Network reconnected — restarting ICE...');
    updateConnectionStatus('connecting', 'Reconnecting...');
    for (const id in peers) {
      if (peers[id] && peers[id].pc) attemptIceRestart(peers[id].pc);
    }
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

  try {
    const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
    if (camStream && camStream.getVideoTracks().length > 0) {
      cameraTrack = camStream.getVideoTracks()[0];
    }
  } catch (err) {
    cameraError = getFriendlyMediaError('Camera', err);
  }

  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (micStream && micStream.getAudioTracks().length > 0) {
      audioTrack = micStream.getAudioTracks()[0];
    }
  } catch (err) {
    micError = getFriendlyMediaError('Microphone', err);
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
    default:
      return { short: 'Access Error', long: `Unable to access ${deviceType.toLowerCase()}: ${err.message || 'unknown error'}` };
  }
}

// ===== Socket.IO Connection & Room Signaling Flow =====
function joinExistingRoom(pin) {
  const finalPin = pin || sessionStorage.getItem('nexus_pin_' + roomCode) || sessionStorage.getItem('linkdrop_pin_' + roomCode) || null;
  const storedMax = sessionStorage.getItem('nexus_max_' + roomCode) || '2';
  const storedName = sessionStorage.getItem('nexus_name') || 'User';

  if (socket) {
    socket.emit('join-room', roomCode, socket.id, finalPin, storedMax, storedName);
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

  socket = io(serverUrl);

  socket.on('connect', () => {
    updateConnectionStatus('connecting', 'Signaling Connected...');

    socket.emit('check-room', { roomId: roomCode }, (result) => {
      if (result && result.maxMembers) {
        maxRoomMembers = result.maxMembers;
      }

      if (!result || !result.exists) {
        const savedPin = sessionStorage.getItem('nexus_pin_' + roomCode) || sessionStorage.getItem('linkdrop_pin_' + roomCode) || null;
        joinExistingRoom(savedPin);
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
      maxRoomMembers = data.maxMembers || 2;
      updateRoomSummaryInfo(data);
    }
  });

  socket.on('pin-required', () => {
    showPinModal();
  });

  socket.on('incorrect-pin', (msg) => {
    const errBox = document.getElementById('pinErrorBox');
    if (errBox) {
      errBox.textContent = msg === 'TOO_MANY_ATTEMPTS'
        ? 'Too many incorrect attempts. Please wait a few minutes.'
        : 'Incorrect PIN code. Please try again.';
      errBox.style.display = 'block';
    }
    const btn = document.getElementById('btnSubmitPin');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Unlock & Join';
    }
  });

  socket.on('pin-valid', () => {
    const modal = document.getElementById('pinPromptModal');
    if (modal) modal.classList.remove('open');
    toast('PIN Verified!');
    updateConnectionStatus('connecting', 'Joining Room...');
  });

  socket.on('room-full', () => {
    toast('This room is full');
    updateConnectionStatus('disconnected', 'This room is full');
    setTimeout(() => location.href = '/', 2000);
  });

  socket.on('request-join', (data) => {
    isHost = true;
    const approvalPopup = document.getElementById('approvalPopup');
    if (approvalPopup) {
      const msgText = approvalPopup.querySelector('p');
      if (msgText) msgText.textContent = `${data?.displayName || 'A participant'} wants to join your Nexus room.`;
      approvalPopup.dataset.targetId = data?.socketId || '';
      approvalPopup.classList.add('open');
    }
  });

  socket.on('guest-canceled', () => {
    toast('Guest canceled join request');
    const approvalPopup = document.getElementById('approvalPopup');
    if (approvalPopup) approvalPopup.classList.remove('open');
  });

  socket.on('accepted', async (data) => {
    toast('Host accepted join request!');
    updateConnectionStatus('connecting', 'Establishing P2P...');
    if (data && data.members) {
      data.members.forEach(m => {
        if (m.socketId !== socket.id) {
          getOrCreatePeer(m.socketId, m.displayName, false);
        }
      });
    }
    startStatsMonitoring();
  });

  socket.on('rejected', () => {
    toast('Host rejected join request');
    updateConnectionStatus('disconnected', 'Join request rejected');
    setTimeout(() => location.href = '/', 1500);
  });

  socket.on('user-joined', (data) => {
    toast(`${data.displayName || 'New participant'} joined the room`);
    if (data && data.socketId && data.socketId !== socket.id) {
      getOrCreatePeer(data.socketId, data.displayName, true);
    }
  });

  socket.on('user-left', (data) => {
    const peerId = data?.socketId || data;
    if (peerId && peers[peerId]) {
      toast(`${peers[peerId].displayName || 'Participant'} left`);
      removePeer(peerId);
    }
  });

  socket.on('host-changed', (data) => {
    if (data && data.newHostId === socket.id) {
      isHost = true;
      toast('You are now the Host of this room');
    } else if (data) {
      toast(`New Host: ${data.newHostName || 'Peer'}`);
    }
  });

  // Targeted & Fallback WebRTC Signaling
  socket.on('offer', async (data, legacySenderId) => {
    const offer = data.offer || data;
    const senderId = data.senderId || legacySenderId;
    const senderName = data.senderName || 'Peer';

    if (!senderId) return;

    const peerObj = getOrCreatePeer(senderId, senderName, false);
    const peerConnection = peerObj.pc;

    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      await flushQueuedCandidates();

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socket.emit('answer', roomCode, answer, senderId);
    } catch (err) {
      console.error('[Nexus] Error handling offer:', err);
    }
  });

  socket.on('answer', async (data, legacySenderId) => {
    const answer = data.answer || data;
    const senderId = data.senderId || legacySenderId;

    if (senderId && peers[senderId]) {
      try {
        await peers[senderId].pc.setRemoteDescription(new RTCSessionDescription(answer));
        await flushQueuedCandidates();
      } catch (err) {
        console.error('[Nexus] Error setting remote answer:', err);
      }
    } else if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await flushQueuedCandidates();
      } catch (err) {}
    }
  });

  socket.on('ice-candidate', async (data, legacySenderId) => {
    const candidate = data.candidate || data;
    const senderId = data.senderId || legacySenderId;

    const targetPc = (senderId && peers[senderId]) ? peers[senderId].pc : pc;

    if (targetPc && targetPc.remoteDescription && targetPc.remoteDescription.type) {
      try {
        await targetPc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {}
    } else {
      queuedCandidates.push({ candidate, senderId });
    }
  });

  socket.on('screen-share-state', (isSharing) => {
    const banner = document.getElementById('screenShareBanner');
    const txt = document.getElementById('screenShareText');
    if (banner && txt) {
      txt.textContent = isSharing ? 'Peer is sharing their screen' : 'Screen Share Active';
      banner.style.display = isSharing ? 'flex' : 'none';
    }
  });

  // Host Popup Controls
  const acceptBtn = document.getElementById('acceptBtn');
  const rejectBtn = document.getElementById('rejectBtn');
  const approvalPopup = document.getElementById('approvalPopup');

  if (acceptBtn) acceptBtn.onclick = () => {
    const targetId = approvalPopup?.dataset?.targetId;
    socket.emit('accept', roomCode, targetId);
    if (approvalPopup) approvalPopup.classList.remove('open');
    if (targetId) {
      getOrCreatePeer(targetId, 'Guest', true);
    } else {
      createAndSendOffer();
    }
  };
  if (rejectBtn) rejectBtn.onclick = () => {
    const targetId = approvalPopup?.dataset?.targetId;
    socket.emit('reject', roomCode, targetId);
    if (approvalPopup) approvalPopup.classList.remove('open');
  };
}

// ===== Peer Connection Factory (Mesh Architecture) =====
function getOrCreatePeer(targetSocketId, targetDisplayName, isInitiator = false) {
  if (peers[targetSocketId]) return peers[targetSocketId];

  const peerConnection = new RTCPeerConnection(rtcConfig);
  pc = peerConnection; // Fallback reference

  const peerObj = {
    socketId: targetSocketId,
    displayName: targetDisplayName || 'Peer',
    pc: peerConnection,
    chatChannel: null,
    fileChannel: null,
    stream: null,
    quality: 'good'
  };

  peers[targetSocketId] = peerObj;

  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.onicecandidate = (e) => {
    if (e.candidate && socket) {
      socket.emit('ice-candidate', roomCode, e.candidate, targetSocketId);
    }
  };

  peerConnection.ontrack = (e) => {
    let remoteMediaStream = peerObj.stream;
    if (!remoteMediaStream) {
      remoteMediaStream = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream();
      peerObj.stream = remoteMediaStream;
      remoteStream = remoteMediaStream; // Fallback
    }
    if (!remoteMediaStream.getTracks().some(t => t.id === e.track.id)) {
      remoteMediaStream.addTrack(e.track);
    }

    renderParticipantVideoTile(targetSocketId, peerObj.displayName, remoteMediaStream);
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log(`[Nexus] WebRTC connectionState with ${targetSocketId}:`, state);
    if (state === 'connected') {
      updateConnectionStatus('connected', 'Connected');
    } else if (state === 'disconnected' || state === 'failed') {
      attemptIceRestart(peerConnection);
    }
  };

  if (isInitiator) {
    const chatCh = peerConnection.createDataChannel('chat');
    setupChatChannelListeners(chatCh);
    peerObj.chatChannel = chatCh;
    chatChannel = chatCh;

    const fileCh = peerConnection.createDataChannel('file-transfer');
    setupFileChannelListeners(fileCh);
    peerObj.fileChannel = fileCh;
    fileChannel = fileCh;

    peerConnection.createOffer()
      .then(offer => peerConnection.setLocalDescription(offer))
      .then(() => {
        socket.emit('offer', roomCode, peerConnection.localDescription, targetSocketId);
      })
      .catch(err => console.error('[Nexus] Create offer error:', err));
  } else {
    peerConnection.ondatachannel = (e) => {
      const channel = e.channel;
      if (channel.label === 'chat') {
        peerObj.chatChannel = channel;
        chatChannel = channel;
        setupChatChannelListeners(channel);
      } else if (channel.label === 'file-transfer') {
        peerObj.fileChannel = channel;
        fileChannel = channel;
        setupFileChannelListeners(channel);
      }
    };
  }

  return peerObj;
}

function removePeer(targetSocketId) {
  if (peers[targetSocketId]) {
    try { peers[targetSocketId].pc.close(); } catch(e) {}
    delete peers[targetSocketId];
  }
  removeParticipantVideoTile(targetSocketId);

  if (Object.keys(peers).length === 0) {
    updateConnectionStatus('disconnected', 'Waiting for peer...');
    const remoteVideo = document.getElementById('remoteVideo');
    if (remoteVideo) remoteVideo.srcObject = null;
    const remoteAvatar = document.getElementById('remoteAvatar');
    if (remoteAvatar) remoteAvatar.style.display = 'flex';
  }
}

// ===== Dynamic Video Tile Rendering =====
function renderParticipantVideoTile(socketId, displayName, mediaStream) {
  const container = document.getElementById('remoteVideoWrap');
  if (!container) return;

  const remoteVideo = document.getElementById('remoteVideo');
  const remoteAvatar = document.getElementById('remoteAvatar');

  if (Object.keys(peers).length <= 1 && remoteVideo) {
    remoteVideo.srcObject = mediaStream;
    if (remoteAvatar) remoteAvatar.style.display = 'none';
    try { remoteVideo.play().catch(e => {}); } catch(e) {}
    return;
  }

  let tile = document.getElementById(`tile_${socketId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.id = `tile_${socketId}`;
    tile.className = 'participant-tile';
    tile.onclick = () => focusParticipantTile(socketId);

    const videoEl = document.createElement('video');
    videoEl.id = `video_${socketId}`;
    videoEl.autoplay = true;
    videoEl.playsInline = true;

    const badge = document.createElement('div');
    badge.className = 'tile-badge';
    badge.innerHTML = `<span class="quality-dot good" id="q_${socketId}"></span> <span id="name_${socketId}">${escapeHtml(displayName)}</span>`;

    tile.appendChild(videoEl);
    tile.appendChild(badge);
    container.appendChild(tile);
  }

  const videoElement = document.getElementById(`video_${socketId}`);
  if (videoElement && videoElement.srcObject !== mediaStream) {
    videoElement.srcObject = mediaStream;
    try { videoElement.play().catch(e => {}); } catch(e) {}
  }
}

function removeParticipantVideoTile(socketId) {
  const tile = document.getElementById(`tile_${socketId}`);
  if (tile && tile.parentNode) {
    tile.parentNode.removeChild(tile);
  }
  if (focusedSocketId === socketId) focusedSocketId = null;
}

function focusParticipantTile(socketId) {
  focusedSocketId = (focusedSocketId === socketId) ? null : socketId;
  const tiles = document.querySelectorAll('.participant-tile');
  tiles.forEach(t => t.classList.remove('focused'));

  if (focusedSocketId) {
    const targetTile = document.getElementById(`tile_${socketId}`);
    if (targetTile) targetTile.classList.add('focused');
    toast(`Focused: ${peers[socketId]?.displayName || 'Peer'}`);
  }
}

async function flushQueuedCandidates() {
  while (queuedCandidates.length > 0) {
    const item = queuedCandidates.shift();
    const cand = item.candidate || item;
    const targetId = item.senderId;
    const targetPc = (targetId && peers[targetId]) ? peers[targetId].pc : pc;
    try {
      if (targetPc) await targetPc.addIceCandidate(new RTCIceCandidate(cand));
    } catch (err) {}
  }
}

async function attemptIceRestart(peerConnection) {
  if (isRestartingIce || !peerConnection) return;
  isRestartingIce = true;
  try {
    const offer = await peerConnection.createOffer({ iceRestart: true });
    await peerConnection.setLocalDescription(offer);
    if (socket) socket.emit('offer', roomCode, offer);
  } catch (err) {
    console.error('[Nexus] ICE restart failed:', err);
  } finally {
    isRestartingIce = false;
  }
}

// ===== Create Offer AFTER addTrack() =====
async function createAndSendOffer() {
  pc = createPeer();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  if (socket) socket.emit('offer', roomCode, offer);
}

function createPeer() {
  const peerObj = getOrCreatePeer('default_peer', 'Guest', true);
  return peerObj.pc;
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

      for (const id in peers) {
        const peerObj = peers[id];
        if (peerObj && peerObj.pc) {
          const sender = peerObj.pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) await sender.replaceTrack(screenTrack);
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

  if (cameraTrack) {
    for (const id in peers) {
      const peerObj = peers[id];
      if (peerObj && peerObj.pc) {
        const sender = peerObj.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          sender.replaceTrack(cameraTrack);
          cameraTrack.enabled = true;
        }
      }
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

  channel.onopen = () => { console.log('[Nexus] Chat DataChannel opened'); };
  channel.onclose = () => { console.log('[Nexus] Chat DataChannel closed'); };
  channel.onerror = (err) => { console.warn('[Nexus] Chat DataChannel error:', err); };

  channel.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data && data.type === 'chat' && typeof data.text === 'string') {
        const cleanText = data.text.slice(0, 2000);
        renderChatMessage(cleanText, 'them', data.timestamp, data.sender || 'Peer');

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

  let sent = false;
  for (const id in peers) {
    const ch = peers[id]?.chatChannel || chatChannel;
    if (ch && ch.readyState === 'open') {
      try { ch.send(payload); sent = true; } catch(e) {}
    }
  }

  if (chatChannel && chatChannel.readyState === 'open' && !sent) {
    try { chatChannel.send(payload); sent = true; } catch(e) {}
  }

  renderChatMessage(text, 'me', timestamp, myDisplayName);
  input.value = '';
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

  channel.onopen = () => { console.log('[Nexus] File DataChannel opened'); };
  channel.onclose = () => {
    console.log('[Nexus] File DataChannel closed');
    cleanupIncompleteTransfers('Channel closed');
  };
  channel.onerror = (err) => {
    console.warn('[Nexus] File DataChannel error:', err);
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

          if (Object.keys(incomingFileTransfers).length >= MAX_SIMULTANEOUS_TRANSFERS) {
            toast('Maximum simultaneous transfers reached');
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
  const targetChannel = getActiveFileChannel();
  if (!targetChannel || targetChannel.readyState !== 'open') {
    toast('P2P connection not connected for files');
    return;
  }

  const fileList = Array.from(files);
  if (fileList.length + Object.keys(activeFileTransfers).length > MAX_SIMULTANEOUS_TRANSFERS) {
    toast(`Maximum ${MAX_SIMULTANEOUS_TRANSFERS} simultaneous transfers allowed`);
  }

  for (const file of fileList.slice(0, MAX_SIMULTANEOUS_TRANSFERS)) {
    if (file.size > MAX_FILE_SIZE) {
      toast(`File ${file.name} exceeds 500MB limit`);
      continue;
    }
    await sendSingleFile(file, targetChannel);
  }
}

function getActiveFileChannel() {
  for (const id in peers) {
    if (peers[id]?.fileChannel?.readyState === 'open') return peers[id].fileChannel;
  }
  return fileChannel;
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
      console.warn('[Nexus] Send chunk error:', err);
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
  const targetChannel = getActiveFileChannel();
  if (targetChannel && targetChannel.readyState === 'open') {
    try {
      targetChannel.send(JSON.stringify({ type: 'file-cancel', id }));
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

  if (socket) {
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

  if (socket) {
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

  const audioElements = document.querySelectorAll('video');
  audioElements.forEach(video => {
    if (video.id !== 'localVideo') {
      video.volume = val / 100;
    }
  });
}

function fullscreenPage() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(err => {
      toast('Fullscreen not supported');
    });
  } else {
    document.exitFullscreen();
  }
}

// ===== Picture-in-Picture Control =====
async function togglePictureInPicture() {
  if (!document.pictureInPictureEnabled) {
    toast('Picture-in-Picture is not supported in this browser');
    return;
  }

  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      const activeVideo = document.getElementById('remoteVideo') || document.getElementById('localVideo');
      if (activeVideo && activeVideo.srcObject) {
        await activeVideo.requestPictureInPicture();
      } else {
        toast('No active video stream for Picture-in-Picture');
      }
    }
  } catch (err) {
    console.warn('[Nexus] Picture-in-Picture failed:', err);
    toast('Picture-in-Picture failed');
  }
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

    for (const id in peers) {
      const peerObj = peers[id];
      if (peerObj && peerObj.pc) {
        const sender = peerObj.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(newVideoTrack);
      }
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

    for (const id in peers) {
      const peerObj = peers[id];
      if (peerObj && peerObj.pc) {
        const sender = peerObj.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
        if (sender) await sender.replaceTrack(newAudioTrack);
      }
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
    console.warn('[Nexus] Quality constraint application error:', err);
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

  let html = '';
  for (const id in peers) {
    const peerObj = peers[id];
    if (peerObj && peerObj.pc) {
      try {
        const stats = await peerObj.pc.getStats();
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
        peerObj.quality = quality;

        const dotEl = document.getElementById(`q_${id}`);
        if (dotEl) dotEl.className = `quality-dot ${quality}`;

        html += `
          <div style="border-bottom: 1px solid var(--border); padding-bottom: 4px; margin-bottom: 4px;">
            <div><strong>Peer (${peerObj.displayName || id.slice(0, 6)}):</strong> <span class="quality-dot ${quality}"></span> ${quality.toUpperCase()}</div>
            <div>Latency (RTT): ${rtt !== null ? rtt + ' ms' : 'N/A'}</div>
            <div>Packets Lost: ${packetsLost}</div>
            <div>Video: ${resHeight ? resHeight + 'p' : 'N/A'} ${fps ? '· ' + fps + ' FPS' : ''}</div>
            <div>Data: ${formatBytes(bytesReceived)} RX / ${formatBytes(bytesSent)} TX</div>
          </div>
        `;
      } catch (err) {}
    }
  }

  if (!html) html = '<div>No active WebRTC peer connections.</div>';
  output.innerHTML = html;
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
    console.warn('[Nexus] Device enumeration failed:', err);
  }
}

function updateRoomSummaryInfo(data) {
  const infoCode = document.getElementById('infoRoomCode');
  const infoMax = document.getElementById('infoMaxMembers');
  const infoPin = document.getElementById('infoPinStatus');

  if (infoCode && roomCode) infoCode.textContent = roomCode;
  if (infoMax && data) infoMax.textContent = `${data.members ? data.members.length : 1} / ${data.maxMembers} Members`;
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

function leaveRoom() {
  if (statsIntervalId) clearInterval(statsIntervalId);
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  for (const id in peers) {
    try { peers[id].pc.close(); } catch(e) {}
  }
  if (socket) {
    try { socket.disconnect(); } catch(e) {}
    socket = null;
  }
  if (silkBg && typeof silkBg.destroy === 'function') {
    try { silkBg.destroy(); } catch(e) {}
    silkBg = null;
  }

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

function generateSecureRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const array = new Uint8Array(6);
  window.crypto.getRandomValues(array);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[array[i] % chars.length];
  }
  return code;
}

function submitCreateRoom() {
  const radioProtected = document.getElementById('radioPinProtected') || document.querySelector('input[name="roomPinOption"][value="pin"]');
  const pinInput = document.getElementById('createPinInput');
  const maxMembersSelect = document.getElementById('createMaxMembers');
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

  const maxMembers = maxMembersSelect ? maxMembersSelect.value : '2';
  const displayName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : 'Host';

  const code = generateSecureRoomCode();
  sessionStorage.setItem('nexus_host_' + code, 'true');
  sessionStorage.setItem('linkdrop_host_' + code, 'true');
  sessionStorage.setItem('nexus_name', displayName);
  sessionStorage.setItem('nexus_max_' + code, maxMembers);

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
