/**
 * Normalize a media/image URL so it is always an absolute, loadable https URL.
 * Also normalizes known CDN hotlink-sensitive domains to more permissive aliases.
 *
 * Bilibili (and other CDNs) frequently return protocol-relative URLs such as
 * "//i0.hdslb.com/bfs/face/...". Inside a chrome-extension:// page, a bare
 * "//host/path" resolves against the extension scheme (chrome-extension://host/...)
 * and the image breaks. Force an explicit https: scheme, and upgrade any legacy
 * http:// URL as well.
 *
 * Non-http(s) schemes (data:, blob:, relative paths) are returned unchanged.
 */
export function toSecureMediaUrl(url?: string | null): string {
  if (!url) return '';
  let trimmed = url.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) {
    trimmed = `https:${trimmed}`;
  } else if (/^http:\/\//i.test(trimmed)) {
    trimmed = trimmed.replace(/^http:/i, 'https:');
  }

  // Xiaohongshu permanent direct CDN URL normalization:
  // Xiaohongshu web SSR embeds temporary expiring URLs with format:
  //   https://sns-webpic-qc.xhscdn.com/{timestamp}/{hash}/{fileId}!{suffix}
  // These expiring URLs return 403 after ~24h. Moreover, replacing the domain to sns-img-qc
  // while keeping the /{timestamp}/{hash}/ prefix results in 404.
  // The permanent, non-expiring URL accepted by Xiaohongshu's image CDN (sns-img-qc and ci.xiaohongshu.com)
  // is directly: https://sns-img-qc.xhscdn.com/{fileId} (without timestamp/hash).
  if (
    trimmed.includes('xhscdn.com') ||
    trimmed.includes('xhscdn.net') ||
    trimmed.includes('xiaohongshu.com')
  ) {
    // 1. Check if avatar
    if (trimmed.includes('/avatar/')) {
      const m = trimmed.match(/\/avatar\/[a-zA-Z0-9_\-\.]+/);
      if (m) {
        return `https://sns-avatar-qc.xhscdn.com${m[0]}`;
      }
    }

    // 2. Note cover or note image: extract fileId from the last path segment
    try {
      const u = new URL(trimmed);
      const path = u.pathname;
      // Extract the last path segment, e.g. "1040g0083228pocsrnk3g5on69nl7ojc1fp8g5do!nc_n_nwebp_prv_1"
      const lastSegment = path.substring(path.lastIndexOf('/') + 1);
      // Strip format suffix (!...) and query params
      const fileId = lastSegment.split('!')[0].split('?')[0];

      // A valid Xiaohongshu fileId is typically a 1040... key or a 24~40 hex/alphanumeric string
      if (fileId && fileId.length >= 10 && !/^\d{10,14}$/.test(fileId)) {
        return `https://sns-img-qc.xhscdn.com/${fileId}`;
      }
    } catch {}

    // Fallback: replace legacy subdomains if URL didn't match standard path
    trimmed = trimmed.replace(/sns-webpic(-qc|-bd|-hw)?\.xhscdn\.com/g, 'sns-img-qc.xhscdn.com');
  }

  return trimmed;
}

// In-memory cache for base64 / blob URLs proxied via background
const imageProxyCache = new Map<string, string>();
const pendingProxyFetches = new Map<string, Promise<string | null>>();

/**
 * Fetch an image through the background service worker using extension host permissions
 * and custom Referer / Origin headers, returning a base64 data URL.
 */
export async function proxyImage(url: string): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const secureUrl = toSecureMediaUrl(url);

  // Check cache first
  if (imageProxyCache.has(secureUrl)) {
    return imageProxyCache.get(secureUrl)!;
  }
  if (imageProxyCache.has(url)) {
    return imageProxyCache.get(url)!;
  }

  // Deduplicate in-flight requests for the same image
  if (pendingProxyFetches.has(secureUrl)) {
    return pendingProxyFetches.get(secureUrl)!;
  }

  const fetchPromise = (async () => {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        // First attempt with secureUrl
        let resp = await new Promise<{ ok: boolean; dataUrl?: string; error?: string }>((resolve) => {
          chrome.runtime.sendMessage({ type: 'PROXY_IMAGE', url: secureUrl }, (res) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(res || { ok: false });
            }
          });
        });

        // If first attempt failed and original url is different, try original url as fallback
        if (!resp?.ok && secureUrl !== url) {
          resp = await new Promise<{ ok: boolean; dataUrl?: string; error?: string }>((resolve) => {
            chrome.runtime.sendMessage({ type: 'PROXY_IMAGE', url }, (res) => {
              if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(res || { ok: false });
              }
            });
          });
        }

        if (resp?.ok && resp.dataUrl) {
          imageProxyCache.set(secureUrl, resp.dataUrl);
          imageProxyCache.set(url, resp.dataUrl);
          return resp.dataUrl;
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      pendingProxyFetches.delete(secureUrl);
    }
  })();

  pendingProxyFetches.set(secureUrl, fetchPromise);
  return fetchPromise;
}

