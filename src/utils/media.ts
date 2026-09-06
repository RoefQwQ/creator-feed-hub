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

  // Xiaohongshu CDN domain normalization:
  // sns-webpic-qc.xhscdn.com is strict WAF, sns-img-qc / sns-img-bd / sns-img-hw are permissive
  // Replace strict subdomains and strip expiring image query tokens that cause 403 on stale caches
  if (trimmed.includes('sns-webpic-qc.xhscdn.com')) {
    trimmed = trimmed.replace('sns-webpic-qc.xhscdn.com', 'sns-img-qc.xhscdn.com');
  } else if (trimmed.includes('sns-webpic-bd.xhscdn.com')) {
    trimmed = trimmed.replace('sns-webpic-bd.xhscdn.com', 'sns-img-bd.xhscdn.com');
  } else if (trimmed.includes('sns-webpic-hw.xhscdn.com')) {
    trimmed = trimmed.replace('sns-webpic-hw.xhscdn.com', 'sns-img-hw.xhscdn.com');
  } else if (trimmed.includes('sns-webpic.xhscdn.com')) {
    trimmed = trimmed.replace('sns-webpic.xhscdn.com', 'sns-img-qc.xhscdn.com');
  }

  // If URL has Xiaohongshu web format query with strict sign or expiring token, sanitize it
  if (trimmed.includes('.xhscdn.com/') || trimmed.includes('.xhscdn.net/')) {
    // Keep image format/dimension parameters like imageView2 or strip broken dynamic tokens
    try {
      const u = new URL(trimmed);
      // If query has note verification tokens or signatures that expired, stripping query often allows CDN direct image hit
      if (u.searchParams.has('sign') || u.searchParams.has('token') || u.searchParams.has('expire')) {
        u.searchParams.delete('sign');
        u.searchParams.delete('token');
        u.searchParams.delete('expire');
        trimmed = u.toString();
      }
    } catch {}
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

