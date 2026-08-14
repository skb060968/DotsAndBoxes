/**
 * Audio Manager — Dots and Boxes
 * 
 * Sound effects for game actions.
 * Pattern adapted from Musical Chairs.
 */

const SOUND_FILES = {
  tap: '/sounds/tap.mp3',         // Dot selected
  line: '/sounds/line.mp3',       // Line drawn
  music: '/sounds/music.mp3',     // Game started
  victory: '/sounds/victory.mp3', // Box completed / Game won
};

const MUTE_KEY = 'dots_and_boxes_muted';

export const AUDIO_STATUS_EVENT = 'dots-and-boxes:audio-status';
export const GESTURE_PROMPT = 'Tap anywhere to enable sound';
export const SILENT_MODE_MESSAGE = 'Audio unavailable - visual mode only';

let audioCtx = null;
let silentBuffer = null;
let initialized = false;
let warmedHtmlAudio = false;

const soundBuffers = {};
const audioEls = {};
const unavailable = new Set();

let pendingGesture = false;
const pendingSounds = [];

const statusListeners = new Set();

function clamp(volume) {
  const n = Number(volume);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function getAudioStatus() {
  const names = Array.from(unavailable);
  const silentMode = names.length >= Object.keys(SOUND_FILES).length;
  let message = null;
  if (silentMode) message = SILENT_MODE_MESSAGE;
  else if (pendingGesture) message = GESTURE_PROMPT;
  return {
    ready: initialized,
    muted: isMuted(),
    pendingGesture,
    silentMode,
    unavailable: names,
    message,
  };
}

function emitStatus() {
  const status = getAudioStatus();
  statusListeners.forEach((fn) => {
    try { fn(status); } catch (_) {}
  });
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(AUDIO_STATUS_EVENT, { detail: status }));
    }
  } catch (_) {}
}

export function onAudioStatusChange(listener) {
  if (typeof listener !== 'function') return () => {};
  statusListeners.add(listener);
  try { listener(getAudioStatus()); } catch (_) {}
  return () => statusListeners.delete(listener);
}

export function isAudioAvailable(name) {
  if (!name) return unavailable.size < Object.keys(SOUND_FILES).length;
  return !unavailable.has(name);
}

export function needsUserGesture() {
  return pendingGesture;
}

function markUnavailable(name) {
  if (unavailable.has(name)) return;
  unavailable.add(name);
  console.warn(`[audio] "${name}" unavailable (${SOUND_FILES[name]}) - continuing silently`);
  emitStatus();
}

function markPending(kind) {
  if (pendingGesture) return;
  pendingGesture = true;
  console.log(`[audio] ${kind} blocked by autoplay policy - retrying on next gesture`);
  emitStatus();
}

function clearPending() {
  if (!pendingGesture) return;
  pendingGesture = false;
  emitStatus();
}

function getAudioContext() {
  if (audioCtx) return audioCtx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  } catch (_) {
    audioCtx = null;
  }
  return audioCtx;
}

function kickSilent() {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (!silentBuffer) silentBuffer = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = silentBuffer;
    src.connect(ctx.destination);
    src.start(0);
  } catch (_) {}
}

async function loadBuffer(name, url) {
  const ctx = getAudioContext();
  if (!ctx) return null;
  try {
    const res = await fetch(url);
    if (!res || !res.ok) {
      markUnavailable(name);
      return null;
    }
    const bytes = await res.arrayBuffer();
    return await ctx.decodeAudioData(bytes);
  } catch (_) {
    return null;
  }
}

function preloadBuffers() {
  Object.entries(SOUND_FILES).forEach(([name, url]) => {
    loadBuffer(name, url).then((buf) => {
      if (buf) soundBuffers[name] = buf;
    });
  });
}

function createAudioEl(name, url) {
  try {
    const el = new Audio();
    el.preload = 'auto';
    el.onerror = () => markUnavailable(name);
    el.addEventListener('canplaythrough', () => {
      if (unavailable.delete(name)) emitStatus();
    }, { once: true });
    el.src = url;
    try { el.load(); } catch (_) {}
    return el;
  } catch (_) {
    markUnavailable(name);
    return null;
  }
}

