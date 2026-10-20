<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { checkZipRelease, isNewerVersion, loadUpdateSettings, saveUpdateSettings } from "./updates";
import type { ReleaseInfo, UpdateSettings } from "./updates";
defineProps<{ disabled?: boolean }>();
const version = chrome.runtime.getManifest().version;
const settings = reactive<UpdateSettings>({ channel: "browser", feedUrl: "" });
const release = ref<ReleaseInfo | null>(null), busy = ref(false), error = ref(""), notice = ref("");
onMounted(async () => {
  try { Object.assign(settings, await loadUpdateSettings()); }
  catch { error.value = "无法读取更新配置。"; }
});
function reset(): void { release.value = null; error.value = ""; notice.value = ""; }
async function check(): Promise<void> {
  reset(); busy.value = true;
  try {
    if (settings.channel === "zip") {
      // Keep permission request in the initiating click, before any storage await.
      const latest = await checkZipRelease(settings.feedUrl.trim());
      await saveUpdateSettings(settings);
      if (isNewerVersion(latest.version, version)) { release.value = latest; notice.value = "发现新版本 " + latest.version; }
      else notice.value = "当前版本已是该更新源的最新版本。";
    } else {
      await saveUpdateSettings(settings);
      const result = await chrome.runtime.requestUpdateCheck();
      notice.value = result.status === "update_available" ? "新版本 " + result.version + " 已就绪。请停止任务并关闭全部扩展页面，等待 Chrome 应用更新。"
        : result.status === "throttled" ? "Chrome 暂时限制频繁检查，请稍后重试。"
          : "Chrome 未发现商店更新；若使用解压版，请切换 ZIP 更新源。";
    }
  } catch (failure) { error.value = failure instanceof Error ? failure.message : "检查更新失败。"; }
  finally { busy.value = false; }
}
</script>

<template>
  <details class="update-menu" data-testid="update-menu">
    <summary>更新 · v{{ version }}</summary>
    <div class="card update-panel">
      <h2>扩展更新</h2>
      <label>分发渠道<select v-model="settings.channel" :disabled="busy" data-testid="update-channel" @change="reset">
        <option value="browser">Chrome 商店更新</option><option value="zip">ZIP 更新源</option>
      </select></label>
      <label v-if="settings.channel === 'zip'">更新清单地址<input v-model="settings.feedUrl" type="url" placeholder="填写开发者提供的 update.json 地址" data-testid="update-feed" @input="reset" /></label>
      <p class="hint">商店版由 Chrome 分发安装。解压版可检查并下载新版 ZIP，覆盖原加载目录后在扩展管理页重新加载。请先停止任务、关闭旧调度页。</p>
      <button :disabled="busy || disabled" data-testid="update-check" @click="check">{{ busy ? "正在检查…" : "检查更新" }}</button>
      <p v-if="disabled" class="hint">当前页面正在处理任务，请结束后更新。</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <template v-if="release">
        <p>{{ release.notes }}</p>
        <a :href="release.zipUrl" target="_blank" rel="noopener noreferrer" download data-testid="update-download">下载 v{{ release.version }} ZIP</a>
        <p class="hint">开发者提供的 SHA-256（下载后自行核对）：<code>{{ release.sha256 }}</code></p>
      </template>
    </div>
  </details>
</template>

<style scoped>
.update-menu { position: relative; font-size: 13px; }
summary { cursor: pointer; white-space: nowrap; padding: 6px; }
.update-panel { position: absolute; z-index: 30; right: 0; top: 100%; width: min(360px, calc(100vw - 32px)); max-height: 75vh; overflow: auto; box-shadow: 0 4px 16px #0002; }
.update-panel code { overflow-wrap: anywhere; }
</style>
