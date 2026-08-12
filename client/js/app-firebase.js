// Main Application Logic - Firebase Version
class DotsAndBoxesApp {
  constructor() {
    this.gameState = null;
    this.roomId = null;
    this.roomCode = null;
    this.playerId = null;
    this.playerNumber = null;
    this.playerName = '';
    this.playerAvatar = '😀';
    this.players = [];
    this.maxPlayers = 3;
    this.canvas = null;
    this.roomListener = null;
    this.heartbeatInterval = null;
    
    this.init();
  }

  init() {
    // Initialize Firebase
    if (!FirebaseDB.init()) {
      this.showToast('Failed to initialize Firebase. Check configuration.', 'error');
      return;
    }
    
    this.setupEventListeners();
    this.loadPlayerData();
    this.generatePlayerId();
    
    // Initialize sound on first user interaction
    document.addEventListener('click', () => {
      if (!window.soundManager.initialized) {
        window.soundManager.init();
      }
    }, { once: true });
    
    // Check for room code in URL
    this.checkURLForRoomCode();
    
    // Cleanup old rooms periodically (once per hour)
    setInterval(() => {
      FirebaseDB.cleanupOldRooms();
    }, 60 * 60 * 1000);
  }

  generatePlayerId() {
    // Generate unique player ID
    this.playerId = 'player_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('playerId', this.playerId);
  }

