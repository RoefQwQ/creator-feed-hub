<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { db } from '../../src/db';
import { parseProfileUrl, type ParsedProfile } from '../../src/utils/urlParser';
import { toSecureMediaUrl } from '../../src/utils/media';
import { bgFetch } from '../../src/utils/http';
import { PLATFORM_REGISTRY, type Creator, type Channel } from '../../src/types';
import { updateChannel, clearStaleUpdatingStatus } from '../../src/adapters';
import {
  ExternalLink,
  PlusCircle,
  Check,
  Link as LinkIcon,
  Globe,
  LayoutDashboard,
  UserPlus,
  Radio,
  AlertCircle,
  Search,
  X,
  CheckCircle2
} from 'lucide-vue-next';

const loading = ref(true);
const currentUrl = ref('');
const parsed = ref<ParsedProfile | null>(null);
const existingChannel = ref<Channel | null>(null);
const existingCreator = ref<Creator | null>(null);
const creators = ref<Creator[]>([]);
const channels = ref<Channel[]>([]);

// Form inputs
const mode = ref<'new' | 'bind'>('new');
const manualUrl = ref('');
const newCreatorName = ref('');
const newCreatorTags = ref('');
const selectedCreatorId = ref('');
const creatorSearchQuery = ref('');
const isEditingCreatorSelection = ref(false);
const accountRole = ref<'main' | 'sub' | 'alt' | 'custom'>('main');
const customLabel = ref('');
const saving = ref(false);
const saveSuccess = ref(false);

const selectedCreatorObj = computed(() => {
  return creators.value.find(c => c.id === selectedCreatorId.value);
});

// Live matching existing creators when typing in newCreatorName
const matchedExistingCreators = computed(() => {
  const q = newCreatorName.value.trim().toLowerCase();
  if (!q) return [];
  return creators.value.filter(c => {
    const matchName = c.name.toLowerCase().includes(q);
    const matchTag = c.tags?.some(t => t.toLowerCase().includes(q));
    const matchNote = c.note?.toLowerCase().includes(q);
    const matchId = c.id.toLowerCase().includes(q);
    return matchName || matchTag || matchNote || matchId;
  });
});

// Filtered candidates when searching in bind mode
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

function selectCreator(c: Creator) {
  selectedCreatorId.value = c.id;
  mode.value = 'bind';
  isEditingCreatorSelection.value = false;
  creatorSearchQuery.value = '';
}

function switchToNewCreatorWithQuery(name?: string) {
  mode.value = 'new';
  if (name) newCreatorName.value = name;
  selectedCreatorId.value = '';
}

const detectedAuthorMeta = ref<{ name?: string; avatar?: string }>({});

const activeDisplayName = computed(() => {
  if (detectedAuthorMeta.value.name) return detectedAuthorMeta.value.name;
  if (parsed.value?.suggestedName && parsed.value.suggestedName !== parsed.value.accountId) {
    return parsed.value.suggestedName;
  }
  return parsed.value?.suggestedName || parsed.value?.accountId || '';
});

const isRplayTab = computed(() => {
  return currentUrl.value.includes('rplay.live');
});
const rplaySyncState = ref<'idle' | 'syncing' | 'synced' | 'failed'>('idle');
const rplaySyncMessage = ref('');

async function triggerRplaySync() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  rplaySyncState.value = 'syncing';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SYNC_RPLAY_TOKEN' });
    if (res?.success) {
      rplaySyncState.value = 'synced';
      rplaySyncMessage.value = '已成功同步登录凭证 ✓';
    } else {
      // Check if already stored in local storage
      const stored = await chrome.storage?.local?.get('rplay_auth_token');
      if (stored?.rplay_auth_token) {
        rplaySyncState.value = 'synced';
        rplaySyncMessage.value = '已使用之前保存的凭证 ✓';
      } else {
        rplaySyncState.value = 'failed';
        rplaySyncMessage.value = res?.error || '未在当前页面检测到有效登录 Token';
      }
    }
  } catch (e: any) {
    rplaySyncState.value = 'failed';
    rplaySyncMessage.value = '提取失败: ' + (e?.message || e);
  }
}

