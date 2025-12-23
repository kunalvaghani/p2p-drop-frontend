/* ================================
   CONFIG
   ================================ */
// Your Render signaling backend:
const SIGNALING_HTTP = "https://p2p-drop-signal.onrender.com";

/* ================================
   UI
   ================================ */
const roomEl = document.getElementById("room");
const randBtn = document.getElementById("rand");
const hostBtn = document.getElementById("host");
const joinBtn = document.getElementById("join");
const disconnectBtn = document.getElementById("disconnect");
const fileEl = document.getElementById("file");
const sendBtn = document.getElementById("send");
const acceptBtn = document.getElementById("accept");
const saveReceivedBtn = document.getElementById("saveReceived");
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
   WebRTC tuning
   ================================ */
/**
 * IMPORTANT:
 * - Bigger chunks do NOT beat bandwidth.
 * - Too-big messages can break DataChannel cross-browser.
 * MDN notes the default negotiated max message size can be 64KiB if not present.
 */
const NUM_CHANNELS = 4;

// Payload size (NOT counting our 8-byte header). Safer across browsers than 256KiB.
const CHUNK_PAYLOAD = 32 * 1024;

// Per-channel backpressure
const HIGH_WATER = 4 * 1024 * 1024; // 4MB
const LOW_WATER  = 1 * 1024 * 1024; // 1MB

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpToWsBase(httpUrl) {
  return httpUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}

function sanitizeName(name) {
  return (name || "download").replace(/[^\w.\-()+\s]/g, "_").slice(0, 180);
}

/* ================================
   State
   ================================ */
let ws = null;
let pc = null;

// One ordered channel for control messages (meta/accept/reject/done)
let dcCtrl = null;

// Unordered reliable channels for data
let dcData = []; // array of RTCDataChannel

let isHost = false;
let connectedRoom = null;

// TX
let txBusy = false;
let txFile = null;
let txAccepted = false;

// RX
let pendingMeta = null;
let rxActive = false;
let rxSink = null;        // { type, write(Uint8Array), close(), finalize? }
let rxName = "";
let rxMime = "";
let rxSize = 0;
let rxTotalChunks = 0;

let rxNextSeq = 0;
let rxBytesWritten = 0;
let rxPendingChunks = new Map(); // seq -> Uint8Array
let rxDoneFlag = false;

// OPFS finalize
let lastReceivedFile = null; // File object for Save Received

/* ================================
   Buttons
   ================================ */
randBtn.onclick = () => {
  roomEl.value = Math.floor(1000 + Math.random() * 9000).toString();
};

hostBtn.onclick = () => {
  if (!roomEl.value.trim()) randBtn.onclick();
  isHost = true;
  connectToRoom(roomEl.value.trim());
};

joinBtn.onclick = () => {
  const id = roomEl.value.trim();
  if (!id) return alert("Enter a Room ID first.");
  isHost = false;
  connectToRoom(id);
};

disconnectBtn.onclick = () => {
  if (ws) ws.close();
  cleanup();
};

sendBtn.onclick = async () => {
  const file = fileEl.files[0];
  if (!file) return alert("Select a file first.");
  if (!dcCtrl || dcCtrl.readyState !== "open") return alert("Not connected yet.");
  if (txBusy) return alert("Already sending something.");

  txBusy = true;
  txAccepted = false;
  txFile = file;

  const totalChunks = Math.ceil(file.size / CHUNK_PAYLOAD);
  const meta = {
    kind: "meta",
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
    chunkPayload: CHUNK_PAYLOAD,
    totalChunks,
    channels: NUM_CHANNELS
  };

  log(`[TX] Proposing: ${file.name} (${file.size} bytes, ${totalChunks} chunks, ${NUM_CHANNELS} channels)`);
  progressEl.value = 0;
  acceptBtn.disabled = true;

  dcCtrl.send(JSON.stringify(meta));

  // Wait for accept/reject
  const start = Date.now();
  while (!txAccepted && txBusy) {
    await wait(50);
    if (Date.now() - start > 60_000) { // 60s
      log("[TX] Timeout waiting for receiver accept.");
      txBusy = false;
      return;
    }
  }

  if (!txAccepted) {
    txBusy = false;
    return;
  }

  // Start sending chunks
  try {
    await sendFileOverDataChannels(file);
    dcCtrl.send(JSON.stringify({ kind: "done" }));
    log("[TX] Done.");
  } catch (e) {
    log(`[TX] Error: ${e?.name || e}: ${e?.message || ""}`);
  } finally {
    txBusy = false;
  }
};

