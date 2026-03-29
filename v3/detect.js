/**
 * WLED WebInstaller v3 — Hardware Detection
 *
 * Ported from esp-web-tools PR #690 (src/util/build-match.ts, src/diagnostics-dialog.ts).
 * Original code copyright Home Assistant, licensed under Apache 2.0.
 * See NOTICES file in repository root.
 */

import { ESPLoader, Transport } from 'https://cdn.jsdelivr.net/npm/esptool-js@0.5.7/+esm';
export { ESPLoader, Transport };

// Map chip names that differ from esp-web-tools chipFamily values.
// Identity mappings (ESP32 → ESP32, etc.) are handled by the fallback.
const CHIP_FAMILY_MAP = {
  'ESP8266EX': 'ESP8266',
  'ESP8685': 'ESP32-C3',
};


/**
 * Parse PSRAM size from chip feature strings.
 * Feature strings may contain entries like "Embedded PSRAM 2MB" or "Embedded Flash 8MB".
 */
export function parsePsramSizeFromFeatures(features) {
  if (!features) return null;
  for (const feature of features) {
    const match = feature.match(/(?:Embedded\s+)?PSRAM\s+(\d+)\s*MB/i);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Detect hardware by connecting to an ESP device via Web Serial.
 *
 * @param {SerialPort} port - Web Serial port (will be closed/reopened by ESPLoader)
 * @param {function} [onLog] - Optional log callback
 * @returns {Promise<{chipFamily, chipName, chipDescription, flashSizeMB, psramSizeMB, mac, features}>}
 */
export async function detectHardware(port, onLog) {
  const log = onLog || (() => {});

  // ESPLoader needs to open the port itself — close it if open
  if (port.readable) {
    try { await port.close(); } catch (_) { /* already closing */ }
  }

  const transport = new Transport(port, true);
  const esploader = new ESPLoader({
    transport,
    baudrate: 115200,
    romBaudrate: 115200,
    terminal: {
      clean() {},
      writeLine(data) { log(data); },
      write(data) {},
    },
  });

  try {
    log('Connecting...');
    await esploader.main();
    const chipName = esploader.chip.CHIP_NAME;
    log(`Chip: ${chipName}`);

    const chipFamily = CHIP_FAMILY_MAP[chipName] || chipName;

    // Flash size detection — getFlashSize() returns KB
    let flashSizeMB = null;
    try {
      const flashKB = await esploader.getFlashSize();
      flashSizeMB = flashKB / 1024;
    } catch (_) {
      // flash size unavailable on some chips
    }
    log(`Flash: ${flashSizeMB !== null ? flashSizeMB + 'MB' : 'unknown'}`);

    // Chip features and PSRAM detection
    let features = [];
    let chipDescription = chipName;
    try {
      features = await esploader.chip.getChipFeatures(esploader);
    } catch (_) {}
    try {
      chipDescription = await esploader.chip.getChipDescription(esploader);
    } catch (_) {}

    const psramSizeMB = parsePsramSizeFromFeatures(features);
    log(`PSRAM: ${psramSizeMB !== null ? psramSizeMB + 'MB' : 'none detected'}`);

    // MAC address
    let mac = '';
    try {
      const macArr = await esploader.chip.readMac(esploader);
      if (Array.isArray(macArr)) {
        mac = macArr.map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
      } else if (typeof macArr === 'string') {
        mac = macArr.toUpperCase();
      }
    } catch (_) {}
    log(`MAC: ${mac || 'unknown'}`);

    return {
      chipFamily,
      chipName,
      chipDescription,
      flashSizeMB,
      psramSizeMB,
      mac,
      features,
    };
  } finally {
    try { await esploader.hardReset(); } catch (_) {}
    try { await transport.disconnect(); } catch (_) {}
  }
}

/**
 * Find boards that match the detected hardware.
 * Returns boards sorted by match quality: branded boards first, generics last.
 *
 * @param {Array} boards - Array of board objects from boards.json
 * @param {Object} hardware - Detected hardware from detectHardware()
 * @returns {Array} Sorted array of matching board objects
 */
/**
 * Flash firmware to a connected ESP device via esptool-js.
 *
 * @param {SerialPort} port - Web Serial port (same one used for detection)
 * @param {Array<{path: string, offset: number}>} parts - Firmware parts to flash
 * @param {Object} [opts]
 * @param {boolean} [opts.eraseFirst] - Erase flash before writing
 * @param {function(string)} [opts.onProgress] - Progress callback: state, percent, message
 * @param {function(string)} [opts.onLog] - Log callback
 * @returns {Promise<void>}
 */
export async function flashFirmware(port, parts, { eraseFirst = false, onProgress, onLog } = {}) {
  const log = onLog || (() => {});
  const progress = onProgress || (() => {});

  // Close port if open — ESPLoader needs to open it itself
  if (port.readable) {
    try { await port.close(); } catch (_) {}
  }

  const transport = new Transport(port, true);
  const esploader = new ESPLoader({
    transport,
    baudrate: 115200,
    romBaudrate: 115200,
    terminal: {
      clean() {},
      writeLine(data) { log(data); },
      write(data) {},
    },
  });

  try {
    // Connect
    progress('connecting', -1, 'Connecting to device...');
    log('Connecting...');
    await esploader.main();
    log(`Connected: ${esploader.chip.CHIP_NAME}`);

    // Download all parts in parallel
    progress('downloading', -1, `Downloading firmware (${parts.length} files)...`);
    log(`Downloading ${parts.length} firmware files...`);

    const fileArray = await Promise.all(parts.map(async (part) => {
      const resp = await fetch(part.path);
      if (!resp.ok) throw new Error(`Failed to download ${part.path}: HTTP ${resp.status}`);
      const blob = await resp.blob();
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read firmware file'));
        reader.readAsBinaryString(blob);
      });
      return { data, address: part.offset };
    }));
    log('Download complete.');

    // Erase if requested
    if (eraseFirst) {
      progress('erasing', -1, 'Erasing flash...');
      log('Erasing flash...');
      await esploader.eraseFlash();
      log('Erase complete.');
    }

    // Calculate total uncompressed size for progress tracking
    const totalSize = fileArray.reduce((sum, f) => sum + f.data.length, 0);
    let totalWritten = 0;
    let currentFileBaseWritten = 0;

    // Write flash
    progress('writing', 0, 'Installing... 0%');
    log('Writing firmware...');

    await esploader.writeFlash({
      fileArray,
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        // written/total are for the current file
        // Calculate cumulative progress across all files
        const prevFilesSize = fileArray
          .slice(0, fileIndex)
          .reduce((sum, f) => sum + f.data.length, 0);
        const overallWritten = prevFilesSize + (written / total) * fileArray[fileIndex].data.length;
        const pct = Math.min(Math.round((overallWritten / totalSize) * 100), 100);
        progress('writing', pct, `Installing... ${pct}%`);
      },
    });

    log('Write complete.');

    // Done
    progress('done', 100, 'Done! Device is restarting.');
    log('Resetting device...');
  } finally {
    // Hard reset and disconnect
    try {
      await transport.device.setSignals({ dataTerminalReady: false, requestToSend: true });
      await new Promise(r => setTimeout(r, 100));
      await transport.device.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch (_) {}
    try { await transport.disconnect(); } catch (_) {}
  }
}

