# Dots and Boxes - Multiplayer PWA

A real-time multiplayer implementation of the classic Dots and Boxes game for 2-4 players.

## Features

- 🎮 **Multiplayer**: Play with 2-4 players in real-time
- 🌐 **PWA**: Install as a native app on any device
- 📱 **Mobile-First**: Responsive design optimized for touch devices
- 🔥 **Firebase**: Real-time synchronization with Firebase Realtime Database
- ♿ **Accessible**: ARIA labels and keyboard navigation support
- 🎨 **Modern UI**: Clean, dark-themed interface with smooth animations

## Game Rules

1. Players take turns connecting adjacent dots with lines
2. When a player completes a box (all 4 sides), they score 1 point and get an extra turn
3. The game ends when all boxes are completed
4. The player with the most boxes wins

## Grid

- 6 columns × 11 rows of dots
- 5 × 10 = 50 possible boxes

## Setup

### Prerequisites

- Node.js 18+ and npm
- Firebase project with Realtime Database

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create `.env` file in the root directory:
   ```env
   VITE_FIREBASE_API_KEY=your_api_key
   VITE_FIREBASE_AUTH_DOMAIN=your_project_id.firebaseapp.com
   VITE_FIREBASE_DATABASE_URL=https://your_project_id.asia-southeast1.firebasedatabase.app
   VITE_FIREBASE_PROJECT_ID=your_project_id
   VITE_FIREBASE_STORAGE_BUCKET=your_project_id.appspot.com
   VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
   VITE_FIREBASE_APP_ID=your_app_id
   ```

4. Configure Firebase Realtime Database rules (see below)

5. Add icons to `public/icons/`:
   - `favicon.ico`
   - `icon-192.png` (192×192)
   - `icon-512.png` (512×512)

6. (Optional) Add sound files to `public/sounds/`:
   - `tap.mp3` - Dot selection/line drawing
   - `music.mp3` - Game start
   - `victory.mp3` - Game complete

### Firebase Realtime Database Rules

```json
{
  "rules": {
    "rooms": {
      "$roomCode": {
        ".read": true,
        ".write": true,
        ".indexOn": ["meta/createdAt"]
      }
    }
  }
}
```

**Note**: These rules are permissive for development. Implement proper security rules for production.

## Development

Start the development server:

```bash
npm run dev
```

The app will be available at `http://localhost:5173`

## Build

Create a production build:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Project Structure

```
dbmp/
├── public/
│   ├── icons/          # PWA icons
│   ├── sounds/         # Audio files (optional)
│   ├── manifest.json   # PWA manifest
│   └── sw.js          # Service worker
├── src/
│   ├── main.js                 # Main UI controller
│   ├── firebase-config.js      # Firebase initialization
│   ├── firebase-sync.js        # Room/player sync logic
│   ├── firebase-recovery.js    # Connection recovery
│   ├── game-manager.js         # Game logic (pure functions)
│   ├── session.js              # Session persistence
│   ├── audio-manager.js        # Sound effects
│   └── deep-link-handler.js    # Deep linking/sharing
├── index.html          # HTML structure
├── style.css           # Styles
├── vite.config.js      # Vite configuration
└── package.json        # Dependencies
```

## Architecture

The app follows a clean separation of concerns:

- **Game Logic** (`game-manager.js`): Pure functions for game state validation and updates
- **Firebase Sync** (`firebase-sync.js`): Real-time database operations and listeners
- **UI Controller** (`main.js`): Screen management, SVG rendering, and user interactions
- **Session Management** (`session.js`): Persists player session across page reloads

### Game Flow

1. **Menu** → Create or Join
2. **Create/Join** → Enter details and select avatar
3. **Lobby** → Wait for players, host starts game
4. **Game** → Players take turns connecting dots
5. **Victory** → Show final scores and rankings

### Interaction Design

```
TAP DOT → Select start dot → Highlight valid neighbors
  ↓
TAP ADJACENT DOT → Validate → Animate line → Check boxes
  ↓
Box completed? → YES: +1 point, extra turn
               → NO: Next player's turn
```

## Technologies

- **Vanilla JavaScript** - No framework dependencies
- **Vite** - Fast build tool and dev server
- **Firebase Realtime Database** - Real-time multiplayer sync
- **SVG** - Scalable vector graphics for game grid
- **CSS Variables** - Theming and responsive design
- **Service Worker** - Offline support and caching

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS Safari, Chrome Android)

## Known Limitations

- Maximum 4 players per room
- Rooms are automatically cleaned up after 24 hours of inactivity
- Audio files are optional (game works without them)
- No AI opponent (multiplayer only)

## Contributing

Contributions are welcome! Please follow the existing code style and architecture.

## License

MIT License - Feel free to use this for learning or your own projects.
