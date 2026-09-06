import Dexie, { type Table } from 'dexie';
import type { Creator, Channel, Post, AppSettings, DeletedPostRecord } from '../../types';

export class FeedDatabase extends Dexie {
  creators!: Table<Creator, string>;
  channels!: Table<Channel, string>;
  posts!: Table<Post, string>;
  settings!: Table<{ key: string; value: any }, string>;
  deletedPostIds!: Table<DeletedPostRecord, string>;

  constructor() {
    super('CreatorFeedHubDB');
    this.version(1).stores({
      creators: 'id, name, *tags, createdAt, sortOrder',
      channels: 'id, creatorId, platform, accountId, status, lastCheckAt',
      posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked',
      settings: 'key',
    });
    // Version 2: Add compound index [channelId+publishedAt] for blazing fast channel queries & watermark checks
    this.version(2).stores({
      posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked, [channelId+publishedAt]',
    });
    // Version 3: Add deletedPostIds store to record tombstoned post IDs
    this.version(3).stores({
      deletedPostIds: 'id, channelId, creatorId, deletedAt',
    });
  }
}

export const db = new FeedDatabase();
