import { db } from './database';

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
