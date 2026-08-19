import { auth, authReady, db } from './firebase-config.js';
import { applyMove, createGameState } from './game-engine.js';
import {
  get,
  off,
  onDisconnect,
  onValue,
  ref,
  remove,
  runTransaction,
  set,
} from 'firebase/database';

const ROOM_PATH = 'dots-and-boxes-rooms';
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_CODE_RE = /^[A-HJ-NP-Z]{4}$/;
const PLAYER_KEY_RE = /^player_([0-3])$/;
const COLORS = new Set(['#2563eb', '#db2777', '#16a34a', '#eab308', '#7c3aed', '#ea580c']);
const AVATARS = new Set(['🦊', '🐼', '🐸', '🦁', '🐙', '🦄']);
const TRANSIENT_CODES = new Set([
  'database/disconnected',
  'database/network-error',
  'database/unavailable',
  'auth/network-request-failed',
  'unavailable',
  'network-request-failed',
]);

const roomPath = (code) => `${ROOM_PATH}/${normalizeRoomCode(code)}`;
const playerKeyFor = (index) => `player_${index}`;
const playerIndexFrom = (key) => Number.parseInt(key.slice(7), 10);
const cleanName = (value, fallback = 'Player') => (String(value || '').trim() || fallback).slice(0, 16);
const now = () => Date.now();
let stopPresence = null;

export function normalizeRoomCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!ROOM_CODE_RE.test(code)) throw new Error('Invalid room code');
  return code;
}

async function requireUser() {
  const user = await authReady;
  if (!user?.uid || auth.currentUser?.uid !== user.uid) throw new Error('Authentication unavailable');
  return user;
}

export async function firebaseRetry(operation, maxRetries = 2, delayMs = 500) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = String(error?.code || '').toLowerCase();
      if (attempt >= maxRetries || !TRANSIENT_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
}

export function generateRoomCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join('');
}

function playerRecord(name, avatar, color, uid, joinedAt) {
  return {
    name: cleanName(name),
    avatar: AVATARS.has(avatar) ? avatar : '🦊',
    color: COLORS.has(color) ? color : '#2563eb',
    uid,
    connected: true,
    joinedAt,
  };
}

export async function createRoom(hostName, hostAvatar, hostColor) {
  const user = await requireUser();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const roomCode = generateRoomCode();
    const createdAt = now();
    const room = {
      schemaVersion: 1,
      meta: {
        hostUid: user.uid,
        hostName: cleanName(hostName, 'Host'),
        status: 'lobby',
        createdAt,
        lastActivity: createdAt,
      },
      players: {
        player_0: playerRecord(hostName, hostAvatar, hostColor, user.uid, createdAt),
      },
    };
    const result = await firebaseRetry(() => runTransaction(
      ref(db, roomPath(roomCode)),
      (current) => current === null ? room : undefined,
      { applyLocally: false },
    ));
    if (result.committed) return { roomCode, playerIndex: 0 };
  }
  throw new Error('Unable to reserve a room code.');
}

export async function getRoom(roomCode) {
  await requireUser();
  const snapshot = await firebaseRetry(() => get(ref(db, roomPath(roomCode))));
  return snapshot.exists() ? snapshot.val() : null;
}

export async function joinRoom(roomCode, playerName, playerAvatar, playerColor) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const roomRef = ref(db, roomPath(code));
  let room = await getRoom(code);
  if (!room) return { success: false, reason: 'Room not found.' };
  if (room.schemaVersion !== 1) return { success: false, reason: 'Room version is outdated.' };

  const ownedKey = Object.keys(room.players || {}).find((key) => room.players[key]?.uid === user.uid);
  if (ownedKey) {
    await firebaseRetry(() => set(ref(db, `${roomPath(code)}/players/${ownedKey}/connected`), true));
    return { success: true, playerIndex: playerIndexFrom(ownedKey) };
  }
  if (room.meta?.status !== 'lobby') return { success: false, reason: 'Game already in progress.' };
  if (!COLORS.has(playerColor)) return { success: false, reason: 'Choose a valid color.' };
  if (Object.values(room.players || {}).some((player) => player?.color === playerColor)) {
    return { success: false, reason: 'That color is already taken.' };
  }

  for (let index = 1; index <= 3; index += 1) {
    const key = playerKeyFor(index);
    try {
      const result = await runTransaction(
        ref(db, `${roomPath(code)}/players/${key}`),
        (current) => current === null
          ? playerRecord(playerName, playerAvatar, playerColor, user.uid, now())
          : undefined,
        { applyLocally: false },
      );
      if (result.committed) return { success: true, playerIndex: index };
    } catch (error) {
      if (!String(error?.code || '').toLowerCase().includes('permission-denied')) throw error;
      room = (await firebaseRetry(() => get(roomRef))).val() || {};
      const owned = Object.keys(room.players || {}).find((candidate) => room.players[candidate]?.uid === user.uid);
      if (owned) return { success: true, playerIndex: playerIndexFrom(owned) };
      if (Object.values(room.players || {}).some((player) => player?.color === playerColor)) {
        return { success: false, reason: 'That color is already taken.' };
      }
    }
  }
  return { success: false, reason: 'Room is full (4 players).' };
}

