// Main Entry Point for Vite
// This file imports all necessary modules and initializes the app

// Import CSS
import '../css/styles.css';

// Import Firebase configuration
import { FirebaseDB } from './firebase-config.js';

// Import game modules
import { soundManager } from './sounds.js';
import { qrGenerator } from './qrcode.js';
import GameStateManager from './game.js';
import GameCanvas from './canvas.js';

// Import and initialize the main app
import DotsAndBoxesApp from './app-firebase.js';

console.log('🎮 Dots and Boxes - Vite build');
console.log('🔥 Firebase Project:', import.meta.env.VITE_FIREBASE_PROJECT_ID);

// Make app available globally for debugging (optional)
if (import.meta.env.DEV) {
  window.__app_debug__ = {
    FirebaseDB,
    soundManager,
    qrGenerator,
    GameStateManager,
    GameCanvas,
  };
}
