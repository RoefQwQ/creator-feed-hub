<script setup lang="ts">
import { computed, ref } from 'vue';
import { Bookmark, ChevronRight, Clock, ExternalLink, Film, ImageOff, Repeat2, Trash2 } from 'lucide-vue-next';
import { PLATFORM_REGISTRY, type Channel, type Creator, type Post } from '../../../src/types';
import { toSecureMediaUrl, proxyImage, isImageFailed, markImageFailed } from '../../../src/utils/media';

const props = withDefaults(defineProps<{
  post: Post;
  creators: Creator[];
  channels: Channel[];
  bookmarked?: boolean;
}>(), { bookmarked: false });

const emit = defineEmits<{
  bookmark: [post: Post];
  delete: [post: Post];
  read: [post: Post];
  media: [media: { url: string; originalUrl?: string; type: string; title?: string }];
  avatarError: [url: string];
}>();

const creator = computed(() => props.creators.find(c => c.id === props.post.creatorId));
const channel = computed(() => props.channels.find(c => c.id === props.post.channelId));
const authorName = computed(() => creator.value?.name || '未知创作者');
const channelName = computed(() => channel.value?.displayName || channel.value?.accountId || props.post.platform);
const avatar = computed(() => creator.value?.avatar || channel.value?.avatarUrl || props.post.authorMeta?.avatar || '');
const label = computed(() => props.post.channelLabel || channel.value?.label);
const isRepost = computed(() => props.post.isRepost || props.post.content?.startsWith('RT @') || props.post.content?.includes('//转发自'));
const secure = toSecureMediaUrl;

// Pre-initialize mediaFailedMap with already known failed URLs
const mediaFailedMap = ref<Record<string, boolean>>({});

// Helper to check if media is failed either locally or globally
function isMediaFailed(url?: string): boolean {
  if (!url) return true;
  return Boolean(mediaFailedMap.value[url] || isImageFailed(url));
}

const avatarFailed = ref(false);

function handleAvatarError(url: string) {
  avatarFailed.value = true;
  markImageFailed(url);
  emit('avatarError', url);
}

async function handleMediaError(e: Event, originalUrl?: string) {
  const target = e.target as HTMLImageElement;
  if (!target || !originalUrl) return;

  // IMMEDIATELY hide the broken image element so the browser's native broken icon NEVER flashes
  target.style.opacity = '0';
  target.style.visibility = 'hidden';

  const retryCount = Number(target.dataset.retryCount || 0);
  if (retryCount >= 1 || isImageFailed(originalUrl)) {
    markImageFailed(originalUrl);
    mediaFailedMap.value[originalUrl] = true;
    return;
  }
  target.dataset.retryCount = String(retryCount + 1);

  try {
    const proxiedDataUrl = await proxyImage(originalUrl);
    if (proxiedDataUrl) {
      target.src = proxiedDataUrl;
      target.style.opacity = '';
      target.style.visibility = '';
      return;
    }
  } catch {}

  markImageFailed(originalUrl);
  mediaFailedMap.value[originalUrl] = true;
}

const formatTime = (timestamp: number) => {
  if (!timestamp) return '未知时间';
  const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return date.toLocaleDateString('zh-CN');
};
const openMedia = (url: string, type: string) => emit('media', { url, originalUrl: props.post.originalUrl, type, title: props.post.title });
</script>

