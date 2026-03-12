<script setup lang="ts">
import { ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'

const props = defineProps<{
  show: boolean
  accountId?: string
  currentAvatar?: string
}>()

const emit = defineEmits(['close', 'saved'])

const avatarUrl = ref('')
const loading = ref(false)

// 随机头像图床链接池
const randomAvatars = [
  'https://i.imgs.ovh/2026/03/12/OVXq24.jpeg',
  'https://i.imgs.ovh/2026/03/12/OVXkzC.jpeg',
  'https://i.imgs.ovh/2026/03/12/OVX5XA.jpeg',
  'https://i.imgs.ovh/2026/03/12/OVX8FN.jpeg',
  'https://i.imgs.ovh/2026/03/12/OVXeDH.jpeg',
  'https://i.imgs.ovh/2026/03/12/OVXshU.jpeg',
  'https://i.imgs.ovh/2026/03/12/OVXDaX.jpeg',
  'https://i.imgs.ovh/2026/03/12/OVXM5Q.jpeg',
  'https://i.imgs.ovh/2026/03/12/OVXPdF.jpeg',
  'https://i.imgs.ovh/2026/03/12/OVXW0m.jpeg',
]

function randomAvatar() {
  const selected = randomAvatars[Math.floor(Math.random() * randomAvatars.length)]
  if (selected) {
    avatarUrl.value = selected
  }
}

async function save() {
  if (!avatarUrl.value.trim()) return
  loading.value = true
  try {
    emit('saved', avatarUrl.value.trim())
  } finally {
    loading.value = false
  }
}

watch(() => props.show, (val) => {
  if (val) {
    avatarUrl.value = props.currentAvatar || ''
  }
})
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div class="max-w-md w-full rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-lg font-semibold">设置头像</h3>
        <BaseButton variant="ghost" class="!p-1" @click="emit('close')">
          <div class="i-carbon-close text-xl" />
        </BaseButton>
      </div>

      <div class="space-y-4">
        <div class="flex justify-center">
          <div class="h-24 w-24 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
            <div v-if="avatarUrl" v-html="`<img src='${avatarUrl}' class='h-full w-full object-cover' />`" />
            <div v-else class="i-carbon-user flex h-full w-full items-center justify-center text-4xl text-gray-400" />
          </div>
        </div>

        <BaseInput
          v-model="avatarUrl"
          label="头像链接"
          placeholder="输入图床链接"
        />

        <BaseButton variant="outline" class="w-full" @click="randomAvatar">
          <div class="i-carbon-shuffle mr-2" />
          随机头像
        </BaseButton>

        <div class="flex justify-end gap-2 pt-2">
          <BaseButton variant="outline" @click="emit('close')">
            取消
          </BaseButton>
          <BaseButton variant="primary" :loading="loading" @click="save">
            保存
          </BaseButton>
        </div>
      </div>
    </div>
  </div>
</template>
