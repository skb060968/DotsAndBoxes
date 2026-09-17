// On-device diagnostics: records failures to localStorage and adds a 5-tap
// viewer with a Copy button. Import-only integration; must come first so
// startup errors are captured too.
import './diagnostics.js';

import QRCode from 'qrcode';
import { initializeBoard, renderBoardState, setActiveSpeakers } from './board-ui.js';
import { applyMove, createGameState, playerOrder } from './game-engine.js';
import { auth, authReady } from './firebase-config.js';
import {
  createRoom,
  commitForfeitWin,
  commitSharedMove,
  commitSkipOfflineTurn,
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
import { maybeShowAppBanner } from './install-banner.js';
import { mountVoiceChat } from './voice-chat-widget.js';
import {
  isMuted,
  playSound,
  setMuted,
  startBackgroundMusic,
  stopBackgroundMusic,
} from './sound-manager.js';

const AVATARS = ['🥷', '🧙', '🦸', '👷', '🤴', '👸', '🧝', '🧛'];
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
let voiceWidget = null;

/* Lobby presence: a dropped player lingers briefly with the OFFLINE treatment,
   then is pruned from the list (the host and the local player are never hidden). */
const LOBBY_PRUNE_DELAY_MS = 2500;
let disconnectedSince = {};
let lobbyPruneTimer = null;

/* Offline watchdog (gameplay). There is no host loop in this game — every player
   commits their own move — so the FIRST CONNECTED player in turn order acts as
   the watchdog: after the grace period they pass the turn over an offline player,
   or, if they are the only one left, take the win. */
const OFFLINE_GRACE_MS = 15000;   // survive a lift/tunnel, but don't leave the table dead
const MAX_OFFLINE_SKIPS = 2;      // after this many consecutive misses, skip without waiting
let offlineTurnTimer = null;
let offlineTurnKey = null;        // generation the timer was armed for
let offlineSkips = {};            // slotKey -> consecutive skipped turns

const localKey = () => (playerIndex != null ? `player_${playerIndex}` : null);

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
  if (voiceWidget) { try { voiceWidget.stop(); } catch (_) {} }
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
  clearOfflineTurnWatch();
  offlineSkips = {};
  updateSkipOfflineButton();
}

function cleanupAndGoHome() {
  releaseRoomState();
  showScreen('home');
}

/* ======= OFFLINE WATCHDOG (gameplay) ======= */

/** A PEER (never this device) is offline. While a device is itself offline its own
 *  slot can read `connected: false` from its queued presence write, so it must never
 *  treat *itself* as the dropped player. */
function peerOffline(key) {
  if (!key || key === localKey()) return false;
  return players.find((p) => p.slotKey === key)?.connected === false;
}

/** Seats actually in this game (players who were offline at start are not dealt in). */
function gameSeats(game = currentGame) {
  return playerOrder(game).filter((key) => players.some((p) => p.slotKey === key));
}

/** The one device that runs the watchdog: the first connected seat in turn order. */
function watchdogKey() {
  return gameSeats().find((key) => key === localKey() || !peerOffline(key)) || null;
}

const gameIsLive = () => Boolean(roomCode) && Boolean(currentGame) && currentGame.status === 'playing';
const turnGeneration = (g) => `${g.roundId}:${g.revision}:${g.currentPlayerKey}`;

/** True when this device is the ONLY connected seat in a live game with 2+ seats. */
function canClaimWin() {
  if (!gameIsLive()) return false;
  const seats = gameSeats();
  return seats.length >= 2 && seats.includes(localKey()) && seats.every((key) => key === localKey() || peerOffline(key));
}

function clearOfflineTurnWatch() {
  if (offlineTurnTimer) { clearTimeout(offlineTurnTimer); offlineTurnTimer = null; }
  offlineTurnKey = null;
}

/** Re-evaluated on every room snapshot: arm, re-arm or cancel the watchdog. */
function evaluateOfflineWatch() {
  if (!gameIsLive() || watchdogKey() !== localKey()) { clearOfflineTurnWatch(); updateSkipOfflineButton(); return; }

  const cur = currentGame.currentPlayerKey;
  if (canClaimWin()) {
    const gen = `${currentGame.roundId}:claim`;
    if (offlineTurnKey !== gen) {
      clearOfflineTurnWatch();
      offlineTurnKey = gen;
      offlineTurnTimer = setTimeout(() => { offlineTurnTimer = null; claimWinAsRemainingPlayer(); }, OFFLINE_GRACE_MS);
    }
  } else if (peerOffline(cur)) {
    const gen = turnGeneration(currentGame);
    if (offlineTurnKey !== gen) {
      clearOfflineTurnWatch();
      offlineTurnKey = gen;
      // Someone who has already missed their last turns is gone for good: don't
      // make the table wait a full grace period every lap.
      const wait = (offlineSkips[cur] || 0) >= MAX_OFFLINE_SKIPS ? 0 : OFFLINE_GRACE_MS;
      offlineTurnTimer = setTimeout(() => { offlineTurnTimer = null; skipOfflineTurn(gen); }, wait);
    }
  } else {
    if (cur) offlineSkips[cur] = 0;          // present again — forgive earlier misses
    clearOfflineTurnWatch();
  }
  updateSkipOfflineButton();
}

