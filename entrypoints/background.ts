import { defineBackground } from 'wxt/utils/define-background';
import { db, getSettings } from '../src/db';
import { updateChannel } from '../src/adapters';

const AUTO_SYNC_ALARM = 'creator-feed-auto-sync';

// Public guest bearer token used by x.com's web GraphQL client.
const TWITTER_BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export default defineBackground(() => {
  console.log('[Creator Feed Hub] Background Service Worker ready');
  setupDeclarativeNetRules();
  setupAutoSync();

  chrome.runtime.onInstalled.addListener(() => {
    setupDeclarativeNetRules();
    setupAutoSync();
  });

  chrome.alarms?.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== AUTO_SYNC_ALARM) return;
    const settings = await getSettings();
    if (!settings.enableAutoSync) {
      // Clear alarm if auto sync is disabled
      await chrome.alarms.clear(AUTO_SYNC_ALARM);
      return;
    }
    await syncAllChannels();
    await updateUnreadBadge();
  });

async function setupAutoSync() {
  if (!chrome.alarms) return;
  const settings = await getSettings();
  if (settings.enableAutoSync) {
    await chrome.alarms.create(AUTO_SYNC_ALARM, { periodInMinutes: 30 });
  } else {
    await chrome.alarms.clear(AUTO_SYNC_ALARM);
  }
  await updateUnreadBadge();
}

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

