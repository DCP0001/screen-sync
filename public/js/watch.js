// ═══════════════════════════════════════════════
// ScreenSync — Watch Party Orchestrator
// ═══════════════════════════════════════════════

(function () {
  'use strict';

  // ── URL params ──
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('id');
  const isHost = params.get('role') === 'host';

  if (!roomId) { window.location.href = '/'; return; }

  // ── State ──
  let myPeerId = null;
  let nickname = '';
  let localAudioStream = null;
  let isMicOn = false;
  let syncEnabled = true; // viewers accept sync commands
  const audioPCs = new Map(); // peerId → { pc, audio element }
  const signaling = new SignalingClient();
  const SYNC_INTERVAL = 3000;
  const DRIFT_THRESHOLD = 0.8; // seconds
  let syncTimer = null;
  let chatCount = 0;

  // ── DOM refs ──
  const $ = (id) => document.getElementById(id);
  const roomIdDisplay   = $('room-id-display');
  const roomIdBadge     = $('room-id-badge');
  const hostStatusDot   = $('host-status-dot');
  const hostStatusText  = $('host-status-text');
  const viewerCount     = $('viewer-count');
  const dropOverlay     = $('drop-overlay');
  const lobbyTitle      = $('lobby-title');
  const lobbySubtitle   = $('lobby-subtitle');
  const video           = $('watch-video');
  const fileInput       = $('file-input');
  const btnPickFile     = $('btn-pick-file');
  const btnPlay         = $('btn-play');
  const seekBar         = $('seek-bar');
  const seekBarFill     = $('seek-bar-fill');
  const timeDisplay     = $('time-display');
  const btnVolume       = $('btn-volume');
  const volumeSlider    = $('volume-slider');
  const btnFullscreen   = $('btn-fullscreen');
  const btnMic          = $('btn-mic');
  const btnCopyLink     = $('btn-copy-link');
  const btnLeave        = $('btn-leave');
  const chatMessages    = $('chat-messages');
  const chatInput       = $('chat-input');
  const btnSendChat     = $('btn-send-chat');
  const chatCountEl     = $('chat-count');
  const nicknameModal   = $('nickname-modal');
  const nicknameInput   = $('nickname-input');
  const btnSetNickname  = $('btn-set-nickname');
  const toastBox        = $('toast-container');

  // ── Helpers ──
  function toast(msg, variant = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast--${variant}`;
    el.textContent = msg;
    toastBox.appendChild(el);
    setTimeout(() => { el.classList.add('removing'); el.addEventListener('animationend', () => el.remove()); }, 3500);
  }

  function formatTime(s) {
    if (isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function setHostStatus(status) {
    hostStatusDot.className = 'status-dot';
    if (status === 'active') { hostStatusDot.classList.add('status-dot--online'); hostStatusText.textContent = 'Watching'; }
    else if (status === 'inactive') { hostStatusDot.classList.add('status-dot--offline'); hostStatusText.textContent = 'Idle'; }
    else { hostStatusDot.classList.add('status-dot--warning'); hostStatusText.textContent = 'Connecting…'; }
  }

  // ═══════════════════════════════════════════════
  // NICKNAME
  // ═══════════════════════════════════════════════

  function showNicknameModal() {
    return new Promise((resolve) => {
      nicknameModal.style.display = 'flex';
      nicknameInput.focus();
      const submit = () => {
        nickname = nicknameInput.value.trim() || 'User ' + Math.floor(Math.random() * 999);
        nicknameModal.style.display = 'none';
        resolve(nickname);
      };
      btnSetNickname.addEventListener('click', submit);
      nicknameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    });
  }

  // ═══════════════════════════════════════════════
  // VIDEO FILE LOADING
  // ═══════════════════════════════════════════════

  function loadVideoFile(file) {
    if (!isHost) {
      toast('Only the host can upload a video', 'error');
      return;
    }

    lobbyTitle.textContent = 'Uploading...';
    lobbySubtitle.textContent = '0%';
    btnPickFile.style.display = 'none';

    const formData = new FormData();
    formData.append('video', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/upload/${roomId}`, true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        lobbySubtitle.textContent = `${percent}%`;
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        const res = JSON.parse(xhr.responseText);
        video.src = res.url;
        video.load();
        dropOverlay.classList.add('hidden');
        toast(`Uploaded: ${file.name}`, 'success');

        signaling.send('video-url-load', { url: res.url, fileName: file.name });
      } else {
        lobbyTitle.textContent = 'Upload failed';
        lobbySubtitle.textContent = 'Please try again';
        btnPickFile.style.display = 'inline-block';
        toast('Upload failed', 'error');
      }
    };

    xhr.onerror = () => {
      lobbyTitle.textContent = 'Upload failed';
      lobbySubtitle.textContent = 'Network error';
      btnPickFile.style.display = 'inline-block';
      toast('Upload failed', 'error');
    };

    xhr.send(formData);
  }

  btnPickFile.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadVideoFile(e.target.files[0]);
  });

  // Drag & drop
  const videoWrapper = $('video-wrapper');
  videoWrapper.addEventListener('dragover', (e) => { e.preventDefault(); videoWrapper.classList.add('drag-over'); });
  videoWrapper.addEventListener('dragleave', () => videoWrapper.classList.remove('drag-over'));
  videoWrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    videoWrapper.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) loadVideoFile(file);
    else toast('Please drop a video file', 'error');
  });

  // ═══════════════════════════════════════════════
  // VIDEO CONTROLS
  // ═══════════════════════════════════════════════

  // Play/Pause
  btnPlay.addEventListener('click', () => {
    if (!video.src) return;
    if (video.paused) {
      video.play();
      if (isHost) signaling.send('video-play', { currentTime: video.currentTime });
    } else {
      video.pause();
      if (isHost) signaling.send('video-pause', { currentTime: video.currentTime });
    }
  });

  video.addEventListener('play', () => { btnPlay.textContent = '⏸️'; setHostStatus('active'); });
  video.addEventListener('pause', () => { btnPlay.textContent = '▶️'; });

  // Seek bar
  let isSeeking = false;
  seekBar.addEventListener('input', () => {
    isSeeking = true;
    const t = (seekBar.value / 100) * video.duration;
    seekBarFill.style.width = seekBar.value + '%';
    timeDisplay.textContent = `${formatTime(t)} / ${formatTime(video.duration)}`;
  });
  seekBar.addEventListener('change', () => {
    const t = (seekBar.value / 100) * video.duration;
    video.currentTime = t;
    isSeeking = false;
    if (isHost) signaling.send('video-seek', { currentTime: t });
  });

  video.addEventListener('timeupdate', () => {
    if (isSeeking) return;
    const pct = (video.currentTime / video.duration) * 100;
    seekBar.value = pct || 0;
    seekBarFill.style.width = (pct || 0) + '%';
    timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  });

  // Volume
  volumeSlider.addEventListener('input', () => {
    video.volume = parseFloat(volumeSlider.value);
    video.muted = video.volume === 0;
    btnVolume.textContent = video.muted ? '🔇' : '🔊';
  });
  btnVolume.addEventListener('click', () => {
    video.muted = !video.muted;
    btnVolume.textContent = video.muted ? '🔇' : '🔊';
    volumeSlider.value = video.muted ? 0 : video.volume;
  });

  // Fullscreen
  btnFullscreen.addEventListener('click', () => {
    const el = $('video-wrapper');
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  });

  // ═══════════════════════════════════════════════
  // HOST: PERIODIC TIME SYNC
  // ═══════════════════════════════════════════════

  function startSyncTimer() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(() => {
      if (isHost && !video.paused && video.src) {
        signaling.send('video-time-sync', { currentTime: video.currentTime, paused: false });
      }
    }, SYNC_INTERVAL);
  }

  // ═══════════════════════════════════════════════
  // CHAT
  // ═══════════════════════════════════════════════

  function addChatMessage(nick, text, isSelf = false) {
    // Remove empty placeholder
    const empty = chatMessages.querySelector('.chat-empty');
    if (empty) empty.remove();

    const el = document.createElement('div');
    el.className = `chat-msg ${isSelf ? 'chat-msg--self' : ''}`;
    el.innerHTML = `<span class="chat-msg__name">${escapeHtml(nick)}</span><span class="chat-msg__text">${escapeHtml(text)}</span>`;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    chatCount++;
    chatCountEl.textContent = `${chatCount} messages`;
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    addChatMessage(nickname, text, true);
    signaling.send('chat-message', { nickname, text });
    chatInput.value = '';
  }

  btnSendChat.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatMessage(); });

  // ═══════════════════════════════════════════════
  // VOICE CHAT (WebRTC Audio)
  // ═══════════════════════════════════════════════

  async function startMic() {
    try {
      localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      isMicOn = true;
      btnMic.textContent = '🎤 Mic On';
      btnMic.style.borderColor = 'var(--status-online)';
      toast('Microphone enabled', 'success');

      // Send audio offer to all existing peers
      const room = signaling;
      // We need a list of peers — we'll create connections for them
      // The peer list comes from peer-joined events; for simplicity,
      // we handle it reactively in peer-joined + offer exchange
    } catch (err) {
      toast('Microphone access denied', 'error');
    }
  }

  function stopMic() {
    if (localAudioStream) {
      localAudioStream.getTracks().forEach(t => t.stop());
      localAudioStream = null;
    }
    isMicOn = false;
    btnMic.textContent = '🎤 Voice Chat';
    btnMic.style.borderColor = '';

    // Close all audio peer connections
    for (const [pid, { pc, audio }] of audioPCs) {
      WebRTCHelper.closePeerConnection(pc);
      if (audio) audio.remove();
    }
    audioPCs.clear();
  }

  btnMic.addEventListener('click', () => {
    if (isMicOn) stopMic();
    else startMic();
  });

  // Create audio offer to a specific peer
  async function createAudioOffer(peerId) {
    if (!localAudioStream) return;

    const pc = WebRTCHelper.createPeerConnection();
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    document.body.appendChild(audioEl);
    audioPCs.set(peerId, { pc, audio: audioEl });

    localAudioStream.getTracks().forEach(t => pc.addTrack(t, localAudioStream));

    WebRTCHelper.onIceCandidate(pc, (candidate) => {
      signaling.send('ice-candidate', { targetPeerId: peerId, candidate: candidate.toJSON() });
    });

    WebRTCHelper.onTrack(pc, (stream) => {
      audioEl.srcObject = stream;
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.send('offer', { targetPeerId: peerId, sdp: { type: offer.type, sdp: offer.sdp } });
  }

  // Handle audio offer from a peer
  async function handleAudioOffer(peerId, sdp) {
    const pc = WebRTCHelper.createPeerConnection();
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    document.body.appendChild(audioEl);
    audioPCs.set(peerId, { pc, audio: audioEl });

    // Add our mic if we have it
    if (localAudioStream) {
      localAudioStream.getTracks().forEach(t => pc.addTrack(t, localAudioStream));
    }

    WebRTCHelper.onIceCandidate(pc, (candidate) => {
      signaling.send('ice-candidate', { targetPeerId: peerId, candidate: candidate.toJSON() });
    });

    WebRTCHelper.onTrack(pc, (stream) => {
      audioEl.srcObject = stream;
    });

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    pc._remoteDescriptionSet = true;
    // Flush ICE queue
    for (const c of (pc._iceCandidateQueue || [])) {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    }
    pc._iceCandidateQueue = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signaling.send('answer', { targetPeerId: peerId, sdp: { type: answer.type, sdp: answer.sdp } });
  }

  // ═══════════════════════════════════════════════
  // SIGNALING HANDLERS
  // ═══════════════════════════════════════════════

  function setupSignaling() {
    signaling.on('room-joined', (msg) => {
      myPeerId = msg.peerId;
      viewerCount.textContent = msg.peerCount;
      setHostStatus(msg.isHost ? 'inactive' : 'connecting');
      toast(msg.isHost ? 'Party room ready!' : 'Joined party!', 'success');
    });

    signaling.on('peer-joined', async (msg) => {
      viewerCount.textContent = msg.peerCount;
      toast('Someone joined the party!', 'info');
      // If mic is on, create audio offer
      if (isMicOn && localAudioStream) {
        await createAudioOffer(msg.peerId);
      }
    });

    signaling.on('peer-count-update', (msg) => { viewerCount.textContent = msg.peerCount; });

    signaling.on('peer-left', (msg) => {
      const entry = audioPCs.get(msg.peerId);
      if (entry) {
        WebRTCHelper.closePeerConnection(entry.pc);
        if (entry.audio) entry.audio.remove();
        audioPCs.delete(msg.peerId);
      }
      toast('Someone left', 'info');
    });

    signaling.on('host-left', () => {
      setHostStatus('inactive');
      toast('Host disconnected', 'error');
    });

    // Video sync from host
    signaling.on('video-url-load', (msg) => {
      if (!isHost) {
        video.src = msg.url;
        video.load();
        dropOverlay.classList.add('hidden');
        toast(`Host loaded: ${msg.fileName}`, 'success');
      }
    });

    signaling.on('video-play', (msg) => {
      if (!isHost && syncEnabled && video.src) {
        video.currentTime = msg.currentTime;
        video.play().catch(() => {});
      }
    });

    signaling.on('video-pause', (msg) => {
      if (!isHost && syncEnabled && video.src) {
        video.currentTime = msg.currentTime;
        video.pause();
      }
    });

    signaling.on('video-seek', (msg) => {
      if (!isHost && syncEnabled && video.src) {
        video.currentTime = msg.currentTime;
      }
    });

    signaling.on('video-time-sync', (msg) => {
      if (!isHost && syncEnabled && video.src && !video.paused) {
        const drift = Math.abs(video.currentTime - msg.currentTime);
        if (drift > DRIFT_THRESHOLD) {
          video.currentTime = msg.currentTime;
        }
      }
    });

    // Chat
    signaling.on('chat-message', (msg) => {
      addChatMessage(msg.nickname, msg.text, false);
    });

    // WebRTC signaling for audio
    signaling.on('offer', async (msg) => {
      await handleAudioOffer(msg.peerId, msg.sdp);
    });

    signaling.on('answer', async (msg) => {
      const entry = audioPCs.get(msg.peerId);
      if (entry) {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        entry.pc._remoteDescriptionSet = true;
        for (const c of (entry.pc._iceCandidateQueue || [])) {
          await entry.pc.addIceCandidate(new RTCIceCandidate(c));
        }
        entry.pc._iceCandidateQueue = [];
      }
    });

    signaling.on('ice-candidate', async (msg) => {
      const entry = audioPCs.get(msg.peerId);
      if (entry) {
        await WebRTCHelper.addIceCandidate(entry.pc, msg.candidate);
      }
    });

    signaling.on('error', (msg) => toast(msg.message, 'error'));
  }

  // ═══════════════════════════════════════════════
  // COMMON CONTROLS
  // ═══════════════════════════════════════════════

  function copyRoomLink() {
    const url = `${window.location.origin}/watch.html?id=${roomId}`;
    navigator.clipboard.writeText(url).then(() => toast('Link copied!', 'success'))
      .catch(() => toast('Could not copy', 'error'));
  }

  btnCopyLink.addEventListener('click', copyRoomLink);
  roomIdBadge.addEventListener('click', copyRoomLink);

  btnLeave.addEventListener('click', () => {
    signaling.disconnect();
    stopMic();
    window.location.href = '/';
  });

  // ═══════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════

  async function init() {
    roomIdDisplay.textContent = roomId;
    document.title = `ScreenSync — Watch Party ${roomId}`;

    // Show different UI for host vs viewer
    if (!isHost) {
      lobbyTitle.textContent = 'Waiting for host';
      lobbySubtitle.textContent = 'The host is uploading a video...';
      btnPickFile.style.display = 'none';
    }

    // Nickname prompt
    await showNicknameModal();

    // Setup signaling
    setupSignaling();

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    try {
      await signaling.connect(`${protocol}://${location.host}/ws`);
    } catch {
      toast('Cannot connect to server', 'error');
      return;
    }

    signaling.send('join-room', { roomId, role: isHost ? 'host' : 'viewer' });
    signaling.send('set-nickname', { nickname });

    startSyncTimer();
  }

  init();
})();
