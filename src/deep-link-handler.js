/**
 * Deep Link Handler — Dots and Boxes
 * Handles ?room=ABCD URL parameters and sharing functionality
 */

const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z]{4}$/;

/**
 * Initialize deep link handling - extracts room code from URL
 */
export function initDeepLinkHandler({ roomInputId, joinScreenId, gameName }) {
  const params = new URLSearchParams(window.location.search);
  const roomCode = params.get('room');
  
  if (!roomCode) return null;
  
  const normalized = roomCode.trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(normalized)) {
    console.warn('[deep-link] Invalid room code in URL:', roomCode);
    return null;
  }
  
  // Prefill the join input
  const input = document.getElementById(roomInputId);
  if (input) {
    input.value = normalized;
  }
  
  // Show join screen
  const screen = document.getElementById(joinScreenId);
  if (screen) {
    screen.removeAttribute('hidden');
  }
  
  return normalized;
}

/**
 * Create share handler for a room code
 */
export function createShareHandler(roomCode, gameName) {
  return async () => {
    const url = `${window.location.origin}?room=${roomCode}`;
    const title = `Join ${gameName}`;
    const text = `Join my ${gameName} game! Room code: ${roomCode}`;
    
    // Try native share API first (mobile)
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.warn('[share] Native share failed:', err);
        }
      }
    }
    
    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(url);
      showToast?.(`Room code ${roomCode} copied to clipboard!`, 'success');
    } catch (err) {
      console.warn('[share] Clipboard write failed:', err);
      // Last resort: show the URL
      prompt('Share this link:', url);
    }
  };
}

/**
 * Show QR code modal (requires qrcode library)
 */
export async function showQRCode(roomCode, gameName) {
  try {
    const QRCode = (await import('qrcode')).default;
    const url = `${window.location.origin}?room=${roomCode}`;
    
    // Create modal
    const modal = document.createElement('div');
    modal.className = 'qr-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-labelledby', 'qrModalTitle');
    modal.setAttribute('aria-modal', 'true');
    
    const canvas = document.createElement('canvas');
    await QRCode.toCanvas(canvas, url, {
      width: 256,
      margin: 2,
      color: {
        dark: '#1e293b',
        light: '#ffffff',
      },
    });
    
    modal.innerHTML = `
      <div class="qr-modal-content">
        <h3 id="qrModalTitle">Scan to Join</h3>
        <p>Room code: <strong>${roomCode}</strong></p>
        <div class="qr-canvas-container"></div>
        <button type="button" class="menu-btn" id="qrModalClose">Close</button>
      </div>
    `;
    
    modal.querySelector('.qr-canvas-container').appendChild(canvas);
    document.body.appendChild(modal);
    
    // Close handlers
    const close = () => {
      modal.remove();
    };
    
    modal.querySelector('#qrModalClose').addEventListener('click', close);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    
    // Focus trap
    const closeBtn = modal.querySelector('#qrModalClose');
    if (closeBtn) closeBtn.focus();
    
  } catch (err) {
    console.error('[qr] Failed to generate QR code:', err);
    alert(`Room code: ${roomCode}\nShare this link:\n${window.location.origin}?room=${roomCode}`);
  }
}

// Helper reference to toast function (will be injected by main.js)
let showToast = null;
export function setShowToast(fn) {
  showToast = fn;
}
