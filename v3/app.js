/**
 * WLED WebInstaller v3 — Flow Orchestration
 *
 * Detects hardware via esptool-js, matches boards from boards.json,
 * flashes firmware directly via esptool-js, and drives the UI.
 */

import { detectHardware, findMatchingBoards, flashFirmware, configureWiFi, resetDevice, ESPLoader, Transport } from './detect.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_LOG_LINES = 4000;

// ---------------------------------------------------------------------------
// Connection event bus — components subscribe to connection status changes
// ---------------------------------------------------------------------------
const ConnectionStatus = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
};

const connectionBus = {
  _listeners: [],
  _status: ConnectionStatus.DISCONNECTED,

  get status() { return this._status; },

  emit(status) {
    this._status = status;
    for (const fn of this._listeners) fn(status);
  },

  on(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(l => l !== fn); };
  },
};

// ---------------------------------------------------------------------------
// Bootloader/partition binary URLs — served from the live site.
// ---------------------------------------------------------------------------
const BIN_BASE = 'https://install.wled.me/bin/';

function binUrl(release, file) {
  return BIN_BASE + release + '/' + file;
}

// CORS proxy used by all WLED GitHub release binaries
const CORS = 'https://proxy.corsfix.com/?';
const GH = 'https://github.com/wled/WLED/releases/download/';

// ---------------------------------------------------------------------------
// Firmware matrix — every version × chip × variant
// ---------------------------------------------------------------------------
const VERSIONS = {
  '0.15.3': {
    name: '0.15.3 (Latest Stable)',
    builds: {
      'ESP32': {
        chipFamily: 'ESP32',
        parts: [
          { path: binUrl('Release/release_0_15_3', 'esp32_bootloader_v4.bin'), offset: 0 },
          { path: `${CORS}${GH}v0.15.3/WLED_0.15.3_ESP32.bin`, offset: 65536 },
        ],
      },
      'ESP32_ETH': {
        chipFamily: 'ESP32',
        parts: [
          { path: binUrl('Release/release_0_15_3', 'esp32_bootloader_v4.bin'), offset: 0 },
          { path: `${CORS}${GH}v0.15.3/WLED_0.15.3_ESP32_Ethernet.bin`, offset: 65536 },
        ],
      },
      'ESP32_WROVER': {
        chipFamily: 'ESP32',
        parts: [
          { path: binUrl('Release/release_0_15_3', 'esp32_bootloader_v4.bin'), offset: 0 },
          { path: `${CORS}${GH}v0.15.3/WLED_0.15.3_ESP32_WROVER.bin`, offset: 65536 },
        ],
      },
      'ESP32-C3': {
        chipFamily: 'ESP32-C3',
        parts: [
          { path: binUrl('Release/release_0_15_3', 'esp32-c3_bootloader_v2.bin'), offset: 0 },
          { path: `${CORS}${GH}v0.15.3/WLED_0.15.3_ESP32-C3.bin`, offset: 65536 },
        ],
      },
      'ESP32-S2': {
        chipFamily: 'ESP32-S2',
        parts: [
          { path: binUrl('Release/release_0_15_3', 'bootloader_s2.bin'), offset: 4096 },
          { path: binUrl('Release/release_0_15_3', 'partitions_s2_4m.bin'), offset: 32768 },
          { path: `${CORS}${GH}v0.15.3/WLED_0.15.3_ESP32-S2.bin`, offset: 65536 },
        ],
      },
      'ESP32-S3_4MB': {
        chipFamily: 'ESP32-S3',
        parts: [
          { path: binUrl('Release/release_0_15_3', 'bootloader_s3.bin'), offset: 0 },
          { path: `${CORS}${GH}v0.15.3/WLED_0.15.3_ESP32-S3_4M_qspi.bin`, offset: 65536 },
        ],
      },
      'ESP32-S3_8MB': {
        chipFamily: 'ESP32-S3',
        parts: [
          { path: binUrl('Release/release_0_15_3', 'bootloader_s3.bin'), offset: 0 },
          { path: binUrl('Release/release_0_15_3', 'partitions_s3_8m.bin'), offset: 32768 },
          { path: `${CORS}${GH}v0.15.3/WLED_0.15.3_ESP32-S3_8MB_opi.bin`, offset: 65536 },
        ],
      },
      'ESP32-S3_16MB': {
        chipFamily: 'ESP32-S3',
        parts: [
          { path: binUrl('Release/release_0_15_3', 'bootloader_s3.bin'), offset: 0 },
          { path: `${CORS}${GH}v0.15.3/WLED_0.15.3_ESP32-S3_16MB_opi.bin`, offset: 65536 },
        ],
      },
      'ESP8266': {
        chipFamily: 'ESP8266',
        parts: [
          { path: `${CORS}${GH}v0.15.3/WLED_0.15.3_ESP8266.bin`, offset: 0 },
        ],
      },
    },
  },
  '16.0.0-alpha': {
    name: '16.0.0 Nightly',
    builds: {
      'ESP32': {
        chipFamily: 'ESP32',
        parts: [
          { path: binUrl('nightly', 'esp32_bootloader_v4.bin'), offset: 0 },
          { path: `${CORS}${GH}nightly/WLED_16.0.0-alpha_ESP32.bin`, offset: 65536 },
        ],
      },
      'ESP32_ETH': {
        chipFamily: 'ESP32',
        parts: [
          { path: binUrl('nightly', 'esp32_bootloader_v4.bin'), offset: 0 },
          { path: `${CORS}${GH}nightly/WLED_16.0.0-alpha_ESP32_Ethernet.bin`, offset: 65536 },
        ],
      },
      'ESP32-C3': {
        chipFamily: 'ESP32-C3',
        parts: [
          { path: binUrl('nightly', 'esp32-c3_bootloader_v2.bin'), offset: 0 },
          { path: binUrl('nightly', 'partitions_c3.bin'), offset: 32768 },
          { path: binUrl('nightly', 'boot_app0_v2022.bin'), offset: 57344 },
          { path: `${CORS}${GH}nightly/WLED_16.0.0-alpha_ESP32-C3.bin`, offset: 65536 },
        ],
      },
      'ESP32-S2': {
        chipFamily: 'ESP32-S2',
        parts: [
          { path: binUrl('nightly', 'bootloader_s2.bin'), offset: 4096 },
          { path: `${CORS}${GH}nightly/WLED_16.0.0-alpha_ESP32-S2.bin`, offset: 65536 },
        ],
      },
      'ESP32-S3_4MB': {
        chipFamily: 'ESP32-S3',
        parts: [
          { path: binUrl('nightly', 'bootloader_s3.bin'), offset: 0 },
          { path: `${CORS}${GH}nightly/WLED_16.0.0-alpha_ESP32-S3_4M_qspi.bin`, offset: 65536 },
        ],
      },
      'ESP8266': {
        chipFamily: 'ESP8266',
        parts: [
          { path: `${CORS}${GH}nightly/WLED_16.0.0-alpha_ESP8266.bin`, offset: 0 },
        ],
      },
    },
  },
};

