import QRCode from 'qrcode';
import { initializeBoard } from './board-ui.js';
import { auth, authReady } from './firebase-config.js';
import {
  createRoom,
  deleteRoom,
  joinRoom,
  leavePlayer,
  listenRoom,
  normalizeRoomCode,
  removePlayer,
  restoreSession,
  setupDisconnectHandler,
  stopPresenceTracking,
} from './firebase-sync.js';
import { showScreen, showToast } from './platform-ui.js';
import {
  isMuted,
  playSound,
  setMuted,
  startBackgroundMusic,
  stopBackgroundMusic,
} from './sound-manager.js';

const AVATARS = ['🦊', '🐼', '🐸', '🦁', '🐙', '🦄'];
const COLORS = [
  ['Ocean', '#2563eb'], ['Berry', '#db2777'], ['Leaf', '#16a34a'],
  ['Sun', '#eab308'], ['Grape', '#7c3aed'], ['Coral', '#ea580c'],
];
const SESSION_KEY = 'dots_and_boxes_session';
const SHARE_BASE_URL = 'https://dots-and-boxes-brown.vercel.app/';
const ROOM_CODE_RE = /^[A-HJ-NP-Z]{4}$/;

let players = [];
let roomCode = null;
let playerIndex = null;
let isHost = false;
let unsubscribeRoom = null;
let leavingRoom = false;

function saveSession() {
  if (roomCode && playerIndex !== null) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, playerIndex })); } catch (_) {}
  }
}

function loadSession() {
  try {
    const value = localStorage.getItem(SESSION_KEY);
    return value ? JSON.parse(value) : null;
  } catch (_) { return null; }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

function normalizeTypedCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-HJ-NP-Z]/g, '').slice(0, 4);
}

function roomLink() {
  const url = new URL(SHARE_BASE_URL);
  url.searchParams.set('room', roomCode);
  return url.href;
}

function buildPickers() {
  document.querySelectorAll('.avatar-picker').forEach((picker) => {
    AVATARS.forEach((avatar, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pick';
      button.dataset.value = avatar;
      button.setAttribute('aria-label', avatar);
      button.setAttribute('aria-pressed', String(index === 0));
      button.textContent = avatar;
      picker.append(button);
    });
  });
  document.querySelectorAll('.color-picker').forEach((picker) => {
    COLORS.forEach(([name, color], index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pick color-pick';
      button.dataset.value = color;
      button.style.setProperty('--pick-color', color);
      button.setAttribute('aria-label', name);
      button.setAttribute('aria-pressed', String(index === 0));
      picker.append(button);
    });
  });
  document.querySelectorAll('.picker').forEach((picker) => {
    picker.addEventListener('click', (event) => {
      const button = event.target.closest('.pick');
      if (!button) return;
      picker.querySelectorAll('.pick').forEach((item) => item.setAttribute('aria-pressed', 'false'));
      button.setAttribute('aria-pressed', 'true');
    });
  });
}

function picked(name) {
  return document.querySelector(`[data-picker="${name}"] .pick[aria-pressed="true"]`)?.dataset.value;
}

function validName(id) {
  const value = document.getElementById(id).value.trim();
  if (!value) showToast('Please enter your name.');
  return value;
}

function releaseRoomState() {
  stopBackgroundMusic();
  unsubscribeRoom?.();
  unsubscribeRoom = null;
  stopPresenceTracking().catch(() => {});
  clearSession();
  players = [];
  roomCode = null;
  playerIndex = null;
  isHost = false;
  leavingRoom = false;
}

function cleanupAndGoHome() {
  releaseRoomState();
  showScreen('home');
}

function renderLobbyPlayers() {
  const list = document.getElementById('lobby-players');
  list.replaceChildren();
  players.forEach((player) => {
    const item = document.createElement('li');
    item.classList.toggle('offline', player.connected === false);
    item.style.setProperty('--player', player.color);
    item.innerHTML = '<span class="player-swatch"></span><span class="avatar"></span><span class="name"></span>';
    item.querySelector('.avatar').textContent = player.avatar;
    item.querySelector('.name').textContent = player.name;

    if (player.connected === false) {
      const offline = document.createElement('span');
      offline.className = 'offline-badge';
      offline.textContent = 'OFFLINE';
      item.append(offline);
    }
    if (player.playerIndex === 0) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'HOST';
      item.append(badge);
    } else if (isHost) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'remove-player';
      button.textContent = '×';
      button.title = `Remove ${player.name}`;
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await removePlayer(roomCode, player.playerIndex);
          showToast(`${player.name} removed from room.`);
        } catch (error) {
          console.error('Remove player failed:', error);
          showToast('Action failed — try again.');
          button.disabled = false;
        }
      });
      item.append(button);
    }
    list.append(item);
  });
}

