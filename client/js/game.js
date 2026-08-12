// Game State Management Helper (Client-side)
// This file contains utility functions for game state management

class GameStateManager {
  constructor() {
    this.localState = null;
  }

  updateState(newState) {
    this.localState = { ...this.localState, ...newState };
  }

  getState() {
    return this.localState;
  }

  resetState() {
    this.localState = null;
  }

  // Validate move client-side before sending to server
  isValidMove(line, gameState) {
    if (!gameState) return false;
    
    const { type, row, col } = line;
    const key = `${row},${col}`;
    
    if (type === 'horizontal') {
      return gameState.horizontalLines[key] === null;
    } else if (type === 'vertical') {
      return gameState.verticalLines[key] === null;
    }
    
    return false;
  }

  // Calculate if a move would complete any boxes (for preview)
  wouldCompleteBox(line, gameState) {
    if (!gameState) return false;
    
    const { type, row, col } = line;
    let boxCount = 0;
    
    if (type === 'horizontal') {
      // Check box above
      if (row > 0) {
        if (this.checkBoxComplete(row - 1, col, gameState, line)) {
          boxCount++;
        }
      }
      // Check box below
      if (row < gameState.gridSize - 1) {
        if (this.checkBoxComplete(row, col, gameState, line)) {
          boxCount++;
        }
      }
    } else if (type === 'vertical') {
      // Check box to left
      if (col > 0) {
        if (this.checkBoxComplete(row, col - 1, gameState, line)) {
          boxCount++;
        }
      }
      // Check box to right
      if (col < gameState.gridSize - 1) {
        if (this.checkBoxComplete(row, col, gameState, line)) {
          boxCount++;
        }
      }
    }
    
    return boxCount;
  }

  checkBoxComplete(row, col, gameState, proposedLine) {
    const top = this.getLineState(gameState, 'horizontal', row, col, proposedLine);
    const bottom = this.getLineState(gameState, 'horizontal', row + 1, col, proposedLine);
    const left = this.getLineState(gameState, 'vertical', row, col, proposedLine);
    const right = this.getLineState(gameState, 'vertical', row, col + 1, proposedLine);
    
    return top && bottom && left && right;
  }

  getLineState(gameState, type, row, col, proposedLine) {
    // Check if this is the proposed line
    if (proposedLine.type === type && proposedLine.row === row && proposedLine.col === col) {
      return true;
    }
    
    const key = `${row},${col}`;
    
    if (type === 'horizontal') {
      return gameState.horizontalLines[key] !== null;
    } else {
      return gameState.verticalLines[key] !== null;
    }
  }
}

// Export for use in other files
window.GameStateManager = GameStateManager;
