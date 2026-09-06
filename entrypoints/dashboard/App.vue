<script setup lang="ts">
import { ref, shallowRef, onMounted, onUnmounted, computed, watch, nextTick } from 'vue';
import {
  db,
  getSettings,
  saveSettings,
  getDatabaseStats,
  cleanupOldPosts,
  deletePostAndTombstone,
  restoreDeletedPost,
  restoreDeletedPostId,
  restoreDeletedPostIds,
  restoreAllDeletedPostIds,
  permanentlyDeletePost,
  getDeletedPostCount,
  getDeletedPostRecords,
  healBrokenPostMedia
} from '../../src/db';
import {
  PLATFORM_REGISTRY,
  type Platform,
  type Creator,
  type Channel,
  type Post,
  type AppSettings,
  type DeletedPostRecord
} from '../../src/types';
import {
  updateChannel,
  updateCreator,
  clearStaleUpdatingStatus,
  fetchChannelHistory,
  deepSyncChannel,
  batchUpdateChannelsInterleaved
} from '../../src/adapters';
import { parseProfileUrl } from '../../src/utils/urlParser';
import { toSecureMediaUrl } from '../../src/utils/media';
import {
  RefreshCw,
  Plus,
  Settings,
  Users,
  LayoutGrid,
  ExternalLink,
  Search,
  CheckCircle2,
  AlertCircle,
  Clock,
  Trash2,
  Download,
  Upload,
  Moon,
  Sun,
  Image as ImageIcon,
  Film,
  Sparkles,
  Bookmark,
  Share2,
  Filter,
  Eye,
  EyeOff,
  Link,
  ChevronRight,
  X,
  Maximize2,
  SlidersHorizontal,
  ShieldCheck,
  ChevronDown,
  Rss,
  Tag,
  Layers,
  Key,
  Repeat2,
  History,
  FolderDown,
  CheckSquare,
  Square,
  Calendar,
  ArrowUpDown,
  Play,
  StopCircle,
  Edit3,
  ImageOff,
  Camera,
  RotateCcw
} from 'lucide-vue-next';
import PostCard from './components/PostCard.vue';
import MediaLightbox from './components/MediaLightbox.vue';
import ImageCacheSettings from './components/ImageCacheSettings.vue';

// State
const activeTab = ref<'feed' | 'creators' | 'bookmarks' | 'settings'>('feed');
const creators = ref<Creator[]>([]);
const channels = ref<Channel[]>([]);
const posts = shallowRef<Post[]>([]);
const dbStats = ref<{
  creatorsCount: number;
  channelsCount: number;
  totalPostsCount: number;
  bookmarkedPostsCount: number;
  storageUsageBytes: number;
  storageQuotaBytes: number;
}>({
  creatorsCount: 0,
  channelsCount: 0,
  totalPostsCount: 0,
  bookmarkedPostsCount: 0,
  storageUsageBytes: 0,
  storageQuotaBytes: 0,
});
const settings = ref<AppSettings>({
  theme: 'system',
  itemsPerFetch: 10,
  requestDelayMs: 600,
  enableR18Blur: true,
  autoOpenOriginalUrl: false,
});

// UI Controls
const searchQuery = ref('');
const selectedPlatform = ref<string>('all');
const selectedTag = ref<string>('all'); // Legacy backward compatibility
const includeTags = ref<Set<string>>(new Set());
const excludeTags = ref<Set<string>>(new Set());
const isRefreshingAll = ref(false);
const refreshProgress = ref({ current: 0, total: 0 });
const isDarkMode = ref(false);

// Deleted posts (tombstones) state & Sync dropdown
const deletedPostCount = ref(0);
const deletedPostsList = ref<DeletedPostRecord[]>([]);
const showDeletedPostsModal = ref(false);
const deletedPostsSearchQuery = ref('');
const showSyncMenu = ref(false);

const filteredDeletedPostsList = computed(() => {
  const q = deletedPostsSearchQuery.value.trim().toLowerCase();
  if (!q) return deletedPostsList.value;
  return deletedPostsList.value.filter(item => {
    return (
      (item.title && item.title.toLowerCase().includes(q)) ||
      (item.id && item.id.toLowerCase().includes(q)) ||
      (item.platform && item.platform.toLowerCase().includes(q))
    );
  });
});

// Bookmarks view controls
const bookmarkSearchQuery = ref('');
const bookmarkSelectedPlatform = ref<string>('all');

// Creator tags quick editor modal state
const editingTagCreator = ref<Creator | null>(null);
const editingTagInput = ref('');

// Hidden creators & platform sub-filters
const hiddenCreatorIds = ref<Set<string>>(new Set());
const hiddenCreatorPlatforms = ref<Record<string, string[]>>({});
const creatorMap = computed(() => new Map(creators.value.map(creator => [creator.id, creator])));


try {
  const savedHidden = localStorage.getItem('creator_feed_hidden_creators');
  if (savedHidden) {
    hiddenCreatorIds.value = new Set(JSON.parse(savedHidden));
  }
  const savedPlatforms = localStorage.getItem('creator_feed_hidden_platforms');
  if (savedPlatforms) {
    hiddenCreatorPlatforms.value = JSON.parse(savedPlatforms);
  }
} catch {}

function toggleHideCreator(creatorId: string) {
  if (hiddenCreatorIds.value.has(creatorId)) {
    hiddenCreatorIds.value.delete(creatorId);
  } else {
    hiddenCreatorIds.value.add(creatorId);
  }
  hiddenCreatorIds.value = new Set(hiddenCreatorIds.value);
  try {
    localStorage.setItem('creator_feed_hidden_creators', JSON.stringify(Array.from(hiddenCreatorIds.value)));
  } catch {}
}

function toggleHideCreatorPlatform(creatorId: string, platformKey: string) {
  const current = hiddenCreatorPlatforms.value[creatorId] ? [...hiddenCreatorPlatforms.value[creatorId]] : [];
  const idx = current.indexOf(platformKey);
  if (idx !== -1) {
    current.splice(idx, 1);
  } else {
    current.push(platformKey);
  }
  hiddenCreatorPlatforms.value = {
    ...hiddenCreatorPlatforms.value,
    [creatorId]: current,
  };
  try {
    localStorage.setItem('creator_feed_hidden_platforms', JSON.stringify(hiddenCreatorPlatforms.value));
  } catch {}
}

function unhideAllCreators() {
  hiddenCreatorIds.value = new Set();
  try {
    localStorage.removeItem('creator_feed_hidden_creators');
  } catch {}
}

function getCreatorPlatforms(creatorId: string): string[] {
  const chs = channels.value.filter(ch => ch.creatorId === creatorId);
  const platforms = new Set<string>();
  chs.forEach(ch => platforms.add(ch.platform));
  return Array.from(platforms);
}

function resetCreatorHiddenPlatforms(creatorId: string) {
  if (hiddenCreatorPlatforms.value[creatorId]) {
    const updated = { ...hiddenCreatorPlatforms.value };
    delete updated[creatorId];
    hiddenCreatorPlatforms.value = updated;
    try {
      localStorage.setItem('creator_feed_hidden_platforms', JSON.stringify(hiddenCreatorPlatforms.value));
    } catch {}
  }
}

const failedAvatarUrls = ref<Set<string>>(new Set());

function handleAvatarError(url?: string) {
  if (url) {
    failedAvatarUrls.value.add(url);
    failedAvatarUrls.value = new Set(failedAvatarUrls.value);
  }
}

function getCreatorAvatar(c?: Creator | null): string {
  if (!c) return '';
  if (c.avatar && c.avatar.trim().length > 0 && !failedAvatarUrls.value.has(c.avatar)) {
    return toSecureMediaUrl(c.avatar);
  }
  // Fallback 1: check channels of this creator
  const ch = channels.value.find(
    ch => ch.creatorId === c.id && ch.avatarUrl && ch.avatarUrl.trim().length > 0 && !failedAvatarUrls.value.has(ch.avatarUrl)
  );
  if (ch?.avatarUrl) {
    if (!c.avatar) {
      c.avatar = ch.avatarUrl;
      db.creators.update(c.id, { avatar: ch.avatarUrl }).catch(() => {});
    }
    return toSecureMediaUrl(ch.avatarUrl);
  }
  // Fallback 2: check posts of this creator
  const p = posts.value.find(
    p => p.creatorId === c.id && p.authorMeta?.avatar && p.authorMeta.avatar.trim().length > 0 && !failedAvatarUrls.value.has(p.authorMeta.avatar)
  );
  if (p?.authorMeta?.avatar) {
    if (!c.avatar) {
      c.avatar = p.authorMeta.avatar;
      db.creators.update(c.id, { avatar: p.authorMeta.avatar }).catch(() => {});
    }
    return toSecureMediaUrl(p.authorMeta.avatar);
  }
  return '';
}

function getPostAuthorAvatar(post: Post): string {
  const creator = creators.value.find(c => c.id === post.creatorId);
  if (creator) {
    const a = getCreatorAvatar(creator);
    if (a) return a;
  }
  if (post.authorMeta?.avatar && !failedAvatarUrls.value.has(post.authorMeta.avatar)) {
    return toSecureMediaUrl(post.authorMeta.avatar);
  }
  const ch = channels.value.find(c => c.id === post.channelId);
  if (ch?.avatarUrl && !failedAvatarUrls.value.has(ch.avatarUrl)) {
    return toSecureMediaUrl(ch.avatarUrl);
  }
  return '';
}

// Right sidebar creator inline accordion state
const expandedCreatorIds = ref<Set<string>>(new Set());

function toggleExpandCreator(creatorId: string) {
  if (expandedCreatorIds.value.has(creatorId)) {
    expandedCreatorIds.value.delete(creatorId);
  } else {
    expandedCreatorIds.value.add(creatorId);
  }
  expandedCreatorIds.value = new Set(expandedCreatorIds.value);
}

// Pagination & Infinite Scroll to keep DOM lightweight while pre-rendering smoothly
const PAGE_SIZE = 36;
const visibleCount = ref(PAGE_SIZE);
const infiniteScrollTrigger = ref<HTMLElement | null>(null);
let scrollObserver: IntersectionObserver | null = null;
const isFetchingHistory = ref<Record<string, boolean>>({});

function setupScrollObserver() {
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return;

  scrollObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (entry && entry.isIntersecting) {
        if (visibleCount.value < filteredPosts.value.length) {
          visibleCount.value += PAGE_SIZE;
        }
      }
    },
    { rootMargin: '900px 0px' }
  );

  if (infiniteScrollTrigger.value) {
    scrollObserver.observe(infiniteScrollTrigger.value);
  }
}

watch(infiniteScrollTrigger, (el) => {
  if (el && scrollObserver) {
    scrollObserver.observe(el);
  }
});

watch(activeTab, (newTab) => {
  if (newTab === 'feed' || newTab === 'bookmarks') {
    nextTick(setupScrollObserver);
  }
});

onMounted(() => window.addEventListener('keydown', handleGlobalShortcut));
onUnmounted(() => window.removeEventListener('keydown', handleGlobalShortcut));

// Lightbox
const lightboxMedia = ref<{ url: string; originalUrl?: string; type: string; title?: string } | null>(null);

// Modals
const showAddModal = ref(false);
const addModalMode = ref<'new' | 'channel'>('new');
const targetCreatorForChannel = ref<Creator | null>(null);
const inputUrl = ref('');
const inputName = ref('');
const inputTags = ref('');
const inputCreatorId = ref('');
const inputRole = ref<'main' | 'sub' | 'alt' | 'custom'>('main');
const inputCustomLabel = ref('');
const isSubmittingAdd = ref(false);

// Platform login detector status
const platformLoginStatus = ref<Record<string, boolean>>({});
const currentRplayToken = ref<string>('');
const hideReposts = ref(false);
const hideTextOnly = ref(false);

watch(activeTab, async (newTab) => {
  if (newTab === 'settings') {
    deletedPostsList.value = await getDeletedPostRecords();
    await refreshDeletedCount();
  }
});

onMounted(async () => {
  // Clear any hanging updating status from previous reloads/crashes so icons don't spin perpetually
  await clearStaleUpdatingStatus();
  await reloadData();
  settings.value = await getSettings();
  hideReposts.value = Boolean(settings.value.hideReposts);
  hideTextOnly.value = Boolean(settings.value.hideTextOnly);

  // Load existing Rplay token if available
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const stored = await chrome.storage.local.get('rplay_auth_token');
    if (stored?.rplay_auth_token) {
      currentRplayToken.value = stored.rplay_auth_token;
    }
  }

  // Explicitly default to comfortable daytime (light) mode
  const savedTheme = localStorage.getItem('creator_feed_theme');
  if (savedTheme === 'dark') {
    isDarkMode.value = true;
    document.documentElement.classList.add('dark');
  } else {
    isDarkMode.value = false;
    document.documentElement.classList.remove('dark');
  }

  // Keydown listener for Lightbox ESC
  window.addEventListener('keydown', handleKeydown);

  // Setup infinite scroll observer
  setupScrollObserver();

  // Resize listener for responsive waterfall layout
  window.addEventListener('resize', handleResizeForWaterfall);

  // Check login states
  await checkPlatformLogins();
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('resize', handleResizeForWaterfall);
  if (scrollObserver) {
    scrollObserver.disconnect();
  }
});

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && lightboxMedia.value) {
    lightboxMedia.value = null;
  }
}

async function reloadData() {
  try {
    // Auto-heal broken CDN image URLs for Xiaohongshu and other platforms in local IndexedDB
    await healBrokenPostMedia();
  } catch {}

  creators.value = await db.creators.toArray();
  channels.value = await db.channels.toArray();
  posts.value = await db.posts.orderBy('publishedAt').reverse().toArray();
  // Refresh storage statistics
  try {
    dbStats.value = await getDatabaseStats();
  } catch {}
  await refreshDeletedCount();
  deletedPostsList.value = await getDeletedPostRecords();
}

const isHealingMedia = ref(false);
async function handleHealBrokenMedia() {
  if (isHealingMedia.value) return;
  isHealingMedia.value = true;
  try {
    const healed = await healBrokenPostMedia();
    await reloadData();
    if (healed > 0) {
      alert(`【小红书图裂修复完成】成功修复并重写了本地数据库中 ${healed} 条动态的媒体链接！`);
    } else {
      alert(`【检测完成】本地所有小红书动态与图片的 CDN 地址均已为最新兼容格式。`);
    }
  } catch (err: any) {
    alert('修复异常: ' + (err?.message || err));
  } finally {
    isHealingMedia.value = false;
  }
}

async function refreshDeletedCount() {
  try {
    deletedPostCount.value = await getDeletedPostCount();
  } catch {
    deletedPostCount.value = 0;
  }
}

async function handleDeletePost(post: Post) {
  const snippet = post.title || (post.content ? post.content.slice(0, 35) : '该动态');
  if (!confirm(`确定要删除此条动态吗？\n\n“${snippet}”\n\n提示：该动态ID将记录到本地数据库黑名单中。后续点击“同步全部”默认不会重新拉取此动态；您可在设置或同步选项中随时查看与恢复。`)) {
    return;
  }
  await deletePostAndTombstone(post);
  posts.value = posts.value.filter(p => p.id !== post.id);
  await refreshDeletedCount();
}

async function openDeletedPostsModal() {
  deletedPostsList.value = await getDeletedPostRecords();
  await refreshDeletedCount();
  deletedPostsSearchQuery.value = '';
  showDeletedPostsModal.value = true;
}

async function handleRestoreSingleDeleted(record: DeletedPostRecord) {
  const restoredPost = await restoreDeletedPost(record.id);
  deletedPostsList.value = deletedPostsList.value.filter(r => r.id !== record.id);
  await reloadData();
  await refreshDeletedCount();
  if (restoredPost) {
    alert(`【动态已定向找回】\n已将动态“${restoredPost.title || '该作品'}”直接还原到动态列表中！`);
  } else {
    const ch = channels.value.find(c => c.id === record.channelId);
    if (ch) {
      await updateChannel(ch, settings.value.itemsPerFetch, true, { restoreDeleted: true });
      await reloadData();
    }
    alert(`【动态已定向找回】已解除过滤并重新拉取该动态！`);
  }
}

async function handleRestoreAllAndSync() {
  if (deletedPostCount.value === 0) return;
  if (!confirm(`确定要将回收站中全部 ${deletedPostCount.value} 条已删除动态定向找回并还原到动态列表中吗？`)) return;
  await restoreAllDeletedPostIds();
  await reloadData();
  await refreshDeletedCount();
  deletedPostsList.value = [];
  showDeletedPostsModal.value = false;
  await handleRefreshAll(true);
  alert(`【全部找回完成】回收站动态已全部恢复并还原至动态流！`);
}

async function handlePermanentlyDelete(record: DeletedPostRecord) {
  if (!confirm(`确定要从回收站彻底删除该记录吗？彻底删除后将无法在此定向找回。`)) return;
  await permanentlyDeletePost(record.id);
  deletedPostsList.value = deletedPostsList.value.filter(r => r.id !== record.id);
  await refreshDeletedCount();
}

async function handleEmptyRecycleBin() {
  if (deletedPostCount.value === 0) return;
  if (!confirm(`确定要彻底清空回收站中全部 ${deletedPostCount.value} 条记录吗？清空后将无法在此定向找回。`)) return;
  await db.deletedPostIds.clear();
  deletedPostsList.value = [];
  await refreshDeletedCount();
  alert('回收站已彻底清空。');
}

const isCleaningStorage = ref(false);
async function handleCleanupPosts(days: number) {
  const daysText = days === 0 ? '所有未收藏的动态' : `${days} 天前的未收藏历史动态`;
  if (!confirm(`确定要清理 ${daysText} 吗？\n\n提示：带有 ⭐ 收藏标记的动态将被永久保留，绝不会被删除。`)) {
    return;
  }

  isCleaningStorage.value = true;
  try {
    const deletedCount = await cleanupOldPosts(days);
    await reloadData();
    alert(`【存储空间已释放】成功清理了 ${deletedCount} 条历史动态！`);
  } catch (err: any) {
    alert('清理失败: ' + (err?.message || err));
  } finally {
    isCleaningStorage.value = false;
  }
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function toggleDarkMode() {
  isDarkMode.value = !isDarkMode.value;
  if (isDarkMode.value) {
    document.documentElement.classList.add('dark');
    localStorage.setItem('creator_feed_theme', 'dark');
  } else {
    document.documentElement.classList.remove('dark');
    localStorage.setItem('creator_feed_theme', 'light');
  }
}

// All available tags
const allTags = computed(() => {
  const set = new Set<string>();
  creators.value.forEach(c => c.tags?.forEach(t => set.add(t)));
  return Array.from(set);
});

// Repost/Retweet detector & filter helper
function isRepostPost(p: Post): boolean {
  if (p.isRepost !== undefined) return p.isRepost;
  // Fallback signatures for existing database posts
  if (p.platform === 'twitter') {
    if (p.content?.startsWith('[转推') || p.title?.includes('的转推') || p.content?.startsWith('RT @')) return true;
  }
  if (p.platform === 'bilibili') {
    if (p.content?.includes('//转发自') || p.content?.startsWith('//@') || p.title?.includes('转发动态')) return true;
  }
  return false;
}

const repostsCount = computed(() => {
  return posts.value.filter(isRepostPost).length;
});

async function toggleHideReposts() {
  hideReposts.value = !hideReposts.value;
  settings.value.hideReposts = hideReposts.value;
  await saveSettings({ hideReposts: hideReposts.value });
}

// Text-only post detector & filter helper (posts with no images, videos or audio)
function isTextOnlyPost(p: Post): boolean {
  return !p.mediaList || p.mediaList.length === 0;
}

const textOnlyCount = computed(() => {
  return posts.value.filter(isTextOnlyPost).length;
});

async function toggleHideTextOnly() {
  hideTextOnly.value = !hideTextOnly.value;
  settings.value.hideTextOnly = hideTextOnly.value;
  await saveSettings({ hideTextOnly: hideTextOnly.value });
}

// Tag filtering tri-state helpers (neutral -> include -> exclude -> neutral)
function cycleTagFilter(t: string) {
  if (includeTags.value.has(t)) {
    // Switch from include (+) to exclude (-)
    includeTags.value.delete(t);
    excludeTags.value.add(t);
  } else if (excludeTags.value.has(t)) {
    // Switch from exclude (-) to neutral (off)
    excludeTags.value.delete(t);
  } else {
    // Switch from neutral to include (+)
    includeTags.value.add(t);
  }
  includeTags.value = new Set(includeTags.value);
  excludeTags.value = new Set(excludeTags.value);
}

function clearAllTagFilters() {
  includeTags.value = new Set();
  excludeTags.value = new Set();
  selectedTag.value = 'all';
}

function getTagFilterState(t: string): 'include' | 'exclude' | 'none' {
  if (includeTags.value.has(t)) return 'include';
  if (excludeTags.value.has(t)) return 'exclude';
  return 'none';
}

// Bookmarking action
async function toggleBookmarkPost(post: Post) {
  const nextState = !post.isBookmarked;
  post.isBookmarked = nextState;
  try {
    await db.posts.update(post.id, { isBookmarked: nextState });
    // Update dbStats count reactively
    if (dbStats.value) {
      dbStats.value.bookmarkedPostsCount = (dbStats.value.bookmarkedPostsCount || 0) + (nextState ? 1 : -1);
    }
  } catch (err) {
    console.error('Failed to toggle post bookmark', err);
    post.isBookmarked = !nextState; // rollback on failure
  }
}

async function markPostRead(post: Post) {
  if (post.isRead) return;
  post.isRead = true;
  await db.posts.update(post.id, { isRead: true });
}

function handleGlobalShortcut(event: KeyboardEvent) {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName)) return;
  if (event.key.toLowerCase() === 'r' && activeTab.value === 'feed' && !isRefreshingAll.value) {
    event.preventDefault();
    handleRefreshAll();
  }
}


