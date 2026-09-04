export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  data: string;
  error?: string;
}

/**
 * Universal cross-origin fetch for Chrome Extension MV3.
 * Delegates to Background Service Worker to completely bypass CORS restrictions.
 */
export async function bgFetch(url: string, options: RequestInit = {}): Promise<HttpResponse> {
  // Convert headers if passed as Headers instance
  let headersObj: Record<string, string> = {};
  if (options.headers) {
    if (options.headers instanceof Headers) {
      options.headers.forEach((v, k) => {
        headersObj[k] = v;
      });
    } else if (Array.isArray(options.headers)) {
      options.headers.forEach(([k, v]) => {
        headersObj[k] = v;
      });
    } else {
      headersObj = { ...(options.headers as Record<string, string>) };
    }
  }

  // 1. Try delegating to Background Service Worker (CORS-exempt)
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const resp = await new Promise<HttpResponse | null>((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: 'BG_FETCH',
            url,
            options: {
              method: options.method || 'GET',
              headers: headersObj,
              credentials: options.credentials || 'include',
            },
          },
          (res) => {
            if (chrome.runtime.lastError) {
              console.warn('[bgFetch] runtime.lastError:', chrome.runtime.lastError.message);
              resolve(null);
            } else {
              resolve(res);
            }
          }
        );
      });

      if (resp && typeof resp.ok === 'boolean') {
        return resp;
      }
    } catch (e) {
      console.warn('[bgFetch] Delegate failed, fallback to direct:', e);
    }
  }

  // 2. Direct fetch fallback
  try {
    const res = await fetch(url, options);
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      data: text,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      data: '',
      error: err.message || '网络请求失败 (CORS或断网)',
    };
  }
}