/**
 * Find boards that match the detected hardware.
 * Returns boards sorted by match quality: branded boards first, generics last.
 *
 * @param {Array} boards - Array of board objects from boards.json
 * @param {Object} hardware - Detected hardware from detectHardware()
 * @returns {Array} Sorted array of matching board objects
 */
// ---------------------------------------------------------------------------
// Improv WiFi Serial Protocol
// ---------------------------------------------------------------------------
const IMPROV = [0x49, 0x4D, 0x50, 0x52, 0x4F, 0x56]; // "IMPROV"

function buildImprovPacket(type, data) {
  const pkt = [...IMPROV, 0x01, type, data.length, ...data];
  let sum = 0;
  for (let i = 6; i < pkt.length; i++) sum = (sum + pkt[i]) & 0xFF;
  pkt.push(sum);
  return new Uint8Array(pkt);
}

function tryParseImprov(buf) {
  while (buf.length >= 9) {
    if (buf[0] === 0x49 && buf[1] === 0x4D && buf[2] === 0x50 &&
        buf[3] === 0x52 && buf[4] === 0x4F && buf[5] === 0x56) break;
    buf.shift();
  }
  if (buf.length < 9) return null;
  const len = buf[8];
  const total = 10 + len;
  if (buf.length < total) return null;
  let sum = 0;
  for (let i = 6; i < total - 1; i++) sum = (sum + buf[i]) & 0xFF;
  if (sum !== buf[total - 1]) { buf.shift(); return null; }
  const type = buf[7];
  const data = buf.slice(9, 9 + len);
  buf.splice(0, total);
  return { type, data };
}

async function readImprovResponse(reader, buf, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pkt = tryParseImprov(buf);
    if (pkt) return pkt;
    const remaining = Math.max(deadline - Date.now(), 1);
    const result = await Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), remaining)),
    ]);
    if (result.done) throw new Error('Port closed');
    for (const b of result.value) buf.push(b);
  }
  throw new Error('timeout');
}

