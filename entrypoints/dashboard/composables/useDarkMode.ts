import { ref } from 'vue';

/**
 * Pure UI preference: light/dark theme persisted to localStorage under
 * `creator_feed_theme`. Dashboard-only concern.
 */
const isDarkMode = ref(false);

function applyDarkClass() {
  if (isDarkMode.value) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

/** Restore theme from localStorage (defaults to light) and apply to <html>. */
export function initDarkMode(): boolean {
  const savedTheme = localStorage.getItem('creator_feed_theme');
  const dark = savedTheme === 'dark';
  isDarkMode.value = dark;
  applyDarkClass();
  return dark;
}

/** Flip theme, persist it and apply to <html>. */
export function toggleDarkMode(): boolean {
  isDarkMode.value = !isDarkMode.value;
  applyDarkClass();
  localStorage.setItem('creator_feed_theme', isDarkMode.value ? 'dark' : 'light');
  return isDarkMode.value;
}

export function useDarkMode() {
  return { isDarkMode, initDarkMode, toggleDarkMode };
}