async function setupLobby() {
  stopBackgroundMusic();
  document.getElementById('lobby-code').textContent = roomCode;
  document.getElementById('start-game').hidden = !isHost;
  document.getElementById('leave-lobby').disabled = false;
  showScreen('lobby');

  unsubscribeRoom?.();
  unsubscribeRoom = listenRoom(roomCode, {
    onPlayersChange: (roomPlayers, room) => {
      if (leavingRoom) return;
      const ownKey = `player_${playerIndex}`;
      if (!roomPlayers[ownKey] || roomPlayers[ownKey].uid !== auth.currentUser?.uid) {
        showToast('You were removed from the room.', 3000);
        cleanupAndGoHome();
        return;
      }
      isHost = room.meta?.hostUid === auth.currentUser?.uid;
      document.getElementById('start-game').hidden = !isHost;
      players = Object.entries(roomPlayers)
        .filter(([key, player]) => /^player_[0-3]$/.test(key) && player?.name)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, player]) => ({
          ...player,
          playerIndex: Number.parseInt(key.slice(7), 10),
          boxes: 0,
        }));
      renderLobbyPlayers();
    },
    onRoomDeleted: () => {
      if (!leavingRoom) showToast('The room was closed by the host.', 3000);
      cleanupAndGoHome();
    },
    onError: (error) => {
      console.error('Room listener failed:', error);
      showToast('Action failed — try again.');
    },
  });

  try {
    await setupDisconnectHandler(roomCode, playerIndex);
  } catch (error) {
    console.warn('Presence setup failed:', error);
    showToast('Presence update failed — reconnect to try again.');
  }
}

async function leaveCurrentRoom() {
  if (!roomCode || playerIndex === null) {
    cleanupAndGoHome();
    return;
  }
  leavingRoom = true;
  try {
    if (isHost) await deleteRoom(roomCode);
    else await leavePlayer(roomCode, playerIndex);
  } catch (error) {
    console.error('Leave room failed:', error);
    showToast('Action failed — try again.');
  } finally {
    cleanupAndGoHome();
  }
}

function handleGameComplete(result) {
  stopBackgroundMusic();
  const highest = Math.max(...result.winners.map((winner) => winner.boxes));
  const names = result.winners.map((winner) => winner.name);
  document.getElementById('result-summary').textContent = names.length === 1
    ? `${names[0]} wins with ${highest} boxes!`
    : `${names.join(' and ')} tie with ${highest} boxes!`;
  playSound('win');
  showScreen('results');
}

function startGame() {
  if (!isHost) return;
  if (players.length < 2) {
    playSound('error');
    showToast('At least 2 players are needed.');
    return;
  }
  showScreen('gameplay');
  startBackgroundMusic();
  document.getElementById('end-game').hidden = false;
  initializeBoard({ players, onComplete: handleGameComplete });
}

function previewPlayers() {
  return [
    { name: 'You', avatar: '🦊', color: '#2563eb' },
    { name: 'Maya', avatar: '🐼', color: '#db2777' },
    { name: 'Leo', avatar: '🦁', color: '#16a34a' },
    { name: 'Nova', avatar: '🦄', color: '#eab308' },
  ];
}

function wireShare() {
  document.getElementById('share-code').onclick = async () => {
    const link = roomLink();
    try {
      if (navigator.share) await navigator.share({ url: link });
      else {
        await navigator.clipboard.writeText(link);
        showToast('Room link copied.');
      }
    } catch (error) {
      if (error.name !== 'AbortError') showToast('Could not share room.');
    }
  };
  document.getElementById('show-qr').onclick = async () => {
    try {
      document.getElementById('qr-image').src = await QRCode.toDataURL(roomLink(), { width: 240, margin: 1 });
      document.getElementById('qr-dialog').showModal();
    } catch (error) {
      console.error('QR generation failed:', error);
      showToast('Could not create QR code.');
    }
  };
  document.getElementById('close-qr').onclick = () => document.getElementById('qr-dialog').close();
}

