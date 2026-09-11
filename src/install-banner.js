/**
 * Install banner — brings Dots & Boxes in line with the other games.
 *
 * WHY THIS EXISTS: Chrome fires `beforeinstallprompt` on any installable PWA and, if
 * nobody calls preventDefault(), shows its OWN install / "open in app" dialog. Every
 * other game intercepts that event inside deep-link-handler.js and offers the choice
 * through our own banner instead. Dots & Boxes has its own room-link + QR handling, so
 * it only needs this slice of that module — importing it suppresses Chrome's dialog and
 * gives the same Open/Install banner.
 */
import { showToast } from './platform-ui.js';

let deferredInstallPrompt = null;

// Capture (and suppress) Chrome's automatic install prompt.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

function dismissAppBanner() {
  const banner = document.getElementById('app-banner');
  if (banner) {
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 300);
  }
  sessionStorage.setItem('app-banner-dismissed', 'true');
}

async function handleOpenApp(isMobile) {
  try {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const result = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (result.outcome === 'accepted') {
        showToast('App installing...');
        dismissAppBanner();
      } else {
        showToast('Continue in browser');
      }
      return;
    }
    dismissAppBanner();
    if (!isMobile) {
      showToast('Tip: open the app from your desktop/start menu', 4000);
      return;
    }
    // Browsers cannot reliably launch an installed PWA from a page, so point the
    // user at the platform's own install UI.
    showToast('Open the installed app, or use the browser menu (⋮) → "Install app"', 4000);
  } catch (error) {
    console.warn('Install prompt failed:', error);
    showToast('Install app: browser menu (⋮) → "Install app"', 3500);
  }
}

/**
 * Show the Open/Install banner — only in a browser tab (never inside the installed
 * app), and only once per session.
 */
export function maybeShowAppBanner(delay = 800) {
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  if (navigator.standalone) return;                       // iOS installed
  if (sessionStorage.getItem('app-banner-dismissed')) return;

  setTimeout(() => {
    if (document.getElementById('app-banner')) return;
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const banner = document.createElement('div');
    banner.id = 'app-banner';
    banner.className = 'app-banner';
    banner.innerHTML = `
      <div class="app-banner-content">
        <span class="app-banner-icon">📱</span>
        <span class="app-banner-text">${isMobile ? 'Better experience in app' : 'Have the app installed?'}</span>
        <div class="app-banner-actions">
          <button id="app-banner-open" class="app-banner-btn primary">${isMobile ? 'Open/Install App' : 'Using App'}</button>
          <button id="app-banner-continue" class="app-banner-btn secondary">Continue Here</button>
          <button id="app-banner-close" class="app-banner-btn close" aria-label="Close">×</button>
        </div>
      </div>
    `;
    document.body.appendChild(banner);
    setTimeout(() => banner.classList.add('show'), 100);
    document.getElementById('app-banner-open')?.addEventListener('click', () => handleOpenApp(isMobile));
    document.getElementById('app-banner-continue')?.addEventListener('click', dismissAppBanner);
    document.getElementById('app-banner-close')?.addEventListener('click', dismissAppBanner);
  }, delay);
}
