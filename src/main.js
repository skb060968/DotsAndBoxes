/**
 * Main UI Controller — Dots and Boxes (Modified Gameplay)
 * Handles all screens, SVG rendering, and game interaction
 */

import { initFirebase } from './firebase-config.js';
import { initRecovery } from './firebase-recovery.js';
import {
  createRoom,
  joinRoom,
  listenRoom,
  deleteRoom,
  setupDisconnectHandler,
  restoreConnection,
  removePlayer,
  PLAYER_COLORS,
} from './firebase-sync.js';
import {
  startGame,
  drawLine,
  applyLine,
  updateGameState,
  saveRankings,
  initializeGame,
  isGameOver,
  getWinners,
  computeFinalRankings,
  GRID_COLS,
  GRID_ROWS,
  PHASES,
  areAdjacent,
  getLineKeyBetweenDots,
  parseLineKey,
} from './game-manager.js';
import {
  saveSession,
  loadSession,
  clearSession,
} from './session.js';
import { initAudio, playSound, toggleMute, isMuted } from './audio-manager.js';
import {
  initDeepLinkHandler,
  createShareHandler,
  setShowToast,
} from './deep-link-handler.js';

// Constants
const DOT_RADIUS = 8;
const DOT_SPACING = 60;
const LINE_STROKE_WIDTH = 4;
const GRID_PADDING = 40;
const TOAST_DURATION = 3000;
const GAME_NAME = 'Dots and Boxes';

// Room / session state
let roomCode = null;
let playerIndex = -1;
let isHost = false;
let playerName = '';
let roomListener = null;

// Current game data
let currentMeta = {};
let currentPlayers = {};
let currentGame = null;
let currentStatus = 'lobby';

// UI state
let selectedDot = null;
let currentScreen = 'menuScreen';
<<<<<<< HEAD
let selectedCreateAvatar = PLAYER_AVATARS[0];
let selectedJoinAvatar = PLAYER_AVATARS[0];
=======
let selectedCreateColor = PLAYER_COLORS[0];
let selectedJoinColor = PLAYER_COLORS[0];

>>>>>>> a6cbb7267daf1a4839e031b53dfb7977f07827d7
// ============================================================================
// Screen Management
// ============================================================================

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((screen) => {
    screen.setAttribute('hidden', '');
  });
  const target = document.getElementById(screenId);
  if (target) {
    target.removeAttribute('hidden');
    currentScreen = screenId;
  }
}

function showLoading(message = 'Loading...') {
  const el = document.getElementById('loadingOverlay');
  const msg = document.getElementById('loadingMessage');
  if (el) el.removeAttribute('hidden');
  if (msg) msg.textContent = message;
}

function hideLoading() {
  const el = document.getElementById('loadingOverlay');
  if (el) el.setAttribute('hidden', '');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  container.appendChild(toast);

  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, TOAST_DURATION);
}

function announce(message) {
  const el = document.getElementById('ariaAnnouncer');
  if (!el) return;
  el.textContent = message;
}

// ============================================================================
// Color Picker
// ============================================================================

function renderColorPicker(containerId, onSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';
  PLAYER_COLORS.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-btn';
    btn.textContent = emoji;
    btn.setAttribute('aria-label', `Select ${emoji} color`);
    btn.addEventListener('click', () => {
      container.querySelectorAll('.color-btn').forEach((b) =>
        b.classList.remove('selected')
      );
      btn.classList.add('selected');
      onSelect(emoji);
    });
    container.appendChild(btn);
  });

  // Auto-select first
  const firstBtn = container.querySelector('.color-btn');
  if (firstBtn) {
    firstBtn.classList.add('selected');
    onSelect(PLAYER_COLORS[0]);
  }
}

function initColorPickers() {
  renderColorPicker('createColorPicker', (emoji) => {
    selectedCreateColor = emoji;
  });
  renderColorPicker('joinColorPicker', (emoji) => {
    selectedJoinColor = emoji;
  });
}

// ============================================================================
// Room Management
// ============================================================================

