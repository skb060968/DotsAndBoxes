import { playSound } from './sound-manager.js';
import { COLS, ROWS, edgeKey, isAdjacent, playerOrder } from './game-engine.js';

const NS = 'http://www.w3.org/2000/svg';
const X0 = 14;
const Y0 = 16;
const DX = 14.4;
const DY = 14.8;

let svg;
let cards;
let message;
let players = [];
let game = null;
let localPlayerKey = null;
let onMoveRequest = null;
let selected = null;
let locked = false;
let renderedRound = null;
let renderedRevision = -1;
let renderedEdges = new Set();
let renderedBoxes = new Set();
let groups = {};

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const point = (id) => ({
  column: id % COLS,
  row: Math.floor(id / COLS),
  x: X0 + (id % COLS) * DX,
  y: Y0 + Math.floor(id / COLS) * DY,
});
const svgElement = (tag, attributes = {}) => {
  const node = document.createElementNS(NS, tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
};
const activeKey = () => game?.currentPlayerKey || playerOrder(game)[Number(game?.currentPlayerIndex || 0)] || null;
const playerByKey = (key) => players.find((player) => player.slotKey === key);
const lineAvailable = (a, b) => isAdjacent(a, b) && !game?.edges?.[edgeKey(a, b)];
const availableFrom = (id) => Array.from({ length: COLS * ROWS }, (_, index) => index)
  .filter((index) => lineAvailable(id, index));

function announce(text) {
  message.textContent = text;
}

function validTargets() {
  return selected === null ? [] : availableFrom(selected);
}

function paintSelection() {
  const current = playerByKey(activeKey());
  svg.style.setProperty('--player', current?.color || '#2563eb');
  const targets = validTargets();
  svg.querySelectorAll('.dot').forEach((dot, index) => {
    dot.classList.toggle('selected', index === selected);
    dot.classList.toggle('valid', targets.includes(index));
  });
}

function renderCards() {
  const currentKey = activeKey();
  cards.replaceChildren();
  players.forEach((player) => {
    const score = Number(game?.scores?.[player.slotKey] || 0);
    const card = document.createElement('article');
    card.className = `player-card${game?.status === 'playing' && player.slotKey === currentKey ? ' active' : ''}`;
    card.style.setProperty('--player', player.color);
    card.innerHTML = '<span class="player-avatar" aria-hidden="true"></span><span class="player-name"></span><span class="player-score"></span>';
    card.querySelector('.player-avatar').textContent = player.avatar;
    card.querySelector('.player-name').textContent = player.name;
    card.querySelector('.player-score').textContent = `${score} box${score === 1 ? '' : 'es'}`;
    cards.append(card);
  });
}

function addBox(boxKey, ownerKey) {
  if (renderedBoxes.has(boxKey)) return;
  const [column, row] = boxKey.split('-').map(Number);
  const owner = playerByKey(ownerKey);
  const rect = svgElement('rect', {
    x: X0 + column * DX + 0.9,
    y: Y0 + row * DY + 0.9,
    width: DX - 1.8,
    height: DY - 1.8,
    rx: 2,
    class: 'box-claim',
  });
  rect.style.setProperty('--player', owner?.color || '#64748b');
  groups.boxes.append(rect);
  renderedBoxes.add(boxKey);
}

function addEdge(moveKey, ownerKey, animate = false, animationStart = null, animationEnd = null) {
  if (renderedEdges.has(moveKey)) return;
  const storedPoints = moveKey.split('-').map(Number);
  const start = animate && Number.isInteger(animationStart) ? animationStart : storedPoints[0];
  const end = animate && Number.isInteger(animationEnd) ? animationEnd : storedPoints[1];
  const from = point(start);
  const to = point(end);
  const owner = playerByKey(ownerKey);
  const baseAttributes = {
    x1: from.x, y1: from.y, x2: to.x, y2: to.y, pathLength: 1,
  };
  const shadow = svgElement('line', {
    ...baseAttributes,
    class: `edge-rod-shadow${animate ? ' temp' : ''}`,
    transform: 'translate(.65 1)',
  });
  const line = svgElement('line', {
    ...baseAttributes,
    class: `edge${animate ? ' temp' : ''}`,
  });
  const highlight = svgElement('line', {
    ...baseAttributes,
    class: `edge-rod-highlight${animate ? ' temp' : ''}`,
    transform: 'translate(-.35 -.45)',
  });
  if (animate) {
    [shadow, line, highlight].forEach((layer) => layer.style.setProperty('--player', owner?.color || '#2563eb'));
  }
  groups.lines.append(shadow, line, highlight);
  renderedEdges.add(moveKey);
  if (animate) {
    playSound('linedraw');
    setTimeout(() => [shadow, line, highlight].forEach((layer) => layer.classList.remove('temp')), (reducedMotion() ? 0 : 300) + 1000);
  }
}

function buildBoard() {
  svg.replaceChildren();
  const defs = svgElement('defs');
  defs.innerHTML = '<radialGradient id="dot-gradient" cx="28%" cy="20%" r="74%"><stop offset="0" stop-color="#fffdf5"/><stop offset=".14" stop-color="#ffe9a6"/><stop offset=".4" stop-color="#e6ac2e"/><stop offset=".72" stop-color="#9a6a12"/><stop offset="1" stop-color="#513608"/></radialGradient><filter id="peg-shadow" x="-60%" y="-60%" width="240%" height="240%"><feDropShadow dx=".8" dy="1.15" stdDeviation=".72" flood-color="#2b1a0d" flood-opacity=".62"/></filter>';
  svg.append(defs);
  groups.guides = svgElement('g', { class: 'guide-grid', 'aria-hidden': 'true' });
  groups.boxes = svgElement('g');
  groups.lines = svgElement('g');
  groups.dots = svgElement('g');
  groups.hits = svgElement('g');
  svg.append(groups.guides, groups.boxes, groups.lines, groups.dots, groups.hits);

  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLS - 1; column += 1) {
      const start = point(row * COLS + column);
      const end = point(row * COLS + column + 1);
      groups.guides.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: 'guide-line' }));
    }
  }
  for (let row = 0; row < ROWS - 1; row += 1) {
    for (let column = 0; column < COLS; column += 1) {
      const start = point(row * COLS + column);
      const end = point((row + 1) * COLS + column);
      groups.guides.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: 'guide-line' }));
    }
  }

  for (let index = 0; index < COLS * ROWS; index += 1) {
    const position = point(index);
    const dot = svgElement('circle', { cx: position.x, cy: position.y, r: 2.55, class: 'dot' });
    const highlight = svgElement('circle', {
      cx: position.x - 0.72, cy: position.y - 0.76, r: 0.55,
      class: 'peg-highlight', 'aria-hidden': 'true',
    });
    const hit = svgElement('circle', {
      cx: position.x, cy: position.y, r: 6.2, class: 'hit-target', tabindex: 0,
      role: 'button', 'aria-label': `Dot row ${position.row + 1}, column ${position.column + 1}`,
    });
    hit.addEventListener('click', () => choose(index));
    hit.addEventListener('focus', () => dot.classList.add('keyboard-focus'));
    hit.addEventListener('blur', () => dot.classList.remove('keyboard-focus'));
    hit.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        choose(index);
      }
    });
    groups.dots.append(dot, highlight);
    groups.hits.append(hit);
  }
}