acceptBtn.onclick = async () => {
  if (!pendingMeta) return alert("No incoming file yet.");

  // IMPORTANT: open save sink FIRST (to preserve user gesture for showSaveFilePicker)
  let sink = null;

  // Try Save dialog (Chromium desktop). If canceled/blocked, offer fallback.
  if ("showSaveFilePicker" in window) {
    try {
      sink = await createPickerSink(pendingMeta);
    } catch (e) {
      const name = e?.name || "";
      // AbortError = user canceled dialog; SecurityError/NotAllowedError = gesture/permission issues
      if (name === "AbortError" || name === "SecurityError" || name === "NotAllowedError") {
        log(`[RX] Save dialog canceled/blocked (${name}).`);
        const useFallback = confirm(
          "Save dialog was canceled/blocked.\n\nUse fallback save (store file in browser storage) instead?\nYou can press 'Save Received' after transfer."
        );
        if (!useFallback) {
          dcCtrl.send(JSON.stringify({ kind: "reject", reason: "save_dialog_canceled" }));
          pendingMeta = null;
          acceptBtn.disabled = true;
          return;
        }
      } else {
        log(`[RX] Save dialog error: ${name}: ${e?.message || ""}`);
        dcCtrl.send(JSON.stringify({ kind: "reject", reason: "save_dialog_error" }));
        pendingMeta = null;
        acceptBtn.disabled = true;
        return;
      }
    }
  }

  // Fallback: OPFS streaming (no RAM buffering)
  if (!sink) {
    sink = await createOpfsSink(pendingMeta);
    if (!sink) {
      alert(
        "This browser cannot stream-save large files.\n\nUse Chrome/Edge desktop for multi-GB transfers."
      );
      dcCtrl.send(JSON.stringify({ kind: "reject", reason: "no_streaming_support" }));
      pendingMeta = null;
      acceptBtn.disabled = true;
      return;
    }
  }

  // Accept and start RX
  startReceive(pendingMeta, sink);
  dcCtrl.send(JSON.stringify({ kind: "accept" }));

  pendingMeta = null;
  acceptBtn.disabled = true;
};

saveReceivedBtn.onclick = async () => {
  if (!lastReceivedFile) return;

  // Try Web Share first on mobile (if supported), else download
  try {
    if (navigator.canShare && navigator.canShare({ files: [lastReceivedFile] }) && navigator.share) {
      await navigator.share({ files: [lastReceivedFile], title: lastReceivedFile.name });
      return;
    }
  } catch {}

  const url = URL.createObjectURL(lastReceivedFile);
  const a = document.createElement("a");
  a.href = url;
  a.download = lastReceivedFile.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

/* ================================
   Connect / Cleanup
   ================================ */
async function connectToRoom(roomId) {
  if (!SIGNALING_HTTP.startsWith("http")) {
    return alert("Set SIGNALING_HTTP in app.js to your backend URL.");
  }
  connectedRoom = roomId;

  const wsBase = httpToWsBase(SIGNALING_HTTP);
  const wsUrl = `${wsBase}/ws/${encodeURIComponent(roomId)}`;

  setStatus("Connecting...");
  log(`[WS] ${wsUrl}`);

  ws = new WebSocket(wsUrl);

  ws.onopen = async () => {
    log("[WS] Connected");
    setStatus("Signaling connected", true);

    hostBtn.disabled = true;
    joinBtn.disabled = true;
    disconnectBtn.disabled = false;

    await startPeer(isHost);
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
      try { await pc.addIceCandidate(msg.candidate); } catch {}
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
}

function cleanup() {
  hostBtn.disabled = false;
  joinBtn.disabled = false;
  disconnectBtn.disabled = true;

  sendBtn.disabled = true;
  acceptBtn.disabled = true;
  saveReceivedBtn.disabled = true;

  pendingMeta = null;
  rxActive = false;
  rxSink = null;
  lastReceivedFile = null;

  rxNextSeq = 0;
  rxBytesWritten = 0;
  rxPendingChunks.clear();
  rxDoneFlag = false;

  txBusy = false;
  txFile = null;
  txAccepted = false;

  progressEl.value = 0;

  try { dcCtrl?.close(); } catch {}
  for (const dc of dcData) { try { dc.close(); } catch {} }
  dcCtrl = null;
  dcData = [];

  try { pc?.close(); } catch {}
  pc = null;

  ws = null;
  connectedRoom = null;
}

/* ================================
   Peer setup
   ================================ */
async function startPeer(initiator) {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
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

  pc.ondatachannel = (e) => {
    const ch = e.channel;
    if (ch.label === "ctrl") {
      dcCtrl = ch;
      setupCtrlChannel();
      return;
    }
    if (ch.label.startsWith("data-")) {
      const idx = parseInt(ch.label.slice(5), 10);
      dcData[idx] = ch;
      setupDataChannel(ch, idx);
      return;
    }
  };

  if (initiator) {
    // Create channels only on host to avoid duplicates/glare
    dcCtrl = pc.createDataChannel("ctrl", { ordered: true });
    setupCtrlChannel();

    dcData = new Array(NUM_CHANNELS);
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const ch = pc.createDataChannel(`data-${i}`, { ordered: false }); // unordered, reliable by default
      dcData[i] = ch;
      setupDataChannel(ch, i);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: "offer", sdp: pc.localDescription }));
    log("[SIG] offer sent (host)");
  } else {
    log("[RTC] waiting for offer (joiner)");
  }
}