async function handleCreateRoom(event) {
  event.preventDefault();
  const nameInput = document.getElementById('createNameInput');
  const name = nameInput.value.trim();

  if (!name) {
    showToast('Please enter your name', 'error');
    nameInput.focus();
    return;
  }

  try {
    showLoading('Creating room...');
    const result = await createRoom(name, selectedCreateColor);
    roomCode = result.roomCode;
    playerIndex = result.playerIndex;
    isHost = true;
    playerName = name;

    saveSession({ roomCode, playerIndex, isHost, playerName });
    await setupDisconnectHandler(roomCode, playerIndex);
    startRoomListener();

    showScreen('lobbyScreen');
    document.getElementById('lobbyRoomCode').textContent = roomCode;
    hideLoading();
    announce(`Room ${roomCode} created`);
    playSound('tap');
  } catch (err) {
    hideLoading();
    showToast(err.message || 'Failed to create room', 'error');
    console.error('[create]', err);
  }
}

async function handleJoinRoom(event) {
  event.preventDefault();
  const codeInput = document.getElementById('joinCodeInput');
  const nameInput = document.getElementById('joinNameInput');
  const code = codeInput.value.trim().toUpperCase();
  const name = nameInput.value.trim();

  if (!code || !name) {
    showToast('Please enter room code and name', 'error');
    return;
  }

  try {
    showLoading('Joining room...');
    const result = await joinRoom(code, name, selectedJoinColor);
    roomCode = code;
    playerIndex = result.playerIndex;
    isHost = false;
    playerName = name;

    saveSession({ roomCode, playerIndex, isHost, playerName });
    await setupDisconnectHandler(roomCode, playerIndex);
    startRoomListener();

    hideLoading();
    announce(`Joined room ${roomCode}`);
    playSound('tap');
  } catch (err) {
    hideLoading();
    showToast(err.message || 'Failed to join room', 'error');
    console.error('[join]', err);
  }
}

async function handleLeaveRoom() {
  if (!roomCode) return;

  const confirmed = confirm('Leave this game?');
  if (!confirmed) return;

  try {
    if (isHost) {
      await deleteRoom(roomCode);
    } else {
      await removePlayer(roomCode, playerIndex);
    }
    cleanupRoom();
    showScreen('menuScreen');
    announce('Left room');
  } catch (err) {
    showToast('Failed to leave room', 'error');
    console.error('[leave]', err);
  }
}

// ============================================================================
// Room Listener
// ============================================================================

function startRoomListener() {
  if (roomListener) {
    roomListener();
    roomListener = null;
  }

  roomListener = listenRoom(roomCode, {
    onMetaChange: (meta) => {
      currentMeta = meta;
      updateLobby();
    },
    onStatusChange: (status) => {
      currentStatus = status;
      if (status === 'playing' && currentScreen === 'lobbyScreen') {
        showScreen('gameScreen');
        renderGame();
        announce('Game started');
        playSound('music');
      }
      if (status === 'finished' && currentScreen === 'gameScreen') {
        showVictory();
      }
    },
    onPlayersChange: (players) => {
      currentPlayers = players;
      updateLobby();
      if (currentScreen === 'gameScreen') {
        renderPlayerCards();
      }
    },
    onGameUpdate: (game, status) => {
      currentGame = game;
      if (status === 'playing' && currentScreen === 'gameScreen') {
        renderGame();
      }
      if (status === 'finished' && currentScreen === 'gameScreen') {
        showVictory();
      }
    },
    onRoomDeleted: () => {
      cleanupRoom();
      showToast('Room has been closed', 'info');
      showScreen('menuScreen');
    },
  });
}

function cleanupRoom() {
  if (roomListener) {
    roomListener();
    roomListener = null;
  }
  clearSession();
  roomCode = null;
  playerIndex = -1;
  isHost = false;
  currentMeta = {};
  currentPlayers = {};
  currentGame = null;
  currentStatus = 'lobby';
  selectedDot = null;
}

// ============================================================================
// Lobby Screen
// ============================================================================

