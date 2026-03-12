import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import api from '@/api'

const THEME_KEY = 'ui_theme'

export type Theme = 'light-blue' | 'light-green' | 'light-pink' | 'dark-blue' | 'dark-purple' | 'dark-teal' | 'dark-orange' | 'dark-red'

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(false)
  const currentTheme = ref<Theme>((localStorage.getItem(THEME_KEY) as Theme) || 'light-pink')
  const showThemePanel = ref(false)

  const themes: Record<Theme, {
    name: string
    isDark: boolean
    bg: string
    text: string
    primary: string
    secondary: string
    gradient: string
    icon: string
  }> = {
    // 原始白色主题
    'light-blue': {
      name: '白色',
      isDark: false,
      bg: '#f9fafb',
      text: '#1f2937',
      primary: '#3b82f6',
      secondary: '#2563eb',
      gradient: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
      icon: 'i-carbon-sun',
    },
    // 原始黑色主题
    'dark-blue': {
      name: '深色',
      isDark: true,
      bg: '#111827',
      text: '#f3f4f6',
      primary: '#3b82f6',
      secondary: '#2563eb',
      gradient: 'linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%)',
      icon: 'i-carbon-moon',
    },
    // 樱花粉主题
    'light-pink': {
      name: '樱花粉',
      isDark: false,
      bg: '#fff0f5',
      text: '#831843',
      primary: '#ec4899',
      secondary: '#be185d',
      gradient: 'linear-gradient(135deg, #f472b6 0%, #ec4899 100%)',
      icon: 'i-carbon-favorite',
    },
    // 清新绿主题
    'light-green': {
      name: '清新绿',
      isDark: false,
      bg: '#f0fdf4',
      text: '#14532d',
      primary: '#22c55e',
      secondary: '#16a34a',
      gradient: 'linear-gradient(135deg, #4ade80 0%, #22c55e 100%)',
      icon: 'i-carbon-leaf',
    },
    // 紫罗兰主题
    'dark-purple': {
      name: '紫罗兰',
      isDark: true,
      bg: '#1e1b4b',
      text: '#e9d5ff',
      primary: '#a855f7',
      secondary: '#9333ea',
      gradient: 'linear-gradient(135deg, #c084fc 0%, #a855f7 100%)',
      icon: 'i-carbon-crown',
    },
    // 橙色暖阳主题
    'dark-orange': {
      name: '暖阳橙',
      isDark: true,
      bg: '#292524',
      text: '#fef3c7',
      primary: '#f59e0b',
      secondary: '#d97706',
      gradient: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
      icon: 'i-carbon-sun',
    },
    // 青色主题
    'dark-teal': {
      name: '青空夜',
      isDark: true,
      bg: '#134e4a',
      text: '#ccfbf1',
      primary: '#06b6d4',
      secondary: '#0891b2',
      gradient: 'linear-gradient(135deg, #22d3ee 0%, #06b6d4 100%)',
      icon: 'i-carbon-tree',
    },
    // 绯红主题
    'dark-red': {
      name: '绯红夜',
      isDark: true,
      bg: '#18181b',
      text: '#fda4af',
      primary: '#f43f5e',
      secondary: '#e11d48',
      gradient: 'linear-gradient(135deg, #fb7185 0%, #f43f5e 100%)',
      icon: 'i-carbon-close-filled',
    },
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function closeSidebar() {
    sidebarOpen.value = false
  }

  function openSidebar() {
    sidebarOpen.value = true
  }

  async function fetchTheme() {
    // 从服务器获取主题设置（可选）
    try {
      const res = await api.get('/api/settings')
      if (res.data.ok && res.data.data.ui?.theme) {
        // 如果服务器有主题设置，可以选择使用
        // 但优先使用本地存储的主题
      }
    }
    catch {
      // 未登录时静默失败，使用本地缓存值
    }
  }

  function applyTheme(theme: Theme) {
    // Validate theme
    if (!themes[theme]) {
      theme = 'light-pink'
    }

    const t = themes[theme]
    currentTheme.value = theme
    localStorage.setItem(THEME_KEY, theme)

    // Apply theme colors to CSS variables
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.setProperty('--theme-bg', t.bg)
      document.documentElement.style.setProperty('--theme-text', t.text)
      document.documentElement.style.setProperty('--theme-primary', t.primary)
      document.documentElement.style.setProperty('--theme-secondary', t.secondary)
      document.documentElement.style.setProperty('--theme-gradient', t.gradient)

      // Toggle dark class
      if (t.isDark) {
        document.documentElement.classList.add('dark')
      }
      else {
        document.documentElement.classList.remove('dark')
      }
    }
  }

  function toggleThemePanel() {
    showThemePanel.value = !showThemePanel.value
  }

  // Legacy toggleDark for backward compatibility
  function toggleDark() {
    const current = currentTheme.value
    if (themes[current]?.isDark) {
      applyTheme('light-green')
    }
    else {
      applyTheme('light-pink')
    }
  }

  // Computed isDark based on currentTheme
  const isDark = computed(() => themes[currentTheme.value]?.isDark ?? false)

  // Watch theme changes and apply
  watch(currentTheme, (val) => {
    applyTheme(val)
  })

  // Initialize theme immediately (not in onMounted)
  applyTheme(currentTheme.value)

  return {
    sidebarOpen,
    isDark,
    currentTheme,
    showThemePanel,
    themes,
    applyTheme,
    toggleThemePanel,
    toggleDark,
    toggleSidebar,
    closeSidebar,
    openSidebar,
    fetchTheme,
  }
})