/**
 * Executes lightweight in-page DOM script to extract author real name & avatar from current active tab
 */
async function extractActiveTabAuthorMeta(tabId: number, tabUrl?: string) {
  if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) return;
  if (!tabUrl || /^(chrome|edge|about|devtools):/i.test(tabUrl)) return;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        let name = '';
        let avatar = '';
        const host = window.location.hostname.toLowerCase();

        // 1. YouTube
        if (host.includes('youtube.com')) {
          // Name
          const ytNameEl = document.querySelector('ytd-channel-name yt-formatted-string, #channel-name #text, #channel-header #text');
          if (ytNameEl?.textContent?.trim()) {
            name = ytNameEl.textContent.trim();
          } else {
            const ogTitle = (document.querySelector('meta[property="og:title"]') as HTMLMetaElement)?.content;
            if (ogTitle) {
              name = ogTitle.trim();
            } else if (document.title) {
              name = document.title.replace(/\s*-\s*YouTube$/i, '').trim();
            }
          }
          // Avatar
          const ytAvatarImg = document.querySelector('#channel-header img#img, ytd-channel-avatar-editor img, #avatar img') as HTMLImageElement;
          if (ytAvatarImg?.src && !ytAvatarImg.src.startsWith('data:')) {
            avatar = ytAvatarImg.src;
          } else {
            const ogImg = (document.querySelector('meta[property="og:image"]') as HTMLMetaElement)?.content;
            if (ogImg) avatar = ogImg;
          }
        }
        // 2. Twitter / X
        else if (host.includes('twitter.com') || host.includes('x.com')) {
          const userNameEl = document.querySelector('div[data-testid="UserName"]');
          if (userNameEl) {
            const spans = Array.from(userNameEl.querySelectorAll('span'));
            // First non-empty span that doesn't start with @
            const titleSpan = spans.find(s => s.textContent?.trim() && !s.textContent.trim().startsWith('@'));
            if (titleSpan?.textContent?.trim()) {
              name = titleSpan.textContent.trim();
            }
          }
          const xAvatarImg = document.querySelector('div[data-testid="UserAvatar-Container-unknown"] img, div[data-testid*="UserAvatar"] img') as HTMLImageElement;
          if (xAvatarImg?.src) {
            avatar = xAvatarImg.src;
          }
        }
        else if (host.includes('bilibili.com')) {
          // Exclude viewer's top navigation bar (.bili-header, .mini-header, etc.)
          const notInGlobalHeader = (el: Element | null): boolean => {
            if (!el) return false;
            return !el.closest('#bili-header, .bili-header, .bili-header__bar, .mini-header, .international-header');
          };

          // 1. Author name
          const nameCandidates = [
            document.querySelector('#h-name'),
            document.querySelector('#space-header #h-name'),
            document.querySelector('.up-name'),
            document.querySelector('.user-name'),
            document.querySelector('.nickname'),
          ];
          for (const cand of nameCandidates) {
            if (cand && notInGlobalHeader(cand) && cand.textContent?.trim()) {
              name = cand.textContent.trim();
              break;
            }
          }

          // 2. Creator avatar strictly within space header / UP info
          const spaceHeader = document.querySelector('#wrapper #header, #space-header, .space-header, #h-center, .space-header-avatar, #h-avatar');
          if (spaceHeader) {
            const upAvatarImg = spaceHeader.querySelector('#h-avatar img, .h-avatar img, img[src*="bfs/face"], img[src*="hdslb.com/bfs/face"], img') as HTMLImageElement | null;
            if (upAvatarImg && notInGlobalHeader(upAvatarImg)) {
              avatar = upAvatarImg.currentSrc || upAvatarImg.src || '';
            }
          }

          if (!avatar) {
            // Find avatars specifically excluding top header
            const avatarNodes = Array.from(document.querySelectorAll('#h-avatar img, .space-header-avatar img, .up-info__avatar img, img[src*="hdslb.com/bfs/face"]'));
            for (const node of avatarNodes) {
              if (notInGlobalHeader(node) && (node as HTMLImageElement).src) {
                avatar = (node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src;
                break;
              }
            }
          }
        }
        // 4. Xiaohongshu
        else if (host.includes('xiaohongshu.com')) {
          const xhsName = document.querySelector('.user-name, .user-nickname, .info-part .name')?.textContent?.trim();
          if (xhsName) name = xhsName;
          const xhsAvatar = (document.querySelector('.avatar-wrapper img, .user-avatar img') as HTMLImageElement)?.src;
          if (xhsAvatar) avatar = xhsAvatar;
        }
        // 5. Weibo
        else if (host.includes('weibo.com') || host.includes('weibo.cn')) {
          const wbName = document.querySelector('.profile_name, .username')?.textContent?.trim();
          if (wbName) name = wbName;
          const wbAvatar = (document.querySelector('.profile_avatar img, .woo-avatar-main') as HTMLImageElement)?.src;
          if (wbAvatar) avatar = wbAvatar;
        }

        // Fallback meta tags
        if (!name) {
          const ogTitle = (document.querySelector('meta[property="og:title"]') as HTMLMetaElement)?.content;
          if (ogTitle) name = ogTitle.trim();
        }
        if (!avatar) {
          const ogImg = (document.querySelector('meta[property="og:image"]') as HTMLMetaElement)?.content;
          if (ogImg) avatar = ogImg;
        }

        return { name, avatar };
      },
    });

    if (results?.[0]?.result) {
      const { name, avatar } = results[0].result;
      if (name) {
        detectedAuthorMeta.value.name = name;
        newCreatorName.value = name;
      }
      if (avatar) {
        detectedAuthorMeta.value.avatar = toSecureMediaUrl(avatar);
      }
    }

    // Authoritative fallback for Bilibili: public User Card API directly by UID
    if (parsed.value?.platform === 'bilibili' && parsed.value.accountId) {
      try {
        const cardRes = await bgFetch(`https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(parsed.value.accountId)}`);
        if (cardRes.ok && cardRes.data) {
          const cardJson = JSON.parse(cardRes.data);
          if (cardJson?.code === 0 && cardJson?.data?.card) {
            const cardData = cardJson.data.card;
            if (cardData.name) {
              detectedAuthorMeta.value.name = cardData.name;
              newCreatorName.value = cardData.name;
            }
            if (cardData.face) {
              detectedAuthorMeta.value.avatar = toSecureMediaUrl(cardData.face);
            }
          }
        }
      } catch (e) {
        console.warn('[Popup] Bilibili card API fetch skipped:', e);
      }
    }
  } catch (err) {
    console.warn('Scripting DOM extraction skipped or not allowed on this tab:', err);
  }
}

