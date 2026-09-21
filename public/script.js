/**
 * Nexus — Core Client Logic
 * WebRTC Signaling, P2P Video/Audio, DataChannels (Chat & Files), Screen Sharing
 */

// ===== Global State =====
let socket = null;
let roomCode = null;
let isHost = false;

let localStream = null;
let remoteStream = null;
let screenStream = null;
let isScreenSharing = false;

let pc = null;
let chatChannel = null;
let fileChannel = null;

let queuedCandidates = [];
let silkBg = null;
let unreadChatCount = 0;
let reconnectAttempts = 0;
let isRestartingIce = false;
const MAX_RECONNECT_ATTEMPTS = 3;

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

// Dynamic WebRTC Configuration (Loaded from server endpoint)
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

  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'room' && parts[1]) {
    roomCode = parts[1].toUpperCase();
    setRoomBadge(roomCode);
    updateConnectionStatus('connecting', 'Waiting for permissions...');
  }

  setupEventListeners();
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

// ===== UI & Keyboard Event Listeners =====
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

  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    const key = e.key.toLowerCase();
    if (key === 'm') toggleAudio();
    if (key === 'v') toggleVideo();
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

// ===== Camera & Microphone Media Acquisition & Permission Handling =====
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

  // 1. Request Camera Independently
  try {
    const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
    if (camStream && camStream.getVideoTracks().length > 0) {
      cameraTrack = camStream.getVideoTracks()[0];
    }
  } catch (err) {
    cameraError = getFriendlyMediaError('Camera', err);
  }

  // 2. Request Microphone Independently
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (micStream && micStream.getAudioTracks().length > 0) {
      audioTrack = micStream.getAudioTracks()[0];
    }
  } catch (err) {
    micError = getFriendlyMediaError('Microphone', err);
  }

  // 3. Update UI Status Display
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

  // If neither camera nor microphone was acquired
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

  // Assign Local MediaStream
  localStream = new MediaStream(tracks);

  const localVideo = document.getElementById('localVideo');
  const localAvatar = document.getElementById('localAvatar');

  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.autoplay = true;
    localVideo.muted = true;
    localVideo.playsInline = true;

    try {
      await localVideo.play();
    } catch (e) {}
  }

  if (localAvatar && cameraTrack) {
    localAvatar.style.display = 'none';
  }

  // Hide Pre-Call Modal
  const preCallModal = document.getElementById('preCallModal');
  if (preCallModal) preCallModal.classList.remove('open');

  if (btnAllow) {
    btnAllow.disabled = false;
    btnAllow.textContent = 'Allow & Join Room';
  }

  // Connect Socket.IO signaling & proceed to WebRTC peer connection
  await connectSocketAndJoinRoom();
}

function getFriendlyMediaError(deviceType, err) {
  if (!err) return { short: 'Error', long: `${deviceType} unavailable.` };

  switch (err.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        short: 'Permission Denied',
        long: `Permission denied for ${deviceType.toLowerCase()}. Please check browser site permissions.`
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        short: 'Not Found',
        long: `No ${deviceType.toLowerCase()} device detected on this system.`
      };
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        short: 'In Use',
        long: `${deviceType} is currently in use by another application.`
      };
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return {
        short: 'Hardware Constraint',
        long: `${deviceType} requirements could not be met by your hardware.`
      };
    case 'SecurityError':
      return {
        short: 'Security Restricted',
        long: `${deviceType} access is blocked by browser security policy.`
      };
    default:
      return {
        short: 'Access Error',
        long: `Unable to access ${deviceType.toLowerCase()}: ${err.message || 'unknown error'}`
      };
  }
}

