<script setup lang="ts">
import type { ProxyMode } from '../../types/settings'

const props = defineProps<{
  proxyMode: ProxyMode
  proxyHost: string
  proxyPort: number
  proxyAllowDirectFallback: boolean
}>()

const emit = defineEmits<{
  'update:proxyMode': [mode: ProxyMode]
  'update:proxyHost': [host: string]
  'update:proxyPort': [port: number]
  'toggle:allowDirectFallback': []
}>()

function setProxyMode(event: Event): void {
  emit('update:proxyMode', (event.target as HTMLSelectElement).value as ProxyMode)
}

function setProxyHost(event: Event): void {
  emit('update:proxyHost', (event.target as HTMLInputElement).value)
}

function setProxyPort(event: Event): void {
  const value = parseInt((event.target as HTMLInputElement).value, 10)
  emit('update:proxyPort', Number.isFinite(value) ? value : 0)
}
</script>

<template>
  <div class="section-block">
    <h3>网络代理 (Network Proxy)</h3>
    <div class="setting-list">
      <div class="setting-item">
        <div class="setting-copy">
          <strong>代理模式</strong>
          <span>为流媒体插件（YouTube Music 等）配置 HTTP 代理，需重启后生效。</span>
        </div>
        <select class="preview-select" :value="props.proxyMode" @change="setProxyMode">
          <option value="auto">自动检测</option>
          <option value="custom">自定义</option>
          <option value="off">关闭</option>
        </select>
      </div>
      <template v-if="props.proxyMode === 'custom'">
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>代理地址</strong>
            <span>HTTP 代理服务器地址，不含协议前缀。</span>
          </div>
          <input
            class="preview-select"
            type="text"
            placeholder="127.0.0.1"
            :value="props.proxyHost"
            @change="setProxyHost"
          />
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>代理端口</strong>
            <span>HTTP 代理服务器端口。</span>
          </div>
          <input
            class="preview-select"
            type="number"
            placeholder="7897"
            :value="props.proxyPort || ''"
            @change="setProxyPort"
            min="0"
            max="65535"
          />
        </div>
      </template>
      <template v-if="props.proxyMode !== 'off'">
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>代理失败时允许直连</strong>
            <span>默认关闭。开启后代理连接失败才会尝试直连；已取消的请求永不回退。</span>
          </div>
          <span
            class="toggle-switch"
            :class="{
              active: props.proxyAllowDirectFallback,
              inactive: !props.proxyAllowDirectFallback
            }"
            role="switch"
            :aria-checked="props.proxyAllowDirectFallback"
            @click="emit('toggle:allowDirectFallback')"
          ></span>
        </div>
      </template>
    </div>
  </div>
</template>
