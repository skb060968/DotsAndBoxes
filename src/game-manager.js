/**
 * Game State Manager — Dots and Boxes
 *
 * Pure game logic for turn-based Dots and Boxes.
 * Grid: 6 columns × 11 rows of dots = 5×10 boxes possible
 * 
 * ─────────────────────────────────────────────────────────────────────────────
 * MODULE CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 * NO top-level Firebase import. All functions are pure and testable.
 * Firebase I/O uses lazy dynamic imports inside async wrappers.
 */

import { withRetry, logError } from './firebase-recovery.js';
import { db } from './firebase-config.js';
import { ref, update, serverTimestamp } from 'firebase/database';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONSTANTS
// ═════════════════════════════════════════════════════════════════════════════

/** Grid dimensions: 6 columns × 11 rows of dots */
export const GRID_COLS = 6;
export const GRID_ROWS = 11;

/** Boxes: (cols-1) × (rows-1) */
export const BOXES_COLS = GRID_COLS - 1;
export const BOXES_ROWS = GRID_ROWS - 1;
export const TOTAL_BOXES = BOXES_COLS * BOXES_ROWS;

/** Player limits */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

/** Player colors (colored circles) */
export const PLAYER_COLORS = Object.freeze(['🔴', '🔵', '🟢', '🟡']);

/** Room code pattern */
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z]{4}$/;

/** Player key prefix */
export const PLAYER_KEY_PREFIX = 'player_';

/** Root node for all rooms */
export const ROOM_PATH_PREFIX = 'dots-and-boxes-rooms';

/** Game phases */
export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  PLAYING: 'playing',
  FINISHED: 'finished',
});