// ===== Socket.IO Connection & Room Signaling Flow =====
function joinExistingRoom(pin) {
  const finalPin = pin || sessionStorage.getItem('nexus_pin_' + roomCode) || sessionStorage.getItem('linkdrop_pin_' + roomCode) || null;
  if (socket) {
    socket.emit('join-room', roomCode, socket.id, finalPin);
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

    // Ask server whether room requires PIN BEFORE joining
    socket.emit('check-room', { roomId: roomCode }, (result) => {
      if (!result || !result.exists) {
        // Room does not exist on server yet -> Host creating room
        const savedPin = sessionStorage.getItem('nexus_pin_' + roomCode) || sessionStorage.getItem('linkdrop_pin_' + roomCode) || null;
        joinExistingRoom(savedPin);
        return;
      }

      if (result.protected) {
        // Check if user is host of this room
        const isHostSession = sessionStorage.getItem('nexus_host_' + roomCode) === 'true' || sessionStorage.getItem('linkdrop_host_' + roomCode) === 'true';
        const savedPin = sessionStorage.getItem('nexus_pin_' + roomCode) || sessionStorage.getItem('linkdrop_pin_' + roomCode);

        if (isHostSession && savedPin) {
          // Host re-entering their protected room -> verify PIN
          socket.emit('verify-room-pin', { roomId: roomCode, pin: savedPin }, (res) => {
            if (res && res.success) {
              joinExistingRoom(savedPin);
            } else {
              showPinModal();
            }
          });
        } else {
          // Guest attempting to join protected room -> Show PIN modal!
          showPinModal();
        }
      } else {
        // Unprotected room -> Join directly!
        joinExistingRoom();
      }
    });
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

  socket.on('request-join', () => {
    isHost = true;
    const approvalPopup = document.getElementById('approvalPopup');
    if (approvalPopup) approvalPopup.classList.add('open');
  });

  socket.on('guest-canceled', () => {
    toast('Guest canceled join request');
    const approvalPopup = document.getElementById('approvalPopup');
    if (approvalPopup) approvalPopup.classList.remove('open');
  });

  socket.on('accepted', async () => {
    toast('Host accepted join request');
    updateConnectionStatus('connecting', 'Establishing P2P...');
  });

  socket.on('rejected', () => {
    toast('Host rejected join request');
    updateConnectionStatus('disconnected', 'Join request rejected');
    setTimeout(() => location.href = '/', 1500);
  });

  socket.on('peer-disconnected', () => {
    toast('Peer disconnected');
    updateConnectionStatus('disconnected', 'Peer disconnected');

    const remoteVideo = document.getElementById('remoteVideo');
    if (remoteVideo) remoteVideo.srcObject = null;
    const remoteAvatar = document.getElementById('remoteAvatar');
    if (remoteAvatar) remoteAvatar.style.display = 'flex';
  });

  // Signaling Offers / Answers / ICE Candidates
  socket.on('offer', async (desc) => {
    if (!pc) pc = createPeer();

    if (localStream) {
      localStream.getTracks().forEach(t => {
        const senders = pc.getSenders();
        if (!senders.some(s => s.track && s.track.id === t.id)) {
          pc.addTrack(t, localStream);
        }
      });
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(desc));
      await flushQueuedCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('answer', roomCode, answer);
    } catch (err) {
      console.error('[Nexus] Error handling offer:', err);
    }
  });

  socket.on('answer', async (desc) => {
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(desc));
        await flushQueuedCandidates();
      } catch (err) {
        console.error('[Nexus] Error setting remote answer:', err);
      }
    }
  });

  socket.on('ice-candidate', async (candidate) => {
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {}
    } else {
      queuedCandidates.push(candidate);
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
    socket.emit('accept', roomCode);
    if (approvalPopup) approvalPopup.classList.remove('open');
    createAndSendOffer();
  };
  if (rejectBtn) rejectBtn.onclick = () => {
    socket.emit('reject', roomCode);
    if (approvalPopup) approvalPopup.classList.remove('open');
  };
}

