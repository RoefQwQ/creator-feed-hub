// Minimal local types for the BG_FETCH runtime-message contract. They only
// describe what this handler reads / replies with — the protocol shape itself
// is unchanged (see src/utils/http.ts bgFetch() for the caller side).
interface BgFetchMessage {
  type: 'BG_FETCH';
  url?: string;
  options?: {
    method?: string;
    headers?: Record<string, string>;
    credentials?: RequestCredentials;
  };
}

type SendResponse = (response?: unknown) => void;

/** Error-message extraction mirroring `err?.message || 'Background fetch error'`. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || 'Background fetch error';
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = err.message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Background fetch error';
}

/**
 * Handles BG_FETCH messages: performs a CORS-exempt cross-origin fetch from
 * the background service worker, attaching Bilibili login/device cookies
 * (sent automatically via credentials: 'include') and auto-injecting the
 * Rplay Referer / Origin / platform-type headers plus the stored auth token.
 *
 * Responses:
 *  - `{ ok, status, statusText, data }` mirroring the fetch result
 *  - `{ ok: false, status: 0, data: '', error }` for unexpected failures
 *
 * Returns `true` so the runtime message channel stays open until the async
 * sendResponse fires — callers MUST return this value from the listener.
 */
export function handleBgFetch(message: BgFetchMessage, sendResponse: SendResponse): boolean {
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
              if (typeof stored.rplay_auth_token === 'string') {
                headers['Authorization'] = stored.rplay_auth_token;
              }
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
    } catch (err) {
      console.error('[Background] Fetch error:', err);
      sendResponse({
        ok: false,
        status: 0,
        data: '',
        error: errorMessage(err),
      });
    }
  })();
  return true; // Keep message channel open for async response
}