async function updateUnreadBadge() {
  try {
    const unreadCount = await db.posts.where('isRead').equals(0).count();
    await chrome.action?.setBadgeText({ text: unreadCount > 0 ? String(Math.min(unreadCount, 999)) : '' });
    await chrome.action?.setBadgeBackgroundColor({ color: '#4f46e5' });
  } catch (error) {
    console.warn('[Background] Badge update failed:', error);
  }
}


  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'UPDATE_AUTO_SYNC') {
      setupAutoSync();
      sendResponse({ success: true });
      return false;
    }

    if (message.type === 'OPEN_DASHBOARD') {
      chrome.tabs.create({
        url: chrome.runtime.getURL('/dashboard.html'),
      });
      sendResponse({ success: true });
      return false;
    }

    if (message.type === 'SAVE_RPLAY_TOKEN') {
      if (message.token && typeof message.token === 'string') {
        chrome.storage?.local?.set({ rplay_auth_token: message.token });
      }
      sendResponse({ success: true });
      return false;
    }

    if (message.type === 'BG_FETCH') {
      (async () => {
        try {
          const url = message.url as string;
          const headers: Record<string, string> = { ...(message.options?.headers || {}) };

          if (url.includes('bilibili.com') || url.includes('hdslb.com')) {
            // Bilibili cookies (incl. HttpOnly SESSDATA / bili_jct) cannot be set via the
            // fetch "Cookie" header: browsers forbid and silently strip it, which caused
            // unauthenticated "访问权限不足" responses. They are attached automatically by
            // fetch's credentials: 'include' (host permissions already declared in the manifest).
            // Note: User-Agent / Referer / Origin are also browser-forbidden headers and are
            // ignored even if set here; the browser sends its own real UA automatically. The
            // adapter relies on medialist (which needs no special headers) as the authoritative
            // source, so the risk-controlled dynamic feed is only a best-effort supplement.
            try {
              const cookies = await Promise.all([
                chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'SESSDATA' }),
                chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'DedeUserID' }),
                chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'buvid3' }),
              ]);
              if (!cookies.some((cookie) => Boolean(cookie?.value))) {
                console.warn(
                  '[Background] Bilibili: no login/device cookies found; the dynamic feed may be risk-controlled (video list will still work)'
                );
              }
            } catch (error) {
              console.warn('[Background] Bilibili cookie read failed:', error);
            }
          }

          // 2. Auto-inject Rplay token & headers if accessing rplay.live
          if (url.includes('rplay.live')) {
            if (!headers['Referer']) headers['Referer'] = 'https://rplay.live/';
            if (!headers['Origin']) headers['Origin'] = 'https://rplay.live';
            if (!headers['platform-type']) headers['platform-type'] = 'web';
            if (typeof chrome !== 'undefined' && chrome.storage?.local && !headers['Authorization'] && !headers['authorization']) {
              try {
                const stored = await chrome.storage.local.get('rplay_auth_token');
                if (stored?.rplay_auth_token) {
                  headers['Authorization'] = stored.rplay_auth_token;
                }
              } catch (e) {
                console.warn('[Background] Rplay token inject error:', e);
              }
            }
          }

          const res = await fetch(url, {
            method: message.options?.method || 'GET',
            headers,
            credentials: message.options?.credentials || 'include',
          });

          const text = await res.text();
          sendResponse({
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            data: text,
          });
        } catch (err: any) {
          console.error('[Background] Fetch error:', err);
          sendResponse({
            ok: false,
            status: 0,
            data: '',
            error: err.message || 'Background fetch error',
          });
        }
      })();
      return true; // Keep message channel open for async response
    }

    if (message.type === 'PROXY_IMAGE') {
      (async () => {
        try {
          const url = (message.url as string || '').trim();
          if (!url || !/^https?:\/\//i.test(url)) {
            sendResponse({ ok: false, error: 'Invalid URL' });
            return;
          }

          const isXhs = url.includes('xhscdn.com') || url.includes('xiaohongshu.com') || url.includes('xhscdn.net');
          let referer = 'https://www.xiaohongshu.com/';
          let origin = 'https://www.xiaohongshu.com';
          if (url.includes('sinaimg.cn') || url.includes('weibo.com')) {
            referer = 'https://weibo.com/';
            origin = 'https://weibo.com';
          } else if (url.includes('pximg.net') || url.includes('pixiv.net')) {
            referer = 'https://www.pixiv.net/';
            origin = 'https://www.pixiv.net';
          } else if (url.includes('bilibili.com') || url.includes('hdslb.com')) {
            referer = 'https://www.bilibili.com/';
            origin = 'https://www.bilibili.com';
          }

          // Generate candidate URLs to try if first one returns 403/404 (e.g. Xiaohongshu CDN domain fallback)
          const urlsToTry = [url];
          if (isXhs) {
            if (url.includes('sns-webpic-qc.xhscdn.com')) {
              urlsToTry.push(url.replace('sns-webpic-qc.xhscdn.com', 'sns-img-qc.xhscdn.com'));
              urlsToTry.push(url.replace('sns-webpic-qc.xhscdn.com', 'sns-img-bd.xhscdn.com'));
            } else if (url.includes('sns-img-qc.xhscdn.com')) {
              urlsToTry.push(url.replace('sns-img-qc.xhscdn.com', 'sns-img-bd.xhscdn.com'));
              urlsToTry.push(url.replace('sns-img-qc.xhscdn.com', 'sns-webpic-qc.xhscdn.com'));
            }
          }

          let res: Response | null = null;
          let lastStatus = 0;

          for (const targetUrl of urlsToTry) {
            try {
              const fetchOptions: RequestInit = {
                method: 'GET',
                headers: {
                  Referer: referer,
                  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                },
                // Use 'include' so extension host permissions attach user's authenticated cookies (e.g. web_session, a1)
                credentials: isXhs ? 'include' : 'omit',
              };

              const resp = await fetch(targetUrl, fetchOptions);
              if (resp.ok) {
                res = resp;
                break;
              }
              lastStatus = resp.status;
            } catch {
              // Try next candidate
            }
          }

          if (!res || !res.ok) {
            sendResponse({ ok: false, status: lastStatus, error: `HTTP ${lastStatus || 403}` });
            return;
          }

          const arrayBuffer = await res.arrayBuffer();
          const mimeType = res.headers.get('content-type') || 'image/jpeg';
          const bytes = new Uint8Array(arrayBuffer);
          let binary = '';
          const chunkSize = 8192;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[]);
          }
          const base64 = btoa(binary);
          const dataUrl = `data:${mimeType};base64,${base64}`;

          sendResponse({ ok: true, dataUrl });
        } catch (err: any) {
          console.error('[Background] PROXY_IMAGE error:', err);
          sendResponse({ ok: false, error: err?.message || 'Proxy image error' });
        }
      })();
      return true;
    }

    if (message.type === 'SYNC_RPLAY_TOKEN') {
      (async () => {
        try {
          if (!chrome.tabs || !chrome.scripting) {
            sendResponse({ success: false, error: 'Background 缺少 tabs 或 scripting 权限' });
            return;
          }

          // 1. Try querying specifically for rplay.live tabs, fallback to all tabs
          let tabs = await chrome.tabs.query({ url: ['*://*.rplay.live/*', 'https://rplay.live/*'] }).catch(() => []);
          if (!tabs || tabs.length === 0) {
            const allTabs = await chrome.tabs.query({}).catch(() => []);
            tabs = allTabs.filter(t => t.url && t.url.includes('rplay.live'));
          }

          if (tabs.length === 0) {
            sendResponse({
              success: false,
              error: '未检测到已打开的 rplay.live 标签页。请先在浏览器中新建标签页打开 rplay.live 并确认已登录（也可以使用“手动粘贴”输入凭证）。',
            });
            return;
          }

          let token: string | null = null;
          for (const tab of tabs) {
            if (!tab.id) continue;
            try {
              const res = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                  const candidateKeys = [
                    '_AUTHORIZATION_',
                    'token',
                    'pocketbase_auth',
                    'auth_token',
                    'accessToken',
                    'auth',
                  ];
                  for (const k of candidateKeys) {
                    const val = localStorage.getItem(k);
                    if (val && val.length > 8) return val;
                  }
                  // Scan all keys
                  for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && (k.toLowerCase().includes('auth') || k.toLowerCase().includes('token'))) {
                      const v = localStorage.getItem(k);
                      if (v && v.length > 8) return v;
                    }
                  }
                  return null;
                },
              });

              if (res?.[0]?.result) {
                token = res[0].result;
                break;
              }
            } catch (scriptErr) {
              console.warn('[Background] Tab scripting error:', scriptErr);
            }
          }

          if (token) {
            await chrome.storage.local.set({ rplay_auth_token: token });
            sendResponse({ success: true, token });
          } else {
            sendResponse({
              success: false,
              error: '已检测到打开的 Rplay 页面，但在该页面 LocalStorage 中未找到有效登录 Token，请确认已在 rplay.live 登录。',
            });
          }
        } catch (err: any) {
          sendResponse({ success: false, error: err?.message || '提取凭证异常' });
        }
      })();
      return true;
    }

    if (message.type === 'FETCH_TWITTER_TIMELINE') {
      (async () => {
        try {
          const username = (message.username as string || '').replace(/^@/, '').trim();
          const limit = Number(message.limit) || 12;
          const onlyOriginal = Boolean(message.onlyOriginal);
          const cursor = typeof message.cursor === 'string' ? message.cursor : '';
          if (!username) {
            sendResponse({ success: false, error: '缺少推特用户名' });
            return;
          }

          // Keep the proven page-context path as primary; direct fetch is only a fallback.
          const pageResult = await fetchTwitterTimelineViaTabOrSession(username, limit, onlyOriginal, cursor);
          const directResult = pageResult?.success ? null : await fetchTwitterTimelineDirect(username, limit, onlyOriginal, cursor);
          sendResponse(pageResult?.success ? pageResult : (directResult || pageResult));
        } catch (err: any) {
          sendResponse({ success: false, error: err?.message || '获取推特动态异常' });
        }
      })();
      return true;
    }

    return false;
  });

  // Auto-sync Rplay auth token when user visits or navigates on rplay.live
  if (chrome.tabs?.onUpdated) {
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab.url && tab.url.includes('rplay.live')) {
        try {
          const res = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => localStorage.getItem('_AUTHORIZATION_'),
          });
          const token = res?.[0]?.result;
          if (token && typeof token === 'string' && token.length > 8) {
            console.log('[Background] Auto-saved Rplay auth token from active tab');
            await chrome.storage.local.set({ rplay_auth_token: token });
          }
        } catch {
          // Tab may not be ready or page restricted
        }
      }
    });
  }

  // Prefer direct Service Worker requests. This avoids opening a temporary x.com tab.
  async function fetchTwitterTimelineDirect(username: string, limit: number, onlyOriginal: boolean, cursor: string): Promise<{ success: boolean; error?: string; tweetData?: unknown; userData?: unknown } | null> {
    try {
      const [ct0Cookie, authCookie] = await Promise.all([
        chrome.cookies.get({ url: 'https://x.com', name: 'ct0' }).then(value => value || chrome.cookies.get({ url: 'https://twitter.com', name: 'ct0' })),
        chrome.cookies.get({ url: 'https://x.com', name: 'auth_token' }).then(value => value || chrome.cookies.get({ url: 'https://twitter.com', name: 'auth_token' })),
      ]);
      if (!ct0Cookie?.value || !authCookie?.value) return null;
      const headers: Record<string, string> = {
        Accept: '*/*',
        Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
        'x-csrf-token': ct0Cookie.value,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-client-language': 'zh-cn',
      };
      const endpoint = (operation: string, variables: Record<string, unknown>, features: Record<string, unknown>, fieldToggles: Record<string, unknown>) => {
        return `https://x.com/i/api/graphql/${operation}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}&fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`;
      };
      const userFeatures = {
        hidden_profile_subscriptions_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        subscriptions_verification_info_is_identity_verified_enabled: true,
        subscriptions_verification_info_verified_since_enabled: true,
        highlights_tweets_tab_ui_enabled: true,
        responsive_web_twitter_article_notes_tab_enabled: true,
        subscriptions_feature_can_gift_premium: true,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_timeline_navigation_enabled: true,
      };
      const userFieldToggles = { withPayments: false, withAuxiliaryUserLabels: false };
      const tweetFeatures = {
        rweb_video_screen_enabled: true,
        rweb_cashtags_enabled: true,
        profile_label_improvements_pcf_label_in_post_enabled: true,
        responsive_web_profile_redirect_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        verified_phone_label_enabled: false,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_timeline_navigation_enabled: true,
        premium_content_api_read_enabled: false,
        communities_web_enable_tweet_community_results_fetch: true,
        c9s_tweet_anatomy_moderator_badge_enabled: true,
        responsive_web_grok_analyze_button_fetch_trends_enabled: false,
        responsive_web_grok_analyze_post_followups_enabled: false,
        rweb_cashtags_composer_attachment_enabled: true,
        responsive_web_jetfuel_frame: false,
        responsive_web_grok_share_attachment_enabled: true,
        responsive_web_grok_annotations_enabled: false,
        articles_preview_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        rweb_conversational_replies_downvote_enabled: true,
        graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
        view_counts_everywhere_api_enabled: true,
        longform_notetweets_consumption_enabled: true,
        responsive_web_twitter_article_tweet_consumption_enabled: true,
        content_disclosure_indicator_enabled: true,
        content_disclosure_ai_generated_indicator_enabled: true,
        responsive_web_grok_show_grok_translated_post: false,
        responsive_web_grok_analysis_button_from_backend: false,
        post_ctas_fetch_enabled: true,
        freedom_of_speech_not_reach_fetch_enabled: true,
        standardized_nudges_misinfo: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        responsive_web_grok_image_annotation_enabled: false,
        responsive_web_grok_imagine_annotation_enabled: false,
        responsive_web_grok_community_note_auto_translation_is_enabled: false,
        responsive_web_enhance_cards_enabled: false,
      };
      const tweetFieldToggles = {
        withPayments: false,
        withAuxiliaryUserLabels: false,
        withArticleRichContentState: false,
        withArticlePlainText: false,
        withArticleSummaryText: false,
        withArticleVoiceOver: false,
        withGrokAnalyze: false,
        withDisallowedReplyControls: false,
      };
      const userController = new AbortController();
      const userTimer = setTimeout(() => userController.abort(), 8_000);
      let userResponse: Response;
      try {
        userResponse = await fetch(endpoint('Gb-d6r0vxPOADdG62OEBpQ/UserByScreenName', {
          screen_name: username,
          withSafetyModeUserFields: true,
        }, userFeatures, userFieldToggles), { headers, credentials: 'include', signal: userController.signal });
      } finally {
        clearTimeout(userTimer);
      }
      if (!userResponse.ok) return { success: false, error: `查询推特用户 @${username} 失败 (HTTP ${userResponse.status})` };
      const userData: unknown = await userResponse.json();
      if (!userData || typeof userData !== 'object' || !('data' in userData)) return { success: false, error: '推特用户接口返回数据格式异常' };
      const userResult = userData.data;
      if (!userResult || typeof userResult !== 'object' || !('user' in userResult)) return { success: false, error: `未在推特找到该用户 (@${username})，请核对用户名是否正确。` };
      const userNode = userResult.user;
      if (!userNode || typeof userNode !== 'object' || !('result' in userNode)) return { success: false, error: `未在推特找到该用户 (@${username})，请核对用户名是否正确。` };
      const resultNode = userNode.result;
      if (!resultNode || typeof resultNode !== 'object' || !('rest_id' in resultNode) || typeof resultNode.rest_id !== 'string') return { success: false, error: `未在推特找到该用户 (@${username})，请核对用户名是否正确。` };
      const variables: Record<string, unknown> = {
        userId: resultNode.rest_id,
        count: onlyOriginal ? Math.min(Math.max(limit * 3, 25), 45) : limit,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        withV2Timeline: true,
      };
      if (cursor) variables.cursor = cursor;
      const tweetController = new AbortController();
      const tweetTimer = setTimeout(() => tweetController.abort(), 8_000);
      let tweetResponse: Response;
      try {
        tweetResponse = await fetch(endpoint('eviprbEPLvNG88V3smUngQ/UserTweets', variables, tweetFeatures, tweetFieldToggles), { headers, credentials: 'include', signal: tweetController.signal });
      } finally {
        clearTimeout(tweetTimer);
      }
      if (!tweetResponse.ok) return { success: false, error: `获取推特动态失败 (HTTP ${tweetResponse.status})` };
      return { success: true, tweetData: await tweetResponse.json(), userData };
    } catch (error: unknown) {
      console.warn('[Background] Direct Twitter request failed; trying tab fallback:', error);
      return null;
    }
  }

  // Fallback uses an existing x.com tab, or a temporary tab when direct cookies are unavailable.
  async function fetchTwitterTimelineViaTabOrSession(
    username: string,
    limit: number,
    onlyOriginal: boolean = false,
    cursor: string = ''
  ) {
    if (!chrome.tabs || !chrome.scripting) {
      return { success: false, error: 'Background 缺少 tabs 或 scripting 权限' };
    }

    let targetTabId: number | null = null;
    let isTempTab = false;

    try {
      const allTabs = await chrome.tabs.query({}).catch(() => []);
      const existingTab = allTabs.find(t =>
        t.id &&
        t.url &&
        (t.url.includes('x.com') || t.url.includes('twitter.com')) &&
        !t.url.includes('/i/flow/login')
      );

      if (existingTab && existingTab.id) {
        targetTabId = existingTab.id;
      } else {
        // Create an inactive background tab so the user is not disrupted
        const tempTab = await chrome.tabs.create({
          url: 'https://x.com/?ref=cfh_sync',
          active: false,
        });
        targetTabId = tempTab.id || null;
        isTempTab = true;

        // Wait up to 4.5s for tab to initialize
        await new Promise<void>((resolve) => {
          let done = false;
          const timer = setTimeout(() => {
            if (!done) {
              done = true;
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve();
            }
          }, 4500);

          function onUpdated(tabId: number, info: chrome.tabs.TabChangeInfo) {
            if (tabId === tempTab.id && (info.status === 'complete' || info.title)) {
              if (!done) {
                done = true;
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(onUpdated);
                setTimeout(resolve, 500);
              }
            }
          }
          chrome.tabs.onUpdated.addListener(onUpdated);
        });
      }

      if (!targetTabId) {
        return {
          success: false,
          error: '未能连接推特标签页。请先在浏览器中新建标签页打开 x.com 并确认已登录。',
        };
      }

      const tabResult = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: async (user: string, count: number, onlyOrig: boolean, cur: string) => {
          try {
            // Read ct0 from document.cookie
            const ct0Match = document.cookie.match(/(?:^|;\s*)ct0=([a-zA-Z0-9_-]+)/);
            const ct0 = ct0Match ? ct0Match[1] : '';
            if (!ct0) {
              return {
                success: false,
                error: '推特页面中未检测到登录凭据 (ct0)。请确认当前浏览器已在 x.com 登录。',
              };
            }

            const headers: Record<string, string> = {
              Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
              'x-csrf-token': ct0,
              'x-twitter-active-user': 'yes',
              'x-twitter-auth-type': 'OAuth2Session',
              'x-twitter-client-language': 'zh-cn',
              Accept: '*/*',
            };

            // 1. UserByScreenName
            const userOp = 'Gb-d6r0vxPOADdG62OEBpQ/UserByScreenName';
            const userVars = JSON.stringify({ screen_name: user, withSafetyModeUserFields: true });
            const userFt = JSON.stringify({
              hidden_profile_subscriptions_enabled: true,
              rweb_tipjar_consumption_enabled: true,
              responsive_web_graphql_exclude_directive_enabled: true,
              verified_phone_label_enabled: false,
              subscriptions_verification_info_is_identity_verified_enabled: true,
              subscriptions_verification_info_verified_since_enabled: true,
              highlights_tweets_tab_ui_enabled: true,
              responsive_web_twitter_article_notes_tab_enabled: true,
              subscriptions_feature_can_gift_premium: true,
              creator_subscriptions_tweet_preview_api_enabled: true,
              responsive_web_graphql_timeline_navigation_enabled: true,
            });
            const userFieldToggles = JSON.stringify({
              withPayments: false,
              withAuxiliaryUserLabels: false,
            });

            const userResp = await fetch(
              `/i/api/graphql/${userOp}?variables=${encodeURIComponent(userVars)}&features=${encodeURIComponent(userFt)}&fieldToggles=${encodeURIComponent(userFieldToggles)}`,
              { headers, credentials: 'include' }
            );

            if (!userResp.ok) {
              if (userResp.status === 429) {
                return { success: false, error: '推特用户查询接口频率受限 (HTTP 429)。请稍等 2~5 分钟冷却后再试。' };
              }
              return { success: false, error: `查询推特用户 @${user} 失败 (HTTP ${userResp.status})` };
            }

            const userData = await userResp.json();
            const restId = userData?.data?.user?.result?.rest_id;
            if (!restId) {
              return { success: false, error: `未在推特找到该用户 (@${user})，请核对用户名是否正确。` };
            }

            // 2. UserTweets
            const tweetOp = 'eviprbEPLvNG88V3smUngQ/UserTweets';
            // Sample wider window if onlyOriginal requested so retweets do not squeeze out originals
            const sampleCount = onlyOrig ? Math.min(Math.max(count * 3, 25), 45) : (count || 15);
            const tweetVarsObj: Record<string, any> = {
              userId: restId,
              count: sampleCount,
              includePromotedContent: false,
              withQuickPromoteEligibilityTweetFields: true,
              withVoice: true,
              withV2Timeline: true,
            };
            if (cur && cur.trim()) {
              tweetVarsObj.cursor = cur.trim();
            }
            const tweetVars = JSON.stringify(tweetVarsObj);
            const tweetFt = JSON.stringify({
              rweb_video_screen_enabled: true,
              rweb_cashtags_enabled: true,
              profile_label_improvements_pcf_label_in_post_enabled: true,
              responsive_web_profile_redirect_enabled: true,
              rweb_tipjar_consumption_enabled: true,
              verified_phone_label_enabled: false,
              creator_subscriptions_tweet_preview_api_enabled: true,
              responsive_web_graphql_timeline_navigation_enabled: true,
              premium_content_api_read_enabled: false,
              communities_web_enable_tweet_community_results_fetch: true,
              c9s_tweet_anatomy_moderator_badge_enabled: true,
              responsive_web_grok_analyze_button_fetch_trends_enabled: false,
              responsive_web_grok_analyze_post_followups_enabled: false,
              rweb_cashtags_composer_attachment_enabled: true,
              responsive_web_jetfuel_frame: false,
              responsive_web_grok_share_attachment_enabled: true,
              responsive_web_grok_annotations_enabled: false,
              articles_preview_enabled: true,
              responsive_web_edit_tweet_api_enabled: true,
              rweb_conversational_replies_downvote_enabled: true,
              graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
              view_counts_everywhere_api_enabled: true,
              longform_notetweets_consumption_enabled: true,
              responsive_web_twitter_article_tweet_consumption_enabled: true,
              content_disclosure_indicator_enabled: true,
              content_disclosure_ai_generated_indicator_enabled: true,
              responsive_web_grok_show_grok_translated_post: false,
              responsive_web_grok_analysis_button_from_backend: false,
              post_ctas_fetch_enabled: true,
              freedom_of_speech_not_reach_fetch_enabled: true,
              standardized_nudges_misinfo: true,
              tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
              longform_notetweets_rich_text_read_enabled: true,
              longform_notetweets_inline_media_enabled: true,
              responsive_web_grok_image_annotation_enabled: false,
              responsive_web_grok_imagine_annotation_enabled: false,
              responsive_web_grok_community_note_auto_translation_is_enabled: false,
              responsive_web_enhance_cards_enabled: false,
            });
            const tweetFieldToggles = JSON.stringify({
              withPayments: false,
              withAuxiliaryUserLabels: false,
              withArticleRichContentState: false,
              withArticlePlainText: false,
              withArticleSummaryText: false,
              withArticleVoiceOver: false,
              withGrokAnalyze: false,
              withDisallowedReplyControls: false,
            });

            let tweetResp = await fetch(
              `/i/api/graphql/${tweetOp}?variables=${encodeURIComponent(tweetVars)}&features=${encodeURIComponent(tweetFt)}&fieldToggles=${encodeURIComponent(tweetFieldToggles)}`,
              { headers, credentials: 'include' }
            );

            if (!tweetResp.ok) {
              if (tweetResp.status === 429) {
                return { success: false, error: '推特动态接口频率受限 (HTTP 429)。请等待 2~5 分钟冷却后再试。' };
              }
              return { success: false, error: `获取推文动态失败 (HTTP ${tweetResp.status})` };
            }

            let tweetData = await tweetResp.json();

            // Check if instructions are empty, if so, fallback to UserTweetsAndReplies
            const instructions =
              tweetData?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
              tweetData?.data?.user?.result?.timeline?.timeline?.instructions ||
              [];
            const hasTweetEntries = instructions.some(
              (inst: any) =>
                (inst.type === 'TimelineAddEntries' && inst.entries?.some((e: any) => e.entryId?.startsWith('tweet-'))) ||
                inst.type === 'TimelinePinEntry'
            );

            if (!hasTweetEntries) {
              try {
                const replyOp = 'qUpkZU6eN8MbtQb7rC_pYg/UserTweetsAndReplies';
                const replyResp = await fetch(
                  `/i/api/graphql/${replyOp}?variables=${encodeURIComponent(tweetVars)}&features=${encodeURIComponent(tweetFt)}&fieldToggles=${encodeURIComponent(tweetFieldToggles)}`,
                  { headers, credentials: 'include' }
                );
                if (replyResp.ok) {
                  const replyData = await replyResp.json();
                  const replyInst =
                    replyData?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
                    replyData?.data?.user?.result?.timeline?.timeline?.instructions ||
                    [];
                  if (replyInst.some((inst: any) => inst.type === 'TimelineAddEntries' && inst.entries?.length > 0)) {
                    tweetData = replyData;
                  }
                }
              } catch {}
            }

            // Extract bottom pagination cursor if present
            let bottomCursor: string | undefined;
            const finalInstructions =
              tweetData?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
              tweetData?.data?.user?.result?.timeline?.timeline?.instructions ||
              [];
            for (const inst of finalInstructions) {
              if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
                for (const entry of inst.entries) {
                  const entryId = entry.entryId || '';
                  if (
                    entryId.startsWith('cursor-bottom-') ||
                    entry.content?.cursorType === 'Bottom' ||
                    entry.content?.entryType === 'TimelineTimelineCursor'
                  ) {
                    bottomCursor = entry.content?.value || entry.content?.itemContent?.value;
                  }
                }
              }
            }

            return { success: true, tweetData, userData, bottomCursor };
          } catch (scriptErr: any) {
            return { success: false, error: scriptErr?.message || '推特标签页执行脚本异常' };
          }
        },
        args: [username, limit, Boolean(onlyOriginal), cursor || ''],
      });

      const res = tabResult?.[0]?.result;
      return res || { success: false, error: '推特标签页未返回有效数据' };
    } finally {
      // Clean up temporary tab if created
      if (isTempTab && targetTabId) {
        try {
          await chrome.tabs.remove(targetTabId);
        } catch {}
      }
    }
  }
});

