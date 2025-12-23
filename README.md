# P2P Drop (No Server Storage)

A simple, free, cross-device **peer-to-peer file transfer** website using **WebRTC** for direct transfers and a lightweight **WebSocket signaling server** (Render) for connection setup.

✅ No files are stored on the server  
✅ Works on Windows / macOS / Android (best on Chrome/Edge)  
✅ Uses Room ID to connect devices  
✅ Large files supported (browser/storage limitations apply)

---

## Live Website

Open the app here:

**https://kunalvaghani.github.io/p2p-drop-frontend/**

---

## How It Works

- The **frontend** is hosted on **GitHub Pages**.
- The **signaling server** is hosted on **Render** and is used only to exchange WebRTC connection data (offer/answer/ICE).
- Actual file data is sent **directly device-to-device** using WebRTC DataChannels.

---

## How to Use

### 1) Connect Two Devices
1. Open the website on **Device A**
2. Enter a Room ID (or click **Random**)
3. Click **Create Room**
4. Open the website on **Device B**
5. Enter the **same Room ID**
6. Click **Connect**
7. Wait until status shows **P2P connected**

### 2) Send a File
1. On the sender device, click **Choose File**
2. Click **Send**
3. On the receiver device, click **Accept Incoming**
4. After transfer completes:
   - Click **Save Received** to download/share the file (if shown)

---

## Notes / Limitations (Important)

- Transfer speed depends entirely on your **real upload/download bandwidth**.
- Multi-GB transfers work best on **Chrome or Edge desktop**.
- Some mobile browsers (especially iPhone Safari) may not reliably handle multi-GB downloads due to browser/OS storage limitations.

---