function updateLobby() {
  if (currentScreen !== 'lobbyScreen') return;

  const list = document.getElementById('lobbyPlayerList');
  if (!list) return;

  list.innerHTML = '';

  const playerEntries = Object.entries(currentPlayers).sort((a, b) => {
    const indexA = parseInt(a[0].split('_')[1]);
    const indexB = parseInt(b[0].split('_')[1]);
    return indexA - indexB;
  });

  playerEntries.forEach(([key, player]) => {
    const index = parseInt(key.split('_')[1]);
    const color = player.color || PLAYER_COLORS[index];
    const connected = player.connected !== false;

    const item = document.createElement('div');
    item.className = `lobby-player ${!connected ? 'disconnected' : ''}`;
    item.innerHTML = `
      <span class="player-color">${color}</span>
      <span class="player-name">${player.name}</span>
      ${!connected ? '<span class="status-badge">Disconnected</span>' : ''}
    `;
    list.appendChild(item);
  });

  // Update start button
  const startBtn = document.getElementById('startGameBtn');
  if (startBtn) {
    const playerCount = Object.keys(currentPlayers).length;
    startBtn.disabled = !isHost || playerCount < 2;
    startBtn.textContent = playerCount < 2
      ? 'Waiting for players...'
      : 'Start Game';
  }

  // Keep room code display in sync (e.g. after session restore)
  const codeEl = document.getElementById('lobbyRoomCode');
  if (codeEl && roomCode) codeEl.textContent = roomCode;
}

async function handleStartGame() {
  if (!isHost || !roomCode) return;

  try {
    showLoading('Starting game...');
    // Build a proper initialState using the pure game-manager helper
    const initialState = initializeGame(currentPlayers);
    const result = await startGame(roomCode, initialState, { isHost: true });
    hideLoading();
    if (!result.ok) {
      showToast(result.message || 'Failed to start game', 'error');
    }
  } catch (err) {
    hideLoading();
    showToast(err.message || 'Failed to start game', 'error');
    console.error('[start]', err);
  }
}

// ============================================================================
// Game Screen — SVG Grid Rendering
// ============================================================================

function renderGame() {
  renderGrid();
  renderPlayerCards();
  updateTurnIndicator();
}

function renderGrid() {
  const svg = document.getElementById('gameGrid');
  if (!svg) return;

  svg.innerHTML = '';

  const gridWidth = (GRID_COLS - 1) * DOT_SPACING + 2 * GRID_PADDING;
  const gridHeight = (GRID_ROWS - 1) * DOT_SPACING + 2 * GRID_PADDING;
  svg.setAttribute('viewBox', `0 0 ${gridWidth} ${gridHeight}`);
  svg.setAttribute('width', gridWidth);
  svg.setAttribute('height', gridHeight);

  const boxesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  boxesLayer.id = 'boxesLayer';
  svg.appendChild(boxesLayer);

  const linesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  linesLayer.id = 'linesLayer';
  svg.appendChild(linesLayer);

  const dotsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  dotsLayer.id = 'dotsLayer';
  svg.appendChild(dotsLayer);

  renderBoxes(boxesLayer);
  renderLines(linesLayer);
  renderDots(dotsLayer);
}

function renderBoxes(layer) {
  if (!currentGame?.boxes) return;

  Object.entries(currentGame.boxes).forEach(([key, boxData]) => {
    // Box keys are "col_row" (underscore-separated), not comma-separated
    const parts = key.split('_');
    const col = Number(parts[0]);
    const row = Number(parts[1]);
    if (!Number.isFinite(col) || !Number.isFinite(row)) return;

    const x = GRID_PADDING + col * DOT_SPACING;
    const y = GRID_PADDING + row * DOT_SPACING;

    // boxData is {playerId, completedAt} — extract numeric player index from playerId
    const playerId = boxData?.playerId ?? boxData;
    const ownerIndex = typeof playerId === 'string'
      ? parseInt(playerId.split('_')[1], 10)
      : Number(playerId);

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', DOT_SPACING);
    rect.setAttribute('height', DOT_SPACING);
    rect.setAttribute('class', `box box-${ownerIndex}`);
    rect.setAttribute('data-owner', ownerIndex);

    layer.appendChild(rect);
  });
}

