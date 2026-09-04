import type { Channel, Post } from '../types';

export interface FetchOptions {
  onlyOriginal?: boolean;
  cursor?: string;
  /** Only fetch posts published after this timestamp (ms). Used for incremental sync. */
  sinceTimestamp?: number;
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
}

export interface PlatformAdapter {
  platform: string;
  fetchLatest(channel: Channel, limit?: number, options?: FetchOptions): Promise<FetchResult>;
  checkAuthStatus?(): Promise<{ loggedIn: boolean; username?: string }>;
}

