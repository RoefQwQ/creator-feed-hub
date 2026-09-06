import { db } from '../db/database';
import { getSettings } from '../db/settingsRepository';
import { updateChannel } from '../../sync/channelSync';
const AUTO_SYNC_ALARM = 'creator-feed-auto-sync';

/**
 * (Re)creates or clears the periodic auto-sync alarm according to the current
 * setting, then refreshes the unread badge. Safe to call on startup, install
 * or whenever the setting changes.
 */
export async function setupAutoSync() {
  if (!chrome.alarms) return;
  const settings = await getSettings();
  if (settings.enableAutoSync) {
    await chrome.alarms.create(AUTO_SYNC_ALARM, { periodInMinutes: 30 });
  } else {
    await chrome.alarms.clear(AUTO_SYNC_ALARM);
  }
  await updateUnreadBadge();
}

/**
 * Syncs every tracked channel once with the current per-fetch limit and
 * repost preference. No-op while auto-sync is disabled.
 */
async function syncAllChannels() {
  try {
    const settings = await getSettings();
    if (!settings.enableAutoSync) return;

    const channels = await db.channels.toArray();
    for (const channel of channels) {
      await updateChannel(channel, settings.itemsPerFetch, false, { onlyOriginal: settings.hideReposts });
    }
  } catch (error) {
    console.warn('[Background] Auto-sync failed:', error);
  }
}

/**
 * Reflects the unread post count on the toolbar badge (capped at 999, indigo).
 */
async function updateUnreadBadge() {
  try {
    const unreadCount = await db.posts.where('isRead').equals(0).count();
    await chrome.action?.setBadgeText({ text: unreadCount > 0 ? String(Math.min(unreadCount, 999)) : '' });
    await chrome.action?.setBadgeBackgroundColor({ color: '#4f46e5' });
  } catch (error) {
    console.warn('[Background] Badge update failed:', error);
  }
}

/**
 * Handler for the auto-sync alarm: clears the alarm when auto-sync is
 * disabled, otherwise syncs all channels and refreshes the badge.
 */
export async function handleAutoSyncAlarm(alarm: { name: string }) {
  if (!chrome.alarms) return;
  if (alarm.name !== AUTO_SYNC_ALARM) return;
  const settings = await getSettings();
  if (!settings.enableAutoSync) {
    // Clear alarm if auto sync is disabled
    await chrome.alarms.clear(AUTO_SYNC_ALARM);
    return;
  }
  await syncAllChannels();
  await updateUnreadBadge();
}
