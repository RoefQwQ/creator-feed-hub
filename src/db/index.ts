// Compatibility entry: database definitions, settings, stats & post lifecycle.
// Implementations live in src/infrastructure/db/.
export {
  FeedDatabase,
  db,
} from '../infrastructure/db/database';
export {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
} from '../infrastructure/db/settingsRepository';
export {
  getDatabaseStats,
} from '../infrastructure/db/statsService';
export {
  cleanupOldPosts,
  deletePostAndTombstone,
  restoreDeletedPost,
  restoreDeletedPostId,
  restoreDeletedPostIds,
  restoreAllDeletedPostIds,
  permanentlyDeletePost,
  getDeletedPostCount,
  getDeletedPostRecords,
  healBrokenPostMedia,
} from '../infrastructure/db/postRepository';
