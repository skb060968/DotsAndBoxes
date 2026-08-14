/**
 * Firebase Connection Recovery and Error Handling
 * 
 * Provides retry logic with exponential backoff and connection monitoring.
 * Pattern adapted from Musical Chairs.
 */

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5000;

export const CONNECTION_RESTORED_MESSAGE = 'Connection restored - resyncing...';

/** Simple error logger */
export function logError(context, error, metadata = {}) {
  console.error(`[${context}]`, error, metadata);
}

/**
 * Retry a Firebase operation with exponential backoff.
 */
export async function withRetry(operation, options = {}) {
  const { context = 'firebase-op', metadata = {}, maxAttempts = MAX_RETRY_ATTEMPTS } = options;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation();
      return { ok: true, value: result, attempts: attempt };
    } catch (error) {
      if (attempt === maxAttempts) {
        logError(context, error, { ...metadata, attempts: attempt });
        return {
          ok: false,
          error,
          attempts: attempt,
          message: 'Operation failed after multiple attempts',
        };
      }
      
      // Exponential backoff: 500ms, 1000ms, 2000ms, ...
      const delay = Math.min(
        RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
        RETRY_MAX_DELAY_MS
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return { ok: false, attempts: maxAttempts, message: 'Max retries exceeded' };
}

/**
 * Specialized retry for read operations (more attempts allowed).
 */
export async function withReadRetry(operation, options = {}) {
  return withRetry(operation, { ...options, maxAttempts: 5 });
}

/**
 * Connection status monitoring (simplified version).
 */
let isConnected = true;
const connectionListeners = new Set();

export function getConnectionStatus() {
  return {
    online: isConnected,
    resyncPending: false,
    resyncOverdue: false,
  };
}

export function isOnline() {
  return isConnected;
}

export function onConnectionChange(listener) {
  if (typeof listener !== 'function') return () => {};
  connectionListeners.add(listener);
  // Emit current status immediately
  try {
    listener({ online: isConnected, message: null });
  } catch (_) {}
  return () => connectionListeners.delete(listener);
}

export function onReconnect(handler) {
  // Simplified - real implementation would hook into Firebase connection state
  return () => {};
}

export async function startConnectionMonitor() {
  if (typeof window === 'undefined') return false;
  
  window.addEventListener('online', () => {
    isConnected = true;
    connectionListeners.forEach(fn => {
      try {
        fn({ online: true, message: CONNECTION_RESTORED_MESSAGE });
      } catch (_) {}
    });
  });
  
  window.addEventListener('offline', () => {
    isConnected = false;
    connectionListeners.forEach(fn => {
      try {
        fn({ online: false, message: 'Connection lost - retrying...' });
      } catch (_) {}
    });
  });
  
  return true;
}

export function setErrorContextProvider(provider) {
  // Hook for adding context to error logs
}

/**
 * Initialize recovery — starts the connection monitor and wires up
 * any app-wide recovery hooks. Called once during app bootstrap.
 */
export async function initRecovery() {
  await startConnectionMonitor();
}