async function flushQueuedCandidates() {
  while (queuedCandidates.length > 0) {
    const cand = queuedCandidates.shift();
    try {
      if (pc) await pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch (err) {}
  }
}

async function attemptIceRestart(peer) {
  if (isRestartingIce || !peer) return;
  isRestartingIce = true;
  try {
    const offer = await peer.createOffer({ iceRestart: true });
    await peer.setLocalDescription(offer);
    if (socket) socket.emit('offer', roomCode, offer);
  } catch (err) {
    console.error('[Nexus] ICE restart failed:', err);
  } finally {
    isRestartingIce = false;
  }
}

// ===== PeerConnection & Remote Track Handling =====
function createPeer() {
  if (pc) {
    try { pc.close(); } catch(e) {}
  }

  const peer = new RTCPeerConnection(rtcConfig);

  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;
    console.log('[Nexus] WebRTC connectionState:', state);

    switch (state) {
      case 'new':
        updateConnectionStatus('connecting', 'Connecting...');
        break;
      case 'connecting':
        updateConnectionStatus('connecting', reconnectAttempts > 0 ? `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...` : 'Connecting...');
        break;
      case 'connected':
        reconnectAttempts = 0;
        updateConnectionStatus('connected', 'Connected');
        break;
      case 'disconnected':
      case 'failed':
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          updateConnectionStatus('connecting', `Reconnecting P2P (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          toast(`Reconnecting P2P (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          attemptIceRestart(peer);
        } else {
          updateConnectionStatus('disconnected', 'Connection lost. Please reconnect.');
          toast('P2P Connection lost. Please reconnect.');
        }
        break;
      case 'closed':
        updateConnectionStatus('disconnected', 'Call ended');
        break;
    }
  };

  peer.ontrack = (e) => {
    const remoteVideo = document.getElementById('remoteVideo');
    const remoteAvatar = document.getElementById('remoteAvatar');

    if (remoteVideo) {
      let targetStream = null;
      if (e.streams && e.streams[0]) {
        targetStream = e.streams[0];
      } else {
        if (!remoteStream) {
          remoteStream = new MediaStream();
        }
        if (!remoteStream.getTracks().some(t => t.id === e.track.id)) {
          remoteStream.addTrack(e.track);
        }
        targetStream = remoteStream;
      }

      if (remoteVideo.srcObject !== targetStream) {
        remoteVideo.srcObject = targetStream;
      }

      const hasVideo = targetStream.getVideoTracks().some(t => t.readyState === 'live' || t.enabled);
      if (remoteAvatar && (e.track.kind === 'video' || hasVideo)) {
        remoteAvatar.style.display = 'none';
      }

      try {
        remoteVideo.play().catch(err => {});
      } catch (err) {}
    }
  };

  peer.onicecandidate = (e) => {
    if (e.candidate && socket) {
      socket.emit('ice-candidate', roomCode, e.candidate);
    }
  };

  peer.ondatachannel = (e) => {
    const channel = e.channel;
    if (channel.label === 'chat') {
      chatChannel = channel;
      setupChatChannelListeners(chatChannel);
    } else if (channel.label === 'file-transfer') {
      fileChannel = channel;
      setupFileChannelListeners(fileChannel);
    }
  };

  return peer;
}

// ===== Create Offer AFTER addTrack() =====
async function createAndSendOffer() {
  pc = createPeer();

  chatChannel = pc.createDataChannel('chat');
  setupChatChannelListeners(chatChannel);

  fileChannel = pc.createDataChannel('file-transfer');
  setupFileChannelListeners(fileChannel);

  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  if (socket) socket.emit('offer', roomCode, offer);
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
        if (sender) await sender.replaceTrack(screenTrack);
      }

      screenTrack.onended = () => {
        stopScreenShare();
      };

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

  if (pc && cameraTrack) {
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

  channel.onopen = () => {
    console.log('[Nexus] Chat DataChannel opened');
  };

  channel.onclose = () => {
    console.log('[Nexus] Chat DataChannel closed');
  };

  channel.onerror = (err) => {
    console.warn('[Nexus] Chat DataChannel error:', err);
  };

  channel.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data && data.type === 'chat' && typeof data.text === 'string') {
        const cleanText = data.text.slice(0, 2000);
        renderChatMessage(cleanText, 'them', data.timestamp);

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

  if (text.length > 2000) {
    text = text.substring(0, 2000);
    toast('Message truncated to 2000 characters');
  }

  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (chatChannel && chatChannel.readyState === 'open') {
    chatChannel.send(JSON.stringify({ type: 'chat', text, timestamp }));
  } else {
    toast('Chat channel not connected yet');
    return;
  }

  renderChatMessage(text, 'me', timestamp);
  input.value = '';
}

function handleChatKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

// Safe DOM Rendering for Chat Messages (NO innerHTML for untrusted input)
function renderChatMessage(text, sender, timestamp) {
  const container = document.getElementById('chatMessages');
  if (!container) return;

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${sender}`;

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

// ===== P2P File Transfer DataChannel (Backpressure & Safety) =====
function setupFileChannelListeners(channel) {
  if (!channel) return;
  channel.binaryType = 'arraybuffer';

  channel.onopen = () => {
    console.log('[Nexus] File DataChannel opened');
  };

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
  if (!fileChannel || fileChannel.readyState !== 'open') {
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
    await sendSingleFile(file);
  }
}

async function sendSingleFile(file) {
  const fileId = 'file_' + Math.random().toString(36).substr(2, 9);
  activeFileTransfers[fileId] = { cancelled: false, startTime: Date.now() };

  try {
    fileChannel.send(JSON.stringify({
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
  fileChannel.bufferedAmountLowThreshold = 64 * 1024; // 64 KB threshold

  while (offset < file.size) {
    if (activeFileTransfers[fileId]?.cancelled || fileChannel.readyState !== 'open') {
      break;
    }

    // Backpressure handling: wait when buffer exceeds 128 KB
    if (fileChannel.bufferedAmount > 128 * 1024) {
      await new Promise(resolve => {
        let timeout = setTimeout(() => {
          fileChannel.onbufferedamountlow = null;
          resolve();
        }, 1000);

        fileChannel.onbufferedamountlow = () => {
          clearTimeout(timeout);
          fileChannel.onbufferedamountlow = null;
          resolve();
        };
      });
    }

    if (activeFileTransfers[fileId]?.cancelled || fileChannel.readyState !== 'open') {
      break;
    }

    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await slice.arrayBuffer();

    try {
      fileChannel.send(buffer);
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
    fileChannel.send(JSON.stringify({ type: 'file-end', id: fileId }));
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

// ===== Audio & Video Media Toggles =====
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
}

function setRemoteVolume(val) {
  const remoteVideo = document.getElementById('remoteVideo');
  const volVal = document.getElementById('volVal');
  const settingsVolVal = document.getElementById('settingsVolVal');
  const volumeSlider = document.getElementById('volumeSlider');
  const settingsVolumeSlider = document.getElementById('settingsVolumeSlider');
  const volumeIcon = document.getElementById('volumeIcon');

  const vol = Math.max(0, Math.min(100, parseInt(val, 10) || 0));
  const volumeDecimal = vol / 100;

  if (remoteVideo) {
    remoteVideo.volume = volumeDecimal;
  }
  if (volVal) volVal.textContent = `${vol}%`;
  if (settingsVolVal) settingsVolVal.textContent = `${vol}%`;
  if (volumeSlider) volumeSlider.value = vol;
  if (settingsVolumeSlider) settingsVolumeSlider.value = vol;

  if (volumeIcon) {
    if (vol === 0) {
      volumeIcon.innerHTML = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
    } else if (vol < 50) {
      volumeIcon.innerHTML = '<path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>';
    } else {
      volumeIcon.innerHTML = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
    }
  }
}

function toggleVolumeSlider() {
  const popup = document.getElementById('volumePopup');
  if (popup) {
    popup.classList.toggle('open');
  }
}

function toggleVideo() {
  if (!localStream) {
    toast('Media stream not active');
    return;
  }
  const videoTrack = localStream.getVideoTracks()?.[0];
  const btn = document.getElementById('btnVideo');
  const avatar = document.getElementById('localAvatar');

  if (!videoTrack) {
    toast('No camera track available');
    return;
  }

  videoTrack.enabled = !videoTrack.enabled;
  if (btn) btn.classList.toggle('off', !videoTrack.enabled);
  if (avatar) avatar.style.display = videoTrack.enabled ? 'none' : 'flex';

  toast(videoTrack.enabled ? 'Camera Enabled' : 'Camera Disabled');
}

// ===== Fullscreen =====
function fullscreenPage() {
  const elem = document.documentElement;
  try {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (elem.requestFullscreen) elem.requestFullscreen();
      else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
      else if (elem.msRequestFullscreen) elem.msRequestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  } catch (err) {
    toast('Fullscreen toggle failed');
  }
}

function toggleDrawer(type) {
  const chatDrawer = document.getElementById('chatDrawer');
  const fileDrawer = document.getElementById('fileDrawer');

  if (type === 'chat') {
    fileDrawer?.classList.remove('open');
    chatDrawer?.classList.toggle('open');
    if (chatDrawer?.classList.contains('open')) {
      unreadChatCount = 0;
      updateChatBadge();
      document.getElementById('chatInput')?.focus();
    }
  } else if (type === 'file') {
    chatDrawer?.classList.remove('open');
    fileDrawer?.classList.toggle('open');
  }
}

// ===== Settings & Media Devices Switcher =====
function openSettings() {
  const modal = document.getElementById('settingsModal');
  if (modal) {
    modal.classList.add('open');
    populateMediaDevices();
  }
}

function closeSettings() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.classList.remove('open');
}

async function populateMediaDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioSelect = document.getElementById('audioInputSelect');
    const videoSelect = document.getElementById('videoInputSelect');

    if (audioSelect) audioSelect.innerHTML = '';
    if (videoSelect) videoSelect.innerHTML = '';

    devices.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `${device.kind === 'audioinput' ? 'Mic' : 'Cam'} (${device.deviceId.substr(0, 5)})`;

      if (device.kind === 'audioinput' && audioSelect) {
        audioSelect.appendChild(option);
      } else if (device.kind === 'videoinput' && videoSelect) {
        videoSelect.appendChild(option);
      }
    });
  } catch (err) {}
}

async function switchAudioDevice(deviceId) {
  if (!localStream || !deviceId) return;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    const newTrack = newStream.getAudioTracks()[0];

    const oldTrack = localStream.getAudioTracks()[0];
    if (oldTrack) {
      localStream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    localStream.addTrack(newTrack);

    if (pc) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) await sender.replaceTrack(newTrack);
    }
    toast('Audio input updated');
  } catch (err) {
    toast('Failed to switch audio input');
  }
}

async function switchVideoDevice(deviceId) {
  if (!localStream || !deviceId) return;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
    const newTrack = newStream.getVideoTracks()[0];

    const oldTrack = localStream.getVideoTracks()[0];
    if (oldTrack) {
      localStream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    localStream.addTrack(newTrack);

    const localVideo = document.getElementById('localVideo');
    if (localVideo) {
      localVideo.srcObject = localStream;
      localVideo.play().catch(e => {});
    }

    if (pc && !isScreenSharing) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    }
    toast('Camera updated');
  } catch (err) {
    toast('Failed to switch camera');
  }
}

function toggleMirrorVideo(isMirrored) {
  const wrap = document.getElementById('localVideoWrap');
  if (wrap) {
    if (isMirrored) wrap.classList.add('mirror');
    else wrap.classList.remove('mirror');
  }
}

function clearPreferences() {
  localStorage.clear();
  changeTheme('cyber');
  toast('Preferences reset');
}

// ===== End Call & Stop All Tracks =====
function confirmEndCall() {
  const modal = document.getElementById('endCallModal');
  if (modal) modal.classList.add('open');
}

function closeEndCallModal() {
  const modal = document.getElementById('endCallModal');
  if (modal) modal.classList.remove('open');
}

function leaveRoom() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
    remoteStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  if (chatChannel) {
    try { chatChannel.close(); } catch(e) {}
    chatChannel = null;
  }
  if (fileChannel) {
    try { fileChannel.close(); } catch(e) {}
    fileChannel = null;
  }
  if (pc) {
    try { pc.close(); } catch(e) {}
    pc = null;
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
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 unambiguous alphanumeric characters
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

  const code = generateSecureRoomCode();
  sessionStorage.setItem('nexus_host_' + code, 'true');
  sessionStorage.setItem('linkdrop_host_' + code, 'true');
  if (pinVal) {
    sessionStorage.setItem('nexus_pin_' + code, pinVal);
    sessionStorage.setItem('linkdrop_pin_' + code, pinVal);
  }

  window.location.href = `/room/${code}`;
}


function handleGuestPinKeyDown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitGuestPin();
  }
}

// ===== Guest PIN Validation Handler =====
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
