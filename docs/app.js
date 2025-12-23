/* ================================
   CONFIG
   ================================ */
const SIGNALING_HTTP = "https://p2p-drop-signal.onrender.com";

/* ================================
   UI helpers
   ================================ */
const roomEl = document.getElementById("room");
const randBtn = document.getElementById("rand");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const fileEl = document.getElementById("file");
const sendBtn = document.getElementById("send");
const acceptBtn = document.getElementById("accept");
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

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpToWsBase(httpUrl) {
  return httpUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}

function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

// IMPORTANT: mobile browsers cannot safely buffer multi-GB
const MAX_MOBILE_BYTES = 500 * 1024 * 1024; // 500MB

/* ================================
   PERFORMANCE TUNING
   ================================ */
const NUM_CHANNELS = 4;
const CHUNK_SIZE = 256 * 1024;           // 256KB
const HIGH_WATER = 16 * 1024 * 1024;     // 16MB buffered cap per channel
const LOW_WATER  = 4 * 1024 * 1024;      // resume when < 4MB

/* ================================
   WebRTC + Signaling state
   ================================ */
let ws = null;
let pc = null;
let dcs = []; // RTCDataChannel array

/* ================================
   TX state (wait accept / reject)
   ================================ */
let txActive = false;
let txAbort = false;
let txWaitAcceptResolve = null;

/* ================================
   RX state (accept flow)
   ================================ */
let pendingMeta = null;

let rxMeta = null;
let rxTotalChunks = 0;
let rxExpectedSize = 0;
let rxReceivedBytes = 0;
let rxNextWriteIndex = 0;
let rxChunkMap = new Map(); // chunkIndex -> ArrayBuffer payload
let rxWriter = null;        // FileSystemWritableFileStream (Chrome/Edge)
let rxWriteChain = Promise.resolve();
let rxParts = [];           // fallback memory buffer (not good for huge files)

/* ================================
   Packet format (binary)
   [u32 chunkIndex][u32 payloadLen][payload bytes...]
   ================================ */
function packChunk(index, payloadBuf) {
  const payloadLen = payloadBuf.byteLength;
  const out = new ArrayBuffer(8 + payloadLen);
  const dv = new DataView(out);
  dv.setUint32(0, index);
  dv.setUint32(4, payloadLen);
  new Uint8Array(out, 8).set(new Uint8Array(payloadBuf));
  return out;
}

function unpackChunk(packetBuf) {
  const dv = new DataView(packetBuf);
  const index = dv.getUint32(0);
  const len = dv.getUint32(4);
  const payload = packetBuf.slice(8, 8 + len);
  return { index, payload };
}

/* ================================
   Control messages between peers
   ================================ */
function sendControl(msgObj) {
  const ch0 = dcs[0];
  if (ch0 && ch0.readyState === "open") {
    ch0.send(JSON.stringify(msgObj));
  }
}

/* ================================
   Streaming save (desktop Chrome/Edge)
   ================================ */
async function openWriterIfPossible(fileName) {
  // Mobile Safari doesn't support this.
  if (!window.showSaveFilePicker) return null;

  const handle = await window.showSaveFilePicker({
    suggestedName: fileName,
    types: [{ description: "All files", accept: { "*/*": [".*"] } }],
  });
  return await handle.createWritable();
}

function resetRxHard() {
  pendingMeta = null;
  rxMeta = null;
  rxTotalChunks = 0;
  rxExpectedSize = 0;
  rxReceivedBytes = 0;
  rxNextWriteIndex = 0;
  rxChunkMap.clear();
  rxWriter = null;
  rxParts = [];
  progressEl.value = 0;
}

