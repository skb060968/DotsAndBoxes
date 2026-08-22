import { auth, db } from './firebase-config.js';
import {
  get, off, onDisconnect, onValue, push, ref, remove, runTransaction, set,
} from 'firebase/database';

/**
 * Optional 1:1 voice chat for a Dots & Boxes room (Option C: STUN only, no TURN).
 *
 * - Opt-in: nothing captures the mic until the player taps "Join voice".
 * - Capped at 2 participants per room, so this is always a single peer
 *   connection (no mesh), which is the most reliable configuration.
 * - Firebase Realtime Database is used only for signalling (offer/answer/ICE).
 * - iOS-safe: mic capture and audio playback are triggered from the user's tap;
 *   the remote <audio> element is playsinline + autoplay.
 * - Never blocks gameplay: any failure is reported via onStatus and the game
 *   continues normally.
 *
 * STUN-only means connections succeed on the same Wi-Fi and many networks but
 * can fail when both peers are behind restrictive mobile/carrier NAT. Adding a
 * TURN relay later is the upgrade path.
 */

const ROOM_PATH = 'dots-and-boxes-rooms';
const MAX_VOICE = 2;
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const PLAYER_KEY_RE = /^player_[0-3]$/;

export function createVoiceChat({ roomCode, playerKey, uid, onStatus }) {
  if (!PLAYER_KEY_RE.test(playerKey || '')) throw new Error('Invalid player slot for voice');
  const base = `${ROOM_PATH}/${roomCode}/voice`;
  const participantsRef = ref(db, `${base}/participants`);
  const myParticipantRef = ref(db, `${base}/participants/${playerKey}`);
  const mySignalRef = ref(db, `${base}/signals/${playerKey}`);

  let joined = false;
  let muted = false;
  let connected = false;
  let localStream = null;
  let peer = null;
  let remoteAudio = null;
  let otherKey = null;
  let participantsUnsub = null;
  let remoteUnsub = null;
  let disconnectHandle = null;
  const pendingCandidates = [];
  let closed = false;

  const emit = (state, detail = {}) => {
    onStatus?.({ state, joined, muted, connected, ...detail });
  };

  function stopRemoteListener() {
    if (remoteUnsub) { remoteUnsub(); remoteUnsub = null; }
  }

  function teardownPeer() {
    stopRemoteListener();
    pendingCandidates.length = 0;
    if (peer) {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      try { peer.close(); } catch (_) {}
      peer = null;
    }
    if (remoteAudio) {
      try { remoteAudio.srcObject = null; remoteAudio.remove(); } catch (_) {}
      remoteAudio = null;
    }
    connected = false;
    // Clear our signalling so a fresh negotiation can start cleanly next time.
    remove(ref(db, `${base}/signals/${playerKey}`)).catch(() => {});
  }

  function ensureRemoteAudio() {
    if (remoteAudio) return remoteAudio;
    remoteAudio = document.createElement('audio');
    remoteAudio.autoplay = true;
    remoteAudio.setAttribute('playsinline', '');
    remoteAudio.dataset.voiceRemote = 'true';
    document.body.appendChild(remoteAudio);
    return remoteAudio;
  }

  async function writeDescription(description) {
    await set(ref(db, `${base}/signals/${playerKey}/description`), {
      type: description.type,
      sdp: description.sdp,
    });
  }

  async function flushPendingCandidates() {
    if (!peer || !peer.remoteDescription) return;
    while (pendingCandidates.length) {
      const candidate = pendingCandidates.shift();
      try { await peer.addIceCandidate(candidate); } catch (_) {}
    }
  }

  function listenToRemote() {
    stopRemoteListener();
    const remoteSignalRef = ref(db, `${base}/signals/${otherKey}`);
    const handler = async (snapshot) => {
      if (closed || !peer) return;
      const data = snapshot.val() || {};
      // Remote description
      const description = data.description;
      if (description && description.type && description.sdp) {
        const alreadySet = peer.currentRemoteDescription
          && peer.currentRemoteDescription.type === description.type;
        if (!alreadySet) {
          try {
            await peer.setRemoteDescription(description);
            await flushPendingCandidates();
            if (description.type === 'offer') {
              const answer = await peer.createAnswer();
              await peer.setLocalDescription(answer);
              await writeDescription(peer.localDescription);
            }
          } catch (_) { /* renegotiation race; ignore */ }
        }
      }
      // Remote ICE candidates
      const candidates = data.candidates || {};
      for (const key of Object.keys(candidates)) {
        const entry = candidates[key];
        if (!entry || !entry.candidate) continue;
        const candidate = {
          candidate: entry.candidate,
          sdpMid: entry.sdpMid ?? null,
          sdpMLineIndex: entry.sdpMLineIndex ?? null,
        };
        if (peer.remoteDescription) {
          try { await peer.addIceCandidate(candidate); } catch (_) {}
        } else {
          pendingCandidates.push(candidate);
        }
      }
    };
    onValue(remoteSignalRef, handler);
    remoteUnsub = () => off(remoteSignalRef, 'value', handler);
  }

  async function establishConnection() {
    if (peer || !otherKey || !localStream) return;
    emit('connecting', { otherKey });
    // Start each negotiation from a clean slate.
    await remove(ref(db, `${base}/signals/${playerKey}`)).catch(() => {});

    peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));

    peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      const json = event.candidate.toJSON();
      push(ref(db, `${base}/signals/${playerKey}/candidates`), {
        candidate: json.candidate,
        sdpMid: json.sdpMid ?? null,
        sdpMLineIndex: json.sdpMLineIndex ?? null,
      }).catch(() => {});
    };
    peer.ontrack = (event) => {
      const audio = ensureRemoteAudio();
      audio.srcObject = event.streams[0];
      audio.play?.().catch(() => {});
    };
    peer.onconnectionstatechange = () => {
      if (!peer) return;
      if (peer.connectionState === 'connected') {
        connected = true;
        emit('connected', { otherKey });
      } else if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
        connected = false;
        emit(joined ? 'waiting' : 'idle', { otherKey });
      }
    };

    listenToRemote();

    // Deterministic role: lower slot key creates the offer, the other answers.
    const isInitiator = playerKey < otherKey;
    if (isInitiator) {
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await writeDescription(peer.localDescription);
      } catch (_) {
        emit('error', { message: 'Could not start voice.' });
      }
    }
  }

  function watchParticipants() {
    const handler = (snapshot) => {
      if (closed) return;
      const participants = snapshot.val() || {};
      const others = Object.keys(participants)
        .filter((key) => PLAYER_KEY_RE.test(key) && key !== playerKey && participants[key]?.uid);
      const nextOther = others.sort()[0] || null;

      if (nextOther !== otherKey) {
        // The partner changed (joined, left, or swapped) — reset the peer.
        teardownPeer();
        otherKey = nextOther;
      }
      if (otherKey && !peer) {
        establishConnection();
      } else if (!otherKey) {
        emit('waiting');
      }
    };
    onValue(participantsRef, handler);
    participantsUnsub = () => off(participantsRef, 'value', handler);
  }

  async function join() {
    if (joined) return { ok: true };
    if (!auth.currentUser || auth.currentUser.uid !== uid) {
      emit('error', { message: 'Not connected. Try again.' });
      return { ok: false, reason: 'auth' };
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      emit('error', { message: 'Voice chat is not supported on this device.' });
      return { ok: false, reason: 'unsupported' };
    }

    // Mic capture must happen in the tap handler for iOS to grant permission.
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (_) {
      emit('error', { message: 'Microphone permission is needed for voice.' });
      return { ok: false, reason: 'mic' };
    }

    // Claim a voice slot atomically; enforce the 2-participant cap.
    let full = false;
    const result = await runTransaction(participantsRef, (current) => {
      const map = current || {};
      if (map[playerKey]?.uid === uid) return map; // already in (reconnect)
      const count = Object.keys(map).filter((key) => map[key]?.uid).length;
      if (count >= MAX_VOICE) { full = true; return undefined; }
      map[playerKey] = { uid, joinedAt: Date.now() };
      return map;
    }, { applyLocally: false }).catch(() => ({ committed: false }));

    if (full || !result.committed) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
      emit(full ? 'full' : 'error', { message: full ? 'Voice is full (2 players).' : 'Could not join voice.' });
      return { ok: false, reason: full ? 'full' : 'error' };
    }

    joined = true;
    muted = false;
    // Auto-clean our voice data if the tab closes or disconnects.
    disconnectHandle = onDisconnect(myParticipantRef);
    disconnectHandle.remove().catch(() => {});
    onDisconnect(mySignalRef).remove().catch(() => {});

    emit('waiting');
    watchParticipants();
    return { ok: true };
  }

  async function leave() {
    if (!joined && !localStream) return;
    joined = false;
    if (participantsUnsub) { participantsUnsub(); participantsUnsub = null; }
    teardownPeer();
    otherKey = null;
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }
    try { await disconnectHandle?.cancel(); } catch (_) {}
    try { await onDisconnect(mySignalRef).cancel(); } catch (_) {}
    await remove(mySignalRef).catch(() => {});
    await remove(myParticipantRef).catch(() => {});
    muted = false;
    connected = false;
    emit('idle');
  }

  function toggleMute() {
    if (!localStream) return muted;
    muted = !muted;
    localStream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    emit(connected ? 'connected' : 'waiting');
    return muted;
  }

  function destroy() {
    closed = true;
    leave();
  }

  return {
    join,
    leave,
    toggleMute,
    destroy,
    isJoined: () => joined,
    isMuted: () => muted,
  };
}
