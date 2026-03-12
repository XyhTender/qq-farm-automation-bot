import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { useAppStore } from '@/stores/app'
import { useToastStore } from '@/stores/toast'
import App from './App.vue'
import router from './router'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import './style.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

// Apply theme immediately before app mounts
const THEME_KEY = 'ui_theme'
const savedTheme = localStorage.getItem(THEME_KEY) || 'light-pink'
const themes: Record<string, { isDark: boolean, bg: string, text: string, primary: string, secondary: string, gradient: string }> = {
  'light-blue': { isDark: false, bg: '#f9fafb', text: '#1f2937', primary: '#3b82f6', secondary: '#2563eb', gradient: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' },
  'dark-blue': { isDark: true, bg: '#111827', text: '#f3f4f6', primary: '#3b82f6', secondary: '#2563eb', gradient: 'linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%)' },
  'light-pink': { isDark: false, bg: '#fff0f5', text: '#831843', primary: '#ec4899', secondary: '#be185d', gradient: 'linear-gradient(135deg, #f472b6 0%, #ec4899 100%)' },
  'light-green': { isDark: false, bg: '#f0fdf4', text: '#14532d', primary: '#22c55e', secondary: '#16a34a', gradient: 'linear-gradient(135deg, #4ade80 0%, #22c55e 100%)' },
  'dark-purple': { isDark: true, bg: '#1e1b4b', text: '#e9d5ff', primary: '#a855f7', secondary: '#9333ea', gradient: 'linear-gradient(135deg, #c084fc 0%, #a855f7 100%)' },
  'dark-orange': { isDark: true, bg: '#292524', text: '#fef3c7', primary: '#f59e0b', secondary: '#d97706', gradient: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)' },
  'dark-teal': { isDark: true, bg: '#134e4a', text: '#ccfbf1', primary: '#06b6d4', secondary: '#0891b2', gradient: 'linear-gradient(135deg, #22d3ee 0%, #06b6d4 100%)' },
  'dark-red': { isDark: true, bg: '#18181b', text: '#fda4af', primary: '#f43f5e', secondary: '#e11d48', gradient: 'linear-gradient(135deg, #fb7185 0%, #f43f5e 100%)' },
}

const theme = themes[savedTheme] || themes['light-pink']
if (theme) {
  document.documentElement.style.setProperty('--theme-bg', theme.bg)
  document.documentElement.style.setProperty('--theme-text', theme.text)
  document.documentElement.style.setProperty('--theme-primary', theme.primary)
  document.documentElement.style.setProperty('--theme-secondary', theme.secondary)
  document.documentElement.style.setProperty('--theme-gradient', theme.gradient)
  if (theme.isDark) {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }
}

// Global Error Handling
const toast = useToastStore()

app.config.errorHandler = (err: any, _instance, info) => {
  console.error('全局 Vue 错误:', err, info)
  const message = err.message || String(err)
  if (message.includes('ResizeObserver loop'))
    return
  toast.error(`应用错误: ${message}`)
}

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  if (reason && typeof reason === 'object' && 'isAxiosError' in reason)
    return

  console.error('Unhandled Rejection:', reason)
  const message = reason?.message || String(reason)
  toast.error(`异步错误: ${message}`)
})

window.onerror = (message, _source, _lineno, _colno, error) => {
  console.error('Global Error:', message, error)
  if (String(message).includes('Script error'))
    return
  toast.error(`系统错误: ${message}`)
}

// Apply theme from localStorage immediately, then sync from server if authed
const appStore = useAppStore()
appStore.fetchTheme()

app.mount('#app')
