<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import Sidebar from '@/components/Sidebar.vue'
import { useAppStore } from '@/stores/app'
import { useUserStore } from '@/stores/user'

const appStore = useAppStore()
const userStore = useUserStore()
const { sidebarOpen } = storeToRefs(appStore)

const showWarningModal = ref(false)
const warningCountdown = ref(10)
let countdownTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  if (userStore.isLoggedIn) {
    const lastWarningTime = localStorage.getItem('last_warning_time')
    const now = Date.now()
    if (!lastWarningTime || now - Number(lastWarningTime) > 24 * 60 * 60 * 1000) {
      showWarningModal.value = true
      countdownTimer = setInterval(() => {
        if (warningCountdown.value > 0) {
          warningCountdown.value--
        }
      }, 1000)
    }
  }
})

onUnmounted(() => {
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
})

function closeWarningModal() {
  if (warningCountdown.value > 0) return
  showWarningModal.value = false
  localStorage.setItem('last_warning_time', String(Date.now()))
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}
</script>

<template>
  <div class="w-screen flex overflow-hidden bg-gray-50 dark:bg-gray-900" style="height: 100dvh;">
    <!-- 强制警告弹窗 - iOS风格 -->
    <Teleport to="body">
      <Transition name="modal-fade">
        <div
          v-if="showWarningModal"
          class="fixed inset-0 z-[10000] flex items-center justify-center"
        >
          <!-- 透明背景 -->
          <div class="absolute inset-0 bg-black/20" />
          
          <!-- 弹窗主体 -->
          <div class="warning-modal relative w-[400px] overflow-hidden rounded-3xl bg-white/90 shadow-xl backdrop-blur-md dark:bg-gray-900/90">
            <!-- 顶部装饰条 -->
            <div class="h-1 w-full bg-gradient-to-r from-pink-400 via-rose-400 to-pink-500" />
            
            <!-- 水波纹背景效果 -->
            <div class="ripple-bg">
              <div class="ripple ripple-1" />
              <div class="ripple ripple-2" />
              <div class="ripple ripple-3" />
            </div>

            <!-- 内容区域 -->
            <div class="relative z-10 p-8">
              <!-- 图标 -->
              <div class="mb-6 flex justify-center">
                <div class="icon-container relative">
                  <div class="absolute inset-0 animate-ping rounded-full bg-pink-400/20" />
                  <div class="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-pink-400 to-rose-500 shadow-lg">
                    <span class="text-4xl">🌸</span>
                  </div>
                </div>
              </div>

              <!-- 标题 -->
              <h3 class="mb-6 text-center text-2xl text-gray-800 font-bold dark:text-white">
                重要声明
              </h3>

              <!-- 声明内容 -->
              <div class="mb-8 space-y-4">
                <div class="rounded-2xl bg-gradient-to-r from-pink-50 to-rose-50 p-5 dark:from-pink-950/50 dark:to-rose-950/50">
                  <p class="text-center text-xl text-pink-600 font-bold dark:text-pink-400">
                    🚫 开源项目，禁止贩卖 🚫
                  </p>
                </div>
                
                <div class="space-y-3 text-center">
                  <p class="text-base text-gray-600 dark:text-gray-300">
                    本项目完全<span class="font-bold text-pink-600 dark:text-pink-400">开源免费</span>
                  </p>
                  <p class="text-sm text-gray-500 dark:text-gray-400">
                    任何收费行为均为诈骗！咸鱼卖的退款拉黑！
                  </p>
                  <div class="rounded-xl bg-pink-100/50 p-3 dark:bg-pink-900/20">
                    <p class="text-sm text-pink-600 font-medium dark:text-pink-400">
                      ⚠️ 倒卖一辈子发不了财 ⚠️
                    </p>
                  </div>
                </div>
              </div>

              <!-- 倒计时提示 -->
              <div v-if="warningCountdown > 0" class="mb-4 text-center">
                <div class="inline-flex items-center gap-2 rounded-full bg-pink-50 px-4 py-2 dark:bg-pink-900/30">
                  <div class="h-4 w-4 animate-spin rounded-full border-2 border-pink-200 border-t-pink-500" />
                  <span class="text-sm text-pink-600 dark:text-pink-400">
                    请阅读声明 <span class="font-mono font-bold text-pink-700 dark:text-pink-300">{{ warningCountdown }}</span> 秒
                  </span>
                </div>
              </div>

              <!-- 按钮 -->
              <button
                class="w-full rounded-2xl py-4 text-base font-semibold transition-all duration-300"
                :class="warningCountdown > 0 
                  ? 'cursor-not-allowed bg-pink-100 text-pink-300 dark:bg-pink-900/30 dark:text-pink-500' 
                  : 'bg-gradient-to-r from-pink-500 to-rose-500 text-white shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-[0.98]'"
                :disabled="warningCountdown > 0"
                @click="closeWarningModal"
              >
                {{ warningCountdown > 0 ? '请仔细阅读声明' : '我已知晓' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 全局水印 -->
    <div class="watermark-container">
      <div class="watermark" />
    </div>

    <!-- Mobile Sidebar Overlay -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-40 bg-gray-900/50 backdrop-blur-sm transition-opacity lg:hidden"
      @click="appStore.closeSidebar"
    />

    <Sidebar />

    <main class="relative h-full min-w-0 flex flex-1 flex-col overflow-hidden">
      <!-- Top Bar (Mobile/Tablet only or for additional actions) -->
      <header class="h-16 flex shrink-0 items-center justify-between border-b border-gray-100 bg-white px-6 lg:hidden dark:border-gray-700/50 dark:bg-gray-800">
        <div class="text-lg font-bold">
          QQ农场智能助手
        </div>
        <button
          class="flex items-center justify-center rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          @click="appStore.toggleSidebar"
        >
          <div class="i-carbon-menu text-xl" />
        </button>
      </header>

      <!-- Main Content Area -->
      <div class="flex flex-1 flex-col overflow-hidden">
        <div class="custom-scrollbar flex flex-1 flex-col overflow-y-auto p-2 md:p-6 sm:p-4">
          <RouterView v-slot="{ Component, route }">
            <Transition name="slide-fade" mode="out-in">
              <component :is="Component" :key="route.path" />
            </Transition>
          </RouterView>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* 弹窗动画 */
.modal-fade-enter-active {
  animation: modal-in 0.4s ease-out;
}

.modal-fade-leave-active {
  animation: modal-out 0.3s ease-in;
}

@keyframes modal-in {
  0% {
    opacity: 0;
    transform: scale(0.9);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes modal-out {
  0% {
    opacity: 1;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(0.9);
  }
}

/* 弹窗样式 */
.warning-modal {
  animation: float 3s ease-in-out infinite;
}

@keyframes float {
  0%, 100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-5px);
  }
}

/* 水波纹背景 */
.ripple-bg {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 100%;
  height: 100%;
  overflow: hidden;
  pointer-events: none;
}

.ripple {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle, rgba(239, 68, 68, 0.1) 0%, transparent 70%);
  animation: ripple-effect 4s ease-out infinite;
}

.ripple-1 {
  width: 200px;
  height: 200px;
  animation-delay: 0s;
}

.ripple-2 {
  width: 300px;
  height: 300px;
  animation-delay: 1.3s;
}

.ripple-3 {
  width: 400px;
  height: 400px;
  animation-delay: 2.6s;
}

@keyframes ripple-effect {
  0% {
    transform: translate(-50%, -50%) scale(0.5);
    opacity: 0.6;
  }
  100% {
    transform: translate(-50%, -50%) scale(2);
    opacity: 0;
  }
}

/* 图标容器动画 */
.icon-container {
  animation: pulse-glow 2s ease-in-out infinite;
}

@keyframes pulse-glow {
  0%, 100% {
    filter: drop-shadow(0 0 10px rgba(239, 68, 68, 0.3));
  }
  50% {
    filter: drop-shadow(0 0 20px rgba(239, 68, 68, 0.5));
  }
}

/* 水印样式 */
.watermark-container {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 9999;
  overflow: hidden;
}

.watermark {
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='200'%3E%3Ctext x='50%25' y='50%25' font-size='16' font-family='Arial, sans-serif' fill='rgba(128, 128, 128, 0.15)' text-anchor='middle' dominant-baseline='middle' transform='rotate(-25, 150, 100)'%3E开源项目 禁止贩卖%3C/text%3E%3C/svg%3E");
  background-repeat: repeat;
  transform: rotate(0deg);
}

/* Slide Fade Transition */
.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: all 0.2s ease-out;
}

.slide-fade-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.slide-fade-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.3);
  border-radius: 3px;
}
.custom-scrollbar:hover::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.5);
}
</style>
