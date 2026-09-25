/**
 * LinkDrop / Nexus — Multi-Participant WebRTC Engine & Call Manager
 * Dynamic Mesh WebRTC, Targeted Signaling, Front/Back Mobile Camera Switching,
 * Draggable Preview with Drag-to-Hide Trash Target, P2P Chat & File Share.
 */

// ===== Global State =====
let socket = null;
let roomCode = null;
let isHost = false;
let myDisplayName = 'User';
let mySocketId = null;

let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let currentFacingMode = 'user'; // 'user' (front) or 'environment' (back)
let isLocalPreviewHidden = false;

// Pending Host Join Requests Queue
const pendingJoinRequests = [];

// Room Lock & Feature States
let isRoomLocked = false;
let isHandRaised = false;
let currentLayoutMode = 'grid'; // 'grid' | 'active' | 'spotlight'
let activeSpeakerId = null;
let pinnedParticipantId = null;
let mainParticipantId = null; // 'local' or socketId of participant in MAIN stage
let smallParticipantId = 'local'; // 'local' or socketId of participant in SMALL floating preview
let isManualSwapPinned = false; // true when user manually swapped/spotlighted a participant
let audioCtx = null;
const speakerAnalysis = new Map(); // socketId -> { analyser, source, volumeHistory }
let hlsPlayerInstance = null;

// Multi-Participant Peer Connections Store
// Map<socketId, { socketId, displayName, pc, remoteStream, chatChannel, fileChannel, pendingIceCandidates, audioEnabled, videoEnabled }>
const peerConnections = new Map();

let silkBg = null;
let unreadChatCount = 0;
let statsIntervalId = null;
let audioCheckIntervalId = null;
let maxRoomParticipants = 2;

// Timing Instrumentation per peer
const timing = {
  t1_socketConnected: null,
  t2_roomJoined: null,
  t3_joinRequestReceived: null,
  t4_accepted: null
};

// Device & Quality Selection State
let selectedVideoDeviceId = null;
let selectedAudioDeviceId = null;
let selectedAudioOutputDeviceId = null;
let selectedVideoQuality = 'auto';
let isPushToTalk = false;
let isSpacePressed = false;

// WebRTC High Quality & Encoding Target Configurations
const QUALITY_TARGETS = {
  '1080p': { label: '1080p', maxBitrate: 3500000, maxFramerate: 30, height: 1080, width: 1920 },
  '720p':  { label: '720p',  maxBitrate: 1800000, maxFramerate: 30, height: 720,  width: 1280 },
  '540p':  { label: '540p',  maxBitrate: 1000000, maxFramerate: 25, height: 540,  width: 960 },
  '360p':  { label: '360p',  maxBitrate: 500000,  maxFramerate: 20, height: 360,  width: 640 }
};

let localCameraSettings = {
  width: 0,
  height: 0,
  frameRate: 0,
  facingMode: 'user'
};

let localCameraCapabilities = null;
let currentEffectiveQualityTier = '720p';
let lastQualityAdaptTime = Date.now();

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
const CHUNK_SIZE = 32768; // 32 KB chunk size for DataChannel

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
    toast('Network reconnected — restarting WebRTC ICE for participants...');
    updateConnectionStatus('connecting', 'Reconnecting WebRTC...');
    peerConnections.forEach((peerData) => {
      attemptIceRestartFor(peerData.socketId);
    });
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

  // Primary attempt: preferred 1080p camera configuration
  try {
    const combinedStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    if (combinedStream) {
      cameraTrack = combinedStream.getVideoTracks()[0] || null;
      audioTrack = combinedStream.getAudioTracks()[0] || null;
      currentFacingMode = 'user';
    }
  } catch (err) {
    console.warn('[Nexus Quality] Primary 1080p getUserMedia failed, attempting 720p fallback:', err.name);
    // Step-down fallback: 720p constraint
    try {
      const fallbackStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: true
      });
      if (fallbackStream) {
        cameraTrack = fallbackStream.getVideoTracks()[0] || null;
        audioTrack = fallbackStream.getAudioTracks()[0] || null;
        currentFacingMode = 'user';
      }
    } catch (fErr) {
      // Independent track fallback
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
  }

  if (cameraTrack) {
    if (typeof cameraTrack.getSettings === 'function') {
      localCameraSettings = cameraTrack.getSettings();
      console.log('[Nexus Quality] Real camera track settings granted:', localCameraSettings);
    }
    if (typeof cameraTrack.getCapabilities === 'function') {
      try { localCameraCapabilities = cameraTrack.getCapabilities(); } catch (e) {}
    }
    if ('contentHint' in cameraTrack) {
      cameraTrack.contentHint = 'motion';
    }
    updateLocalQualityBadgeUI();
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

// ===== Mobile Front/Back Camera Switching =====
async function switchCameraFacingMode() {
  if (!localStream) {
    toast('No active camera stream');
    return;
  }

  const currentVideoTrack = localStream.getVideoTracks()[0];
  if (!currentVideoTrack) {
    toast('No camera track available to switch');
    return;
  }

  const targetFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  let newStream = null;

  // Attempt 1: Exact facingMode constraint with high quality targets
  try {
    newStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { exact: targetFacingMode },
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: false
    });
  } catch (err1) {
    console.warn('[Nexus Cam Switch] Exact facingMode failed, trying loose constraint:', err1.name);

    // Attempt 2: Loose facingMode constraint
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: targetFacingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        },
        audio: false
      });
    } catch (err2) {
      console.warn('[Nexus Cam Switch] Loose facingMode failed, attempting device enumeration fallback:', err2.name);

      // Attempt 3: Enumerate devices fallback
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        if (videoDevices.length > 1) {
          const alternativeDevice = videoDevices.find(d => d.deviceId !== selectedVideoDeviceId) || videoDevices[1];
          newStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: alternativeDevice.deviceId } },
            audio: false
          });
        }
      } catch (err3) {
        console.error('[Nexus Cam Switch] Device enumeration fallback failed:', err3);
      }
    }
  }

  if (!newStream || !newStream.getVideoTracks()[0]) {
    toast('Unable to switch camera');
    return;
  }

  const newVideoTrack = newStream.getVideoTracks()[0];

  if (typeof newVideoTrack.getSettings === 'function') {
    localCameraSettings = newVideoTrack.getSettings();
    console.log('[Nexus Cam Switch] New camera track settings:', localCameraSettings);
  }
  if ('contentHint' in newVideoTrack) {
    newVideoTrack.contentHint = 'motion';
  }

  // Stop previous video track
  currentVideoTrack.stop();
  localStream.removeTrack(currentVideoTrack);
  localStream.addTrack(newVideoTrack);

  // Update local video element
  const localVideo = document.getElementById('localVideo');
  if (localVideo) {
    localVideo.srcObject = localStream;
  }

  // Update facingMode state
  currentFacingMode = targetFacingMode;

  // Mirror effect: front camera mirrored, back camera non-mirrored
  const localVideoWrap = document.getElementById('localVideoWrap');
  if (localVideoWrap) {
    localVideoWrap.classList.toggle('mirror', currentFacingMode === 'user');
  }

  // Replace video track across ALL connected peers without renegotiation and re-apply encoding parameters
  peerConnections.forEach((peerData, peerId) => {
    if (peerData.pc && peerData.pc.connectionState !== 'closed') {
      const sender = peerData.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        sender.replaceTrack(newVideoTrack).then(() => {
          applySenderEncodingParameters(peerData.pc);
        }).catch(err => {
          console.warn(`[Nexus Cam Switch] replaceTrack failed for peer ${peerId}:`, err);
        });
      }
    }
  });

  updateLocalQualityBadgeUI();
  toast(`Switched to ${currentFacingMode === 'user' ? 'Front' : 'Back'} Camera (${localCameraSettings.width || '?'}x${localCameraSettings.height || '?'})`);
}

// ===== WebRTC Sender Encodings & Adaptive Quality Engine =====
function applySenderEncodingParameters(pc) {
  if (!pc || pc.connectionState === 'closed') return;
  const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
  if (!sender || typeof sender.getParameters !== 'function') return;

  try {
    const params = sender.getParameters();
    if (!params) return;
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }

    const tier = QUALITY_TARGETS[currentEffectiveQualityTier] || QUALITY_TARGETS['720p'];

    if (isScreenSharing) {
      params.encodings[0].maxBitrate = 3500000;
      params.encodings[0].maxFramerate = 30;
      params.encodings[0].scaleResolutionDownBy = 1.0;
    } else {
      params.encodings[0].maxBitrate = tier.maxBitrate;
      params.encodings[0].maxFramerate = tier.maxFramerate;

      const captureHeight = localCameraSettings.height || 1080;
      if (captureHeight > tier.height) {
        params.encodings[0].scaleResolutionDownBy = Math.max(1.0, captureHeight / tier.height);
      } else {
        params.encodings[0].scaleResolutionDownBy = 1.0;
      }
    }

    if ('degradationPreference' in params) {
      params.degradationPreference = currentEffectiveQualityTier === '360p' ? 'maintain-framerate' : 'maintain-resolution';
    }

    sender.setParameters(params).catch(err => {
      console.warn('[Nexus Quality] setParameters error:', err.message);
    });
  } catch (err) {
    console.warn('[Nexus Quality] applySenderEncodingParameters exception:', err);
  }
}