function setupCtrlChannel() {
  dcCtrl.onopen = () => {
    log("[CTRL] open");
    sendBtn.disabled = false;
    setStatus("P2P connected", true);
  };
  dcCtrl.onclose = () => log("[CTRL] closed");
  dcCtrl.onerror = () => log("[CTRL] error");

  dcCtrl.onmessage = async (event) => {
    if (typeof event.data !== "string") return;
    const msg = JSON.parse(event.data);

    if (msg.kind === "meta") {
      pendingMeta = msg;
      acceptBtn.disabled = false;
      log(`[RX] Incoming request: ${msg.name} (${msg.size} bytes, ${msg.totalChunks} chunks). Click "Accept Incoming".`);
      return;
    }

    if (msg.kind === "accept") {
      txAccepted = true;
      log("[TX] Receiver accepted.");
      return;
    }

    if (msg.kind === "reject") {
      log(`[TX] Receiver rejected: ${msg.reason || "unknown"}`);
      txBusy = false;
      txAccepted = false;
      return;
    }

    if (msg.kind === "done") {
      rxDoneFlag = true;
      log("[RX] Sender reported done.");
      // If we already wrote all chunks, finalize now
      await maybeFinalizeReceive();
      return;
    }
  };
}

function setupDataChannel(ch, idx) {
  ch.binaryType = "arraybuffer";
  ch.bufferedAmountLowThreshold = LOW_WATER;

  ch.onopen = () => log(`[DATA${idx}] open`);
  ch.onclose = () => log(`[DATA${idx}] closed`);
  ch.onerror = () => log(`[DATA${idx}] error`);
  ch.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    if (!rxActive) return;
    handleIncomingPacket(event.data);
  };
}

/* ================================
   Packet format: [seq:uint32][len:uint32][payload bytes...]
   ================================ */
function packPacket(seq, payloadU8) {
  const len = payloadU8.byteLength;
  const buf = new ArrayBuffer(8 + len);
  const dv = new DataView(buf);
  dv.setUint32(0, seq, true);
  dv.setUint32(4, len, true);
  new Uint8Array(buf, 8).set(payloadU8);
  return buf;
}

function unpackPacket(arrayBuf) {
  const dv = new DataView(arrayBuf);
  const seq = dv.getUint32(0, true);
  const len = dv.getUint32(4, true);
  const payload = new Uint8Array(arrayBuf, 8, len);
  return { seq, payload };
}

/* ================================
   RX Sink implementations
   ================================ */
async function createPickerSink(meta) {
  // Must be called directly from user gesture; otherwise SecurityError. (Hence why we call it first.)
  const handle = await window.showSaveFilePicker({ suggestedName: sanitizeName(meta.name) });
  const writable = await handle.createWritable();
  log("[RX] Streaming to chosen file (Save dialog).");
  return {
    type: "picker",
    async write(u8) { await writable.write(u8); },
    async close() { await writable.close(); },
    async finalize() { return null; }
  };
}

async function createOpfsSink(meta) {
  if (!navigator.storage || !navigator.storage.getDirectory) return null;

  try { await navigator.storage.persist?.(); } catch {}

  try {
    const root = await navigator.storage.getDirectory();
    const tempName = `p2pdrop_${Date.now()}_${sanitizeName(meta.name)}`;
    const handle = await root.getFileHandle(tempName, { create: true });
    const writable = await handle.createWritable();
    log("[RX] Streaming to OPFS (browser storage fallback).");

    return {
      type: "opfs",
      async write(u8) { await writable.write(u8); },
      async close() { await writable.close(); },
      async finalize() {
        const file = await handle.getFile();
        return new File([file], sanitizeName(meta.name), { type: meta.mime || "application/octet-stream" });
      }
    };
  } catch (e) {
    log(`[RX] OPFS error: ${e?.name || e}: ${e?.message || ""}`);
    return null;
  }
}

/* ================================
   Receiving logic (sequential flush)
   ================================ */