onMounted(async () => {
  try {
    await clearStaleUpdatingStatus();
    creators.value = await db.creators.toArray();
    channels.value = await db.channels.toArray();

    // Query active tab
    if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) {
        currentUrl.value = tab.url;
        await handleUrl(tab.url);

        if (tab.id) {
          await extractActiveTabAuthorMeta(tab.id, tab.url);
        }

        if (tab.url.includes('rplay.live')) {
          // Check if token already exists first
          const stored = await chrome.storage?.local?.get('rplay_auth_token');
          if (stored?.rplay_auth_token) {
            rplaySyncState.value = 'synced';
            rplaySyncMessage.value = '已同步登录凭证 ✓';
          }
          // Also trigger live sync from tab
          triggerRplaySync();
        }
      }
    }
  } catch (e) {
    console.error('Failed to init popup', e);
  } finally {
    loading.value = false;
  }
});

const samePlatformAccounts = computed(() => {
  if (!parsed.value || !selectedCreatorId.value || mode.value !== 'bind') return [];
  return channels.value.filter(
    ch => ch.creatorId === selectedCreatorId.value && ch.platform === parsed.value?.platform
  );
});

async function handleUrl(urlStr: string) {
  const res = parseProfileUrl(urlStr);
  parsed.value = res;
  if (res) {
    if (!newCreatorName.value || newCreatorName.value === res.accountId) {
      newCreatorName.value = res.suggestedName || '';
    }
    const channelId = `${res.platform}:${res.accountId}`;
    const foundCh = await db.channels.get(channelId);
    if (foundCh) {
      existingChannel.value = foundCh;
      existingCreator.value = (await db.creators.get(foundCh.creatorId)) || null;
    } else {
      existingChannel.value = null;
      existingCreator.value = null;
      if (creators.value.length > 0) {
        selectedCreatorId.value = creators.value[0].id;
      }
    }

    // If platform is Bilibili, proactively fetch authoritative public card info
    if (res.platform === 'bilibili' && res.accountId) {
      try {
        const cardRes = await bgFetch(`https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(res.accountId)}`);
        if (cardRes.ok && cardRes.data) {
          const cardJson = JSON.parse(cardRes.data);
          if (cardJson?.code === 0 && cardJson?.data?.card) {
            const cardData = cardJson.data.card;
            if (cardData.name) {
              detectedAuthorMeta.value.name = cardData.name;
              newCreatorName.value = cardData.name;
            }
            if (cardData.face) {
              detectedAuthorMeta.value.avatar = toSecureMediaUrl(cardData.face);
            }
          }
        }
      } catch (e) {
        console.warn('[Popup] Bilibili card fetch in handleUrl skipped:', e);
      }
    }
  }
}