async function skipOfflineTurn(gen) {
  if (!gameIsLive() || turnGeneration(currentGame) !== gen) return;   // play already moved on
  const cur = currentGame.currentPlayerKey;
  if (!peerOffline(cur)) return;                                        // came back in time
  const name = players.find((p) => p.slotKey === cur)?.name || 'That player';
  try {
    const next = await commitSkipOfflineTurn(roomCode, playerIndex, currentGame.revision);
    if (next) {
      offlineSkips[cur] = (offlineSkips[cur] || 0) + 1;
      showToast(`${name} is offline — turn skipped.`, 2600);
    }
  } catch (error) {
    console.error('Skip offline turn failed:', error);
  }
}

async function claimWinAsRemainingPlayer() {
  if (!canClaimWin()) return;
  clearOfflineTurnWatch();
  try {
    const next = await commitForfeitWin(roomCode, playerIndex, currentGame.revision);
    if (next) showToast('Everyone else went offline — you win.', 3500);
  } catch (error) {
    console.error('Claim win failed:', error);
    showToast('Could not claim the win — try again.', 3000);
  }
}

/** Shortcut so the watchdog player need not sit out the grace period. */
function updateSkipOfflineButton() {
  const btn = document.getElementById('btn-skip-offline');
  if (!btn) return;
  const mine = gameIsLive() && watchdogKey() === localKey();
  if (mine && canClaimWin()) {
    btn.hidden = false;
    btn.textContent = '🏁 Claim win';
    btn.title = 'Everyone else is offline — take the win now';
    return;
  }
  const cur = mine ? currentGame.currentPlayerKey : null;
  const show = Boolean(cur) && peerOffline(cur);
  btn.hidden = !show;
  if (!show) return;
  const name = players.find((p) => p.slotKey === cur)?.name || 'player';
  btn.textContent = `⏭ Skip ${name}`;
  btn.title = `${name} is offline — pass the turn now`;
}

/* ======= VOICE CHAT (optional, LiveKit, voice-only) =======
 * Uses the standardized self-contained widget (see voice-chat-widget.js).
 * Mounted lazily on game start; torn down when leaving the room.
 */

function mountVoice() {
  if (voiceWidget || !roomCode || playerIndex === null) return;
  voiceWidget = mountVoiceChat({
    mount: '#voice-widget',
    game: 'dots',
    getRoomCode: () => roomCode,
    getIdentity: () => (playerIndex !== null ? `player_${playerIndex}` : null),
    getDisplayName: () => players.find((player) => player.playerIndex === playerIndex)?.name || `Player ${playerIndex + 1}`,
    getIdToken: async () => (await authReady).getIdToken(),
    onSpeakers: (identities) => setActiveSpeakers(identities),
    notify: (message) => showToast(message),
  });
}

/** Players that count toward the roster — connected ones only (Start gate). */
function connectedLobbyPlayers() {
  return players.filter((player) => player.connected !== false);
}

/** Whether a player should still appear in the lobby list. Connected players,
    the host, and the local player always show; a dropped player lingers with
    the OFFLINE treatment for a short window and is then pruned. */
function isVisibleInLobby(player) {
  if (player.connected !== false) return true;
  if (player.playerIndex === 0 || player.playerIndex === playerIndex) return true;
  const since = disconnectedSince[player.slotKey];
  return typeof since === 'number' && Date.now() - since < LOBBY_PRUNE_DELAY_MS;
}

/** Track when each player first went offline so the list can prune them inside
    the linger window while still showing the state change first. */
function trackDisconnections() {
  const stamp = Date.now();
  const next = {};
  let pruneNeeded = false;
  players.forEach((player) => {
    if (player.connected === false) {
      next[player.slotKey] = disconnectedSince[player.slotKey] || stamp;
      const prunable = player.playerIndex !== 0 && player.playerIndex !== playerIndex;
      if (prunable && stamp - next[player.slotKey] < LOBBY_PRUNE_DELAY_MS) pruneNeeded = true;
    }
  });
  disconnectedSince = next;
  if (!pruneNeeded || lobbyPruneTimer !== null) return;
  lobbyPruneTimer = setTimeout(() => {
    lobbyPruneTimer = null;
    renderLobbyPlayers();
  }, LOBBY_PRUNE_DELAY_MS);
}

