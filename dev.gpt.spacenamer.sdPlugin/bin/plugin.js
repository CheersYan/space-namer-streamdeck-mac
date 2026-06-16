#!/usr/bin/env node
"use strict";

/**
 * Space Namer Lite for Stream Deck
 *
 * A self-contained macOS-only Stream Deck plugin that:
 * - reads macOS Spaces from ~/Library/Preferences/com.apple.spaces.plist,
 * - gives normal Desktop spaces temporary per-boot names,
 * - prompts when a new normal Desktop space appears,
 * - switches by sending macOS's built-in Control-Left/Control-Right shortcuts.
 *
 * No Homebrew, DesktopRenamer, yabai, Hammerspoon, or SIP changes required.
 *
 * Runtime notes:
 * - Built without npm dependencies so the .sdPlugin can be installed directly.
 * - Uses Node's built-in WebSocket when available, with a small Node 20 fallback.
 * - Uses /usr/bin/plutil to read the Spaces plist.
 * - Uses /usr/bin/osascript for prompts and Control-arrow key events.
 */

const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");

const execFileAsync = util.promisify(execFile);

const PLUGIN_UUID = "dev.gpt.spacenamer";
const ACTION_PREFIX = `${PLUGIN_UUID}.desktop.`;
const ACTION_REFRESH = `${PLUGIN_UUID}.refresh`;
const ACTION_NAME_ALL = `${PLUGIN_UUID}.name-all`;

const POLL_INTERVAL_MS = 2000;
const LONG_PRESS_MS = 850;
const SWITCH_STEP_DELAY_MS = 260;
const MAX_DESKTOP_ACTIONS = 16;
const LOG_DIR = path.resolve(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "plugin.log");
const SPACE_PLIST = path.join(os.homedir(), "Library", "Preferences", "com.apple.spaces.plist");

let ws = null;
let topology = emptyTopology();
let spaces = []; // Normal desktop spaces for Stream Deck keys, derived from topology.normalSpaces.
let sessionNames = new Map();
let contexts = new Map();
let scanInProgress = false;
let hasScanned = false;
let lastError = null;
let promptQueue = Promise.resolve();
let sessionPath = null;