function parseImprovStrings(data) {
  const strings = [];
  let i = 0;
  while (i < data.length) {
    const len = data[i++];
    if (i + len > data.length) break;
    strings.push(new TextDecoder().decode(new Uint8Array(data.slice(i, i + len))));
    i += len;
  }
  return strings;
}

/**
 * Configure WiFi on a running WLED device via Improv serial protocol.
 *
 * @param {SerialPort} port
 * @param {string} ssid
 * @param {string} password
 * @param {Object} [opts]
 * @param {function(string, string)} [opts.onStatus] - (state, message) callback
 * @returns {Promise<string|null>} Device URL if returned by the device
 */
export async function configureWiFi(port, ssid, password, { onStatus } = {}) {
  const status = onStatus || (() => {});

  if (port.readable) {
    try { await port.close(); } catch (_) {}
  }
  await port.open({ baudRate: 115200 });

  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  const buf = [];

  try {
    status('waiting', 'Waiting for device...');
    let ready = false;
    for (let i = 0; i < 15 && !ready; i++) {
      try {
        await writer.write(buildImprovPacket(0x03, [0x02, 0]));
        const pkt = await readImprovResponse(reader, buf, 2000);
        if (pkt.type === 0x01 && pkt.data[0] >= 0x02) ready = true;
      } catch (_) {}
    }
    if (!ready) throw new Error('Device not responding. Make sure WLED is installed and running.');

    status('sending', 'Sending WiFi credentials...');
    const enc = new TextEncoder();
    const s = enc.encode(ssid);
    const p = enc.encode(password);
    await writer.write(buildImprovPacket(0x03, [
      0x01, s.length + p.length + 2, s.length, ...s, p.length, ...p,
    ]));

    status('connecting', 'Connecting to WiFi...');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const pkt = await readImprovResponse(reader, buf, 30000);
      if (pkt.type === 0x02 && pkt.data[0] !== 0x00) {
        throw new Error(pkt.data[0] === 0x03
          ? 'Unable to connect. Check SSID and password.'
          : 'WiFi configuration failed.');
      }
      if (pkt.type === 0x04) {
        const urls = parseImprovStrings(pkt.data.slice(1));
        status('done', 'Connected!');
        return urls[0] || null;
      }
    }
    throw new Error('WiFi configuration timed out.');
  } finally {
    try { reader.releaseLock(); } catch (_) {}
    try { writer.releaseLock(); } catch (_) {}
    try { await port.close(); } catch (_) {}
  }
}

/**
 * Reset a device via DTR/RTS signals.
 */
export async function resetDevice(port) {
  if (port.readable) {
    try { await port.close(); } catch (_) {}
  }
  await port.open({ baudRate: 115200 });
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await new Promise(r => setTimeout(r, 100));
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  } finally {
    try { await port.close(); } catch (_) {}
  }
}

export function findMatchingBoards(boards, hardware) {
  const { chipFamily, flashSizeMB, psramSizeMB } = hardware;

  const chipMatches = boards.filter(b => b.chip === chipFamily);
  if (chipMatches.length === 0) return [];

  const scored = [];

  for (const board of chipMatches) {
    let score = 0;
    const isGeneric = board.id.startsWith('generic-');

    // Flash size scoring
    if (board.flashMB !== null && flashSizeMB !== null) {
      if (board.flashMB === flashSizeMB) {
        score += 10;
      } else if (board.flashMB > flashSizeMB) {
        // Board needs more flash than detected — exclude branded, keep generic
        if (!isGeneric) continue;
        score -= 5;
      } else {
        score += 2; // Board spec is lower but compatible
      }
    }

    // PSRAM scoring
    if (board.psramMB !== null && board.psramMB > 0) {
      if (psramSizeMB !== null && psramSizeMB > 0) {
        score += (board.psramMB === psramSizeMB) ? 10 : 5;
      } else {
        // Board expects PSRAM but none detected — unlikely match
        score -= 15;
      }
    } else if (psramSizeMB !== null && psramSizeMB > 0 && board.psramMB === null) {
      // Hardware has PSRAM, board doesn't specify — mild mismatch
      score -= 2;
    }

    // Generic boards always rank lower
    if (isGeneric) score -= 20;

    scored.push({ board, score, isGeneric });
  }

  return scored
    .sort((a, b) => {
      if (a.isGeneric !== b.isGeneric) return a.isGeneric ? 1 : -1;
      return b.score - a.score;
    })
    .map(s => s.board);
}
