/**
 * Session Persistence — Dots and Boxes
 * 
 * Saves session for auto-rejoin after refresh.
 * Pattern adapted from Musical Chairs.
 */

export const SESSION_KEY = 'dots_and_boxes_session';
export const SESSION_SCHEMA_VERSION = 1;
export const STORAGE_UNAVAILABLE_MESSAGE = 'Auto-rejoin unavailable in private mode';
export const SESSION_EXPIRED_MESSAGE = 'Previous room no longer exists';
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const SESSION_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes

const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z]{4}$/;
const MAX_PLAYER_INDEX = 3; // 0-3 for 4 players
const MAX_NAME_LENGTH = 40;

let storageAvailable = null;
let warnedUnavailable = false;

function getStorage() {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return null;
    return localStorage;
  } catch (_) {
    return null;
  }
}

function markAvailable() {
  storageAvailable = true;
}

function markUnavailable(op) {
  storageAvailable = false;
  if (!warnedUnavailable) {
    warnedUnavailable = true;
    console.warn(`[session] localStorage unavailable during ${op} - ${STORAGE_UNAVAILABLE_MESSAGE}`);
  }
}

function readRaw() {
  const store = getStorage();
  if (!store) {
    markUnavailable('read');
    return null;
  }
  try {
    const raw = store.getItem(SESSION_KEY);
    markAvailable();
    return typeof raw === 'string' ? raw : null;
  } catch (_) {
    markUnavailable('read');
    return null;
  }
}

function writeRaw(raw) {
  const store = getStorage();
  if (!store) {
    markUnavailable('write');
    return false;
  }
  try {
    store.setItem(SESSION_KEY, raw);
    markAvailable();
    return true;
  } catch (_) {
    markUnavailable('write');
    return false;
  }
}

function removeRaw() {
  const store = getStorage();
  if (!store) {
    markUnavailable('clear');
    return false;
  }
  try {
    store.removeItem(SESSION_KEY);
    markAvailable();
    return true;
  } catch (_) {
    markUnavailable('clear');
    return false;
  }
}

function normalizeSession(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const { roomCode, playerIndex, isHost, playerName } = data;

  if (typeof roomCode !== 'string') return null;
  const code = roomCode.trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(code)) return null;

  if (typeof playerIndex !== 'number' || !Number.isInteger(playerIndex)) return null;
  if (playerIndex < 0 || playerIndex > MAX_PLAYER_INDEX) return null;

  if (typeof isHost !== 'boolean') return null;

  if (typeof playerName !== 'string') return null;
  const name = playerName.trim().slice(0, MAX_NAME_LENGTH);
  if (name.length === 0) return null;

  return { roomCode: code, playerIndex, isHost, playerName: name };
}

function isFreshTimestamp(savedAt, now) {
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt) || savedAt <= 0) return false;
  if (savedAt > now + SESSION_FUTURE_SKEW_MS) return false;
  return now - savedAt <= SESSION_MAX_AGE_MS;
}

export function saveSession(data) {
  const session = normalizeSession(data);
  if (!session) {
    console.warn('[session] refusing to save malformed session payload');
    return false;
  }

  let raw;
  try {
    raw = JSON.stringify({
      ...session,
      v: SESSION_SCHEMA_VERSION,
      savedAt: Date.now(),
    });
  } catch (_) {
    return false;
  }

  return writeRaw(raw);
}

export function loadSession() {
  const raw = readRaw();
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    console.warn('[session] stored session is not valid JSON - discarding');
    removeRaw();
    return null;
  }

  const session = normalizeSession(parsed);
  if (!session) {
    console.warn('[session] stored session failed validation - discarding');
    removeRaw();
    return null;
  }

  const savedAt = parsed && typeof parsed === 'object' ? parsed.savedAt : undefined;
  const version = parsed && typeof parsed === 'object' ? parsed.v : undefined;

  if (version !== SESSION_SCHEMA_VERSION || !isFreshTimestamp(savedAt, Date.now())) {
    console.warn('[session] stored session is stale or from an older schema - discarding');
    removeRaw();
    return null;
  }

  return { ...session, savedAt };
}

export function clearSession() {
  return removeRaw();
}

export function hasStoredSession() {
  return loadSession() !== null;
}

export function isStorageAvailable() {
  if (storageAvailable !== null) return storageAvailable;

  const store = getStorage();
  if (!store) {
    markUnavailable('probe');
    return false;
  }
  const probeKey = `${SESSION_KEY}__probe`;
  try {
    store.setItem(probeKey, '1');
    store.removeItem(probeKey);
    markAvailable();
    return true;
  } catch (_) {
    markUnavailable('probe');
    return false;
  }
}

export function getStorageStatus() {
  const available = isStorageAvailable();
  return {
    available,
    probed: storageAvailable !== null,
    hasSession: available ? hasStoredSession() : false,
    message: available ? null : STORAGE_UNAVAILABLE_MESSAGE,
  };
}

export function __resetSessionForTests() {
  storageAvailable = null;
  warnedUnavailable = false;
}

export default {
  saveSession,
  loadSession,
  clearSession,
  hasStoredSession,
  isStorageAvailable,
  getStorageStatus,
  SESSION_KEY,
  SESSION_SCHEMA_VERSION,
  SESSION_MAX_AGE_MS,
  STORAGE_UNAVAILABLE_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
};