function startReceive(meta, sink) {
  rxActive = true;
  rxSink = sink;

  rxName = meta.name || "download";
  rxMime = meta.mime || "application/octet-stream";
  rxSize = meta.size || 0;
  rxTotalChunks = meta.totalChunks || Math.ceil(rxSize / CHUNK_PAYLOAD);

  rxNextSeq = 0;
  rxBytesWritten = 0;
  rxPendingChunks.clear();
  rxDoneFlag = false;

  lastReceivedFile = null;
  saveReceivedBtn.disabled = true;

  progressEl.value = 0;

  log(`[RX] Accepted: ${rxName} (${rxSize} bytes, ${rxTotalChunks} chunks). Receiving...`);
}

let rxFlushBusy = false;

function handleIncomingPacket(arrayBuf) {
  const { seq, payload } = unpackPacket(arrayBuf);
  // Store out-of-order
  rxPendingChunks.set(seq, payload);
  // Attempt flush
  flushRxInOrder().catch(() => {});
}

async function flushRxInOrder() {
  if (rxFlushBusy) return;
  rxFlushBusy = true;

  try {
    while (rxPendingChunks.has(rxNextSeq)) {
      const payload = rxPendingChunks.get(rxNextSeq);
      rxPendingChunks.delete(rxNextSeq);

      await rxSink.write(payload);

      rxBytesWritten += payload.byteLength;
      rxNextSeq++;

      if (rxSize > 0) {
        progressEl.value = Math.min(100, Math.floor((rxBytesWritten / rxSize) * 100));
      }
    }
  } finally {
    rxFlushBusy = false;
  }

  await maybeFinalizeReceive();
}

async function maybeFinalizeReceive() {
  if (!rxActive) return;

  const wroteAll = (rxTotalChunks > 0) ? (rxNextSeq >= rxTotalChunks) : (rxBytesWritten >= rxSize);
  if (!wroteAll) return;
  if (!rxDoneFlag) return; // wait for sender "done"

  rxActive = false;
  progressEl.value = 100;

  log("[RX] All chunks written. Finalizing...");

  try {
    await rxSink.close();
    const finalized = await rxSink.finalize?.();

    if (finalized) {
      lastReceivedFile = finalized;
      saveReceivedBtn.disabled = false;
      log(`[RX] Ready: press "Save Received" to download/share "${finalized.name}".`);
    } else {
      log("[RX] Saved to chosen location.");
    }
  } catch (e) {
    log(`[RX] Finalize error: ${e?.name || e}: ${e?.message || ""}`);
  } finally {
    rxSink = null;
    rxPendingChunks.clear();
    rxDoneFlag = false;
    await wait(300);
    progressEl.value = 0;
  }
}

/* ================================
   Sending logic
   ================================ */
async function waitForLow(dc) {
  while (dc.bufferedAmount > HIGH_WATER) {
    await new Promise(resolve => {
      const onLow = () => { dc.removeEventListener("bufferedamountlow", onLow); resolve(); };
      dc.addEventListener("bufferedamountlow", onLow);
    });
  }
}

async function sendFileOverDataChannels(file) {
  if (!dcCtrl || dcCtrl.readyState !== "open") throw new Error("CTRL channel not open.");

  // Wait until we have at least one data channel open
  const start = Date.now();
  while (dcData.filter(Boolean).filter(ch => ch.readyState === "open").length === 0) {
    await wait(50);
    if (Date.now() - start > 15_000) throw new Error("No data channels opened.");
  }

  // Tell receiver we accepted on this side (symmetry)
  // (Receiver will also send accept; harmless)
  try { dcCtrl.send(JSON.stringify({ kind: "accept" })); } catch {}

  const totalChunks = Math.ceil(file.size / CHUNK_PAYLOAD);
  let seq = 0;
  let offset = 0;

  const t0 = performance.now();

  while (offset < file.size) {
    const end = Math.min(file.size, offset + CHUNK_PAYLOAD);
    const ab = await file.slice(offset, end).arrayBuffer();
    const u8 = new Uint8Array(ab);

    const ch = dcData[seq % NUM_CHANNELS] || dcData.find(c => c && c.readyState === "open");
    if (!ch || ch.readyState !== "open") throw new Error("Data channel closed.");

    await waitForLow(ch);

    const packet = packPacket(seq, u8);
    ch.send(packet);

    seq++;
    offset = end;

    progressEl.value = Math.min(100, Math.floor((seq / totalChunks) * 100));
  }

  const t1 = performance.now();
  const seconds = Math.max(0.001, (t1 - t0) / 1000);
  const mbps = (file.size * 8) / (seconds * 1_000_000);
  log(`[TX] Sent ${file.size} bytes in ${seconds.toFixed(2)}s (~${mbps.toFixed(1)} Mbps).`);
  await wait(300);
}
