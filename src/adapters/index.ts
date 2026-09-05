import type { Platform, Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { bilibiliAdapter } from './bilibili';
import { youtubeAdapter } from './youtube';
import { twitterAdapter } from './twitter';
import { pixivAdapter } from './pixiv';
import { fantiaAdapter } from './fantia';
import { rplayAdapter } from './rplay';
import { withnyAdapter } from './withny';
import { xiaohongshuAdapter } from './xiaohongshu';
import { weiboAdapter } from './weibo';
import { rssAdapter } from './rss';
import { db } from '../db';

const ADAPTER_MAP: Record<string, PlatformAdapter> = {
  bilibili: bilibiliAdapter,
  youtube: youtubeAdapter,
  twitter: twitterAdapter,
  pixiv: pixivAdapter,
  fantia: fantiaAdapter,
  rplay: rplayAdapter,
  withny: withnyAdapter,
  xiaohongshu: xiaohongshuAdapter,
  weibo: weiboAdapter,
  rss: rssAdapter,
};

export function getAdapter(platform: Platform): PlatformAdapter | undefined {
  return ADAPTER_MAP[platform] || ADAPTER_MAP['rss'];
}

export function registerAdapter(platformKey: string, adapter: PlatformAdapter) {
  ADAPTER_MAP[platformKey] = adapter;
}

/**
 * Resets any channels that were left in 'updating' status due to browser restart or crash.
 */
export async function clearStaleUpdatingStatus() {
  try {
    await db.channels.where('status').equals('updating').modify({
      status: 'idle',
    });
  } catch (e) {
    console.warn('[Adapters] Failed to clear stale updating status:', e);
  }
}

/**
 * Format error message with helpful, non-cryptic explanation for rate-limiting.
 */
function normalizeErrorMessage(errorStr?: string): string | undefined {
  if (!errorStr) return undefined;
  if (errorStr.includes('429') || errorStr.toLowerCase().includes('too many requests')) {
    return '触发平台防刷频率限制 (HTTP 429)。目标平台正在进行安全限流冷却，请等待 2~3 分钟后再刷新，避免频繁请求。';
  }
  return errorStr;
}

/**
 * Executes an on-demand update for a single channel with timeout safety & rate-limiting protection.
 */
export async function updateChannel(
  channel: Channel,
  limit: number = 10,
  force: boolean = false,
  options?: FetchOptions
): Promise<FetchResult> {
  const adapter = getAdapter(channel.platform);
  if (!adapter) {
    return { posts: [], error: `不支持的平台: ${channel.platform}` };
  }

  // Cooldown protection: if updated successfully within 30 seconds and not forced, skip hitting network
  if (!force && !options?.cursor && channel.lastSuccessAt && Date.now() - channel.lastSuccessAt < 30_000) {
    return {
      posts: [],
      error: undefined,
    };
  }

  // Set updating status
  await db.channels.update(channel.id, {
    status: 'updating',
    errorMessage: undefined,
  });

  try {
    // Twitter may need an existing authenticated tab fallback; allow enough time for it to load.
    const timeoutPromise = new Promise<FetchResult>((_, reject) => {
      setTimeout(() => reject(new Error('同步请求超时（已超过 45 秒未响应，请检查平台登录状态）')), 45_000);
    });

    // For normal (non-paginated) syncs, find the newest post already in DB to use as a watermark.
    // This tells adapters to only return content *newer* than what we already have.
    let sinceTimestamp = options?.sinceTimestamp ?? 0;
    if (!sinceTimestamp && !options?.cursor) {
      try {
        const latestPost = await db.posts
          .where('channelId')
          .equals(channel.id)
          .reverse()
          .sortBy('publishedAt');
        if (latestPost.length > 0) {
          sinceTimestamp = latestPost[0].publishedAt;
        }
      } catch {}
    }

    const mergedOptions: FetchOptions = { ...options, sinceTimestamp };
    const result = await Promise.race([adapter.fetchLatest(channel, limit, mergedOptions), timeoutPromise]);

    if (result.error && result.posts.length === 0) {
      const friendlyError = normalizeErrorMessage(result.error);
      await db.channels.update(channel.id, {
        status: 'error',
        errorMessage: friendlyError,
        lastCheckAt: Date.now(),
      });
      return { ...result, error: friendlyError };
    }

    let enhancedPosts: Post[] = [];

    // Save or upsert posts (ensure channelLabel is populated)
    if (result.posts && result.posts.length > 0) {
      // Universal incremental filter:
      // 1. Normal sync (sinceTimestamp > 0): drop posts where publishedAt <= sinceTimestamp (already stored)
      // 2. History dig (options?.cursor set): drop posts whose ID already exists in DB so only new older items are added
      let newPosts = result.posts;
      if (sinceTimestamp > 0) {
        newPosts = result.posts.filter(p => p.publishedAt > sinceTimestamp);
      } else if (options?.cursor) {
        try {
          // Use primaryKeys() instead of toArray() to avoid pulling full object payloads into memory
          const existingIds = new Set(
            await db.posts.where('channelId').equals(channel.id).primaryKeys()
          );
          newPosts = result.posts.filter(p => !existingIds.has(p.id));
        } catch {}
      }

      enhancedPosts = newPosts.map((p) => ({
        ...p,
        channelLabel: p.channelLabel || channel.label,
      }));

      if (enhancedPosts.length > 0) {
        await db.posts.bulkPut(enhancedPosts);
      }

      // Bilibili dedup cleanup: remove any old bilibili_<dynId> posts that share
      // the same originalUrl as a freshly saved bilibili_video_<bvid> post.
      if (channel.platform === 'bilibili') {
        const videoUrls = new Set(
          enhancedPosts
            .filter(p => p.id.startsWith('bilibili_video_'))
            .map(p => p.originalUrl)
        );
        if (videoUrls.size > 0) {
          const existingPosts = await db.posts.where('channelId').equals(channel.id).toArray();
          const staleIds = existingPosts
            .filter(p => !p.id.startsWith('bilibili_video_') && videoUrls.has(p.originalUrl))
            .map(p => p.id);
          if (staleIds.length > 0) {
            await db.posts.bulkDelete(staleIds);
          }
        }
      }
    }

    // Update channel metadata if updated
    const updates: Partial<Channel> = {
      status: 'success',
      lastCheckAt: Date.now(),
      lastSuccessAt: Date.now(),
      errorMessage: undefined,
    };

    // Cursor handling:
    // When doing a historical dig (options?.cursor is present):
    if (options?.cursor) {
      if (result.nextCursor) {
        updates.nextCursor = result.nextCursor;
      } else if (result.hasMore === false) {
        updates.nextCursor = '__END__';
      }
    } else {
      // Normal sync (fetching latest):
      // Only set nextCursor if channel currently has no cursor at all.
      // NEVER overwrite an already advanced historical cursor with page 1's cursor!
      if (result.nextCursor && !channel.nextCursor) {
        updates.nextCursor = result.nextCursor;
      }
    }

    if (result.authorMeta?.name) {
      const authName = result.authorMeta.name.trim();
      const currentName = channel.displayName || '';
      const isPlaceholderName =
        !currentName ||
        currentName === channel.accountId ||
        currentName === channel.accountId.replace(/^@/, '') ||
        currentName === `@${channel.accountId.replace(/^@/, '')}` ||
        currentName.startsWith(channel.platform) ||
        currentName.startsWith('Channel_') ||
        currentName.startsWith('B站') ||
        currentName.startsWith('小红书') ||
        currentName.startsWith('微博') ||
        currentName.startsWith('Pixiv') ||
        currentName.startsWith('Fantia') ||
        currentName.startsWith('Rplay');

      if (isPlaceholderName && authName) {
        updates.displayName = authName;
      }
    }
    // Always update avatarUrl on channel (not just when empty, to stay fresh)
    if (result.authorMeta?.avatar) {
      updates.avatarUrl = result.authorMeta.avatar;
    }

    await db.channels.update(channel.id, updates);

    // Propagate avatar & authoritative name to parent Creator if Creator has default/placeholder info
    if (channel.creatorId) {
      const creator = await db.creators.get(channel.creatorId);
      if (creator) {
        const creatorUpdates: Partial<Creator> = {};
        // Update Creator avatar if empty, invalid, or updated
        if (result.authorMeta?.avatar && (!creator.avatar || creator.avatar.trim() === '' || creator.avatar.startsWith('http://'))) {
          creatorUpdates.avatar = result.authorMeta.avatar;
        }
        if (result.authorMeta?.name) {
          const authName = result.authorMeta.name.trim();
          const isDefaultCreatorName =
            !creator.name ||
            creator.name === '新创作者' ||
            creator.name === '未命名创作者' ||
            creator.name === channel.accountId ||
            creator.name === channel.accountId.replace(/^@/, '') ||
            creator.name.startsWith('Channel_') ||
            creator.name.startsWith('B站用户_') ||
            creator.name.startsWith('B站稿件_') ||
            creator.name.startsWith('小红书_') ||
            creator.name.startsWith('微博_') ||
            creator.name.startsWith('Pixiv画师_') ||
            creator.name.startsWith('Fantia俱乐部_') ||
            creator.name.startsWith('Rplay_');

          if (isDefaultCreatorName && authName) {
            creatorUpdates.name = authName;
          }
        }
        if (Object.keys(creatorUpdates).length > 0) {
          creatorUpdates.updatedAt = Date.now();
          await db.creators.update(channel.creatorId, creatorUpdates);
        }
      }
    }

    // Return the genuinely newly discovered posts so caller alerts reflect actual new content
    return {
      ...result,
      posts: enhancedPosts,
    };
  } catch (err: any) {
    const friendlyError = normalizeErrorMessage(err?.message || '未知异常');
    await db.channels.update(channel.id, {
      status: 'error',
      errorMessage: friendlyError,
      lastCheckAt: Date.now(),
    });
    return { posts: [], error: friendlyError };
  } finally {
    // Failsafe: Ensure channel is NEVER left in 'updating' status
    const current = await db.channels.get(channel.id);
    if (current?.status === 'updating') {
      await db.channels.update(channel.id, { status: 'idle' });
    }
  }
}

/**
 * Updates all channels belonging to a specific Creator
 */
export async function updateCreator(
  creatorId: string,
  limit: number = 10,
  options?: FetchOptions
): Promise<FetchResult[]> {
  const channels = await db.channels.where('creatorId').equals(creatorId).toArray();
  const results: FetchResult[] = [];
  for (const ch of channels) {
    const res = await updateChannel(ch, limit, true, options);
    results.push(res);
    // Paced delay to avoid 429
    await new Promise((r) => setTimeout(r, 800));
  }
  return results;
}

/**
 * Fetches older historical posts for a channel using its saved pagination cursor
 */
export async function fetchChannelHistory(
  channel: Channel,
  limit: number = 10,
  onlyOriginal: boolean = false
): Promise<FetchResult> {
  if (channel.nextCursor === '__END__') {
    return {
      posts: [],
      error: '已到达该账号历史作品最底部，暂无更多更早内容。',
      hasMore: false,
    };
  }

  return await updateChannel(channel, limit, true, {
    cursor: channel.nextCursor,
    onlyOriginal,
  });
}

export interface DeepSyncOptions {
  maxPosts?: number; // 0: unconstrained / dig to the end
  untilTimestamp?: number; // 0: no date limit
  onlyOriginal?: boolean;
  onProgress?: (info: {
    channelId: string;
    displayName: string;
    platform: string;
    round: number;
    fetchedThisRound: number;
    totalNewPosts: number;
    reachEnd: boolean;
    status: 'fetching' | 'done' | 'error';
    error?: string;
  }) => void;
  shouldStop?: () => boolean;
}

/**
 * Iteratively deep-syncs past history for a channel until target count/date or the end is reached
 */
export async function deepSyncChannel(
  channel: Channel,
  options: DeepSyncOptions = {}
): Promise<{ totalNew: number; reachEnd: boolean; rounds: number; error?: string }> {
  let totalNew = 0;
  let rounds = 0;
  const maxPosts = options.maxPosts || 0;
  const untilTimestamp = options.untilTimestamp || 0;

  while (true) {
    if (options.shouldStop?.()) {
      options.onProgress?.({
        channelId: channel.id,
        displayName: channel.displayName || channel.accountId,
        platform: channel.platform,
        round: rounds,
        fetchedThisRound: 0,
        totalNewPosts: totalNew,
        reachEnd: false,
        status: 'done',
      });
      break;
    }

    const currentCh = await db.channels.get(channel.id);
    if (!currentCh || currentCh.nextCursor === '__END__') {
      options.onProgress?.({
        channelId: channel.id,
        displayName: channel.displayName || channel.accountId,
        platform: channel.platform,
        round: rounds,
        fetchedThisRound: 0,
        totalNewPosts: totalNew,
        reachEnd: true,
        status: 'done',
      });
      return { totalNew, reachEnd: true, rounds };
    }

    rounds++;
    options.onProgress?.({
      channelId: channel.id,
      displayName: channel.displayName || channel.accountId,
      platform: channel.platform,
      round: rounds,
      fetchedThisRound: 0,
      totalNewPosts: totalNew,
      reachEnd: false,
      status: 'fetching',
    });

    const res = await fetchChannelHistory(currentCh, 20, options.onlyOriginal);
    const newCount = res.posts?.length || 0;
    totalNew += newCount;

    options.onProgress?.({
      channelId: channel.id,
      displayName: channel.displayName || channel.accountId,
      platform: channel.platform,
      round: rounds,
      fetchedThisRound: newCount,
      totalNewPosts: totalNew,
      reachEnd: Boolean(res.hasMore === false || res.posts.length === 0),
      status: res.error ? 'error' : 'fetching',
      error: res.error,
    });

    if (res.error || !res.posts || res.posts.length === 0 || res.hasMore === false) {
      break;
    }

    // Check if reached untilTimestamp
    if (untilTimestamp > 0) {
      const oldestInBatch = Math.min(...res.posts.map((p) => p.publishedAt || Date.now()));
      if (oldestInBatch <= untilTimestamp) {
        break;
      }
    }

    // Check if reached maxPosts
    if (maxPosts > 0 && totalNew >= maxPosts) {
      break;
    }

    // Safe paced delay between pagination calls (at least 900ms)
    await new Promise((r) => setTimeout(r, 900));
  }

  return { totalNew, reachEnd: false, rounds };
}

