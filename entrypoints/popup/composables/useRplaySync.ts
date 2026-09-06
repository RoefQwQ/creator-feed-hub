import { ref } from 'vue';

/**
 * Rplay.live one-click credential sync banner state and action for the Popup.
 * Talks to the background service worker via the existing message protocol
 * (`SYNC_RPLAY_TOKEN`) and falls back to previously stored credentials.
 */
export function useRplaySync() {
  const rplaySyncState = ref<'idle' | 'syncing' | 'synced' | 'failed'>('idle');
  const rplaySyncMessage = ref('');

  async function triggerRplaySync() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    rplaySyncState.value = 'syncing';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SYNC_RPLAY_TOKEN' });
      if (res?.success) {
        rplaySyncState.value = 'synced';
        rplaySyncMessage.value = '已成功同步登录凭证 ✓';
      } else {
        // Check if already stored in local storage
        const stored = await chrome.storage?.local?.get('rplay_auth_token');
        if (stored?.rplay_auth_token) {
          rplaySyncState.value = 'synced';
          rplaySyncMessage.value = '已使用之前保存的凭证 ✓';
        } else {
          rplaySyncState.value = 'failed';
          rplaySyncMessage.value = res?.error || '未在当前页面检测到有效登录 Token';
        }
      }
    } catch (e: unknown) {
      rplaySyncState.value = 'failed';
      const detail =
        e instanceof Error
          ? e.message
          : typeof e === 'string'
            ? e
            : e && typeof e === 'object' && 'message' in e && typeof e.message === 'string'
              ? e.message
              : String(e);
      rplaySyncMessage.value = '提取失败: ' + detail;
    }
  }

  /** Pre-fill synced state when a previously stored token exists (rplay page open). */
  async function markSyncedIfStored() {
    const stored = await chrome.storage?.local?.get('rplay_auth_token');
    if (stored?.rplay_auth_token) {
      rplaySyncState.value = 'synced';
      rplaySyncMessage.value = '已同步登录凭证 ✓';
    }
  }

  return { rplaySyncState, rplaySyncMessage, triggerRplaySync, markSyncedIfStored };
}
