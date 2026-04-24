// ═══════════════════════════════════════════════
// ScreenSync — Landing Page Logic
// ═══════════════════════════════════════════════

(function () {
  'use strict';

  // ── DOM refs ──
  const btnCreate   = document.getElementById('btn-create-room');
  const btnWatch    = document.getElementById('btn-watch-party');
  const btnJoin     = document.getElementById('btn-join-room');
  const inputCode   = document.getElementById('input-room-code');
  const toastBox    = document.getElementById('toast-container');
  const particlesEl = document.getElementById('particles');

  // ── Particles ──
  function spawnParticles(count = 30) {
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.classList.add('particle');
      el.style.left = `${Math.random() * 100}%`;
      el.style.animationDuration = `${12 + Math.random() * 20}s`;
      el.style.animationDelay = `${Math.random() * 15}s`;
      el.style.width = el.style.height = `${2 + Math.random() * 3}px`;
      particlesEl.appendChild(el);
    }
  }

  // ── Toast ──
  function showToast(message, variant = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast--${variant}`;
    toast.textContent = message;
    toastBox.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('removing');
      toast.addEventListener('animationend', () => toast.remove());
    }, 3500);
  }

  // ── Generic room creator ──
  function createRoomAndRedirect(btn, originalLabel, targetPage) {
    btn.disabled = true;
    btn.textContent = '⏳ Creating…';

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'create-room' }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'room-created') {
        ws.close();
        window.location.href = `/${targetPage}?id=${msg.roomId}&role=host`;
      } else if (msg.type === 'error') {
        showToast(msg.message, 'error');
        btn.disabled = false;
        btn.textContent = originalLabel;
        ws.close();
      }
    };

    ws.onerror = () => {
      showToast('Failed to connect to server', 'error');
      btn.disabled = false;
      btn.textContent = originalLabel;
    };

    ws.onclose = () => {
      setTimeout(() => {
        if (btn.disabled && !window.location.href.includes('.html')) {
          btn.disabled = false;
          btn.textContent = originalLabel;
        }
      }, 2000);
    };
  }

  // ── Create Watch Party ──
  btnWatch.addEventListener('click', () => {
    createRoomAndRedirect(btnWatch, '🎬 Start a Watch Party', 'watch.html');
  });

  // ── Join Room ──
  function joinRoom() {
    const code = inputCode.value.trim().toLowerCase();
    if (!code) {
      showToast('Please enter a room code', 'error');
      inputCode.focus();
      return;
    }
    if (code.length < 4) {
      showToast('Room code is too short', 'error');
      inputCode.focus();
      return;
    }
    window.location.href = `/watch.html?id=${code}`;
  }

  btnJoin.addEventListener('click', joinRoom);
  inputCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });

  // ── Format input ──
  inputCode.addEventListener('input', () => {
    inputCode.value = inputCode.value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  });

  // ── Init ──
  spawnParticles();
})();
