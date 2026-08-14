// Canvas Drawing and Interaction Logic - ES6 Module
export default class GameCanvas {
  constructor(canvasId, gridRows, gridCols, onLineClick) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.gridRows = gridRows; // Number of rows (dots vertically)
    this.gridCols = gridCols; // Number of columns (dots horizontally)
    this.onLineClick = onLineClick;
    
    // Visual settings - will be calculated based on available space
    this.dotRadius = 6;
    this.lineWidth = 5;
    this.gridPadding = 30;
    this.cellSize = 50; // Will be adjusted dynamically
    
    // Player colors - support up to 4 players
    this.playerColors = [
      '#3498db', // Player 1 - Blue
      '#e74c3c', // Player 2 - Red
      '#2ecc71', // Player 3 - Green
      '#f39c12'  // Player 4 - Orange
    ];
    
    // Colors
    this.colors = {
      background: '#ffffff',
      dot: '#34495e',
      emptyLine: '#e8ecf0',
      hover: '#95a5a6',
    };
    
    // Interaction state
    this.hoveredLine = null;
    this.gameState = null;
    
    this.setupCanvas();
    this.setupInteraction();
  }

  setupCanvas() {
    const container = this.canvas.parentElement;
    const containerWidth = container.clientWidth - 40;
    const containerHeight = window.innerHeight - 300; // Reserve space for player cards and controls
    
    // Calculate optimal cell size based on available space
    const maxCellWidth = (containerWidth - this.gridPadding * 2) / (this.gridCols - 1);
    const maxCellHeight = (containerHeight - this.gridPadding * 2) / (this.gridRows - 1);
    
    // Use the smaller dimension to ensure grid fits in both directions
    this.cellSize = Math.min(maxCellWidth, maxCellHeight, 60); // Max 60px per cell
    this.cellSize = Math.max(this.cellSize, 30); // Min 30px per cell
    
    // Adjust visual elements based on cell size
    this.dotRadius = Math.max(this.cellSize * 0.12, 4);
    this.lineWidth = Math.max(this.cellSize * 0.1, 3);
    
    // Calculate canvas size based on grid dimensions
    const canvasWidth = this.gridPadding * 2 + (this.gridCols - 1) * this.cellSize;
    const canvasHeight = this.gridPadding * 2 + (this.gridRows - 1) * this.cellSize;
    
    // Set canvas size with device pixel ratio for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = canvasWidth * dpr;
    this.canvas.height = canvasHeight * dpr;
    this.canvas.style.width = canvasWidth + 'px';
    this.canvas.style.height = canvasHeight + 'px';
    
    this.ctx.scale(dpr, dpr);
    
    // Make canvas responsive
    window.addEventListener('resize', () => this.handleResize());
  }

  handleResize() {
    // Redraw without full recalculation to maintain game state
    if (this.gameState) {
      this.drawBoard(this.gameState);
    }
  }

  setupInteraction() {
    // Mouse events
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('click', (e) => this.handleClick(e));
    this.canvas.addEventListener('mouseleave', () => {
      this.hoveredLine = null;
      this.drawBoard(this.gameState);
    });
    
    // Touch events for mobile
    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.handleTouch(e);
    });
  }

  handleMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX / (window.devicePixelRatio || 1);
    const y = (e.clientY - rect.top) * scaleY / (window.devicePixelRatio || 1);
    
    const nearestLine = this.getNearestLine(x, y);
    
    console.log('[Canvas] Mouse move - x:', x, 'y:', y, 'nearest:', nearestLine);
    
    if (nearestLine && this.isLineAvailable(nearestLine)) {
      this.hoveredLine = nearestLine;
      this.canvas.style.cursor = 'pointer';
    } else {
      this.hoveredLine = null;
      this.canvas.style.cursor = 'default';
    }
    
    this.drawBoard(this.gameState);
  }

  handleClick(e) {
    console.log('[Canvas] Click detected, hovered line:', this.hoveredLine);
    if (this.hoveredLine && this.isLineAvailable(this.hoveredLine)) {
      console.log('[Canvas] Line is available, calling onLineClick');
      this.onLineClick(this.hoveredLine);
    } else {
      console.log('[Canvas] Line not available or no hovered line');
    }
  }

  handleTouch(e) {
    const touch = e.touches[0];
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = (touch.clientX - rect.left) * scaleX / (window.devicePixelRatio || 1);
    const y = (touch.clientY - rect.top) * scaleY / (window.devicePixelRatio || 1);
    
    const nearestLine = this.getNearestLine(x, y);
    
    if (nearestLine && this.isLineAvailable(nearestLine)) {
      this.onLineClick(nearestLine);
    }
  }

  getNearestLine(x, y) {
    const threshold = Math.max(25, this.cellSize * 0.5); // Increased from 15 and 0.3
    console.log('[getNearestLine] threshold:', threshold, 'cellSize:', this.cellSize);
    let nearestLine = null;
    let minDistance = threshold;
    
    // Check horizontal lines (connecting dots horizontally)
    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols - 1; col++) {
        const lineX1 = this.gridPadding + col * this.cellSize;
        const lineY1 = this.gridPadding + row * this.cellSize;
        const lineX2 = this.gridPadding + (col + 1) * this.cellSize;
        const lineY2 = lineY1;
        
        const dist = this.distanceToLine(x, y, lineX1, lineY1, lineX2, lineY2);
        if (dist < minDistance) {
          minDistance = dist;
          nearestLine = { type: 'horizontal', row, col };
        }
      }
    }
    
    // Check vertical lines (connecting dots vertically)
    for (let row = 0; row < this.gridRows - 1; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        const lineX1 = this.gridPadding + col * this.cellSize;
        const lineY1 = this.gridPadding + row * this.cellSize;
        const lineX2 = lineX1;
        const lineY2 = this.gridPadding + (row + 1) * this.cellSize;
        
        const dist = this.distanceToLine(x, y, lineX1, lineY1, lineX2, lineY2);
        if (dist < minDistance) {
          minDistance = dist;
          nearestLine = { type: 'vertical', row, col };
        }
      }
    }
    
    console.log('[getNearestLine] returning:', nearestLine, 'minDistance:', minDistance);
    return nearestLine;
  }

  distanceToLine(px, py, x1, y1, x2, y2) {
    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;
    
    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    
    if (lenSq !== 0) param = dot / lenSq;
    
    let xx, yy;
    
    if (param < 0) {
      xx = x1;
      yy = y1;
    } else if (param > 1) {
      xx = x2;
      yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }
    
    const dx = px - xx;
    const dy = py - yy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  isLineAvailable(line) {
    if (!this.gameState) return false;
    
    const key = `${line.row},${line.col}`;
    
    if (line.type === 'horizontal') {
      return this.gameState.horizontalLines[key] === null;
    } else {
      return this.gameState.verticalLines[key] === null;
    }
  }

  drawBoard(gameState) {
    this.gameState = gameState;
    if (!gameState) return;
    
    // Clear canvas
    this.ctx.fillStyle = this.colors.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    
    // Draw boxes first (behind lines)
    this.drawBoxes(gameState.boxes);
    
    // Draw all potential line positions (faded)
    this.drawPotentialLines();
    
    // Draw active lines
    this.drawActiveLines(gameState.horizontalLines, gameState.verticalLines);
    
    // Draw hovered line
    if (this.hoveredLine) {
      this.drawHoveredLine(this.hoveredLine);
    }
    
    // Draw dots last (on top)
    this.drawDots();
  }

  drawDots() {
    this.ctx.fillStyle = this.colors.dot;
    this.ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
    this.ctx.shadowBlur = 2;
    
    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        const x = this.gridPadding + col * this.cellSize;
        const y = this.gridPadding + row * this.cellSize;
        
        this.ctx.beginPath();
        this.ctx.arc(x, y, this.dotRadius, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }
    
    this.ctx.shadowColor = 'transparent';
    this.ctx.shadowBlur = 0;
  }

  drawPotentialLines() {
    this.ctx.strokeStyle = this.colors.emptyLine;
    this.ctx.lineWidth = this.lineWidth;
    this.ctx.lineCap = 'round';
    
    // Horizontal lines
    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols - 1; col++) {
        const x1 = this.gridPadding + col * this.cellSize;
        const y1 = this.gridPadding + row * this.cellSize;
        const x2 = this.gridPadding + (col + 1) * this.cellSize;
        const y2 = y1;
        
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.stroke();
      }
    }
    
    // Vertical lines
    for (let row = 0; row < this.gridRows - 1; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        const x1 = this.gridPadding + col * this.cellSize;
        const y1 = this.gridPadding + row * this.cellSize;
        const x2 = x1;
        const y2 = this.gridPadding + (row + 1) * this.cellSize;
        
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.stroke();
      }
    }
  }

  drawActiveLines(horizontalLines, verticalLines) {
    this.ctx.lineWidth = this.lineWidth + 1;
    this.ctx.lineCap = 'round';
    
    // Draw horizontal lines
    for (let key in horizontalLines) {
      const player = horizontalLines[key];
      if (player !== null) {
        const [row, col] = key.split(',').map(Number);
        const x1 = this.gridPadding + col * this.cellSize;
        const y1 = this.gridPadding + row * this.cellSize;
        const x2 = this.gridPadding + (col + 1) * this.cellSize;
        const y2 = y1;
        
        // Use player number to get color (1-indexed, array is 0-indexed)
        this.ctx.strokeStyle = this.playerColors[player - 1] || this.playerColors[0];
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.stroke();
      }
    }
    
    // Draw vertical lines
    for (let key in verticalLines) {
      const player = verticalLines[key];
      if (player !== null) {
        const [row, col] = key.split(',').map(Number);
        const x1 = this.gridPadding + col * this.cellSize;
        const y1 = this.gridPadding + row * this.cellSize;
        const x2 = x1;
        const y2 = this.gridPadding + (row + 1) * this.cellSize;
        
        // Use player number to get color (1-indexed, array is 0-indexed)
        this.ctx.strokeStyle = this.playerColors[player - 1] || this.playerColors[0];
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.stroke();
      }
    }
  }

  drawHoveredLine(line) {
    this.ctx.strokeStyle = this.colors.hover;
    this.ctx.lineWidth = this.lineWidth + 1;
    this.ctx.lineCap = 'round';
    
    if (line.type === 'horizontal') {
      const x1 = this.gridPadding + line.col * this.cellSize;
      const y1 = this.gridPadding + line.row * this.cellSize;
      const x2 = this.gridPadding + (line.col + 1) * this.cellSize;
      const y2 = y1;
      
      this.ctx.beginPath();
      this.ctx.moveTo(x1, y1);
      this.ctx.lineTo(x2, y2);
      this.ctx.stroke();
    } else {
      const x1 = this.gridPadding + line.col * this.cellSize;
      const y1 = this.gridPadding + line.row * this.cellSize;
      const x2 = x1;
      const y2 = this.gridPadding + (line.row + 1) * this.cellSize;
      
      this.ctx.beginPath();
      this.ctx.moveTo(x1, y1);
      this.ctx.lineTo(x2, y2);
      this.ctx.stroke();
    }
  }

  drawBoxes(boxes) {
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    
    for (let key in boxes) {
      const player = boxes[key];
      if (player !== null) {
        const [row, col] = key.split(',').map(Number);
        const x = this.gridPadding + col * this.cellSize;
        const y = this.gridPadding + row * this.cellSize;
        
        // Get player color
        const playerColor = this.playerColors[player - 1] || this.playerColors[0];
        
        // Draw filled box with semi-transparent color
        this.ctx.fillStyle = playerColor + '33'; // Add alpha for transparency
        this.ctx.fillRect(x, y, this.cellSize, this.cellSize);
        
        // Draw player number/indicator in the box
        const fontSize = Math.max(Math.floor(this.cellSize * 0.4), 14);
        this.ctx.font = `bold ${fontSize}px Arial`;
        this.ctx.fillStyle = playerColor;
        this.ctx.fillText(`P${player}`, x + this.cellSize / 2, y + this.cellSize / 2);
      }
    }
  }

  animateBoxCompletion(boxKeys) {
    // Simple flash animation for completed boxes
    let flash = 0;
    const flashInterval = setInterval(() => {
      flash++;
      if (flash > 6) {
        clearInterval(flashInterval);
        return;
      }
      this.drawBoard(this.gameState);
    }, 100);
  }

  setGridSize(gridRows, gridCols) {
    this.gridRows = gridRows;
    this.gridCols = gridCols;
    this.setupCanvas();
  }
}