function wireMute() {
  const input = document.getElementById('mute');
  const icon = document.getElementById('mute-icon');
  const syncIcon = () => { icon.textContent = input.checked ? '🔇' : '🔊'; };
  input.checked = isMuted();
  input.onchange = () => {
    setMuted(input.checked);
    syncIcon();
  };
  syncIcon();
}

function wire() {
  const joinCodeInput = document.getElementById('join-code');
  joinCodeInput.addEventListener('input', () => {
    const normalized = normalizeTypedCode(joinCodeInput.value);
    if (joinCodeInput.value !== normalized) joinCodeInput.value = normalized;
  });
  document.getElementById('home-host').onclick = () => showScreen('create-room');
  document.getElementById('home-join').onclick = () => showScreen('join-room');
  document.querySelectorAll('[data-home]').forEach((button) => {
    button.onclick = () => roomCode ? leaveCurrentRoom() : showScreen('home');
  });

  document.getElementById('create-submit').onclick = async (event) => {
    const button = event.currentTarget;
    const name = validName('create-name');
    if (!name) return;
    button.disabled = true;
    try {
      const result = await createRoom(name, picked('create-avatar'), picked('create-color'));
      roomCode = result.roomCode;
      playerIndex = result.playerIndex;
      isHost = true;
      saveSession();
      await setupLobby();
    } catch (error) {
      console.error('Create room failed:', error);
      showToast('Action failed — try again.');
    } finally {
      button.disabled = false;
    }
  };

  document.getElementById('join-submit').onclick = async (event) => {
    const button = event.currentTarget;
    const code = normalizeTypedCode(joinCodeInput.value);
    const name = validName('join-name');
    if (!ROOM_CODE_RE.test(code)) {
      showToast('Enter a 4-letter room code.');
      return;
    }
    if (!name) return;
    button.disabled = true;
    try {
      const result = await joinRoom(code, name, picked('join-avatar'), picked('join-color'));
      if (!result.success) {
        showToast(result.reason || 'Unable to join room.');
        return;
      }
      roomCode = normalizeRoomCode(code);
      playerIndex = result.playerIndex;
      isHost = false;
      saveSession();
      await setupLobby();
    } catch (error) {
      console.error('Join room failed:', error);
      showToast('Action failed — try again.');
    } finally {
      button.disabled = false;
    }
  };

  document.getElementById('start-game').onclick = startGame;
  document.getElementById('leave-lobby').onclick = async (event) => {
    event.currentTarget.disabled = true;
    await leaveCurrentRoom();
  };
  document.getElementById('play-again').onclick = startGame;
  document.getElementById('end-game').onclick = async () => {
    if (!isHost || !confirm('End this game for everyone?')) return;
    await leaveCurrentRoom();
  };
  wireShare();
  wireMute();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then((registration) => {
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showToast('Update ready — refresh to apply.', 4000);
        }
      });
    });
  }).catch(() => {});
}

async function init() {
  buildPickers();
  wire();
  registerServiceWorker();

  const params = new URLSearchParams(location.search);
  if (params.get('preview') === 'gameplay') {
    isHost = true;
    players = previewPlayers();
    showScreen('gameplay');
    startBackgroundMusic();
    document.getElementById('end-game').hidden = false;
    initializeBoard({ players, onComplete: handleGameComplete });
    return;
  }

  try {
    await authReady;
  } catch (error) {
    console.error('Authentication failed:', error);
    showToast('Unable to connect securely. Check your internet connection.', 3500);
    showScreen('home');
    return;
  }

  const linkedRoom = normalizeTypedCode(params.get('room'));
  const saved = loadSession();
  const shouldRestore = saved && (!linkedRoom || linkedRoom === saved.roomCode);
  if (shouldRestore) {
    try {
      const restored = await restoreSession(saved.roomCode, saved.playerIndex);
      if (restored) {
        roomCode = restored.roomCode;
        playerIndex = restored.playerIndex;
        isHost = restored.isHost;
        saveSession();
        await setupLobby();
        return;
      }
    } catch (error) {
      console.warn('Session restoration failed:', error);
      showToast('Action failed — reconnect and try again.', 3000);
      showScreen('home');
      return;
    }
    clearSession();
  }

  if (ROOM_CODE_RE.test(linkedRoom)) {
    document.getElementById('join-code').value = linkedRoom;
    showScreen('join-room');
  } else {
    showScreen('home');
  }
}

init();