function emptyTopology() {
  return {
    displayId: "unknown",
    displayIndex: 0,
    currentSpaceId: null,
    allSpaces: [],
    normalSpaces: [],
    monitorCount: 0,
    plistPath: SPACE_PLIST,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message, extra) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const suffix = extra === undefined ? "" : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}${suffix}\n`, "utf8");
  } catch {
    // Logging should never break the plugin.
  }
}

class Node20WebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(address) {
    super();
    this.address = address;
    this.readyState = Node20WebSocket.CONNECTING;
    this.buffer = Buffer.alloc(0);
    this.handshakeComplete = false;
    this.expectedAccept = null;
    this.socket = null;
    this.connect();
  }

  addEventListener(type, listener) {
    this.on(type, listener);
  }

  removeEventListener(type, listener) {
    this.off(type, listener);
  }

  connect() {
    const url = new URL(this.address);
    if (url.protocol !== "ws:") {
      throw new Error(`Unsupported WebSocket protocol: ${url.protocol}`);
    }

    const host = url.hostname;
    const port = Number(url.port || 80);
    const requestPath = `${url.pathname || "/"}${url.search || ""}`;
    const key = crypto.randomBytes(16).toString("base64");
    this.expectedAccept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    this.socket = net.createConnection({ host, port }, () => {
      this.socket.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"));
    });

    this.socket.on("data", (chunk) => {
      try {
        this.handleData(chunk);
      } catch (err) {
        this.fail(err);
      }
    });
    this.socket.on("error", (err) => this.fail(err));
    this.socket.on("close", () => {
      const wasClosed = this.readyState === Node20WebSocket.CLOSED;
      this.readyState = Node20WebSocket.CLOSED;
      if (!wasClosed) this.emit("close", {});
    });
  }

  fail(err) {
    this.emit("error", {
      message: String(err && err.message ? err.message : err),
      error: err,
    });
    this.close();
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeComplete) {
      const marker = this.buffer.indexOf("\r\n\r\n");
      if (marker < 0) return;

      const headerText = this.buffer.subarray(0, marker).toString("utf8");
      this.buffer = this.buffer.subarray(marker + 4);
      this.verifyHandshake(headerText);
      this.handshakeComplete = true;
      this.readyState = Node20WebSocket.OPEN;
      this.emit("open", {});
    }

    this.readFrames();
  }

  verifyHandshake(headerText) {
    const lines = headerText.split(/\r?\n/);
    if (!/^HTTP\/1\.1 101\b/.test(lines[0] || "")) {
      throw new Error(`WebSocket upgrade failed: ${lines[0] || "empty response"}`);
    }

    const headers = new Map();
    for (const line of lines.slice(1)) {
      const index = line.indexOf(":");
      if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
    }

    const accept = headers.get("sec-websocket-accept");
    if (accept !== this.expectedAccept) {
      throw new Error("WebSocket upgrade failed: invalid Sec-WebSocket-Accept header");
    }
  }

  readFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const longLength = this.buffer.readBigUInt64BE(offset);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
        length = Number(longLength);
        offset += 8;
      }

      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + length) return;

      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);

      if (mask) {
        const unmasked = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i += 1) {
          unmasked[i] = payload[i] ^ mask[i % 4];
        }
        payload = unmasked;
      }

      if (opcode === 0x1) {
        this.emit("message", { data: payload.toString("utf8") });
      } else if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x9) {
        this.sendFrame(0xA, payload);
      }
    }
  }

  send(data) {
    if (this.readyState !== Node20WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sendFrame(0x1, Buffer.from(String(data), "utf8"));
  }

  sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;

    let header;
    if (payload.length < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | payload.length;
    } else if (payload.length <= 0xffff) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    const mask = crypto.randomBytes(4);
    const maskedPayload = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
      maskedPayload[i] = payload[i] ^ mask[i % 4];
    }

    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  close() {
    if (this.readyState === Node20WebSocket.CLOSED || this.readyState === Node20WebSocket.CLOSING) return;
    this.readyState = Node20WebSocket.CLOSING;
    if (this.socket && !this.socket.destroyed) this.socket.end();
    this.readyState = Node20WebSocket.CLOSED;
  }
}

function createStreamDeckWebSocket(address) {
  if (typeof WebSocket !== "undefined") return new WebSocket(address);
  log("Using Node 20 WebSocket fallback");
  return new Node20WebSocket(address);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key && key.startsWith("-")) out[key] = argv[i + 1];
  }
  return out;
}

function send(event) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(event));
}

function setTitle(context, title) {
  send({ event: "setTitle", context, payload: { title, target: 0 } });
}

function showOk(context) {
  send({ event: "showOk", context });
}

function showAlert(context) {
  send({ event: "showAlert", context });
}

function slotFromAction(action) {
  if (!action || !action.startsWith(ACTION_PREFIX)) return null;
  const slot = Number.parseInt(action.slice(ACTION_PREFIX.length), 10);
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_DESKTOP_ACTIONS) return null;
  return slot;
}

function appleScriptString(value) {
  return `"${String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n")}"`;
}

async function runOsascript(script, timeoutMs = 15000) {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function runPlutilJson(plistPath) {
  const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
    timeout: 6000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function getBootSessionId() {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    const match = stdout.match(/sec\s*=\s*(\d+)/);
    if (match) return match[1];
  } catch (err) {
    log("Unable to read macOS boot time; falling back to runtime session", String(err && err.message ? err.message : err));
  }
  return `runtime-${Date.now()}`;
}

async function initSessionStore() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const bootId = await getBootSessionId();
  sessionPath = `/tmp/${PLUGIN_UUID}-${uid}-${bootId}.json`;
  try {
    if (fs.existsSync(sessionPath)) {
      const data = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
      if (data && data.names && typeof data.names === "object") {
        sessionNames = new Map(Object.entries(data.names));
        log("Loaded session names", { count: sessionNames.size, sessionPath });
      }
    }
  } catch (err) {
    log("Unable to load session file", String(err && err.message ? err.message : err));
  }
}

