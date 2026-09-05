import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { bgFetch } from '../utils/http';

/** Map Bilibili business error codes to a clear, user-facing message. */
function biliCodeMessage(code: number, fallback?: string): string {
  switch (code) {
    case -101:
      return 'B站未登录或登录已过期，请检查登录状态';
    case -352:
      return 'B站风控校验失败，请稍后重试或完成人机验证';
    case -403:
      return 'B站接口拒绝访问（权限不足或签名失效），请确认登录状态后重试';
    case -412:
      return 'B站请求被拦截（风控），请稍后重试';
    default:
      return fallback || `B站接口异常 (code ${code})`;
  }
}

export const bilibiliAdapter: PlatformAdapter = {
  platform: 'bilibili',

  async fetchLatest(channel: Channel, limit: number = 15, options?: FetchOptions): Promise<FetchResult> {
    const uid = channel.accountId;
    let authorName = channel.displayName;
    let authorAvatar = channel.avatarUrl;

    // sinceTimestamp: the watermark. Normal sync skips anything older or equal to this.
    // Historical dig (options.cursor is set) ignores the watermark and fetches older content.
    const sinceTs = options?.cursor ? 0 : (options?.sinceTimestamp ?? 0);

    if (options?.cursor) {
      return this.fetchHistory(channel, uid, limit, options, authorName, authorAvatar);
    }

    const allPosts: Post[] = [];
    const seenBvids = new Set<string>();
    let nextCursor: string | undefined;
    let hasMore = false;
    // Remember non-zero business codes so a total-empty result reports the real cause.
    let lastDynamicCode: number | undefined;
    let lastMediaCode: number | undefined;

    // PRIMARY: Space dynamic feed (sorted newest-first, covers all dynamic types)
    try {
      const dynamicUrl = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${encodeURIComponent(uid)}`;
      const res = await bgFetch(dynamicUrl, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: `https://space.bilibili.com/${uid}/dynamic`,
          Origin: 'https://space.bilibili.com',
          'User-Agent': 'Mozilla/5.0',
        },
      });

      if (res.ok && res.data) {
        const json = JSON.parse(res.data);
        if (json.code !== 0) {
          lastDynamicCode = json.code;
          console.warn('[Bilibili] dynamic feed returned code', json.code, json.message);
        } else if (json.data?.items) {
          const items: any[] = json.data.items;
          if (json.data.has_more) hasMore = true;
          if (json.data.offset) nextCursor = String(json.data.offset);

          for (const item of items) {
            const modules = item.modules || {};
            const moduleAuthor = modules.module_author || {};
            const moduleDynamic = modules.module_dynamic || {};

            if (moduleAuthor.name) authorName = moduleAuthor.name;
            if (moduleAuthor.face) authorAvatar = moduleAuthor.face;

            const pubTime = moduleAuthor.pub_ts ? moduleAuthor.pub_ts * 1000 : 0;

            // WATERMARK CHECK: dynamic feed is newest-first, stop as soon as we hit old content
            if (sinceTs > 0 && pubTime > 0 && pubTime <= sinceTs) {
              hasMore = false;
              nextCursor = undefined;
              break;
            }

            const isForward = item.type === 'DYNAMIC_TYPE_FORWARD' || Boolean(item.orig);
            if (options?.onlyOriginal && isForward) continue;

            const archiveBvid = moduleDynamic.major?.archive?.bvid;
            if (archiveBvid && seenBvids.has(archiveBvid)) continue;
            if (archiveBvid) seenBvids.add(archiveBvid);

            const idStr = item.id_str || String(item.basic?.comment_id_str || item.id || '');
            const postId = archiveBvid
              ? `bilibili_video_${archiveBvid}`
              : `bilibili_${idStr || Math.random().toString(36).slice(2)}`;

            const text = moduleDynamic.desc?.text || moduleDynamic.major?.archive?.desc || '';
            const title = moduleDynamic.major?.archive?.title || '';

            const mediaList: any[] = [];
            const major = moduleDynamic.major || {};
            if (major.archive) {
              mediaList.push({
                type: 'video',
                previewUrl: major.archive.cover,
                originalUrl: `https://www.bilibili.com/video/${major.archive.bvid}`,
              });
            }
            if (major.draw?.items) {
              for (const img of major.draw.items) {
                mediaList.push({ type: 'image', previewUrl: img.src, originalUrl: img.src });
              }
            }
            // Forward posts: archive/draw media live on the original item, not the forward wrapper.
            if (isForward && item.orig?.modules?.module_dynamic?.major) {
              const origMajor = item.orig.modules.module_dynamic.major;
              if (origMajor.archive && !mediaList.some((m) => m.type === 'video' && m.originalUrl?.endsWith(origMajor.archive.bvid))) {
                mediaList.push({
                  type: 'video',
                  previewUrl: origMajor.archive.cover,
                  originalUrl: `https://www.bilibili.com/video/${origMajor.archive.bvid}`,
                });
              }
              if (origMajor.draw?.items) {
                for (const img of origMajor.draw.items) {
                  if (!mediaList.some((m) => m.type === 'image' && m.previewUrl === img.src)) {
                    mediaList.push({ type: 'image', previewUrl: img.src, originalUrl: img.src });
                  }
                }
              }
            }

            allPosts.push({
              id: postId,
              creatorId: channel.creatorId,
              channelId: channel.id,
              platform: 'bilibili',
              title,
              content: text || title || '（分享动态）',
              mediaList,
              originalUrl: archiveBvid
                ? `https://www.bilibili.com/video/${archiveBvid}`
                : `https://t.bilibili.com/${idStr}`,
              publishedAt: pubTime || Date.now(),
              fetchedAt: Date.now(),
              isRead: false,
              isRepost: isForward,
            });

            if (allPosts.length >= limit) break;
          }
        }
      }
    } catch (e) {
      console.warn('[Bilibili] dynamic feed fetch failed:', e);
    }

    // SUPPLEMENT: medialist API for pure video uploads that may have no dynamic post entry
    if (allPosts.length < limit) {
      try {
        const videoListUrl = `https://api.bilibili.com/x/v2/medialist/resource/list?type=1&biz_id=${uid}&ps=${limit}`;
        const res = await bgFetch(videoListUrl, {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Referer': `https://space.bilibili.com/${uid}/video`,
          },
        });

        if (res.ok && res.data) {
          const json = JSON.parse(res.data);
          if (json.code !== 0) {
            lastMediaCode = json.code;
            console.warn('[Bilibili] medialist returned code', json.code, json.message);
          } else if (json.data?.media_list) {
            for (const item of json.data.media_list) {
              const bvid = item.bv_id;
              if (!bvid || seenBvids.has(bvid)) continue;

              const pubTime = item.pubtime ? item.pubtime * 1000 : 0;
              // Skip if it falls within already-covered time range
              if (sinceTs > 0 && pubTime > 0 && pubTime <= sinceTs) continue;

              if (item.upper?.name) authorName = item.upper.name;
              if (item.upper?.face) authorAvatar = item.upper.face;

              seenBvids.add(bvid);
              const cover = item.cover || '';
              const title = item.title || '无标题视频';
              const desc = item.intro && item.intro !== '-' ? item.intro : title;

              allPosts.push({
                id: `bilibili_video_${bvid}`,
                creatorId: channel.creatorId,
                channelId: channel.id,
                platform: 'bilibili',
                title,
                content: desc,
                mediaList: cover ? [{ type: 'video', previewUrl: cover, originalUrl: `https://www.bilibili.com/video/${bvid}` }] : [],
                originalUrl: `https://www.bilibili.com/video/${bvid}`,
                publishedAt: pubTime || Date.now(),
                fetchedAt: Date.now(),
                isRead: false,
                isRepost: false,
              });

              if (allPosts.length >= limit) break;
            }
          }
        }
      } catch (e) {
        console.warn('[Bilibili] medialist supplement failed:', e);
      }
    }

    // Fallback: space archive search
    if (allPosts.length === 0) {
      const archiveResult = await this.fetchArchiveFallback(channel, limit, options);
      // A hard business-code failure (permission / risk-control) must not be masked by an empty archive result.
      const hardCode = lastDynamicCode ?? lastMediaCode;
      if (hardCode !== undefined && archiveResult.posts.length === 0) {
        return {
          posts: [],
          error: biliCodeMessage(hardCode, archiveResult.error),
        };
      }
      return archiveResult;
    }

    allPosts.sort((a, b) => b.publishedAt - a.publishedAt);

    return {
      posts: allPosts.slice(0, limit),
      authorMeta: { name: authorName, avatar: authorAvatar },
      nextCursor,
      hasMore,
    };
  },

  // Historical dig: paginate backwards through dynamic feed using offset cursor
  async fetchHistory(
    channel: Channel,
    uid: string,
    limit: number,
    options: FetchOptions,
    authorName?: string,
    authorAvatar?: string,
  ): Promise<FetchResult> {
    const allPosts: Post[] = [];
    const seenBvids = new Set<string>();
    let nextCursor: string | undefined;
    let hasMore = false;

    try {
      const offset = options.cursor || '';
      const dynamicUrl = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${uid}${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
      const res = await bgFetch(dynamicUrl, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Referer': `https://space.bilibili.com/${uid}/dynamic`,
        },
      });

      if (res.ok && res.data) {
        const json = JSON.parse(res.data);
        if (json.code === 0 && json.data?.items) {
          const items: any[] = json.data.items;
          hasMore = Boolean(json.data.has_more);
          if (json.data.offset) nextCursor = String(json.data.offset);

          for (const item of items) {
            const modules = item.modules || {};
            const moduleAuthor = modules.module_author || {};
            const moduleDynamic = modules.module_dynamic || {};

            if (moduleAuthor.name) authorName = moduleAuthor.name;
            if (moduleAuthor.face) authorAvatar = moduleAuthor.face;

            const isForward = item.type === 'DYNAMIC_TYPE_FORWARD' || Boolean(item.orig);
            if (options.onlyOriginal && isForward) continue;

            const archiveBvid = moduleDynamic.major?.archive?.bvid;
            if (archiveBvid && seenBvids.has(archiveBvid)) continue;
            if (archiveBvid) seenBvids.add(archiveBvid);

            const idStr = item.id_str || String(item.basic?.comment_id_str || item.id || '');
            const postId = archiveBvid
              ? `bilibili_video_${archiveBvid}`
              : `bilibili_${idStr || Math.random().toString(36).slice(2)}`;
            const pubTime = moduleAuthor.pub_ts ? moduleAuthor.pub_ts * 1000 : Date.now();
            const text = moduleDynamic.desc?.text || moduleDynamic.major?.archive?.desc || '';
            const title = moduleDynamic.major?.archive?.title || '';

            const mediaList: any[] = [];
            const major = moduleDynamic.major || {};
            if (major.archive) {
              mediaList.push({
                type: 'video',
                previewUrl: major.archive.cover,
                originalUrl: `https://www.bilibili.com/video/${major.archive.bvid}`,
              });
            }
            if (major.draw?.items) {
              for (const img of major.draw.items) {
                mediaList.push({ type: 'image', previewUrl: img.src, originalUrl: img.src });
              }
            }
            // Forward posts: archive/draw media live on the original item, not the forward wrapper.
            if (isForward && item.orig?.modules?.module_dynamic?.major) {
              const origMajor = item.orig.modules.module_dynamic.major;
              if (origMajor.archive && !mediaList.some((m) => m.type === 'video' && m.originalUrl?.endsWith(origMajor.archive.bvid))) {
                mediaList.push({
                  type: 'video',
                  previewUrl: origMajor.archive.cover,
                  originalUrl: `https://www.bilibili.com/video/${origMajor.archive.bvid}`,
                });
              }
              if (origMajor.draw?.items) {
                for (const img of origMajor.draw.items) {
                  if (!mediaList.some((m) => m.type === 'image' && m.previewUrl === img.src)) {
                    mediaList.push({ type: 'image', previewUrl: img.src, originalUrl: img.src });
                  }
                }
              }
            }

            allPosts.push({
              id: postId,
              creatorId: channel.creatorId,
              channelId: channel.id,
              platform: 'bilibili',
              title,
              content: text || title || '（分享动态）',
              mediaList,
              originalUrl: archiveBvid
                ? `https://www.bilibili.com/video/${archiveBvid}`
                : `https://t.bilibili.com/${idStr}`,
              publishedAt: pubTime,
              fetchedAt: Date.now(),
              isRead: false,
              isRepost: isForward,
            });

            if (allPosts.length >= limit) break;
          }
        }
      }
    } catch (e) {
      console.warn('[Bilibili] historical dynamic fetch failed:', e);
    }

    return {
      posts: allPosts,
      authorMeta: { name: authorName, avatar: authorAvatar },
      nextCursor,
      hasMore,
    };
  },

  async fetchArchiveFallback(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    try {
      const uid = channel.accountId;
      const sinceTs = options?.sinceTimestamp ?? 0;
      const pn = options?.cursor ? Math.max(Number(options.cursor) || 1, 1) : 1;
      const archiveUrl = `https://api.bilibili.com/x/space/wbi/arc/search?mid=${uid}&ps=${limit}&tid=0&pn=${pn}&order=pubdate`;
      const res = await bgFetch(archiveUrl, {
        headers: { 'Referer': `https://space.bilibili.com/${uid}/video` },
      });

      if (!res.ok) return { posts: [], error: `B站接口异常 HTTP ${res.status}` };

      const json = JSON.parse(res.data);
      if (json.code === 0 && json.data?.list?.vlist) {
        const vlist: any[] = json.data.list.vlist;
        const total = json.data?.page?.count || 0;
        const hasMore = pn * limit < total && vlist.length > 0;

        const posts: Post[] = vlist
          .filter((v: any) => sinceTs === 0 || v.created * 1000 > sinceTs)
          .map((v: any) => ({
            id: `bilibili_video_${v.bvid}`,
            creatorId: channel.creatorId,
            channelId: channel.id,
            platform: 'bilibili',
            title: v.title,
            content: v.description || v.title,
            mediaList: [{ type: 'video', previewUrl: v.pic, originalUrl: `https://www.bilibili.com/video/${v.bvid}` }],
            originalUrl: `https://www.bilibili.com/video/${v.bvid}`,
            publishedAt: v.created * 1000,
            fetchedAt: Date.now(),
            isRead: false,
            isRepost: false,
          }));

        return {
          posts,
          authorMeta: { name: vlist[0]?.author || channel.displayName },
          nextCursor: hasMore ? String(pn + 1) : undefined,
          hasMore,
        };
      }
      return { posts: [], error: biliCodeMessage(json.code, json.message || '获取B站投稿失败') };
    } catch (e: any) {
      return { posts: [], error: e.message || '网络连接异常' };
    }
  },

  async checkAuthStatus(): Promise<{ loggedIn: boolean; username?: string }> {
    if (typeof chrome === 'undefined' || !chrome.cookies?.get) return { loggedIn: false };
    try {
      const sessdata = await chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'SESSDATA' });
      const dedeUserId = await chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'DedeUserID' });
      return { loggedIn: Boolean(sessdata?.value || dedeUserId?.value) };
    } catch {
      return { loggedIn: false };
    }
  },
};