function announceTurn() {
  if (game?.status === 'finished') return;
  const current = playerByKey(activeKey());
  if (!current) return;
  announce(current.slotKey === localPlayerKey
    ? 'Your turn. Choose a dot.'
    : `${current.name}'s turn.`);
}

async function commit(start, end) {
  locked = true;
  selected = null;
  paintSelection();
  announce('Sending move…');
  try {
    const committed = await onMoveRequest(start, end, game.revision);
    renderBoardState(committed);
  } catch (error) {
    console.error('Move failed:', error);
    playSound('error');
    announce(error?.message || 'Action failed — try again.');
    locked = false;
    paintSelection();
  }
}

function choose(id) {
  if (locked || game?.status !== 'playing') return;
  if (localPlayerKey !== '*' && activeKey() !== localPlayerKey) {
    playSound('error');
    announceTurn();
    return;
  }
  if (selected === null) {
    if (!availableFrom(id).length) {
      playSound('error');
      announce('No available line from this dot.');
      return;
    }
    playSound('tap');
    selected = id;
    announce('Now choose a glowing adjacent dot.');
    paintSelection();
    return;
  }
  if (id === selected) {
    playSound('tap');
    selected = null;
    announceTurn();
    paintSelection();
    return;
  }
  if (lineAvailable(selected, id)) {
    const start = selected;
    commit(start, id);
    return;
  }
  if (!availableFrom(id).length) {
    playSound('error');
    announce('Choose a glowing dot or another starting dot.');
    return;
  }
  playSound('tap');
  selected = id;
  announce('Start moved. Choose a glowing adjacent dot.');
  paintSelection();
}

export function renderBoardState(nextGame, options = {}) {
  if (!nextGame) return;
  if (renderedRound !== nextGame.roundId) {
    initializeBoard({ players, localPlayerKey, game: nextGame, onMoveRequest });
    return;
  }
  const shouldAnimate = options.animate !== false
    && nextGame.revision === renderedRevision + 1
    && nextGame.lastMove?.edgeKey
    && !renderedEdges.has(nextGame.lastMove.edgeKey);
  game = nextGame;
  Object.entries(game.edges || {}).forEach(([key, owner]) => {
    addEdge(
      key,
      owner,
      shouldAnimate && key === game.lastMove?.edgeKey,
      game.lastMove?.start,
      game.lastMove?.end,
    );
  });
  const previousBoxCount = renderedBoxes.size;
  Object.entries(game.boxes || {}).forEach(([key, owner]) => addBox(key, owner));
  if (shouldAnimate && renderedBoxes.size > previousBoxCount) playSound('boxclaim');
  renderedRevision = Number(game.revision || 0);
  selected = null;
  locked = false;
  renderCards();
  paintSelection();
  announceTurn();
}

export function initializeBoard(options = {}) {
  svg = document.getElementById('dots-board');
  cards = document.getElementById('player-cards');
  message = document.getElementById('game-message');
  players = (options.players || []).map((player) => ({ ...player }));
  localPlayerKey = options.localPlayerKey || null;
  onMoveRequest = typeof options.onMoveRequest === 'function' ? options.onMoveRequest : async () => {};
  game = options.game || null;
  selected = null;
  locked = false;
  renderedRound = game?.roundId ?? null;
  renderedRevision = Number(game?.revision || 0);
  renderedEdges = new Set();
  renderedBoxes = new Set();
  buildBoard();
  Object.entries(game?.edges || {}).forEach(([key, owner]) => addEdge(key, owner, false));
  Object.entries(game?.boxes || {}).forEach(([key, owner]) => addBox(key, owner));
  renderCards();
  paintSelection();
  announceTurn();
}