function saveSessionStore() {
  if (!sessionPath) return;
  try {
    const tmp = `${sessionPath}.${process.pid}.tmp`;
    const data = {
      note: "Temporary per-macOS-boot labels for dev.gpt.spacenamer. Safe to delete.",
      updatedAt: new Date().toISOString(),
      names: Object.fromEntries(sessionNames),
    };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, sessionPath);
  } catch (err) {
    log("Unable to save session file", String(err && err.message ? err.message : err));
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeUuid(value) {
  const out = String(value || "").trim();
  return out || null;
}

function isWallSpace(space) {
  const type = Number(space && space.type);
  return type === 6 || Object.prototype.hasOwnProperty.call(space || {}, "WallSpaceOnly");
}

function isNormalDesktopSpace(space) {
  if (!space || !normalizeUuid(space.uuid)) return false;
  const type = Number(space.type);
  if (Number.isFinite(type) && type !== 0) return false;
  if (space.TileLayoutManager || space.WallSpace || space.fs_wid || space.pid) return false;
  return !isWallSpace(space);
}

function isNavigableTopLevelSpace(space) {
  if (!space || !normalizeUuid(space.uuid)) return false;
  if (isWallSpace(space)) return false;
  return true;
}

function findMonitorArrays(plist) {
  const candidates = [
    plist && plist.SpacesDisplayConfiguration && plist.SpacesDisplayConfiguration["Management Data"] && plist.SpacesDisplayConfiguration["Management Data"].Monitors,
    plist && plist["SpacesDisplayConfiguration"] && plist["SpacesDisplayConfiguration"].Monitors,
    plist && plist["Management Data"] && plist["Management Data"].Monitors,
    plist && plist.Monitors,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }

  // Defensive fallback: recursively look for an object property called Monitors that resembles the Spaces monitor list.
  const queue = [plist];
  const seen = new Set();
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node.Monitors) && node.Monitors.some((item) => item && Array.isArray(item.Spaces))) {
      return node.Monitors;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return [];
}

function parseMonitor(monitor, monitorIndex) {
  const displayId = String(
    monitor["Display Identifier"] ||
    monitor.DisplayIdentifier ||
    monitor.displayIdentifier ||
    `display-${monitorIndex + 1}`
  );
  const currentSpaceId = normalizeUuid(
    monitor["Current Space"] && monitor["Current Space"].uuid ||
    monitor.CurrentSpace && monitor.CurrentSpace.uuid ||
    monitor["Collapsed Space"] && monitor["Collapsed Space"].uuid ||
    null
  );
  const rawSpaces = asArray(monitor.Spaces);
  const allSpaces = [];
  const normalSpaces = [];
  for (const rawSpace of rawSpaces) {
    if (!isNavigableTopLevelSpace(rawSpace)) continue;
    const id = normalizeUuid(rawSpace.uuid);
    const type = Number.isFinite(Number(rawSpace.type)) ? Number(rawSpace.type) : null;
    const base = {
      id,
      managedId: rawSpace.ManagedSpaceID || rawSpace.id64 || null,
      type,
      displayId,
      displayIndex: monitorIndex,
      order: allSpaces.length + 1,
      isNormalDesktop: isNormalDesktopSpace(rawSpace),
      isCurrent: id === currentSpaceId,
    };
    allSpaces.push(base);
    if (base.isNormalDesktop) {
      normalSpaces.push({
        ...base,
        number: normalSpaces.length + 1,
      });
    }
  }
  return {
    displayId,
    displayIndex: monitorIndex,
    currentSpaceId,
    allSpaces,
    normalSpaces,
    rawSpaceCount: rawSpaces.length,
  };
}

function choosePrimaryMonitor(parsedMonitors) {
  if (!parsedMonitors.length) return null;
  const withMain = parsedMonitors.find((monitor) => monitor.displayId === "Main" && monitor.normalSpaces.length > 0);
  if (withMain) return withMain;
  const withCurrentNormal = parsedMonitors.find((monitor) => monitor.currentSpaceId && monitor.normalSpaces.some((space) => space.id === monitor.currentSpaceId));
  if (withCurrentNormal) return withCurrentNormal;
  const withCurrentAny = parsedMonitors.find((monitor) => monitor.currentSpaceId && monitor.allSpaces.length > 0);
  if (withCurrentAny) return withCurrentAny;
  return parsedMonitors.find((monitor) => monitor.normalSpaces.length > 0) || parsedMonitors[0];
}

function parseSpacesPlist(plist, plistPath = SPACE_PLIST) {
  const monitors = findMonitorArrays(plist).map(parseMonitor).filter((monitor) => monitor.allSpaces.length > 0 || monitor.normalSpaces.length > 0);
  const primary = choosePrimaryMonitor(monitors);
  if (!primary) {
    return { ...emptyTopology(), monitorCount: 0, plistPath };
  }
  return {
    displayId: primary.displayId,
    displayIndex: primary.displayIndex,
    currentSpaceId: primary.currentSpaceId,
    allSpaces: primary.allSpaces,
    normalSpaces: primary.normalSpaces,
    monitorCount: monitors.length,
    plistPath,
  };
}

