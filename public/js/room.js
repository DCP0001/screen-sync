// ═══════════════════════════════════════════════
// ScreenSync — Room Orchestrator
// ═══════════════════════════════════════════════

(function () {
  'use strict';

  // ── Parse URL params ──
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('id');
  const isHost = params.get('role') === 'host';

  if (!roomId) {
    window.location.href = '/';
    return;
  }

  // ── State ──
  let myPeerId = null;
  let localStream = null;
  let isStopping = false; // guard against re-entrant hostStopSharing
  const peerConnections = new Map(); // peerId → RTCPeerConnection
  const signaling = new SignalingClient();

  // ── DOM Refs ──
  const $ = (id) => document.getElementById(id);
  const roomIdDisplay       = $('room-id-display');
  const roomIdBadge         = $('room-id-badge');
  const hostStatusDot       = $('host-status-dot');
  const hostStatusText      = $('host-status-text');
  const viewerCount         = $('viewer-count');
  const lobbyOverlay        = $('lobby-overlay');
  const lobbyIcon           = $('lobby-icon');
  const lobbyTitle          = $('lobby-title');
  const lobbySubtitle       = $('lobby-subtitle');
  const remoteVideo         = $('remote-video');
  const btnShare            = $('btn-share');
  const btnStopShare        = $('btn-stop-share');
  const btnFullscreen       = $('btn-fullscreen');
  const btnCopyLink         = $('btn-copy-link');
  const btnLeave            = $('btn-leave');
  const disconnectedOverlay = $('disconnected-overlay');
  const disconnectTitle     = $('disconnect-title');
  const disconnectSubtitle  = $('disconnect-subtitle');
  const btnReconnect        = $('btn-reconnect');
  const toastBox            = $('toast-container');

  // ── Toast helper ──
  function toast(message, variant = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast--${variant}`;
    el.textContent = message;
    toastBox.appendChild(el);
    setTimeout(() => {
      el.classList.add('removing');
      el.addEventListener('animationend', () => el.remove());
    }, 3500);
  }

  // ── Update UI helpers ──
  function setViewerCount(count) {
    viewerCount.textContent = count;
  }

  function setHostStatus(status) {
    hostStatusDot.className = 'status-dot';
    if (status === 'active') {
      hostStatusDot.classList.add('status-dot--online');
      hostStatusText.textContent = 'Live';
    } else if (status === 'inactive') {
      hostStatusDot.classList.add('status-dot--offline');
      hostStatusText.textContent = 'Inactive';
    } else {
      hostStatusDot.classList.add('status-dot--warning');
      hostStatusText.textContent = 'Connecting…';
    }
  }

  function showLobby(icon, title, subtitle) {
    lobbyOverlay.classList.remove('hidden');
    lobbyIcon.textContent = icon;
    lobbyTitle.textContent = title;
    lobbySubtitle.textContent = subtitle;
  }

  function hideLobby() {
    lobbyOverlay.classList.add('hidden');
  }

  function showDisconnected(title, subtitle) {
    disconnectedOverlay.classList.remove('hidden');
    disconnectTitle.textContent = title;
    disconnectSubtitle.textContent = subtitle;
  }

  // ── Setup UI based on role ──
  function setupUI() {
    roomIdDisplay.textContent = roomId;
    document.title = `ScreenSync — ${roomId}`;

    if (isHost) {
      btnShare.classList.remove('hidden');
      btnFullscreen.classList.add('hidden');
      showLobby('🖥️', 'Ready to share', 'Click "Share Screen" below to start streaming.');
    } else {
      btnShare.classList.add('hidden');
      btnStopShare.classList.add('hidden');
      btnFullscreen.classList.remove('hidden');
      showLobby('📺', 'Waiting for host', 'The host hasn\'t started sharing yet…');
    }
  }

  // ═════════════════════════════════════════════
  // HOST LOGIC
  // ═════════════════════════════════════════════

  async function hostStartSharing() {
    try {
      localStream = await WebRTCHelper.captureScreen();
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        toast('Screen sharing was cancelled', 'error');
      } else {
        toast('Failed to capture screen: ' + err.message, 'error');
      }
      return;
    }

    isStopping = false;

    // Show preview on host side
    remoteVideo.srcObject = localStream;
    hideLobby();
    setHostStatus('active');
    btnShare.classList.add('hidden');
    btnStopShare.classList.remove('hidden');

    // Handle user stopping via browser UI (ended event)
    localStream.getVideoTracks()[0].addEventListener('ended', () => {
      console.log('[Room] Track ended event fired');
      hostStopSharing();
    });

    // Create offers for all existing viewers that already joined
    console.log('[Room] Existing peers to send offers:', peerConnections.size);
    for (const [peerId] of peerConnections) {
      await createOfferForPeer(peerId);
    }

    toast('Screen sharing started', 'success');
  }

  function hostStopSharing() {
    // Guard against re-entrant calls (track.stop() fires 'ended' event)
    if (isStopping) return;
    isStopping = true;

    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    remoteVideo.srcObject = null;

    // Close all peer connections
    for (const [peerId, pc] of peerConnections) {
      WebRTCHelper.closePeerConnection(pc);
    }
    peerConnections.clear();

    setHostStatus('inactive');
    btnStopShare.classList.add('hidden');
    btnShare.classList.remove('hidden');
    showLobby('🖥️', 'Sharing stopped', 'Click "Share Screen" to start again.');

    signaling.send('sharing-stopped');
    toast('Screen sharing stopped', 'info');
  }

  async function createOfferForPeer(peerId) {
    if (!localStream) {
      console.warn('[Room] createOfferForPeer: no localStream, skipping');
      return;
    }

    console.log('[Room] Creating offer for peer:', peerId);

    // Close existing connection if any
    if (peerConnections.has(peerId)) {
      WebRTCHelper.closePeerConnection(peerConnections.get(peerId));
    }

    const pc = WebRTCHelper.createPeerConnection();
    peerConnections.set(peerId, pc);

    // ICE candidates → signaling
    WebRTCHelper.onIceCandidate(pc, (candidate) => {
      signaling.send('ice-candidate', {
        targetPeerId: peerId,
        candidate: candidate.toJSON(),
      });
    });

    // Monitor connection state
    WebRTCHelper.onConnectionStateChange(pc, (state) => {
      console.log(`[Room] Peer ${peerId} connection state:`, state);
      if (state === 'connected') {
        toast('Viewer connected', 'success');
      } else if (state === 'failed') {
        toast('Connection to a viewer failed', 'error');
      }
    });

    try {
      // Create and send offer
      const offer = await WebRTCHelper.createOffer(pc, localStream);
      console.log('[Room] Offer created, sending to peer:', peerId);
      signaling.send('offer', { targetPeerId: peerId, sdp: offer });
    } catch (err) {
      console.error('[Room] Failed to create offer:', err);
      toast('Failed to create connection: ' + err.message, 'error');
    }
  }

  // ═════════════════════════════════════════════
  // VIEWER LOGIC
  // ═════════════════════════════════════════════

  async function handleOffer(peerId, sdp) {
    console.log('[Room] Received offer from peer:', peerId);

    // Close existing
    if (peerConnections.has(peerId)) {
      WebRTCHelper.closePeerConnection(peerConnections.get(peerId));
    }

    const pc = WebRTCHelper.createPeerConnection();
    peerConnections.set(peerId, pc);

    // ICE candidates → signaling
    WebRTCHelper.onIceCandidate(pc, (candidate) => {
      signaling.send('ice-candidate', {
        targetPeerId: peerId,
        candidate: candidate.toJSON(),
      });
    });

    // Receive track → display
    WebRTCHelper.onTrack(pc, (stream) => {
      console.log('[Room] Received remote stream, tracks:', stream.getTracks().length);
      remoteVideo.srcObject = stream;
      remoteVideo.play().catch(() => {}); // ensure playback starts
      hideLobby();
      setHostStatus('active');
      toast('Receiving stream', 'success');
    });

    // Connection state
    WebRTCHelper.onConnectionStateChange(pc, (state) => {
      console.log('[Room] Viewer connection state:', state);
      if (state === 'connected') {
        hideLobby();
        setHostStatus('active');
      } else if (state === 'disconnected' || state === 'failed') {
        showLobby('📡', 'Connection lost', 'Trying to reconnect to host…');
        setHostStatus('inactive');
      }
    });

    try {
      // Create and send answer
      const answer = await WebRTCHelper.createAnswer(pc, sdp);
      console.log('[Room] Answer created, sending to peer:', peerId);
      signaling.send('answer', { targetPeerId: peerId, sdp: answer });
    } catch (err) {
      console.error('[Room] Failed to create answer:', err);
      toast('Connection failed: ' + err.message, 'error');
    }
  }

  // ═════════════════════════════════════════════
  // SIGNALING HANDLERS
  // ═════════════════════════════════════════════

  function setupSignalingHandlers() {
    // Both host & viewer receive: room-joined
    signaling.on('room-joined', (msg) => {
      myPeerId = msg.peerId;
      setViewerCount(msg.peerCount);
      if (msg.isHost) {
        setHostStatus('inactive');
        toast('Room ready!', 'success');
      } else {
        setHostStatus('connecting');
        toast('Joined room', 'success');
      }
    });

    // Host receives: new viewer joined
    signaling.on('peer-joined', async (msg) => {
      setViewerCount(msg.peerCount);
      toast('A viewer joined', 'info');
      // If already sharing, create offer for new peer
      if (localStream) {
        await createOfferForPeer(msg.peerId);
      }
    });

    // Viewer receives: offer from host
    signaling.on('offer', async (msg) => {
      await handleOffer(msg.peerId, msg.sdp);
    });

    // Host receives: answer from viewer
    signaling.on('answer', async (msg) => {
      const pc = peerConnections.get(msg.peerId);
      if (pc) {
        await WebRTCHelper.setRemoteAnswer(pc, msg.sdp);
      }
    });

    // Both: ICE candidate
    signaling.on('ice-candidate', async (msg) => {
      const pc = peerConnections.get(msg.peerId);
      if (pc) {
        await WebRTCHelper.addIceCandidate(pc, msg.candidate);
      }
    });

    // Viewer/Host: peer left
    signaling.on('peer-left', (msg) => {
      const pc = peerConnections.get(msg.peerId);
      if (pc) {
        WebRTCHelper.closePeerConnection(pc);
        peerConnections.delete(msg.peerId);
      }
      toast('A viewer left', 'info');
    });

    // Viewer: peer count update
    signaling.on('peer-count-update', (msg) => {
      setViewerCount(msg.peerCount);
    });

    // Viewer: host left
    signaling.on('host-left', () => {
      for (const [pid, pc] of peerConnections) {
        WebRTCHelper.closePeerConnection(pc);
      }
      peerConnections.clear();
      remoteVideo.srcObject = null;
      setHostStatus('inactive');
      showLobby('👋', 'Host disconnected', 'The host has left the room.');
      toast('Host disconnected', 'error');
    });

    // Viewer: host stopped sharing
    signaling.on('sharing-stopped', () => {
      for (const [pid, pc] of peerConnections) {
        WebRTCHelper.closePeerConnection(pc);
      }
      peerConnections.clear();
      remoteVideo.srcObject = null;
      setHostStatus('inactive');
      showLobby('⏸️', 'Sharing paused', 'The host stopped sharing their screen.');
    });

    // Error
    signaling.on('error', (msg) => {
      toast(msg.message, 'error');
    });
  }

  // ═════════════════════════════════════════════
  // EVENT LISTENERS
  // ═════════════════════════════════════════════

  // Share screen
  btnShare.addEventListener('click', hostStartSharing);

  // Stop sharing
  btnStopShare.addEventListener('click', hostStopSharing);

  // Copy link
  function copyRoomLink() {
    const url = `${window.location.origin}/room.html?id=${roomId}`;
    navigator.clipboard.writeText(url).then(() => {
      toast('Room link copied!', 'success');
    }).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Room link copied!', 'success');
    });
  }

  btnCopyLink.addEventListener('click', copyRoomLink);
  roomIdBadge.addEventListener('click', copyRoomLink);

  // Fullscreen
  btnFullscreen.addEventListener('click', () => {
    const el = remoteVideo;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  });

  // Leave
  btnLeave.addEventListener('click', () => {
    signaling.disconnect();
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    for (const [, pc] of peerConnections) WebRTCHelper.closePeerConnection(pc);
    window.location.href = '/';
  });

  // Reconnect
  btnReconnect.addEventListener('click', () => {
    disconnectedOverlay.classList.add('hidden');
    init();
  });

  // ═════════════════════════════════════════════
  // INIT
  // ═════════════════════════════════════════════

  async function init() {
    setupUI();
    setupSignalingHandlers();

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${location.host}/ws`;

    signaling.onClose = () => {
      setHostStatus('inactive');
    };

    try {
      await signaling.connect(wsUrl);
    } catch {
      showDisconnected('Cannot connect', 'Failed to connect to the signaling server. Please check your connection.');
      return;
    }

    // Both host and viewer use join-room.
    // Server auto-creates the room if role=host and it doesn't exist.
    signaling.send('join-room', { roomId, role: isHost ? 'host' : 'viewer' });
  }

  init();
})();