<template>
  <article
    class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 overflow-hidden shadow-xs hover:shadow-xl hover:-translate-y-1 transition-all duration-300 ease-out flex flex-col group/card will-change-transform"
    :class="bookmarked ? 'ring-1 ring-amber-500/30' : (post.isRead ? '' : 'ring-1 ring-indigo-400/40 dark:ring-indigo-600/50')"
    @click="emit('read', post)"
  >
    <div class="p-4 border-b border-slate-100 dark:border-slate-800/60 flex items-center justify-between">
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 shrink-0 flex items-center justify-center text-xs font-bold text-indigo-600 overflow-hidden border border-slate-200 dark:border-slate-700 shadow-2xs group-hover/card:scale-105 transition-transform duration-200">
          <img v-if="avatar && !avatarFailed" :src="secure(avatar)" referrerpolicy="no-referrer" class="w-full h-full object-cover" @error="handleAvatarError(avatar)" />
          <span v-else>{{ authorName.slice(0, 1) }}</span>
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-1.5 min-w-0">
            <h4 class="font-bold text-xs text-slate-900 dark:text-white leading-tight truncate group-hover/card:text-indigo-600 dark:group-hover/card:text-indigo-400 transition-colors">{{ authorName }}</h4>
            <span v-if="label" class="px-1.5 py-0.2 rounded text-[9px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-slate-700/80 shrink-0">{{ label }}</span>
          </div>
          <div class="flex items-center gap-1.5 text-[10px] text-slate-400 mt-0.5 min-w-0">
            <span :class="PLATFORM_REGISTRY[post.platform]?.badgeBg || 'bg-slate-100 text-slate-700 border-slate-200'" class="px-1.5 py-0.2 rounded text-[9px] font-semibold border shrink-0 transition-transform hover:scale-105">{{ PLATFORM_REGISTRY[post.platform]?.name || post.platform }}</span>
            <span v-if="isRepost" class="px-1.5 py-0.2 rounded text-[9px] font-medium bg-amber-50 text-amber-700 border border-amber-200 shrink-0 flex items-center gap-0.5"><Repeat2 class="w-2.5 h-2.5" />转发</span>
            <span class="truncate max-w-[100px] text-slate-500 dark:text-slate-400">@{{ channelName }}</span><span>•</span>
            <span class="flex items-center gap-0.5 shrink-0"><Clock class="w-2.5 h-2.5" />{{ formatTime(post.publishedAt) }}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button type="button" @click.stop="emit('bookmark', post)" :title="post.isBookmarked ? '取消收藏' : '收藏'" class="p-1.5 rounded-lg transition-all duration-150 cursor-pointer active:scale-90" :class="post.isBookmarked ? 'text-amber-500 bg-amber-50 dark:bg-amber-950/60' : 'text-slate-400 hover:text-amber-500 hover:bg-slate-100 dark:hover:bg-slate-800'"><Bookmark class="w-3.5 h-3.5" :class="{ 'fill-amber-500 text-amber-500': post.isBookmarked }" /></button>
        <button type="button" @click.stop="emit('delete', post)" title="删除动态" class="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-all duration-150 cursor-pointer active:scale-90"><Trash2 class="w-3.5 h-3.5" /></button>
        <a :href="post.originalUrl" target="_blank" title="打开原帖" class="text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-all duration-150 cursor-pointer active:scale-90 shrink-0"><ExternalLink class="w-3.5 h-3.5" /></a>
      </div>
    </div>

    <div class="p-4 flex-1 space-y-3">
      <h5 v-if="post.title" class="font-bold text-sm text-slate-900 dark:text-white leading-snug line-clamp-2 tracking-tight">{{ post.title }}</h5>
      <p v-if="post.content" class="text-xs text-slate-600 dark:text-slate-300 line-clamp-4 whitespace-pre-wrap leading-relaxed">{{ post.content }}</p>
      <div v-if="post.mediaList?.length" class="pt-1">
        <!-- Single Video -->
        <div v-if="post.mediaList.length === 1 && post.mediaList[0].type === 'video'" @click.stop="openMedia(post.mediaList[0].previewUrl, 'video')" class="relative aspect-video rounded-xl overflow-hidden bg-slate-900 cursor-pointer group/vid flex items-center justify-center">
          <img v-if="!isMediaFailed(post.mediaList[0].previewUrl)" :src="secure(post.mediaList[0].previewUrl)" referrerpolicy="no-referrer" loading="lazy" class="w-full h-full object-cover opacity-90 group-hover/vid:scale-105 transition-transform duration-300" @error="handleMediaError($event, post.mediaList[0].previewUrl)" />
          <Film class="absolute w-11 h-11 p-3 rounded-full bg-white/30 backdrop-blur-xs text-white fill-white shadow-lg group-hover/vid:scale-110 transition-transform duration-200" />
        </div>

        <!-- Single Image -->
        <div v-else-if="post.mediaList.length === 1">
          <!-- Elegant Fallback Card when image is restricted / unavailable -->
          <div
            v-if="isMediaFailed(post.mediaList[0].previewUrl)"
            class="w-full py-8 px-5 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-gradient-to-b from-slate-50 to-slate-100/70 dark:from-slate-850 dark:to-slate-900/80 flex flex-col items-center justify-center text-center select-none"
          >
            <div class="w-10 h-10 rounded-2xl bg-white dark:bg-slate-800 shadow-xs border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-center text-slate-400 dark:text-slate-400 mb-2.5">
              <ImageOff class="w-5 h-5 stroke-[1.75]" />
            </div>
            <p class="text-xs font-semibold text-slate-700 dark:text-slate-200">原图暂无法直接预览</p>
            <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1 max-w-[240px] leading-relaxed">
              源站 CDN 访问受限或动态时间较早，可直接在原帖中查看完整内容
            </p>
            <a
              :href="post.originalUrl"
              target="_blank"
              @click.stop
              class="mt-3.5 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 border border-slate-200 dark:border-slate-700 shadow-2xs hover:shadow-xs hover:border-indigo-300 dark:hover:border-indigo-700 transition-all cursor-pointer"
            >
              <span>直达原帖查看图片</span>
              <ExternalLink class="w-3.5 h-3.5" />
            </a>
          </div>

          <!-- Normal Single Image Display -->
          <div
            v-else
            @click.stop="openMedia(post.mediaList[0].previewUrl, 'image')"
            class="relative min-h-[160px] max-h-[460px] rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800 cursor-zoom-in group/img flex items-center justify-center"
          >
            <img
              :src="secure(post.mediaList[0].previewUrl)"
              referrerpolicy="no-referrer"
              loading="lazy"
              class="w-full h-full max-h-[460px] object-cover group-hover/img:scale-103 transition-transform duration-300 ease-out"
              @error="handleMediaError($event, post.mediaList[0].previewUrl)"
            />
          </div>
        </div>

        <!-- Gallery Grid (2 or more images) -->
        <div v-else :class="post.mediaList.length === 2 ? 'grid grid-cols-2 gap-2 aspect-[16/11]' : post.mediaList.length <= 4 ? 'grid grid-cols-2 gap-1.5 aspect-square' : 'grid grid-cols-3 gap-1.5'">
          <div
            v-for="(media, index) in post.mediaList.slice(0, post.mediaList.length > 4 ? 6 : undefined)"
            :key="index"
            @click.stop="!isMediaFailed(media.previewUrl) && openMedia(media.originalUrl || media.previewUrl, media.type)"
            class="relative aspect-square rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center"
            :class="isMediaFailed(media.previewUrl) ? 'border border-slate-200/80 dark:border-slate-800 bg-slate-50 dark:bg-slate-850' : 'cursor-zoom-in group/gallery'"
          >
            <!-- Miniature Fallback if thumbnail is unavailable -->
            <div
              v-if="isMediaFailed(media.previewUrl)"
              class="w-full h-full flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 p-1 text-center select-none"
              title="图片无法直接加载，可点击直达原帖查看"
            >
              <ImageOff class="w-4 h-4 stroke-[1.75]" />
              <span class="text-[9px] mt-1 text-slate-400 dark:text-slate-500 scale-90">预览受限</span>
            </div>
            <!-- Normal Thumbnail -->
            <template v-else>
              <img
                :src="secure(media.previewUrl)"
                referrerpolicy="no-referrer"
                loading="lazy"
                class="w-full h-full object-cover group-hover/gallery:scale-105 transition-transform duration-300 ease-out"
                @error="handleMediaError($event, media.previewUrl)"
              />
              <span
                v-if="index === 5 && post.mediaList.length > 6"
                class="absolute inset-0 bg-black/60 backdrop-blur-2xs flex items-center justify-center text-white font-bold text-xs"
              >
                +{{ post.mediaList.length - 6 }}
              </span>
            </template>
          </div>
        </div>
      </div>
    </div>
    <div class="px-4 py-2.5 bg-slate-50/80 dark:bg-slate-850/60 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
      <span>{{ formatTime(post.fetchedAt) }} 同步</span>
      <a :href="post.originalUrl" target="_blank" class="flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 font-medium group/link transition-colors">
        <span>原文</span>
        <ChevronRight class="w-3 h-3 group-hover/link:translate-x-0.5 transition-transform" />
      </a>
    </div>
  </article>
</template>
