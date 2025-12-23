/* ================================
   CONFIG (CHANGE THIS ONE LINE)
   ================================ */
// After deploying backend on Render, set it like:
// const SIGNALING_HTTP = "https://p2p-drop-signal.onrender.com";
const SIGNALING_HTTP = "https://YOUR-BACKEND-ON-RENDER.onrender.com";

/* ================================
   UI helpers
   ================================ */
const roomEl = document.getElementById("room");
const randBtn = document.getElementById("rand");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const fileEl = document.getElementById("file");
const sendBtn = document.getElementById("send");
const progressEl = document.getElementById("progress");
const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");

function setStatus(text, ok = false) {
  statusEl.textContent = text;
  statusEl.className = "pill " + (ok ? "ok" : "");
  if (!ok && text.toLowerCase().includes("error")) statusEl.className = "pill bad";
}

function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

/* ================================
   WebRTC + Signaling
   ================================ */
let ws = null;
let pc = null;
let dc = null;

const CHUNK_SIZE = 64 * 1024;           // 64KiB recommended for DataChannel
const HIGH_WATER = 8 * 1024 * 1024;     // 8MB max buffered before pausing send
const LOW_WATER  = 2 * 1024 * 1024;     // resume when buffered < 2MB

// RX state
let rxMeta = null;
let rxParts = [];
let rxBytes = 0;

// Used for backpressure waiting
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpToWsBase(httpUrl) {
  // https://x -> wss://x , http://x -> ws://x
  return httpUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}

randBtn.onclick = () => {
  roomEl.value = Math.floor(1000 + Math.random() * 9000).toString();
};

connectBtn.onclick = async () => {
  const roomId = roomEl.value.trim();
  if (!roomId) return alert("Enter a Room ID first.");

  if (!SIGNALING_HTTP.includes("http")) {
    return alert("Set SIGNALING_HTTP in app.js to your Render backend URL.");
  }

  const wsBase = httpToWsBase(SIGNALING_HTTP);
  const wsUrl = `${wsBase}/ws/${encodeURIComponent(roomId)}`;

  setStatus("Connecting...");
  log(`[WS] ${wsUrl}`);

  ws = new WebSocket(wsUrl);

  ws.onopen = async () => {
    log("[WS] Connected");
    setStatus("Signaling connected", true);
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    await startPeer();
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (!pc) return;

    if (msg.type === "offer") {
      log("[SIG] offer");
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: "answer", sdp: pc.localDescription }));
    }

    if (msg.type === "answer") {
      log("[SIG] answer");
      await pc.setRemoteDescription(msg.sdp);
    }

    if (msg.type === "ice" && msg.candidate) {
      await pc.addIceCandidate(msg.candidate);
    }
  };

  ws.onerror = () => {
    setStatus("WebSocket error", false);
    log("[WS] error");
  };

  ws.onclose = () => {
    setStatus("Disconnected", false);
    log("[WS] closed");
    cleanup();
  };
};

disconnectBtn.onclick = () => {
  if (ws) ws.close();
  cleanup();
};

function cleanup() {
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  sendBtn.disabled = true;

  if (dc) { try { dc.close(); } catch {} }
  if (pc) { try { pc.close(); } catch {} }
  dc = null;
  pc = null;

  ws = null;

  rxMeta = null;
  rxParts = [];
  rxBytes = 0;
  progressEl.value = 0;
}

async function startPeer() {
  // TURN not included here. Add TURN later for “works everywhere”.
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }
    ]
  });

  pc.onicecandidate = (e) => {
    if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ice", candidate: e.candidate }));
    }
  };

  pc.onconnectionstatechange = () => {
    log(`[RTC] state=${pc.connectionState}`);
    if (pc.connectionState === "connected") setStatus("P2P connected", true);
    if (["failed","disconnected","closed"].includes(pc.connectionState)) setStatus("P2P not connected", false);
  };

  // If remote creates channel, receive it here
  pc.ondatachannel = (e) => {
    dc = e.channel;
    setupDataChannel();
  };

  // Create our own channel too (works fine; one will become the active one)
  dc = pc.createDataChannel("file", { ordered: true });
  setupDataChannel();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({ type: "offer", sdp: pc.localDescription }));
  log("[SIG] offer sent");
}

function setupDataChannel() {
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = LOW_WATER;

  dc.onopen = () => {
    log("[DC] open");
    sendBtn.disabled = false;
    setStatus("P2P connected", true);
  };

  dc.onclose = () => {
    log("[DC] closed");
    sendBtn.disabled = true;
  };

  dc.onerror = () => {
    log("[DC] error");
    sendBtn.disabled = true;
  };

  dc.onmessage = (event) => {
    // First message is JSON meta; then binary chunks
    if (typeof event.data === "string") {
      const msg = JSON.parse(event.data);
      if (msg.kind === "meta") {
        rxMeta = msg;
        rxParts = [];
        rxBytes = 0;
        progressEl.value = 0;
        log(`[RX] Incoming: ${rxMeta.name} (${rxMeta.size} bytes)`);
      }
      return;
    }

    // Binary chunk
    const buf = event.data;
    rxParts.push(buf);
    rxBytes += buf.byteLength;

    if (rxMeta && rxMeta.size > 0) {
      progressEl.value = Math.min(100, Math.floor((rxBytes / rxMeta.size) * 100));
    }

    // Finished?
    if (rxMeta && rxBytes >= rxMeta.size) {
      const blob = new Blob(rxParts, { type: rxMeta.mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = rxMeta.name || "download";
      a.click();

      URL.revokeObjectURL(url);
      log("[RX] Download ready");
      rxMeta = null;
      rxParts = [];
      rxBytes = 0;
      progressEl.value = 0;
    }
  };
}

sendBtn.onclick = async () => {
  const file = fileEl.files[0];
  if (!file) return alert("Select a file first.");
  if (!dc || dc.readyState !== "open") return alert("Not connected yet.");

  // send meta first
  const meta = { kind: "meta", name: file.name, size: file.size, mime: file.type };
  dc.send(JSON.stringify(meta));
  log(`[TX] Sending: ${file.name} (${file.size} bytes)`);

  progressEl.value = 0;

  let offset = 0;

  while (offset < file.size) {
    // Backpressure: if buffered too much, wait until low threshold event
    while (dc.bufferedAmount > HIGH_WATER) {
      await new Promise(resolve => {
        const onLow = () => {
          dc.removeEventListener("bufferedamountlow", onLow);
          resolve();
        };
        dc.addEventListener("bufferedamountlow", onLow);
      });
    }

    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buf = await slice.arrayBuffer();
    dc.send(buf);

    offset += buf.byteLength;
    progressEl.value = Math.min(100, Math.floor((offset / file.size) * 100));
  }

  log("[TX] Done");
  // keep progress for a moment
  await wait(300);
};