async function getAllSpaces() {
  const plist = await runPlutilJson(SPACE_PLIST);
  return parseSpacesPlist(plist, SPACE_PLIST);
}

function isProbablyDefaultDesktopName(name) {
  return /^desktop\s*\d+$/i.test(String(name || "").trim()) || /^space\s*\d+$/i.test(String(name || "").trim());
}

function defaultLabelForSpace(space, slot) {
  const number = space && space.number ? space.number : slot;
  const externalName = String((space && space.name) || "").trim();
  if (externalName && !isProbablyDefaultDesktopName(externalName)) return externalName;
  return `Desktop ${number}`;
}

function labelForSpace(space, slot) {
  if (!space) return `Desktop ${slot}`;
  const saved = sessionNames.get(space.id);
  if (saved && saved.trim()) return saved.trim();
  return defaultLabelForSpace(space, slot);
}

function wrapLabel(label) {
  const clean = String(label || "").trim().replace(/\s+/g, " ");
  if (clean.length <= 11) return clean;
  const words = clean.split(" ");
  if (words.length === 1) return clean.length <= 16 ? clean : `${clean.slice(0, 15)}…`;
  let bestIndex = 1;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i += 1) {
    const left = words.slice(0, i).join(" ").length;
    const right = words.slice(i).join(" ").length;
    const score = Math.abs(left - right);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  const first = words.slice(0, bestIndex).join(" ");
  const second = words.slice(bestIndex).join(" ");
  return `${first}\n${second}`;
}

function spaceForSlot(slot) {
  return spaces[slot - 1] || null;
}

function slotForSpaceId(spaceId) {
  const index = spaces.findIndex((space) => space.id === spaceId);
  return index >= 0 ? index + 1 : null;
}

function titleForSlot(slot) {
  if (lastError) return "Spaces\nError";
  const space = spaceForSlot(slot);
  if (!space) return `D${slot}\n—`;
  return `D${slot}\n${wrapLabel(labelForSpace(space, slot))}`;
}

function titleForContext(ctx) {
  if (!ctx) return "";
  if (ctx.type === "desktop") return titleForSlot(ctx.slot);
  if (ctx.type === "refresh") return lastError ? "Retry\nSpaces" : "Refresh\nSpaces";
  if (ctx.type === "name-all") return "Name\nDesktops";
  return "";
}

function renderContext(context, ctx = contexts.get(context)) {
  if (!context || !ctx) return;
  setTitle(context, titleForContext(ctx));
}

function renderAll() {
  for (const [context, ctx] of contexts.entries()) renderContext(context, ctx);
}

async function promptForSpaceName(space, reason) {
  const slot = slotForSpaceId(space.id) || space.number || 1;
  const currentLabel = labelForSpace(space, slot);
  const title = reason === "created" ? "New desktop detected" : "Rename desktop";
  const message = reason === "created"
    ? `A new macOS desktop was detected. Name Desktop ${space.number || slot}:`
    : `Enter a temporary session name for Desktop ${space.number || slot}:`;
  const notificationPart = reason === "created"
    ? `try\n  display notification "Name it now, or keep the default label." with title "Space Namer"\nend try\n`
    : "";
  const script = `
    ${notificationPart}
    try
      set dialogResult to display dialog ${appleScriptString(message)} default answer ${appleScriptString(currentLabel)} buttons {"Use Default", "Save"} default button "Save" cancel button "Use Default" with title ${appleScriptString(title)} with icon note
      if button returned of dialogResult is "Save" then
        return text returned of dialogResult
      else
        return ""
      end if
    on error number -128
      return ""
    end try
  `;
  const answer = (await runOsascript(script, 120000)).trim();
  return answer;
}

function enqueuePrompt(job) {
  promptQueue = promptQueue
    .catch((err) => log("Prompt queue recovered from error", String(err && err.message ? err.message : err)))
    .then(job)
    .catch((err) => log("Prompt failed", String(err && err.message ? err.message : err)));
  return promptQueue;
}