function renderLines(layer) {
  if (!currentGame?.lines) return;

  Object.entries(currentGame.lines).forEach(([key, lineData]) => {
    // Line keys are "h_col_row" or "v_col_row" — use parseLineKey helper
    const parsed = parseLineKey(key);
    if (!parsed) return;

    const { type: dir, col: c, row: r } = parsed;

    // lineData is {playerId, timestamp} — extract numeric player index
    const playerId = lineData?.playerId ?? lineData;
    const ownerIndex = typeof playerId === 'string'
      ? parseInt(playerId.split('_')[1], 10)
      : Number(playerId);

    let x1, y1, x2, y2;

    if (dir === 'h') {
      x1 = GRID_PADDING + c * DOT_SPACING;
      y1 = GRID_PADDING + r * DOT_SPACING;
      x2 = x1 + DOT_SPACING;
      y2 = y1;
    } else {
      x1 = GRID_PADDING + c * DOT_SPACING;
      y1 = GRID_PADDING + r * DOT_SPACING;
      x2 = x1;
      y2 = y1 + DOT_SPACING;
    }

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('class', `line line-${ownerIndex}`);
    line.setAttribute('data-owner', ownerIndex);
    line.setAttribute('stroke-width', LINE_STROKE_WIDTH);

    layer.appendChild(line);
  });
}

function renderDots(layer) {
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const x = GRID_PADDING + col * DOT_SPACING;
      const y = GRID_PADDING + row * DOT_SPACING;

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', x);
      circle.setAttribute('cy', y);
      circle.setAttribute('r', DOT_RADIUS);
      circle.setAttribute('class', 'dot');
      circle.setAttribute('data-col', col);
      circle.setAttribute('data-row', row);
      circle.style.cursor = 'pointer';

      circle.addEventListener('click', () => handleDotClick(col, row));

      layer.appendChild(circle);
    }
  }
}

// ============================================================================
// Dot Interaction
function handleDotClick(col, row) {
  if (!currentGame || currentStatus !== 'playing') return;

  if (currentGame.currentTurn !== playerIndex) {
    showToast('Not your turn', 'warning');
    return;
  }

  if (!selectedDot) {
    selectDot(col, row);
  } else {
    attemptDrawLine(col, row);
  }
}

function selectDot(col, row) {
  selectedDot = { col, row };
  highlightDot(col, row, true);
  highlightValidNeighbors(col, row);
  playSound('tap', 0.5);
}

function highlightDot(col, row, selected) {
  const svg = document.getElementById('gameGrid');
  if (!svg) return;

  svg.querySelectorAll('.dot').forEach((dot) => {
    const c = parseInt(dot.getAttribute('data-col'));
    const r = parseInt(dot.getAttribute('data-row'));
    if (c === col && r === row) {
      dot.classList.toggle('selected', selected);
    }
  });
}

function highlightValidNeighbors(col, row) {
  const svg = document.getElementById('gameGrid');
  if (!svg) return;

  svg.querySelectorAll('.dot').forEach((d) => d.classList.remove('raised'));

  const neighbors = [
    { col: col - 1, row },
    { col: col + 1, row },
    { col, row: row - 1 },
    { col, row: row + 1 },
  ];

  const lines = currentGame?.lines ?? {};

  neighbors.forEach((neighbor) => {
    if (neighbor.col < 0 || neighbor.col >= GRID_COLS) return;
    if (neighbor.row < 0 || neighbor.row >= GRID_ROWS) return;

    const lk = getLineKeyBetweenDots({ col, row }, neighbor);
    if (!lk || lines[lk]) return;

    const dot = svg.querySelector(
      `.dot[data-col="${neighbor.col}"][data-row="${neighbor.row}"]`
    );
    if (dot) dot.classList.add('raised');
  });
}