async function drainWrites() {
  while (rxChunkMap.has(rxNextWriteIndex)) {
    const payload = rxChunkMap.get(rxNextWriteIndex);
    rxChunkMap.delete(rxNextWriteIndex);

    if (rxWriter) {
      await rxWriter.write(payload);
    } else {
      rxParts.push(payload);
    }

    rxNextWriteIndex++;
  }

  // Done?
  if (rxMeta && rxNextWriteIndex === rxTotalChunks) {
    if (rxWriter) {
      await rxWriter.close();
      log("[RX] File saved (streamed to disk).");
    } else {
      // WARNING: huge files may crash in browsers that must buffer in RAM.
      const blob = new Blob(rxParts, { type: rxMeta.mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = rxMeta.name || "download";
      a.click();
      URL.revokeObjectURL(url);
      log("[RX] Download triggered (buffered).");
    }

    resetRxHard();
  }
}

/* ================================
   Incoming handler
   ================================ */
function handleIncoming(data) {
  // STRING = control/meta
  if (typeof data === "string") {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // Sender-side: receiver rejected
    if (msg.kind === "reject") {
      if (txActive) {
        txAbort = true;
        if (txWaitAcceptResolve) { txWaitAcceptResolve(); txWaitAcceptResolve = null; }
        log(`[TX] Receiver rejected: ${msg.reason || "unknown"}`);
        alert(msg.reason || "Receiver rejected the file.");
      }
      return;
    }

    // Sender-side: receiver accepted (start transfer)
    if (msg.kind === "accept") {
      if (txWaitAcceptResolve) { txWaitAcceptResolve(); txWaitAcceptResolve = null; }
      log("[TX] Receiver accepted. Starting transfer...");
      return;
    }

    // Receiver-side: meta (do NOT open picker here; wait for Accept button)
    if (msg.kind === "meta") {
      resetRxHard();
      pendingMeta = msg;

      // Mobile guard: reject early
      if (isMobile() && msg.size > MAX_MOBILE_BYTES) {
        log("[RX] Too large for mobile browser. Rejecting.");
        alert("This file is too large to receive on phone browser. Receive on laptop OR use Upload Mode (cloud link).");
        sendControl({ kind: "reject", reason: "Receiver is mobile; file too large for browser memory." });
        resetRxHard();
        return;
      }

      log(`[RX] Incoming request: ${msg.name} (${msg.size} bytes, ${msg.totalChunks} chunks). Click "Accept Incoming".`);
      return;
    }

    return;
  }

  // BINARY chunk packets
  // IMPORTANT: ignore chunks until receiver ACCEPTS (rxMeta != null)
  if (!rxMeta) return;

  const { index, payload } = unpackChunk(data);

  rxChunkMap.set(index, payload);
  rxReceivedBytes += payload.byteLength;

  if (rxExpectedSize > 0) {
    progressEl.value = Math.min(100, Math.floor((rxReceivedBytes / rxExpectedSize) * 100));
  }

  rxWriteChain = rxWriteChain.then(() => drainWrites()).catch(() => {});
}

/* ================================
   Accept Incoming button (user gesture -> picker allowed)
   ================================ */
acceptBtn.onclick = async () => {
  if (!pendingMeta) {
    alert("No incoming file request.");
    return;
  }

  // Prepare RX state
  rxMeta = pendingMeta;
  rxTotalChunks = pendingMeta.totalChunks;
  rxExpectedSize = pendingMeta.size;
  rxReceivedBytes = 0;
  rxNextWriteIndex = 0;
  rxChunkMap.clear();
  rxParts = [];
  progressEl.value = 0;

  log(`[RX] Accepted: ${rxMeta.name}. Choose save location...`);

  // IMPORTANT: This is a click handler => user gesture => picker works reliably
  try {
    rxWriter = await openWriterIfPossible(rxMeta.name);
    if (rxWriter) {
      log("[RX] Streaming write enabled.");
    } else {
      log("[RX] Streaming not available (will buffer in memory). Large files may fail on this browser/device.");
    }
  } catch {
    rxWriter = null;
    log("[RX] Save picker canceled/blocked. Large files will likely fail (RAM buffering).");
    alert("You canceled the Save dialog. Large files cannot be received safely. Try again and press Save.");
    // Do not accept transfer if user canceled
    resetRxHard();
    sendControl({ kind: "reject", reason: "Receiver canceled Save dialog." });
    return;
  }

  // Tell sender OK to start now
  sendControl({ kind: "accept" });
  pendingMeta = null;
};

/* ================================
   Connection lifecycle
   ================================ */
function cleanup() {
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  sendBtn.disabled = true;
  acceptBtn.disabled = true;

  txActive = false;
  txAbort = false;
  if (txWaitAcceptResolve) { txWaitAcceptResolve(); txWaitAcceptResolve = null; }

  try { if (ws) ws.close(); } catch {}
  try { if (dcs) dcs.forEach(c => c && c.close()); } catch {}
  try { if (pc) pc.close(); } catch {}

  ws = null;
  pc = null;
  dcs = [];

  resetRxHard();
  setStatus("Disconnected", false);
}

disconnectBtn.onclick = () => cleanup();

randBtn.onclick = () => {
  roomEl.value = Math.floor(1000 + Math.random() * 9000).toString();
};

connectBtn.onclick = async () => {
  const roomId = roomEl.value.trim();
  if (!roomId) return alert("Enter a Room ID first.");

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
    log("[WS] closed");
    cleanup();
  };
};

/* ================================
   WebRTC setup
   ================================ */
async function startPeer() {
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }
      // TURN improves connectivity reliability; speed is limited by upload bandwidth.
    ],
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

  // Remote-created channels
  pc.ondatachannel = (e) => {
    const ch = e.channel;
    const m = /file-(\d+)/.exec(ch.label || "");
    const idx = m ? parseInt(m[1], 10) : 0;
    setupDataChannel(ch, idx);
    dcs[idx] = ch;
  };

  // Create multiple channels
  dcs = [];
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const ch = pc.createDataChannel(`file-${i}`, { ordered: false });
    setupDataChannel(ch, i);
    dcs.push(ch);
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({ type: "offer", sdp: pc.localDescription }));
  log("[SIG] offer sent");
}

