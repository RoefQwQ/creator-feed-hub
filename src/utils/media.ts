/**
 * Normalize a media/image URL so it is always an absolute, loadable https URL.
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
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http:/i, 'https:');
  return trimmed;
}
