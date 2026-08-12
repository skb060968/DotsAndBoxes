// Firebase Configuration
// Replace these values with your actual Firebase project credentials
// Get them from: Firebase Console → Project Settings → General → Your apps → Web app

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Initialize Firebase
let app, database, dbRef;

function initializeFirebase() {
  try {
    // Initialize Firebase
    app = firebase.initializeApp(firebaseConfig);
    database = firebase.database();
    dbRef = firebase.database().ref();
    
    console.log('✅ Firebase initialized successfully');
    return true;
  } catch (error) {
    console.error('❌ Firebase initialization error:', error);
    return false;
  }
}

// Firebase Database Helper Functions
const FirebaseDB = {
  // Initialize
  init: initializeFirebase,
  
  // Get database reference
  getRef: (path) => {
    return firebase.database().ref(path);
  },
  
  // Room operations
  rooms: {
    create: async (roomData) => {
      const roomRef = dbRef.child('rooms').push();
      await roomRef.set(roomData);
      
      // Add code mapping
      await dbRef.child('roomCodes').child(roomData.code).set(roomRef.key);
      
      return roomRef.key;
    },
    
    get: (roomId) => {
      return dbRef.child('rooms').child(roomId).once('value');
    },
    
    getByCode: async (code) => {
      const codeSnapshot = await dbRef.child('roomCodes').child(code).once('value');
      const roomId = codeSnapshot.val();
      
      if (!roomId) return null;
      
      const roomSnapshot = await dbRef.child('rooms').child(roomId).once('value');
      return { id: roomId, data: roomSnapshot.val() };
    },
    
    update: (roomId, updates) => {
      return dbRef.child('rooms').child(roomId).update(updates);
    },
    
    delete: async (roomId) => {
      const roomSnapshot = await dbRef.child('rooms').child(roomId).once('value');
      const room = roomSnapshot.val();
      
      if (room && room.code) {
        await dbRef.child('roomCodes').child(room.code).remove();
      }
      
      return dbRef.child('rooms').child(roomId).remove();
    },
    
    listen: (roomId, callback) => {
      const roomRef = dbRef.child('rooms').child(roomId);
      roomRef.on('value', (snapshot) => {
        callback(snapshot.val());
      });
      return roomRef;
    },
    
    stopListening: (roomRef) => {
      if (roomRef) {
        roomRef.off('value');
      }
    }
  },
  
  // Player operations
  players: {
    add: (roomId, playerId, playerData) => {
      return dbRef.child('rooms').child(roomId).child('players').child(playerId).set(playerData);
    },
    
    update: (roomId, playerId, updates) => {
      return dbRef.child('rooms').child(roomId).child('players').child(playerId).update(updates);
    },
    
    remove: (roomId, playerId) => {
      return dbRef.child('rooms').child(roomId).child('players').child(playerId).remove();
    },
    
    updateLastActive: (roomId, playerId) => {
      return dbRef.child('rooms').child(roomId).child('players').child(playerId)
        .update({ lastActive: Date.now() });
    }
  },
  
  // Game operations
  game: {
    update: (roomId, gameData) => {
      return dbRef.child('rooms').child(roomId).child('game').update(gameData);
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
      
      return dbRef.child('rooms').child(roomId).update(updates);
    },
    
    updateBox: (roomId, row, col, player) => {
      return dbRef.child('rooms').child(roomId).child('game').child('boxes')
        .child(row).child(col).set(player);
    },
    
    updateScore: (roomId, playerNumber, score) => {
      return dbRef.child('rooms').child(roomId).child('game').child('scores')
        .child(playerNumber.toString()).set(score);
    },
    
    setCurrentPlayer: (roomId, playerNumber) => {
      return dbRef.child('rooms').child(roomId).child('game')
        .update({ currentPlayer: playerNumber });
    },
    
    setGameOver: (roomId, winner) => {
      return dbRef.child('rooms').child(roomId).child('game')
        .update({ isGameOver: true, winner: winner });
    },
    
    reset: (roomId, initialGameState) => {
      return dbRef.child('rooms').child(roomId).child('game').set(initialGameState);
    }
  },
  
  // Presence system
  presence: {
    setOnline: (userId, roomId = null) => {
      const presenceRef = dbRef.child('presence').child(userId);
      
      // Set online status
      presenceRef.set({
        status: 'online',
        lastSeen: Date.now(),
        roomId: roomId
      });
      
      // Set to offline on disconnect
      presenceRef.onDisconnect().update({
        status: 'offline',
        lastSeen: Date.now()
      });
      
      return presenceRef;
    },
    
    setOffline: (userId) => {
      return dbRef.child('presence').child(userId).update({
        status: 'offline',
        lastSeen: Date.now()
      });
    },
    
    listen: (userId, callback) => {
      const presenceRef = dbRef.child('presence').child(userId);
      presenceRef.on('value', (snapshot) => {
        callback(snapshot.val());
      });
      return presenceRef;
    }
  },
  
  // Cleanup old rooms (rooms older than 24 hours)
  cleanupOldRooms: async () => {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const roomsSnapshot = await dbRef.child('rooms').once('value');
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
      
      const codeSnapshot = await dbRef.child('roomCodes').child(code).once('value');
      exists = codeSnapshot.exists();
      attempts++;
    }
    
    if (attempts >= maxAttempts) {
      throw new Error('Failed to generate unique room code');
    }
    
    return code;
  }
};

// Export for use in other files
window.FirebaseDB = FirebaseDB;