function cleanupDeletedSpaces(currentSpaces) {
  const currentIds = new Set(currentSpaces.map((space) => space.id));
  let changed = false;
  for (const id of Array.from(sessionNames.keys())) {
    if (!currentIds.has(id)) {
      sessionNames.delete(id);
      changed = true;
    }
  }
  if (changed) saveSessionStore();
}

async function scanSpaces(options = {}) {
  const { forcePromptNew = true } = options;
  if (scanInProgress) return;
  scanInProgress = true;
  try {
    const previousIds = new Set(spaces.map((space) => space.id));
    const firstScan = !hasScanned;
    const nextTopology = await getAllSpaces();
    const nextSpaces = nextTopology.normalSpaces;

    cleanupDeletedSpaces(nextSpaces);

    for (let i = 0; i < nextSpaces.length; i += 1) {
      const space = nextSpaces[i];
      const slot = i + 1;
      if (!sessionNames.has(space.id)) {
        sessionNames.set(space.id, defaultLabelForSpace(space, slot));
      }
    }

    topology = nextTopology;
    spaces = nextSpaces;
    hasScanned = true;
    lastError = null;
    saveSessionStore();
    renderAll();

    const created = spaces.filter((space) => !previousIds.has(space.id));
    if (!firstScan && forcePromptNew && created.length > 0) {
      for (const createdSpace of created) {
        enqueuePrompt(async () => {
          const currentSlot = slotForSpaceId(createdSpace.id) || createdSpace.number || 1;
          const answer = await promptForSpaceName(createdSpace, "created");
          if (answer) {
            sessionNames.set(createdSpace.id, answer);
          } else if (!sessionNames.get(createdSpace.id)) {
            sessionNames.set(createdSpace.id, defaultLabelForSpace(createdSpace, currentSlot));
          }
          saveSessionStore();
          renderAll();
        });
      }
    }
  } catch (err) {
    lastError = String((err && (err.stderr || err.message)) || err || "Unknown error").trim();
    log("Scan failed", lastError);
    renderAll();
  } finally {
    scanInProgress = false;
  }
}

async function renameSlot(slot, context) {
  await scanSpaces({ forcePromptNew: false });
  const space = spaceForSlot(slot);
  if (!space) {
    showAlert(context);
    return;
  }
  const answer = await promptForSpaceName(space, "manual");
  if (answer) {
    sessionNames.set(space.id, answer);
    saveSessionStore();
    renderAll();
    showOk(context);
  } else {
    showAlert(context);
  }
}

async function nameAllSpaces(context) {
  await scanSpaces({ forcePromptNew: false });
  if (spaces.length === 0) {
    showAlert(context);
    return;
  }
  for (const space of spaces) {
    const answer = await promptForSpaceName(space, "manual");
    if (answer) sessionNames.set(space.id, answer);
    saveSessionStore();
    renderAll();
  }
  showOk(context);
}

async function pressControlArrow(direction) {
  const keyCode = direction === "right" ? 124 : 123;
  const script = `tell application "System Events" to key code ${keyCode} using control down`;
  await runOsascript(script, 8000);
}

async function moveRelativeSpaces(stepCount) {
  const count = Math.abs(stepCount);
  const direction = stepCount > 0 ? "right" : "left";
  for (let i = 0; i < count; i += 1) {
    await pressControlArrow(direction);
    if (i < count - 1) await sleep(SWITCH_STEP_DELAY_MS);
  }
}

function indexInAllSpaces(spaceId) {
  return topology.allSpaces.findIndex((space) => space.id === spaceId);
}

async function switchToSpace(space) {
  if (!space || !space.id) throw new Error("No space selected");

  // Refresh immediately so currentSpaceId is as current as the plist allows.
  topology = await getAllSpaces();
  spaces = topology.normalSpaces;

  const currentIndex = indexInAllSpaces(topology.currentSpaceId);
  const targetIndex = indexInAllSpaces(space.id);

  if (targetIndex < 0) {
    throw new Error("Target desktop is not in the current Spaces order. Press Refresh Spaces and try again.");
  }
  if (currentIndex < 0) {
    throw new Error("Current Space is not visible in the Spaces plist yet. Press Refresh Spaces after leaving full screen or Mission Control.");
  }

  const delta = targetIndex - currentIndex;
  if (delta === 0) return;
  await moveRelativeSpaces(delta);
  await sleep(350);
  await scanSpaces({ forcePromptNew: false });
}