const DEFAULT_VERSION = '0.15.3';

// ---------------------------------------------------------------------------
// Build selection — pick the right firmware for detected hardware + board
// ---------------------------------------------------------------------------
function selectBuild(version, hardware, board) {
  const builds = VERSIONS[version]?.builds;
  if (!builds) return null;

  const { chipFamily, flashSizeMB, psramSizeMB } = hardware;

  // Ethernet boards get ethernet firmware
  if (board?.features?.includes('ethernet') && builds[chipFamily + '_ETH']) {
    return { key: chipFamily + '_ETH', build: builds[chipFamily + '_ETH'] };
  }

  // ESP32 with PSRAM → WROVER build
  if (chipFamily === 'ESP32' && psramSizeMB > 0 && builds['ESP32_WROVER']) {
    return { key: 'ESP32_WROVER', build: builds['ESP32_WROVER'] };
  }

  // ESP32-S3: pick by flash size
  if (chipFamily === 'ESP32-S3') {
    if (flashSizeMB >= 16 && builds['ESP32-S3_16MB']) {
      return { key: 'ESP32-S3_16MB', build: builds['ESP32-S3_16MB'] };
    }
    if (flashSizeMB >= 8 && builds['ESP32-S3_8MB']) {
      return { key: 'ESP32-S3_8MB', build: builds['ESP32-S3_8MB'] };
    }
    if (builds['ESP32-S3_4MB']) {
      return { key: 'ESP32-S3_4MB', build: builds['ESP32-S3_4MB'] };
    }
  }

  // Default: chip family build
  if (builds[chipFamily]) {
    return { key: chipFamily, build: builds[chipFamily] };
  }

  // Fallback: find any build matching chipFamily
  for (const [key, build] of Object.entries(builds)) {
    if (build.chipFamily === chipFamily) {
      return { key, build };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Build label for display
// ---------------------------------------------------------------------------
const FEATURE_LABELS = {
  'ethernet': 'Ethernet',
  'usb-c-pd': 'USB-C PD',
  'built-in-fuses': 'Built-in fuses',
  'microphone': 'Microphone',
  'current-sensor': 'Current sensor',
  'external-power': 'External power',
};

const BUILD_LABELS = {
  'ESP32': 'ESP32',
  'ESP32_ETH': 'ESP32 Ethernet',
  'ESP32_WROVER': 'ESP32 WROVER (PSRAM)',
  'ESP32-C3': 'ESP32-C3',
  'ESP32-S2': 'ESP32-S2',
  'ESP32-S3_4MB': 'ESP32-S3 (4MB QSPI)',
  'ESP32-S3_8MB': 'ESP32-S3 (8MB OPI)',
  'ESP32-S3_16MB': 'ESP32-S3 (16MB OPI)',
  'ESP8266': 'ESP8266',
};

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
const State = {
  IDLE: 'IDLE',
  DETECTING: 'DETECTING',
  DETECTED: 'DETECTED',
  ERROR: 'ERROR',
};

let state = State.IDLE;
let boards = [];
let detectedHardware = null;
let matchedBoards = [];
let selectedBoard = null;
let selectedVersion = DEFAULT_VERSION;
let detectedPort = null;
let $reconnectBar = null;

// DOM references (set on init)
let $connectBtn, $detectSection, $errorSection, $errorMessage;
let $hwChip, $hwFlash, $hwPsram, $hwMac;
let $matchingBoards, $fwName, $installBtn;
let $versionSelect, $boardSearch, $boardList, $boardFilters;
let $connectSection, $detectLog;
let $flashProgress, $flashProgressBar, $flashProgressText, $eraseCheckbox;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/** Stop logs and return the port, or show reconnect bar and return null. */
async function acquirePort() {
  if (logsReader) await stopLogs();
  if (detectedPort) return detectedPort;
  connectionBus.emit(ConnectionStatus.DISCONNECTED);
  return null;
}

function setState(newState) {
  state = newState;

  $connectSection.hidden = (state !== State.IDLE && state !== State.DETECTING);
  $detectSection.hidden = (state !== State.DETECTED);
  $errorSection.hidden = (state !== State.ERROR);

  $connectBtn.disabled = (state === State.DETECTING);
  $connectBtn.textContent = state === State.DETECTING ? 'Detecting...' : 'Connect';
  $detectLog.hidden = (state !== State.DETECTING);

  if (state === State.IDLE) {
    $detectLog.textContent = '';
  }

}

function renderHardwareInfo(hw) {
  $hwChip.textContent = hw.chipDescription || hw.chipFamily;
  $hwFlash.textContent = hw.flashSizeMB !== null ? `${hw.flashSizeMB} MB flash` : 'Flash unknown';
  $hwPsram.textContent = hw.psramSizeMB !== null && hw.psramSizeMB > 0 ? `${hw.psramSizeMB} MB PSRAM` : 'No PSRAM';
  $hwMac.textContent = hw.mac || '';
}

function renderMatchingBoards(matched) {
  $matchingBoards.innerHTML = '';

  if (matched.length === 0) return;

  // Use the top-ranked branded board for firmware selection (ethernet, etc.)
  selectedBoard = matched[0];

  const label = document.createElement('span');
  label.textContent = matched.length === 1 ? 'Possible match: ' : 'Possible matches: ';
  $matchingBoards.appendChild(label);

  matched.forEach((board, i) => {
    if (i > 0) $matchingBoards.appendChild(document.createTextNode(', '));
    const link = document.createElement('a');
    link.href = board.link;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = board.name;
    $matchingBoards.appendChild(link);
  });
}

function updateFirmwareSelection() {
  const result = selectBuild(selectedVersion, detectedHardware, selectedBoard);
  if (!result) {
    $fwName.textContent = `No firmware available for ${detectedHardware?.chipFamily || 'this chip'}`;
    $installBtn.style.display = 'none';
    return;
  }

  const label = BUILD_LABELS[result.key] || result.key;
  const versionName = VERSIONS[selectedVersion]?.name || selectedVersion;
  $fwName.textContent = `WLED ${versionName} — ${label}`;
  $installBtn.style.display = '';
}

// ---------------------------------------------------------------------------
// Board database rendering
// ---------------------------------------------------------------------------
let activeChipFilter = 'all';

function renderBoardDatabase(filter, search) {
  let filtered = boards;

  if (filter && filter !== 'all') {
    filtered = filtered.filter(b => b.chip === filter);
  }

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(b =>
      b.name.toLowerCase().includes(q) ||
      b.manufacturer.toLowerCase().includes(q) ||
      b.description.toLowerCase().includes(q) ||
      b.chip.toLowerCase().includes(q)
    );
  }

  // Separate branded from generic
  const branded = filtered.filter(b => !b.id.startsWith('generic-'));
  const generic = filtered.filter(b => b.id.startsWith('generic-'));

  $boardList.innerHTML = '';

  if (branded.length === 0 && generic.length === 0) {
    $boardList.innerHTML = '<p class="no-match">No boards match your search.</p>';
    return;
  }

  const renderGroup = (items, label) => {
    if (items.length === 0) return;
    if (label) {
      const h = document.createElement('h3');
      h.className = 'board-group-label';
      h.textContent = label;
      $boardList.appendChild(h);
    }
    const grid = document.createElement('div');
    grid.className = 'board-grid';
    items.forEach(board => {
      const card = document.createElement('a');
      card.className = 'board-card';
      card.href = board.link;
      card.target = '_blank';
      card.rel = 'noopener';

      const header = document.createElement('div');
      header.className = 'board-card-header';
      const name = document.createElement('strong');
      name.textContent = board.name;
      const badge = document.createElement('span');
      badge.className = 'chip-badge';
      badge.textContent = board.chip;
      header.appendChild(name);
      header.appendChild(badge);

      const desc = document.createElement('p');
      desc.className = 'board-card-desc';
      desc.textContent = board.description;

      const specs = document.createElement('div');
      specs.className = 'board-card-specs';
      const addSpec = (text) => {
        const s = document.createElement('span');
        s.textContent = text;
        specs.appendChild(s);
      };
      if (board.flashMB) addSpec(`Flash: ${board.flashMB}MB`);
      if (board.psramMB) addSpec(`PSRAM: ${board.psramMB}MB`);
      if (board.outputs) addSpec(`Outputs: ${board.outputs}`);
      if (board.voltage) addSpec(board.voltage);
      if (board.maxAmps) addSpec(`${board.maxAmps}A max`);

      // Feature tags (skip wifi — all boards have it)
      for (const feat of board.features) {
        if (feat === 'wifi') continue;
        addSpec(FEATURE_LABELS[feat] || feat);
      }

      const mfr = document.createElement('span');
      mfr.className = 'board-card-mfr';
      try {
        const host = new URL(board.link).hostname.replace(/^www\./, '');
        mfr.textContent = `${board.manufacturer} · ${host}`;
      } catch (_) {
        mfr.textContent = board.manufacturer;
      }

      card.appendChild(header);
      card.appendChild(desc);
      card.appendChild(specs);
      card.appendChild(mfr);
      grid.appendChild(card);
    });
    $boardList.appendChild(grid);
  };

  renderGroup(branded, branded.length > 0 && generic.length > 0 ? 'WLED-Ready Boards' : null);
  renderGroup(generic, 'Generic Development Boards');
}

// ---------------------------------------------------------------------------
// Version selector
// ---------------------------------------------------------------------------
function populateVersionSelector() {
  $versionSelect.innerHTML = '';
  for (const [key, ver] of Object.entries(VERSIONS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = ver.name;
    if (key === DEFAULT_VERSION) opt.selected = true;
    $versionSelect.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// Detection flow
// ---------------------------------------------------------------------------
async function onConnect() {
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (e) {
    // User cancelled the port picker
    return;
  }

  setState(State.DETECTING);
  connectionBus.emit(ConnectionStatus.CONNECTING);

  try {
    detectedHardware = await detectHardware(port, (msg) => {
      $detectLog.textContent += msg + '\n';
      $detectLog.scrollTop = $detectLog.scrollHeight;
    });

    // Store port reference for reuse (install/erase without second picker)
    detectedPort = port;

    connectionBus.emit(ConnectionStatus.CONNECTED);

    matchedBoards = findMatchingBoards(boards, detectedHardware);
    renderHardwareInfo(detectedHardware);
    renderMatchingBoards(matchedBoards);
    updateFirmwareSelection();
    setState(State.DETECTED);
  } catch (e) {
    console.error('Detection failed:', e);
    connectionBus.emit(ConnectionStatus.DISCONNECTED);
    $errorMessage.textContent = e.message || 'Failed to communicate with device. Check connection and try again.';
    setState(State.ERROR);
  }
}

// ---------------------------------------------------------------------------
// Erase flash
// ---------------------------------------------------------------------------
async function onErase() {
  if (!confirm('This will erase all data on the device. Continue?')) return;

  const port = await acquirePort();
  if (!port) return;

  if (port.readable) {
    try { await port.close(); } catch (_) {}
  }

  const transport = new Transport(port, true);
  const esploader = new ESPLoader({
    transport,
    baudrate: 115200,
    romBaudrate: 115200,
    terminal: { clean() {}, writeLine() {}, write() {} },
  });

  try {
    await esploader.main();
    await esploader.eraseFlash();
    alert('Flash erased successfully. The device will restart.');
  } catch (e) {
    alert('Erase failed: ' + (e.message || e));
  } finally {
    try { await esploader.hardReset(); } catch (_) {}
    try { await transport.disconnect(); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Install firmware
// ---------------------------------------------------------------------------
async function onInstall() {
  const port = await acquirePort();
  if (!port) return;

  const result = selectBuild(selectedVersion, detectedHardware, selectedBoard);
  if (!result) {
    alert('No firmware available for this chip.');
    return;
  }

  const eraseFirst = $eraseCheckbox.checked;

  // Disable buttons during flash
  $installBtn.disabled = true;
  document.getElementById('erase-btn').disabled = true;
  $flashProgress.hidden = false;
  $flashProgressBar.className = 'progress-bar indeterminate';
  $flashProgressBar.style.width = '100%';
  $flashProgressText.textContent = 'Preparing...';

  try {
    await flashFirmware(port, result.build.parts, {
      eraseFirst,
      onProgress: (state, pct, message) => {
        $flashProgressText.textContent = message;
        if (pct >= 0) {
          $flashProgressBar.className = 'progress-bar';
          $flashProgressBar.style.width = pct + '%';
        } else {
          $flashProgressBar.className = 'progress-bar indeterminate';
          $flashProgressBar.style.width = '100%';
        }
        if (state === 'done') {
          $flashProgressBar.classList.add('success');
          // Auto-open WiFi setup after successful install
          const $cfg = document.getElementById('section-configure');
          if ($cfg && !$cfg.open) {
            $cfg.open = true;
            $cfg.classList.add('highlight-open');
            $cfg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            setTimeout(() => $cfg.classList.remove('highlight-open'), 2500);
          }
        }
      },
      onLog: () => {},
    });
  } catch (e) {
    console.error('Flash failed:', e);
    $flashProgressBar.className = 'progress-bar error';
    $flashProgressBar.style.width = '100%';
    $flashProgressText.textContent = `Installation failed: ${e.message || e}`;
  } finally {
    $installBtn.disabled = false;
    document.getElementById('erase-btn').disabled = false;
  }
}


// ---------------------------------------------------------------------------
// Serial logs (reuses detectedPort)
// ---------------------------------------------------------------------------
let logsReader = null;

function setLogsStatus(text, active) {
  const $status = document.getElementById('logs-status');
  const $text = document.getElementById('logs-status-text');
  if (!$status) return;
  $status.hidden = false;
  $text.textContent = text;
  $status.classList.toggle('stopped', !active);
}

function hideLogsStatus() {
  const $status = document.getElementById('logs-status');
  if ($status) $status.hidden = true;
}

async function startLogs() {
  const $output = document.getElementById('serial-output');
  if (logsReader) return;

  const port = detectedPort;
  if (!port) {
    $output.textContent = 'No device connected. Go back and connect first.';
    hideLogsStatus();
    return;
  }

  if (!port.readable) {
    try { await port.open({ baudRate: 115200 }); } catch (e) {
      $output.textContent = 'Failed to open port: ' + e.message;
      hideLogsStatus();
      return;
    }
  }

  setLogsStatus('Connected, waiting for logs...', true);
  $output.textContent = '';
  logsReader = port.readable.getReader();
  const decoder = new TextDecoder();
  let receivedData = false;

  try {
    while (true) {
      const { value, done } = await logsReader.read();
      if (done) break;
      if (!receivedData) {
        receivedData = true;
        setLogsStatus('Receiving logs', true);
        const $hint = document.getElementById('logs-hint');
        if ($hint) $hint.hidden = true;
      }
      $output.textContent += decoder.decode(value, { stream: true });
      const lines = $output.textContent.split('\n');
      if (lines.length > MAX_LOG_LINES) {
        $output.textContent = lines.slice(-MAX_LOG_LINES).join('\n');
      }
      $output.scrollTop = $output.scrollHeight;
    }
  } catch (_) {}
  logsReader = null;
  setLogsStatus('Logging stopped', false);
}

async function stopLogs() {
  if (!logsReader) return;
  try { await logsReader.cancel(); } catch (_) {}
  logsReader = null;
  try { await detectedPort?.close(); } catch (_) {}
  setLogsStatus('Logging stopped', false);
}

// ---------------------------------------------------------------------------
// Configure WiFi
// ---------------------------------------------------------------------------
async function onWiFiSave() {
  const ssid = document.getElementById('wifi-ssid').value.trim();
  if (!ssid) { alert('Please enter a WiFi network name.'); return; }

  const port = await acquirePort();
  if (!port) return;

  const password = document.getElementById('wifi-password').value;
  const $status = document.getElementById('wifi-status');
  const $visitDevice = document.getElementById('visit-device');
  const $visitLink = document.getElementById('visit-device-link');
  const $saveBtn = document.getElementById('wifi-save-btn');

  $saveBtn.disabled = true;
  $status.hidden = false;
  $status.className = 'wifi-status';
  $status.textContent = 'Preparing...';
  $visitDevice.hidden = true;

  try {
    const url = await configureWiFi(port, ssid, password, {
      onStatus: (state, message) => {
        $status.textContent = message;
        if (state === 'done') {
          $status.classList.add('status-success');
        }
      },
    });
    if (url) {
      $visitLink.href = url.startsWith('http') ? url : 'http://' + url;
      $visitDevice.hidden = false;
    }
  } catch (e) {
    $status.textContent = e.message || 'WiFi configuration failed.';
    $status.classList.add('status-error');
  } finally {
    $saveBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Reset device
// ---------------------------------------------------------------------------
async function onResetDevice() {
  if (!detectedPort) return;

  // If logs are streaming, reset via signals without closing
  if (logsReader && detectedPort.writable) {
    try {
      await detectedPort.setSignals({ dataTerminalReady: false, requestToSend: true });
      await new Promise(r => setTimeout(r, 100));
      await detectedPort.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch (e) {
      console.error('Reset failed:', e);
    }
    return;
  }

  try {
    await resetDevice(detectedPort);
  } catch (e) {
    console.error('Reset failed:', e);
  }
  // Restart logs if the logs section is open
  const $sectionLogs = document.getElementById('section-logs');
  if ($sectionLogs && $sectionLogs.open) {
    startLogs();
  }
}

// ---------------------------------------------------------------------------
// Browser support check
// ---------------------------------------------------------------------------
function checkBrowserSupport() {
  const unsupported = document.getElementById('unsupported');
  const installer = document.getElementById('installer');

  if (!('serial' in navigator)) {
    unsupported.hidden = false;
    installer.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  // Cache DOM refs
  $connectBtn = document.getElementById('connect-btn');
  $connectSection = document.getElementById('connect-section');
  $detectSection = document.getElementById('detect-section');
  $errorSection = document.getElementById('error-section');
  $errorMessage = document.getElementById('error-message');
  $hwChip = document.getElementById('hw-chip');
  $hwFlash = document.getElementById('hw-flash');
  $hwPsram = document.getElementById('hw-psram');
  $hwMac = document.getElementById('hw-mac');
  $matchingBoards = document.getElementById('matching-boards');
  $fwName = document.getElementById('fw-name');
  $installBtn = document.getElementById('install-btn');
  $versionSelect = document.getElementById('version-select');
  $boardSearch = document.getElementById('board-search');
  $boardList = document.getElementById('board-list');
  $boardFilters = document.getElementById('board-filters');
  $detectLog = document.getElementById('detect-log');
  $flashProgress = document.getElementById('flash-progress');
  $flashProgressBar = document.getElementById('flash-progress-bar');
  $flashProgressText = document.getElementById('flash-progress-text');
  $eraseCheckbox = document.getElementById('erase-checkbox');
  // Load board database
  try {
    const resp = await fetch('boards.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    boards = await resp.json();
  } catch (e) {
    console.error('Failed to load boards.json:', e);
    boards = [];
  }

  // Populate UI
  populateVersionSelector();
  renderBoardDatabase('all', '');
  checkBrowserSupport();

  // Event listeners
  $connectBtn.addEventListener('click', onConnect);

  document.getElementById('retry-btn').addEventListener('click', () => {
    setState(State.IDLE);
  });

  $installBtn.addEventListener('click', onInstall);
  document.getElementById('erase-btn').addEventListener('click', onErase);

  // Section toggle handlers (WiFi + Logs collapsibles)
  const $sectionLogs = document.getElementById('section-logs');
  const $sectionConfigure = document.getElementById('section-configure');

  $sectionLogs.addEventListener('toggle', () => {
    if ($sectionLogs.open) {
      startLogs();
    } else {
      stopLogs();
    }
  });

  $sectionConfigure.addEventListener('toggle', () => {
    if ($sectionConfigure.open && logsReader) {
      stopLogs();
    }
  });

  // Configure
  document.querySelector('.wifi-form').addEventListener('submit', (e) => {
    e.preventDefault();
    onWiFiSave();
  });

  // Logs pane
  document.getElementById('reset-device-btn').addEventListener('click', onResetDevice);
  document.getElementById('clear-logs-btn').addEventListener('click', () => {
    document.getElementById('serial-output').textContent = '';
  });
  document.getElementById('copy-logs-btn').addEventListener('click', () => {
    const text = document.getElementById('serial-output').textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('copy-logs-btn');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  });
  document.getElementById('stop-logs-btn').addEventListener('click', stopLogs);

  $versionSelect.addEventListener('change', () => {
    selectedVersion = $versionSelect.value;
    if (state === State.DETECTED) {
      updateFirmwareSelection();
    }
  });

  // Board search + filters (debounced to avoid DOM churn on every keystroke)
  let searchTimer;
  $boardSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderBoardDatabase(activeChipFilter, $boardSearch.value), 150);
  });

  $boardFilters.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    activeChipFilter = btn.dataset.chip;
    $boardFilters.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderBoardDatabase(activeChipFilter, $boardSearch.value);
  });

  // Connection status bus — update UI on status changes
  const $ciBadge = document.querySelector('.ci-badge');
  const $ciLabel = $ciBadge?.querySelector('span:last-child');

  $reconnectBar = document.getElementById('reconnect-bar');
  document.getElementById('reconnect-btn').addEventListener('click', onConnect);

  connectionBus.on((status) => {
    if ($ciBadge) {
      $ciBadge.classList.toggle('disconnected', status === ConnectionStatus.DISCONNECTED);
      if ($ciLabel) $ciLabel.textContent = status === ConnectionStatus.CONNECTED ? 'Connected' : 'Disconnected';
    }
    if ($reconnectBar) {
      $reconnectBar.hidden = status !== ConnectionStatus.DISCONNECTED;
    }
  });

  // Detect USB disconnects via Web Serial API
  navigator.serial.addEventListener('disconnect', (e) => {
    if (detectedPort && e.target === detectedPort) {
      // In DETECTED state, ignore disconnects — post-detection hard reset
      // on native USB chips (S2/S3/C3) briefly drops USB. The port
      // remains valid once the device finishes rebooting. If the device is
      // truly gone, operations will fail and show the reconnect bar.
      if (state === State.DETECTED) return;

      connectionBus.emit(ConnectionStatus.DISCONNECTED);
      logsReader = null;
      detectedPort = null;
      detectedHardware = null;
      setLogsStatus('Device disconnected', false);
    }
  });

  setState(State.IDLE);
}

document.addEventListener('DOMContentLoaded', init);
