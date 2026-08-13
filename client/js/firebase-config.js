// Firebase Configuration - Modular SDK with Vite
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, push, set, get, update, remove, onValue, off, onDisconnect } from 'firebase/database';

// Firebase configuration from environment variables
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

// Initialize Firebase
let app, database;

function initializeFirebase() {
  try {
    app = initializeApp(firebaseConfig);
    database = getDatabase(app);
    
    console.log('✅ Firebase initialized successfully');
    return true;
  } catch (error) {
    console.error('❌ Firebase initialization error:', error);
    return false;
  }
}

// Helper function to get database reference
function getDbRef(path = '') {
  return ref(database, path);
}

// Firebase Database Helper Functions
export const FirebaseDB = {
  // Initialize
  init: initializeFirebase,
  
  // Get database reference
  getRef: (path) => getDbRef(path),
  
  // Room operations
  rooms: {
    create: async (roomData) => {
      const roomsRef = getDbRef('rooms');
      const newRoomRef = push(roomsRef);
      await set(newRoomRef, roomData);
      
      // Add code mapping
      const codeRef = getDbRef(`roomCodes/${roomData.code}`);
      await set(codeRef, newRoomRef.key);
      
      return newRoomRef.key;
    },
    
    get: (roomId) => {
      const roomRef = getDbRef(`rooms/${roomId}`);
      return get(roomRef);
    },
    
    getByCode: async (code) => {
      const codeRef = getDbRef(`roomCodes/${code}`);
      const codeSnapshot = await get(codeRef);
      const roomId = codeSnapshot.val();
      
      if (!roomId) return null;
      
      const roomRef = getDbRef(`rooms/${roomId}`);
      const roomSnapshot = await get(roomRef);
      return { id: roomId, data: roomSnapshot.val() };
    },
    
    update: (roomId, updates) => {
      const roomRef = getDbRef(`rooms/${roomId}`);
      return update(roomRef, updates);
    },
    
    delete: async (roomId) => {
      const roomRef = getDbRef(`rooms/${roomId}`);
      const roomSnapshot = await get(roomRef);
      const room = roomSnapshot.val();
      
      if (room && room.code) {
        const codeRef = getDbRef(`roomCodes/${room.code}`);
        await remove(codeRef);
      }
      
      return remove(roomRef);
    },
    
    listen: (roomId, callback) => {
      const roomRef = getDbRef(`rooms/${roomId}`);
      onValue(roomRef, (snapshot) => {
        callback(snapshot.val());
      });
      return roomRef;
    },
    
    stopListening: (roomRef) => {
      if (roomRef) {
        off(roomRef, 'value');
      }
    }
  },
  
  // Player operations
  players: {
    add: (roomId, playerId, playerData) => {
      const playerRef = getDbRef(`rooms/${roomId}/players/${playerId}`);
      return set(playerRef, playerData);
    },
    
    update: (roomId, playerId, updates) => {
      const playerRef = getDbRef(`rooms/${roomId}/players/${playerId}`);
      return update(playerRef, updates);
    },
    
    remove: (roomId, playerId) => {
      const playerRef = getDbRef(`rooms/${roomId}/players/${playerId}`);
      return remove(playerRef);
    },
    
    updateLastActive: (roomId, playerId) => {
      const playerRef = getDbRef(`rooms/${roomId}/players/${playerId}`);
      return update(playerRef, { lastActive: Date.now() });
    }
  },
  
  // Game operations
  game: {
    update: (roomId, gameData) => {
      const gameRef = getDbRef(`rooms/${roomId}/game`);
      return update(gameRef, gameData);
    },
    
    makeMove: async (roomId, moveData) => {
      const updates = {};
      
      // Update the specific line
      if (moveData.type === 'horizontal') {
        updates[`game/horizontalLines/${moveData.row}/${moveData.col}`] = moveData.player;
      } else {
        updates[`game/verticalLines/${moveData.row}/${moveData.col}`] = moveData.player;
      }
      
      // Update last move
      updates['game/lastMove'] = {
        type: moveData.type,
        row: moveData.row,
        col: moveData.col,
        player: moveData.player,
        timestamp: Date.now()
      };
      
      const roomRef = getDbRef(`rooms/${roomId}`);
      return update(roomRef, updates);
    },
    
    updateBox: (roomId, row, col, player) => {
      const boxRef = getDbRef(`rooms/${roomId}/game/boxes/${row}/${col}`);
      return set(boxRef, player);
    },
    
    updateScore: (roomId, playerNumber, score) => {
      const scoreRef = getDbRef(`rooms/${roomId}/game/scores/${playerNumber}`);
      return set(scoreRef, score);
    },
    
    setCurrentPlayer: (roomId, playerNumber) => {
      const gameRef = getDbRef(`rooms/${roomId}/game`);
      return update(gameRef, { currentPlayer: playerNumber });
    },
    
    setGameOver: (roomId, winner) => {
      const gameRef = getDbRef(`rooms/${roomId}/game`);
      return update(gameRef, { isGameOver: true, winner: winner });
    },
    
    reset: (roomId, initialGameState) => {
      const gameRef = getDbRef(`rooms/${roomId}/game`);
      return set(gameRef, initialGameState);
    }
  },
  
  // Presence system
  presence: {
    setOnline: (userId, roomId = null) => {
      const presenceRef = getDbRef(`presence/${userId}`);
      
      // Set online status
      set(presenceRef, {
        status: 'online',
        lastSeen: Date.now(),
        roomId: roomId
      });
      
      // Set to offline on disconnect
      const disconnectRef = onDisconnect(presenceRef);
      disconnectRef.update({
        status: 'offline',
        lastSeen: Date.now()
      });
      
      return presenceRef;
    },
    
    setOffline: (userId) => {
      const presenceRef = getDbRef(`presence/${userId}`);
      return update(presenceRef, {
        status: 'offline',
        lastSeen: Date.now()
      });
    },
    
    listen: (userId, callback) => {
      const presenceRef = getDbRef(`presence/${userId}`);
      onValue(presenceRef, (snapshot) => {
        callback(snapshot.val());
      });
      return presenceRef;
    }
  },
  
  // Cleanup old rooms (rooms older than 24 hours)
  cleanupOldRooms: async () => {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const roomsRef = getDbRef('rooms');
    const roomsSnapshot = await get(roomsRef);
    const rooms = roomsSnapshot.val();
    
    if (!rooms) return;
    
    const deletePromises = [];
    
    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      if (room.createdAt < oneDayAgo && room.status !== 'playing') {
        deletePromises.push(FirebaseDB.rooms.delete(roomId));
      }
    });
    
    await Promise.all(deletePromises);
    console.log(`Cleaned up ${deletePromises.length} old rooms`);
  },
  
  // Generate unique room code
  generateRoomCode: async () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code;
    let exists = true;
    let attempts = 0;
    const maxAttempts = 50;
    
    while (exists && attempts < maxAttempts) {
      code = '';
      for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      
      const codeRef = getDbRef(`roomCodes/${code}`);
      const codeSnapshot = await get(codeRef);
      exists = codeSnapshot.exists();
      attempts++;
    }
    
    if (attempts >= maxAttempts) {
      throw new Error('Failed to generate unique room code');
    }
    
    return code;
  }
};

