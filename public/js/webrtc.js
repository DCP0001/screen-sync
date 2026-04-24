// ═══════════════════════════════════════════════
// ScreenSync — WebRTC Helpers
// ═══════════════════════════════════════════════

const WebRTCHelper = (() => {
  'use strict';

  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
    ],
  };

  function createPeerConnection(configOverride = null) {
    const pc = new RTCPeerConnection(configOverride || ICE_SERVERS);
    // Internal ICE candidate queue
    pc._iceCandidateQueue = [];
    pc._remoteDescriptionSet = false;
    console.log('[WebRTC] PeerConnection created');
    return pc;
  }

  /**
   * Add tracks from a stream to a peer connection.
   * Each peer connection gets its own clone of each track
   * to avoid shared-track lifecycle issues.
   */
  function addStreamTracks(pc, stream) {
    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
      console.log('[WebRTC] Added track:', track.kind, track.readyState);
    });
  }

  async function createOffer(pc, stream) {
    addStreamTracks(pc, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log('[WebRTC] Offer created');
    return { type: offer.type, sdp: offer.sdp };
  }

  async function createAnswer(pc, offerSdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
    pc._remoteDescriptionSet = true;
    // Flush queued ICE candidates
    await _flushIceCandidateQueue(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log('[WebRTC] Answer created');
    return { type: answer.type, sdp: answer.sdp };
  }

  async function setRemoteAnswer(pc, answerSdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
    pc._remoteDescriptionSet = true;
    // Flush queued ICE candidates
    await _flushIceCandidateQueue(pc);
    console.log('[WebRTC] Remote answer set');
  }

  async function _flushIceCandidateQueue(pc) {
    const queue = pc._iceCandidateQueue || [];
    pc._iceCandidateQueue = [];
    for (const c of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
        console.log('[WebRTC] Flushed queued ICE candidate');
      } catch (err) {
        console.warn('[WebRTC] Failed to flush ICE candidate:', err);
      }
    }
  }

  async function addIceCandidate(pc, candidate) {
    try {
      if (pc._remoteDescriptionSet) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        console.log('[WebRTC] Queuing ICE candidate (remote desc not set)');
        pc._iceCandidateQueue.push(candidate);
      }
    } catch (err) {
      console.warn('[WebRTC] ICE candidate error:', err);
    }
  }

  function onIceCandidate(pc, cb) {
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        cb(e.candidate);
      }
    };
  }

  function onTrack(pc, cb) {
    pc.ontrack = (e) => {
      console.log('[WebRTC] ontrack fired, streams:', e.streams.length);
      if (e.streams && e.streams[0]) {
        cb(e.streams[0]);
      } else if (e.track) {
        // Fallback: create a stream from the track
        const stream = new MediaStream([e.track]);
        cb(stream);
      }
    };
  }

  function onConnectionStateChange(pc, cb) {
    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', pc.connectionState);
      cb(pc.connectionState);
    };
    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE connection state:', pc.iceConnectionState);
    };
  }

  function closePeerConnection(pc) {
    if (!pc) return;
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    try { pc.close(); } catch {}
    console.log('[WebRTC] PeerConnection closed');
  }

  async function captureScreen() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 60 },
      },
      audio: false,
    });
    const vt = stream.getVideoTracks()[0];
    if (vt && 'contentHint' in vt) vt.contentHint = 'detail';
    console.log('[WebRTC] Screen capture started, track state:', vt.readyState);
    return stream;
  }

  return {
    createPeerConnection, addStreamTracks, createOffer,
    createAnswer, setRemoteAnswer, addIceCandidate,
    onIceCandidate, onTrack, onConnectionStateChange,
    closePeerConnection, captureScreen,
  };
})();

window.WebRTCHelper = WebRTCHelper;