export async function restoreSession(roomCode, playerIndex) {
  const user = await requireUser();
  const index = Number(playerIndex);
  const key = playerKeyFor(index);
  if (!PLAYER_KEY_RE.test(key)) return null;
  const room = await getRoom(roomCode);
  if (!room || room.schemaVersion !== 1 || room.players?.[key]?.uid !== user.uid) return null;
  await firebaseRetry(() => set(ref(db, `${roomPath(roomCode)}/players/${key}/connected`), true));
  return {
    roomCode: normalizeRoomCode(roomCode),
    playerIndex: index,
    isHost: room.meta?.hostUid === user.uid,
  };
}

export function listenRoom(roomCode, callbacks = {}) {
  const roomRef = ref(db, roomPath(roomCode));
  const handler = (snapshot) => {
    if (!snapshot.exists()) {
      callbacks.onRoomDeleted?.();
      return;
    }
    const room = snapshot.val();
    if (room.schemaVersion !== 1) {
      callbacks.onError?.(new Error('Unsupported room version.'));
      return;
    }
    callbacks.onRoomSnapshot?.(room);
    callbacks.onPlayersChange?.(room.players || {}, room);
    if (room.game) callbacks.onGameUpdate?.(room.game, room);
    const status = room.game?.status === 'finished'
      ? 'finished'
      : room.game?.status === 'playing' || room.meta?.status === 'active'
        ? 'active'
        : room.meta?.status;
    callbacks.onStatusChange?.(status, room);
  };
  onValue(roomRef, handler, (error) => callbacks.onError?.(error));
  return () => off(roomRef, 'value', handler);
}