async function switchSlot(slot, context) {
  await scanSpaces({ forcePromptNew: false });
  const space = spaceForSlot(slot);
  if (!space) {
    showAlert(context);
    return;
  }
  try {
    await switchToSpace(space);
    showOk(context);
  } catch (err) {
    log("Switch failed", String(err && err.message ? err.message : err));
    showAlert(context);
  }
}

function handleWillAppear(message) {
  const slot = slotFromAction(message.action);
  if (slot) {
    contexts.set(message.context, { type: "desktop", slot, longPressTimer: null, longPressFired: false });
  } else if (message.action === ACTION_REFRESH) {
    contexts.set(message.context, { type: "refresh" });
  } else if (message.action === ACTION_NAME_ALL) {
    contexts.set(message.context, { type: "name-all" });
  }
  renderContext(message.context);
}

function handleWillDisappear(message) {
  const ctx = contexts.get(message.context);
  if (ctx && ctx.longPressTimer) clearTimeout(ctx.longPressTimer);
  contexts.delete(message.context);
}

function handleKeyDown(message) {
  const ctx = contexts.get(message.context);
  if (!ctx) return;

  if (ctx.type === "desktop") {
    if (ctx.longPressTimer) clearTimeout(ctx.longPressTimer);
    ctx.longPressFired = false;
    ctx.longPressTimer = setTimeout(() => {
      ctx.longPressFired = true;
      renameSlot(ctx.slot, message.context).catch((err) => {
        log("Long-press rename failed", String(err && err.message ? err.message : err));
        showAlert(message.context);
      });
    }, LONG_PRESS_MS);
    return;
  }

  if (ctx.type === "refresh") {
    scanSpaces({ forcePromptNew: true })
      .then(() => showOk(message.context))
      .catch(() => showAlert(message.context));
    return;
  }

  if (ctx.type === "name-all") {
    nameAllSpaces(message.context).catch((err) => {
      log("Name-all failed", String(err && err.message ? err.message : err));
      showAlert(message.context);
    });
  }
}

function handleKeyUp(message) {
  const ctx = contexts.get(message.context);
  if (!ctx || ctx.type !== "desktop") return;
  if (ctx.longPressTimer) {
    clearTimeout(ctx.longPressTimer);
    ctx.longPressTimer = null;
  }
  if (ctx.longPressFired) return;
  switchSlot(ctx.slot, message.context).catch((err) => {
    log("Switch slot failed", String(err && err.message ? err.message : err));
    showAlert(message.context);
  });
}

function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (err) {
    log("Unable to parse Stream Deck message", String(err && err.message ? err.message : err));
    return;
  }

  switch (message.event) {
    case "willAppear":
      handleWillAppear(message);
      break;
    case "willDisappear":
      handleWillDisappear(message);
      break;
    case "keyDown":
      handleKeyDown(message);
      break;
    case "keyUp":
      handleKeyUp(message);
      break;
    case "deviceDidConnect":
    case "systemDidWakeUp":
      scanSpaces({ forcePromptNew: false }).catch((err) => log("Wake/device scan failed", String(err && err.message ? err.message : err)));
      break;
    default:
      break;
  }
}

async function start() {
  await initSessionStore();
  await scanSpaces({ forcePromptNew: false });
  setInterval(() => {
    scanSpaces({ forcePromptNew: true }).catch((err) => log("Interval scan failed", String(err && err.message ? err.message : err)));
  }, POLL_INTERVAL_MS);
}

async function main() {
  const args = parseArgs(process.argv);
  const port = args["-port"];
  const pluginUUID = args["-pluginUUID"];
  const registerEvent = args["-registerEvent"];

  if (!port || !pluginUUID || !registerEvent) {
    console.error("Space Namer Lite is a Stream Deck plugin and should be launched by the Stream Deck app.");
    return;
  }

  ws = createStreamDeckWebSocket(`ws://127.0.0.1:${port}`);
  ws.addEventListener("open", () => {
    send({ event: registerEvent, uuid: pluginUUID });
    start().catch((err) => log("Startup failed", String(err && err.message ? err.message : err)));
  });
  ws.addEventListener("message", (event) => handleMessage(event.data));
  ws.addEventListener("error", (event) => log("WebSocket error", String(event && event.message ? event.message : event)));
  ws.addEventListener("close", () => log("WebSocket closed"));
}

main().catch((err) => {
  log("Fatal plugin error", String(err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