function handleManualParse() {
  if (!manualUrl.value) return;
  detectedAuthorMeta.value = {};
  handleUrl(manualUrl.value);
}

async function handleSave() {
  if (!parsed.value) return;
  saving.value = true;

  try {
    let targetCreatorId = selectedCreatorId.value;

    if (mode.value === 'new' || !targetCreatorId) {
      const creatorName = newCreatorName.value.trim() || activeDisplayName.value || parsed.value.suggestedName || '新创作者';
      const tags = newCreatorTags.value
        .split(/[,，\s]+/)
        .map(t => t.trim())
        .filter(Boolean);

      const newCreator: Creator = {
        id: 'c_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        name: creatorName,
        avatar: detectedAuthorMeta.value.avatar || '',
        tags,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await db.creators.add(newCreator);
      targetCreatorId = newCreator.id;
      creators.value.push(newCreator);
    }

    const channelId = `${parsed.value.platform}:${parsed.value.accountId}`;
    const roleLabel = accountRole.value === 'custom'
      ? (customLabel.value.trim() || '自定义频道')
      : (accountRole.value === 'main' ? '主账号' : accountRole.value === 'sub' ? '日常小号' : '里号/差分');

    const channelDisplayName = activeDisplayName.value || parsed.value.suggestedName || parsed.value.accountId;

    const newChannel: Channel = {
      id: channelId,
      creatorId: targetCreatorId,
      platform: parsed.value.platform,
      accountId: parsed.value.accountId,
      displayName: channelDisplayName,
      avatarUrl: detectedAuthorMeta.value.avatar || undefined,
      profileUrl: parsed.value.cleanUrl,
      label: roleLabel,
      accountRole: accountRole.value,
      status: 'idle',
    };

    await db.channels.put(newChannel);

    // Trigger on-demand initial fetch
    updateChannel(newChannel, 5).catch(console.error);

    saveSuccess.value = true;
    existingChannel.value = newChannel;
    existingCreator.value = (await db.creators.get(targetCreatorId)) || null;
  } catch (err) {
    console.error('Save failed', err);
  } finally {
    saving.value = false;
  }
}

function openDashboard() {
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    chrome.tabs.create({
      url: chrome.runtime.getURL('/dashboard.html'),
    });
  } else {
    window.open('/dashboard.html', '_blank');
  }
}