function applyAllSenderEncodingParameters() {
  peerConnections.forEach(peerData => {
    if (peerData.pc) applySenderEncodingParameters(peerData.pc);
  });
}

function applyPreferredVideoCodecs(pc) {
  if (!pc || typeof pc.getTransceivers !== 'function') return;

  try {
    const transceivers = pc.getTransceivers();
    const videoTransceiver = transceivers.find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'video') ||
                             transceivers.find(t => t.sender && t.sender.track && t.sender.track.kind === 'video');

    if (!videoTransceiver || typeof videoTransceiver.setCodecPreferences !== 'function') return;

    if (typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function') {
      const caps = RTCRtpSender.getCapabilities('video');
      if (caps && Array.isArray(caps.codecs)) {
        // Preferred compatibility order: VP8, H264, VP9, AV1
        const preferredMimes = ['video/VP8', 'video/H264', 'video/VP9', 'video/AV1'];
        const sortedCodecs = [];

        preferredMimes.forEach(mime => {
          const matching = caps.codecs.filter(c => c.mimeType.toLowerCase() === mime.toLowerCase());
          sortedCodecs.push(...matching);
        });

        caps.codecs.forEach(c => {
          if (!sortedCodecs.includes(c)) sortedCodecs.push(c);
        });

        if (sortedCodecs.length > 0) {
          videoTransceiver.setCodecPreferences(sortedCodecs);
        }
      }
    }
  } catch (err) {
    console.warn('[Nexus Codec] setCodecPreferences fallback:', err.message);
  }
}

function computeEffectiveQualityTier(networkQuality) {
  if (selectedVideoQuality !== 'auto') {
    let target = selectedVideoQuality + 'p';
    if (!QUALITY_TARGETS[target]) target = '720p';

    if (localCameraSettings.height && localCameraSettings.height < QUALITY_TARGETS[target].height) {
      if (localCameraSettings.height >= 720) target = '720p';
      else if (localCameraSettings.height >= 540) target = '540p';
      else target = '360p';
    }
    return target;
  }

  const totalParticipants = peerConnections.size + 1;
  let roomCapTier = '1080p';
  if (totalParticipants >= 9) roomCapTier = '360p';
  else if (totalParticipants >= 5) roomCapTier = '540p';
  else if (totalParticipants >= 3) roomCapTier = '720p';

  let networkTier = '1080p';
  if (networkQuality === 'poor') networkTier = '360p';
  else if (networkQuality === 'fair') networkTier = '540p';
  else if (networkQuality === 'good') networkTier = '720p';
  else networkTier = '1080p';

  const order = ['360p', '540p', '720p', '1080p'];
  const roomCapIdx = order.indexOf(roomCapTier);
  const netIdx = order.indexOf(networkTier);
  const finalIdx = Math.min(roomCapIdx, netIdx);

  return order[finalIdx];
}

function updateAdaptiveQuality(overallNetworkQuality) {
  const newTarget = computeEffectiveQualityTier(overallNetworkQuality);
  const now = Date.now();

  const order = ['360p', '540p', '720p', '1080p'];
  const currentIdx = order.indexOf(currentEffectiveQualityTier);
  const newIdx = order.indexOf(newTarget);

  if (newIdx === currentIdx) return;

  const isDowngrade = newIdx < currentIdx;
  const cooldownMs = isDowngrade ? 5000 : 15000;

  if (now - lastQualityAdaptTime < cooldownMs) {
    return;
  }

  currentEffectiveQualityTier = newTarget;
  lastQualityAdaptTime = now;

  applyAllSenderEncodingParameters();
  updateLocalQualityBadgeUI();
}

function updateLocalQualityBadgeUI() {
  const badge = document.getElementById('localQualityBadge');
  if (!badge) return;

  const w = localCameraSettings.width || 0;
  const h = localCameraSettings.height || 0;
  const fps = localCameraSettings.frameRate || 30;

  let tierLabel = '1080p';
  if (h >= 1080 || w >= 1920) tierLabel = '1080p';
  else if (h >= 720 || w >= 1280) tierLabel = '720p';
  else if (h >= 540 || w >= 854) tierLabel = '540p';
  else if (h > 0) tierLabel = '360p';

  const dotColor = currentEffectiveQualityTier === '1080p' || currentEffectiveQualityTier === '720p' ? '🟢' : (currentEffectiveQualityTier === '540p' ? '🟡' : '🔴');

  badge.textContent = `${dotColor} ${tierLabel} • ${Math.round(fps)} FPS`;
}

