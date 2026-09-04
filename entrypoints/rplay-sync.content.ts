import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
  matches: ['*://*.rplay.live/*'],
  runAt: 'document_idle',
  main() {
    function syncToken() {
      try {
        const token =
          localStorage.getItem('_AUTHORIZATION_') ||
          localStorage.getItem('token') ||
          localStorage.getItem('pocketbase_auth');
        if (token && token.length > 8 && typeof chrome !== 'undefined') {
          if (chrome.storage?.local) {
            chrome.storage.local.set({ rplay_auth_token: token });
          }
          if (chrome.runtime?.sendMessage) {
            chrome.runtime.sendMessage({ type: 'SAVE_RPLAY_TOKEN', token }).catch(() => {});
          }
        }
      } catch (e) {
        // Ignore cross-origin or storage errors
      }
    }

    // Sync on page load
    syncToken();

    // Sync if user logs in later
    window.addEventListener('storage', (e) => {
      if (e.key === '_AUTHORIZATION_' || e.key === 'token') {
        syncToken();
      }
    });

    // Also periodic sync for SPA state updates
    setInterval(syncToken, 5000);
  },
});
