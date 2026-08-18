const SOUND_FILES = {
  tap: '/sounds/tap.mp3',
  linedraw: '/sounds/linedraw.mp3',
  boxclaim: '/sounds/boxclaim.mp3',
  error: '/sounds/error.mp3',
  win: '/sounds/win.mp3',
  music: '/sounds/music.mp3',
};

const MUTE_KEY = 'dots-muted';
const audioBuffers = {};
let audioContext = null;
let audioUnlocked = false;
let backgroundMusic = null;
let backgroundMusicWanted = false;
let backgroundMusicVolume = 0.10;
let muted = false;

try {
  const saved = localStorage.getItem(MUTE_KEY);
  muted = saved === 'true' || saved === '1';
} catch (_) {}

export function isMuted() {
  return muted;
}

function pauseBackgroundMusic() {
  try { backgroundMusic?.pause(); } catch (_) {}
}

function resumeBackgroundMusic() {
  if (!backgroundMusicWanted || muted) return;
  if (!backgroundMusic) {
    startBackgroundMusic();
    return;
  }
  if (backgroundMusic.paused) backgroundMusic.play().catch(() => {});
}

export function startBackgroundMusic() {
  backgroundMusicWanted = true;
  if (muted) return;
  if (backgroundMusic) {
    backgroundMusic.play().catch(() => {});
    return;
  }
  try {
    backgroundMusic = new Audio(SOUND_FILES.music);
    backgroundMusic.loop = true;
    backgroundMusic.volume = backgroundMusicVolume;
    backgroundMusic.play().catch(() => {});
  } catch (_) {
    backgroundMusic = null;
  }
}

export function stopBackgroundMusic() {
  backgroundMusicWanted = false;
  if (!backgroundMusic) return;
  try {
    backgroundMusic.pause();
    backgroundMusic.currentTime = 0;
  } catch (_) {}
  backgroundMusic = null;
}

export function setBackgroundMusicVolume(value) {
  backgroundMusicVolume = Math.max(0, Math.min(1, Number(value) || 0));
  if (backgroundMusic) backgroundMusic.volume = backgroundMusicVolume;
}

export function setMuted(value) {
  muted = Boolean(value);
  try { localStorage.setItem(MUTE_KEY, String(muted)); } catch (_) {}
  if (muted) pauseBackgroundMusic();
  else resumeBackgroundMusic();
}

export function playSound(name) {
  if (muted || !SOUND_FILES[name] || name === 'music') return;
  if (audioContext && audioBuffers[name]) {
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffers[name];
    source.connect(audioContext.destination);
    source.start(0);
    return;
  }
  try {
    const audio = new Audio(SOUND_FILES[name]);
    audio.play().catch(() => {});
  } catch (_) {}
}

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    resumeBackgroundMusic();
    Object.entries(SOUND_FILES).forEach(([name, url]) => {
      if (name === 'music') return;
      fetch(url)
        .then((response) => response.arrayBuffer())
        .then((buffer) => audioContext.decodeAudioData(buffer))
        .then((decoded) => { audioBuffers[name] = decoded; })
        .catch(() => {});
    });
  } catch (_) {
    audioContext = null;
  }
}

['click', 'touchstart', 'keydown'].forEach((eventName) => {
  document.addEventListener(eventName, unlockAudio, { once: true });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') pauseBackgroundMusic();
  else resumeBackgroundMusic();
});
