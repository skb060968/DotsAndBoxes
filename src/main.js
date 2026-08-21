import QRCode from 'qrcode';
import { initializeBoard, renderBoardState } from './board-ui.js';
import { applyMove, createGameState } from './game-engine.js';
import { auth, authReady } from './firebase-config.js';
import {
  createRoom,
  commitSharedMove,
  deleteRoom,
  joinRoom,
  leavePlayer,
  listenRoom,
  normalizeRoomCode,
  removePlayer,
  resetSharedGame,
  restoreSession,
  setupDisconnectHandler,
  startSharedGame,
  stopPresenceTracking,
} from './firebase-sync.js';
import { showConfirm, showScreen, showToast } from './platform-ui.js';
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
let currentGame = null;
let displayedRound = null;
let resultsRound = null;
let pendingResultsRound = null;

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
  currentGame = null;
  displayedRound = null;
  resultsRound = null;
  pendingResultsRound = null;
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
          slotKey: key,
          playerIndex: Number.parseInt(key.slice(7), 10),
          boxes: Number(currentGame?.scores?.[key] || 0),
        }));
      renderLobbyPlayers();
    },
    onGameUpdate: (gameState) => {
      currentGame = gameState;
      if (gameState.status === 'finished') {
        if (displayedRound === gameState.roundId) renderBoardState(gameState);
        if (pendingResultsRound !== gameState.roundId && resultsRound !== gameState.roundId) {
          pendingResultsRound = gameState.roundId;
          setTimeout(() => showSharedResults(gameState), displayedRound === gameState.roundId ? 340 : 0);
        }
      } else {
        enterSharedGame(gameState);
      }
    },
    onStatusChange: (status, room) => {
      if (status === 'active' && room.game) enterSharedGame(room.game);
      if (status === 'lobby' && !leavingRoom) {
        currentGame = null;
        displayedRound = null;
        resultsRound = null;
        pendingResultsRound = null;
        stopBackgroundMusic();
        document.getElementById('start-game').hidden = !isHost;
        document.getElementById('start-game').disabled = false;
        showScreen('lobby');
      }
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

/**
 * iPad/iOS Safari can lay out the gameplay screen before the viewport settles,
 * so the fixed-height (svh) grid overflows and hides the player cards/controls
 * until the first interaction forces a reflow. Nudging a relayout across a few
 * frames (and shortly after) makes it settle immediately, like phones do.
 */
function refitGameScreen() {
  const el = document.getElementById('gameplay');
  if (!el) return;
  const nudge = () => {
    if (el.hidden) return;
    void el.offsetHeight;
    window.dispatchEvent(new Event('resize'));
  };
  requestAnimationFrame(() => { nudge(); requestAnimationFrame(nudge); });
  setTimeout(nudge, 140);
  setTimeout(nudge, 320);
}

function enterSharedGame(gameState) {
  if (!gameState || gameState.status !== 'playing') return;
  currentGame = gameState;
  const wasHidden = document.getElementById('gameplay')?.hidden !== false;
  showScreen('gameplay');
  if (wasHidden) refitGameScreen();
  startBackgroundMusic();
  document.getElementById('end-game').hidden = !isHost;
  const localKey = `player_${playerIndex}`;
  if (displayedRound !== gameState.roundId) {
    displayedRound = gameState.roundId;
    initializeBoard({
      players,
      localPlayerKey: localKey,
      game: gameState,
      onMoveRequest: (start, end, revision) => commitSharedMove(roomCode, playerIndex, revision, start, end),
    });
  } else {
    renderBoardState(gameState);
  }
}

function renderResultStandings(gameState) {
  const list = document.getElementById('result-standings');
  if (!list) return;
  list.replaceChildren();
  const ranked = players
    .map((player) => ({ ...player, boxes: Number(gameState.scores?.[player.slotKey] || 0) }))
    .sort((a, b) => b.boxes - a.boxes);
  ranked.forEach((player, index) => {
    const isWinner = Boolean(gameState.winnerKeys?.[player.slotKey]);
    const item = document.createElement('li');
    item.className = `standing${isWinner ? ' winner' : ''}`;
    item.style.setProperty('--player', player.color);
    const rank = document.createElement('span');
    rank.className = 'standing-rank';
    rank.textContent = isWinner ? '🏆' : `#${index + 1}`;
    const avatar = document.createElement('span');
    avatar.className = 'standing-avatar';
    avatar.textContent = player.avatar;
    const name = document.createElement('span');
    name.className = 'standing-name';
    name.textContent = player.name;
    const score = document.createElement('span');
    score.className = 'standing-score';
    score.textContent = `${player.boxes} box${player.boxes === 1 ? '' : 'es'}`;
    item.append(rank, avatar, name, score);
    list.append(item);
  });
}

function showSharedResults(gameState) {
  if (!gameState || gameState.status !== 'finished') return;
  currentGame = gameState;
  pendingResultsRound = null;
  stopBackgroundMusic();
  const winners = players.filter((player) => gameState.winnerKeys?.[player.slotKey]);
  const highest = Math.max(...players.map((player) => Number(gameState.scores?.[player.slotKey] || 0)));
  const names = winners.map((winner) => winner.name);
  document.getElementById('result-summary').textContent = names.length === 1
    ? `${names[0]} wins with ${highest} boxes!`
    : `${names.join(' and ')} tie with ${highest} boxes!`;
  renderResultStandings(gameState);
  const playAgain = document.getElementById('play-again');
  playAgain.hidden = !isHost;
  playAgain.disabled = false;
  playAgain.textContent = 'New Game';
  if (resultsRound !== gameState.roundId) {
    resultsRound = gameState.roundId;
    playSound('win');
  }
  showScreen('results');
}

async function startGame() {
  if (!isHost) return;
  if (players.length < 2) {
    playSound('error');
    showToast('At least 2 players are needed.');
    return;
  }
  const button = document.getElementById('start-game');
  button.disabled = true;
  try {
    await startSharedGame(roomCode);
  } catch (error) {
    console.error('Start game failed:', error);
    playSound('error');
    showToast(error?.message || 'Action failed — try again.');
    button.disabled = false;
  }
}

function previewPlayers() {
  return [
    { slotKey: 'player_0', name: 'You', avatar: '🦊', color: '#2563eb' },
    { slotKey: 'player_1', name: 'Maya', avatar: '🐼', color: '#db2777' },
    { slotKey: 'player_2', name: 'Leo', avatar: '🦁', color: '#16a34a' },
    { slotKey: 'player_3', name: 'Nova', avatar: '🦄', color: '#eab308' },
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
  let unsubscribeJoinPreview = null;
  let previewedCode = null;

  const applyTakenColors = (takenColors = []) => {
    const taken = new Set(takenColors);
    const buttons = [...document.querySelectorAll('[data-picker="join-color"] .color-pick')];
    buttons.forEach((button) => {
      const unavailable = taken.has(button.dataset.value);
      const label = button.dataset.colorLabel || button.getAttribute('aria-label');
      button.dataset.colorLabel = label;
      button.disabled = unavailable;
      button.classList.toggle('taken', unavailable);
      button.setAttribute('aria-disabled', String(unavailable));
      button.title = unavailable ? `${label} is already taken` : label;
    });
    const selected = buttons.find((button) => button.getAttribute('aria-pressed') === 'true');
    if (!selected || selected.disabled) {
      selected?.setAttribute('aria-pressed', 'false');
      buttons.find((button) => !button.disabled)?.setAttribute('aria-pressed', 'true');
    }
  };

  const stopJoinPreview = () => {
    unsubscribeJoinPreview?.();
    unsubscribeJoinPreview = null;
    previewedCode = null;
    applyTakenColors();
  };

  const startJoinPreview = (code) => {
    if (!ROOM_CODE_RE.test(code)) {
      stopJoinPreview();
      return;
    }
    if (code === previewedCode && unsubscribeJoinPreview) return;
    stopJoinPreview();
    previewedCode = code;
    unsubscribeJoinPreview = listenRoom(code, {
      onPlayersChange: (roomPlayers) => {
        applyTakenColors(Object.values(roomPlayers).map((player) => player?.color).filter(Boolean));
      },
      onRoomDeleted: () => applyTakenColors(),
      onError: (error) => {
        console.warn('Join color preview failed:', error);
        applyTakenColors();
      },
    });
  };

  joinCodeInput.addEventListener('input', () => {
    const normalized = normalizeTypedCode(joinCodeInput.value);
    if (joinCodeInput.value !== normalized) joinCodeInput.value = normalized;
    startJoinPreview(normalized);
  });
  document.getElementById('home-host').onclick = () => showScreen('create-room');
  document.getElementById('home-join').onclick = () => {
    stopJoinPreview();
    showScreen('join-room');
  };
  document.querySelectorAll('[data-home]').forEach((button) => {
    button.onclick = () => {
      stopJoinPreview();
      return roomCode ? leaveCurrentRoom() : showScreen('home');
    };
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
      stopJoinPreview();
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
  document.getElementById('play-again').onclick = async (event) => {
    if (!isHost) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await resetSharedGame(roomCode);
    } catch (error) {
      console.error('New game reset failed:', error);
      showToast('Action failed — try again.');
      button.disabled = false;
    }
  };
  document.getElementById('end-game').onclick = async () => {
    if (!isHost) return;
    const confirmed = await showConfirm('End this game for everyone?', {
      confirmText: 'End game',
      cancelText: 'Keep playing',
    });
    if (!confirmed) return;
    await leaveCurrentRoom();
  };
  wireShare();
  wireMute();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const toast = document.getElementById('update-toast');
  const message = document.getElementById('update-message');
  const updateButton = document.getElementById('update-now');
  const laterButton = document.getElementById('update-later');
  let waitingWorker = null;
  let updateAccepted = false;
  let reloadStarted = false;

  const setProgress = (updating, text = null) => {
    updateButton.disabled = updating;
    laterButton.disabled = updating;
    updateButton.textContent = updating ? 'Updating…' : 'Update app';
    message.textContent = text || (updating
      ? 'Applying update… The app will reload automatically.'
      : 'Update now, or choose Later to keep playing.');
    toast.setAttribute('aria-busy', String(updating));
  };

  const showUpdate = (worker) => {
    waitingWorker = worker || waitingWorker;
    updateAccepted = false;
    setProgress(false);
    toast.hidden = false;
  };

  updateButton.addEventListener('click', () => {
    if (updateAccepted) return;
    updateAccepted = true;
    setProgress(true);
    if (!waitingWorker) {
      requestAnimationFrame(() => requestAnimationFrame(() => location.reload()));
      return;
    }
    try {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } catch (error) {
      console.warn('Could not activate app update:', error);
      updateAccepted = false;
      setProgress(false, 'Update could not start. Please try again.');
      updateButton.textContent = 'Try again';
    }
  });

  laterButton.addEventListener('click', () => {
    if (!updateAccepted) toast.hidden = true;
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateAccepted || reloadStarted) return;
    reloadStarted = true;
    location.reload();
  });

  const start = () => navigator.serviceWorker.register('/sw.js').then((registration) => {
    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdate(registration.waiting);
    }
    setInterval(() => registration.update(), 5 * 60 * 1000);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdate(registration.waiting || worker);
        }
      });
    });
  }).catch((error) => console.warn('Service worker registration failed:', error));

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

async function init() {
  buildPickers();
  wire();
  registerServiceWorker();

  const params = new URLSearchParams(location.search);
  if (params.get('preview') === 'gameplay') {
    isHost = true;
    players = previewPlayers();
    let previewGame = createGameState(players.map((player) => player.slotKey), 'preview');
    showScreen('gameplay');
    refitGameScreen();
    startBackgroundMusic();
    document.getElementById('end-game').hidden = false;
    initializeBoard({
      players,
      localPlayerKey: '*',
      game: previewGame,
      onMoveRequest: async (start, end) => {
        const activePreviewKey = previewGame.playerOrder[previewGame.currentPlayerIndex];
        previewGame = applyMove(previewGame, activePreviewKey, start, end, 'preview');
        return previewGame;
      },
    });
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
    const input = document.getElementById('join-code');
    input.value = linkedRoom;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    showScreen('join-room');
  } else {
    showScreen('home');
  }
}

init();