const currentPlatformMeta = computed(() => {
  return parsed.value ? PLATFORM_REGISTRY[parsed.value.platform] : null;
});
</script>

<template>
  <div class="p-4 flex flex-col justify-between min-h-[460px] text-xs">
    <!-- Header -->
    <div class="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
      <div class="flex items-center gap-2.5">
        <img src="/icons/icon-48.png" class="w-7 h-7 rounded-xl shadow-xs shrink-0" alt="Creator Feed Hub" />
        <div>
          <h1 class="font-bold text-sm tracking-tight text-slate-900 dark:text-white">Creator Feed Hub</h1>
          <p class="text-[10px] text-slate-500">创作者聚合追踪</p>
        </div>
      </div>
      <button
        @click="openDashboard"
        title="打开面板"
        class="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:text-indigo-300 dark:hover:bg-indigo-900/50 rounded-md transition-colors cursor-pointer"
      >
        <LayoutDashboard class="w-3.5 h-3.5" />
        <span>打开面板</span>
      </button>
    </div>

    <!-- Rplay Page Live Sync Banner -->
    <div
      v-if="isRplayTab"
      class="mt-2.5 p-2 rounded-xl border text-xs flex items-center justify-between gap-2"
      :class="rplaySyncState === 'synced' ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200' : 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200'"
    >
      <div class="flex items-center gap-1.5 min-w-0">
        <Check v-if="rplaySyncState === 'synced'" class="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <Radio v-else class="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 animate-pulse" />
        <span class="truncate text-[11px]">
          {{ rplaySyncState === 'synced' ? '已自动从当前页面同步 Rplay 登录凭证' : (rplaySyncState === 'syncing' ? '正在提取登录凭据...' : (rplaySyncMessage || '检测到 Rplay 页面，可同步登录凭证')) }}
        </span>
      </div>
      <button
        v-if="rplaySyncState !== 'synced'"
        @click="triggerRplaySync"
        class="shrink-0 px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-[10px] font-medium transition-colors cursor-pointer"
      >
        一键同步
      </button>
      <span v-else class="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">✓ 就绪</span>
    </div>

    <!-- Body content -->
    <div class="my-3 flex-1">
      <!-- Loading -->
      <div v-if="loading" class="py-12 text-center text-slate-400">
        正在识别...
      </div>

      <!-- Detected Platform Card -->
      <div v-else-if="parsed" class="space-y-3">
        <!-- Target Info -->
        <div class="p-3 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-xs">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-1.5">
              <span
                :class="currentPlatformMeta?.badgeBg"
                class="px-2 py-0.5 rounded-full text-[10px] font-semibold border"
              >
                {{ currentPlatformMeta?.name }}
              </span>
              <span class="text-slate-400 text-[10px]">已识别</span>
            </div>
            <a
              :href="parsed.cleanUrl"
              target="_blank"
              class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              <ExternalLink class="w-3.5 h-3.5" />
            </a>
          </div>

          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 flex items-center justify-center font-bold text-sm text-indigo-600 dark:text-indigo-300 overflow-hidden shrink-0 shadow-2xs">
              <img
                v-if="detectedAuthorMeta.avatar"
                :src="toSecureMediaUrl(detectedAuthorMeta.avatar)"
                class="w-full h-full object-cover"
                referrerpolicy="no-referrer"
              />
              <span v-else>{{ (activeDisplayName || parsed.accountId).slice(0, 1) }}</span>
            </div>

            <div class="min-w-0 flex-1">
              <div class="font-bold text-slate-800 dark:text-slate-100 text-sm truncate flex items-center gap-1.5">
                <span>{{ activeDisplayName || parsed.accountId }}</span>
                <span v-if="detectedAuthorMeta.name" class="px-1.5 py-0.2 rounded text-[9px] bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 shrink-0">
                  页面昵称
                </span>
              </div>
              <div class="text-[11px] text-slate-400 truncate mt-0.5 flex items-center gap-1">
                <span>ID:</span>
                <span class="font-mono text-slate-500 dark:text-slate-400">{{ parsed.accountId }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- If Already Added -->
        <div
          v-if="existingChannel"
          class="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 rounded-xl text-emerald-800 dark:text-emerald-200"
        >
          <div class="flex items-center gap-1.5 font-semibold text-xs mb-1">
            <Check class="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <span>已关注</span>
          </div>
          <p class="text-[11px] text-emerald-700 dark:text-emerald-300">
            已归集到 <strong>{{ existingCreator?.name || '未知创作者' }}</strong>
          </p>
          <button
            @click="openDashboard"
            class="mt-2.5 w-full py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium transition-colors cursor-pointer"
          >
            查看动态
          </button>
        </div>

        <!-- Add Options -->
        <div v-else class="space-y-3">
          <div class="flex gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
            <button
              @click="mode = 'new'"
              :class="mode === 'new' ? 'bg-white dark:bg-slate-700 shadow-xs text-slate-900 dark:text-white font-medium' : 'text-slate-500'"
              class="flex-1 py-1 text-center rounded-md text-[11px] transition-all cursor-pointer"
            >
              新建创作者
            </button>
            <button
              @click="mode = 'bind'"
              :disabled="creators.length === 0"
              :class="mode === 'bind' ? 'bg-white dark:bg-slate-700 shadow-xs text-slate-900 dark:text-white font-medium' : 'text-slate-500'"
              class="flex-1 py-1 text-center rounded-md text-[11px] transition-all disabled:opacity-40 cursor-pointer"
            >
              绑定到已有 ({{ creators.length }})
            </button>
          </div>

          <!-- Mode: New Creator -->
          <div v-if="mode === 'new'" class="space-y-2">
            <div>
              <label class="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">创作者名称</label>
              <div class="relative">
                <input
                  v-model="newCreatorName"
                  type="text"
                  placeholder="例如：爱丽丝 / Alice"
                  class="w-full px-2.5 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 outline-none"
                />
              </div>

              <!-- Associated existing creators live suggestions -->
              <div
                v-if="matchedExistingCreators.length > 0"
                class="mt-1.5 p-2 bg-indigo-50/90 dark:bg-indigo-950/60 border border-indigo-200/80 dark:border-indigo-800 rounded-xl space-y-1.5"
              >
                <div class="flex items-center justify-between text-[11px] text-indigo-800 dark:text-indigo-300 font-medium">
                  <span>已有创作者：</span>
                  <span class="text-[10px] text-indigo-500">点击绑定</span>
                </div>
                <div class="space-y-1 max-h-32 overflow-y-auto">
                  <div
                    v-for="c in matchedExistingCreators"
                    :key="c.id"
                    @click="selectCreator(c)"
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
                          <span v-for="t in c.tags?.slice(0, 1)" :key="t" class="ml-1 px-1 rounded bg-slate-100 dark:bg-slate-700">#{{ t }}</span>
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
            <div>
              <label class="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">标签（逗号分隔）</label>
              <input
                v-model="newCreatorTags"
                type="text"
                placeholder="例如：ASMR, 插画, 游戏"
                class="w-full px-2.5 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 outline-none"
              />
            </div>
          </div>

          <!-- Mode: Bind Existing -->
          <div v-else class="space-y-2">
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="block text-[11px] font-medium text-slate-700 dark:text-slate-300">选择创作者</label>
                <span class="text-[10px] text-slate-400">可搜索</span>
              </div>

              <!-- Case A: Selected creator card -->
              <div
                v-if="selectedCreatorObj && !isEditingCreatorSelection"
                class="flex items-center justify-between p-2 bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-200/80 dark:border-indigo-800 rounded-xl"
              >
                <div class="flex items-center gap-2 min-w-0">
                  <div class="w-7 h-7 rounded-lg bg-indigo-100 dark:bg-indigo-900/60 flex items-center justify-center font-bold text-[11px] text-indigo-600 dark:text-indigo-300 overflow-hidden shrink-0 border border-indigo-200 dark:border-indigo-800">
                    <img v-if="selectedCreatorObj.avatar" :src="toSecureMediaUrl(selectedCreatorObj.avatar)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
                    <span v-else>{{ selectedCreatorObj.name.slice(0, 1) }}</span>
                  </div>
                  <div class="min-w-0">
                    <div class="font-bold text-xs text-slate-900 dark:text-white truncate">
                      {{ selectedCreatorObj.name }}
                    </div>
                    <div class="text-[9px] text-slate-500 dark:text-slate-400 truncate">
                      已绑 {{ channels.filter(ch => ch.creatorId === selectedCreatorObj.id).length }} 个账号
                      <span v-for="t in selectedCreatorObj.tags?.slice(0, 2)" :key="t" class="ml-1 px-1 rounded bg-white dark:bg-slate-800 text-slate-500 border border-slate-200/60 dark:border-slate-700">#{{ t }}</span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  @click="isEditingCreatorSelection = true"
                  class="px-2 py-0.5 text-[11px] text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-semibold bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer shrink-0"
                >
                  更换
                </button>
              </div>

              <!-- Case B: Search input & candidate dropdown -->
              <div v-else class="space-y-1">
                <div class="relative">
                  <Search class="absolute left-2.5 top-2 w-3 h-3 text-slate-400" />
                  <input
                    v-model="creatorSearchQuery"
                    type="text"
                    placeholder="输入姓名 / 拼音 / 标签关键词搜索..."
                    class="w-full pl-7.5 pr-7 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                    autofocus
                  />
                  <button
                    v-if="creatorSearchQuery"
                    type="button"
                    @click="creatorSearchQuery = ''"
                    class="absolute right-2 top-2 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    <X class="w-3 h-3" />
                  </button>
                </div>

                <div class="max-h-36 overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-700/60 shadow-xs">
                  <div
                    v-for="c in filteredCandidateCreators"
                    :key="c.id"
                    @click="selectCreator(c)"
                    class="p-1.5 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-700/60 cursor-pointer transition-colors"
                    :class="{ 'bg-indigo-50/50 dark:bg-indigo-950/40': selectedCreatorId === c.id }"
                  >
                    <div class="flex items-center gap-2 min-w-0">
                      <div class="w-6 h-6 rounded bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-[10px] text-indigo-600 overflow-hidden shrink-0 border border-slate-200 dark:border-slate-600">
                        <img v-if="c.avatar" :src="toSecureMediaUrl(c.avatar)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
                        <span v-else>{{ c.name.slice(0, 1) }}</span>
                      </div>
                      <div class="min-w-0">
                        <div class="font-bold text-xs text-slate-800 dark:text-slate-100 truncate flex items-center gap-1">
                          <span>{{ c.name }}</span>
                          <CheckCircle2 v-if="selectedCreatorId === c.id" class="w-2.5 h-2.5 text-indigo-600 shrink-0" />
                        </div>
                        <div class="text-[9px] text-slate-400 truncate">
                          已绑 {{ channels.filter(ch => ch.creatorId === c.id).length }} 号
                          <span v-for="t in c.tags?.slice(0, 1)" :key="t" class="ml-1 text-slate-500">#{{ t }}</span>
                        </div>
                      </div>
                    </div>
                    <span class="text-[10px] text-indigo-600 dark:text-indigo-400 font-semibold px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60">选择</span>
                  </div>

                  <div v-if="filteredCandidateCreators.length === 0" class="p-2.5 text-center text-xs text-slate-400 space-y-1">
                    <div>未找到 "{{ creatorSearchQuery }}"</div>
                    <button
                      type="button"
                      @click="switchToNewCreatorWithQuery(creatorSearchQuery)"
                      class="text-indigo-600 dark:text-indigo-400 hover:underline font-semibold cursor-pointer text-[11px]"
                    >
                      + 新建创作者「{{ creatorSearchQuery }}」
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Same Platform Hint -->
            <div
              v-if="samePlatformAccounts.length > 0"
              class="p-2 bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800/60 rounded-lg text-[10px] text-sky-800 dark:text-sky-200 leading-tight"
            >
              该创作者已有同平台账号（{{ samePlatformAccounts[0].displayName || samePlatformAccounts[0].accountId }}），本次将作为副号绑定。
            </div>
          </div>

          <!-- Account Role / Tag selector (Common to both modes) -->
          <div class="space-y-1.5 pt-1 border-t border-slate-100 dark:border-slate-800">
            <label class="block text-[11px] font-medium text-slate-700 dark:text-slate-300">账号类型：</label>
            <div class="grid grid-cols-4 gap-1">
              <button
                type="button"
                @click="accountRole = 'main'"
                :class="accountRole === 'main' ? 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/80 dark:text-amber-300 dark:border-amber-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
                class="py-1 text-[10px] rounded border transition-all cursor-pointer text-center"
              >
                主账号
              </button>
              <button
                type="button"
                @click="accountRole = 'sub'"
                :class="accountRole === 'sub' ? 'bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
                class="py-1 text-[10px] rounded border transition-all cursor-pointer text-center"
              >
                小号
              </button>
              <button
                type="button"
                @click="accountRole = 'alt'"
                :class="accountRole === 'alt' ? 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/80 dark:text-rose-300 dark:border-rose-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
                class="py-1 text-[10px] rounded border transition-all cursor-pointer text-center"
              >
                里号
              </button>
              <button
                type="button"
                @click="accountRole = 'custom'"
                :class="accountRole === 'custom' ? 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-950/80 dark:text-purple-300 dark:border-purple-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
                class="py-1 text-[10px] rounded border transition-all cursor-pointer text-center"
              >
                自定义
              </button>
            </div>
            <div v-if="accountRole === 'custom'" class="mt-1">
              <input
                v-model="customLabel"
                type="text"
                placeholder="例如：剪辑熟肉、直播回放"
                class="w-full px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>

          <!-- Confirm Button -->
          <button
            @click="handleSave"
            :disabled="saving"
            class="w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer"
          >
            <PlusCircle class="w-3.5 h-3.5" />
            <span>{{ saving ? '添加中...' : '确认关注' }}</span>
          </button>
        </div>
      </div>

      <!-- Unrecognized Page / Manual Add -->
      <div v-else class="space-y-3">
        <div class="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 rounded-xl">
          <div class="flex items-center gap-1.5 text-amber-800 dark:text-amber-200 font-semibold mb-1">
            <AlertCircle class="w-4 h-4 text-amber-600" />
            <span>未识别到创作者</span>
          </div>
          <p class="text-[10px] text-amber-700 dark:text-amber-300">
            请导航到支持的创作者主页
          </p>
        </div>

        <div class="space-y-2">
          <label class="block text-[11px] font-medium text-slate-700 dark:text-slate-300">手动输入链接：</label>
          <div class="flex gap-1.5">
            <input
              v-model="manualUrl"
              type="text"
              placeholder="https://space.bilibili.com/..."
              class="flex-1 px-2.5 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:ring-1 focus:ring-indigo-500"
              @keyup.enter="handleManualParse"
            />
            <button
              @click="handleManualParse"
              class="px-3 py-1.5 bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 rounded-lg text-xs font-medium hover:opacity-90"
            >
              识别
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom Statistics & Direct Dashboard Access -->
    <div class="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-[11px] text-slate-500">
      <div class="flex items-center gap-2">
        <span>关注: <strong class="text-slate-800 dark:text-slate-200">{{ creators.length }}</strong></span>
      </div>
      <button
        @click="openDashboard"
        class="flex items-center gap-1 text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-medium"
      >
        <span>打开面板</span>
        <ExternalLink class="w-3 h-3" />
      </button>
    </div>
  </div>
</template>