  checkURLForRoomCode() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    
    if (code && code.length === 4) {
      document.getElementById('roomCodeInput').value = code.toUpperCase();
      this.showScreen('joinRoomScreen');
      this.showToast(`Room code ${code} detected!`, 'info');
    }
  }

  setupEventListeners() {
    // Splash screen buttons
    document.getElementById('createRoomBtn').addEventListener('click', () => {
      window.soundManager.playClick();
      this.showScreen('createRoomScreen');
    });

    document.getElementById('joinRoomBtn').addEventListener('click', () => {
      window.soundManager.playClick();
      this.showScreen('joinRoomScreen');
    });

    document.getElementById('howToPlayBtn').addEventListener('click', () => {
      window.soundManager.playClick();
      this.showScreen('howtoScreen');
    });

    // Create room screen
    document.getElementById('createRoomSubmit').addEventListener('click', () => {
      window.soundManager.playClick();
      this.createRoom();
    });

    document.getElementById('backFromCreate').addEventListener('click', () => {
      window.soundManager.playClick();
      this.showScreen('splashScreen');
    });

    // Join room screen
    document.getElementById('joinRoomSubmit').addEventListener('click', () => {
      window.soundManager.playClick();
      this.joinRoom();
    });

    document.getElementById('backFromJoin').addEventListener('click', () => {
      window.soundManager.playClick();
      this.showScreen('splashScreen');
    });

    // How to play screen
    document.getElementById('backFromHowto').addEventListener('click', () => {
      window.soundManager.playClick();
      this.showScreen('splashScreen');
    });

    // Waiting screen
    document.getElementById('copyRoomCodeBtn').addEventListener('click', () => {
      window.soundManager.playClick();
      this.copyRoomCode();
    });

    document.getElementById('shareRoomBtn').addEventListener('click', () => {
      window.soundManager.playClick();
      this.shareRoom();
    });

    document.getElementById('generateQRBtn').addEventListener('click', () => {
      window.soundManager.playClick();
      this.showQRCode();
    });

    document.getElementById('closeQRModal').addEventListener('click', () => {
      window.soundManager.playClick();
      this.closeQRModal();
    });

    document.getElementById('qrModal').addEventListener('click', (e) => {
      if (e.target.id === 'qrModal') {
        this.closeQRModal();
      }
    });

    document.getElementById('cancelWaitBtn').addEventListener('click', () => {
      window.soundManager.playClick();
      this.leaveRoom();
    });

    // Game screen
    document.getElementById('leaveGameBtn').addEventListener('click', () => {
      window.soundManager.playClick();
      this.leaveGame();
    });

    // Game over screen
    document.getElementById('playAgainBtn').addEventListener('click', () => {
      window.soundManager.playClick();
      this.requestRematch();
    });

    document.getElementById('backToMenuBtn').addEventListener('click', () => {
      window.soundManager.playClick();
      this.leaveGame();
    });

    // Avatar selection
    this.setupAvatarSelection('hostAvatarOptions', 'hostNameInput');
    this.setupAvatarSelection('guestAvatarOptions', 'guestNameInput');

    // Player count selection
    document.querySelectorAll('.player-count-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        window.soundManager.playClick();
        document.querySelectorAll('.player-count-btn').forEach(b => b.classList.remove('selected'));
        e.target.classList.add('selected');
        this.maxPlayers = parseInt(e.target.dataset.count);
      });
    });

    // Hover sounds for buttons
    document.querySelectorAll('.btn').forEach(btn => {
      btn.addEventListener('mouseenter', () => {
        // Subtle hover sound (optional)
      });
    });
  }

  setupAvatarSelection(containerId, inputId) {
    const container = document.getElementById(containerId);
    const input = document.getElementById(inputId);
    
    container.querySelectorAll('.avatar-option').forEach(avatar => {
      avatar.addEventListener('click', () => {
        window.soundManager.playClick();
        container.querySelectorAll('.avatar-option').forEach(a => a.classList.remove('selected'));
        avatar.classList.add('selected');
        this.playerAvatar = avatar.textContent;
        
        // Store selection
        if (inputId === 'hostNameInput') {
          localStorage.setItem('playerAvatar', this.playerAvatar);
        }
      });
    });
  }

  async createRoom() {
    this.playerName = document.getElementById('hostNameInput').value.trim() || 'Host';
    
    if (!this.playerName) {
      this.showToast('Please enter your name', 'error');
      window.soundManager.playError();
      return;
    }
    
    this.savePlayerData();
    
    try {
      // Generate unique room code
      const code = await FirebaseDB.generateRoomCode();
      
      // Initialize game state
      const initialGameState = {
        currentPlayer: 1,
        rows: 11,
        cols: 6,
        horizontalLines: this.createEmptyLines(11, 6),
        verticalLines: this.createEmptyLines(10, 7),
        boxes: this.createEmptyBoxes(10, 5),
        scores: { 1: 0, 2: 0, 3: 0, 4: 0 },
        isGameOver: false,
        winner: null,
        lastMove: null
      };
      
      // Create room data
      const roomData = {
        id: null, // Will be set by Firebase
        code: code,
        hostId: this.playerId,
        maxPlayers: this.maxPlayers,
        currentPlayers: 1,
        status: 'waiting',
        createdAt: Date.now(),
        players: {
          [this.playerId]: {
            id: this.playerId,
            name: this.playerName,
            avatar: this.playerAvatar,
            playerNumber: 1,
            score: 0,
            isHost: true,
            lastActive: Date.now()
          }
        },
        game: initialGameState
      };
      
      // Create room in Firebase
      this.roomId = await FirebaseDB.rooms.create(roomData);
      this.roomCode = code;
      this.playerNumber = 1;
      
      // Set presence
      FirebaseDB.presence.setOnline(this.playerId, this.roomId);
      
      // Start listening to room updates
      this.listenToRoom();
      
      // Start heartbeat
      this.startHeartbeat();
      
      // Show waiting screen
      this.showScreen('waitingScreen');
      document.getElementById('displayRoomCode').textContent = this.roomCode;
      this.updatePlayerSlots();
      
      this.showToast('Room created successfully!', 'success');
      console.log(`Room created: ${this.roomCode} (${this.roomId})`);
      
    } catch (error) {
      console.error('Error creating room:', error);
      this.showToast('Failed to create room', 'error');
      window.soundManager.playError();
    }
  }

  async joinRoom() {
    this.playerName = document.getElementById('guestNameInput').value.trim() || 'Guest';
    const roomCode = document.getElementById('roomCodeInput').value.trim().toUpperCase();
    
    if (!this.playerName) {
      this.showToast('Please enter your name', 'error');
      window.soundManager.playError();
      return;
    }
    
    if (!roomCode || roomCode.length !== 4) {
      this.showToast('Please enter a valid 4-letter room code', 'error');
      window.soundManager.playError();
      return;
    }
    
    this.savePlayerData();
    
    try {
      // Find room by code
      const roomResult = await FirebaseDB.rooms.getByCode(roomCode);
      
      if (!roomResult) {
        this.showToast('Room not found', 'error');
        window.soundManager.playError();
        return;
      }
      
      const { id, data: room } = roomResult;
      
      // Check if room is full
      if (room.currentPlayers >= room.maxPlayers) {
        this.showToast('Room is full', 'error');
        window.soundManager.playError();
        return;
      }
      
      // Check if room is already playing
      if (room.status === 'playing') {
        this.showToast('Game already in progress', 'error');
        window.soundManager.playError();
        return;
      }
      
      this.roomId = id;
      this.roomCode = roomCode;
      this.playerNumber = room.currentPlayers + 1;
      
      // Add player to room
      await FirebaseDB.players.add(this.roomId, this.playerId, {
        id: this.playerId,
        name: this.playerName,
        avatar: this.playerAvatar,
        playerNumber: this.playerNumber,
        score: 0,
        isHost: false,
        lastActive: Date.now()
      });
      
      // Update room player count
      await FirebaseDB.rooms.update(this.roomId, {
        currentPlayers: this.playerNumber
      });
      
      // Set presence
      FirebaseDB.presence.setOnline(this.playerId, this.roomId);
      
      // Start listening to room updates
      this.listenToRoom();
      
      // Start heartbeat
      this.startHeartbeat();
      
      // Show waiting screen
      this.showScreen('waitingScreen');
      document.getElementById('displayRoomCode').textContent = this.roomCode;
      
      this.showToast('Joined room successfully!', 'success');
      window.soundManager.playJoin();
      console.log(`Joined room: ${this.roomCode} (${this.roomId})`);
      
    } catch (error) {
      console.error('Error joining room:', error);
      this.showToast('Failed to join room', 'error');
      window.soundManager.playError();
    }
  }

  listenToRoom() {
    if (this.roomListener) {
      FirebaseDB.rooms.stopListening(this.roomListener);
    }
    
    this.roomListener = FirebaseDB.rooms.listen(this.roomId, (roomData) => {
      if (!roomData) {
        console.log('Room deleted');
        this.handleRoomDeleted();
        return;
      }
      
      this.handleRoomUpdate(roomData);
    });
  }

  handleRoomUpdate(roomData) {
    // Update players list
    this.players = Object.values(roomData.players || {}).sort((a, b) => a.playerNumber - b.playerNumber);
    
    // Update UI based on room status
    if (roomData.status === 'waiting') {
      this.updatePlayerSlots();
      
      // Start game if room is full
      if (roomData.currentPlayers >= roomData.maxPlayers && this.players.length >= roomData.maxPlayers) {
        if (roomData.players[this.playerId]?.isHost) {
          // Only host starts the game
          this.startGame();
        }
      }
    } else if (roomData.status === 'playing') {
      // Update game state
      this.gameState = roomData.game;
      
      // If game screen not visible, show it
      if (document.getElementById('gameScreen').style.display !== 'flex') {
        this.showGameScreen();
      }
      
      // Render game
      if (this.canvas) {
        this.canvas.updateGameState(this.gameState, this.players);
        this.canvas.render();
      }
      
      // Update player cards
      this.updatePlayerCards();
      
      // Check for game over
      if (this.gameState.isGameOver) {
        this.handleGameOver({
          winner: this.gameState.winner,
          scores: this.gameState.scores,
          players: this.players
        });
      }
    }
  }

  async startGame() {
    try {
      await FirebaseDB.rooms.update(this.roomId, {
        status: 'playing'
      });
      
      console.log('Game started');
    } catch (error) {
      console.error('Error starting game:', error);
    }
  }

  showGameScreen() {
    this.showScreen('gameScreen');
    
    // Initialize canvas
    this.canvas = new GameCanvas('gameCanvas', this.gameState, this.players);
    this.canvas.setMoveCallback((line) => this.makeMove(line));
    this.canvas.render();
    
    // Create player cards
    this.createPlayerCards();
    
    window.soundManager.playWin();
  }

  async makeMove(line) {
    // Validate it's player's turn
    if (this.gameState.currentPlayer !== this.playerNumber) {
      this.showToast("Not your turn!", 'error');
      window.soundManager.playError();
      return;
    }
    
    // Check if line is already drawn
    if (line.type === 'horizontal') {
      if (this.gameState.horizontalLines[line.row][line.col] !== 0) {
        window.soundManager.playError();
        return;
      }
    } else {
      if (this.gameState.verticalLines[line.row][line.col] !== 0) {
        window.soundManager.playError();
        return;
      }
    }
    
    try {
      // Update line in Firebase
      await FirebaseDB.game.makeMove(this.roomId, {
        type: line.type,
        row: line.row,
        col: line.col,
        player: this.playerNumber
      });
      
      // Update local state
      if (line.type === 'horizontal') {
        this.gameState.horizontalLines[line.row][line.col] = this.playerNumber;
      } else {
        this.gameState.verticalLines[line.row][line.col] = this.playerNumber;
      }
      
      // Check for completed boxes
      const completedBoxes = this.checkCompletedBoxes(line);
      
      if (completedBoxes.length > 0) {
        // Update boxes
        for (const box of completedBoxes) {
          await FirebaseDB.game.updateBox(this.roomId, box.row, box.col, this.playerNumber);
          this.gameState.boxes[box.row][box.col] = this.playerNumber;
        }
        
        // Update score
        const newScore = (this.gameState.scores[this.playerNumber] || 0) + completedBoxes.length;
        await FirebaseDB.game.updateScore(this.roomId, this.playerNumber, newScore);
        this.gameState.scores[this.playerNumber] = newScore;
        
        // Player gets another turn
        window.soundManager.playBoxComplete();
      } else {
        // Next player's turn
        const nextPlayer = (this.playerNumber % this.players.length) + 1;
        await FirebaseDB.game.setCurrentPlayer(this.roomId, nextPlayer);
        this.gameState.currentPlayer = nextPlayer;
        
        window.soundManager.playLineDraw();
      }
      
      // Check if game is over
      if (this.isGameOver()) {
        const winner = this.getWinner();
        await FirebaseDB.game.setGameOver(this.roomId, winner);
        this.gameState.isGameOver = true;
        this.gameState.winner = winner;
      }
      
    } catch (error) {
      console.error('Error making move:', error);
      this.showToast('Failed to make move', 'error');
      window.soundManager.playError();
    }
  }

  checkCompletedBoxes(line) {
    const boxes = [];
    const rows = 10;
    const cols = 5;
    
    if (line.type === 'horizontal') {
      // Check box above
      if (line.row > 0) {
        const r = line.row - 1;
        const c = line.col;
        if (this.isBoxComplete(r, c)) {
          boxes.push({ row: r, col: c });
        }
      }
      // Check box below
      if (line.row < rows) {
        const r = line.row;
        const c = line.col;
        if (this.isBoxComplete(r, c)) {
          boxes.push({ row: r, col: c });
        }
      }
    } else {
      // Check box to the left
      if (line.col > 0) {
        const r = line.row;
        const c = line.col - 1;
        if (this.isBoxComplete(r, c)) {
          boxes.push({ row: r, col: c });
        }
      }
      // Check box to the right
      if (line.col < cols) {
        const r = line.row;
        const c = line.col;
        if (this.isBoxComplete(r, c)) {
          boxes.push({ row: r, col: c });
        }
      }
    }
    
    return boxes;
  }

  isBoxComplete(row, col) {
    // Check if box is already owned
    if (this.gameState.boxes[row][col] !== 0) {
      return false;
    }
    
    // Check all four sides
    const top = this.gameState.horizontalLines[row][col];
    const bottom = this.gameState.horizontalLines[row + 1][col];
    const left = this.gameState.verticalLines[row][col];
    const right = this.gameState.verticalLines[row][col + 1];
    
    return top !== 0 && bottom !== 0 && left !== 0 && right !== 0;
  }

  isGameOver() {
    // Game is over when all boxes are filled
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 5; c++) {
        if (this.gameState.boxes[r][c] === 0) {
          return false;
        }
      }
    }
    return true;
  }

  getWinner() {
    let maxScore = 0;
    let winner = 1;
    
    for (let i = 1; i <= this.players.length; i++) {
      if (this.gameState.scores[i] > maxScore) {
        maxScore = this.gameState.scores[i];
        winner = i;
      }
    }
    
    return winner;
  }

  startHeartbeat() {
    // Update last active every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.roomId && this.playerId) {
        FirebaseDB.players.updateLastActive(this.roomId, this.playerId);
      }
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  async leaveRoom() {
    if (!this.roomId || !this.playerId) return;
    
    try {
      // Remove player from room
      await FirebaseDB.players.remove(this.roomId, this.playerId);
      
      // Update player count
      const roomSnapshot = await FirebaseDB.rooms.get(this.roomId);
      const room = roomSnapshot.val();
      
      if (room) {
        const remainingPlayers = Object.keys(room.players || {}).length - 1;
        
        if (remainingPlayers === 0) {
          // Delete room if empty
          await FirebaseDB.rooms.delete(this.roomId);
        } else {
          await FirebaseDB.rooms.update(this.roomId, {
            currentPlayers: remainingPlayers
          });
        }
      }
      
      // Set offline
      await FirebaseDB.presence.setOffline(this.playerId);
      
      // Stop listening
      if (this.roomListener) {
        FirebaseDB.rooms.stopListening(this.roomListener);
        this.roomListener = null;
      }
      
      // Stop heartbeat
      this.stopHeartbeat();
      
      // Reset state
      this.roomId = null;
      this.roomCode = null;
      this.playerNumber = null;
      
      // Go back to splash
      this.showScreen('splashScreen');
      
    } catch (error) {
      console.error('Error leaving room:', error);
    }
  }

  async leaveGame() {
    await this.leaveRoom();
    
    // Clear canvas
    if (this.canvas) {
      this.canvas.destroy();
      this.canvas = null;
    }
  }

  handleRoomDeleted() {
    this.showToast('Room has been closed', 'error');
    this.leaveRoom();
  }

  async requestRematch() {
    if (!this.roomId) return;
    
    try {
      // Reset game state
      const initialGameState = {
        currentPlayer: 1,
        rows: 11,
        cols: 6,
        horizontalLines: this.createEmptyLines(11, 6),
        verticalLines: this.createEmptyLines(10, 7),
        boxes: this.createEmptyBoxes(10, 5),
        scores: { 1: 0, 2: 0, 3: 0, 4: 0 },
        isGameOver: false,
        winner: null,
        lastMove: null
      };
      
      await FirebaseDB.game.reset(this.roomId, initialGameState);
      await FirebaseDB.rooms.update(this.roomId, {
        status: 'playing'
      });
      
      this.gameState = initialGameState;
      this.showGameScreen();
      
      this.showToast('Rematch started!', 'success');
      
    } catch (error) {
      console.error('Error requesting rematch:', error);
      this.showToast('Failed to start rematch', 'error');
    }
  }

  // Helper functions
  createEmptyLines(rows, cols) {
    const lines = {};
    for (let r = 0; r < rows; r++) {
      lines[r] = {};
      for (let c = 0; c < cols; c++) {
        lines[r][c] = 0;
      }
    }
    return lines;
  }

  createEmptyBoxes(rows, cols) {
    const boxes = {};
    for (let r = 0; r < rows; r++) {
      boxes[r] = {};
      for (let c = 0; c < cols; c++) {
        boxes[r][c] = 0;
      }
    }
    return boxes;
  }

  updatePlayerSlots() {
    const container = document.getElementById('playerSlots');
    container.innerHTML = '';
    
    for (let i = 0; i < this.maxPlayers; i++) {
      const player = this.players[i];
      const slot = document.createElement('div');
      slot.className = 'player-slot';
      
      if (player) {
        slot.classList.add('filled');
        slot.innerHTML = `
          <div class="player-slot-avatar">${player.avatar}</div>
          <div class="player-slot-name">${player.name}</div>
          ${player.isHost ? '<div class="host-badge">👑 Host</div>' : ''}
        `;
      } else {
        slot.innerHTML = `
          <div class="player-slot-avatar">👤</div>
          <div class="player-slot-name">Waiting...</div>
        `;
      }
      
      container.appendChild(slot);
    }
  }

  createPlayerCards() {
    const container = document.getElementById('playerCards');
    container.innerHTML = '';
    
    this.players.forEach(player => {
      const card = document.createElement('div');
      card.className = 'player-card';
      card.id = `player-${player.playerNumber}`;
      card.dataset.player = player.playerNumber;
      
      card.innerHTML = `
        <div class="player-avatar">${player.avatar}</div>
        <div class="player-info">
          <div class="player-name">${player.name}</div>
          <div class="player-score">Score: <span id="score-${player.playerNumber}">0</span></div>
        </div>
      `;
      
      container.appendChild(card);
    });
  }

  updatePlayerCards() {
    // Update scores
    this.players.forEach(player => {
      const scoreEl = document.getElementById(`score-${player.playerNumber}`);
      if (scoreEl) {
        scoreEl.textContent = this.gameState.scores[player.playerNumber] || 0;
      }
    });
    
    // Highlight current player
    document.querySelectorAll('.player-card').forEach(card => {
      const playerNum = parseInt(card.dataset.player);
      if (playerNum === this.gameState.currentPlayer) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });
  }

  handleGameOver(data) {
    const { winner, scores, players } = data;
    
    // Show game over screen
    this.showScreen('gameOverScreen');
    
    // Display winner
    const winnerPlayer = players.find(p => p.playerNumber === winner);
    const resultDiv = document.getElementById('gameResult');
    
    if (winnerPlayer) {
      resultDiv.innerHTML = `
        <h2>🎉 ${winnerPlayer.name} Wins! 🎉</h2>
        <div class="winner-avatar">${winnerPlayer.avatar}</div>
      `;
    }
    
    // Display scores
    const scoresDiv = document.getElementById('finalScores');
    scoresDiv.innerHTML = players.map(p => `
      <div class="final-score-item ${p.playerNumber === winner ? 'winner' : ''}">
        <span class="score-avatar">${p.avatar}</span>
        <span class="score-name">${p.name}</span>
        <span class="score-value">${scores[p.playerNumber] || 0}</span>
      </div>
    `).join('');
    
    // Play win sound
    window.soundManager.playWin();
  }

  // UI Helper Functions
  copyRoomCode() {
    const code = this.roomCode;
    
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(() => {
        this.showToast('Room code copied!', 'success');
      }).catch(() => {
        this.showToast('Failed to copy', 'error');
      });
    } else {
      const input = document.createElement('input');
      input.value = code;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      this.showToast('Room code copied!', 'success');
    }
  }

  shareRoom() {
    const url = `${window.location.origin}?code=${this.roomCode}`;
    const text = `Join my Dots & Boxes game! Room code: ${this.roomCode}`;
    
    if (navigator.share) {
      navigator.share({
        title: 'Dots & Boxes Game',
        text: text,
        url: url
      })
      .then(() => {
        this.showToast('Shared successfully!', 'success');
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          this.copyShareLink(url, text);
        }
      });
    } else {
      this.copyShareLink(url, text);
    }
  }

  copyShareLink(url, text) {
    const shareText = `${text}\n${url}`;
    
    if (navigator.clipboard) {
      navigator.clipboard.writeText(shareText).then(() => {
        this.showToast('Share link copied to clipboard!', 'success');
      }).catch(() => {
        this.showToast('Failed to copy link', 'error');
      });
    } else {
      const input = document.createElement('input');
      input.value = shareText;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      this.showToast('Share link copied!', 'success');
    }
  }

  showQRCode() {
    const url = `${window.location.origin}?code=${this.roomCode}`;
    const container = document.getElementById('qrCodeContainer');
    const modal = document.getElementById('qrModal');
    
    container.innerHTML = '';
    
    const qrImage = window.qrGenerator.generate(url, 256);
    container.appendChild(qrImage);
    
    document.getElementById('qrRoomCode').textContent = this.roomCode;
    
    modal.classList.add('active');
  }

  closeQRModal() {
    const modal = document.getElementById('qrModal');
    modal.classList.remove('active');
  }

  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
      screen.style.display = 'none';
    });
    document.getElementById(screenId).style.display = 'flex';
  }

  showToast(message, type = 'info') {
    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    // Animate in
    setTimeout(() => toast.classList.add('show'), 100);
    
    // Remove after 3 seconds
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  loadPlayerData() {
    const savedName = localStorage.getItem('playerName');
    const savedAvatar = localStorage.getItem('playerAvatar');
    const savedId = localStorage.getItem('playerId');
    
    if (savedName) {
      document.getElementById('hostNameInput').value = savedName;
      document.getElementById('guestNameInput').value = savedName;
      this.playerName = savedName;
    }
    
    if (savedAvatar) {
      this.playerAvatar = savedAvatar;
      // Select the avatar in UI
      document.querySelectorAll('.avatar-option').forEach(option => {
        if (option.textContent === savedAvatar) {
          option.classList.add('selected');
        }
      });
    }
    
    if (savedId) {
      this.playerId = savedId;
    }
  }

  savePlayerData() {
    localStorage.setItem('playerName', this.playerName);
    localStorage.setItem('playerAvatar', this.playerAvatar);
  }
}

// Initialize app when page loads
window.addEventListener('DOMContentLoaded', () => {
  window.app = new DotsAndBoxesApp();
});