function renderLobbyPlayers() {
  const list = document.getElementById('lobby-players');
  list.replaceChildren();
  const startBtn = document.getElementById('start-game');
  if (startBtn && isHost) startBtn.disabled = connectedLobbyPlayers().length < 2;
  players.filter(isVisibleInLobby).forEach((player) => {
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
      trackDisconnections();
      renderLobbyPlayers();
    },
    onGameUpdate: (gameState) => {
      currentGame = gameState;
      evaluateOfflineWatch();   // `players` is already refreshed for this snapshot
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
        clearOfflineTurnWatch();
        offlineSkips = {};
        updateSkipOfflineButton();
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
/**
 * iPad Safari paints the gameplay screen before it settles, leaving the player
 * cards, outer dot rows and controls unpainted until a touch forces a repaint.
 * Toggling a compositing property (an invisible transform) at a few settle
 * points forces the whole screen to paint immediately, without needing a tap.
 */
function refitGameScreen() {
  const el = document.getElementById('gameplay');
  if (!el) return;
  const repaint = () => {
    if (el.hidden) return;
    void el.offsetHeight;
    el.style.transform = 'translateZ(0)';
    void el.offsetHeight;
    el.style.transform = '';
  };
  requestAnimationFrame(() => requestAnimationFrame(repaint));
  [120, 300, 600].forEach((delay) => setTimeout(repaint, delay));
}

function enterSharedGame(gameState) {
  if (!gameState || gameState.status !== 'playing') return;
  currentGame = gameState;
  const wasHidden = document.getElementById('gameplay')?.hidden !== false;
  showScreen('gameplay');
  if (wasHidden) refitGameScreen();
  startBackgroundMusic();
  mountVoice();
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
  const summary = document.getElementById('result-summary');
  if (gameState.operation?.type === 'forfeit') {
    // The win came from everyone else dropping out, not from the board — say so,
    // otherwise the result looks like it came from nowhere.
    summary.textContent = `${names[0] || 'The remaining player'} wins — everyone else went offline.`;
  } else {
    summary.textContent = names.length === 1
      ? `${names[0]} wins with ${highest} boxes!`
      : `${names.join(' and ')} tie with ${highest} boxes!`;
  }
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
  if (connectedLobbyPlayers().length < 2) {
    playSound('error');
    showToast('At least 2 connected players are needed.');
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
    { slotKey: 'player_0', name: 'You', avatar: '🥷', color: '#2563eb' },
    { slotKey: 'player_1', name: 'Maya', avatar: '🧙', color: '#db2777' },
    { slotKey: 'player_2', name: 'Leo', avatar: '🦸', color: '#16a34a' },
    { slotKey: 'player_3', name: 'Nova', avatar: '👷', color: '#eab308' },
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
  const button = document.getElementById('mute');
  if (!button) return;
  const render = (muted) => {
    button.textContent = muted ? '🔇' : '🔊';
    button.setAttribute('aria-pressed', String(muted));
    button.setAttribute('aria-label', muted ? 'Unmute game sound' : 'Mute game sound');
  };
  render(isMuted());
  button.onclick = () => {
    const next = !isMuted();
    setMuted(next);
    render(next);
  };
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
  document.getElementById('home-help').onclick = () => showScreen('how-to');
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
  // Resolve a stalled turn at once rather than waiting out the grace period.
  document.getElementById('btn-skip-offline')?.addEventListener('click', () => {
    if (!gameIsLive() || watchdogKey() !== localKey()) return;
    if (canClaimWin()) { claimWinAsRemainingPlayer(); return; }
    const gen = turnGeneration(currentGame);
    if (!peerOffline(currentGame.currentPlayerKey)) return;
    clearOfflineTurnWatch();
    skipOfflineTurn(gen);
  });
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
    // Arrived via a shared room link in a browser tab → offer the app (same as the
    // other games). Chrome's own install dialog is suppressed in install-banner.js.
    maybeShowAppBanner();
  } else if (!document.getElementById('home')?.hasAttribute('hidden')
    || !document.querySelector('.screen:not([hidden])')) {
    // Anonymous sign-in takes a network round-trip on a first visit, and the home
    // buttons are already live — so the player may have opened Create/Join and
    // started typing by now. Only fall back to home if they have not moved on;
    // otherwise this yanked them back mid-word (looked exactly like a refresh).
    showScreen('home');
  }
}

init();
