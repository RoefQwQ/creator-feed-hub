// Compatibility entry: platform adapter registration & lookup.
// Real implementation lives in src/platform/registry.ts.
export {
  getAdapter,
  registerAdapter,
} from '../platform/registry';
export type {
  FetchOptions,
  FetchResult,
  PlatformAdapter,
} from './types';
// Sync orchestration (implementation in src/sync/) was historically exported
// from this module; re-export to keep existing imports working.
export {
  clearStaleUpdatingStatus,
  updateChannel,
  interleaveChannelsByPlatform,
  batchUpdateChannelsInterleaved,
  updateCreator,
  fetchChannelHistory,
  type DeepSyncOptions,
  deepSyncChannel,
} from '../sync';
