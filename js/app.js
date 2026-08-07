import { CONFIG } from './config.js';
import { createSignaling } from './signaling/index.js';
import { PeerLink } from './webrtc.js';
import { TransportSession } from './transport.js';
import { SaveEngine, hasFileSystemAccess, triggerBlobDownload } from './save-engine.js';
import { UsageTracker } from './usage-tracker.js';
import { isExecutableAdjacent, extOf } from './security.js';
import * as ui from './ui.js';

function randomRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

let signaling, peerLink, transport, saveEngine, usage;
let lastTurnBytes = 0;

ui.setSaveEngineNote(hasFileSystemAccess ? 'A' : 'B');
usage = new UsageTracker();
usage.addEventListener('update', (e) => ui.renderUsage(e.detail));

async function startAsRoom(roomCode, isInitiator) {
  ui.setLinkStatus('connecting', isInitiator ? 'Waiting for peer…' : 'Joining…');
  signaling = createSignaling();

  // Every signaling send/receive counts toward Metered's message ceiling —
  // this is the one place both directions funnel through, so it's the
  // right spot to feed the guardrail.
  const originalSendSignal = signaling.sendSignal.bind(signaling);
  signaling.sendSignal = async (...args) => { usage.recordSignalMessage(); return originalSendSignal(...args); };

  await signaling.connect(roomCode);

  signaling.onPeerJoined(async (peerId) => {
    usage.recordConcurrent(1);
    peerLink = new PeerLink(signaling, peerId, isInitiator);
    saveEngine = new SaveEngine();
    await peerLink.open();

    peerLink.addEventListener('channel-open', () => {
      ui.setLinkStatus('connected', 'Connected');
      transport = new TransportSession(peerLink, saveEngine);
      wireTransport(transport);
    });

    peerLink.addEventListener('path', (e) => {
      ui.updatePathInfo(e.detail);
      const total = e.detail.bytesSent + e.detail.bytesReceived;
      if (e.detail.localType === 'relay' || e.detail.remoteType === 'relay') {
        usage.recordTurnBytes(total - lastTurnBytes);
      }
      lastTurnBytes = total;
    });

    peerLink.addEventListener('channel-close', () => ui.setLinkStatus('idle', 'Peer disconnected'));
  });
}

function wireTransport(t) {
  t.addEventListener('send-analysis', async ({ detail }) => {
    const { fileId, name, sniff, sha256, vt } = detail;
    const needsConfirm = isExecutableAdjacent(name) || sniff?.mismatch;
    if (needsConfirm) {
      const reason = sniff?.mismatch
        ? `is disguised as .${extOf(name)} but looks like ${sniff.detected}`
        : 'is an executable-adjacent file type';
      const ok = await ui.requestTypedConfirmation({ fileName: name, reason });
      if (!ok) { t.cancelSend(fileId); return; }
    }
    if (vt?.status === 'flagged') {
      const ok = await ui.requestTypedConfirmation({ fileName: name, reason: `was flagged by ${vt.malicious} VirusTotal engine(s)` });
      if (!ok) { t.cancelSend(fileId); return; }
    }
    t.confirmSend(fileId);
  });

  t.addEventListener('send-progress', ({ detail }) => {
    ui.setTransferProgress(detail.fileId, detail.sentBytes / detail.totalBytes, 'Sending…');
  });
  t.addEventListener('send-complete', ({ detail }) => {
    ui.setTransferProgress(detail.fileId, 1, 'Sent', 'ok');
  });
  t.addEventListener('send-error', ({ detail }) => {
    ui.setTransferProgress(detail.fileId, 0, `Error: ${detail.message}`, 'danger');
  });
  t.addEventListener('send-rejected', ({ detail }) => {
    ui.setTransferProgress(detail.fileId, 0, `Declined by peer${detail.reason ? ': ' + detail.reason : ''}`, 'danger');
  });

  t.addEventListener('incoming-file', async ({ detail }) => {
    const { fileId, name, size, security } = detail;
    const record = ui.upsertTransferItem(fileId, { name, size, direction: 'receive' });
    record.el.remove(); // the accept/reject card replaces the normal row until accepted

    const accepted = await ui.promptIncomingFile({ fileId, name, size, security });
    if (!accepted) { t.rejectIncoming(fileId, 'declined by recipient'); return; }

    // NOTE ON TIMING: acceptIncoming() calls showSaveFilePicker() (Engine A)
    // internally. That must run on the tail of the same user gesture that
    // resolved promptIncomingFile()'s Accept click — don't insert an await
    // before this call, or Chromium will reject it as lacking a user gesture.
    ui.upsertTransferItem(fileId, { name, size, direction: 'receive' });
    ui.setTransferProgress(fileId, 0, 'Choose a save location…');
    try {
      await t.acceptIncoming(detail);
      ui.setTransferProgress(fileId, 0, 'Receiving…');
    } catch (err) {
      ui.setTransferProgress(fileId, 0, `Couldn't start save: ${err.message}`, 'danger');
    }
  });

  t.addEventListener('receive-progress', ({ detail }) => {
    ui.setTransferProgress(detail.fileId, detail.receivedChunks / detail.totalChunks, 'Receiving…');
  });
  t.addEventListener('receive-complete', ({ detail }) => {
    if (detail.blob) triggerBlobDownload(detail.blob, detail.name || 'download');
    const tone = detail.vt?.status === 'flagged' ? 'danger' : 'ok';
    ui.setTransferProgress(
      detail.fileId, 1,
      detail.vt?.status === 'flagged' ? `Saved — but flagged by VirusTotal (${detail.vt.malicious} engines)` : 'Saved',
      tone,
    );
  });
  t.addEventListener('receive-cancelled', ({ detail }) => {
    ui.setTransferProgress(detail.fileId, 0, 'Sender cancelled', 'warn');
  });

  t.addEventListener('throughput', ({ detail }) => ui.updateTelemetry(detail));
}

// ---- room UI wiring ---------------------------------------------------------
ui.els.createRoomBtn.addEventListener('click', async () => {
  const code = randomRoomCode();
  ui.showRoomCode(code);
  ui.setRoomHint('Share this code with the other person. Keep this tab open.');
  await startAsRoom(code, true);
});

ui.els.joinRoomBtn.addEventListener('click', async () => {
  const code = ui.els.roomCodeInput.value.trim().toUpperCase();
  if (!code) return;
  ui.setRoomHint(`Joining ${code}…`);
  await startAsRoom(code, false);
});

ui.els.copyRoomCodeBtn.addEventListener('click', () => {
  navigator.clipboard?.writeText(ui.els.roomCodeValue.textContent);
});

// ---- file selection ----------------------------------------------------------
function handleFiles(fileList) {
  if (!transport) { ui.setRoomHint('Connect to a peer before sending a file.'); return; }
  for (const file of fileList) {
    const handle = transport.sendFile(file);
    ui.upsertTransferItem(handle.fileId, { name: file.name, size: file.size, direction: 'send' });
    ui.setTransferProgress(handle.fileId, 0, 'Checking file…');
  }
}

ui.els.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
ui.els.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); ui.els.dropzone.classList.add('dragover'); });
ui.els.dropzone.addEventListener('dragleave', () => ui.els.dropzone.classList.remove('dragover'));
ui.els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  ui.els.dropzone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});

console.info(`[p2p-hyper-share] signaling backend: ${CONFIG.SIGNALING_BACKEND}`);