async function setupDeclarativeNetRules() {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.updateDynamicRules) return;
  try {
    const rules: chrome.declarativeNetRequest.Rule[] = [
      // 1. Weibo Sinaimg Hotlink Bypass: rewrite Referer to https://weibo.com/
      {
        id: 1001,
        priority: 1,
        action: {
          type: 'modifyHeaders' as any,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as any,
              value: 'https://weibo.com/',
            },
          ],
        },
        condition: {
          urlFilter: '*sinaimg.cn*',
          resourceTypes: ['image', 'media', 'xmlhttprequest', 'sub_frame'] as any,
        },
      },
      // 2. Pixiv Pximg Hotlink Bypass: rewrite Referer to https://www.pixiv.net/
      {
        id: 1002,
        priority: 1,
        action: {
          type: 'modifyHeaders' as any,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as any,
              value: 'https://www.pixiv.net/',
            },
          ],
        },
        condition: {
          urlFilter: '*pximg.net*',
          resourceTypes: ['image', 'media', 'xmlhttprequest', 'sub_frame'] as any,
        },
      },
      // 3. Upgrade http to https for sinaimg
      {
        id: 1003,
        priority: 1,
        action: {
          type: 'upgradeScheme' as any,
        },
        condition: {
          urlFilter: 'http://*.sinaimg.cn/*',
          resourceTypes: ['image', 'media', 'xmlhttprequest', 'sub_frame'] as any,
        },
      },
      // 4. Xiaohongshu xhscdn.com Hotlink Bypass: rewrite Referer & Origin to https://www.xiaohongshu.com/
      {
        id: 1004,
        priority: 1,
        action: {
          type: 'modifyHeaders' as any,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as any,
              value: 'https://www.xiaohongshu.com/',
            },
            {
              header: 'Origin',
              operation: 'set' as any,
              value: 'https://www.xiaohongshu.com',
            },
          ],
        },
        condition: {
          urlFilter: '*xhscdn.com*',
          resourceTypes: ['image', 'media', 'xmlhttprequest', 'sub_frame'] as any,
        },
      },
      // 5. Xiaohongshu image subdomains Hotlink Bypass
      {
        id: 1005,
        priority: 1,
        action: {
          type: 'modifyHeaders' as any,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as any,
              value: 'https://www.xiaohongshu.com/',
            },
            {
              header: 'Origin',
              operation: 'set' as any,
              value: 'https://www.xiaohongshu.com',
            },
          ],
        },
        condition: {
          urlFilter: '*xiaohongshu.com*',
          resourceTypes: ['image', 'media', 'xmlhttprequest', 'sub_frame'] as any,
        },
      },
      // 6. Xiaohongshu xhscdn.net Hotlink Bypass
      {
        id: 1006,
        priority: 1,
        action: {
          type: 'modifyHeaders' as any,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as any,
              value: 'https://www.xiaohongshu.com/',
            },
            {
              header: 'Origin',
              operation: 'set' as any,
              value: 'https://www.xiaohongshu.com',
            },
          ],
        },
        condition: {
          urlFilter: '*xhscdn.net*',
          resourceTypes: ['image', 'media', 'xmlhttprequest', 'sub_frame'] as any,
        },
      },
    ];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001, 1002, 1003, 1004, 1005, 1006],
      addRules: rules,
    });
    console.log('[Creator Feed Hub] declarativeNetRequest rules initialized');
  } catch (e) {
    console.warn('[Creator Feed Hub] Failed to set declarativeNetRequest rules:', e);
  }
}