function setupDataChannel(ch, idx) {
  ch.binaryType = "arraybuffer";
  ch.bufferedAmountLowThreshold = LOW_WATER;

  ch.onopen = () => {
    log(`[DC${idx}] open`);
    const allOpen =
      dcs.length === NUM_CHANNELS &&
      dcs.every(c => c && c.readyState === "open");

    if (allOpen) {
      sendBtn.disabled = false;
      acceptBtn.disabled = false;
      setStatus("P2P connected", true);
    }
  };

  ch.onclose = () => {
    log(`[DC${idx}] closed`);
    sendBtn.disabled = true;
    acceptBtn.disabled = true;
  };

  ch.onerror = () => {
    log(`[DC${idx}] error`);
    sendBtn.disabled = true;
    acceptBtn.disabled = true;
  };

  ch.onmessage = (event) => handleIncoming(event.data);
}

/* ================================
   Sending (parallel / round-robin)
   Waits for receiver "accept"
   ================================ */
sendBtn.onclick = async () => {
  const file = fileEl.files[0];
  if (!file) return alert("Select a file first.");

  const ready =
    dcs.length === NUM_CHANNELS &&
    dcs.every(c => c && c.readyState === "open");

  if (!ready) return alert("Not connected yet (all channels not open).");

  txActive = true;
  txAbort = false;

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // Send meta on channel 0
  const meta = {
    kind: "meta",
    name: file.name,
    size: file.size,
    mime: file.type,
    chunkSize: CHUNK_SIZE,
    totalChunks
  };
  dcs[0].send(JSON.stringify(meta));

  log(`[TX] Request sent. Waiting for receiver accept... (${file.name}, ${file.size} bytes)`);
  progressEl.value = 0;

  // Wait for accept or reject
  await new Promise((resolve) => { txWaitAcceptResolve = resolve; });

  if (txAbort) {
    log("[TX] Aborted before start.");
    txActive = false;
    return;
  }

  let sentBytes = 0;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    if (txAbort) {
      log("[TX] Aborted.");
      txActive = false;
      return;
    }

    const offset = chunkIndex * CHUNK_SIZE;
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buf = await slice.arrayBuffer();

    const chIdx = chunkIndex % NUM_CHANNELS;
    const ch = dcs[chIdx];

    // per-channel backpressure
    while (ch.bufferedAmount > HIGH_WATER) {
      if (txAbort) break;
      await new Promise((resolve) => {
        const onLow = () => {
          ch.removeEventListener("bufferedamountlow", onLow);
          resolve();
        };
        ch.addEventListener("bufferedamountlow", onLow);
      });
    }

    if (txAbort) {
      log("[TX] Aborted.");
      txActive = false;
      return;
    }

    ch.send(packChunk(chunkIndex, buf));

    sentBytes += buf.byteLength;
    progressEl.value = Math.min(100, Math.floor((sentBytes / file.size) * 100));
  }

  log("[TX] Done");
  txActive = false;
  await wait(200);
};