// Filtered Bookmarked Posts for Bookmarks View
const filteredBookmarkedPosts = computed(() => {
  return posts.value.filter(p => {
    if (!p.isBookmarked) return false;
    // Platform filter
    if (bookmarkSelectedPlatform.value !== 'all' && p.platform !== bookmarkSelectedPlatform.value) {
      return false;
    }
    // Text-only filter (hide posts without media)
    if (hideTextOnly.value && isTextOnlyPost(p)) {
      return false;
    }
    // Search query
    if (bookmarkSearchQuery.value.trim()) {
      const q = bookmarkSearchQuery.value.toLowerCase();
      const matchText = (p.title || '').toLowerCase().includes(q) || p.content.toLowerCase().includes(q);
      const creator = creatorMap.value.get(p.creatorId);
      const matchAuthor = creator?.name.toLowerCase().includes(q);
      if (!matchText && !matchAuthor) return false;
    }
    return true;
  });
});

// Visible creators under currently selected platform and tag filter
const visibleCreatorsForFilter = computed(() => {
  return creators.value.filter(c => {
    const cTags = c.tags || [];
    // 1. Exclude tags check (if creator has ANY tag in excludeTags, hide)
    if (excludeTags.value.size > 0) {
      if (cTags.some(t => excludeTags.value.has(t))) return false;
    }
    // 2. Include tags check (creator must match at least one tag in includeTags)
    if (includeTags.value.size > 0) {
      if (!cTags.some(t => includeTags.value.has(t))) return false;
    }
    // 3. Platform filter
    if (selectedPlatform.value !== 'all') {
      const hasPlatformChannel = channels.value.some(
        ch => ch.creatorId === c.id && ch.platform === selectedPlatform.value
      );
      if (!hasPlatformChannel) return false;
    }
    return true;
  });
});

// Count of hidden creators currently visible in filter
const hiddenCreatorsInFilterCount = computed(() => {
  return visibleCreatorsForFilter.value.filter(c => hiddenCreatorIds.value.has(c.id)).length;
});

// Post count map per platform for left sidebar badge
const platformPostCounts = computed(() => {
  const counts: Record<string, number> = { all: posts.value.length };
  for (const p of posts.value) {
    counts[p.platform] = (counts[p.platform] || 0) + 1;
  }
  return counts;
});

// Filtered posts
const filteredPosts = computed(() => {
  return posts.value.filter(p => {
    // 1. Check if creator is completely hidden
    if (hiddenCreatorIds.value.has(p.creatorId)) {
      return false;
    }

    // 2. Check if this specific platform of this creator is hidden (ONLY active when in "all platforms" view)
    if (selectedPlatform.value === 'all') {
      const hiddenPlatforms = hiddenCreatorPlatforms.value[p.creatorId];
      if (hiddenPlatforms && hiddenPlatforms.includes(p.platform)) {
        return false;
      }
    }

    // Repost filter
    if (hideReposts.value && isRepostPost(p)) {
      return false;
    }
    // Text-only filter (hide posts without media)
    if (hideTextOnly.value && isTextOnlyPost(p)) {
      return false;
    }
    // Platform filter
    if (selectedPlatform.value !== 'all' && p.platform !== selectedPlatform.value) {
      return false;
    }
    // Tag filter (positive inclusion & negative exclusion)
    const creator = creatorMap.value.get(p.creatorId);
    const cTags = creator?.tags || [];
    if (excludeTags.value.size > 0) {
      if (cTags.some(t => excludeTags.value.has(t))) {
        return false;
      }
    }
    if (includeTags.value.size > 0) {
      if (!cTags.some(t => includeTags.value.has(t))) {
        return false;
      }
    }
    // Search query
    if (searchQuery.value.trim()) {
      const q = searchQuery.value.toLowerCase();
      const matchText = (p.title || '').toLowerCase().includes(q) || p.content.toLowerCase().includes(q);
      const matchAuthor = creator?.name.toLowerCase().includes(q);
      if (!matchText && !matchAuthor) return false;
    }
    return true;
  });
});

// Paginated view for lightweight rendering
const paginatedPosts = computed(() => {
  return filteredPosts.value.slice(0, visibleCount.value);
});

function loadMore() {
  visibleCount.value += PAGE_SIZE;
}

// ===== Masonry Waterfall Layout: Height-Balanced Column Distribution =====
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1200);
const columnCount = computed(() => {
  if (windowWidth.value < 768) return 1;   // mobile: single column
  if (windowWidth.value < 1280) return 2;  // tablet: 2 columns
  return 3;                                 // desktop: 3 columns
});

function handleResizeForWaterfall() {
  windowWidth.value = window.innerWidth;
}

/**
 * Estimate the card render height in virtual units based on title, content length, and media count.
 * This guarantees that tall posts (like long single-image photo shoots) don't create deep voids in adjacent columns.
 */
function estimatePostHeight(p: Post): number {
  let h = 90; // Header avatar + meta info + padding
  if (p.title) h += 28;
  if (p.content) {
    const lines = Math.min(Math.ceil(p.content.length / 32), 4);
    h += lines * 18;
  }
  if (p.mediaList?.length) {
    if (p.mediaList.length === 1) {
      h += p.mediaList[0].type === 'video' ? 210 : 320;
    } else if (p.mediaList.length === 2) {
      h += 220;
    } else {
      h += 260;
    }
  }
  h += 40; // Footer timestamp + direct link bar
  return h;
}

// Distribute posts into columns using greedy shortest-column balancing for Feed waterfall
const feedColumns = computed(() => {
  const count = columnCount.value;
  const cols: Post[][] = Array.from({ length: count }, () => []);
  const colHeights = new Array(count).fill(0);

  paginatedPosts.value.forEach((post) => {
    // Find the current shortest column
    let minCol = 0;
    for (let c = 1; c < count; c++) {
      if (colHeights[c] < colHeights[minCol]) {
        minCol = c;
      }
    }
    cols[minCol].push(post);
    colHeights[minCol] += estimatePostHeight(post) + 20; // 20px gap
  });

  return cols;
});

// Distribute posts into columns using greedy shortest-column balancing for Bookmarks waterfall
const bookmarkColumns = computed(() => {
  const count = columnCount.value;
  const cols: Post[][] = Array.from({ length: count }, () => []);
  const colHeights = new Array(count).fill(0);

  filteredBookmarkedPosts.value.forEach((post) => {
    let minCol = 0;
    for (let c = 1; c < count; c++) {
      if (colHeights[c] < colHeights[minCol]) {
        minCol = c;
      }
    }
    cols[minCol].push(post);
    colHeights[minCol] += estimatePostHeight(post) + 20;
  });

  return cols;
});

// Refresh all channels using multi-round interleaved round-robin pacing across platforms
async function handleRefreshAll(restoreDeleted: boolean = false) {
  if (isRefreshingAll.value || channels.value.length === 0) return;
  isRefreshingAll.value = true;
  refreshProgress.value = { current: 0, total: channels.value.length };

  try {
    const minDelay = Math.max(settings.value.requestDelayMs || 600, 800);
    await batchUpdateChannelsInterleaved(
      channels.value,
      settings.value.itemsPerFetch,
      {
        onlyOriginal: hideReposts.value,
        minPlatformIntervalMs: minDelay,
        restoreDeleted,
        onProgress: (current, total) => {
          refreshProgress.value = { current, total };
        },
      }
    );
    await reloadData();
  } catch (err) {
    console.error('Refresh all error', err);
  } finally {
    isRefreshingAll.value = false;
    await clearStaleUpdatingStatus();
    await reloadData();
  }
}

// Refresh single creator
async function handleRefreshCreator(creatorId: string) {
  const creator = creators.value.find(c => c.id === creatorId);
  const chs = channels.value.filter(ch => ch.creatorId === creatorId);
  if (chs.length === 0) {
    alert('该创作者暂未绑定任何平台账号，请先点击【追加新账号】添加。');
    return;
  }
  const results = await updateCreator(creatorId, settings.value.itemsPerFetch, { onlyOriginal: hideReposts.value });
  await reloadData();
  const safeResults = Array.isArray(results) ? results : [];
  const totalPosts = safeResults.reduce((acc, r) => acc + (r.posts?.length || 0), 0);
  const errors = safeResults.filter(r => r.error).map(r => r.error);
  if (errors.length > 0 && totalPosts === 0) {
    alert(`【同步提示 - ${creator?.name || '创作者'}】\n${errors.join('\n')}`);
  } else {
    alert(`【同步完成】已成功获取到 ${totalPosts} 条作品/动态！`);
  }
}

// Refresh single channel (with optional forceRefresh to update existing posts)
async function handleRefreshChannel(channel: Channel, forceRefresh: boolean = false) {
  // Prevent rapid spam-clicks (8s cooldown check unless forceRefresh)
  if (!forceRefresh && channel.lastCheckAt && Date.now() - channel.lastCheckAt < 8_000) {
    alert('【操作过于频繁】该账号在 8 秒内刚执行过同步。为保护账号免受平台限流，请稍等片刻后再试。');
    return;
  }
  const fetchLimit = forceRefresh ? 100 : settings.value.itemsPerFetch;
  const res = await updateChannel(channel, fetchLimit, true, {
    onlyOriginal: hideReposts.value,
    forceRefresh,
  });
  await reloadData();
  if (res.error) {
    alert(`【同步未成功】${channel.displayName || channel.accountId}：\n${res.error}`);
  } else if (res.posts && res.posts.length > 0) {
    alert(`【同步成功】已获取并更新 ${channel.displayName || channel.accountId} 的 ${res.posts.length} 条作品/动态！`);
  } else {
    alert(`【同步完成】连接平台成功，但 ${channel.displayName || channel.accountId} 近期暂无公开发布的内容。`);
  }
}

// Deep History: Fetch older posts for a single channel using cursor
async function handleFetchChannelHistory(channel: Channel) {
  if (isFetchingHistory.value[channel.id] || channel.status === 'updating') return;
  isFetchingHistory.value[channel.id] = true;

  try {
    const res = await fetchChannelHistory(channel, settings.value.itemsPerFetch, hideReposts.value);
    await reloadData();
    if (res.error) {
      alert(`【深挖历史提示 - ${channel.displayName || channel.accountId}】\n\n${res.error}`);
    } else if (res.posts && res.posts.length > 0) {
      alert(`【深挖成功】已成功回溯获取到 ${channel.displayName || channel.accountId} 的 ${res.posts.length} 条更早历史作品！`);
    } else {
      alert(`【深挖完成】已抓取完毕或已到达该账号历史作品的最深处。`);
    }
  } catch (err: any) {
    alert('深挖更早历史异常: ' + (err?.message || err));
  } finally {
    isFetchingHistory.value[channel.id] = false;
    await reloadData();
  }
}

// Deep History: Fetch older posts for all channels of a creator
async function handleFetchCreatorHistory(creatorId: string) {
  const creator = creators.value.find(c => c.id === creatorId);
  const chs = channels.value.filter(ch => ch.creatorId === creatorId);
  if (chs.length === 0) {
    alert('该创作者暂未绑定任何平台账号。');
    return;
  }

  let totalNew = 0;
  for (const ch of chs) {
    isFetchingHistory.value[ch.id] = true;
    try {
      const res = await fetchChannelHistory(ch, settings.value.itemsPerFetch, hideReposts.value);
      totalNew += res.posts?.length || 0;
      await new Promise(r => setTimeout(r, 800));
    } catch {} finally {
      isFetchingHistory.value[ch.id] = false;
    }
  }
  await reloadData();
  if (totalNew > 0) {
    alert(`【历史深挖完成】已为【${creator?.name || '创作者'}】回溯抓取到 ${totalNew} 条更早历史动态！`);
  } else {
    alert(`【历史深挖完成】已到达该创作者各平台当前游标下的历史尽头。`);
  }
}

// ==================== CREATORS DIRECTORY FILTER & SORT & BATCH STATE ====================
const creatorSearch = ref('');
const creatorPlatformFilter = ref('all');
const creatorTagFilter = ref('all');
const creatorSortBy = ref<'updated' | 'channels' | 'posts' | 'name'>('updated');
const isBatchMode = ref(false);
const selectedCreatorIds = ref<Set<string>>(new Set());
const avatarPickerCreator = ref<Creator | null>(null);

function openAvatarPicker(creator: Creator) {
  avatarPickerCreator.value = creator;
}

async function selectPrimaryAvatar(creator: Creator, url: string) {
  const avatar = toSecureMediaUrl(url);
  await db.creators.update(creator.id, { avatar, primaryAvatarUrl: avatar, updatedAt: Date.now() });
  creator.avatar = avatar;
  creator.primaryAvatarUrl = avatar;
  avatarPickerCreator.value = null;
}

// Post count map per creator
const creatorPostCountMap = computed(() => {
  const map: Record<string, number> = {};
  for (const p of posts.value) {
    map[p.creatorId] = (map[p.creatorId] || 0) + 1;
  }
  return map;
});

// Platform count map per creator
const creatorChannelMap = computed(() => {
  const map: Record<string, Channel[]> = {};
  for (const ch of channels.value) {
    if (!map[ch.creatorId]) map[ch.creatorId] = [];
    map[ch.creatorId].push(ch);
  }
  return map;
});

// Platform distribution among creators for filter pill badges
const creatorCountByPlatform = computed(() => {
  const counts: Record<string, number> = { all: creators.value.length };
  for (const c of creators.value) {
    const chs = channels.value.filter(ch => ch.creatorId === c.id);
    const platforms = new Set(chs.map(ch => ch.platform));
    platforms.forEach(p => {
      counts[p] = (counts[p] || 0) + 1;
    });
  }
  return counts;
});

// Filtered and sorted creators list for Directory tab
const filteredCreatorsList = computed(() => {
  let list = [...creators.value];

  // 1. Search filter (matches creator name, tag, or channel account/displayName)
  if (creatorSearch.value.trim()) {
    const q = creatorSearch.value.trim().toLowerCase();
    list = list.filter(c => {
      const matchName = (c.name || '').toLowerCase().includes(q);
      const matchTag = c.tags?.some(t => t.toLowerCase().includes(q));
      const matchCh = channels.value.some(
        ch => ch.creatorId === c.id && ((ch.displayName || '').toLowerCase().includes(q) || ch.accountId.toLowerCase().includes(q))
      );
      return matchName || matchTag || matchCh;
    });
  }

  // 2. Platform filter
  if (creatorPlatformFilter.value !== 'all') {
    list = list.filter(c => {
      return channels.value.some(ch => ch.creatorId === c.id && ch.platform === creatorPlatformFilter.value);
    });
  }

  // 3. Tag filter (positive inclusion & negative exclusion)
  if (excludeTags.value.size > 0) {
    list = list.filter(c => {
      const cTags = c.tags || [];
      return !cTags.some(t => excludeTags.value.has(t));
    });
  }
  if (includeTags.value.size > 0) {
    list = list.filter(c => {
      const cTags = c.tags || [];
      return cTags.some(t => includeTags.value.has(t));
    });
  }
  if (creatorTagFilter.value !== 'all') {
    list = list.filter(c => c.tags?.includes(creatorTagFilter.value));
  }

  // 4. Sorting
  list.sort((a, b) => {
    if (creatorSortBy.value === 'channels') {
      const countA = (creatorChannelMap.value[a.id] || []).length;
      const countB = (creatorChannelMap.value[b.id] || []).length;
      return countB - countA;
    }
    if (creatorSortBy.value === 'posts') {
      const countA = creatorPostCountMap.value[a.id] || 0;
      const countB = creatorPostCountMap.value[b.id] || 0;
      return countB - countA;
    }
    if (creatorSortBy.value === 'name') {
      return (a.name || '').localeCompare(b.name || '');
    }
    // 'updated': latest channel lastCheckAt or creator updatedAt
    const timeA = Math.max(a.updatedAt || 0, ...(creatorChannelMap.value[a.id] || []).map(ch => ch.lastCheckAt || 0));
    const timeB = Math.max(b.updatedAt || 0, ...(creatorChannelMap.value[b.id] || []).map(ch => ch.lastCheckAt || 0));
    return timeB - timeA;
  });

  return list;
});

function toggleSelectCreator(id: string) {
  if (selectedCreatorIds.value.has(id)) {
    selectedCreatorIds.value.delete(id);
  } else {
    selectedCreatorIds.value.add(id);
  }
  selectedCreatorIds.value = new Set(selectedCreatorIds.value);
}

function selectAllFilteredCreators() {
  const set = new Set<string>();
  filteredCreatorsList.value.forEach(c => set.add(c.id));
  selectedCreatorIds.value = set;
}

function clearCreatorSelection() {
  selectedCreatorIds.value = new Set();
  isBatchMode.value = false;
}

async function batchRefreshSelectedCreators() {
  const ids = Array.from(selectedCreatorIds.value);
  if (ids.length === 0) return;
  for (const id of ids) {
    await handleRefreshCreator(id);
    await new Promise(r => setTimeout(r, 600));
  }
  alert(`【批量同步完成】已成功同步选中的 ${ids.length} 位创作者动态！`);
}

async function batchDeleteSelectedCreators() {
  const ids = Array.from(selectedCreatorIds.value);
  if (ids.length === 0) return;
  if (!confirm(`确定要批量移除选中的 ${ids.length} 位创作者档案及其全部绑定账号与已缓存作品吗？`)) {
    return;
  }
  for (const id of ids) {
    await db.creators.delete(id);
    const chs = await db.channels.where('creatorId').equals(id).toArray();
    for (const ch of chs) {
      await db.posts.where('channelId').equals(ch.id).delete();
      await db.channels.delete(ch.id);
    }
  }
  selectedCreatorIds.value = new Set();
  isBatchMode.value = false;
  await reloadData();
  alert('批量删除完成。');
}

// Quick creator tags editor
const editingTagsList = ref<string[]>([]);
const newTagInput = ref('');

function openEditCreatorTags(creator: Creator) {
  editingTagCreator.value = creator;
  editingTagsList.value = [...(creator.tags || [])];
  newTagInput.value = '';
}

