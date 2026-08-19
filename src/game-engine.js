export const COLS = 6;
export const ROWS = 11;
export const TOTAL_BOXES = (COLS - 1) * (ROWS - 1);
export const TOTAL_EDGES = ROWS * (COLS - 1) + (ROWS - 1) * COLS;

export function edgeKey(a, b) {
  const start = Number(a);
  const end = Number(b);
  return start < end ? `${start}-${end}` : `${end}-${start}`;
}

export function isAdjacent(a, b) {
  const start = Number(a);
  const end = Number(b);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0 || start >= COLS * ROWS || end >= COLS * ROWS) return false;
  const startColumn = start % COLS;
  const startRow = Math.floor(start / COLS);
  const endColumn = end % COLS;
  const endRow = Math.floor(end / COLS);
  return Math.abs(startColumn - endColumn) + Math.abs(startRow - endRow) === 1;
}

export function boxEdgeKeys(column, row) {
  const topLeft = row * COLS + column;
  const topRight = topLeft + 1;
  const bottomLeft = topLeft + COLS;
  const bottomRight = bottomLeft + 1;
  return [
    edgeKey(topLeft, topRight), edgeKey(bottomLeft, bottomRight),
    edgeKey(topLeft, bottomLeft), edgeKey(topRight, bottomRight),
  ];
}

function candidateBoxes(a, b) {
  const start = Number(a);
  const end = Number(b);
  const startColumn = start % COLS;
  const startRow = Math.floor(start / COLS);
  const endColumn = end % COLS;
  const endRow = Math.floor(end / COLS);
  const candidates = [];
  if (startRow === endRow) {
    const column = Math.min(startColumn, endColumn);
    if (startRow > 0) candidates.push([column, startRow - 1]);
    if (startRow < ROWS - 1) candidates.push([column, startRow]);
  } else {
    const row = Math.min(startRow, endRow);
    if (startColumn > 0) candidates.push([startColumn - 1, row]);
    if (startColumn < COLS - 1) candidates.push([startColumn, row]);
  }
  return candidates;
}

export function playerOrder(game) {
  if (Array.isArray(game?.playerOrder)) return game.playerOrder.filter(Boolean);
  return Object.keys(game?.playerOrder || {}).sort((a, b) => Number(a) - Number(b)).map((key) => game.playerOrder[key]);
}

export function createGameState(playerKeys, ownerUid, timestamp = Date.now()) {
  const order = [...playerKeys];
  const scores = Object.fromEntries(order.map((key) => [key, 0]));
  return {
    status: 'playing',
    roundId: timestamp,
    revision: 0,
    edgeCount: 0,
    playerCount: order.length,
    playerOrder: order,
    currentPlayerIndex: 0,
    currentPlayerKey: order[0],
    scores,
    operation: {
      type: 'start', ownerUid, playerKey: order[0], revision: 0, timestamp,
    },
  };
}

export function applyMove(game, playerKey, start, end, ownerUid, timestamp = Date.now()) {
  if (!game || game.status !== 'playing') throw new Error('The game is not active.');
  if (!isAdjacent(start, end)) throw new Error('Choose an adjacent dot.');
  const order = playerOrder(game);
  const currentKey = order[game.currentPlayerIndex];
  if (currentKey !== playerKey) throw new Error('It is not your turn.');
  const moveEdge = edgeKey(start, end);
  if (game.edges?.[moveEdge]) throw new Error('That line is already claimed.');

  const edges = { ...(game.edges || {}), [moveEdge]: playerKey };
  const boxes = { ...(game.boxes || {}) };
  const claimedBoxes = {};
  candidateBoxes(start, end).forEach(([column, row]) => {
    const boxKey = `${column}-${row}`;
    if (!boxes[boxKey] && boxEdgeKeys(column, row).every((key) => edges[key])) {
      boxes[boxKey] = playerKey;
      claimedBoxes[boxKey] = true;
    }
  });

  const claimedCount = Object.keys(claimedBoxes).length;
  const scores = { ...(game.scores || {}) };
  scores[playerKey] = Number(scores[playerKey] || 0) + claimedCount;
  const edgeCount = Number(game.edgeCount || 0) + 1;
  const finished = Object.keys(boxes).length === TOTAL_BOXES || edgeCount === TOTAL_EDGES;
  const revision = Number(game.revision || 0) + 1;
  const nextIndex = claimedCount ? game.currentPlayerIndex : (game.currentPlayerIndex + 1) % order.length;
  const result = {
    ...game,
    status: finished ? 'finished' : 'playing',
    revision,
    edgeCount,
    currentPlayerIndex: nextIndex,
    currentPlayerKey: order[nextIndex],
    edges,
    boxes,
    scores,
    operation: { type: 'move', ownerUid, playerKey, revision, timestamp },
    lastMove: { start: Number(start), end: Number(end), edgeKey: moveEdge, playerKey, claimedCount, revision, timestamp },
  };
  if (claimedCount) result.lastMove.claimedBoxes = claimedBoxes;
  if (finished) {
    const highest = Math.max(...order.map((key) => Number(scores[key] || 0)));
    result.winnerKeys = Object.fromEntries(order.filter((key) => scores[key] === highest).map((key) => [key, true]));
    result.endedAt = timestamp;
  }
  return result;
}
