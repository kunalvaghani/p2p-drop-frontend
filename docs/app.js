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

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpToWsBase(httpUrl) {
  return httpUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}

/* ================================
   PERFORMANCE TUNING
   ================================ */
const NUM_CHANNELS = 4;                  // parallel lanes
const CHUNK_SIZE = 256 * 1024;           // 256KB chunks
const HIGH_WATER = 16 * 1024 * 1024;     // 16MB buffer cap per channel
const LOW_WATER  = 4 * 1024 * 1024;      // resume when < 4MB

/* ================================
   WebRTC + Signaling state
   ================================ */
let ws = null;
let pc = null;
let dcs = []; // RTCDataChannel array

/* ================================
   RX state (supports out-of-order)
   ================================ */
let rxMeta = null;
let rxTotalChunks = 0;
let rxExpectedSize = 0;

let rxReceivedBytes = 0;
let rxNextWriteIndex = 0;
let rxChunkMap = new Map(); // chunkIndex -> ArrayBuffer payload

let rxWriter = null;        // FileSystemWritableFileStream (Chrome/Edge)
let rxWriteChain = Promise.resolve();
let rxParts = [];           // fallback memory buffer (not good for 6GB)

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
   Streaming save (desktop Chrome/Edge)
   ================================ */
async function openWriterIfPossible(fileName) {
  // Only works on desktop Chrome/Edge; not on iPhone Safari.
  if (!window.showSaveFilePicker) return null;

  const handle = await window.showSaveFilePicker({
    suggestedName: fileName,
    types: [{ description: "All files", accept: { "*/*": [".*"] } }],
  });
  return await handle.createWritable();
}

async function drainWrites() {
  while (rxChunkMap.has(rxNextWriteIndex)) {
    const payload = rxChunkMap.get(rxNextWriteIndex);
    rxChunkMap.delete(rxNextWriteIndex);

    if (rxWriter) {
      await rxWriter.write(payload);
    } else {
      // fallback memory buffer (may crash for huge files)
      rxParts.push(payload);
    }
    rxNextWriteIndex++;
  }

  // done?
  if (rxMeta && rxNextWriteIndex === rxTotalChunks) {
    if (rxWriter) {
      await rxWriter.close();
      log("[RX] File saved (streamed to disk).");
    } else {
      // Big files may crash here; desktop only.
      const blob = new Blob(rxParts, { type: rxMeta.mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = rxMeta.name || "download";
      a.click();
      URL.revokeObjectURL(url);
      log("[RX] Download triggered (buffered).");
      rxParts = [];
    }

    // reset
    rxMeta = null;
    rxTotalChunks = 0;
    rxExpectedSize = 0;
    rxReceivedBytes = 0;
    rxNextWriteIndex = 0;
    rxChunkMap.clear();
    progressEl.value = 0;
  }
}

function handleIncoming(data) {
  if (typeof data === "string") {
    const msg = JSON.parse(data);

    if (msg.kind === "meta") {
      rxMeta = msg;
      rxTotalChunks = msg.totalChunks;
      rxExpectedSize = msg.size;

      rxReceivedBytes = 0;
      rxNextWriteIndex = 0;
      rxChunkMap.clear();
      rxParts = [];
      progressEl.value = 0;

      log(`[RX] Incoming: ${msg.name} (${msg.size} bytes, ${msg.totalChunks} chunks)`);

      // prepare streaming writer
      rxWriter = null;
      rxWriteChain = (async () => {
        try {
          rxWriter = await openWriterIfPossible(msg.name);
          if (rxWriter) log("[RX] Streaming write enabled (best for multi-GB).");
          else log("[RX] Streaming not available (will buffer in memory).");
        } catch {
          rxWriter = null;
          log("[RX] Save picker canceled; will buffer in memory.");
        }
      })();
    }
    return;
  }

  // binary packet
  const { index, payload } = unpackChunk(data);

  rxChunkMap.set(index, payload);
  rxReceivedBytes += payload.byteLength;

  if (rxExpectedSize > 0) {
    progressEl.value = Math.min(100, Math.floor((rxReceivedBytes / rxExpectedSize) * 100));
  }

  rxWriteChain = rxWriteChain.then(() => drainWrites()).catch(() => {});
}

/* ================================
   Connection lifecycle
   ================================ */
function cleanup() {
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  sendBtn.disabled = true;

  try { if (ws) ws.close(); } catch {}
  try { if (dcs) dcs.forEach(c => c && c.close()); } catch {}
  try { if (pc) pc.close(); } catch {}

  ws = null;
  pc = null;
  dcs = [];

  // RX reset
  rxMeta = null;
  rxTotalChunks = 0;
  rxExpectedSize = 0;
  rxReceivedBytes = 0;
  rxNextWriteIndex = 0;
  rxChunkMap.clear();
  rxWriter = null;
  rxParts = [];
  progressEl.value = 0;

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
      // Add TURN here later for “works everywhere”
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
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) setStatus("P2P not connected", false);
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
    // enable send only when ALL channels open
    const allOpen =
      dcs.length === NUM_CHANNELS &&
      dcs.every((c) => c && c.readyState === "open");

    if (allOpen) {
      sendBtn.disabled = false;
      setStatus("P2P connected", true);
    }
  };

  ch.onclose = () => {
    log(`[DC${idx}] closed`);
    sendBtn.disabled = true;
  };

  ch.onerror = () => {
    log(`[DC${idx}] error`);
    sendBtn.disabled = true;
  };

  ch.onmessage = (event) => handleIncoming(event.data);
}

/* ================================
   Sending (parallel / round-robin)
   ================================ */
sendBtn.onclick = async () => {
  const file = fileEl.files[0];
  if (!file) return alert("Select a file first.");

  const ready =
    dcs.length === NUM_CHANNELS &&
    dcs.every((c) => c && c.readyState === "open");

  if (!ready) return alert("Not connected yet (all channels not open).");

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // send meta on channel 0
  const meta = {
    kind: "meta",
    name: file.name,
    size: file.size,
    mime: file.type,
    chunkSize: CHUNK_SIZE,
    totalChunks
  };
  dcs[0].send(JSON.stringify(meta));

  log(`[TX] Sending: ${file.name} (${file.size} bytes, ${totalChunks} chunks, ${NUM_CHANNELS} channels)`);
  progressEl.value = 0;

  let sentBytes = 0;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const offset = chunkIndex * CHUNK_SIZE;
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buf = await slice.arrayBuffer();

    const chIdx = chunkIndex % NUM_CHANNELS;
    const ch = dcs[chIdx];

    // per-channel backpressure
    while (ch.bufferedAmount > HIGH_WATER) {
      await new Promise((resolve) => {
        const onLow = () => {
          ch.removeEventListener("bufferedamountlow", onLow);
          resolve();
        };
        ch.addEventListener("bufferedamountlow", onLow);
      });
    }

    ch.send(packChunk(chunkIndex, buf));

    sentBytes += buf.byteLength;
    progressEl.value = Math.min(100, Math.floor((sentBytes / file.size) * 100));
  }

  log("[TX] Done");
  await wait(200);
};