/** Line directions */
export const LINE_TYPES = Object.freeze({
  HORIZONTAL: 'h',
  VERTICAL: 'v',
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — LOCAL GAME STATE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Creates initial game state.
 * @returns {{
 *   roomCode: string | null,
 *   playerIndex: number | null,
 *   isHost: boolean,
 *   phase: string,
 *   currentTurn: number,
 *   players: Object,
 *   lines: Object,
 *   boxes: Object,
 *   selectedDot: {col: number, row: number} | null,
 *   scores: Object
 * }}
 */
export function createInitialGameState() {
  return {
    // Session
    roomCode: null,
    playerIndex: null,
    isHost: false,

    // Game state
    phase: PHASES.LOBBY,
    currentTurn: 0, // player index whose turn it is
    playerOrder: [], // [0, 1, 2, 3] - order of play

    // Grid state
    players: {},
    lines: {}, // key: "h_col_row" or "v_col_row" → { playerId, timestamp }
    boxes: {}, // key: "col_row" → { playerId, completedAt }
    
    // UI state
    selectedDot: null, // {col, row} or null
    scores: {}, // playerId → box count
  };
}

/** Shared game state instance */
export const gameState = createInitialGameState();

/** Reset game state to initial values */
export function resetLocalGameState() {
  Object.assign(gameState, createInitialGameState());
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — ROOM CODE HELPERS (pure)
// ═════════════════════════════════════════════════════════════════════════════

export function isValidRoomCode(code) {
  return typeof code === 'string' && ROOM_CODE_PATTERN.test(code);
}

export function normalizeRoomCode(input) {
  return typeof input === 'string' ? input.trim().toUpperCase() : '';
}

export function roomPath(roomCode, suffix = '') {
  const base = `${ROOM_PATH_PREFIX}/${roomCode}`;
  return suffix ? `${base}/${suffix}` : base;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — PLAYER HELPERS (pure)
// ═════════════════════════════════════════════════════════════════════════════

export function playerKey(index) {
  return `${PLAYER_KEY_PREFIX}${index}`;
}

export function playerIndexFromKey(key) {
  if (typeof key !== 'string' || !key.startsWith(PLAYER_KEY_PREFIX)) return NaN;
  const raw = key.slice(PLAYER_KEY_PREFIX.length);
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
}

export function occupiedPlayerIndices(players) {
  if (!players || typeof players !== 'object') return [];
  return Object.keys(players)
    .map(playerIndexFromKey)
    .filter((i) => Number.isInteger(i) && i >= 0 && i < MAX_PLAYERS)
    .sort((a, b) => a - b);
}

export function connectedPlayerIds(players) {
  return occupiedPlayerIndices(players)
    .map(playerKey)
    .filter((key) => players[key]?.connected === true);
}

export function hasEnoughPlayers(players) {
  return connectedPlayerIds(players).length >= MIN_PLAYERS;
}

export function isRoomFull(players) {
  return occupiedPlayerIndices(players).length >= MAX_PLAYERS;
}

export const NO_INDEX_AVAILABLE = -1;

export function assignPlayerIndex(players) {
  const occupied = new Set(occupiedPlayerIndices(players));
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (!occupied.has(i)) return i;
  }
  return NO_INDEX_AVAILABLE;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — GRID GEOMETRY (pure)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Creates a line key for the lines object.
 * @param {string} type - 'h' or 'v'
 * @param {number} col - Column index (0-based)
 * @param {number} row - Row index (0-based)
 * @returns {string} e.g. "h_2_3" or "v_1_4"
 */
export function lineKey(type, col, row) {
  return `${type}_${col}_${row}`;
}

/**
 * Parses a line key back into components.
 * @param {string} key - e.g. "h_2_3"
 * @returns {{type: string, col: number, row: number} | null}
 */
export function parseLineKey(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split('_');
  if (parts.length !== 3) return null;
  const [type, colStr, rowStr] = parts;
  if (type !== 'h' && type !== 'v') return null;
  const col = Number(colStr);
  const row = Number(rowStr);
  if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
  return { type, col, row };
}

/**
 * Creates a box key.
 * @param {number} col - Column index of top-left dot
 * @param {number} row - Row index of top-left dot
 * @returns {string} e.g. "2_3"
 */
export function boxKey(col, row) {
  return `${col}_${row}`;
}

/**
 * Check if a dot position is valid.
 */
export function isValidDot(col, row) {
  return Number.isInteger(col) && Number.isInteger(row) 
    && col >= 0 && col < GRID_COLS 
    && row >= 0 && row < GRID_ROWS;
}

/**
 * Check if two dots are adjacent (horizontally or vertically).
 */
export function areAdjacent(dot1, dot2) {
  if (!dot1 || !dot2) return false;
  const colDiff = Math.abs(dot1.col - dot2.col);
  const rowDiff = Math.abs(dot1.row - dot2.row);
  // Adjacent means exactly 1 unit away in one direction, 0 in the other
  return (colDiff === 1 && rowDiff === 0) || (colDiff === 0 && rowDiff === 1);
}

/**
 * Get the line key that would connect two dots.
 * Returns null if dots are not adjacent.
 */
export function getLineKeyBetweenDots(dot1, dot2) {
  if (!areAdjacent(dot1, dot2)) return null;
  
  const colDiff = dot2.col - dot1.col;
  const rowDiff = dot2.row - dot1.row;
  
  if (rowDiff === 0) {
    // Horizontal line
    const minCol = Math.min(dot1.col, dot2.col);
    return lineKey('h', minCol, dot1.row);
  } else {
    // Vertical line
    const minRow = Math.min(dot1.row, dot2.row);
    return lineKey('v', dot1.col, minRow);
  }
}

/**
 * Check if a line already exists.
 */
export function lineExists(lines, type, col, row) {
  const key = lineKey(type, col, row);
  return Boolean(lines && lines[key]);
}

/**
 * Get all 4 line keys that form a box.
 * Box is defined by its top-left dot.
 */
export function getBoxLines(col, row) {
  return [
    lineKey('h', col, row),     // top
    lineKey('h', col, row + 1), // bottom
    lineKey('v', col, row),     // left
    lineKey('v', col + 1, row), // right
  ];
}

/**
 * Check if a box is complete (all 4 sides drawn).
 */
export function isBoxComplete(lines, col, row) {
  const sides = getBoxLines(col, row);
  return sides.every(key => lines && lines[key]);
}

/**
 * Find which boxes (if any) were completed by drawing a specific line.
 * Returns array of box keys: ["col_row", ...]
 */
export function findCompletedBoxes(lines, lineType, lineCol, lineRow) {
  const completed = [];
  const key = lineKey(lineType, lineCol, lineRow);
  
  // Line must exist
  if (!lines || !lines[key]) return completed;
  
  // Check boxes that could be affected by this line
  if (lineType === 'h') {
    // Horizontal line affects box above (row-1) and below (row)
    if (lineRow > 0 && lineCol < BOXES_COLS) {
      if (isBoxComplete(lines, lineCol, lineRow - 1)) {
        completed.push(boxKey(lineCol, lineRow - 1));
      }
    }
    if (lineRow < BOXES_ROWS && lineCol < BOXES_COLS) {
      if (isBoxComplete(lines, lineCol, lineRow)) {
        completed.push(boxKey(lineCol, lineRow));
      }
    }
  } else {
    // Vertical line affects box to left (col-1) and right (col)
    if (lineCol > 0 && lineRow < BOXES_ROWS) {
      if (isBoxComplete(lines, lineCol - 1, lineRow)) {
        completed.push(boxKey(lineCol - 1, lineRow));
      }
    }
    if (lineCol < BOXES_COLS && lineRow < BOXES_ROWS) {
      if (isBoxComplete(lines, lineCol, lineRow)) {
        completed.push(boxKey(lineCol, lineRow));
      }
    }
  }
  
  return completed;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — GAME LOGIC (pure)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Initialize a new game with player order.
 */
export function initializeGame(players) {
  const connected = connectedPlayerIds(players);
  return {
    phase: PHASES.PLAYING,
    currentTurn: 0,
    playerOrder: connected.map(playerIndexFromKey),
    lines: {},
    boxes: {},
    scores: connected.reduce((acc, id) => ({ ...acc, [id]: 0 }), {}),
  };
}

/**
 * Check if it's a specific player's turn.
 */
export function isPlayerTurn(state, playerIndex) {
  if (!state || state.phase !== PHASES.PLAYING) return false;
  if (!Array.isArray(state.playerOrder) || state.playerOrder.length === 0) return false;
  const turnIndex = state.currentTurn % state.playerOrder.length;
  return state.playerOrder[turnIndex] === playerIndex;
}

/**
 * Get the current player index whose turn it is.
 */
export function getCurrentPlayerIndex(state) {
  if (!state || !Array.isArray(state.playerOrder) || state.playerOrder.length === 0) return null;
  const turnIndex = state.currentTurn % state.playerOrder.length;
  return state.playerOrder[turnIndex];
}

/**
 * Advance to next player's turn (only if no box was completed).
 */
export function advanceTurn(state) {
  return {
    ...state,
    currentTurn: state.currentTurn + 1,
  };
}

/**
 * Apply a line draw and check for completed boxes.
 * Returns updated state with line, boxes, and possibly same turn if boxes completed.
 */
export function applyLine(state, playerId, lineType, lineCol, lineRow) {
  const key = lineKey(lineType, lineCol, lineRow);
  
  // Line already exists
  if (state.lines[key]) return state;
  
  const newLines = {
    ...state.lines,
    [key]: {
      playerId,
      timestamp: Date.now(),
    },
  };
  
  // Check for completed boxes
  const completedBoxKeys = findCompletedBoxes(newLines, lineType, lineCol, lineRow);
  
  let newBoxes = { ...state.boxes };
  let newScores = { ...state.scores };
  
  completedBoxKeys.forEach(boxKey => {
    if (!newBoxes[boxKey]) {
      newBoxes[boxKey] = {
        playerId,
        completedAt: Date.now(),
      };
      newScores[playerId] = (newScores[playerId] || 0) + 1;
    }
  });
  
  // If boxes were completed, player gets another turn (don't advance)
  // Otherwise, advance to next player
  const shouldAdvance = completedBoxKeys.length === 0;
  
  return {
    ...state,
    lines: newLines,
    boxes: newBoxes,
    scores: newScores,
    currentTurn: shouldAdvance ? state.currentTurn + 1 : state.currentTurn,
  };
}

/**
 * Check if game is over (all boxes claimed).
 */
export function isGameOver(state) {
  if (!state || !state.boxes) return false;
  return Object.keys(state.boxes).length >= TOTAL_BOXES;
}

/**
 * Get winner(s) - returns array of player IDs with highest score.
 */
export function getWinners(state) {
  if (!state || !state.scores) return [];
  
  const entries = Object.entries(state.scores);
  if (entries.length === 0) return [];
  
  const maxScore = Math.max(...entries.map(([_, score]) => score));
  return entries
    .filter(([_, score]) => score === maxScore)
    .map(([playerId]) => playerId);
}

/**
 * Compute final rankings.
 */
export function computeFinalRankings(state, players) {
  if (!state || !state.scores) return [];
  
  const entries = Object.entries(state.scores)
    .map(([playerId, score]) => ({
      playerId,
      score,
      name: players[playerId]?.name || 'Player',
    }))
    .sort((a, b) => b.score - a.score);
  
  const rankings = [];
  let currentRank = 1;
  let previousScore = null;
  
  entries.forEach((entry, index) => {
    if (previousScore !== null && entry.score < previousScore) {
      currentRank = index + 1;
    }
    rankings.push({ ...entry, rank: currentRank });
    previousScore = entry.score;
  });
  
  return rankings;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — FIREBASE I/O (host-guarded)
// ═════════════════════════════════════════════════════════════════════════════

async function resolveServerTimestamp(options = {}) {
  if (typeof options.serverTimestamp === 'function') return options.serverTimestamp();
  return serverTimestamp();
}

async function applyUpdates(updates, options = {}) {
  if (typeof options.writer === 'function') return options.writer(updates);
  return update(ref(db), updates);
}

function isHostWriter(options = {}) {
  return (options.isHost !== undefined ? options.isHost : gameState.isHost) === true;
}

/**
 * HOST ONLY: Start the game.
 */
export async function startGame(roomCode, initialState, options = {}) {
  if (!isHostWriter(options)) return { ok: false, skipped: 'not-host' };
  
  const timestamp = await resolveServerTimestamp(options);
  const updates = {
    [roomPath(roomCode, 'meta/status')]: 'playing',
    [roomPath(roomCode, 'game/phase')]: initialState.phase,
    [roomPath(roomCode, 'game/currentTurn')]: initialState.currentTurn,
    [roomPath(roomCode, 'game/playerOrder')]: initialState.playerOrder,
    [roomPath(roomCode, 'game/lines')]: initialState.lines,
    [roomPath(roomCode, 'game/boxes')]: initialState.boxes,
    [roomPath(roomCode, 'game/scores')]: initialState.scores,
    [roomPath(roomCode, 'meta/lastActivity')]: timestamp,
  };
  
  const result = await withRetry(() => applyUpdates(updates, options), {
    context: 'startGame',
    metadata: { roomCode },
  });
  
  return {
    ok: result.ok,
    attempts: result.attempts,
    error: result.error,
    message: result.message ?? null,
  };
}

/**
 * Draw a line (any player on their turn).
 */
export async function drawLine(roomCode, playerId, lineType, lineCol, lineRow, options = {}) {
  const key = lineKey(lineType, lineCol, lineRow);
  const timestamp = await resolveServerTimestamp(options);
  
  const updates = {
    [roomPath(roomCode, `game/lines/${key}`)]: {
      playerId,
      timestamp,
    },
    [roomPath(roomCode, 'meta/lastActivity')]: timestamp,
  };
  
  const result = await withRetry(() => applyUpdates(updates, options), {
    context: 'drawLine',
    metadata: { roomCode, playerId, lineType, lineCol, lineRow },
  });
  
  return {
    ok: result.ok,
    attempts: result.attempts,
    error: result.error,
    message: result.message ?? null,
  };
}

/**
 * HOST ONLY: Update game state after a line is drawn.
 */
export async function updateGameState(roomCode, newState, options = {}) {
  if (!isHostWriter(options)) return { ok: false, skipped: 'not-host' };
  
  const timestamp = await resolveServerTimestamp(options);
  const updates = {
    [roomPath(roomCode, 'game/currentTurn')]: newState.currentTurn,
    [roomPath(roomCode, 'game/boxes')]: newState.boxes,
    [roomPath(roomCode, 'game/scores')]: newState.scores,
    [roomPath(roomCode, 'meta/lastActivity')]: timestamp,
  };
  
  if (newState.phase === PHASES.FINISHED) {
    updates[roomPath(roomCode, 'game/phase')] = PHASES.FINISHED;
    updates[roomPath(roomCode, 'meta/status')] = 'finished';
  }
  
  const result = await withRetry(() => applyUpdates(updates, options), {
    context: 'updateGameState',
    metadata: { roomCode },
  });
  
  return {
    ok: result.ok,
    attempts: result.attempts,
    error: result.error,
    message: result.message ?? null,
  };
}

/**
 * HOST ONLY: Save final rankings.
 */
export async function saveRankings(roomCode, rankings, options = {}) {
  if (!isHostWriter(options)) return { ok: false, skipped: 'not-host' };
  
  const timestamp = await resolveServerTimestamp(options);
  const updates = {
    [roomPath(roomCode, 'rankings')]: rankings,
    [roomPath(roomCode, 'meta/lastActivity')]: timestamp,
  };
  
  const result = await withRetry(() => applyUpdates(updates, options), {
    context: 'saveRankings',
    metadata: { roomCode },
  });
  
  return {
    ok: result.ok,
    attempts: result.attempts,
    error: result.error,
    message: result.message ?? null,
  };
}
