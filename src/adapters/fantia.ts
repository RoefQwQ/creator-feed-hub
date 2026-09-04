import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { bgFetch } from '../utils/http';

export const fantiaAdapter: PlatformAdapter = {
  platform: 'fantia',

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    try {
      const clubId = channel.accountId;
      const page = options?.cursor ? Math.max(Number(options.cursor) || 1, 1) : 1;

      // Fetch fanclub post list via Background fetch to bypass CORS
      const apiUrl = `https://fantia.jp/api/v1/posts?fanclub_id=${clubId}&per_page=${limit}&page=${page}`;
      const res = await bgFetch(apiUrl, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (!res.ok) {
        throw new Error(`Fantia API 响应异常: HTTP ${res.status}`);
      }

      const json = JSON.parse(res.data);
      const postsData = json.posts || [];

      // Extract author meta if available
      let authorName = channel.displayName;
      let authorAvatar = channel.avatarUrl;

      if (postsData[0]?.fanclub) {
        authorName = postsData[0].fanclub.creator_name || postsData[0].fanclub.fanclub_name_or_creator_name;
        authorAvatar = postsData[0].fanclub.icon?.main || authorAvatar;
      }

      const posts: Post[] = postsData.map((p: any) => {
        const mediaList: any[] = [];
        if (p.thumb?.main) {
          mediaList.push({
            type: 'image',
            previewUrl: p.thumb.main,
            originalUrl: p.thumb.original || p.thumb.main,
          });
        }

        const pubDate = p.posted_at ? new Date(p.posted_at).getTime() : Date.now();

        return {
          id: `fantia_${p.id}`,
          creatorId: channel.creatorId,
          channelId: channel.id,
          platform: 'fantia',
          title: p.title || 'Fantia 投稿',
          content: (p.comment || p.title || '').slice(0, 300),
          mediaList,
          originalUrl: `https://fantia.jp/posts/${p.id}`,
          publishedAt: pubDate,
          fetchedAt: Date.now(),
          isRead: false,
        };
      });

      // Sort strictly newest first
      posts.sort((a, b) => b.publishedAt - a.publishedAt);

      const hasMore = postsData.length >= limit;

      return {
        posts,
        authorMeta: {
          name: authorName,
          avatar: authorAvatar,
        },
        nextCursor: hasMore ? String(page + 1) : undefined,
        hasMore,
      };
    } catch (err: any) {
      return {
        posts: [],
        error: err?.message || 'Fantia 更新抓取失败 (请确认是否在浏览器中登录过 Fantia)',
      };
    }
  },
};
