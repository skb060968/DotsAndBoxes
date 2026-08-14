/**
 * Main UI Controller — Dots and Boxes
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
  PLAYER_AVATARS,
} from './firebase-sync.js';
import {
  startGame,
  applyLine,
  isGameOver,
  getWinners,
  GRID_COLS,
  GRID_ROWS,
  areAdjacent,
  getLineKeyBetweenDots,
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

// Game state
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
let selectedCreateAvatar = PLAYER_AVATARS[0];
let selectedJoinAvatar = PLAYER_AVATARS[0];

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
// Avatar Picker
// ============================================================================

function renderAvatarPicker(containerId, onSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  container.innerHTML = '';
  PLAYER_AVATARS.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avatar-btn';
    btn.textContent = emoji;
    btn.setAttribute('aria-label', `Select ${emoji} avatar`);
    btn.addEventListener('click', () => {
      container.querySelectorAll('.avatar-btn').forEach((b) => 
        b.classList.remove('selected')
      );
      btn.classList.add('selected');
      onSelect(emoji);
    });
    container.appendChild(btn);
  });
  
  // Auto-select first
  const firstBtn = container.querySelector('.avatar-btn');
  if (firstBtn) {
    firstBtn.classList.add('selected');
    onSelect(PLAYER_AVATARS[0]);
  }
}

function initAvatarPickers() {
  renderAvatarPicker('createAvatarPicker', (emoji) => {
    selectedCreateAvatar = emoji;
  });
  renderAvatarPicker('joinAvatarPicker', (emoji) => {
    selectedJoinAvatar = emoji;
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
    const result = await createRoom(name, selectedCreateAvatar);
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
    const result = await joinRoom(code, name, selectedJoinAvatar);
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
    const emoji = player.emoji || PLAYER_AVATARS[index];
    const connected = player.connected !== false;
    
    const item = document.createElement('div');
    item.className = `lobby-player ${!connected ? 'disconnected' : ''}`;
    item.innerHTML = `
      <span class="player-avatar">${emoji}</span>
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
}

async function handleStartGame() {
  if (!isHost || !roomCode) return;
  
  try {
    showLoading('Starting game...');
    const playerKeys = Object.keys(currentPlayers);
    await startGame(roomCode, playerKeys);
    hideLoading();
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
  
  // Clear existing
  svg.innerHTML = '';
  
  // Calculate dimensions
  const gridWidth = (GRID_COLS - 1) * DOT_SPACING + 2 * GRID_PADDING;
  const gridHeight = (GRID_ROWS - 1) * DOT_SPACING + 2 * GRID_PADDING;
  svg.setAttribute('viewBox', `0 0 ${gridWidth} ${gridHeight}`);
  svg.setAttribute('width', gridWidth);
  svg.setAttribute('height', gridHeight);
  
  // Create layers
  const boxesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  boxesLayer.id = 'boxesLayer';
  svg.appendChild(boxesLayer);
  
  const linesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  linesLayer.id = 'linesLayer';
  svg.appendChild(linesLayer);
  
  const dotsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  dotsLayer.id = 'dotsLayer';
  svg.appendChild(dotsLayer);
  
  // Render content
  renderBoxes(boxesLayer);
  renderLines(linesLayer);
  renderDots(dotsLayer);
}

function renderBoxes(layer) {
  if (!currentGame?.boxes) return;
  
  Object.entries(currentGame.boxes).forEach(([boxKey, owner]) => {
    const [col, row] = boxKey.split(',').map(Number);
    const x = GRID_PADDING + col * DOT_SPACING;
    const y = GRID_PADDING + row * DOT_SPACING;
    
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', DOT_SPACING);
    rect.setAttribute('height', DOT_SPACING);
    rect.setAttribute('class', `box box-${owner}`);
    rect.setAttribute('data-owner', owner);
    
    layer.appendChild(rect);
  });
}

function renderLines(layer) {
  if (!currentGame?.lines) return;
  
  Object.entries(currentGame.lines).forEach(([lineKey, owner]) => {
    const [dir, col, row] = lineKey.split(',');
    const c = Number(col);
    const r = Number(row);
    
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
    line.setAttribute('class', `line line-${owner}`);
    line.setAttribute('data-owner', owner);
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
// ============================================================================

function handleDotClick(col, row) {
  if (!currentGame || currentStatus !== 'playing') return;
  
  const currentPlayerKey = `player_${currentGame.currentTurn}`;
  const myPlayerKey = `player_${playerIndex}`;
  
  if (currentPlayerKey !== myPlayerKey) {
    showToast('Not your turn', 'warning');
    return;
  }
  
  if (!selectedDot) {
    // First dot selection
    selectDot(col, row);
  } else {
    // Second dot - attempt to draw line
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
  
  const dots = svg.querySelectorAll('.dot');
  dots.forEach((dot) => {
    const c = parseInt(dot.getAttribute('data-col'));
    const r = parseInt(dot.getAttribute('data-row'));
    if (c === col && r === row) {
      if (selected) {
        dot.classList.add('selected');
      } else {
        dot.classList.remove('selected');
      }
    }
  });
}

function highlightValidNeighbors(col, row) {
  const svg = document.getElementById('gameGrid');
  if (!svg) return;
  
  // Clear previous highlights
  svg.querySelectorAll('.dot').forEach((d) => d.classList.remove('valid-neighbor'));
  
  // Check all adjacent dots
  const neighbors = [
    { col: col - 1, row },
    { col: col + 1, row },
    { col, row: row - 1 },
    { col, row: row + 1 },
  ];
  
  neighbors.forEach((neighbor) => {
    if (neighbor.col < 0 || neighbor.col >= GRID_COLS) return;
    if (neighbor.row < 0 || neighbor.row >= GRID_ROWS) return;
    
    // Check if line already exists
    const lineKey = getLineKeyBetweenDots(col, row, neighbor.col, neighbor.row);
    if (!lineKey || currentGame.lines[lineKey]) return;
    
    // Highlight this neighbor
    svg.querySelectorAll('.dot').forEach((dot) => {
      const c = parseInt(dot.getAttribute('data-col'));
      const r = parseInt(dot.getAttribute('data-row'));
      if (c === neighbor.col && r === neighbor.row) {
        dot.classList.add('valid-neighbor');
      }
    });
  });
}

async function attemptDrawLine(col, row) {
  if (!selectedDot) return;
  
  // Check if dots are adjacent
  if (!areAdjacent(selectedDot.col, selectedDot.row, col, row)) {
    showToast('Dots must be adjacent', 'warning');
    clearSelection();
    return;
  }
  
  // Get line key
  const lineKey = getLineKeyBetweenDots(selectedDot.col, selectedDot.row, col, row);
  if (!lineKey) {
    showToast('Invalid line', 'error');
    clearSelection();
    return;
  }
  
  // Check if line already exists
  if (currentGame.lines[lineKey]) {
    showToast('Line already drawn', 'warning');
    clearSelection();
    return;
  }
  
  // Apply line
  try {
    const result = await applyLine(roomCode, lineKey, playerIndex);
    
    if (result.boxesCompleted > 0) {
      playSound('victory', 0.6);
      showToast(`+${result.boxesCompleted} box${result.boxesCompleted > 1 ? 'es' : ''}!`, 'success');
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
    dot.classList.remove('selected', 'valid-neighbor');
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
    const emoji = player.emoji || PLAYER_AVATARS[index];
    const boxCount = countPlayerBoxes(index);
    const isCurrentTurn = currentGame && currentGame.currentTurn === index;
    
    const card = document.createElement('div');
    card.className = `player-card ${isCurrentTurn ? 'current-turn' : ''}`;
    card.innerHTML = `
      <div class="player-avatar">${emoji}</div>
      <div class="player-info">
        <div class="player-name">${player.name}</div>
        <div class="player-score">${boxCount} ${boxCount === 1 ? 'box' : 'boxes'}</div>
      </div>
    `;
    
    container.appendChild(card);
  });
}

function countPlayerBoxes(playerIdx) {
  if (!currentGame?.boxes) return 0;
  return Object.values(currentGame.boxes).filter((owner) => owner === playerIdx).length;
}

function updateTurnIndicator() {
  // Player cards already show current turn via 'current-turn' class
  renderPlayerCards();
}

// ============================================================================
// Victory Screen
// ============================================================================

function showVictory() {
  const winners = getWinners(currentGame, Object.keys(currentPlayers));
  
  const resultsContainer = document.getElementById('victoryResults');
  if (!resultsContainer) return;
  
  resultsContainer.innerHTML = '';
  
  // Sort by score descending
  const scores = [];
  Object.entries(currentPlayers).forEach(([key, player]) => {
    const index = parseInt(key.split('_')[1]);
    const emoji = player.emoji || PLAYER_AVATARS[index];
    const boxCount = countPlayerBoxes(index);
    scores.push({ name: player.name, emoji, boxCount, index });
  });
  scores.sort((a, b) => b.boxCount - a.boxCount);
  
  // Winner announcement
  if (winners.length === 1) {
    const winnerIdx = winners[0];
    const winner = scores.find((s) => s.index === winnerIdx);
    const title = document.createElement('h2');
    title.textContent = `${winner.emoji} ${winner.name} wins!`;
    resultsContainer.appendChild(title);
  } else {
    const title = document.createElement('h2');
    title.textContent = 'Tie Game!';
    resultsContainer.appendChild(title);
  }
  
  // Scores list
  scores.forEach((player, rank) => {
    const item = document.createElement('div');
    item.className = 'victory-player';
    item.innerHTML = `
      <span class="rank">#${rank + 1}</span>
      <span class="player-avatar">${player.emoji}</span>
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
  
  // Initialize Firebase
  await initFirebase();
  initRecovery();
  
  // Initialize audio
  initAudio();
  
  // Setup deep link handler
  setShowToast(showToast);
  initDeepLinkHandler((code) => {
    if (!code) return;
    showScreen('joinScreen');
    const input = document.getElementById('joinCodeInput');
    if (input) {
      input.value = code;
      document.getElementById('joinNameInput').focus();
    }
  });
  
  // Initialize avatar pickers
  initAvatarPickers();
  
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
  
  // Bind share button
  const shareBtn = document.getElementById('shareRoomBtn');
  if (shareBtn) {
    shareBtn.addEventListener('click', createShareHandler(() => roomCode));
  }
  
  // Bind mute toggle
  const muteBtn = document.getElementById('muteBtn');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      toggleMute();
      muteBtn.textContent = isMuted() ? '🔇' : '🔊';
    });
  }
  
  // Attempt session recovery
  const recovered = await attemptSessionRecovery();
  
  if (!recovered) {
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