async function attemptDrawLine(col, row) {
  if (!selectedDot) return;

  if (!areAdjacent(selectedDot, { col, row })) {
    showToast('Dots must be adjacent', 'warning');
    clearSelection();
    return;
  }

  const lk = getLineKeyBetweenDots(selectedDot, { col, row });
  if (!lk) {
    showToast('Invalid line', 'error');
    clearSelection();
    return;
  }

  const lines = currentGame?.lines ?? {};
  if (lines[lk]) {
    showToast('Line already drawn', 'warning');
    clearSelection();
    return;
  }

  const parsed = parseLineKey(lk);
  if (!parsed) {
    clearSelection();
    return;
  }

  const myPlayerId = `player_${playerIndex}`;

  try {
    const writeResult = await drawLine(
      roomCode,
      myPlayerId,
      parsed.type,
      parsed.col,
      parsed.row,
    );

    if (!writeResult.ok) {
      showToast(writeResult.message || 'Failed to draw line', 'error');
      clearSelection();
      return;
    }

    if (isHost) {
      const prevBoxCount = Object.keys(currentGame.boxes ?? {}).length;
      const newState = applyLine(currentGame, myPlayerId, parsed.type, parsed.col, parsed.row);
      const boxesCompleted = Object.keys(newState.boxes).length - prevBoxCount;

      if (boxesCompleted > 0) {
        playSound('victory', 0.6);
        showToast(`+${boxesCompleted} box${boxesCompleted > 1 ? 'es' : ''}!`, 'success');
      } else {
        playSound('line', 0.5);
      }

      if (isGameOver(newState)) {
        const rankings = computeFinalRankings(newState, currentPlayers);
        await updateGameState(roomCode, { ...newState, phase: PHASES.FINISHED }, { isHost: true });
        await saveRankings(roomCode, rankings, { isHost: true });
      } else {
        await updateGameState(roomCode, newState, { isHost: true });
      }
    } else {
      playSound('line', 0.5);
    }

    clearSelection();
  } catch (err) {
    showToast(err.message || 'Failed to draw line', 'error');
    console.error('[draw]', err);
    clearSelection();
  }
}

function clearSelection() {
  selectedDot = null;
  const svg = document.getElementById('gameGrid');
  if (!svg) return;

  svg.querySelectorAll('.dot').forEach((dot) => {
    dot.classList.remove('selected', 'raised');
  });
}
// ============================================================================
// Player Cards
// ============================================================================

function renderPlayerCards() {
  const container = document.getElementById('playerCards');
  if (!container) return;

  container.innerHTML = '';

  const playerEntries = Object.entries(currentPlayers).sort((a, b) => {
    const indexA = parseInt(a[0].split('_')[1]);
    const indexB = parseInt(b[0].split('_')[1]);
    return indexA - indexB;
  });

  playerEntries.forEach(([key, player]) => {
    const index = parseInt(key.split('_')[1]);
    const color = player.color || PLAYER_COLORS[index];
    // Pass full playerId string so countPlayerBoxes can match {playerId} objects
    const boxCount = countPlayerBoxes(key);
    const isCurrentTurn = currentGame && currentGame.currentTurn === index;

    const card = document.createElement('div');
    card.className = `player-card ${isCurrentTurn ? 'current-turn' : ''}`;
    card.innerHTML = `
      <div class="player-color">${color}</div>
      <div class="player-info">
        <div class="player-name">${player.name}</div>
        <div class="player-score">${boxCount} ${boxCount === 1 ? 'box' : 'boxes'}</div>
      </div>
    `;

    container.appendChild(card);
  });
}

/**
 * Count boxes owned by a player.
 * @param {string} playerId - e.g. "player_0"
 * Box values in game state are {playerId, completedAt} objects.
 */
function countPlayerBoxes(playerId) {
  if (!currentGame?.boxes) return 0;
  return Object.values(currentGame.boxes).filter(
    (boxData) => boxData?.playerId === playerId
  ).length;
}

function updateTurnIndicator() {
  renderPlayerCards();
}

// ============================================================================
// Victory Screen
// ============================================================================

function showVictory() {
  // getWinners expects a state object with a scores map {playerId -> count}
  const winners = getWinners(currentGame);

  const resultsContainer = document.getElementById('victoryResults');
  if (!resultsContainer) return;

  resultsContainer.innerHTML = '';

  // Build display list from players + box counts
  const scores = Object.entries(currentPlayers).map(([key, player]) => {
    const index = parseInt(key.split('_')[1]);
    const color = player.color || PLAYER_COLORS[index];
    const boxCount = countPlayerBoxes(key);
    return { name: player.name, color, boxCount, playerId: key };
  });
  scores.sort((a, b) => b.boxCount - a.boxCount);

  // Winner announcement
  if (winners.length === 1) {
    const winnerEntry = scores.find((s) => s.playerId === winners[0]);
    const title = document.createElement('h2');
    title.textContent = winnerEntry
      ? `${winnerEntry.color} ${winnerEntry.name} wins!`
      : 'Winner!';
    resultsContainer.appendChild(title);
  } else {
    const title = document.createElement('h2');
    title.textContent = winners.length > 1 ? 'Tie Game!' : 'Game Over!';
    resultsContainer.appendChild(title);
  }

  // Ranked scores list
  scores.forEach((player, rank) => {
    const item = document.createElement('div');
    item.className = 'victory-player';
    item.innerHTML = `
      <span class="rank">#${rank + 1}</span>
      <span class="player-color">${player.color}</span>
      <span class="player-name">${player.name}</span>
      <span class="player-score">${player.boxCount} boxes</span>
    `;
    resultsContainer.appendChild(item);
  });

  showScreen('victoryScreen');
  playSound('victory');
  announce('Game over');
}

