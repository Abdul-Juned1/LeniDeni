import { CONFIG } from './config.js';

const $ = (id) => document.getElementById(id);

export const els = {
  linkStatus: $('linkStatus'), linkStatusText: $('linkStatusText'),
  createRoomBtn: $('createRoomBtn'), joinRoomBtn: $('joinRoomBtn'), roomCodeInput: $('roomCodeInput'),
  roomCodeDisplay: $('roomCodeDisplay'), roomCodeValue: $('roomCodeValue'), copyRoomCodeBtn: $('copyRoomCodeBtn'),
  roomHint: $('roomHint'),
  pathDiagram: $('pathDiagram'), candidateTag: $('candidateTag'), nodeRelay: $('nodeRelay'), pathLineB: $('pathLineB'),
  throughputValue: $('throughputValue'), candidateValue: $('candidateValue'),
  chunkSizeValue: $('chunkSizeValue'), bufferedValue: $('bufferedValue'),
  sparklinePoly: $('sparklinePoly'),
  dropzone: $('dropzone'), fileInput: $('fileInput'), saveEngineNote: $('saveEngineNote'),
  transferList: $('transferList'),
  usageRows: $('usageRows'),
  confirmModal: $('confirmModal'), confirmTitle: $('confirmTitle'), confirmBody: $('confirmBody'),
  confirmWord: $('confirmWord'), confirmInput: $('confirmInput'),
  confirmCancel: $('confirmCancel'), confirmProceed: $('confirmProceed'),
};

export function setLinkStatus(state, text) {
  els.linkStatus.dataset.state = state;
  els.linkStatusText.textContent = text;
}

export function showRoomCode(code) {
  els.roomCodeValue.textContent = code;
  els.roomCodeDisplay.hidden = false;
}

export function setRoomHint(text) {
  els.roomHint.textContent = text;
}

export function setSaveEngineNote(engine) {
  els.saveEngineNote.textContent = engine === 'A'
    ? 'Engine A: saving straight to disk (File System Access API) — resumable, no size limit.'
    : 'Engine B: this browser lacks the File System Access API, using IndexedDB + download link instead.';
}