function preloadAudioElements() {
  Object.entries(SOUND_FILES).forEach(([name, url]) => {
    if (audioEls[name]) return;
    const el = createAudioEl(name, url);
    if (el) audioEls[name] = el;
  });
}

function warmHtmlAudio() {
  if (warmedHtmlAudio) return;
  warmedHtmlAudio = true;
  preloadAudioElements();
  Object.values(audioEls).forEach((el) => {
    try { el.load(); } catch (_) {}
  });
}

export function initAudio() {
  if (initialized) return;
  initialized = true;

  try {
    getAudioContext();
    preloadAudioElements();
    preloadBuffers();

    const handler = () => {
      const ctx = getAudioContext();
      if (ctx) {
        if (ctx.state === 'suspended') {
          try { ctx.resume(); } catch (_) {}
        }
        kickSilent();
      }
      warmHtmlAudio();
      retryPending();
    };

    ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((ev) => {
      document.addEventListener(ev, handler, { passive: true });
    });
  } catch (err) {
    console.warn('[audio] initAudio failed - continuing in silent mode', err);
  }

  emitStatus();
}

function retryPending() {
  if (isMuted()) {
    pendingSounds.length = 0;
    clearPending();
    return;
  }

  const queued = pendingSounds.splice(0, pendingSounds.length);
  queued.forEach(({ name, volume }) => playSound(name, volume));
  clearPending();
}

export function isMuted() {
  try {
    const v = localStorage.getItem(MUTE_KEY);
    return v === '1' || v === 'true';
  } catch (_) {
    return false;
  }
}

function setMuted(muted) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch (_) {}
  if (muted) {
    pendingSounds.length = 0;
  }
  emitStatus();
}

export function toggleMute() {
  const next = !isMuted();
  setMuted(next);
  return next;
}

export function playSound(name, volume = 1.0) {
  if (isMuted()) return;
  const url = SOUND_FILES[name];
  if (!url) return;
  if (unavailable.has(name)) return;

  const vol = clamp(volume);
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try { ctx.resume(); } catch (_) {}
  }

  // Try AudioContext buffer source first
  if (ctx && ctx.state === 'running' && soundBuffers[name]) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = soundBuffers[name];
      const gain = ctx.createGain();
      gain.gain.value = vol;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(0);
      return;
    } catch (_) {}
  }

  // Fallback to HTML audio element
  const warmed = audioEls[name];
  if (warmed) {
    try {
      warmed.currentTime = 0;
      warmed.volume = vol;
      const p = warmed.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => queueBlockedSound(name, vol));
      }
      return;
    } catch (_) {}
  }

  // Last resort: fresh Audio element
  try {
    const a = new Audio(url);
    a.volume = vol;
    a.onerror = () => markUnavailable(name);
    const p = a.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => queueBlockedSound(name, vol));
    }
  } catch (_) {
    queueBlockedSound(name, vol);
  }
}

function queueBlockedSound(name, volume) {
  if (pendingSounds.length < 4) {
    pendingSounds.push({ name, volume });
  }
  markPending(`sound "${name}"`);
}

export function __resetAudioForTests() {
  initialized = false;
  warmedHtmlAudio = false;
  audioCtx = null;
  silentBuffer = null;
  pendingGesture = false;
  pendingSounds.length = 0;
  unavailable.clear();
  statusListeners.clear();
  Object.keys(soundBuffers).forEach((k) => delete soundBuffers[k]);
  Object.keys(audioEls).forEach((k) => delete audioEls[k]);
}

export default {
  initAudio,
  playSound,
  toggleMute,
  isMuted,
  isAudioAvailable,
  needsUserGesture,
  getAudioStatus,
  onAudioStatusChange,
  AUDIO_STATUS_EVENT,
  GESTURE_PROMPT,
  SILENT_MODE_MESSAGE,
};