// ============================================================================
// Navigation
// ============================================================================

function navigateToMenu() {
  showScreen('menuScreen');
}

function navigateToCreate() {
  showScreen('createScreen');
  document.getElementById('createNameInput').focus();
}

function navigateToJoin() {
  showScreen('joinScreen');
  document.getElementById('joinCodeInput').focus();
}

// ============================================================================
// Session Recovery
// ============================================================================

async function attemptSessionRecovery() {
  const session = loadSession();
  if (!session) return false;

  try {
    showLoading('Restoring session...');
    await restoreConnection(session.roomCode, session.playerIndex);

    roomCode = session.roomCode;
    playerIndex = session.playerIndex;
    isHost = session.isHost;
    playerName = session.playerName;

    await setupDisconnectHandler(roomCode, playerIndex);
    startRoomListener();

    hideLoading();
    showToast('Session restored', 'success');
    return true;
  } catch (err) {
    console.error('[recovery]', err);
    clearSession();
    hideLoading();
    showToast('Could not restore session', 'info');
    return false;
  }
}

// ============================================================================
// Bootstrap
// ============================================================================

async function init() {
  console.log('[init] Starting Dots and Boxes...');

  // Initialize Firebase (awaits auth ready)
  await initFirebase();
  initRecovery();

  // Initialize audio
  initAudio();

  // Inject toast helper into deep-link-handler before calling it
  setShowToast(showToast);

  // initDeepLinkHandler uses object-options API: {roomInputId, joinScreenId, gameName}
  // It returns the detected room code (or null) and pre-fills the input itself.
  const deepLinkedCode = initDeepLinkHandler({
    roomInputId: 'joinCodeInput',
    joinScreenId: 'joinScreen',
    gameName: GAME_NAME,
  });
  if (deepLinkedCode) {
    // Pre-fill happened; navigate to join screen and focus on name input
    showScreen('joinScreen');
    document.getElementById('joinNameInput')?.focus();
  }

  // Initialize color pickers
  initColorPickers();

  // Bind navigation
  document.getElementById('createRoomBtn')?.addEventListener('click', navigateToCreate);
  document.getElementById('joinRoomBtn')?.addEventListener('click', navigateToJoin);
  document.getElementById('backToMenuFromCreate')?.addEventListener('click', navigateToMenu);
  document.getElementById('backToMenuFromJoin')?.addEventListener('click', navigateToMenu);
  document.getElementById('backToMenuFromLobby')?.addEventListener('click', handleLeaveRoom);
  document.getElementById('leaveGameBtn')?.addEventListener('click', handleLeaveRoom);
  document.getElementById('backToMenuFromVictory')?.addEventListener('click', async () => {
    if (isHost && roomCode) {
      await deleteRoom(roomCode);
    }
    cleanupRoom();
    navigateToMenu();
  });

  // Bind forms
  document.getElementById('createRoomForm')?.addEventListener('submit', handleCreateRoom);
  document.getElementById('joinRoomForm')?.addEventListener('submit', handleJoinRoom);
  document.getElementById('startGameBtn')?.addEventListener('click', handleStartGame);

  // Share button — createShareHandler(roomCode, gameName) returns an async handler.
  // We defer reading roomCode until click time via a wrapper closure.
  const shareBtn = document.getElementById('shareRoomBtn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      if (!roomCode) return;
      createShareHandler(roomCode, GAME_NAME)();
    });
  }

  // Mute toggle
  const muteBtn = document.getElementById('muteBtn');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      toggleMute();
      muteBtn.textContent = isMuted() ? '🔇' : '🔊';
    });
  }

  // Attempt session recovery
  const recovered = await attemptSessionRecovery();

  if (!recovered && currentScreen === 'menuScreen') {
    showScreen('menuScreen');
  }

  console.log('[init] Ready');
}

// Start app
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