const spark = { points: [], max: 60 };
export function updateTelemetry({ sentMBs, receivedMBs, bufferedAmount, chunkSizeKB }) {
  const active = Math.max(sentMBs, receivedMBs);
  els.throughputValue.textContent = active.toFixed(1);
  els.chunkSizeValue.textContent = Math.round(chunkSizeKB);
  els.bufferedValue.textContent = Math.round(bufferedAmount / 1024);

  spark.points.push(active);
  if (spark.points.length > spark.max) spark.points.shift();
  const peak = Math.max(1, ...spark.points);
  const pts = spark.points.map((v, i) => {
    const x = (i / (spark.max - 1)) * 300;
    const y = 58 - (v / peak) * 54;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  els.sparklinePoly.setAttribute('points', pts);
}

export function updatePathInfo(info) {
  const isRelay = info.localType === 'relay' || info.remoteType === 'relay';
  els.pathDiagram.dataset.state = isRelay ? 'relay' : 'direct';
  els.nodeRelay.hidden = !isRelay;
  els.pathLineB.hidden = !isRelay;
  els.candidateTag.textContent = `${info.localType}/${info.remoteType}`;
  els.candidateValue.textContent = isRelay ? 'relay (TURN)' : info.localType;
  setLinkStatus(isRelay ? 'relay' : 'connected', isRelay ? 'Connected via TURN relay' : 'Connected directly');
}

// ---- transfer list ---------------------------------------------------------
const items = new Map();
export function upsertTransferItem(fileId, { name, size, direction }) {
  if (items.has(fileId)) return items.get(fileId);
  const li = document.createElement('li');
  li.className = 'transfer-item';
  li.innerHTML = `
    <div class="transfer-item-head">
      <span class="transfer-name">${direction === 'send' ? '↑' : '↓'} ${name}</span>
      <span class="transfer-meta">${(size / (1024 * 1024)).toFixed(1)} MB</span>
    </div>
    <div class="transfer-bar"><div class="transfer-bar-fill"></div></div>
    <div class="transfer-status">Waiting…</div>
  `;
  els.transferList.prepend(li);
  const record = {
    el: li,
    fill: li.querySelector('.transfer-bar-fill'),
    status: li.querySelector('.transfer-status'),
  };
  items.set(fileId, record);
  return record;
}
export function setTransferProgress(fileId, fraction, statusText, tone = '') {
  const item = items.get(fileId);
  if (!item) return;
  item.fill.style.width = `${Math.min(100, fraction * 100).toFixed(1)}%`;
  item.status.textContent = statusText;
  if (tone) item.status.dataset.tone = tone; else delete item.status.dataset.tone;
}

// ---- usage gauges -----------------------------------------------------------
export function renderUsage(snapshot) {
  els.usageRows.innerHTML = '';
  const rows = [
    ['Signaling messages', snapshot.messages.used, snapshot.messages.ceiling, ''],
    ['Peak concurrent links', snapshot.concurrent.used, snapshot.concurrent.ceiling, ''],
    ['TURN relay', snapshot.turnGB.used.toFixed(3), snapshot.turnGB.ceiling, ' GB'],
  ];
  for (const [label, used, ceiling, unit] of rows) {
    const ratio = Number(used) / ceiling;
    const tone = ratio > 0.8 ? 'danger' : ratio > 0.5 ? 'warn' : '';
    const row = document.createElement('div');
    row.className = 'usage-row';
    row.innerHTML = `
      <span class="usage-row-label">${label}</span>
      <span class="usage-row-bar"><span class="usage-row-bar-fill" data-tone="${tone}" style="width:${Math.min(100, ratio * 100)}%"></span></span>
      <span>${used}${unit}/${ceiling}${unit}</span>
    `;
    els.usageRows.appendChild(row);
  }
}

export function promptIncomingFile({ fileId, name, size, security }) {
  return new Promise((resolve) => {
    const li = document.createElement('li');
    li.className = 'transfer-item';
    const mismatchNote = security.sniff?.mismatch
      ? `<div class="transfer-status" data-tone="warn">Content looks like ${security.sniff.detected}, not .${security.sniff.declaredExt}</div>` : '';
    const vtNote = security.vt?.status === 'flagged'
      ? `<div class="transfer-status" data-tone="danger">VirusTotal: ${security.vt.malicious} engine(s) flagged this hash</div>`
      : security.vt?.status === 'clean'
        ? `<div class="transfer-status" data-tone="ok">VirusTotal: clean across ${security.vt.total} engines</div>`
        : `<div class="transfer-status">VirusTotal: ${security.vt?.detail || 'not checked'}</div>`;
    li.innerHTML = `
      <div class="transfer-item-head">
        <span class="transfer-name">↓ ${name}</span>
        <span class="transfer-meta">${(size / (1024 * 1024)).toFixed(1)} MB</span>
      </div>
      ${mismatchNote}${vtNote}
      <div class="modal-actions" style="margin-top:10px;">
        <button class="btn btn-ghost" data-action="reject">Decline</button>
        <button class="btn btn-primary" data-action="accept">Accept &amp; choose where to save</button>
      </div>
    `;
    els.transferList.prepend(li);

    li.querySelector('[data-action="reject"]').addEventListener('click', () => {
      li.remove();
      resolve(false);
    });
    li.querySelector('[data-action="accept"]').addEventListener('click', async () => {
      li.remove();
      resolve(true);
    });
  });
}

// ---- typed confirmation modal -----------------------------------------------
export function requestTypedConfirmation({ fileName, reason }) {
  return new Promise((resolve) => {
    const word = CONFIG.SECURITY.CONFIRM_WORD;
    els.confirmBody.textContent = `"${fileName}" ${reason}. This kind of file can execute code on whoever opens it.`;
    els.confirmWord.textContent = word;
    els.confirmInput.value = '';
    els.confirmProceed.disabled = true;
    els.confirmModal.hidden = false;
    els.confirmInput.focus();

    const onInput = () => { els.confirmProceed.disabled = els.confirmInput.value.trim() !== word; };
    const cleanup = () => {
      els.confirmModal.hidden = true;
      els.confirmInput.removeEventListener('input', onInput);
      els.confirmProceed.removeEventListener('click', onProceed);
      els.confirmCancel.removeEventListener('click', onCancel);
    };
    const onProceed = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };

    els.confirmInput.addEventListener('input', onInput);
    els.confirmProceed.addEventListener('click', onProceed);
    els.confirmCancel.addEventListener('click', onCancel);
  });
}
