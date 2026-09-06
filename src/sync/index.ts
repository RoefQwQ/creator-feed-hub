// Compatibility re-exports for the sync orchestration layer.
// Real implementations: channelSync.ts / batchSync.ts / historySync.ts.
export {
  clearStaleUpdatingStatus,
  updateChannel,
} from './channelSync';
export {
  interleaveChannelsByPlatform,
  batchUpdateChannelsInterleaved,
  updateCreator,
} from './batchSync';
export {
  fetchChannelHistory,
  type DeepSyncOptions,
  deepSyncChannel,
} from './historySync';