function addTagToEditingList(t?: string) {
  const raw = (t !== undefined ? t : newTagInput.value).trim().replace(/^#/, '');
  if (!raw) return;
  const splitTags = raw.split(/[,，\s]+/).filter(Boolean);
  for (const tag of splitTags) {
    const cleanTag = tag.trim().replace(/^#/, '');
    if (cleanTag && !editingTagsList.value.includes(cleanTag)) {
      editingTagsList.value.push(cleanTag);
    }
  }
  if (t === undefined) {
    newTagInput.value = '';
  }
}

function removeTagFromEditingList(tagToRemove: string) {
  editingTagsList.value = editingTagsList.value.filter(t => t !== tagToRemove);
}

function toggleTagInEditingList(tag: string) {
  if (editingTagsList.value.includes(tag)) {
    removeTagFromEditingList(tag);
  } else {
    editingTagsList.value.push(tag);
  }
}

async function saveCreatorTags() {
  if (!editingTagCreator.value) return;
  
  // If user typed something in newTagInput without pressing enter or clicking add, include it
  if (newTagInput.value.trim()) {
    addTagToEditingList();
  }

  const c = editingTagCreator.value;
  const newTags = [...editingTagsList.value];
  c.tags = newTags;
  c.updatedAt = Date.now();

  try {
    await db.creators.update(c.id, {
      tags: newTags,
      updatedAt: c.updatedAt,
    });
    await reloadData();
    editingTagCreator.value = null;
    editingTagsList.value = [];
    newTagInput.value = '';
  } catch (err: any) {
    alert('修改标签失败: ' + (err?.message || err));
  }
}

// Global tag management: Delete a tag from all creators in the library
async function deleteGlobalTag(tagToDelete: string) {
  if (!confirm(`确定要从系统全库中移除标签【#${tagToDelete}】吗？\n所有包含该标签的创作者都将自动取消此标签关联。`)) {
    return;
  }
  try {
    const allCreators = await db.creators.toArray();
    for (const c of allCreators) {
      if (c.tags && c.tags.includes(tagToDelete)) {
        const updatedTags = c.tags.filter(t => t !== tagToDelete);
        await db.creators.update(c.id, { tags: updatedTags, updatedAt: Date.now() });
      }
    }
    // Remove from active filters if selected
    includeTags.value.delete(tagToDelete);
    excludeTags.value.delete(tagToDelete);
    includeTags.value = new Set(includeTags.value);
    excludeTags.value = new Set(excludeTags.value);
    removeTagFromEditingList(tagToDelete);
    await reloadData();
  } catch (err: any) {
    alert('移除标签失败: ' + (err?.message || err));
  }
}

// ==================== DEEP SYNC MODAL STATE & HANDLERS ====================
const deepSyncTargetCreator = ref<Creator | null>(null);
const deepSyncSelectedChannels = ref<string[]>([]);
const deepSyncMode = ref<'count' | 'time'>('count');
const deepSyncTargetCount = ref<number>(50);
const deepSyncCustomCount = ref<number>(50);
const deepSyncTimeRange = ref<number>(30); // in days: 30, 90, 180, 365, 0 (all)
const deepSyncOnlyOriginal = ref<boolean>(false);
const deepSyncResetCursor = ref<boolean>(false);
const isDeepSyncRunning = ref<boolean>(false);
const deepSyncAbortRequested = ref<boolean>(false);
const deepSyncLogs = ref<string[]>([]);
const deepSyncTotalNew = ref<number>(0);
const deepSyncCurrentStatus = ref<string>('');

function openDeepSyncModal(creator: Creator, specificChannelId?: string) {
  deepSyncTargetCreator.value = creator;
  const chs = channels.value.filter(ch => ch.creatorId === creator.id);
  if (specificChannelId) {
    deepSyncSelectedChannels.value = [specificChannelId];
  } else {
    deepSyncSelectedChannels.value = chs.map(ch => ch.id);
  }
  deepSyncMode.value = 'count';
  deepSyncTargetCount.value = 50;
  deepSyncCustomCount.value = 50;
  deepSyncTimeRange.value = 30;
  deepSyncOnlyOriginal.value = hideReposts.value;
  deepSyncResetCursor.value = false;
  isDeepSyncRunning.value = false;
  deepSyncAbortRequested.value = false;
  deepSyncLogs.value = [];
  deepSyncTotalNew.value = 0;
  deepSyncCurrentStatus.value = '';
}

function toggleDeepSyncChannel(chId: string) {
  const idx = deepSyncSelectedChannels.value.indexOf(chId);
  if (idx !== -1) {
    deepSyncSelectedChannels.value.splice(idx, 1);
  } else {
    deepSyncSelectedChannels.value.push(chId);
  }
}

async function startDeepSync() {
  if (!deepSyncTargetCreator.value || deepSyncSelectedChannels.value.length === 0) return;
  isDeepSyncRunning.value = true;
  deepSyncAbortRequested.value = false;
  deepSyncLogs.value = [];
  deepSyncTotalNew.value = 0;

  const targetChannels = channels.value.filter(ch => deepSyncSelectedChannels.value.includes(ch.id));
  const maxPostsPerChannel = deepSyncMode.value === 'count' ? deepSyncTargetCount.value : 0;
  const untilTimestamp = deepSyncMode.value === 'time' && deepSyncTimeRange.value > 0
    ? Date.now() - deepSyncTimeRange.value * 24 * 60 * 60 * 1000
    : 0;

  let grandTotal = 0;

  for (const ch of targetChannels) {
    if (deepSyncAbortRequested.value) break;

    const chName = `${PLATFORM_REGISTRY[ch.platform]?.name || ch.platform} (@${ch.displayName || ch.accountId})`;
    deepSyncCurrentStatus.value = `正在深度回溯：${chName}...`;
    deepSyncLogs.value.unshift(`[开始回溯] ${chName}`);

    const res = await deepSyncChannel(ch, {
      maxPosts: maxPostsPerChannel,
      untilTimestamp,
      onlyOriginal: deepSyncOnlyOriginal.value,
      forceResetCursor: deepSyncResetCursor.value,
      shouldStop: () => deepSyncAbortRequested.value,
      onProgress: (info) => {
        if (info.status === 'fetching' && info.fetchedThisRound > 0) {
          deepSyncLogs.value.unshift(`[${info.platform}] 第 ${info.round} 轮翻页抓取到 ${info.fetchedThisRound} 条更早动态 (累计 +${info.totalNewPosts})`);
          if (deepSyncLogs.value.length > 50) deepSyncLogs.value.pop();
        }
        if (info.error) {
          deepSyncLogs.value.unshift(`[提示] ${info.error}`);
        }
      }
    });

    grandTotal += res.totalNew;
    deepSyncTotalNew.value = grandTotal;
    deepSyncLogs.value.unshift(`[${chName}] 回溯完成，共取得 ${res.totalNew} 条更早作品${res.reachEnd ? ' (已抵达历史终点)' : ''}`);
    await reloadData();
  }

  isDeepSyncRunning.value = false;
  deepSyncCurrentStatus.value = deepSyncAbortRequested.value ? '已中止抓取' : '全部选定渠道回溯完成！';
  await reloadData();
}

function stopDeepSync() {
  deepSyncAbortRequested.value = true;
  deepSyncCurrentStatus.value = '正在安全停止当前请求...';
}


// Check platform cookies using chrome.cookies API accurately
async function checkPlatformLogins() {
  if (typeof chrome === 'undefined' || !chrome.cookies?.getAll) return;

  interface PlatformAuthCheck {
    key: string;
    domain: string;
    authCookieNames: string[];
  }

  const platformsToCheck: PlatformAuthCheck[] = [
    { key: 'bilibili', domain: 'bilibili.com', authCookieNames: ['DedeUserID', 'SESSDATA', 'bili_jct'] },
    { key: 'twitter', domain: 'x.com', authCookieNames: ['auth_token', 'ct0'] },
    { key: 'pixiv', domain: 'pixiv.net', authCookieNames: ['PHPSESSID'] },
    { key: 'fantia', domain: 'fantia.jp', authCookieNames: ['_session_id'] },
    { key: 'rplay', domain: 'rplay.live', authCookieNames: ['connect.sid', 'token', 'accessToken', 'refreshToken'] },
    { key: 'withny', domain: 'withny.fun', authCookieNames: ['withny_session', 'token', 'remember_web'] },
    { key: 'xiaohongshu', domain: 'xiaohongshu.com', authCookieNames: ['web_session', 'a1', 'webId'] },
    { key: 'weibo', domain: 'weibo.com', authCookieNames: ['SUB', 'SUBP', '_T_WM'] },
  ];

  // YouTube official RSS is publicly accessible without login
  platformLoginStatus.value['youtube'] = true;

  for (const p of platformsToCheck) {
    if (p.key === 'twitter') {
      try {
        const xCookies = await chrome.cookies.getAll({ domain: 'x.com' });
        const twCookies = await chrome.cookies.getAll({ domain: 'twitter.com' });
        const allCookies = [...xCookies, ...twCookies];
        let hasAuth = allCookies.some(c => p.authCookieNames.includes(c.name));
        if (!hasAuth && chrome.tabs) {
          const tabs = await chrome.tabs.query({ url: ['*://*.x.com/*', '*://*.twitter.com/*'] });
          if (tabs.length > 0) hasAuth = true;
        }
        platformLoginStatus.value['twitter'] = hasAuth;
      } catch {
        platformLoginStatus.value['twitter'] = false;
      }
      continue;
    }

    if (p.key === 'rplay') {
      try {
        let hasAuth = false;
        if (chrome.storage?.local) {
          const stored = await chrome.storage.local.get('rplay_auth_token');
          if (stored && stored.rplay_auth_token) {
            hasAuth = true;
            currentRplayToken.value = stored.rplay_auth_token;
          }
        }
        platformLoginStatus.value['rplay'] = hasAuth;
      } catch {
        platformLoginStatus.value['rplay'] = false;
      }
      continue;
    }

    try {
      const cookies = await chrome.cookies.getAll({ domain: p.domain });
      const hasAuth = cookies.some(c => p.authCookieNames.includes(c.name));
      platformLoginStatus.value[p.key] = hasAuth;
    } catch {
      platformLoginStatus.value[p.key] = false;
    }
  }
}

async function syncRplayFromTab() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    alert('当前运行环境不支持与扩展后台通信');
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SYNC_RPLAY_TOKEN' });
    if (res?.success && res.token) {
      platformLoginStatus.value['rplay'] = true;
      currentRplayToken.value = res.token;
      alert('【同步成功】已从当前打开的 Rplay 页面自动提取并保存有效 Token！');
    } else {
      alert(res?.error || '未能提取到 Rplay 登录凭证。请确认浏览器中已打开 rplay.live 并且处于登录状态，或者点击【手动粘贴】进行设置。');
    }
  } catch (e: any) {
    alert('同步凭证请求异常: ' + (e?.message || e));
  }
}

async function promptManualRplayToken() {
  const current = currentRplayToken.value || '';
  const input = prompt(
    '【设置 / 粘贴 Rplay 登录凭证】\n请输入或粘贴 rplay.live 的 _AUTHORIZATION_ Token（如留空则清除当前保存的凭证）：',
    current
  );
  if (input === null) return;
  const token = input.trim();
  if (token) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ rplay_auth_token: token });
    }
    platformLoginStatus.value['rplay'] = true;
    currentRplayToken.value = token;
    alert('已成功保存 Rplay Token 凭证！');
  } else {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.remove('rplay_auth_token');
    }
    platformLoginStatus.value['rplay'] = false;
    currentRplayToken.value = '';
    alert('已清除保存的 Rplay Token。');
  }
}

// Account role & multi-account grouping helpers
function getRoleLabel(role?: string, label?: string) {
  if (label) return label;
  switch (role) {
    case 'sub': return '日常小号';
    case 'alt': return '里号/差分';
    case 'custom': return '自定义频道';
    default: return '主账号';
  }
}

function getRoleBadgeClass(role?: string) {
  switch (role) {
    case 'sub': return 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/60 dark:text-sky-300 dark:border-sky-800';
    case 'alt': return 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800';
    case 'custom': return 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800';
    default: return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800';
  }
}

async function cycleChannelRole(ch: Channel) {
  const roles: Array<'main' | 'sub' | 'alt' | 'custom'> = ['main', 'sub', 'alt', 'custom'];
  const currentIndex = roles.indexOf(ch.accountRole || 'main');
  const nextRole = roles[(currentIndex + 1) % roles.length];
  ch.accountRole = nextRole;
  ch.label = getRoleLabel(nextRole);
  await db.channels.put(ch);
  await db.posts.where('channelId').equals(ch.id).modify({ channelLabel: ch.label });
  await reloadData();
}

function getCreatorGroupedChannels(creatorId: string): Record<string, Channel[]> {
  const chs = channels.value.filter(ch => ch.creatorId === creatorId);
  const map: Record<string, Channel[]> = {};
  for (const ch of chs) {
    if (!map[ch.platform]) {
      map[ch.platform] = [];
    }
    map[ch.platform].push(ch);
  }
  return map;
}

const creatorSearchQuery = ref('');
const isEditingCreatorSelection = ref(false);

const selectedCreatorObj = computed(() => {
  return creators.value.find(c => c.id === inputCreatorId.value);
});

const filteredCandidateCreators = computed(() => {
  const q = creatorSearchQuery.value.trim().toLowerCase();
  if (!q) return creators.value;
  return creators.value.filter(c => {
    const matchName = c.name.toLowerCase().includes(q);
    const matchTag = c.tags?.some(t => t.toLowerCase().includes(q));
    const matchNote = c.note?.toLowerCase().includes(q);
    const matchId = c.id.toLowerCase().includes(q);
    return matchName || matchTag || matchNote || matchId;
  });
});

const existingMatchingCreators = computed(() => {
  if (addModalMode.value !== 'new' || !inputName.value.trim()) return [];
  const q = inputName.value.trim().toLowerCase();
  return creators.value.filter(c => {
    const matchName = c.name.toLowerCase().includes(q);
    const matchTag = c.tags?.some(t => t.toLowerCase().includes(q));
    const matchNote = c.note?.toLowerCase().includes(q);
    const matchId = c.id.toLowerCase().includes(q);
    return matchName || matchTag || matchNote || matchId;
  });
});

function selectCreator(c: Creator) {
  inputCreatorId.value = c.id;
  targetCreatorForChannel.value = c;
  isEditingCreatorSelection.value = false;
  creatorSearchQuery.value = '';
}

function switchToNewCreatorWithQuery(name?: string) {
  addModalMode.value = 'new';
  if (name) inputName.value = name;
  inputCreatorId.value = '';
  targetCreatorForChannel.value = null;
}

const detectedParsedProfile = computed(() => {
  if (!inputUrl.value.trim()) return null;
  return parseProfileUrl(inputUrl.value);
});

const detectedSamePlatformAccounts = computed(() => {
  if (!inputUrl.value.trim()) return [];
  const parsed = detectedParsedProfile.value;
  if (!parsed) return [];
  const cid = addModalMode.value === 'channel'
    ? (targetCreatorForChannel.value?.id || inputCreatorId.value)
    : inputCreatorId.value;
  if (!cid) return [];
  return channels.value.filter(ch => ch.creatorId === cid && ch.platform === parsed.platform);
});

// Add channel or creator
function openAddModal(mode: 'new' | 'channel', creator?: Creator, initialUrl: string = '') {
  addModalMode.value = mode;
  targetCreatorForChannel.value = creator || null;
  inputUrl.value = initialUrl;
  inputName.value = '';
  inputTags.value = '';
  inputRole.value = mode === 'channel' ? 'sub' : 'main';
  inputCustomLabel.value = '';
  inputCreatorId.value = creator ? creator.id : (creators.value[0]?.id || '');
  isEditingCreatorSelection.value = !creator;
  creatorSearchQuery.value = '';
  showAddModal.value = true;
}

