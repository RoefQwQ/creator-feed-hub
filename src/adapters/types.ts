import type { Channel, Post } from '../types';

export interface FetchOptions {
  onlyOriginal?: boolean;
  cursor?: string;
  /** Set to true when digging older historical posts */
  isHistory?: boolean;
  /** Only fetch posts published after this timestamp (ms). Used for incremental sync. */
  sinceTimestamp?: number;
  /** If true, include previously deleted posts and clear their tombstone records upon fetch */
  restoreDeleted?: boolean;
  /** If true, ignore sinceTimestamp watermark to force-refresh and update existing posts in local DB */
  forceRefresh?: boolean;
}

export interface FetchResult {
  posts: Post[];
  authorMeta?: {
    name?: string;
    avatar?: string;
  };
  nextCursor?: string;
  hasMore?: boolean;
  error?: string;
  /** Total raw posts returned by adapter in this batch before DB deduplication */
  totalFetched?: number;
}

export interface PlatformAdapter {
  platform: string;
  fetchLatest(channel: Channel, limit?: number, options?: FetchOptions): Promise<FetchResult>;
  checkAuthStatus?(): Promise<{ loggedIn: boolean; username?: string }>;
}

