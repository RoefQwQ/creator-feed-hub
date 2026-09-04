import Dexie, { type Table } from 'dexie';
import type { Creator, Channel, Post, AppSettings } from '../types';

export class FeedDatabase extends Dexie {
  creators!: Table<Creator, string>;
  channels!: Table<Channel, string>;
  posts!: Table<Post, string>;
  settings!: Table<{ key: string; value: any }, string>;

  constructor() {
    super('CreatorFeedHubDB');
    this.version(1).stores({
      creators: 'id, name, *tags, createdAt, sortOrder',
      channels: 'id, creatorId, platform, accountId, status, lastCheckAt',
      posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked',
      settings: 'key',
    });
    // Version 2: Add compound index [channelId+publishedAt] for blazing fast channel queries & watermark checks
    this.version(2).stores({
      posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked, [channelId+publishedAt]',
    });
  }
}

export const db = new FeedDatabase();

// Default settings
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  itemsPerFetch: 10,
  requestDelayMs: 600,
  enableR18Blur: true,
  autoOpenOriginalUrl: false,
  hideReposts: false,
};

export async function getSettings(): Promise<AppSettings> {
  const item = await db.settings.get('app_settings');
  return item ? { ...DEFAULT_SETTINGS, ...item.value } : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const updated = { ...current, ...settings };
  await db.settings.put({ key: 'app_settings', value: updated });
  return updated;
}

/**
 * Get comprehensive database statistics (record counts and estimated storage)
 */
export async function getDatabaseStats() {
  const creatorsCount = await db.creators.count();
  const channelsCount = await db.channels.count();
  const totalPostsCount = await db.posts.count();
  const bookmarkedPostsCount = await db.posts.where('isBookmarked').equals(1 as any).count();

  let quotaUsage = { usage: 0, quota: 0 };
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      quotaUsage = {
        usage: est.usage || 0,
        quota: est.quota || 0,
      };
    } catch {}
  }

  return {
    creatorsCount,
    channelsCount,
    totalPostsCount,
    bookmarkedPostsCount,
    storageUsageBytes: quotaUsage.usage,
    storageQuotaBytes: quotaUsage.quota,
  };
}

/**
 * Clean up old unbookmarked posts to prevent storage explosion.
 * @param days Keep posts newer than this many days (e.g. 30, 60, 90). If 0, delete all unbookmarked posts.
 * @returns Number of posts deleted
 */
export async function cleanupOldPosts(days: number = 60): Promise<number> {
  const cutoffTime = days > 0 ? Date.now() - days * 86400 * 1000 : Infinity;

  // Find posts to delete: published before cutoff and NOT bookmarked
  const postsToDelete = await db.posts
    .filter(p => {
      const isOld = days === 0 || p.publishedAt < cutoffTime;
      const isProtected = Boolean(p.isBookmarked);
      return isOld && !isProtected;
    })
    .primaryKeys();

  if (postsToDelete.length > 0) {
    await db.posts.bulkDelete(postsToDelete);
  }

  return postsToDelete.length;
}