// ===== Socket.IO Multi-Participant Signaling Engine =====
function joinExistingRoom(pin) {
  const finalPin = pin || sessionStorage.getItem('nexus_pin_' + roomCode) || sessionStorage.getItem('linkdrop_pin_' + roomCode) || null;
  const storedName = sessionStorage.getItem('nexus_name') || 'User';
  const storedMax = sessionStorage.getItem('nexus_max_' + roomCode) || 2;

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

  socket = io(serverUrl, {
    transports: ["websocket", "polling"]
  });

  socket.on('connect', () => {
    timing.t1_socketConnected = Date.now();
    mySocketId = socket.id;
    console.log('[LinkDrop Socket] Connected with Socket ID:', mySocketId);
    updateConnectionStatus('connecting', 'Signaling Connected...');

    socket.emit('check-room', { roomId: roomCode }, (result) => {
      timing.t2_roomJoined = Date.now();

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
      maxRoomParticipants = data.maxMembers || 2;
      updateRoomSummaryInfo(data);

      if (isHost) {
        updateConnectionStatus('connecting', 'Room created — waiting for participants...');
      } else {
        updateConnectionStatus('connecting', 'Waiting for host approval...');
      }
    }
  });

  socket.on('pin-required', () => {
    showPinModal();
  });

  socket.on('room-full', () => {
    toast('Room is full.');
    updateConnectionStatus('disconnected', 'Room is full');
    setTimeout(() => location.href = '/', 2000);
  });

  socket.on('room-locked', () => {
    toast('Room is locked by host.');
    updateConnectionStatus('disconnected', 'Room is locked');
    setTimeout(() => location.href = '/', 2000);
  });

  socket.on('room-lock-state', (data) => {
    if (data) {
      isRoomLocked = !!data.isLocked;
      const chkLock = document.getElementById('chkLockRoom');
      if (chkLock) chkLock.checked = isRoomLocked;
      toast(isRoomLocked ? 'Room has been Locked' : 'Room has been Unlocked');
      updateRoomSummaryInfo(data);
    }
  });

  socket.on('raise-hand-state', (data) => {
    if (!data || !data.socketId) return;
    updateParticipantHandStateUI(data.socketId, data.isRaised);
  });

  socket.on('reaction', (data) => {
    if (!data || !data.socketId || !data.emoji) return;
    displayFloatingReactionOnTile(data.socketId, data.emoji);
  });

  socket.on('stream-share-start', (data) => {
    if (!data || !data.url) return;
    playStreamShare(data.url, data.mimeType || 'auto', false);
    toast(`${data.senderName || 'Participant'} started stream sharing`);
  });

  socket.on('stream-share-stop', () => {
    closeStreamShareUIOnly();
    toast('Stream sharing ended');
  });

  socket.on('stream-share-action', (data) => {
    if (!data || !data.action) return;
    handleRemoteStreamAction(data.action, data.currentTime);
  });

  socket.on('muted-by-host', () => {
    const audioTrack = localStream?.getAudioTracks()?.[0];
    if (audioTrack) {
      audioTrack.enabled = false;
      const btn = document.getElementById('btnAudio');
      if (btn) btn.classList.add('off');
    }
    toast('You were muted by the Host');
    if (socket && roomCode) {
      socket.emit('peer-state-change', roomCode, { audioEnabled: false });
    }
  });

  socket.on('room-settings-updated', (data) => {
    if (data) {
      if (data.maxMembers) {
        maxRoomParticipants = data.maxMembers;
        toast(`Room capacity updated to max ${data.maxMembers} participants`);
      }
      updateRoomSummaryInfo(data);
    }
  });

  // Host receives join request from prospective participant
  socket.on('request-join', (data) => {
    timing.t3_joinRequestReceived = Date.now();
    isHost = true;
    if (data && data.socketId) {
      if (!pendingJoinRequests.some(r => r.socketId === data.socketId)) {
        pendingJoinRequests.push({
          socketId: data.socketId,
          displayName: data.displayName || 'Participant'
        });
      }
      updateApprovalPopup();
    }
  });

  socket.on('guest-canceled', (data) => {
    if (data && data.socketId) {
      const idx = pendingJoinRequests.findIndex(r => r.socketId === data.socketId);
      if (idx !== -1) {
        pendingJoinRequests.splice(idx, 1);
      }
      toast('Participant canceled join request');
      updateApprovalPopup();
    }
  });

  // Joining participant receives acceptance notice from host
  socket.on('accepted', async (data) => {
    timing.t4_accepted = Date.now();
    toast('Host accepted your join request!');
    updateConnectionStatus('connecting', 'Connecting with room participants...');

    if (data && data.members && Array.isArray(data.members)) {
      data.members.forEach(member => {
        if (member.socketId !== socket.id && !peerConnections.has(member.socketId)) {
          // Initialize tile placeholder for existing room member
          createRemoteVideoTile(member.socketId, member.displayName);
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

  socket.on('kicked', () => {
    toast('You were removed from the room by the host');
    leaveRoomSilent();
    setTimeout(() => location.href = '/', 1500);
  });

  // Existing room participants receive notice when a new member joins after acceptance
  socket.on('user-joined', async (data) => {
    if (!data || !data.socketId || data.socketId === socket.id) return;

    const newSocketId = data.socketId;
    const newDisplayName = data.displayName || 'Participant';

    toast(`${newDisplayName} joined the call`);
    updateConnectionStatus('connected', `Connected (${data.members ? data.members.length : 'Multi'} participants)`);

    // Initiate WebRTC PeerConnection for the new participant
    if (!peerConnections.has(newSocketId)) {
      await createPeerConnectionFor(newSocketId, newDisplayName, true);
    }
  });

  socket.on('user-left', (data) => {
    if (!data || !data.socketId) return;
    handleUserLeft(data.socketId);
  });

  socket.on('host-changed', (data) => {
    if (data.newHostId === socket.id) {
      isHost = true;
      toast('You are now the room Host');
    } else {
      toast(`Host role transferred to ${data.newHostName || 'another participant'}`);
    }
    updateRoomSummaryInfo(data);
    updateRemoteVideoGrid();
  });

  // Targeted Signaling Event Handlers
  socket.on('offer', async (data) => {
    if (!data || !data.senderId || !data.offer) return;
    console.log('[LinkDrop WebRTC] Received Offer from:', data.senderId);
    await handleRemoteOffer(data.senderId, data.offer, data.senderName);
  });

  socket.on('answer', async (data) => {
    if (!data || !data.senderId || !data.answer) return;
    console.log('[LinkDrop WebRTC] Received Answer from:', data.senderId);
    await handleRemoteAnswer(data.senderId, data.answer);
  });

  socket.on('ice-candidate', async (data) => {
    if (!data || !data.senderId || !data.candidate) return;
    await handleRemoteIceCandidate(data.senderId, data.candidate);
  });

  socket.on('peer-state-change', (data) => {
    if (!data || !data.socketId) return;
    updatePeerStateUI(data.socketId, data);
  });

  socket.on('screen-share-state', (data) => {
    if (!data) return;
    const banner = document.getElementById('screenShareBanner');
    const txt = document.getElementById('screenShareText');
    const peerData = peerConnections.get(data.socketId);
    const peerName = peerData ? peerData.displayName : 'A participant';

    if (banner && txt) {
      txt.textContent = data.isSharing ? `${peerName} is sharing their screen` : 'Screen Share Active';
      banner.style.display = data.isSharing ? 'flex' : 'none';
    }
  });

  // Host Approval Popup Buttons
  const acceptBtn = document.getElementById('acceptBtn');
  const rejectBtn = document.getElementById('rejectBtn');

  if (acceptBtn) acceptBtn.onclick = () => {
    const current = pendingJoinRequests.shift();
    updateApprovalPopup();
    if (current && current.socketId) {
      socket.emit('accept', roomCode, current.socketId);
    }
  };

  if (rejectBtn) rejectBtn.onclick = () => {
    const current = pendingJoinRequests.shift();
    updateApprovalPopup();
    if (current && current.socketId) {
      socket.emit('reject', roomCode, current.socketId);
    }
  };
}

function updateApprovalPopup() {
  const approvalPopup = document.getElementById('approvalPopup');
  const badge = document.getElementById('pendingCountBadge');
  if (!approvalPopup) return;

  if (pendingJoinRequests.length === 0) {
    approvalPopup.classList.remove('open');
    if (badge) badge.style.display = 'none';
    delete approvalPopup.dataset.targetId;
    delete approvalPopup.dataset.displayName;
    return;
  }

  const current = pendingJoinRequests[0];
  const msgText = approvalPopup.querySelector('p');
  if (msgText) msgText.textContent = `${current.displayName} wants to join your room call.`;

  approvalPopup.dataset.targetId = current.socketId;
  approvalPopup.dataset.displayName = current.displayName;

  if (badge) {
    if (pendingJoinRequests.length > 1) {
      badge.textContent = `${pendingJoinRequests.length} waiting`;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  approvalPopup.classList.add('open');
}

// ===== Multi-Participant Mesh WebRTC Pipeline =====

async function createPeerConnectionFor(targetSocketId, targetDisplayName, shouldInitiateOffer) {
  if (peerConnections.has(targetSocketId)) {
    const existing = peerConnections.get(targetSocketId);
    try { existing.pc.close(); } catch (e) {}
  }

  const pc = new RTCPeerConnection(rtcConfig);
  applyPreferredVideoCodecs(pc);

  const peerData = {
    socketId: targetSocketId,
    displayName: targetDisplayName,
    pc,
    remoteStream: new MediaStream(),
    chatChannel: null,
    fileChannel: null,
    pendingIceCandidates: [],
    isNegotiating: false,
    audioEnabled: true,
    videoEnabled: true
  };

  peerConnections.set(targetSocketId, peerData);
  createRemoteVideoTile(targetSocketId, targetDisplayName);

  // Attach local media tracks (camera/mic or screen share)
  const activeStream = isScreenSharing && screenStream ? screenStream : localStream;
  if (activeStream) {
    activeStream.getTracks().forEach(track => {
      pc.addTrack(track, activeStream);
    });
    applySenderEncodingParameters(pc);
  }

  // ICE Candidate Event
  pc.onicecandidate = (e) => {
    if (e.candidate && socket) {
      socket.emit('ice-candidate', roomCode, e.candidate, targetSocketId);
    }
  };

  // Remote Track Event
  pc.ontrack = (e) => {
    if (!peerData.remoteStream) {
      peerData.remoteStream = new MediaStream();
    }
    if (!peerData.remoteStream.getTracks().some(t => t.id === e.track.id)) {
      peerData.remoteStream.addTrack(e.track);
    }

    const videoEl = document.getElementById(`remoteVideo_${targetSocketId}`);
    const avatarEl = document.getElementById(`remoteAvatar_${targetSocketId}`);

    if (videoEl) {
      videoEl.srcObject = peerData.remoteStream;
      if (avatarEl) avatarEl.style.display = 'none';
      try { videoEl.play().catch(e => {}); } catch(e) {}
    }

    if (e.track.kind === 'audio') {
      initAudioSpeakerAnalysis(targetSocketId, peerData.remoteStream);
    }
  };

  // Connection State Listener
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log(`[LinkDrop WebRTC Peer ${targetSocketId}] State:`, state);

    if (state === 'connected') {
      updateConnectionStatus('connected', 'WebRTC Connected');
      updateRemoteVideoGrid();
    } else if (state === 'failed') {
      attemptIceRestartFor(targetSocketId);
    }
  };

  if (shouldInitiateOffer) {
    try {
      peerData.isNegotiating = true;

      // Create DataChannels on initiating side
      const chatCh = pc.createDataChannel('chat');
      setupChatChannelListeners(chatCh, targetSocketId);
      peerData.chatChannel = chatCh;

      const fileCh = pc.createDataChannel('file-transfer');
      setupFileChannelListeners(fileCh, targetSocketId);
      peerData.fileChannel = fileCh;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit('offer', roomCode, pc.localDescription, targetSocketId);
    } catch (err) {
      console.error(`[LinkDrop WebRTC] Initiate offer error for ${targetSocketId}:`, err);
    } finally {
      peerData.isNegotiating = false;
    }
  } else {
    // Non-initiating side listens for DataChannels
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === 'chat') {
        peerData.chatChannel = ch;
        setupChatChannelListeners(ch, targetSocketId);
      } else if (ch.label === 'file-transfer') {
        peerData.fileChannel = ch;
        setupFileChannelListeners(ch, targetSocketId);
      }
    };
  }

  return peerData;
}

// Handle incoming Offer
async function handleRemoteOffer(senderId, offer, senderName) {
  try {
    let peerData = peerConnections.get(senderId);
    if (!peerData) {
      peerData = await createPeerConnectionFor(senderId, senderName || 'Participant', false);
    }

    const pc = peerData.pc;
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await flushQueuedIceCandidatesFor(senderId);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('answer', roomCode, answer, senderId);
  } catch (err) {
    console.error(`[LinkDrop WebRTC] Handle offer error from ${senderId}:`, err);
  }
}

// Handle incoming Answer
async function handleRemoteAnswer(senderId, answer) {
  const peerData = peerConnections.get(senderId);
  if (!peerData || !peerData.pc) return;

  try {
    await peerData.pc.setRemoteDescription(new RTCSessionDescription(answer));
    await flushQueuedIceCandidatesFor(senderId);
  } catch (err) {
    console.error(`[LinkDrop WebRTC] Handle answer error from ${senderId}:`, err);
  }
}

// ICE Candidate Queue Handlers per peer
async function handleRemoteIceCandidate(senderId, candidate) {
  if (!candidate) return;

  const peerData = peerConnections.get(senderId);
  if (peerData && peerData.pc && peerData.pc.remoteDescription && peerData.pc.remoteDescription.type) {
    try {
      await peerData.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn(`[LinkDrop ICE] Add candidate error for ${senderId}:`, err.message);
    }
  } else if (peerData) {
    peerData.pendingIceCandidates.push(candidate);
  }
}

async function flushQueuedIceCandidatesFor(senderId) {
  const peerData = peerConnections.get(senderId);
  if (!peerData) return;

  while (peerData.pendingIceCandidates.length > 0) {
    const cand = peerData.pendingIceCandidates.shift();
    try {
      if (peerData.pc) await peerData.pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch (err) {
      console.warn(`[LinkDrop ICE] Flushed candidate error for ${senderId}:`, err.message);
    }
  }
}

async function attemptIceRestartFor(targetSocketId) {
  const peerData = peerConnections.get(targetSocketId);
  if (!peerData || !peerData.pc) return;

  try {
    const offer = await peerData.pc.createOffer({ iceRestart: true });
    await peerData.pc.setLocalDescription(offer);
    if (socket) {
      socket.emit('offer', roomCode, offer, targetSocketId);
    }
  } catch (err) {
    console.error(`[LinkDrop WebRTC] ICE restart failed for ${targetSocketId}:`, err);
  }
}

function handleUserLeft(targetSocketId) {
  const peerData = peerConnections.get(targetSocketId);
  if (peerData) {
    toast(`${peerData.displayName || 'Participant'} left the room`);
    try { peerData.pc.close(); } catch (e) {}
    peerConnections.delete(targetSocketId);
  }

  if (mainParticipantId === targetSocketId) {
    mainParticipantId = Array.from(peerConnections.keys())[0] || 'local';
  }
  if (smallParticipantId === targetSocketId) {
    smallParticipantId = 'local';
  }

  const tileEl = document.getElementById(`tile_${targetSocketId}`);
  if (tileEl) tileEl.remove();

  updateViewAllocation();
}

function cleanupAllPeerConnections() {
  peerConnections.forEach((peerData) => {
    try { peerData.pc.close(); } catch (e) {}
  });
  peerConnections.clear();
  updateRemoteVideoGrid();
}

function kickParticipant(targetSocketId) {
  if (socket && isHost && roomCode && targetSocketId) {
    const peerData = peerConnections.get(targetSocketId);
    const peerName = peerData ? peerData.displayName : 'Participant';
    if (confirm(`Remove ${peerName} from the room call?`)) {
      socket.emit('kick-participant', roomCode, targetSocketId);
    }
  }
}

// ===== Dynamic Remote Video Grid Management =====
function createRemoteVideoTile(socketId, displayName) {
  const grid = document.getElementById('remoteVideoGrid');
  if (!grid) return;

  let tile = document.getElementById(`tile_${socketId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'remote-video-tile';
    tile.id = `tile_${socketId}`;

    const cleanName = escapeHtml(displayName);
    const initial = cleanName.charAt(0).toUpperCase() || 'P';

    tile.innerHTML = `
      <video id="remoteVideo_${socketId}" autoplay playsinline></video>
      <div id="remoteAvatar_${socketId}" class="avatar-placeholder">
        <div class="avatar-icon">${initial}</div>
        <span>${cleanName}</span>
      </div>
      <div id="hand_${socketId}" class="tile-hand-badge" style="display: none;">🙋 Hand Raised</div>
      <div class="tile-badge">
        <span class="quality-dot good" id="quality_${socketId}"></span>
        <span id="res_badge_${socketId}" class="quality-res-badge">🟢 720p • 30 FPS</span>
        <span id="name_${socketId}">${cleanName}</span>
        <span id="mic_${socketId}"></span>
      </div>
      <button class="tile-kick-btn" id="kick_btn_${socketId}" onclick="kickParticipant('${socketId}')" title="Remove participant" aria-label="Remove participant" style="display: ${isHost ? 'grid' : 'none'};">🥾</button>
      <button class="tile-pin-btn" id="pin_btn_${socketId}" onclick="pinParticipant('${socketId}')" title="Pin participant" aria-label="Pin participant">📌</button>
      <button class="tile-fs-btn" onclick="toggleTileFullscreen('${socketId}')" title="Expand Video" aria-label="Expand Video">⛶</button>
    `;

    tile.onclick = (e) => {
      if (!e.target.closest('button')) {
        selectMainParticipant(socketId);
      }
    };

    grid.appendChild(tile);
  }

  updateViewAllocation();
}

function updateRemoteVideoGrid() {
  const grid = document.getElementById('remoteVideoGrid');
  const waitingTile = document.getElementById('waitingTile');
  if (!grid) return;

  const count = peerConnections.size;
  grid.setAttribute('data-count', count);

  if (waitingTile) {
    waitingTile.style.display = count === 0 ? 'flex' : 'none';
  }

  peerConnections.forEach((peerData, sid) => {
    const kickBtn = document.getElementById(`kick_btn_${sid}`);
    if (kickBtn) kickBtn.style.display = isHost ? 'grid' : 'none';
  });
}

function updatePeerStateUI(socketId, state) {
  const peerData = peerConnections.get(socketId);
  if (peerData) {
    if (typeof state.audioEnabled === 'boolean') peerData.audioEnabled = state.audioEnabled;
    if (typeof state.videoEnabled === 'boolean') peerData.videoEnabled = state.videoEnabled;
  }

  const avatar = document.getElementById(`remoteAvatar_${socketId}`);
  const micSpan = document.getElementById(`mic_${socketId}`);

  if (avatar && typeof state.videoEnabled === 'boolean') {
    avatar.style.display = state.videoEnabled ? 'none' : 'flex';
  }

  if (micSpan && typeof state.audioEnabled === 'boolean') {
    micSpan.textContent = state.audioEnabled ? '' : ' 🔇';
  }
}

function toggleTileFullscreen(socketId) {
  const tile = document.getElementById(`tile_${socketId}`);
  if (!tile) return;

  if (document.fullscreenElement === tile) {
    if (document.exitFullscreen) document.exitFullscreen();
  } else {
    if (tile.requestFullscreen) tile.requestFullscreen();
  }
}

// ===== Screen Sharing =====
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

      // Replace video track for ALL active PeerConnections
      peerConnections.forEach((peerData) => {
        if (peerData.pc && peerData.pc.connectionState !== 'closed') {
          const sender = peerData.pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(screenTrack);
        }
      });

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
    peerConnections.forEach((peerData) => {
      if (peerData.pc && peerData.pc.connectionState !== 'closed') {
        const sender = peerData.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          sender.replaceTrack(cameraTrack);
          cameraTrack.enabled = true;
        }
      }
    });
  }

  isScreenSharing = false;
  const btnScreen = document.getElementById('btnScreen');
  const screenBanner = document.getElementById('screenShareBanner');

  if (btnScreen) btnScreen.classList.remove('active-danger');
  if (screenBanner) screenBanner.style.display = 'none';

  if (socket) socket.emit('screen-share-state', roomCode, false);
}

// ===== P2P Text Chat DataChannel =====
function setupChatChannelListeners(channel, senderSocketId) {
  if (!channel) return;

  channel.onopen = () => { console.log(`[LinkDrop] Chat DataChannel opened for ${senderSocketId}`); };
  channel.onclose = () => { console.log(`[LinkDrop] Chat DataChannel closed for ${senderSocketId}`); };
  channel.onerror = (err) => { console.warn(`[LinkDrop] Chat DataChannel error for ${senderSocketId}:`, err); };

  channel.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data && data.type === 'chat' && typeof data.text === 'string') {
        const cleanText = data.text.slice(0, 2000);
        renderChatMessage(cleanText, 'them', data.timestamp, data.sender || 'Participant');

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

  let sentCount = 0;
  peerConnections.forEach((peerData) => {
    if (peerData.chatChannel && peerData.chatChannel.readyState === 'open') {
      try {
        peerData.chatChannel.send(payload);
        sentCount++;
      } catch (err) {}
    }
  });

  // Socket fallback if DataChannels not ready
  if (sentCount === 0 && socket) {
    socket.emit('chat-message', roomCode, { text, sender: myDisplayName, timestamp });
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
function setupFileChannelListeners(channel, targetSocketId) {
  if (!channel) return;
  channel.binaryType = 'arraybuffer';

  channel.onopen = () => { console.log(`[LinkDrop] File DataChannel opened for ${targetSocketId}`); };
  channel.onclose = () => { cleanupIncompleteTransfers('Channel closed'); };
  channel.onerror = (err) => { cleanupIncompleteTransfers('Channel error'); };

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
  const fileList = Array.from(files);
  for (const file of fileList) {
    if (file.size > MAX_FILE_SIZE) {
      toast(`File ${file.name} exceeds 500MB limit`);
      continue;
    }
    await sendSingleFileToAllPeers(file);
  }
}

async function sendSingleFileToAllPeers(file) {
  const fileId = 'file_' + Math.random().toString(36).substr(2, 9);
  activeFileTransfers[fileId] = { cancelled: false, startTime: Date.now() };

  const activeChannels = [];
  peerConnections.forEach((peerData) => {
    if (peerData.fileChannel && peerData.fileChannel.readyState === 'open') {
      activeChannels.push(peerData.fileChannel);
    }
  });

  if (activeChannels.length === 0) {
    toast('No P2P file channel open');
    delete activeFileTransfers[fileId];
    return;
  }

  const startMsg = JSON.stringify({
    type: 'file-start',
    id: fileId,
    name: file.name,
    size: file.size,
    mime: file.type
  });

  activeChannels.forEach(ch => {
    try { ch.send(startMsg); } catch (e) {}
  });

  createFileProgressUI(fileId, file.name, file.size, true);

  let offset = 0;
  while (offset < file.size) {
    if (activeFileTransfers[fileId]?.cancelled) break;

    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await slice.arrayBuffer();

    activeChannels.forEach(ch => {
      if (ch.readyState === 'open') {
        try { ch.send(buffer); } catch (e) {}
      }
    });

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
  const endMsg = JSON.stringify({ type: 'file-end', id: fileId });
  activeChannels.forEach(ch => {
    if (ch.readyState === 'open') {
      try { ch.send(endMsg); } catch (e) {}
    }
  });

  toast(`Sent file: ${file.name}`);
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

  const cancelMsg = JSON.stringify({ type: 'file-cancel', id });
  peerConnections.forEach(peerData => {
    if (peerData.fileChannel && peerData.fileChannel.readyState === 'open') {
      try { peerData.fileChannel.send(cancelMsg); } catch(e) {}
    }
  });

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

  const remoteVideos = document.querySelectorAll('.remote-video-tile video');
  remoteVideos.forEach(v => {
    v.volume = val / 100;
  });
}

// ===== Local Preview Drag & Drag-to-Hide Trash Engine =====
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

function hideLocalPreviewTile(e) {
  if (e) e.stopPropagation();
  const localVideoWrap = document.getElementById('localVideoWrap');
  const btnRestore = document.getElementById('btnRestoreMini');

  if (localVideoWrap) localVideoWrap.style.display = 'none';
  if (btnRestore) btnRestore.style.display = 'grid';

  isLocalPreviewHidden = true;
  toast('Local preview hidden (camera remains active)');
}

function restoreLocalPreviewTile(e) {
  if (e) e.stopPropagation();
  const localVideoWrap = document.getElementById('localVideoWrap');
  const btnRestore = document.getElementById('btnRestoreMini');

  if (localVideoWrap) localVideoWrap.style.display = 'flex';
  if (btnRestore) btnRestore.style.display = 'none';

  isLocalPreviewHidden = false;
  clampMiniVideoPosition();
  toast('Local preview restored');
}

function clampMiniVideoPosition(targetLeft = miniPos.left, targetTop = miniPos.top) {
  const container = document.getElementById('videoContainer');
  const miniEl = document.getElementById('localVideoWrap');
  if (!container || !miniEl) return;

  const containerRect = container.getBoundingClientRect();
  const miniWidth = miniEl.offsetWidth || (window.innerWidth <= 600 ? 150 : 240);
  const miniHeight = miniEl.offsetHeight || (window.innerWidth <= 600 ? 84 : 135);

  const containerW = containerRect.width || window.innerWidth;
  const containerH = containerRect.height || window.innerHeight;

  const maxLeft = Math.max(0, containerW - miniWidth);
  const maxTop = Math.max(0, containerH - miniHeight);

  if (targetLeft === null) targetLeft = maxLeft - 16;
  if (targetTop === null) targetTop = maxTop - 16;

  let clampedLeft = Math.min(Math.max(0, targetLeft), maxLeft);
  let clampedTop = Math.min(Math.max(0, targetTop), maxTop);

  miniPos.left = clampedLeft;
  miniPos.top = clampedTop;

  miniEl.style.left = `${clampedLeft}px`;
  miniEl.style.top = `${clampedTop}px`;
  miniEl.style.right = 'auto';
  miniEl.style.bottom = 'auto';
}

function initDraggableMiniVideo() {
  const container = document.getElementById('videoContainer');
  const miniEl = document.getElementById('localVideoWrap');
  const trashTarget = document.getElementById('dropTrashTarget');

  if (!container || !miniEl) return;

  miniEl.addEventListener('pointerdown', (e) => {
    // Suppress dragging if clicking on overlay control buttons
    if (e.target.closest('.mini-overlay-controls')) return;

    dragPointerId = e.pointerId;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    dragInitialLeft = miniEl.offsetLeft;
    dragInitialTop = miniEl.offsetTop;

    isDraggingMini = true;
    hasMovedExceedingThreshold = false;

    miniEl.classList.add('dragging');
    try {
      miniEl.setPointerCapture(e.pointerId);
    } catch (err) {}
  });

  miniEl.addEventListener('pointermove', (e) => {
    if (!isDraggingMini || e.pointerId !== dragPointerId) return;

    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;

    if (!hasMovedExceedingThreshold && Math.hypot(deltaX, deltaY) > DRAG_THRESHOLD_PX) {
      hasMovedExceedingThreshold = true;
      if (trashTarget) trashTarget.style.display = 'flex';
    }

    if (hasMovedExceedingThreshold) {
      if (e.cancelable) e.preventDefault();
      const newLeft = dragInitialLeft + deltaX;
      const newTop = dragInitialTop + deltaY;
      clampMiniVideoPosition(newLeft, newTop);

      // Check collision with Drop-to-Hide Trash Target
      if (trashTarget) {
        const trashRect = trashTarget.getBoundingClientRect();
        const miniRect = miniEl.getBoundingClientRect();

        const isOverlapping = !(
          miniRect.right < trashRect.left ||
          miniRect.left > trashRect.right ||
          miniRect.bottom < trashRect.top ||
          miniRect.top > trashRect.bottom
        );

        trashTarget.classList.toggle('drag-hover', isOverlapping);
      }
    }
  });

  const endDrag = (e) => {
    if (!isDraggingMini || e.pointerId !== dragPointerId) return;

    miniEl.classList.remove('dragging');
    try {
      miniEl.releasePointerCapture(e.pointerId);
    } catch (err) {}

    let isDroppedOnTrash = false;
    if (trashTarget && trashTarget.classList.contains('drag-hover')) {
      isDroppedOnTrash = true;
      trashTarget.classList.remove('drag-hover');
    }

    if (trashTarget) {
      trashTarget.style.display = 'none';
    }

    if (isDroppedOnTrash) {
      hideLocalPreviewTile(e);
    } else if (!hasMovedExceedingThreshold) {
      // Movement < 8px: CLICK / TAP EVENT!
      // Trigger Video View Swap between Main Stage & Small Floating Preview!
      swapMainAndSmallView();
    }

    isDraggingMini = false;
    dragPointerId = null;
  };

  miniEl.addEventListener('pointerup', endDrag);
  miniEl.addEventListener('pointercancel', endDrag);

  // Prevent accidental clicks after dragging preview tile
  miniEl.addEventListener('click', (e) => {
    if (hasMovedExceedingThreshold) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
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
  clampMiniVideoPosition();
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

    peerConnections.forEach(peerData => {
      if (peerData.pc && peerData.pc.connectionState !== 'closed') {
        const sender = peerData.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(newVideoTrack);
      }
    });

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

    peerConnections.forEach(peerData => {
      if (peerData.pc && peerData.pc.connectionState !== 'closed') {
        const sender = peerData.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
        if (sender) sender.replaceTrack(newAudioTrack);
      }
    });

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
  else if (resolution === '540') { idealWidth = 960; idealHeight = 540; }
  else if (resolution === '360') { idealWidth = 640; idealHeight = 360; }

  try {
    if (resolution !== 'auto') {
      await videoTrack.applyConstraints({
        width: { ideal: idealWidth },
        height: { ideal: idealHeight },
        frameRate: { ideal: 30 }
      }).catch(cErr => console.warn('[Nexus Quality] Track applyConstraints fallback:', cErr));
    } else {
      await videoTrack.applyConstraints({
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      }).catch(() => {});
    }

    if (typeof videoTrack.getSettings === 'function') {
      localCameraSettings = videoTrack.getSettings();
    }
  } catch (err) {
    console.warn('[Nexus Quality] Quality constraint application error:', err);
  }

  // Re-compute quality target and apply sender encodings across all peer connections
  const targetTier = computeEffectiveQualityTier('good');
  currentEffectiveQualityTier = targetTier;
  applyAllSenderEncodingParameters();
  updateLocalQualityBadgeUI();

  toast(`Video quality target set to ${resolution.toUpperCase()}`);
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

// ===== Host Room Capacity Management =====
function changeRoomCapacity(newMaxVal) {
  const newMax = parseInt(newMaxVal, 10);
  if (isNaN(newMax) || newMax < 2) return;

  maxRoomParticipants = newMax;
  if (socket && isHost && roomCode) {
    socket.emit('change-max-participants', roomCode, newMax);
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
  const peerCount = peerConnections.size;

  let overallQuality = 'excellent';
  let totalRtt = 0;
  let rttCount = 0;
  let totalLossPct = 0;

  let html = `
    <div style="border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 8px;">
      <div><strong>📷 Local Camera Capture:</strong> ${localCameraSettings.width || '?'}x${localCameraSettings.height || '?'} @ ${Math.round(localCameraSettings.frameRate || 30)} FPS (${localCameraSettings.facingMode || 'user'})</div>
      <div><strong>⚙️ Effective Encoding Target:</strong> ${currentEffectiveQualityTier} (Max Bitrate: ${QUALITY_TARGETS[currentEffectiveQualityTier]?.maxBitrate / 1000000 || 1.8} Mbps)</div>
      <div><strong>👥 Multi-Participant Load:</strong> ${peerCount + 1} Total Participants in Call</div>
    </div>
  `;

  if (peerCount === 0) {
    if (output) output.innerHTML = html + '<div>No active WebRTC peer connections.</div>';
    updateLocalQualityBadgeUI();
    return;
  }

  for (const [peerId, peerData] of peerConnections.entries()) {
    if (!peerData.pc) continue;

    try {
      const stats = await peerData.pc.getStats();
      let rtt = null;
      let packetsLost = 0;
      let packetsReceived = 0;
      let fps = null;
      let frameWidth = null;
      let frameHeight = null;
      let bytesReceived = 0;
      let bytesSent = 0;
      let codecMime = null;

      stats.forEach(report => {
        if (report.type === 'remote-inbound-rtp' && typeof report.roundTripTime === 'number') {
          rtt = Math.round(report.roundTripTime * 1000);
        }
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          packetsLost = report.packetsLost || 0;
          packetsReceived = report.packetsReceived || 0;
          fps = report.framesPerSecond || fps;
          frameWidth = report.frameWidth || frameWidth;
          frameHeight = report.frameHeight || frameHeight;
          bytesReceived = report.bytesReceived || 0;
          if (report.codecId) {
            const codecReport = stats.get(report.codecId);
            if (codecReport && codecReport.mimeType) codecMime = codecReport.mimeType.replace('video/', '');
          }
        }
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          bytesSent = report.bytesSent || 0;
          if (!codecMime && report.codecId) {
            const codecReport = stats.get(report.codecId);
            if (codecReport && codecReport.mimeType) codecMime = codecReport.mimeType.replace('video/', '');
          }
        }
        if (report.type === 'track' && report.kind === 'video') {
          frameWidth = report.frameWidth || frameWidth;
          frameHeight = report.frameHeight || frameHeight;
        }
      });

      const remoteVideo = document.getElementById(`remoteVideo_${peerId}`);
      if (remoteVideo && remoteVideo.videoWidth && remoteVideo.videoHeight) {
        if (!frameWidth) frameWidth = remoteVideo.videoWidth;
        if (!frameHeight) frameHeight = remoteVideo.videoHeight;
      }

      const totalPackets = packetsReceived + packetsLost;
      const lossPct = totalPackets > 0 ? ((packetsLost / totalPackets) * 100) : 0;

      if (rtt !== null) {
        totalRtt += rtt;
        rttCount++;
      }
      totalLossPct += lossPct;

      const quality = (!rtt || rtt < 60) && lossPct < 1 ? 'excellent' :
                      ((!rtt || rtt < 120) && lossPct < 3 ? 'good' :
                      ((!rtt || rtt < 220) && lossPct < 5 ? 'fair' : 'poor'));

      const qualityDotEl = document.getElementById(`quality_${peerId}`);
      if (qualityDotEl) qualityDotEl.className = `quality-dot ${quality}`;

      const resBadgeEl = document.getElementById(`res_badge_${peerId}`);
      if (resBadgeEl) {
        const fpsStr = fps ? `${Math.round(fps)} FPS` : '30 FPS';
        const hStr = frameHeight ? `${frameHeight}p` : (frameWidth ? `${frameWidth}x${frameHeight}` : '720p');
        const dotColor = quality === 'excellent' || quality === 'good' ? '🟢' : (quality === 'fair' ? '🟡' : '🔴');
        resBadgeEl.textContent = `${dotColor} ${hStr} • ${fpsStr}`;
      }

      html += `
        <div style="border-bottom: 1px solid var(--border); padding-bottom: 6px; margin-bottom: 6px;">
          <div><strong>Participant (${escapeHtml(peerData.displayName)}):</strong> <span class="quality-dot ${quality}"></span> ${quality.toUpperCase()}</div>
          <div>Negotiated Resolution: ${frameWidth && frameHeight ? `${frameWidth}x${frameHeight}` : 'Active'} ${fps ? `@ ${Math.round(fps)} FPS` : ''} ${codecMime ? `(${codecMime})` : ''}</div>
          <div>Latency (RTT): ${rtt !== null ? rtt + ' ms' : 'N/A'} | Packet Loss: ${lossPct.toFixed(1)}%</div>
          <div>Data Transferred: ${formatBytes(bytesReceived)} RX / ${formatBytes(bytesSent)} TX</div>
        </div>
      `;
    } catch (err) {}
  }

  if (rttCount > 0) {
    const avgRtt = totalRtt / rttCount;
    const avgLoss = totalLossPct / peerCount;

    if (avgRtt > 220 || avgLoss >= 5) overallQuality = 'poor';
    else if (avgRtt > 120 || avgLoss >= 3) overallQuality = 'fair';
    else if (avgRtt > 60 || avgLoss >= 1) overallQuality = 'good';
    else overallQuality = 'excellent';
  }

  updateAdaptiveQuality(overallQuality);
  updateLocalQualityBadgeUI();

  if (output) output.innerHTML = html;
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
  if (infoMax) infoMax.textContent = `Capacity: Max ${data.maxMembers || maxRoomParticipants} Participants`;
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
  cleanupAllPeerConnections();
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
  const maxSelect = document.getElementById('createMaxMembers');
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
  const maxMembers = maxSelect ? (parseInt(maxSelect.value, 10) || 2) : 2;

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

// ===== Audio Analysis & Active Speaker Engine =====
function initAudioSpeakerAnalysis(socketId, stream) {
  if (!stream || !stream.getAudioTracks().length) return;
  try {
    if (!audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) audioCtx = new AudioCtxClass();
    }
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    if (speakerAnalysis.has(socketId)) {
      const existing = speakerAnalysis.get(socketId);
      try { existing.source.disconnect(); } catch (e) {}
      speakerAnalysis.delete(socketId);
    }

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);

    speakerAnalysis.set(socketId, {
      analyser,
      source,
      speakingCount: 0,
      lastVolume: 0
    });

    if (!audioCheckIntervalId) {
      startActiveSpeakerMonitor();
    }
  } catch (err) {
    console.warn('[LinkDrop Audio Analysis] Setup failed:', err);
  }
}

function startActiveSpeakerMonitor() {
  if (audioCheckIntervalId) clearInterval(audioCheckIntervalId);
  audioCheckIntervalId = setInterval(() => {
    let maxVol = 0;
    let speakerCandidate = null;

    speakerAnalysis.forEach((analysis, sid) => {
      const peerData = peerConnections.get(sid);
      if (!peerData || !peerData.audioEnabled) {
        analysis.speakingCount = 0;
        updateSpeakingTileUI(sid, false);
        return;
      }

      const dataArray = new Uint8Array(analysis.analyser.frequencyBinCount);
      analysis.analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const avgVol = sum / dataArray.length;
      analysis.lastVolume = avgVol;

      if (avgVol > 20) {
        analysis.speakingCount = Math.min(10, (analysis.speakingCount || 0) + 1);
        updateSpeakingTileUI(sid, true);
        if (avgVol > maxVol && analysis.speakingCount >= 3) {
          maxVol = avgVol;
          speakerCandidate = sid;
        }
      } else {
        analysis.speakingCount = Math.max(0, (analysis.speakingCount || 0) - 1);
        if (analysis.speakingCount === 0) {
          updateSpeakingTileUI(sid, false);
        }
      }
    });

    if (speakerCandidate && speakerCandidate !== activeSpeakerId && !pinnedParticipantId) {
      activeSpeakerId = speakerCandidate;
      updateLayoutPresentation();
    }
  }, 120);
}

function updateSpeakingTileUI(socketId, isSpeaking) {
  const tile = document.getElementById(`tile_${socketId}`);
  if (tile) {
    tile.classList.toggle('is-speaking', isSpeaking);
  }
}

// ===== Video View Swap & Stream Allocation Engine =====

function swapMainAndSmallView() {
  if (peerConnections.size === 0) {
    toast('Waiting for participants to join...');
    return;
  }

  const floatingWrap = document.getElementById('localVideoWrap');
  if (floatingWrap) floatingWrap.classList.add('view-swap-animating');

  const oldMain = mainParticipantId || Array.from(peerConnections.keys())[0] || 'local';
  const oldSmall = smallParticipantId || 'local';

  mainParticipantId = oldSmall;
  smallParticipantId = oldMain;
  isManualSwapPinned = true;
  pinnedParticipantId = mainParticipantId;

  updateViewAllocation();

  setTimeout(() => {
    if (floatingWrap) floatingWrap.classList.remove('view-swap-animating');
  }, 250);

  const mainName = mainParticipantId === 'local' ? 'YOU' : (peerConnections.get(mainParticipantId)?.displayName || 'Participant');
  toast(`View Swapped — ${mainName} in Main Stage`);
}

function selectMainParticipant(targetSocketId) {
  if (mainParticipantId === targetSocketId && isManualSwapPinned) {
    isManualSwapPinned = false;
    pinnedParticipantId = null;
    mainParticipantId = activeSpeakerId || Array.from(peerConnections.keys())[0] || 'local';
    toast('Returned to Automatic Active Speaker View');
  } else {
    const prevMain = mainParticipantId;
    mainParticipantId = targetSocketId;
    if (smallParticipantId === targetSocketId) {
      smallParticipantId = prevMain || 'local';
    }
    isManualSwapPinned = true;
    pinnedParticipantId = targetSocketId;
    const targetName = targetSocketId === 'local' ? 'YOU' : (peerConnections.get(targetSocketId)?.displayName || 'Participant');
    toast(`Spotlight: ${targetName}`);
  }
  updateViewAllocation();
}

function updateViewAllocation() {
  if (!mainParticipantId && peerConnections.size > 0) {
    mainParticipantId = activeSpeakerId || Array.from(peerConnections.keys())[0];
  }
  if (!smallParticipantId) {
    smallParticipantId = 'local';
  }
  if (mainParticipantId === smallParticipantId) {
    if (smallParticipantId === 'local') {
      mainParticipantId = Array.from(peerConnections.keys())[0] || 'local';
    } else {
      smallParticipantId = 'local';
    }
  }

  // 1. Update Small Floating Preview Box (#localVideoWrap)
  const floatingWrap = document.getElementById('localVideoWrap');
  const floatingVideo = document.getElementById('localVideo');
  const floatingAvatar = document.getElementById('localAvatar');
  const floatingBadge = document.getElementById('localQualityBadge');

  if (floatingWrap && floatingVideo) {
    if (smallParticipantId === 'local') {
      if (floatingVideo.srcObject !== localStream) floatingVideo.srcObject = localStream;
      floatingVideo.muted = true;
      floatingWrap.classList.toggle('mirror', currentFacingMode === 'user');

      if (floatingAvatar) {
        const cameraTrack = localStream?.getVideoTracks()?.[0];
        floatingAvatar.style.display = (cameraTrack && cameraTrack.enabled) ? 'none' : 'flex';
        const avatarIcon = floatingAvatar.querySelector('.avatar-icon');
        if (avatarIcon) avatarIcon.textContent = 'YOU';
      }
      updateLocalQualityBadgeUI();
    } else {
      const peerData = peerConnections.get(smallParticipantId);
      if (peerData) {
        if (floatingVideo.srcObject !== peerData.remoteStream) floatingVideo.srcObject = peerData.remoteStream;
        floatingVideo.muted = false;
        const currentVol = document.getElementById('volumeSlider')?.value || 100;
        floatingVideo.volume = currentVol / 100;
        floatingWrap.classList.remove('mirror');

        if (floatingAvatar) {
          floatingAvatar.style.display = peerData.videoEnabled ? 'none' : 'flex';
          const avatarIcon = floatingAvatar.querySelector('.avatar-icon');
          if (avatarIcon) avatarIcon.textContent = (peerData.displayName || 'P').charAt(0).toUpperCase();
        }
        if (floatingBadge) {
          const dotColor = peerData.pc?.connectionState === 'connected' ? '🟢' : '🟡';
          floatingBadge.textContent = `${dotColor} ${escapeHtml(peerData.displayName)}`;
        }
      }
    }
  }

  // 2. Manage tiles in #remoteVideoGrid for non-small participants
  const grid = document.getElementById('remoteVideoGrid');
  if (!grid) return;

  let localTile = document.getElementById('tile_local');
  if (smallParticipantId !== 'local') {
    if (!localTile) {
      localTile = document.createElement('div');
      localTile.className = 'remote-video-tile';
      localTile.id = 'tile_local';
      localTile.onclick = (e) => {
        if (!e.target.closest('button')) selectMainParticipant('local');
      };
      const cleanName = escapeHtml(myDisplayName || 'YOU');
      localTile.innerHTML = `
        <video id="remoteVideo_local" autoplay playsinline muted class="${currentFacingMode === 'user' ? 'mirror' : ''}"></video>
        <div id="remoteAvatar_local" class="avatar-placeholder">
          <div class="avatar-icon">YOU</div>
          <span>${cleanName}</span>
        </div>
        <div class="tile-badge">
          <span class="quality-dot good" id="quality_local"></span>
          <span id="res_badge_local" class="quality-res-badge">🟢 Local</span>
          <span id="name_local">${cleanName} (YOU)</span>
        </div>
        <button class="tile-pin-btn" id="pin_btn_local" onclick="selectMainParticipant('local')" title="Spotlight YOU" aria-label="Spotlight YOU">📌</button>
        <button class="tile-fs-btn" onclick="toggleTileFullscreen('local')" title="Expand Video" aria-label="Expand Video">⛶</button>
      `;
      grid.appendChild(localTile);
    }
    const localTileVideo = document.getElementById('remoteVideo_local');
    if (localTileVideo && localTileVideo.srcObject !== localStream) {
      localTileVideo.srcObject = localStream;
      localTileVideo.muted = true;
    }
    const localTileAvatar = document.getElementById('remoteAvatar_local');
    if (localTileAvatar) {
      const cameraTrack = localStream?.getVideoTracks()?.[0];
      localTileAvatar.style.display = (cameraTrack && cameraTrack.enabled) ? 'none' : 'flex';
    }
    if (localTile) localTile.style.display = 'flex';
  } else if (localTile) {
    localTile.style.display = 'none';
  }

  peerConnections.forEach((peerData, sid) => {
    let tile = document.getElementById(`tile_${sid}`);
    if (!tile) {
      createRemoteVideoTile(sid, peerData.displayName);
      tile = document.getElementById(`tile_${sid}`);
    }

    if (tile) {
      if (sid === smallParticipantId) {
        tile.style.display = 'none';
      } else {
        tile.style.display = 'flex';
        const videoEl = document.getElementById(`remoteVideo_${sid}`);
        if (videoEl && videoEl.srcObject !== peerData.remoteStream) {
          videoEl.srcObject = peerData.remoteStream;
        }
      }
    }
  });

  updateLayoutPresentation();
}

// ===== Layout Mode & Pinning Pipeline =====
function toggleLayoutMode() {
  const icon = document.getElementById('layoutBtnIcon');
  if (currentLayoutMode === 'grid') {
    currentLayoutMode = 'active';
    if (icon) icon.textContent = '🎙️';
    toast('Layout Mode: Active Speaker');
  } else if (currentLayoutMode === 'active') {
    currentLayoutMode = 'spotlight';
    if (icon) icon.textContent = '📌';
    toast('Layout Mode: Spotlight');
  } else {
    currentLayoutMode = 'grid';
    if (icon) icon.textContent = '▦';
    isManualSwapPinned = false;
    pinnedParticipantId = null;
    toast('Layout Mode: Grid (Auto-Active Speaker)');
  }
  updateViewAllocation();
}

function pinParticipant(socketId) {
  selectMainParticipant(socketId);
}

function updateLayoutPresentation() {
  const grid = document.getElementById('remoteVideoGrid');
  if (!grid) return;

  grid.setAttribute('data-layout', currentLayoutMode);

  const mainTargetId = mainParticipantId || pinnedParticipantId || activeSpeakerId || 'local';

  const allTiles = document.querySelectorAll('.remote-video-tile');
  allTiles.forEach(tile => {
    const sid = tile.id.replace('tile_', '');
    const isMain = sid === mainTargetId;
    const isPinned = isManualSwapPinned && isMain;

    tile.classList.toggle('spotlight-main', isMain || currentLayoutMode !== 'grid');
    tile.classList.toggle('is-pinned', isPinned);

    const pinBtn = tile.querySelector('.tile-pin-btn');
    if (pinBtn) pinBtn.classList.toggle('pinned', isPinned);
  });
}

// ===== Hand Raise & Reactions Engine =====
function toggleRaiseHand() {
  isHandRaised = !isHandRaised;
  const btn = document.getElementById('btnRaiseHand');
  if (btn) btn.classList.toggle('active-accent', isHandRaised);

  if (socket && roomCode) {
    socket.emit('raise-hand-state', roomCode, isHandRaised);
  }
  toast(isHandRaised ? 'Hand Raised 🙋' : 'Hand Lowered');
}

function updateParticipantHandStateUI(socketId, isRaised) {
  const badge = document.getElementById(`hand_${socketId}`);
  if (badge) {
    badge.style.display = isRaised ? 'block' : 'none';
  }
}

function toggleReactionsPopup() {
  const popup = document.getElementById('reactionsPopup');
  if (popup) {
    popup.style.display = popup.style.display === 'flex' ? 'none' : 'flex';
  }
}

function sendReaction(emoji) {
  const popup = document.getElementById('reactionsPopup');
  if (popup) popup.style.display = 'none';

  displayFloatingReactionOnTile(mySocketId, emoji);

  let sentCount = 0;
  peerConnections.forEach((peerData) => {
    if (peerData.chatChannel && peerData.chatChannel.readyState === 'open') {
      try {
        peerData.chatChannel.send(JSON.stringify({ type: 'reaction', emoji }));
        sentCount++;
      } catch (e) {}
    }
  });

  if (sentCount === 0 && socket && roomCode) {
    socket.emit('reaction', roomCode, emoji);
  }
}

function displayFloatingReactionOnTile(socketId, emoji) {
  let container = null;
  if (socketId === mySocketId) {
    container = document.getElementById('localVideoWrap');
  } else {
    container = document.getElementById(`tile_${socketId}`);
  }
  if (!container) return;

  const floatEl = document.createElement('div');
  floatEl.className = 'floating-rxn';
  floatEl.textContent = emoji;

  container.appendChild(floatEl);
  setTimeout(() => floatEl.remove(), 2000);
}

// ===== Stream Sharing Engine (Extensionless, Signed, MP4, WebM, HLS, MKV) =====
function openStreamModal() {
  const modal = document.getElementById('streamModal');
  if (modal) {
    modal.classList.add('open');
    const input = document.getElementById('streamUrlInput');
    if (input) { input.value = ''; input.focus(); }
  }
}

function closeStreamModal() {
  const modal = document.getElementById('streamModal');
  if (modal) modal.classList.remove('open');
}

async function detectMediaStreamTypeAndFormat(rawUrl) {
  const cleanUrl = rawUrl.trim();
  let contentType = '';
  let contentLength = null;
  let acceptRanges = '';
  let statusCode = 200;
  let isCorsRestricted = false;

  // Attempt 1: Client-side HEAD request with byte range to inspect response headers
  try {
    const res = await fetch(cleanUrl, {
      method: 'HEAD',
      headers: { 'Range': 'bytes=0-1024' }
    });
    statusCode = res.status;
    contentType = res.headers.get('content-type') || '';
    contentLength = res.headers.get('content-length') ? parseInt(res.headers.get('content-length'), 10) : null;
    acceptRanges = res.headers.get('accept-ranges') || '';
  } catch (err) {
    isCorsRestricted = true;
  }

  // Attempt 2: Server-side header inspection endpoint /api/detect-media if client fetch restricted by CORS
  if (isCorsRestricted || !contentType) {
    try {
      const serverRes = await fetch('/api/detect-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl })
      });
      if (serverRes.ok) {
        const data = await serverRes.json();
        if (data.statusCode) statusCode = data.statusCode;
        if (data.contentType) contentType = data.contentType;
        if (data.contentLength) contentLength = data.contentLength;
        if (data.acceptRanges) acceptRanges = data.acceptRanges;
      }
    } catch (sErr) {}
  }

  // Handle expired or not found URLs
  if (statusCode === 403 || statusCode === 410) {
    return { success: false, error: 'Stream URL expired. Please provide a new URL.' };
  }
  if (statusCode === 404) {
    return { success: false, error: 'Media stream not found (404). Please verify the URL.' };
  }

  // Determine Container & MIME Type from Content-Type header and URL
  let container = 'Media';
  let mimeType = contentType.split(';')[0].trim().toLowerCase();
  const urlLower = cleanUrl.toLowerCase();

  if (mimeType.includes('m3u8') || mimeType.includes('mpegurl') || urlLower.includes('.m3u8')) {
    container = 'HLS';
    mimeType = 'application/vnd.apple.mpegurl';
  } else if (mimeType.includes('webm') || urlLower.includes('.webm')) {
    container = 'WebM';
    mimeType = 'video/webm';
  } else if (mimeType.includes('matroska') || mimeType.includes('mkv') || urlLower.includes('.mkv')) {
    container = 'MKV';
    mimeType = 'video/x-matroska';
  } else if (mimeType.includes('dash') || urlLower.includes('.mpd')) {
    container = 'DASH';
    mimeType = 'application/dash+xml';
  } else if (mimeType.includes('mp4') || mimeType.includes('quicktime') || urlLower.includes('.mp4')) {
    container = 'MP4';
    mimeType = 'video/mp4';
  } else if (!mimeType || mimeType === 'application/octet-stream') {
    if (urlLower.includes('.m3u8')) { container = 'HLS'; mimeType = 'application/vnd.apple.mpegurl'; }
    else if (urlLower.includes('.webm')) { container = 'WebM'; mimeType = 'video/webm'; }
    else if (urlLower.includes('.mkv')) { container = 'MKV'; mimeType = 'video/x-matroska'; }
    else { container = 'MP4 Stream'; mimeType = 'video/mp4'; }
  }

  // Test Browser Playback Compatibility via HTMLMediaElement.canPlayType()
  const testVideo = document.createElement('video');
  let isDirectPlayable = false;

  if (container === 'HLS') {
    isDirectPlayable = (typeof Hls !== 'undefined' && Hls.isSupported()) || Boolean(testVideo.canPlayType('application/vnd.apple.mpegurl'));
  } else {
    const canPlayResult = testVideo.canPlayType(mimeType);
    isDirectPlayable = Boolean(canPlayResult && canPlayResult !== '');
  }

  let usePipeline = false;
  let errorMsg = null;

  if (!isDirectPlayable) {
    if (container === 'MKV' || mimeType.includes('matroska')) {
      usePipeline = true;
    } else {
      errorMsg = `This browser cannot directly play this media format (${container}).`;
    }
  }

  return {
    success: !errorMsg,
    url: cleanUrl,
    mimeType,
    container,
    contentLength,
    acceptRanges,
    usePipeline,
    isCorsRestricted,
    error: errorMsg
  };
}

async function submitStreamShare() {
  const input = document.getElementById('streamUrlInput');
  if (!input) return;
  const url = input.value.trim();

  if (!url || !/^https?:\/\//i.test(url)) {
    toast('Please enter a valid HTTP/HTTPS media URL');
    return;
  }

  toast('Inspecting media stream headers...');
  const detection = await detectMediaStreamTypeAndFormat(url);

  if (!detection.success) {
    toast(detection.error || 'Unable to play this media URL');
    return;
  }

  closeStreamModal();

  const streamMeta = {
    url: detection.url,
    mimeType: detection.mimeType,
    container: detection.container,
    usePipeline: detection.usePipeline,
    senderName: myDisplayName
  };

  playStreamShare(streamMeta, true);

  if (socket && roomCode) {
    socket.emit('stream-share-start', roomCode, streamMeta);
  }
}

function playStreamShare(data, isBroadcaster) {
  const wrap = document.getElementById('streamPlayerWrap');
  const video = document.getElementById('streamVideo');
  const title = document.getElementById('streamTitleText');
  if (!wrap || !video) return;

  const rawUrl = typeof data === 'string' ? data : data.url;
  const mimeType = (typeof data === 'object' && data.mimeType) ? data.mimeType : 'auto';
  const container = (typeof data === 'object' && data.container) ? data.container : 'Media';
  const usePipeline = (typeof data === 'object' && data.usePipeline) ? true : false;

  wrap.style.display = 'flex';
  if (title) {
    const label = usePipeline ? `${container} (Transcoded Stream)` : container;
    title.textContent = `🎬 Shared Stream (${label})`;
  }

  if (hlsPlayerInstance) {
    hlsPlayerInstance.destroy();
    hlsPlayerInstance = null;
  }

  video.onerror = () => {
    const errCode = video.error ? video.error.code : 0;
    let errText = 'Unable to play media stream.';
    if (errCode === 1) errText = 'Playback aborted by user.';
    else if (errCode === 2) errText = 'Network error loading media stream.';
    else if (errCode === 3) errText = 'Media decode error (unsupported codec).';
    else if (errCode === 4) errText = 'This media server does not allow direct browser playback or the URL has expired.';
    toast(errText);
  };

  const playUrl = usePipeline ? `/api/stream-pipeline?url=${encodeURIComponent(rawUrl)}` : rawUrl;

  if (mimeType.includes('mpegurl') || rawUrl.includes('.m3u8')) {
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      hlsPlayerInstance = new Hls();
      hlsPlayerInstance.loadSource(playUrl);
      hlsPlayerInstance.attachMedia(video);
      hlsPlayerInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playUrl;
      video.play().catch(() => {});
    } else {
      toast('HLS playback is not supported on this browser.');
      return;
    }
  } else {
    video.src = playUrl;
    video.play().catch(() => {});
  }
}

function closeStreamShareUIOnly() {
  const wrap = document.getElementById('streamPlayerWrap');
  const video = document.getElementById('streamVideo');
  if (wrap) wrap.style.display = 'none';
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  if (hlsPlayerInstance) {
    hlsPlayerInstance.destroy();
    hlsPlayerInstance = null;
  }
}

function closeStreamShare() {
  closeStreamShareUIOnly();
  if (socket && roomCode) {
    socket.emit('stream-share-stop', roomCode);
  }
  toast('Closed shared stream');
}

function handleRemoteStreamAction(action, currentTime) {
  const video = document.getElementById('streamVideo');
  if (!video) return;

  if (typeof currentTime === 'number' && Math.abs(video.currentTime - currentTime) > 1.5) {
    video.currentTime = currentTime;
  }

  if (action === 'play') video.play().catch(() => {});
  if (action === 'pause') video.pause();
}

// ===== Host Controls & Room Lock =====
function toggleLockRoom(isLocked) {
  isRoomLocked = isLocked;
  if (socket && isHost && roomCode) {
    socket.emit('room-lock-state', roomCode, isLocked);
  }
}

function muteAllParticipants() {
  if (socket && isHost && roomCode) {
    if (confirm('Mute microphone for all participants?')) {
      socket.emit('mute-all', roomCode);
      toast('Sent mute command to participants');
    }
  }
}
