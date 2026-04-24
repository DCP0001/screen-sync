# ScreenSync 📺🎬

ScreenSync is a zero-install, browser-based screen-sharing and watch-party platform powered by WebRTC and Node.js. It allows small groups to connect via peer-to-peer (P2P) mesh networking for ultra-low latency streaming, voice chatting, and synchronized media playback.

## Features

*   **🖥️ Instant Screen Sharing:** Share your full screen, window, or specific browser tab with viewers in real-time. No sign-ups or downloads required.
*   **🎬 Watch Party:** Load a local video file (or upload one) and watch it together. The host controls playback (play, pause, seek), and it synchronizes perfectly across all viewers.
*   **💬 Real-Time Chat:** A built-in text chat overlay for room participants.
*   **🎤 Voice Chat:** Toggle your microphone to talk over the WebRTC audio mesh.
*   **🎨 Glassmorphism UI:** A sleek, dark-themed, responsive user interface designed for a premium user experience.

## Tech Stack

*   **Frontend:** Vanilla HTML5, CSS3 (Custom Variables, Animations), JavaScript (ES6+).
*   **Backend:** Node.js, Express.js.
*   **Signaling:** WebSockets (`ws` package).
*   **Networking:** WebRTC (`RTCPeerConnection`, `getUserMedia`, `getDisplayMedia`).

## Installation

Since this project relies on Node.js, ensure you have [Node.js](https://nodejs.org/) installed on your machine.

1.  Clone the repository (or download the source code):
    ```bash
    git clone https://github.com/yourusername/screen-sync.git
    cd screen-sync
    ```

2.  Install the dependencies:
    ```bash
    npm install
    ```

## Usage

1.  Start the local server:
    ```bash
    npm start
    ```
    *(Alternatively, you can run `node server.js` directly).*

2.  Open your browser and navigate to:
    ```
    http://localhost:3000
    ```

3.  **Host a Room:** Click "Create Room" (or "Watch Party"). You will be assigned a unique 8-character Room ID.
4.  **Join a Room:** Share the Room ID or the full URL with your friends. They can paste the code on the landing page or follow the link directly to join your session.

## Notes on WebRTC

*   **Localhost / HTTPS:** Browsers require a secure context to access screen sharing (`getDisplayMedia`) and microphones (`getUserMedia`). `localhost` is treated as a secure context, so it works fine locally. If you deploy this to the web, you **must** serve it over HTTPS.
*   **STUN/TURN Servers:** This project uses public Google STUN servers to negotiate P2P connections. For production deployments behind restrictive NATs or firewalls, you should configure a TURN server (e.g., Twilio, Metered, or Coturn).

## License

MIT License