async function submitAdd() {
  if (!inputUrl.value.trim()) return;
  isSubmittingAdd.value = true;

  try {
    const parsed = parseProfileUrl(inputUrl.value);
    if (!parsed) {
      alert('无法识别该网址，请确保输入支持的创作者主页、作品链接或 RSS 源。');
      return;
    }

    let creatorId = inputCreatorId.value;

    if (addModalMode.value === 'new' || !creatorId) {
      const newCreator: Creator = {
        id: 'c_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        name: inputName.value.trim() || parsed.suggestedName || '未命名创作者',
        avatar: '',
        tags: inputTags.value.split(/[,，\s]+/).filter(Boolean),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.creators.add(newCreator);
      creatorId = newCreator.id;
    }

    const channelId = `${parsed.platform}:${parsed.accountId}`;
    const roleLabel = inputRole.value === 'custom'
      ? (inputCustomLabel.value.trim() || '自定义频道')
      : getRoleLabel(inputRole.value);

    const newChannel: Channel = {
      id: channelId,
      creatorId,
      platform: parsed.platform,
      accountId: parsed.accountId,
      displayName: parsed.suggestedName || parsed.accountId,
      profileUrl: parsed.cleanUrl,
      label: roleLabel,
      accountRole: inputRole.value,
      status: 'idle',
    };

    await db.channels.put(newChannel);

    // Initial update in background
    updateChannel(newChannel, 5).then(reloadData);

    showAddModal.value = false;
    await reloadData();
  } catch (err: any) {
    alert('添加失败: ' + err?.message);
  } finally {
    isSubmittingAdd.value = false;
  }
}

// Delete creator
async function deleteCreator(creatorId: string) {
  if (!confirm('确定要删除此博主档案吗？相关的渠道与历史动态也将一并移除。')) return;
  await db.creators.delete(creatorId);
  const chs = await db.channels.where('creatorId').equals(creatorId).toArray();
  for (const c of chs) {
    await db.channels.delete(c.id);
    await db.posts.where('channelId').equals(c.id).delete();
  }
  await reloadData();
}

// Delete channel
async function deleteChannel(channelId: string) {
  if (!confirm('确定移除此平台账号吗？')) return;
  await db.channels.delete(channelId);
  await db.posts.where('channelId').equals(channelId).delete();
  await reloadData();
}

// Export / Import Backup
async function exportBackup() {
  const data = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    creators: await db.creators.toArray(),
    channels: await db.channels.toArray(),
    settings: await getSettings(),
    posts: await db.posts.toArray(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `creator-feed-hub-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Native File System Access API: Save directly to a chosen directory/file on disk (e.g. extension project folder)
async function exportBackupToFile() {
  const data = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    creators: await db.creators.toArray(),
    channels: await db.channels.toArray(),
    settings: await getSettings(),
    posts: await db.posts.toArray(),
  };
  const jsonStr = JSON.stringify(data, null, 2);

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: `creator-feed-hub-backup-${new Date().toISOString().slice(0, 10)}.json`,
        types: [
          {
            description: 'JSON Backup File',
            accept: { 'application/json': ['.json'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(jsonStr);
      await writable.close();
      alert('已成功将完整数据备份写入至你指定的本地文件！');
      return;
    } catch (e: any) {
      if (e.name === 'AbortError') return; // User cancelled dialog
      console.warn('showSaveFilePicker error:', e);
    }
  }

  // Fallback to standard download if File System Access API is not supported
  exportBackup();
}

function handleImportFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target?.result as string);
      if (data.creators && Array.isArray(data.creators)) {
        await db.creators.bulkPut(data.creators);
      }
      if (data.channels && Array.isArray(data.channels)) {
        await db.channels.bulkPut(data.channels);
      }
      if (data.posts && Array.isArray(data.posts)) {
        await db.posts.bulkPut(data.posts);
      }
      if (data.settings) {
        await saveSettings(data.settings);
        settings.value = await getSettings();
      }
      await reloadData();
      alert('备份恢复成功！创作者档案、各平台账号及历史动态已全部恢复。');
    } catch (err: any) {
      alert('解析备份失败: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// Inject sample demo data for quick test
async function loadDemoData() {
  const demoCreator: Creator = {
    id: 'demo_alice',
    name: '爱丽丝 (演示博主)',
    avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Alice',
    tags: ['ASMR', '插画', '多账号示范'],
    note: '跨平台与同平台多账号归集样例',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const demoChannel1: Channel = {
    id: 'bilibili:1000000000',
    creatorId: 'demo_alice',
    platform: 'bilibili',
    accountId: '1000000000',
    displayName: '演示平台账号',
    profileUrl: 'https://space.bilibili.com/1000000000',
    label: '主账号',
    accountRole: 'main',
    status: 'idle',
  };

  const demoChannel2: Channel = {
    id: 'bilibili:1000000001',
    creatorId: 'demo_alice',
    platform: 'bilibili',
    accountId: '1000000001',
    displayName: '演示备用账号',
    profileUrl: 'https://space.bilibili.com/1000000001',
    label: '日常小号',
    accountRole: 'sub',
    status: 'idle',
  };

  const demoChannel3: Channel = {
    id: 'youtube:UC_DEMO_CREATOR_000000000000000',
    creatorId: 'demo_alice',
    platform: 'youtube',
    accountId: 'UC_DEMO_CREATOR_000000000000000',
    displayName: '演示视频频道',
    profileUrl: 'https://www.youtube.com/channel/UC_DEMO_CREATOR_000000000000000',
    label: '海外主频道',
    accountRole: 'main',
    status: 'idle',
  };

  await db.creators.put(demoCreator);
  await db.channels.put(demoChannel1);
  await db.channels.put(demoChannel2);
  await db.channels.put(demoChannel3);

  await reloadData();
  alert('演示博主与渠道已导入！已呈现【同平台多账号归集】与【跨平台聚合】。');
}

function formatTime(timestamp: number) {
  if (!timestamp) return '未知时间';
  const diff = Date.now() - timestamp;
  const m = 60 * 1000;
  const h = 60 * m;
  const d = 24 * h;

  if (diff < m) return '刚刚';
  if (diff < h) return `${Math.floor(diff / m)} 分钟前`;
  if (diff < d) return `${Math.floor(diff / h)} 小时前`;
  if (diff < 7 * d) return `${Math.floor(diff / d)} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}
</script>

<template>
  <div class="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100">
    <!-- Top Navigation Bar -->
    <header class="sticky top-0 z-40 bg-white/85 dark:bg-slate-900/85 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800 transition-colors">
      <div class="w-full max-w-[98%] 2xl:max-w-[96%] mx-auto px-3 sm:px-6 h-16 flex items-center justify-between">
        <!-- Logo & Title -->
        <div class="flex items-center gap-3">
          <img src="/icons/icon-48.png" class="w-9 h-9 rounded-xl shadow-md shadow-indigo-500/25 shrink-0" alt="Creator Feed Hub" />
          <div>
            <h1 class="font-black text-lg tracking-tight text-slate-900 dark:text-white flex items-center gap-2">
              Creator Feed Hub
              <span class="text-[10px] font-normal px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                轻量展台
              </span>
            </h1>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">聚合多平台创作者 · 一处浏览全部动态</p>
          </div>
        </div>

        <!-- Tab Switcher -->
        <nav class="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl">
          <button
            @click="activeTab = 'feed'"
            :class="activeTab === 'feed' ? 'bg-white dark:bg-slate-700 shadow-xs text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'"
            class="flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg transition-all cursor-pointer"
          >
            <LayoutGrid class="w-4 h-4" />
            <span>动态</span>
            <span v-if="posts.length" class="text-[10px] px-1.5 py-0.2 bg-slate-200 dark:bg-slate-600 rounded-full text-slate-700 dark:text-slate-300">
              {{ posts.length }}
            </span>
          </button>
          <button
            @click="activeTab = 'creators'"
            :class="activeTab === 'creators' ? 'bg-white dark:bg-slate-700 shadow-xs text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'"
            class="flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg transition-all cursor-pointer"
          >
            <Users class="w-4 h-4" />
            <span>关注</span>
            <span v-if="creators.length" class="text-[10px] px-1.5 py-0.2 bg-slate-200 dark:bg-slate-600 rounded-full text-slate-700 dark:text-slate-300">
              {{ creators.length }}
            </span>
          </button>
          <button
            @click="activeTab = 'bookmarks'"
            :class="activeTab === 'bookmarks' ? 'bg-white dark:bg-slate-700 shadow-xs text-amber-600 dark:text-amber-400 font-semibold' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'"
            class="flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg transition-all cursor-pointer"
          >
            <Bookmark class="w-4 h-4" :class="{ 'fill-amber-500 text-amber-500': activeTab === 'bookmarks' }" />
            <span>收藏</span>
            <span v-if="dbStats.bookmarkedPostsCount" class="text-[10px] px-1.5 py-0.2 bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 font-bold rounded-full">
              {{ dbStats.bookmarkedPostsCount }}
            </span>
          </button>
          <button
            @click="activeTab = 'settings'"
            :class="activeTab === 'settings' ? 'bg-white dark:bg-slate-700 shadow-xs text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'"
            class="flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg transition-all cursor-pointer"
          >
            <Settings class="w-4 h-4" />
            <span>设置</span>
          </button>
        </nav>

        <!-- Right Action Buttons -->
        <div class="flex items-center gap-2">
          <!-- Refresh All Button Group -->
          <div class="relative flex items-center">
            <button
              type="button"
              @click="handleRefreshAll(false)"
              :disabled="isRefreshingAll || channels.length === 0"
              class="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 transition-all cursor-pointer shadow-xs"
              :class="deletedPostCount > 0 ? 'rounded-l-xl border-r border-indigo-500/80' : 'rounded-xl'"
              title="一键同步最新动态（默认跳过已删除的动态）"
            >
              <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': isRefreshingAll }" />
              <span>{{ isRefreshingAll ? `同步中 ${refreshProgress.current}/${refreshProgress.total}` : '同步全部' }}</span>
            </button>
            <div v-if="deletedPostCount > 0" class="relative">
              <button
                type="button"
                @click="showSyncMenu = !showSyncMenu"
                :disabled="isRefreshingAll"
                class="px-2 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-r-xl shadow-xs cursor-pointer transition-colors flex items-center"
                title="同步选项与已删除动态管理"
              >
                <ChevronDown class="w-3.5 h-3.5 transition-transform" :class="{ 'rotate-180': showSyncMenu }" />
              </button>
              <!-- Sync Menu Dropdown -->
              <div
                v-if="showSyncMenu"
                class="fixed inset-0 z-40"
                @click="showSyncMenu = false"
              ></div>
              <div
                v-if="showSyncMenu"
                class="absolute right-0 top-full mt-1.5 w-64 bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 p-1.5 z-50 text-xs space-y-1"
              >
                <button
                  type="button"
                  @click="showSyncMenu = false; handleRefreshAll(false)"
                  class="w-full text-left px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between transition-colors cursor-pointer"
                >
                  <div class="flex items-center gap-2">
                    <RefreshCw class="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                    <span class="font-semibold text-slate-800 dark:text-slate-200">一键同步全部 (常规)</span>
                  </div>
                  <span class="text-[10px] text-slate-400">跳过已删除</span>
                </button>
                <button
                  type="button"
                  @click="showSyncMenu = false; handleRefreshAll(true)"
                  class="w-full text-left px-3 py-2.5 rounded-xl hover:bg-indigo-50 dark:hover:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 flex items-center justify-between transition-colors cursor-pointer"
                >
                  <div class="flex items-center gap-2">
                    <RotateCcw class="w-3.5 h-3.5" />
                    <span class="font-semibold">同步并恢复已删除动态</span>
                  </div>
                  <span class="px-1.5 py-0.5 rounded text-[10px] bg-indigo-100 dark:bg-indigo-900/60 font-bold">{{ deletedPostCount }}</span>
                </button>
                <div class="h-px bg-slate-100 dark:bg-slate-800 my-1"></div>
                <button
                  type="button"
                  @click="showSyncMenu = false; openDeletedPostsModal()"
                  class="w-full text-left px-3 py-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400 flex items-center gap-2 transition-colors cursor-pointer"
                >
                  <Trash2 class="w-3.5 h-3.5 text-slate-400" />
                  <span>管理已删除动态记录 ({{ deletedPostCount }})...</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Add Creator Button -->
          <button
            @click="openAddModal('new')"
            class="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-xl transition-all cursor-pointer"
          >
            <Plus class="w-4 h-4" />
            <span>添加创作者</span>
          </button>

          <!-- Dark Mode Toggle -->
          <button
            @click="toggleDarkMode"
            class="p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="切换浅色/暗黑主题"
          >
            <Moon v-if="!isDarkMode" class="w-4 h-4" />
            <Sun v-else class="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>

    <!-- Main Container -->
    <main class="flex-1 w-full max-w-[98%] 2xl:max-w-[96%] mx-auto px-3 sm:px-6 py-5">

      <section v-if="activeTab === 'feed'" class="flex flex-col lg:flex-row items-start gap-4 xl:gap-5">

        <!-- 1. LEFT SIDEBAR: Platform, Tags & Filters Navigation -->
        <aside class="w-full lg:w-48 xl:w-52 shrink-0 space-y-3.5 lg:sticky lg:top-20">
          <!-- Search input -->
          <div class="p-3 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-2xs">
            <div class="relative">
              <Search class="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-400" />
              <input
                v-model="searchQuery"
                type="text"
                placeholder="搜索内容或创作者..."
                class="w-full pl-8 pr-3 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500 text-slate-800 dark:text-slate-200 placeholder-slate-400"
              />
            </div>
          </div>

          <!-- Platform Navigation Menu -->
          <div class="p-3 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-2xs space-y-1">
            <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-2 py-1 flex items-center justify-between">
              <span>平台</span>
              <span class="text-[10px] font-mono font-normal">{{ Object.keys(PLATFORM_REGISTRY).length }} 个平台</span>
            </div>

            <!-- All Platforms Button -->
            <button
              @click="selectedPlatform = 'all'"
              :class="selectedPlatform === 'all' ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 font-bold border-indigo-200 dark:border-indigo-800 shadow-2xs' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border-transparent'"
              class="w-full flex items-center justify-between px-3 py-2 text-xs rounded-xl border transition-all cursor-pointer"
            >
              <div class="flex items-center gap-2">
                <LayoutGrid class="w-4 h-4" />
                <span>全部</span>
              </div>
              <span class="text-[10px] px-1.5 py-0.2 rounded-full font-mono bg-slate-200/70 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                {{ platformPostCounts['all'] || 0 }}
              </span>
            </button>

            <!-- Each Platform Button -->
            <button
              v-for="(meta, key) in PLATFORM_REGISTRY"
              :key="key"
              @click="selectedPlatform = key"
              :class="selectedPlatform === key ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 font-bold border-indigo-200 dark:border-indigo-800 shadow-2xs' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border-transparent'"
              class="w-full flex items-center justify-between px-3 py-2 text-xs rounded-xl border transition-all cursor-pointer"
            >
              <div class="flex items-center gap-2 truncate">
                <span class="w-2.5 h-2.5 rounded-full shrink-0" :style="{ backgroundColor: meta.color }"></span>
                <span class="truncate">{{ meta.name }}</span>
              </div>
              <span
                v-if="platformPostCounts[key]"
                class="text-[10px] px-1.5 py-0.2 rounded-full font-mono bg-slate-200/70 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
              >
                {{ platformPostCounts[key] }}
              </span>
            </button>
          </div>

          <!-- Content Preferences & Tag Filter -->
          <div class="p-3 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-2xs space-y-3">
            <!-- Content Preferences Buttons -->
            <div class="space-y-1.5">
              <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-2 py-0.5">
                筛选
              </div>
              <!-- Repost Toggle Button -->
              <button
                @click="toggleHideReposts"
                class="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all cursor-pointer border"
                :class="hideReposts ? 'bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-700 font-semibold shadow-2xs' : 'bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'"
              >
                <div class="flex items-center gap-2">
                  <Repeat2 class="w-3.5 h-3.5" :class="{ 'text-amber-600 dark:text-amber-400': hideReposts }" />
                  <span>{{ hideReposts ? '仅原创' : '含转发' }}</span>
                </div>
                <span
                  v-if="repostsCount > 0"
                  class="text-[10px] px-1.5 py-0.2 rounded-full font-mono"
                  :class="hideReposts ? 'bg-amber-200/80 dark:bg-amber-900 text-amber-800 dark:text-amber-200' : 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400'"
                >
                  {{ repostsCount }}
                </span>
              </button>

              <!-- Text-only Post Filter Toggle Button -->
              <button
                @click="toggleHideTextOnly"
                class="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all cursor-pointer border"
                :class="hideTextOnly ? 'bg-indigo-50 text-indigo-800 border-indigo-300 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-700 font-semibold shadow-2xs' : 'bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'"
                :title="hideTextOnly ? '当前已过滤无图文/视频的纯文字博文，点击恢复展示' : '点击过滤纯文字博文，只看包含图片/视频的动态'"
              >
                <div class="flex items-center gap-2">
                  <ImageIcon v-if="hideTextOnly" class="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                  <ImageOff v-else class="w-3.5 h-3.5 text-slate-400" />
                  <span>{{ hideTextOnly ? '仅图文' : '含纯文字' }}</span>
                </div>
                <span
                  v-if="textOnlyCount > 0"
                  class="text-[10px] px-1.5 py-0.2 rounded-full font-mono"
                  :class="hideTextOnly ? 'bg-indigo-200/80 dark:bg-indigo-900 text-indigo-800 dark:text-indigo-200' : 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400'"
                >
                  {{ textOnlyCount }}
                </span>
              </button>
            </div>

            <!-- Tags Filter (Tri-state: Include / Exclude / Neutral) -->
            <div v-if="allTags.length > 0">
              <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-2 py-1 flex items-center justify-between">
                <div class="flex items-center gap-1">
                  <Tag class="w-3 h-3" />
                  <span>标签</span>
                </div>
                <button
                  v-if="includeTags.size > 0 || excludeTags.size > 0"
                  type="button"
                  @click="clearAllTagFilters"
                  class="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer lowercase"
                >
                  清除
                </button>
              </div>
              <p class="text-[10px] text-slate-400 dark:text-slate-500 px-2 pb-1">
                点击循环：包含 → 排除 → 全部
              </p>
              <div class="flex flex-wrap gap-1.5 pt-1 px-1">
                <button
                  type="button"
                  @click="clearAllTagFilters"
                  :class="includeTags.size === 0 && excludeTags.size === 0 ? 'bg-indigo-600 text-white font-semibold shadow-2xs' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'"
                  class="px-2.5 py-1 text-[11px] rounded-lg transition-colors cursor-pointer"
                >
                  全部
                </button>
                <button
                  v-for="t in allTags"
                  :key="t"
                  type="button"
                  @click="cycleTagFilter(t)"
                  :class="[
                    getTagFilterState(t) === 'include'
                      ? 'bg-indigo-600 text-white font-bold shadow-2xs'
                      : getTagFilterState(t) === 'exclude'
                      ? 'bg-rose-600 text-white font-bold shadow-2xs line-through'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                  ]"
                  class="px-2.5 py-1 text-[11px] rounded-lg transition-all cursor-pointer flex items-center gap-1"
                  :title="getTagFilterState(t) === 'include' ? '当前：正向包含（点击切换为反选排除）' : getTagFilterState(t) === 'exclude' ? '当前：反向排除（点击取消选择）' : '点击设置为正向包含(+)'"
                >
                  <span v-if="getTagFilterState(t) === 'include'" class="text-[10px] font-black">+</span>
                  <span v-else-if="getTagFilterState(t) === 'exclude'" class="text-[10px] font-black">−</span>
                  <span>#{{ t }}</span>
                </button>
              </div>
            </div>
          </div>
        </aside>

        <!-- 2. CENTER MAIN CONTENT: Feed Posts Stream -->
        <div class="flex-1 min-w-0 w-full space-y-4">

          <!-- Empty State -->
          <div v-if="filteredPosts.length === 0" class="text-center py-20 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800">
            <div class="w-16 h-16 mx-auto mb-4 rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 flex items-center justify-center text-indigo-500">
              <LayoutGrid class="w-8 h-8" />
            </div>
            <h3 class="text-base font-bold text-slate-800 dark:text-slate-200 mb-1">暂无匹配动态</h3>
            <p class="text-xs text-slate-500 max-w-md mx-auto mb-5 leading-relaxed">
              {{ creators.length === 0 ? '还没有关注任何创作者。试试浏览创作者主页时点击右上角扩展图标快速关注，或导入演示数据体验。' : '当前筛选下没有匹配的内容，试试同步最新动态或调整筛选。' }}
            </p>
            <div class="flex justify-center gap-3">
              <button
                v-if="creators.length === 0"
                @click="loadDemoData"
                class="px-4 py-2 text-xs font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300 rounded-xl transition-colors cursor-pointer"
              >
                导入演示数据
              </button>
              <button
                @click="openAddModal('new')"
                class="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-xs transition-colors cursor-pointer"
              >
                关注第一位创作者
              </button>
            </div>
          </div>

          <!-- Multi-Platform Responsive Masonry Waterfall Layout -->
          <div v-else class="space-y-6">
          <div class="flex gap-4 xl:gap-5 items-start">
            <div
              v-for="(colPosts, colIdx) in feedColumns"
              :key="'feed-col-' + colIdx"
              class="flex-1 flex flex-col gap-4 xl:gap-5 min-w-0"
            >
              <PostCard
                v-for="post in colPosts"
                :key="post.id"
                :post="post"
                :creators="creators"
                :channels="channels"
                @bookmark="toggleBookmarkPost"
                @delete="handleDeletePost"
                @read="markPostRead"
                @media="lightboxMedia = $event"
                @avatar-error="handleAvatarError"
              />
            </div>
          </div>

          <!-- Infinite Scroll Sentinel & Pagination Indicator -->
          <div ref="infiniteScrollTrigger" class="py-8 flex flex-col items-center justify-center text-xs text-slate-400">
            <div v-if="filteredPosts.length > visibleCount" class="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 font-medium bg-indigo-50/70 dark:bg-indigo-950/40 px-4 py-2 rounded-full border border-indigo-100 dark:border-indigo-900/60 shadow-2xs">
              <RefreshCw class="w-3.5 h-3.5 animate-spin" />
              <span>加载更多 · 已显示 {{ visibleCount }} / {{ filteredPosts.length }}</span>
            </div>
            <div v-else-if="filteredPosts.length > 0" class="flex items-center gap-2 text-slate-400 dark:text-slate-500 py-2">
              <CheckCircle2 class="w-3.5 h-3.5 text-emerald-500" />
              <span>已显示全部 {{ filteredPosts.length }} 条动态</span>
            </div>
          </div>
        </div>
        </div>

        <!-- 3. RIGHT SIDEBAR: Creator Selection & Direct Platform Filtering ("成套的右侧边栏") -->
        <aside class="w-full lg:w-64 xl:w-68 shrink-0 space-y-3.5 lg:sticky lg:top-20">
          <div class="p-3.5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-2xs space-y-3">
            <!-- Sidebar Header -->
            <div class="flex items-center justify-between px-1">
              <div class="flex items-center gap-2">
                <Users class="w-4 h-4 text-indigo-500" />
                <span class="text-xs font-bold text-slate-800 dark:text-slate-200">
                  {{ selectedPlatform === 'all' ? '创作者' : `${PLATFORM_REGISTRY[selectedPlatform]?.name || selectedPlatform} 创作者` }}
                </span>
                <span class="text-[10px] px-1.5 py-0.2 rounded-full font-mono bg-slate-100 dark:bg-slate-800 text-slate-500">
                  {{ visibleCreatorsForFilter.length }}
                </span>
              </div>
              <div v-if="hiddenCreatorsInFilterCount > 0" class="flex items-center gap-1.5">
                <span class="text-[10px] text-amber-600 dark:text-amber-400 font-medium">
                  隐藏 {{ hiddenCreatorsInFilterCount }} 人
                </span>
                <button
                  type="button"
                  @click="unhideAllCreators"
                  class="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer font-medium"
                >
                  全部显示
                </button>
              </div>
            </div>

            <!-- Hint text -->
            <div class="text-[11px] text-slate-400 px-1 leading-snug">
              点击展开选择显示/隐藏的平台，点击 👁 隐藏创作者
            </div>

            <!-- Empty Creators under filter -->
            <div
              v-if="visibleCreatorsForFilter.length === 0"
              class="text-center py-6 text-xs text-slate-400 bg-slate-50/50 dark:bg-slate-850/50 rounded-xl border border-dashed border-slate-200 dark:border-slate-800"
            >
              当前筛选下无创作者
            </div>

            <!-- Creator Cards List in Right Sidebar -->
            <div v-else class="space-y-2 max-h-[calc(100vh-210px)] overflow-y-auto pr-0.5 scrollbar-thin">
              <div
                v-for="c in visibleCreatorsForFilter"
                :key="c.id"
                class="rounded-xl border transition-all select-none overflow-hidden"
                :class="[
                  hiddenCreatorIds.has(c.id)
                    ? 'bg-slate-100/60 dark:bg-slate-800/30 border-slate-200 dark:border-slate-800 opacity-60'
                    : 'bg-slate-50/70 dark:bg-slate-850 border-slate-200/80 dark:border-slate-800 shadow-2xs hover:border-indigo-300 dark:hover:border-indigo-700'
                ]"
              >
                <!-- Creator Card Header (Click to expand/fold inline directly) -->
                <div
                  @click="toggleExpandCreator(c.id)"
                  class="flex items-center justify-between p-2.5 cursor-pointer hover:bg-slate-100/60 dark:hover:bg-slate-800/60 transition-colors gap-2"
                  :title="hiddenCreatorIds.has(c.id) ? '点击眼睛恢复显示该创作者' : '点击展开渠道选择，点击眼睛隐藏此创作者'"
                >
                  <!-- Left: Avatar & Name -->
                  <div class="flex items-center gap-2.5 min-w-0">
                    <div class="w-8 h-8 rounded-full overflow-hidden shrink-0 border border-slate-200/80 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-500">
                      <img
                        v-if="getCreatorAvatar(c)"
                        :src="getCreatorAvatar(c)"
                        referrerpolicy="no-referrer"
                        class="w-full h-full object-cover"
                        @error="handleAvatarError(getCreatorAvatar(c))"
                      />
                      <span v-else>{{ (c.name || 'C').slice(0, 1) }}</span>
                    </div>

                    <div class="min-w-0">
                      <div
                        class="text-xs font-bold text-slate-800 dark:text-slate-200 truncate max-w-[130px]"
                        :class="{ 'line-through text-slate-400': hiddenCreatorIds.has(c.id) }"
                        :title="c.name"
                      >
                        {{ c.name }}
                      </div>
                      <div class="flex items-center gap-1.5 text-[10px] text-slate-400 mt-0.5">
                        <span>{{ getCreatorPlatforms(c.id).length }} 个平台</span>
                        <span
                          v-if="selectedPlatform === 'all' && hiddenCreatorPlatforms[c.id]?.length"
                          class="px-1.5 py-0.2 rounded-full bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 font-medium text-[9px] border border-rose-200/60 dark:border-rose-900/60"
                        >
                          隐藏 {{ hiddenCreatorPlatforms[c.id].length }} 平台
                        </span>
                      </div>
                    </div>
                  </div>

                  <!-- Right: Eye Toggle Button + Chevron Indicator -->
                  <div class="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      @click.stop="toggleHideCreator(c.id)"
                      class="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer"
                      :title="hiddenCreatorIds.has(c.id) ? '恢复显示该创作者' : '隐藏该创作者的所有动态'"
                    >
                      <EyeOff v-if="hiddenCreatorIds.has(c.id)" class="w-3.5 h-3.5 text-rose-500" />
                      <Eye v-else class="w-3.5 h-3.5 text-slate-400 hover:text-indigo-600" />
                    </button>
                    <div
                      class="p-0.5 text-slate-400 transition-transform duration-200"
                      :class="{ 'rotate-180': expandedCreatorIds.has(c.id) }"
                    >
                      <ChevronDown class="w-3.5 h-3.5" />
                    </div>
                  </div>
                </div>

                <!-- INLINE EXPANSION: 直接展开选择渠道 (点开直接选择，非二级菜单弹窗) -->
                <div
                  v-if="expandedCreatorIds.has(c.id)"
                  class="p-2.5 pt-2 bg-slate-100/70 dark:bg-slate-900/70 border-t border-slate-200/60 dark:border-slate-800 space-y-2 text-xs animate-in fade-in duration-150"
                >
                  <div class="flex items-center justify-between text-[10px] text-slate-400 px-0.5">
                    <span>选择显示的平台：</span>
                    <button
                      v-if="hiddenCreatorPlatforms[c.id]?.length"
                      type="button"
                      @click.stop="resetCreatorHiddenPlatforms(c.id)"
                      class="text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer font-medium"
                    >
                      全部显示
                    </button>
                  </div>

                  <!-- Platform items of this creator -->
                  <div v-if="getCreatorPlatforms(c.id).length === 0" class="text-center py-2 text-[11px] text-slate-400">
                    暂无绑定账号
                  </div>
                  <div v-else class="space-y-1.5">
                    <div
                      v-for="pKey in getCreatorPlatforms(c.id)"
                      :key="pKey"
                      @click.stop="toggleHideCreatorPlatform(c.id, pKey)"
                      class="flex items-center justify-between px-2.5 py-1.5 rounded-lg border transition-all cursor-pointer"
                      :class="hiddenCreatorPlatforms[c.id]?.includes(pKey)
                        ? 'bg-rose-50/80 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900/50 text-rose-700 dark:text-rose-300'
                        : 'bg-white dark:bg-slate-800 border-slate-200/80 dark:border-slate-700/80 text-slate-700 dark:text-slate-200 hover:border-indigo-300'"
                    >
                      <div class="flex items-center gap-2 truncate min-w-0">
                        <span
                          class="w-2.5 h-2.5 rounded-full shrink-0"
                          :style="{ backgroundColor: PLATFORM_REGISTRY[pKey]?.color || '#6366f1' }"
                        ></span>
                        <div class="min-w-0 truncate">
                          <span class="font-semibold text-[11px] truncate">
                            {{ PLATFORM_REGISTRY[pKey]?.name || pKey }}
                          </span>
                          <span class="text-[9px] text-slate-400 ml-1 truncate">
                            {{ channels.filter(ch => ch.creatorId === c.id && ch.platform === pKey).map(ch => ch.displayName || ch.label || ch.accountId).join(', ') }}
                          </span>
                        </div>
                      </div>

                      <!-- Direct status toggle pill -->
                      <div class="flex items-center gap-1 shrink-0 text-[10px] font-medium ml-2">
                        <span v-if="hiddenCreatorPlatforms[c.id]?.includes(pKey)" class="flex items-center gap-0.5 text-rose-600 dark:text-rose-400 px-1.5 py-0.5 rounded-md bg-rose-100/70 dark:bg-rose-950/80 border border-rose-200 dark:border-rose-800">
                          <EyeOff class="w-3 h-3" />
                          <span>已隐藏</span>
                        </span>
                        <span v-else class="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800">
                          <Eye class="w-3 h-3" />
                          <span>显示中</span>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </section>

      <section v-else-if="activeTab === 'creators'" class="space-y-6">
        <!-- Header & Action Toolbar -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div class="flex items-center gap-2">
              <h2 class="font-bold text-lg text-slate-900 dark:text-white">关注管理</h2>
              <span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900">
                {{ filteredCreatorsList.length }} / {{ creators.length }} 位
              </span>
            </div>
            <p class="text-xs text-slate-500 mt-0.5">管理关注的创作者和绑定的各平台账号</p>
          </div>
          <div class="flex items-center gap-2">
            <button
              @click="isBatchMode = !isBatchMode; if (!isBatchMode) selectedCreatorIds = new Set();"
              :class="isBatchMode ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'"
              class="flex items-center gap-1.5 px-3 py-2 border rounded-xl text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
            >
              <CheckSquare class="w-3.5 h-3.5" />
              <span>{{ isBatchMode ? '完成' : '批量' }}</span>
            </button>
            <button
              @click="openAddModal('new')"
              class="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-xs transition-colors cursor-pointer"
            >
              <Plus class="w-4 h-4" />
              <span>+ 新建</span>
            </button>
          </div>
        </div>

        <!-- Filter & Search Bar -->
        <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 p-4 shadow-2xs space-y-3">
          <div class="flex flex-col md:flex-row items-stretch md:items-center gap-3">
            <!-- Search Input -->
            <div class="relative flex-1">
              <Search class="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                v-model="creatorSearch"
                type="text"
                placeholder="搜索创作者..."
                class="w-full pl-9 pr-8 py-2 bg-slate-100 dark:bg-slate-800 border-none rounded-xl text-xs outline-none focus:ring-2 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
              />
              <button
                v-if="creatorSearch"
                @click="creatorSearch = ''"
                class="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-full"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>

            <!-- Sort By Select -->
            <div class="flex items-center gap-2 shrink-0">
              <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300">
                <ArrowUpDown class="w-3.5 h-3.5 text-slate-400" />
                <span class="text-[11px] text-slate-400 font-medium">排序</span>
                <select
                  v-model="creatorSortBy"
                  class="bg-transparent border-none text-xs font-medium text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer"
                >
                  <option value="updated">最近活跃</option>
                  <option value="posts">作品数</option>
                  <option value="channels">账号数</option>
                  <option value="name">按名称</option>
                </select>
              </div>
            </div>
          </div>

          <!-- Platform Filter Pills -->
          <div class="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
            <span class="text-[11px] text-slate-400 font-medium mr-1 flex items-center gap-1">
              <Filter class="w-3 h-3" />
              平台筛选:
            </span>
            <button
              @click="creatorPlatformFilter = 'all'"
              class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer"
              :class="creatorPlatformFilter === 'all'
                ? 'bg-indigo-600 text-white shadow-2xs font-semibold'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
            >
              全部 ({{ creators.length }})
            </button>
            <template v-for="(cfg, pKey) in PLATFORM_REGISTRY" :key="pKey">
              <button
                v-if="creatorCountByPlatform[pKey]"
                @click="creatorPlatformFilter = pKey"
                class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer flex items-center gap-1"
                :class="creatorPlatformFilter === pKey
                  ? 'bg-indigo-600 text-white shadow-2xs font-semibold'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
              >
                <span>{{ cfg.name }}</span>
                <span class="text-[10px] opacity-75">({{ creatorCountByPlatform[pKey] || 0 }})</span>
              </button>
            </template>
          </div>

          <!-- Tags Filter Row (Tri-state: Include / Exclude / Neutral) -->
          <div v-if="allTags.length > 0" class="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
            <span class="text-[11px] text-slate-400 font-medium mr-1 flex items-center gap-1">
              <Tag class="w-3 h-3" />
              标签筛选:
            </span>
            <button
              type="button"
              @click="clearAllTagFilters"
              :class="includeTags.size === 0 && excludeTags.size === 0 ? 'bg-indigo-600 text-white font-semibold shadow-2xs' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'"
              class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer"
            >
              全部标签
            </button>
            <button
              v-for="t in allTags"
              :key="'dir-tag-' + t"
              type="button"
              @click="cycleTagFilter(t)"
              :class="[
                getTagFilterState(t) === 'include'
                  ? 'bg-indigo-600 text-white font-bold shadow-2xs'
                  : getTagFilterState(t) === 'exclude'
                  ? 'bg-rose-600 text-white font-bold shadow-2xs line-through'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
              ]"
              class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer flex items-center gap-1"
              :title="getTagFilterState(t) === 'include' ? '正向包含（点击切为反向排除）' : getTagFilterState(t) === 'exclude' ? '反向排除（点击取消）' : '点击设置为正向包含(+)'"
            >
              <span v-if="getTagFilterState(t) === 'include'" class="text-[10px] font-black">+</span>
              <span v-else-if="getTagFilterState(t) === 'exclude'" class="text-[10px] font-black">−</span>
              <span>#{{ t }}</span>
            </button>
          </div>
        </div>

        <!-- Batch Action Toolbar (When Batch Mode Active) -->
        <div
          v-if="isBatchMode"
          class="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-indigo-50/90 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800/70 rounded-2xl animate-fade-in"
        >
          <div class="flex items-center gap-3">
            <button
              @click="selectAllFilteredCreators"
              class="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-800 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-indigo-50 cursor-pointer"
            >
              <CheckSquare class="w-3.5 h-3.5 text-indigo-600" />
              <span>全选 ({{ filteredCreatorsList.length }})</span>
            </button>
            <button
              @click="clearCreatorSelection"
              class="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 underline cursor-pointer"
            >
              清空选择
            </button>
            <span class="text-xs font-semibold text-indigo-700 dark:text-indigo-300">
              已选 {{ selectedCreatorIds.size }} 位
            </span>
          </div>

          <div class="flex items-center gap-2">
            <button
              @click="batchRefreshSelectedCreators"
              :disabled="selectedCreatorIds.size === 0"
              class="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors cursor-pointer shadow-2xs"
            >
              <RefreshCw class="w-3.5 h-3.5" />
              <span>同步选中</span>
            </button>
            <button
              @click="batchDeleteSelectedCreators"
              :disabled="selectedCreatorIds.size === 0"
              class="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors cursor-pointer shadow-2xs"
            >
              <Trash2 class="w-3.5 h-3.5" />
              <span>删除选中</span>
            </button>
          </div>
        </div>

        <!-- Empty Creators State -->
        <div v-if="creators.length === 0" class="text-center py-16 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800">
          <Users class="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <p class="text-xs text-slate-500 mb-4">还没有关注任何创作者</p>
          <button
            @click="loadDemoData"
            class="px-4 py-2 text-xs font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300 rounded-xl cursor-pointer"
          >
            导入演示数据
          </button>
        </div>

        <!-- Empty Filter Results -->
        <div v-else-if="filteredCreatorsList.length === 0" class="text-center py-16 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800">
          <Search class="w-8 h-8 text-slate-400 mx-auto mb-2" />
          <p class="text-xs text-slate-500 mb-3">未找到匹配的创作者</p>
          <button
            @click="creatorSearch = ''; creatorPlatformFilter = 'all'; creatorTagFilter = 'all'; clearAllTagFilters();"
            class="px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 dark:bg-indigo-950/50 rounded-lg hover:underline cursor-pointer"
          >
            清除筛选
          </button>
        </div>

        <!-- Creator Cards Grid -->
        <div v-else class="columns-1 md:columns-2 gap-4 xl:gap-5">
          <div
            v-for="c in filteredCreatorsList"
            :key="c.id"
            class="mb-4 xl:mb-5 break-inside-avoid p-3.5 bg-white dark:bg-slate-900 rounded-2xl border transition-all duration-200 shadow-sm space-y-3 relative overflow-hidden"
            :class="selectedCreatorIds.has(c.id) ? 'border-indigo-500 ring-2 ring-indigo-500/20 bg-indigo-50/20 dark:bg-indigo-950/20' : 'border-slate-200/80 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-md'"
          >
            <!-- Top Row: Avatar, Name, Stats & Actions -->
            <div class="flex items-start justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <!-- Checkbox in Batch Mode -->
                <button
                  v-if="isBatchMode"
                  @click="toggleSelectCreator(c.id)"
                  class="shrink-0 text-indigo-600 hover:scale-105 transition-transform cursor-pointer"
                >
                  <CheckSquare v-if="selectedCreatorIds.has(c.id)" class="w-5 h-5 text-indigo-600" />
                  <Square v-else class="w-5 h-5 text-slate-400" />
                </button>

                <!-- Avatar with Hover Change Overlay -->
                <div
                  class="relative group/avatar w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-50 to-violet-100 dark:from-indigo-950/70 dark:to-violet-900/50 flex items-center justify-center text-indigo-600 font-black text-lg overflow-hidden border border-indigo-100 dark:border-indigo-900 shrink-0 shadow-inner cursor-pointer"
                  @click.stop="openAvatarPicker(c)"
                  title="更换主头像"
                >
                  <img
                    v-if="getCreatorAvatar(c)"
                    :src="getCreatorAvatar(c)"
                    referrerpolicy="no-referrer"
                    @error="handleAvatarError(getCreatorAvatar(c))"
                    class="w-full h-full object-cover transition-transform duration-200 group-hover/avatar:scale-105"
                  />
                  <span v-else>{{ c.name.slice(0, 1) }}</span>

                  <!-- Subtle hover mask & camera icon -->
                  <div class="absolute inset-0 bg-black/40 opacity-0 group-hover/avatar:opacity-100 transition-opacity flex items-center justify-center text-white">
                    <Camera class="w-4 h-4 drop-shadow" />
                  </div>
                </div>

                <!-- Name & Meta Tags -->
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <h3 class="font-bold text-base text-slate-900 dark:text-white truncate">{{ c.name }}</h3>
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 shrink-0">
                      {{ creatorPostCountMap[c.id] || 0 }} 条作品
                    </span>
                  </div>
                  <div class="flex flex-wrap items-center gap-1 mt-1">
                    <span
                      v-for="t in c.tags"
                      :key="t"
                      class="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 cursor-pointer hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
                      @click="cycleTagFilter(t)"
                      :title="'点击过滤标签 #' + t"
                    >
                      #{{ t }}
                    </span>
                    <span v-if="!c.tags?.length" class="text-[10px] text-slate-400">未分类</span>
                    <!-- Edit tags button -->
                    <button
                      type="button"
                      @click.stop="openEditCreatorTags(c)"
                      title="编辑修改创作者标签"
                      class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/60 cursor-pointer transition-colors"
                    >
                      <Edit3 class="w-3 h-3" />
                      <span>编辑标签</span>
                    </button>
                  </div>
                </div>
              </div>

              <!-- Top Quick Action Buttons -->
              <div class="flex items-center gap-1 shrink-0">
                <!-- Open Deep History Sync Modal Button -->
                <button
                  @click="openDeepSyncModal(c)"
                  title="回溯更早的历史动态"
                  class="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/60 text-indigo-600 dark:text-indigo-400 text-xs font-semibold transition-colors cursor-pointer border border-indigo-200/60 dark:border-indigo-800/60 shadow-2xs"
                >
                  <History class="w-3.5 h-3.5" />
                  <span class="hidden sm:inline">回溯历史</span>
                </button>
                <!-- Quick Sync Latest -->
                <button
                  @click="handleRefreshCreator(c.id)"
                  title="同步最新动态"
                  class="p-2 text-slate-600 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
                >
                  <RefreshCw class="w-4 h-4" />
                </button>
                <!-- Delete Creator Archive -->
                <button
                  @click="deleteCreator(c.id)"
                  title="移除该创作者档案"
                  class="p-2 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/60 rounded-xl transition-colors cursor-pointer"
                >
                  <Trash2 class="w-4 h-4" />
                </button>
              </div>
            </div>

            <!-- Attached Channels Grouped by Platform -->
            <div class="space-y-2.5 pt-2 border-t border-slate-100 dark:border-slate-800">
              <div class="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 pb-1">
                <span class="font-semibold text-slate-700 dark:text-slate-300">已绑定账号</span>
                <button @click="openAddModal('channel', c)" class="text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-semibold flex items-center gap-1 cursor-pointer bg-indigo-50 dark:bg-indigo-950/60 px-2 py-1 rounded-lg border border-indigo-100 dark:border-indigo-900 transition-colors">
                  <Plus class="w-3 h-3" />
                  <span>+ 绑定新账号</span>
                </button>
              </div>

              <!-- Grouped Platform Sections -->
              <div class="space-y-2">
                <div
                  v-for="(chs, platform) in getCreatorGroupedChannels(c.id)"
                  :key="platform"
                  class="rounded-xl border border-slate-200/70 dark:border-slate-800/80 bg-slate-50/70 dark:bg-slate-850/50 p-2.5 space-y-1.5"
                >
                  <!-- Platform Header within Creator -->
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                      <span :class="PLATFORM_REGISTRY[platform as Platform]?.badgeBg || 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'" class="px-2 py-0.5 rounded text-[10px] font-bold border">
                        {{ PLATFORM_REGISTRY[platform as Platform]?.name || platform }}
                      </span>
                      <span class="text-[11px] text-slate-400">
                        {{ chs.length > 1 ? `绑定了 ${chs.length} 个账号 (同平台多账号互通)` : '1 个账号' }}
                      </span>
                    </div>
                  </div>

                  <!-- Account Rows within this Platform -->
                  <div class="space-y-1">
                    <div
                      v-for="ch in chs"
                      :key="ch.id"
                      class="flex items-center justify-between p-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60 text-xs shadow-2xs"
                    >
                      <div class="flex items-center gap-2 min-w-0 flex-1">
                        <!-- Account Role Badge with Quick Cycle Switch on Click -->
                        <button
                          @click="cycleChannelRole(ch)"
                          title="点击切换账号角色分类 (主号 / 小号 / 里号 / 自定义)"
                          class="px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors cursor-pointer shrink-0"
                          :class="getRoleBadgeClass(ch.accountRole)"
                        >
                          {{ ch.label || getRoleLabel(ch.accountRole) }}
                        </button>

                        <!-- Channel Avatar Thumbnail -->
                        <div class="w-5 h-5 rounded-full overflow-hidden shrink-0 border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-[10px] text-slate-500">
                          <img
                            v-if="ch.avatarUrl && !failedAvatarUrls.has(ch.avatarUrl)"
                            :src="toSecureMediaUrl(ch.avatarUrl)"
                            referrerpolicy="no-referrer"
                            class="w-full h-full object-cover"
                            @error="handleAvatarError(ch.avatarUrl)"
                          />
                          <span v-else>{{ (ch.displayName || ch.accountId || 'U').slice(0, 1) }}</span>
                        </div>

                        <!-- Account Name & Link -->
                        <a
                          :href="ch.profileUrl"
                          target="_blank"
                          class="font-medium text-slate-700 dark:text-slate-200 hover:underline flex items-center gap-1 truncate max-w-[180px] sm:max-w-xs"
                          :title="ch.profileUrl"
                        >
                          <span class="truncate">{{ ch.displayName || ch.accountId }}</span>
                          <ExternalLink class="w-2.5 h-2.5 text-slate-400 shrink-0" />
                        </a>

                        <!-- Status Indicator -->
                        <span
                          v-if="ch.status === 'error'"
                          @click.stop="alert(`【${ch.displayName || ch.accountId} 同步未成功】\n\n原因：${ch.errorMessage || '未知异常'}`)"
                          class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900/60 hover:bg-rose-100 cursor-pointer shrink-0"
                          title="点击查看具体同步错误详情"
                        >
                          同步失败
                        </span>
                      </div>

                      <!-- Actions -->
                      <div class="flex items-center gap-1 shrink-0 ml-2">
                        <!-- Deep Sync Single Channel -->
                        <button
                          @click="openDeepSyncModal(c, ch.id)"
                          title="针对该账号深度回溯更早历史动态"
                          class="p-1 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                        >
                          <History class="w-3.5 h-3.5" />
                        </button>
                        <!-- Refresh Channel Latest (Normal click: incremental; Shift+click: force refresh existing) -->
                        <button
                          @click="handleRefreshChannel(ch, false)"
                          @click.shift.stop="handleRefreshChannel(ch, true)"
                          title="同步最新动态 (按住 Shift 点击可强制重新刷新覆盖已有内容与图片)"
                          class="p-1 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                        >
                          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': ch.status === 'updating' }" />
                        </button>
                        <!-- Delete Channel -->
                        <button
                          @click="deleteChannel(ch.id)"
                          title="移除该账号"
                          class="p-1 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                        >
                          <Trash2 class="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <!-- Error notification if present -->
                    <div
                      v-for="ch in chs.filter(c => c.errorMessage)"
                      :key="'err-' + ch.id"
                      class="text-[10px] text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/50 p-1.5 rounded-md border border-rose-200 dark:border-rose-900/60 flex items-start gap-1"
                    >
                      <AlertCircle class="w-3 h-3 shrink-0 mt-0.5 text-rose-500" />
                      <span class="break-all">{{ ch.displayName || ch.accountId }}: {{ ch.errorMessage }}</span>
                    </div>
                  </div>
                </div>

                <div v-if="channels.filter(ch => ch.creatorId === c.id).length === 0" class="text-center py-4 text-xs text-slate-400">
                  暂无绑定账号，点击上方 + 绑定新账号
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-else-if="activeTab === 'bookmarks'" class="space-y-5">
        <!-- Bookmarks Header & Filter Bar -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-xl bg-amber-50 dark:bg-amber-950/60 flex items-center justify-center text-amber-500">
                <Bookmark class="w-4 h-4 fill-amber-500" />
              </div>
              <h2 class="font-bold text-lg text-slate-900 dark:text-white">收藏</h2>
              <span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                {{ filteredBookmarkedPosts.length }} 条收藏
              </span>
            </div>
            <p class="text-xs text-slate-500 mt-1">
              收藏的动态不会被历史清理删除，永久保留。
            </p>
          </div>
        </div>

        <!-- Bookmarks Search & Platform Filter Bar -->
        <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 p-4 shadow-2xs space-y-3">
          <div class="flex flex-col md:flex-row items-stretch md:items-center gap-3">
            <!-- Search Input -->
            <div class="relative flex-1">
              <Search class="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                v-model="bookmarkSearchQuery"
                type="text"
                placeholder="搜索收藏..."
                class="w-full pl-9 pr-8 py-2 bg-slate-100 dark:bg-slate-800 border-none rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-500 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
              />
              <button
                v-if="bookmarkSearchQuery"
                type="button"
                @click="bookmarkSearchQuery = ''"
                class="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-full"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <!-- Platform Filter Pills -->
          <div class="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
            <span class="text-[11px] text-slate-400 font-medium mr-1 flex items-center gap-1">
              <Filter class="w-3 h-3" />
              平台筛选:
            </span>
            <button
              type="button"
              @click="bookmarkSelectedPlatform = 'all'"
              class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer"
              :class="bookmarkSelectedPlatform === 'all'
                ? 'bg-amber-600 text-white shadow-2xs font-semibold'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
            >
              全部 ({{ posts.filter(p => p.isBookmarked).length }})
            </button>
            <template v-for="(cfg, pKey) in PLATFORM_REGISTRY" :key="'bm-p-' + pKey">
              <button
                v-if="posts.some(p => p.isBookmarked && p.platform === pKey)"
                type="button"
                @click="bookmarkSelectedPlatform = pKey"
                class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer flex items-center gap-1"
                :class="bookmarkSelectedPlatform === pKey
                  ? 'bg-amber-600 text-white shadow-2xs font-semibold'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
              >
                <span>{{ cfg.name }}</span>
                <span class="text-[10px] opacity-75">
                  ({{ posts.filter(p => p.isBookmarked && p.platform === pKey).length }})
                </span>
              </button>
            </template>
          </div>
        </div>

        <!-- Empty Bookmarks State -->
        <div v-if="filteredBookmarkedPosts.length === 0" class="text-center py-20 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800">
          <div class="w-16 h-16 mx-auto mb-4 rounded-2xl bg-amber-50 dark:bg-amber-950/50 flex items-center justify-center text-amber-500">
            <Bookmark class="w-8 h-8" />
          </div>
          <h3 class="text-base font-bold text-slate-800 dark:text-slate-200 mb-1">
            {{ posts.some(p => p.isBookmarked) ? '未找到符合条件的收藏动态' : '暂无收藏的动态' }}
          </h3>
          <p class="text-xs text-slate-500 max-w-md mx-auto mb-5 leading-relaxed">
            {{ posts.some(p => p.isBookmarked) ? '可以尝试更换搜索关键词或选择全部平台。' : '在动态流中点击 ☆ 收藏喜欢的内容' }}
          </p>
          <button
            type="button"
            @click="activeTab = 'feed'"
            class="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-xs transition-colors cursor-pointer"
          >
            前往动态
          </button>
        </div>

        <!-- Bookmarked Posts Masonry Waterfall Layout -->
        <div v-else class="space-y-6">
          <div class="flex gap-4 xl:gap-5 items-start">
            <div
              v-for="(colPosts, colIdx) in bookmarkColumns"
              :key="'bm-col-' + colIdx"
              class="flex-1 flex flex-col gap-4 xl:gap-5 min-w-0"
            >
              <PostCard
                v-for="post in colPosts"
                :key="'bm-' + post.id"
                :post="post"
                :creators="creators"
                :channels="channels"
                bookmarked
                @bookmark="toggleBookmarkPost"
                @delete="handleDeletePost"
                @read="markPostRead"
                @media="lightboxMedia = $event"
                @avatar-error="handleAvatarError"
              />
            </div>
          </div>
        </div>
      </section>

      <section v-else-if="activeTab === 'settings'" class="max-w-3xl mx-auto space-y-6">
        <!-- Security & Architecture Guarantee Banner -->
        <div class="p-5 bg-gradient-to-r from-indigo-900/10 to-violet-900/10 dark:from-indigo-950/50 dark:to-violet-950/50 border border-indigo-200 dark:border-indigo-800/60 rounded-2xl flex items-start gap-3">
          <ShieldCheck class="w-6 h-6 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
          <div class="text-xs space-y-1">
            <h4 class="font-bold text-slate-900 dark:text-white text-sm">隐私与安全</h4>
            <p class="text-slate-600 dark:text-slate-300 leading-relaxed">
              所有数据仅存储在本地浏览器中，不会上传任何信息到外部服务器。
            </p>
          </div>
        </div>

        <!-- Platform Service Hub & Adapter Matrix -->
        <div class="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-5">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 class="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
                <span>平台与登录状态</span>
              </h3>
              <p class="text-xs text-slate-500 mt-0.5">
                查看各平台的登录状态和连接情况
              </p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                @click="openAddModal('new', undefined, 'https://')"
                class="px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 rounded-lg border border-indigo-200 dark:border-indigo-800 flex items-center gap-1 cursor-pointer transition-colors"
              >
                <Plus class="w-3.5 h-3.5" />
                <span>+ 添加 RSS 源</span>
              </button>
              <button
                @click="checkPlatformLogins"
                class="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 rounded-lg hover:bg-slate-200 cursor-pointer flex items-center gap-1.5 transition-colors"
              >
                <RefreshCw class="w-3.5 h-3.5" />
                <span>检测登录状态</span>
              </button>
            </div>
          </div>

          <!-- Architecture & auth guide -->
          <div class="p-3.5 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-slate-200/60 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300 space-y-1.5">
            <div class="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <Sparkles class="w-3.5 h-3.5 text-indigo-500 shrink-0" />
              <span>登录说明：</span>
            </div>
            <p>• <b>大多数平台</b>（B站、Pixiv、Fantia、Withny 等）自动使用浏览器登录状态，在主站登录即可生效。</p>
            <p>• <b>单页应用 (SPA)</b>：Rplay 等站点可在卡片中点击“从当前页同步”。</p>
            <p>• <b>抗限流同源抓取</b>：X (Twitter) 结合浏览器活跃标签页与同源请求，保障同步稳定性。</p>
            <p>• <b>通用订阅协议</b>：支持标准 RSS 2.0 / Atom 1.0 与 RSSHub 源，订阅博客、Substack 等外部内容。</p>
          </div>

          <!-- Platform Grid with Per-Platform Contextual Actions -->
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
            <div
              v-for="(meta, key) in PLATFORM_REGISTRY"
              :key="key"
              class="p-4 bg-slate-50/80 dark:bg-slate-850/60 border border-slate-200/80 dark:border-slate-800 rounded-xl flex flex-col justify-between gap-3 shadow-2xs"
            >
              <div>
                <div class="flex items-start justify-between gap-2 mb-1.5">
                  <div class="flex items-center gap-2">
                    <span class="font-bold text-xs text-slate-900 dark:text-white">{{ meta.name }}</span>
                    <span class="px-1.5 py-0.2 rounded text-[9px] font-medium bg-slate-200/80 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                      {{ meta.authTypeName }}
                    </span>
                  </div>
                  <span
                    class="w-2.5 h-2.5 rounded-full shrink-0 mt-0.5"
                    :class="platformLoginStatus[key] ? 'bg-emerald-500 shadow-xs shadow-emerald-500/50' : 'bg-amber-400'"
                    :title="platformLoginStatus[key] ? '就绪 (可同步)' : '未检测到会话'"
                  ></span>
                </div>
                <p class="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 leading-relaxed">
                  {{ meta.description }}
                </p>
              </div>

              <!-- Contextual Action per Platform -->
              <div class="pt-2 border-t border-slate-200/50 dark:border-slate-800/80">
                <!-- Rplay specific action -->
                <div v-if="key === 'rplay'" class="space-y-2">
                  <div class="flex items-center justify-between text-[11px] px-0.5">
                    <span class="text-slate-500 dark:text-slate-400">登录状态:</span>
                    <span
                      class="font-mono text-[10px] px-2 py-0.5 rounded-full font-medium"
                      :class="platformLoginStatus['rplay'] ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'"
                    >
                      {{ platformLoginStatus['rplay'] ? (currentRplayToken ? currentRplayToken.slice(0, 10) + '...' : '已配置') : '未配置' }}
                    </span>
                  </div>
                  <div class="flex gap-1.5">
                    <button
                      @click="syncRplayFromTab"
                      class="flex-1 py-1.5 px-2 text-xs font-medium text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 rounded-lg border border-indigo-200 dark:border-indigo-800 flex items-center justify-center gap-1 cursor-pointer transition-colors"
                      title="在浏览器中打开 rplay.live 后点击一键同步"
                    >
                      <Link class="w-3.5 h-3.5" />
                      <span>从当前页同步</span>
                    </button>
                    <button
                      @click="promptManualRplayToken"
                      class="py-1.5 px-2.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg flex items-center justify-center gap-1 cursor-pointer transition-colors"
                      title="手动输入、粘贴或修改 Rplay Token"
                    >
                      <Key class="w-3.5 h-3.5 text-slate-500" />
                      <span>手动输入</span>
                    </button>
                  </div>
                </div>

                <!-- Twitter specific action -->
                <button
                  v-else-if="key === 'twitter'"
                  @click="checkPlatformLogins"
                  class="w-full py-1.5 px-2 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                >
                  <RefreshCw class="w-3.5 h-3.5" />
                  <span>检测 X/Twitter 登录</span>
                </button>

                <!-- RSS specific action -->
                <button
                  v-else-if="key === 'rss'"
                  @click="openAddModal('new', undefined, 'https://')"
                  class="w-full py-1.5 px-2 text-xs font-medium text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 rounded-lg border border-indigo-200 dark:border-indigo-800 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Plus class="w-3.5 h-3.5" />
                  <span>添加 RSS 订阅</span>
                </button>

                <!-- Cookie based or open platforms -->
                <a
                  v-else
                  :href="`https://${meta.domain}`"
                  target="_blank"
                  class="w-full py-1.5 px-2 text-xs font-medium text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg flex items-center justify-center gap-1.5 transition-colors"
                >
                  <span>打开登录页 ↗</span>
                </a>
              </div>
            </div>

            <!-- Custom Feed Expansion Slot -->
            <div
              @click="openAddModal('new', undefined, 'https://')"
              class="p-4 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-800 hover:border-indigo-400 dark:hover:border-indigo-600 flex flex-col items-center justify-center text-center cursor-pointer transition-all group bg-slate-50/40 dark:bg-slate-850/40"
            >
              <div class="w-8 h-8 rounded-full bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center text-indigo-600 mb-1.5 group-hover:scale-110 transition-transform">
                <Plus class="w-4 h-4" />
              </div>
              <span class="font-bold text-xs text-slate-800 dark:text-slate-200">添加自定义 RSS / 独立源</span>
              <span class="text-[10px] text-slate-400 mt-0.5">支持博客、Substack 或 RSSHub</span>
            </div>
          </div>
        </div>

        <!-- Data Backup & Restore -->
        <div class="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
          <div>
            <h3 class="font-bold text-base text-slate-900 dark:text-white">数据备份与导出</h3>
            <p class="text-xs text-slate-500 mt-0.5">创作者档案与动态均安全保存在浏览器本地，支持随时导出与恢复独立备份。</p>
          </div>

          <div class="flex flex-wrap gap-3">
            <button
              @click="exportBackupToFile"
              class="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-xs transition-colors cursor-pointer"
            >
              <FolderDown class="w-4 h-4" />
              <span>导出到文件</span>
            </button>

            <button
              @click="exportBackup"
              class="flex items-center gap-2 px-4 py-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
            >
              <Download class="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>下载 JSON 备份</span>
            </button>

            <label class="flex items-center gap-2 px-4 py-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-xl text-xs font-semibold transition-colors cursor-pointer">
              <Upload class="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>导入备份</span>
              <input type="file" accept=".json" class="hidden" @change="handleImportFile" />
            </label>

            <button
              @click="loadDemoData"
              class="flex items-center gap-2 px-4 py-2.5 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 text-indigo-600 dark:text-indigo-300 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
            >
              <Sparkles class="w-4 h-4" />
              <span>导入演示数据</span>
            </button>
          </div>
        </div>

        <!-- Fetch Preferences -->
        <div class="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
          <h3 class="font-bold text-base text-slate-900 dark:text-white">同步设置</h3>
          <div class="space-y-3">
            <div class="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800 text-xs">
              <div>
                <div class="font-semibold text-slate-800 dark:text-slate-200">每次获取条数</div>
                <div class="text-[11px] text-slate-400">每次同步时获取的动态条数</div>
              </div>
              <select
                v-model.number="settings.itemsPerFetch"
                @change="saveSettings({ itemsPerFetch: settings.itemsPerFetch })"
                class="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs outline-none cursor-pointer"
              >
                <option :value="5">5 条</option>
                <option :value="10">10 条（推荐）</option>
                <option :value="20">20 条</option>
              </select>
            </div>

            <div class="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800 text-xs">
              <div>
                <div class="font-semibold text-slate-800 dark:text-slate-200">请求间隔</div>
                <div class="text-[11px] text-slate-400">连续同步多个账号时的请求间隔，避免触发平台限制</div>
              </div>
              <select
                v-model.number="settings.requestDelayMs"
                @change="saveSettings({ requestDelayMs: settings.requestDelayMs })"
                class="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs outline-none cursor-pointer"
              >
                <option :value="300">300ms（快）</option>
                <option :value="600">600ms（推荐）</option>
                <option :value="1200">1200ms（保守）</option>
              </select>
            </div>

            <div class="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800 text-xs">
              <div>
                <div class="font-semibold text-slate-800 dark:text-slate-200">后台自动更新</div>
                <div class="text-[11px] text-slate-400">关闭后仅在手动点击“同步全部”时拉取，冷启动与后台绝不发起任何抓取请求</div>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  v-model="settings.enableAutoSync"
                  @change="saveSettings({ enableAutoSync: settings.enableAutoSync }); chrome.runtime?.sendMessage?.({ type: 'UPDATE_AUTO_SYNC' });"
                  class="sr-only peer"
                />
                <div class="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>

            <div class="flex items-center justify-between py-2 text-xs">
              <div>
                <div class="font-semibold text-slate-800 dark:text-slate-200">默认隐藏转发</div>
                <div class="text-[11px] text-slate-400">默认隐藏转发/转推内容，可在动态页随时切换</div>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  v-model="settings.hideReposts"
                  @change="saveSettings({ hideReposts: settings.hideReposts }); hideReposts = Boolean(settings.hideReposts);"
                  class="sr-only peer"
                />
                <div class="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>
          </div>
        </div>

        <!-- Local Disk Image Cache (File System Access API) -->
        <ImageCacheSettings
          :settings="settings"
          :posts="posts"
          :creators="creators"
          @updateSettings="saveSettings($event)"
        />

        <!-- Database Health & Cache Cleanup -->
        <div class="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
                <span>存储管理</span>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800">
                  运行良好
                </span>
              </h3>
              <p class="text-[11px] text-slate-400 mt-0.5">数据存储在本地浏览器中，可手动清理历史数据释放空间</p>
            </div>
            <button
              type="button"
              @click="reloadData"
              class="px-2.5 py-1 text-xs bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
            >
              刷新
            </button>
          </div>

          <!-- Metrics Grid -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div class="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-700/60">
              <div class="text-[10px] text-slate-400 font-medium">动态总数</div>
              <div class="text-base font-bold text-slate-900 dark:text-white mt-0.5">{{ dbStats.totalPostsCount }} 条</div>
            </div>
            <div class="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-700/60">
              <div class="text-[10px] text-slate-400 font-medium">收藏数</div>
              <div class="text-base font-bold text-amber-600 dark:text-amber-400 mt-0.5">{{ dbStats.bookmarkedPostsCount }} 条</div>
            </div>
            <div class="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-700/60">
              <div class="text-[10px] text-slate-400 font-medium">存储占用</div>
              <div class="text-base font-bold text-indigo-600 dark:text-indigo-400 mt-0.5">{{ formatBytes(dbStats.storageUsageBytes) }}</div>
            </div>
            <div class="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-700/60">
              <div class="text-[10px] text-slate-400 font-medium">创作者 / 账号</div>
              <div class="text-base font-bold text-slate-900 dark:text-white mt-0.5">{{ dbStats.creatorsCount }} 位 / {{ dbStats.channelsCount }} 个</div>
            </div>
          </div>

          <!-- Actions -->
          <div class="pt-2 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div class="text-slate-400 text-[11px] leading-relaxed max-w-md">
              收藏的动态不会被清理，永久保留。
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                @click="handleHealBrokenMedia"
                :disabled="isHealingMedia"
                class="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/60 rounded-xl font-medium transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                title="自动扫描并纠正本地数据库中小红书受限 CDN 域名，恢复旧笔记正常显示"
              >
                <Sparkles class="w-3.5 h-3.5" :class="{ 'animate-spin': isHealingMedia }" />
                <span>{{ isHealingMedia ? '修复中...' : '一键修复小红书图裂' }}</span>
              </button>
              <button
                type="button"
                @click="handleCleanupPosts(60)"
                :disabled="isCleaningStorage"
                class="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl font-medium transition-colors cursor-pointer disabled:opacity-50"
              >
                清理 60 天前数据
              </button>
              <button
                type="button"
                @click="handleCleanupPosts(30)"
                :disabled="isCleaningStorage"
                class="px-3 py-1.5 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60 rounded-xl font-medium transition-colors cursor-pointer disabled:opacity-50"
              >
                清理 30 天前数据
              </button>
            </div>
          </div>
        </div>

        <!-- Dynamic Recycle Bin Card (In Settings) -->
        <div id="recycle-bin-section" class="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 class="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
                <Trash2 class="w-4 h-4 text-rose-500" />
                <span>动态回收站 (安全兜底与定向找回)</span>
                <span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800/60">
                  {{ deletedPostCount }} 条记录
                </span>
              </h3>
              <p class="text-xs text-slate-500 mt-1">
                所有手动删除的动态均在此安全兜底。日常“一键同步”默认不拉取回收站中的内容；您可在此随时“定向找回”并即刻无缝还原至动态流，避免误删导致无法恢复。
              </p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                v-if="deletedPostCount > 0"
                @click="handleRestoreAllAndSync"
                class="px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-xs transition-colors cursor-pointer flex items-center gap-1.5"
                title="将回收站中的所有动态定向还原到动态列表"
              >
                <RotateCcw class="w-3.5 h-3.5" />
                <span>全部找回并还原</span>
              </button>
              <button
                type="button"
                v-if="deletedPostCount > 0"
                @click="handleEmptyRecycleBin"
                class="px-3.5 py-1.5 text-xs font-semibold text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer flex items-center gap-1"
                title="彻底清空回收站"
              >
                <span>清空回收站</span>
              </button>
            </div>
          </div>

          <!-- Filter & Search (if records exist) -->
          <div v-if="deletedPostsList.length > 0" class="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <div class="relative flex-1">
              <Search class="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                v-model="deletedPostsSearchQuery"
                type="text"
                placeholder="搜索已删除动态关键词、标题或 ID..."
                class="w-full pl-8.5 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-900 dark:text-white placeholder-slate-400"
              />
            </div>
          </div>

          <!-- Recycle Bin Items List -->
          <div class="space-y-2.5 max-h-96 overflow-y-auto pr-1">
            <div
              v-if="filteredDeletedPostsList.length === 0"
              class="py-8 text-center bg-slate-50/50 dark:bg-slate-850/40 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 text-xs text-slate-400"
            >
              <Trash2 class="w-6 h-6 mx-auto mb-2 text-slate-300 dark:text-slate-600" />
              <span>{{ deletedPostsSearchQuery ? '未找到符合搜索条件的回收站记录' : '回收站为空，暂无已删除动态' }}</span>
            </div>

            <div
              v-for="record in filteredDeletedPostsList"
              :key="record.id"
              class="p-3.5 bg-slate-50/80 dark:bg-slate-850/60 rounded-xl border border-slate-200/80 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs transition-all hover:border-slate-300 dark:hover:border-slate-700"
            >
              <div class="flex items-start gap-3 min-w-0 flex-1">
                <!-- Media cover / thumbnail if available -->
                <div
                  v-if="record.postData?.mediaList?.length"
                  class="w-13 h-13 rounded-lg overflow-hidden bg-slate-200 dark:bg-slate-800 shrink-0 border border-slate-200 dark:border-slate-700"
                >
                  <img
                    :src="toSecureMediaUrl(record.postData.mediaList[0].previewUrl)"
                    referrerpolicy="no-referrer"
                    class="w-full h-full object-cover"
                  />
                </div>

                <div class="min-w-0 space-y-1 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span
                      v-if="record.platform || record.postData?.platform"
                      :class="PLATFORM_REGISTRY[record.platform || record.postData?.platform || '']?.badgeBg"
                      class="px-1.5 py-0.2 rounded text-[9px] font-bold border shrink-0"
                    >
                      {{ PLATFORM_REGISTRY[record.platform || record.postData?.platform || '']?.name || record.platform }}
                    </span>
                    <h4 class="font-bold text-slate-900 dark:text-white truncate max-w-md">
                      {{ record.title || record.postData?.title || '未命名动态' }}
                    </h4>
                  </div>

                  <p v-if="record.postData?.content" class="text-xs text-slate-500 dark:text-slate-400 line-clamp-1">
                    {{ record.postData.content }}
                  </p>

                  <div class="flex items-center gap-2 text-[10px] text-slate-400 flex-wrap">
                    <span class="font-mono truncate max-w-[140px]">ID: {{ record.id }}</span>
                    <span>•</span>
                    <span>删除于 {{ new Date(record.deletedAt).toLocaleString('zh-CN') }}</span>
                    <span v-if="record.postData?.publishedAt">• 发布于 {{ new Date(record.postData.publishedAt).toLocaleDateString('zh-CN') }}</span>
                  </div>
                </div>
              </div>

              <!-- Action buttons on each item -->
              <div class="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                <button
                  type="button"
                  @click="handleRestoreSingleDeleted(record)"
                  class="px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 rounded-xl transition-colors cursor-pointer flex items-center gap-1"
                  title="立即将此动态定向找回并还原到动态流"
                >
                  <RotateCcw class="w-3.5 h-3.5" />
                  <span>定向找回</span>
                </button>
                <a
                  v-if="record.postData?.originalUrl"
                  :href="record.postData.originalUrl"
                  target="_blank"
                  class="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-lg hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-colors"
                  title="打开原帖"
                >
                  <ExternalLink class="w-3.5 h-3.5" />
                </a>
                <button
                  type="button"
                  @click="handlePermanentlyDelete(record)"
                  class="p-1.5 text-slate-400 hover:text-rose-500 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                  title="彻底删除"
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>

    <!-- Modal: Add Creator or Channel -->
    <div
      v-if="showAddModal"
      class="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div class="w-full max-w-md bg-white dark:bg-slate-900 rounded-3xl p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
            <button
              type="button"
              @click="addModalMode = 'new'"
              :class="addModalMode === 'new' ? 'bg-white dark:bg-slate-700 shadow-2xs text-indigo-600 dark:text-indigo-300 font-bold' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'"
              class="px-2.5 py-1 text-xs rounded-lg transition-all cursor-pointer"
            >
              新建创作者
            </button>
            <button
              type="button"
              @click="addModalMode = 'channel'"
              :class="addModalMode === 'channel' ? 'bg-white dark:bg-slate-700 shadow-2xs text-indigo-600 dark:text-indigo-300 font-bold' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'"
              class="px-2.5 py-1 text-xs rounded-lg transition-all cursor-pointer"
            >
              绑定现有创作者
            </button>
          </div>
          <button @click="showAddModal = false" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-sm cursor-pointer p-1">
            ✕
          </button>
        </div>

        <div class="space-y-3 text-xs">
          <!-- Searchable Creator Selection Combobox when in channel mode -->
          <div v-if="addModalMode === 'channel'" class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label class="block font-medium text-slate-700 dark:text-slate-300">选择创作者</label>
              <span class="text-[10px] text-slate-400">支持搜索</span>
            </div>

            <!-- Case A: Creator is chosen and not currently searching/editing -->
            <div
              v-if="selectedCreatorObj && !isEditingCreatorSelection"
              class="flex items-center justify-between p-2.5 bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-200/80 dark:border-indigo-800 rounded-xl"
            >
              <div class="flex items-center gap-2.5 min-w-0">
                <div class="w-8 h-8 rounded-xl bg-indigo-100 dark:bg-indigo-900/60 flex items-center justify-center font-bold text-xs text-indigo-600 dark:text-indigo-300 overflow-hidden shrink-0 border border-indigo-200 dark:border-indigo-800">
                  <img v-if="selectedCreatorObj.avatar" :src="toSecureMediaUrl(selectedCreatorObj.avatar)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
                  <span v-else>{{ selectedCreatorObj.name.slice(0, 1) }}</span>
                </div>
                <div class="min-w-0">
                  <div class="font-bold text-xs text-slate-900 dark:text-white truncate">
                    {{ selectedCreatorObj.name }}
                  </div>
                  <div class="flex items-center gap-1 mt-0.5">
                    <span class="text-[10px] text-slate-500 dark:text-slate-400">
                      已绑 {{ channels.filter(ch => ch.creatorId === selectedCreatorObj.id).length }} 个账号
                    </span>
                    <span v-for="t in selectedCreatorObj.tags?.slice(0, 2)" :key="t" class="text-[9px] px-1 py-0.2 rounded bg-white dark:bg-slate-800 text-slate-500 border border-slate-200/60 dark:border-slate-700">
                      #{{ t }}
                    </span>
                  </div>
                </div>
              </div>
              <button
                type="button"
                @click="isEditingCreatorSelection = true"
                class="px-2.5 py-1 text-xs text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-semibold bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer shrink-0"
              >
                更换
              </button>
            </div>

            <!-- Case B: Search input & live match dropdown -->
            <div v-else class="space-y-1">
              <div class="relative">
                <Search class="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-400" />
                <input
                  v-model="creatorSearchQuery"
                  type="text"
                  placeholder="搜索创作者..."
                  class="w-full pl-8.5 pr-8 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                  autofocus
                />
                <button
                  v-if="creatorSearchQuery"
                  type="button"
                  @click="creatorSearchQuery = ''"
                  class="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                >
                  <X class="w-3.5 h-3.5" />
                </button>
              </div>

              <!-- Candidate Results List -->
              <div class="max-h-44 overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-md divide-y divide-slate-100 dark:divide-slate-700/60">
                <div
                  v-for="c in filteredCandidateCreators"
                  :key="c.id"
                  @click="selectCreator(c)"
                  class="p-2 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-700/60 cursor-pointer transition-colors"
                  :class="{ 'bg-indigo-50/50 dark:bg-indigo-950/40': inputCreatorId === c.id }"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <div class="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-[11px] text-indigo-600 overflow-hidden shrink-0 border border-slate-200 dark:border-slate-600">
                      <img v-if="c.avatar" :src="toSecureMediaUrl(c.avatar)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
                      <span v-else>{{ c.name.slice(0, 1) }}</span>
                    </div>
                    <div class="min-w-0">
                      <div class="font-bold text-xs text-slate-800 dark:text-slate-100 truncate flex items-center gap-1.5">
                        <span>{{ c.name }}</span>
                        <CheckCircle2 v-if="inputCreatorId === c.id" class="w-3 h-3 text-indigo-600 shrink-0" />
                      </div>
                      <div class="flex items-center gap-1 text-[10px] text-slate-400 truncate">
                        <span>已绑 {{ channels.filter(ch => ch.creatorId === c.id).length }} 个账号</span>
                        <span v-for="t in c.tags?.slice(0, 2)" :key="t" class="px-1 py-0.2 rounded bg-slate-100 dark:bg-slate-700 text-slate-500">#{{ t }}</span>
                      </div>
                    </div>
                  </div>
                  <span class="text-[11px] text-indigo-600 dark:text-indigo-400 font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60">选择</span>
                </div>

                <!-- No match state -->
                <div v-if="filteredCandidateCreators.length === 0" class="p-3 text-center text-xs text-slate-400 space-y-1.5">
                  <div>未找到 "{{ creatorSearchQuery }}"</div>
                  <button
                    type="button"
                    @click="switchToNewCreatorWithQuery(creatorSearchQuery)"
                    class="text-indigo-600 dark:text-indigo-400 hover:underline font-semibold cursor-pointer"
                  >
                    + 新建创作者「{{ creatorSearchQuery }}」
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div>
            <label class="block font-medium text-slate-700 dark:text-slate-300 mb-1">创作者链接</label>
            <input
              v-model="inputUrl"
              type="text"
              placeholder="粘贴主页链接、视频链接或 RSS 地址"
              class="w-full px-3 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500"
            />

            <!-- Real-time Parsed Platform & Account Identifier Preview -->
            <div
              v-if="detectedParsedProfile"
              class="mt-2 p-2.5 bg-slate-50 dark:bg-slate-800/80 rounded-xl border border-slate-200 dark:border-slate-700/80 flex items-center justify-between gap-2"
            >
              <div class="flex items-center gap-2 min-w-0">
                <span
                  :class="PLATFORM_REGISTRY[detectedParsedProfile.platform]?.badgeBg"
                  class="px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0"
                >
                  {{ PLATFORM_REGISTRY[detectedParsedProfile.platform]?.name }}
                </span>
                <div class="min-w-0">
                  <div class="font-bold text-xs text-slate-800 dark:text-slate-100 truncate">
                    {{ detectedParsedProfile.suggestedName || detectedParsedProfile.accountId }}
                  </div>
                  <div class="text-[10px] text-slate-400 truncate flex items-center gap-1">
                    <span>ID:</span>
                    <span class="font-mono text-slate-600 dark:text-slate-300">{{ detectedParsedProfile.accountId }}</span>
                  </div>
                </div>
              </div>
              <span class="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold shrink-0">✓ 已识别</span>
            </div>
          </div>

          <!-- Same platform multi-account hint -->
          <div
            v-if="detectedSamePlatformAccounts.length > 0"
            class="p-2.5 bg-sky-50 dark:bg-sky-950/40 rounded-xl border border-sky-200 dark:border-sky-800/60 text-[11px] text-sky-800 dark:text-sky-200 flex items-start gap-2"
          >
            <Sparkles class="w-3.5 h-3.5 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5" />
            <div>
              该创作者已有同平台账号（{{ detectedSamePlatformAccounts[0].displayName || detectedSamePlatformAccounts[0].accountId }}），本次将作为小号/副号一并绑定。
            </div>
          </div>

          <!-- Account Role / Purpose Selection -->
          <div>
            <label class="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">账号类型</label>
            <div class="grid grid-cols-4 gap-1.5">
              <button
                type="button"
                @click="inputRole = 'main'"
                :class="inputRole === 'main' ? 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/80 dark:text-amber-300 dark:border-amber-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
                class="py-1.5 text-[11px] rounded-lg border transition-all cursor-pointer text-center"
              >
                主账号
              </button>
              <button
                type="button"
                @click="inputRole = 'sub'"
                :class="inputRole === 'sub' ? 'bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
                class="py-1.5 text-[11px] rounded-lg border transition-all cursor-pointer text-center"
              >
                小号
              </button>
              <button
                type="button"
                @click="inputRole = 'alt'"
                :class="inputRole === 'alt' ? 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/80 dark:text-rose-300 dark:border-rose-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
                class="py-1.5 text-[11px] rounded-lg border transition-all cursor-pointer text-center"
              >
                里号
              </button>
              <button
                type="button"
                @click="inputRole = 'custom'"
                :class="inputRole === 'custom' ? 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-950/80 dark:text-purple-300 dark:border-purple-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
                class="py-1.5 text-[11px] rounded-lg border transition-all cursor-pointer text-center"
              >
                自定义
              </button>
            </div>
            <!-- Custom Label Input if custom role selected -->
            <div v-if="inputRole === 'custom'" class="mt-2">
              <input
                v-model="inputCustomLabel"
                type="text"
                placeholder="输入自定义标签"
                class="w-full px-3 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div v-if="addModalMode === 'new'">
            <label class="block font-medium text-slate-700 dark:text-slate-300 mb-1">创作者名称</label>
            <input
              v-model="inputName"
              type="text"
              placeholder="如：爱丽丝 / Alice"
              class="w-full px-3 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <!-- Smart suggestion cards when typing an existing creator name -->
            <div
              v-if="existingMatchingCreators.length > 0"
              class="mt-1.5 p-2 bg-indigo-50/90 dark:bg-indigo-950/60 border border-indigo-200/80 dark:border-indigo-800 rounded-xl space-y-1.5"
            >
              <div class="flex items-center justify-between text-[11px] text-indigo-800 dark:text-indigo-300 font-medium">
                <span>已有创作者：</span>
                <span class="text-[10px] text-indigo-500">点击绑定</span>
              </div>
              <div class="space-y-1 max-h-36 overflow-y-auto">
                <div
                  v-for="c in existingMatchingCreators"
                  :key="c.id"
                  @click="addModalMode = 'channel'; selectCreator(c)"
                  class="p-1.5 bg-white dark:bg-slate-800 rounded-lg border border-indigo-100 dark:border-indigo-900/60 flex items-center justify-between gap-2 hover:bg-indigo-100/50 dark:hover:bg-slate-700 cursor-pointer transition-colors shadow-2xs"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <div class="w-6 h-6 rounded-lg bg-indigo-100 dark:bg-indigo-900/60 flex items-center justify-center font-bold text-[10px] text-indigo-600 dark:text-indigo-300 overflow-hidden shrink-0 border border-indigo-200 dark:border-indigo-800">
                      <img v-if="c.avatar" :src="toSecureMediaUrl(c.avatar)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
                      <span v-else>{{ c.name.slice(0, 1) }}</span>
                    </div>
                    <div class="min-w-0">
                      <div class="font-bold text-xs text-slate-900 dark:text-white truncate">
                        {{ c.name }}
                      </div>
                      <div class="text-[9px] text-slate-400 truncate">
                        已绑 {{ channels.filter(ch => ch.creatorId === c.id).length }} 个账号
                        <span v-for="t in c.tags?.slice(0, 2)" :key="t" class="ml-1 px-1 rounded bg-slate-100 dark:bg-slate-700">#{{ t }}</span>
                      </div>
                    </div>
                  </div>
                  <span class="text-[10px] text-indigo-600 dark:text-indigo-400 font-bold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/80 shrink-0">
                    绑定 →
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="addModalMode === 'new'">
            <label class="block font-medium text-slate-700 dark:text-slate-300 mb-1">标签（逗号分隔）</label>
            <input
              v-model="inputTags"
              type="text"
              placeholder="如：ASMR, 插画, 游戏"
              class="w-full px-3 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
          <button
            @click="showAddModal = false"
            class="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl cursor-pointer"
          >
            取消
          </button>
          <button
            @click="submitAdd"
            :disabled="isSubmittingAdd || !inputUrl.trim()"
            class="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-xl shadow-xs cursor-pointer"
          >
            {{ isSubmittingAdd ? '添加中...' : '确认添加' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ==================== MODAL: DEEP HISTORY RETROSPECTIVE SYNC ==================== -->
    <div
      v-if="deepSyncTargetCreator"
      class="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-xl w-full p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-5 animate-scale-up max-h-[90vh] flex flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-bold border border-indigo-100 dark:border-indigo-900">
              <History class="w-4 h-4" />
            </div>
            <div>
              <h3 class="font-bold text-sm text-slate-900 dark:text-white">
                回溯历史 - {{ deepSyncTargetCreator.name }}
              </h3>
              <p class="text-[11px] text-slate-400">
                获取更早的历史动态
              </p>
            </div>
          </div>
          <button
            @click="!isDeepSyncRunning && (deepSyncTargetCreator = null)"
            :disabled="isDeepSyncRunning"
            class="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
          >
            <X class="w-5 h-5" />
          </button>
        </div>

        <!-- Scrollable Modal Body -->
        <div class="space-y-4 overflow-y-auto flex-1 pr-1">
          <!-- 1. Channels Selection -->
          <div class="space-y-2">
            <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              选择要回溯的账号
            </label>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div
                v-for="ch in channels.filter(c => c.creatorId === deepSyncTargetCreator?.id)"
                :key="ch.id"
                @click="!isDeepSyncRunning && toggleDeepSyncChannel(ch.id)"
                :class="deepSyncSelectedChannels.includes(ch.id) ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300' : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-850 text-slate-600 dark:text-slate-400'"
                class="flex items-center gap-2 p-2.5 rounded-xl border transition-all cursor-pointer select-none text-xs"
              >
                <div class="w-4 h-4 flex items-center justify-center shrink-0">
                  <CheckSquare v-if="deepSyncSelectedChannels.includes(ch.id)" class="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <Square v-else class="w-4 h-4 text-slate-400" />
                </div>
                <span :class="PLATFORM_REGISTRY[ch.platform]?.badgeBg" class="px-1.5 py-0.5 rounded text-[10px] font-bold border shrink-0">
                  {{ PLATFORM_REGISTRY[ch.platform]?.name || ch.platform }}
                </span>
                <span class="truncate font-medium">{{ ch.displayName || ch.accountId }}</span>
              </div>
            </div>
            <p v-if="deepSyncSelectedChannels.length === 0" class="text-[11px] text-rose-500">
              请至少选择一个账号
            </p>
          </div>

          <!-- 2. Target Mode: By Count vs By Time Range -->
          <div class="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              回溯范围
            </label>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                :disabled="isDeepSyncRunning"
                @click="deepSyncMode = 'count'"
                :class="deepSyncMode === 'count' ? 'bg-indigo-600 text-white border-indigo-600 shadow-2xs' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-transparent hover:bg-slate-200 dark:hover:bg-slate-700'"
                class="py-2 px-3 rounded-xl border text-xs font-semibold transition-all cursor-pointer text-center"
              >
                按数量
              </button>
              <button
                type="button"
                :disabled="isDeepSyncRunning"
                @click="deepSyncMode = 'time'"
                :class="deepSyncMode === 'time' ? 'bg-indigo-600 text-white border-indigo-600 shadow-2xs' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-transparent hover:bg-slate-200 dark:hover:bg-slate-700'"
                class="py-2 px-3 rounded-xl border text-xs font-semibold transition-all cursor-pointer text-center"
              >
                按时间
              </button>
            </div>
          </div>

          <!-- Sub-mode A: Count Selection -->
          <div v-if="deepSyncMode === 'count'" class="space-y-2 bg-slate-50 dark:bg-slate-850 p-3 rounded-xl border border-slate-200/70 dark:border-slate-800">
            <div class="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 mb-1">
              <span class="font-medium">目标数量：</span>
              <span class="font-bold text-indigo-600 dark:text-indigo-400">
                {{ deepSyncTargetCount === 0 ? '全部' : `${deepSyncTargetCount} 条` }}
              </span>
            </div>

            <!-- Quick Pill Options -->
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="preset in [30, 50, 100, 200, 0]"
                :key="preset"
                type="button"
                :disabled="isDeepSyncRunning"
                @click="deepSyncTargetCount = preset; deepSyncCustomCount = preset"
                :class="deepSyncTargetCount === preset ? 'bg-indigo-600 text-white font-bold' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50'"
                class="px-2.5 py-1 rounded-lg text-xs transition-colors cursor-pointer"
              >
                {{ preset === 0 ? '全部' : `${preset} 条` }}
              </button>
            </div>

            <!-- Custom Number Input -->
            <div class="flex items-center gap-2 pt-2 text-xs">
              <span class="text-slate-500 text-[11px] shrink-0">自定义条数:</span>
              <input
                v-model.number="deepSyncCustomCount"
                @input="deepSyncTargetCount = deepSyncCustomCount"
                type="number"
                min="5"
                max="1000"
                step="10"
                :disabled="isDeepSyncRunning"
                class="w-24 px-2.5 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:ring-1 focus:ring-indigo-500 font-semibold text-slate-800 dark:text-slate-100"
              />
              <span class="text-slate-400 text-[11px]">(建议 30-200)</span>
            </div>
          </div>

          <!-- Sub-mode B: Time Range Selection -->
          <div v-else class="space-y-2 bg-slate-50 dark:bg-slate-850 p-3 rounded-xl border border-slate-200/70 dark:border-slate-800">
            <div class="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 mb-1">
              <span class="font-medium">时间范围：</span>
              <span class="font-bold text-indigo-600 dark:text-indigo-400">
                {{ deepSyncTimeRange === 0 ? '全部历史作品' : `近 ${deepSyncTimeRange} 天内的作品` }}
              </span>
            </div>

            <div class="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
              <button
                v-for="range in [{ days: 30, label: '近 1 个月' }, { days: 90, label: '近 3 个月' }, { days: 180, label: '近半年' }, { days: 365, label: '近 1 年' }, { days: 0, label: '不限时间' }]"
                :key="range.days"
                type="button"
                :disabled="isDeepSyncRunning"
                @click="deepSyncTimeRange = range.days"
                :class="deepSyncTimeRange === range.days ? 'bg-indigo-600 text-white font-bold' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50'"
                class="py-1.5 px-2 rounded-lg text-xs transition-colors cursor-pointer text-center"
              >
                {{ range.label }}
              </button>
            </div>
          </div>

          <!-- Filter Options (Only Original) -->
          <div class="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-850 rounded-xl border border-slate-200/70 dark:border-slate-800 text-xs">
            <div class="space-y-0.5">
              <div class="font-medium text-slate-800 dark:text-slate-200">仅原创</div>
              <div class="text-[11px] text-slate-400">跳过转发内容，专注回溯创作者本人产出的内容</div>
            </div>
            <input
              v-model="deepSyncOnlyOriginal"
              :disabled="isDeepSyncRunning"
              type="checkbox"
              class="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer"
            />
          </div>

          <!-- Reset Cursor Option -->
          <div class="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-850 rounded-xl border border-slate-200/70 dark:border-slate-800 text-xs">
            <div class="space-y-0.5">
              <div class="font-medium text-slate-800 dark:text-slate-200">重置历史进度（重新深度扫描）</div>
              <div class="text-[11px] text-slate-400">若此前已显示到头或需重新扫描修复旧数据，勾选此项重置断点并重新回溯</div>
            </div>
            <input
              v-model="deepSyncResetCursor"
              :disabled="isDeepSyncRunning"
              type="checkbox"
              class="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer"
            />
          </div>

          <!-- Real-time Deep Sync Logs & Status Window -->
          <div v-if="deepSyncLogs.length > 0 || isDeepSyncRunning" class="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div class="flex items-center justify-between text-xs">
              <span class="font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                <span v-if="isDeepSyncRunning" class="w-2 h-2 rounded-full bg-indigo-500 animate-ping"></span>
                <span>{{ deepSyncCurrentStatus || '回溯中...' }}</span>
              </span>
              <span class="font-bold text-indigo-600 dark:text-indigo-400">
                已获取 {{ deepSyncTotalNew }} 条
              </span>
            </div>
            <div class="p-2.5 bg-slate-900 text-emerald-400 font-mono text-[11px] rounded-xl h-28 overflow-y-auto space-y-1">
              <div v-for="(log, idx) in deepSyncLogs" :key="idx" class="leading-relaxed">
                {{ log }}
              </div>
            </div>
          </div>
        </div>

        <!-- Footer Action Buttons -->
        <div class="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800 shrink-0">
          <button
            v-if="isDeepSyncRunning"
            @click="stopDeepSync"
            class="flex items-center gap-1.5 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-xs font-semibold cursor-pointer shadow-xs"
          >
            <StopCircle class="w-4 h-4" />
            <span>停止</span>
          </button>
          <div v-else class="text-[11px] text-slate-400">
            已抓取历史动态自动去重存入本地
          </div>

          <div class="flex items-center gap-2">
            <button
              @click="deepSyncTargetCreator = null"
              :disabled="isDeepSyncRunning"
              class="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl cursor-pointer disabled:opacity-50"
            >
              关闭
            </button>
            <button
              v-if="!isDeepSyncRunning"
              @click="startDeepSync"
              :disabled="deepSyncSelectedChannels.length === 0"
              class="flex items-center gap-1.5 px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-xl shadow-xs cursor-pointer"
            >
              <Play class="w-3.5 h-3.5" />
              <span>开始回溯</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== MODAL: QUICK EDIT CREATOR TAGS ==================== -->
    <div
      v-if="editingTagCreator"
      class="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4 animate-scale-up">
        <!-- Modal Header -->
        <div class="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
          <div class="flex items-center gap-2">
            <div class="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center text-indigo-600">
              <Tag class="w-4 h-4" />
            </div>
            <div>
              <h3 class="font-bold text-sm text-slate-900 dark:text-white">编辑标签 - {{ editingTagCreator.name }}</h3>
              <p class="text-[11px] text-slate-500">管理此创作者的分类标签</p>
            </div>
          </div>
          <button
            type="button"
            @click="editingTagCreator = null"
            class="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <!-- Tags Active Badges & Management -->
        <div class="space-y-3">
          <div>
            <div class="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              <span>已有标签：</span>
              <span class="text-[11px] font-normal text-slate-400">点击 ✕ 移除</span>
            </div>
            
            <div v-if="editingTagsList.length > 0" class="flex flex-wrap gap-1.5 p-2.5 bg-slate-50 dark:bg-slate-800/70 border border-slate-200/80 dark:border-slate-700 rounded-xl min-h-[42px]">
              <span
                v-for="t in editingTagsList"
                :key="'active-' + t"
                class="group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-indigo-50 text-indigo-700 dark:bg-indigo-950/70 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 transition-colors"
              >
                <span>#{{ t }}</span>
                <button
                  type="button"
                  @click="removeTagFromEditingList(t)"
                  class="w-3.5 h-3.5 rounded-full hover:bg-indigo-200 dark:hover:bg-indigo-800 flex items-center justify-center text-indigo-500 hover:text-indigo-800 dark:hover:text-white transition-colors cursor-pointer"
                  title="移除此标签"
                >
                  <X class="w-2.5 h-2.5" />
                </button>
              </span>
            </div>
            <div v-else class="p-3 bg-slate-50 dark:bg-slate-800/40 border border-dashed border-slate-200 dark:border-slate-700 rounded-xl text-center text-xs text-slate-400">
              暂无标签，在下方输入或选择常用标签
            </div>
          </div>

          <!-- Add New Tag Input -->
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              添加标签：
            </label>
            <div class="flex items-center gap-2">
              <div class="relative flex-1">
                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-bold">#</span>
                <input
                  v-model="newTagInput"
                  @keydown.enter.prevent="addTagToEditingList()"
                  type="text"
                  placeholder="输入标签名..."
                  class="w-full pl-7 pr-3.5 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-2 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
                />
              </div>
              <button
                type="button"
                @click="addTagToEditingList()"
                class="px-3.5 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-xs transition-colors cursor-pointer shrink-0 flex items-center gap-1"
              >
                <Plus class="w-3.5 h-3.5" />
                <span>添加</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Quick suggestion tags from existing library & Global Management -->
        <div v-if="allTags.length > 0" class="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
          <div class="flex items-center justify-between text-[11px] text-slate-400">
            <span>常用标签：</span>
          </div>
          <div class="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto pr-1">
            <div
              v-for="t in allTags"
              :key="'suggest-' + t"
              class="inline-flex items-center rounded-lg border text-[11px] transition-colors overflow-hidden"
              :class="editingTagsList.includes(t)
                ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-950/60 dark:border-indigo-700 dark:text-indigo-300 font-semibold'
                : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200/80 dark:hover:bg-slate-700/80'"
            >
              <button
                type="button"
                @click="toggleTagInEditingList(t)"
                class="px-2 py-1 cursor-pointer flex items-center gap-1"
                :title="editingTagsList.includes(t) ? '点击取消为此博主关联此标签' : '点击为此博主添加此标签'"
              >
                <span>{{ editingTagsList.includes(t) ? '✓' : '+' }}</span>
                <span>#{{ t }}</span>
              </button>
              <!-- Global Delete Tag from entire system -->
              <button
                type="button"
                @click.stop="deleteGlobalTag(t)"
                class="px-1.5 py-1 text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition-colors border-l border-slate-200/60 dark:border-slate-700/60 cursor-pointer"
                title="删除此标签"
              >
                <Trash2 class="w-2.5 h-2.5" />
              </button>
            </div>
          </div>
        </div>

        <!-- Modal Footer -->
        <div class="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
          <button
            type="button"
            @click="editingTagCreator = null"
            class="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            @click="saveCreatorTags"
            class="px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-xs cursor-pointer"
          >
            保存修改
          </button>
        </div>
      </div>
    </div>

    <MediaLightbox v-if="lightboxMedia" :media="lightboxMedia" @close="lightboxMedia = null" />
  </div>
  <!-- Avatar Picker Modal -->
  <div v-if="avatarPickerCreator" class="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4" @click.self="avatarPickerCreator = null">
    <div class="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 shadow-2xl space-y-4">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
        <div>
          <h3 class="font-bold text-sm text-slate-900 dark:text-white">选择主展示头像</h3>
          <p class="text-[11px] text-slate-400 mt-0.5">{{ avatarPickerCreator.name }} · 从已绑定的各平台账号中挑选</p>
        </div>
        <button class="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer" @click="avatarPickerCreator = null">
          <X class="w-4 h-4" />
        </button>
      </div>

      <div class="space-y-2 max-h-72 overflow-y-auto pr-1">
        <button
          v-for="ch in channels.filter(item => item.creatorId === avatarPickerCreator?.id && item.avatarUrl)"
          :key="ch.id"
          class="w-full flex items-center justify-between p-2.5 rounded-xl border transition-all text-left cursor-pointer group"
          :class="getCreatorAvatar(avatarPickerCreator) === toSecureMediaUrl(ch.avatarUrl) ? 'bg-indigo-50/60 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-700' : 'bg-slate-50/50 dark:bg-slate-800/40 border-slate-200/60 dark:border-slate-700/60 hover:bg-indigo-50/30 dark:hover:bg-slate-800 hover:border-indigo-200'"
          @click="selectPrimaryAvatar(avatarPickerCreator!, ch.avatarUrl!)"
        >
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-full overflow-hidden border border-slate-200 dark:border-slate-700 shrink-0 shadow-2xs">
              <img :src="toSecureMediaUrl(ch.avatarUrl)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
            </div>
            <div class="min-w-0">
              <div class="font-semibold text-xs text-slate-800 dark:text-slate-200 truncate">
                {{ ch.displayName || ch.accountId }}
              </div>
              <div class="flex items-center gap-1.5 mt-0.5">
                <span :class="PLATFORM_REGISTRY[ch.platform]?.badgeBg" class="px-1.5 py-0.2 rounded text-[9px] font-bold border">
                  {{ PLATFORM_REGISTRY[ch.platform]?.name || ch.platform }}
                </span>
                <span class="text-[10px] text-slate-400 font-mono truncate max-w-[120px]">
                  {{ ch.accountId }}
                </span>
              </div>
            </div>
          </div>

          <div class="shrink-0 ml-2">
            <span v-if="getCreatorAvatar(avatarPickerCreator) === toSecureMediaUrl(ch.avatarUrl)" class="flex items-center gap-1 text-[11px] font-bold text-indigo-600 dark:text-indigo-400">
              <CheckCircle2 class="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>当前主头像</span>
            </span>
            <span v-else class="text-[10px] text-slate-400 group-hover:text-indigo-600 group-hover:underline">
              设为主头像
            </span>
          </div>
        </button>

        <p v-if="!channels.some(item => item.creatorId === avatarPickerCreator?.id && item.avatarUrl)" class="text-xs text-slate-400 py-6 text-center">
          当前创作者绑定的账号暂未获取到有效平台头像，点击账号旁的同步按钮拉取最新数据。
        </p>
      </div>

      <div class="pt-2 border-t border-slate-100 dark:border-slate-800 flex justify-end">
        <button
          @click="avatarPickerCreator = null"
          class="px-4 py-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
        >
          关闭
        </button>
      </div>
    </div>
  </div>

  <!-- Modal: Deleted Posts Management -->
  <div
    v-if="showDeletedPostsModal"
    class="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
    @click.self="showDeletedPostsModal = false"
  >
    <div class="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-3xl p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4 max-h-[85vh] flex flex-col">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
        <div>
          <h3 class="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
            <Trash2 class="w-4 h-4 text-rose-500" />
            <span>已删除动态管理</span>
            <span class="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-normal">
              共 {{ deletedPostsList.length }} 条记录
            </span>
          </h3>
          <p class="text-xs text-slate-500 mt-1">
            已记录动态的内联 ID。顶部“一键同步”默认跳过这些动态。点击“恢复”可解除过滤，下次同步时重新拉取。
          </p>
        </div>
        <button
          type="button"
          class="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          @click="showDeletedPostsModal = false"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Search box if multiple records -->
      <div v-if="deletedPostsList.length > 3" class="relative shrink-0">
        <Search class="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          v-model="deletedPostsSearchQuery"
          type="text"
          placeholder="搜索已删除动态标题或 ID..."
          class="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-900 dark:text-white placeholder-slate-400"
        />
      </div>

      <!-- Records List -->
      <div class="flex-1 overflow-y-auto space-y-2 pr-1 min-h-[160px]">
        <div v-if="filteredDeletedPostsList.length === 0" class="py-12 text-center text-xs text-slate-400">
          {{ deletedPostsSearchQuery ? '没有找到匹配的记录' : '暂无已删除动态记录' }}
        </div>
        <div
          v-for="record in filteredDeletedPostsList"
          :key="record.id"
          class="p-3 bg-slate-50/80 dark:bg-slate-850/60 rounded-xl border border-slate-200/70 dark:border-slate-800 flex items-center justify-between gap-3 text-xs"
        >
          <div class="flex items-center gap-3 min-w-0">
            <div
              v-if="record.postData?.mediaList?.length"
              class="w-11 h-11 rounded-lg overflow-hidden bg-slate-200 dark:bg-slate-800 shrink-0 border border-slate-200 dark:border-slate-700"
            >
              <img
                :src="toSecureMediaUrl(record.postData.mediaList[0].previewUrl)"
                referrerpolicy="no-referrer"
                class="w-full h-full object-cover"
              />
            </div>
            <div class="min-w-0 space-y-0.5">
              <div class="flex items-center gap-2 min-w-0">
                <span
                  v-if="record.platform || record.postData?.platform"
                  :class="PLATFORM_REGISTRY[record.platform || record.postData?.platform || '']?.badgeBg"
                  class="px-1.5 py-0.2 rounded text-[9px] font-bold border shrink-0"
                >
                  {{ PLATFORM_REGISTRY[record.platform || record.postData?.platform || '']?.name || record.platform }}
                </span>
                <span class="font-medium text-slate-800 dark:text-slate-200 truncate max-w-sm">
                  {{ record.title || record.postData?.title || '未命名动态' }}
                </span>
              </div>
              <div class="flex items-center gap-2 text-[10px] text-slate-400">
                <span class="font-mono">ID: {{ record.id }}</span>
                <span>•</span>
                <span>删除于 {{ new Date(record.deletedAt).toLocaleString('zh-CN') }}</span>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              @click="handleRestoreSingleDeleted(record)"
              class="px-2.5 py-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 rounded-lg transition-colors cursor-pointer flex items-center gap-1"
              title="立即将此动态定向找回并无缝还原至动态流"
            >
              <RotateCcw class="w-3 h-3" />
              <span>定向找回</span>
            </button>
            <button
              type="button"
              @click="handlePermanentlyDelete(record)"
              class="p-1 text-slate-400 hover:text-rose-500 rounded-md hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
              title="彻底删除"
            >
              <Trash2 class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      <!-- Modal Footer -->
      <div class="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
        <div>
          <button
            v-if="deletedPostsList.length > 0"
            type="button"
            @click="handleRestoreAllAndSync"
            class="px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 rounded-xl transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <RotateCcw class="w-3.5 h-3.5" />
            <span>全部定向找回并还原</span>
          </button>
        </div>
        <button
          type="button"
          @click="showDeletedPostsModal = false"
          class="px-4 py-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
        >
          完成
        </button>
      </div>
    </div>
  </div>
</template>