export async function setupDisconnectHandler(roomCode, playerIndex) {
  await stopPresenceTracking();
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  if (!PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot.');
  const playerRef = ref(db, `${roomPath(code)}/players/${key}`);
  const snapshot = await firebaseRetry(() => get(playerRef));
  if (!snapshot.exists() || snapshot.val()?.uid !== user.uid) {
    throw new Error('Player session is no longer valid.');
  }

  const connectedRef = ref(db, `${roomPath(code)}/players/${key}/connected`);
  const infoRef = ref(db, '.info/connected');
  let registration = null;
  let disposed = false;
  const handler = async (connectedSnapshot) => {
    if (!connectedSnapshot.val() || disposed) return;
    try {
      registration = onDisconnect(connectedRef);
      await registration.set(false);
      if (!disposed) await set(connectedRef, true);
    } catch (error) {
      console.warn('Presence update failed:', error);
    }
  };
  onValue(infoRef, handler);
  stopPresence = async () => {
    disposed = true;
    off(infoRef, 'value', handler);
    try { await registration?.cancel(); } catch (_) {}
  };
  return stopPresence;
}

export async function stopPresenceTracking() {
  const cleanup = stopPresence;
  stopPresence = null;
  if (cleanup) await cleanup();
}

export async function leavePlayer(roomCode, playerIndex) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  if (key === 'player_0' || !PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot.');
  const snapshot = await firebaseRetry(() => get(ref(db, `${roomPath(code)}/players/${key}`)));
  if (!snapshot.exists() || snapshot.val()?.uid !== user.uid) throw new Error('Player session is no longer valid.');
  await stopPresenceTracking();
  try { await onDisconnect(ref(db, `${roomPath(code)}/players/${key}/connected`)).cancel(); } catch (_) {}
  await firebaseRetry(() => remove(ref(db, `${roomPath(code)}/players/${key}`)));
}

export async function removePlayer(roomCode, playerIndex) {
  await requireUser();
  const key = playerKeyFor(playerIndex);
  if (key === 'player_0' || !PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot.');
  await firebaseRetry(() => remove(ref(db, `${roomPath(roomCode)}/players/${key}`)));
}

export async function deleteRoom(roomCode) {
  await requireUser();
  await stopPresenceTracking();
  await firebaseRetry(() => remove(ref(db, roomPath(roomCode))));
}


export async function startGameState(roomCode) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const timestamp = now();
  const result = await runTransaction(ref(db, roomPath(code)), (current) => {
    if (!current || current.meta?.hostUid !== user.uid || current.meta?.status !== 'lobby' || current.game) return undefined;
    const playerKeys = Object.keys(current.players || {})
      .filter((key) => PLAYER_KEY_RE.test(key) && current.players[key]?.uid)
      .sort();
    if (playerKeys.length < 2 || playerKeys.length > 4) return undefined;
    return {
      ...current,
      meta: { ...current.meta, status: 'active', lastActivity: timestamp },
      game: createGameState(playerKeys, user.uid, timestamp),
    };
  }, { applyLocally: false });
  if (!result.committed) throw new Error('Unable to start the game. Check that 2–4 players are in the lobby.');
  return result.snapshot.val().game;
}

export async function commitGameMove(roomCode, playerIndex, expectedRevision, start, end) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  if (!PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot.');
  const result = await runTransaction(ref(db, `${roomPath(code)}/game`), (current) => {
    if (!current || current.status !== 'playing' || current.revision !== expectedRevision) return undefined;
    try {
      return applyMove(current, key, start, end, user.uid, now());
    } catch (_) {
      return undefined;
    }
  }, { applyLocally: false });
  if (!result.committed) throw new Error('Move was not committed. The turn or board changed.');
  return result.snapshot.val();
}

export async function resetGameToLobby(roomCode) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const timestamp = now();
  const result = await runTransaction(ref(db, roomPath(code)), (current) => {
    if (!current || current.meta?.hostUid !== user.uid || current.game?.status !== 'finished') return undefined;
    const next = {
      ...current,
      meta: { ...current.meta, status: 'lobby', lastActivity: timestamp },
    };
    delete next.game;
    return next;
  }, { applyLocally: false });
  if (!result.committed) throw new Error('Unable to prepare a new game.');
}


export async function startSharedGame(roomCode) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const result = await firebaseRetry(() => runTransaction(ref(db, roomPath(code)), (current) => {
    if (!current || current.meta?.hostUid !== user.uid || current.meta?.status !== 'lobby' || current.game) return undefined;
    const playerKeys = Object.keys(current.players || {})
      .filter((key) => PLAYER_KEY_RE.test(key) && current.players[key]?.uid)
      .sort();
    if (playerKeys.length < 2 || playerKeys.length > 4) return undefined;
    const timestamp = now();
    return {
      ...current,
      meta: { ...current.meta, status: 'active', lastActivity: timestamp },
      game: createGameState(playerKeys, user.uid, timestamp),
    };
  }, { applyLocally: false }));
  if (!result.committed) throw new Error('Unable to start the game. Check that 2–4 players are in the lobby.');
  return result.snapshot.val().game;
}

export async function commitSharedMove(roomCode, playerIndex, expectedRevision, start, end) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  if (!PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot.');
  let moveError = null;
  const result = await runTransaction(ref(db, `${roomPath(code)}/game`), (current) => {
    if (!current || current.revision !== expectedRevision) return undefined;
    try {
      return applyMove(current, key, start, end, user.uid, now());
    } catch (error) {
      moveError = error;
      return undefined;
    }
  }, { applyLocally: false });
  if (!result.committed) throw moveError || new Error('The turn changed — try again.');
  return result.snapshot.val();
}

export async function resetSharedGame(roomCode) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const result = await firebaseRetry(() => runTransaction(ref(db, roomPath(code)), (current) => {
    if (!current || current.meta?.hostUid !== user.uid || current.game?.status !== 'finished') return undefined;
    const next = {
      ...current,
      meta: { ...current.meta, status: 'lobby', lastActivity: now() },
    };
    delete next.game;
    return next;
  }, { applyLocally: false }));
  if (!result.committed) throw new Error('Unable to prepare a new game.');
}
