<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { TaskQuestion } from "./protocol";
import { questionToMarkdown } from "../shared/question-markdown";

const props = defineProps<{
  items: TaskQuestion[];
  failedIndices: number[];
  imageIndices: number[];
  images: Record<number, { fingerprint: string; dataUrl: string }>;
  busy: Record<number, boolean>;
  errors: Record<number, string>;
  notice: string;
}>();
const emit = defineEmits<{
  preview: [item: TaskQuestion];
  copy: [item: TaskQuestion];
  copyImage: [dataUrl: string];
  downloadImage: [dataUrl: string, index: number];
}>();
const dialog = ref<HTMLDialogElement | null>(null);
const selection = ref<{ index: number; fingerprint: string } | null>(null);
const naturalSize = ref(false);
const selected = computed(() => props.items.find(item => item.index === selection.value?.index && item.fingerprint === selection.value?.fingerprint));
const failures = computed(() => new Set(props.failedIndices));
const imageReads = computed(() => new Set(props.imageIndices));
function status(item: TaskQuestion): "text" | "image" | "failed" {
  if (failures.value.has(item.index)) return "failed";
  return item.needsImage || item.imageRequired || item.imageSource === "originals" || imageReads.value.has(item.index) ? "image" : "text";
}
const labels = { text: "普通读取", image: "图片处理", failed: "最终未回填，待补答" };
const marks = { text: "文", image: "图", failed: "!" };
const image = computed(() => {
  const item = selected.value;
  const cached = item ? props.images[item.index] : undefined;
  return cached?.fingerprint === item?.fingerprint ? cached?.dataUrl : "";
});
async function open(item: TaskQuestion): Promise<void> {
  selection.value = { index: item.index, fingerprint: item.fingerprint };
  naturalSize.value = false;
  await nextTick();
  if (selected.value && !dialog.value?.open) dialog.value?.showModal();
  if (selected.value) emit("preview", item);
}
function close(): void { if (dialog.value?.open) dialog.value.close(); selection.value = null; }
function move(offset: number): void {
  const position = props.items.findIndex(item => item.index === selected.value?.index);
  const item = props.items[position + offset];
  if (item) void open(item);
}
watch(selected, value => { if (!value && dialog.value?.open) close(); });
onBeforeUnmount(close);
defineExpose({ open });
</script>

<template>
  <div v-if="items.length" class="question-board" data-testid="runner-question-board">
    <div class="board-legend" aria-label="题号颜色说明">
      <span class="legend-text">● 普通读取</span><span class="legend-image">● 图片处理</span><span class="legend-failed">● 最终未回填</span>
      <span class="board-hint">点击题号查看 Markdown / 图片</span>
    </div>
    <div class="question-tiles" role="group" aria-label="题目签到表">
      <button v-for="item in items" :key="`${item.index}:${item.fingerprint}`" type="button" class="question-tile"
        :class="'tile-' + status(item)" :data-status="status(item)" :data-testid="'runner-question-' + (item.index + 1)"
        :aria-label="`第 ${item.index + 1} 题 · ${labels[status(item)]}`" :aria-pressed="selected?.index === item.index"
        :title="`第 ${item.index + 1} 题 · ${labels[status(item)]}`" @click="open(item)">
        <strong>{{ item.index + 1 }}</strong><small aria-hidden="true">{{ marks[status(item)] }}</small>
      </button>
    </div>
  </div>
  <dialog ref="dialog" class="question-viewer" aria-labelledby="question-viewer-title" data-testid="runner-question-viewer" @close="selection = null">
    <template v-if="selected">
      <header class="viewer-header">
        <h2 id="question-viewer-title">第 {{ selected.index + 1 }} 题 <span :class="'legend-' + status(selected)">{{ labels[status(selected)] }}</span></h2>
        <div class="row"><button type="button" :disabled="selected.index === items[0]?.index" @click="move(-1)">上一题</button><button type="button" :disabled="selected.index === items[items.length - 1]?.index" @click="move(1)">下一题</button><button type="button" data-testid="runner-close-question" autofocus @click="close">关闭</button></div>
      </header>
      <div class="question-versions" data-testid="runner-source-question">
        <section class="version-pane" aria-label="Markdown 版本">
          <header><h3>Markdown</h3><button type="button" :data-testid="'runner-copy-question-' + (selected.index + 1)" @click="emit('copy', selected)">复制 Markdown</button></header>
          <pre data-testid="runner-question-markdown">{{ questionToMarkdown(selected.question) }}</pre>
        </section>
        <section class="version-pane" aria-label="图片版本">
          <header><h3>图片</h3><div class="row">
            <button type="button" :disabled="busy[selected.index]" :data-testid="'runner-preview-question-' + (selected.index + 1)" @click="emit('preview', selected)">{{ busy[selected.index] ? '读取中…' : '读取题图' }}</button>
            <template v-if="image"><button type="button" @click="naturalSize = !naturalSize">{{ naturalSize ? '适应窗口' : '原尺寸' }}</button><button type="button" @click="emit('copyImage', image)">复制图片</button><button type="button" @click="emit('downloadImage', image, selected.index)">下载图片</button></template>
          </div></header>
          <div class="version-image" :class="{ 'natural-size': naturalSize }">
            <img v-if="image" :src="image" alt="本题完整题干和选项" data-testid="runner-image" />
            <p v-else-if="busy[selected.index]" role="status">正在本地读取完整题图，不发送模型请求…</p>
            <p v-else-if="!errors[selected.index]" class="hint">点击「读取题图」查看图片版本。</p>
            <p v-if="errors[selected.index]" class="error" role="alert">{{ errors[selected.index] }}</p>
          </div>
        </section>
      </div>
      <p v-if="notice" class="viewer-notice" role="status">{{ notice }}</p>
    </template>
  </dialog>
</template>

<style scoped>
.question-board { display: flex; flex-direction: column; gap: 8px; }
.board-legend { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 12px; }
.legend-text { color: var(--success); }
.legend-image { color: var(--accent); }
.legend-failed { color: var(--danger); }
.board-hint { color: var(--fg-muted); margin-left: auto; }
.question-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: 6px; max-height: 264px; overflow-y: auto; padding: 3px; }
.question-tile { height: 44px; padding: 3px 6px; position: relative; border: 1px solid currentColor; box-shadow: none; font-variant-numeric: tabular-nums; }
.question-tile strong { font-size: 15px; }
.question-tile small { position: absolute; right: 3px; bottom: 1px; font-size: 9px; }
.question-tile.tile-text { color: var(--success); background: var(--success-soft); }
.question-tile.tile-image { color: var(--accent); background: var(--accent-soft); }
.question-tile.tile-failed { color: var(--danger); background: var(--danger-soft); }
.question-tile:hover { filter: brightness(.96); }
.question-tile[aria-pressed="true"] { outline: 2px solid currentColor; outline-offset: 1px; }
.question-viewer { width: min(1440px, 96vw); max-width: 96vw; height: 88dvh; max-height: 94dvh; padding: 0; border: 1px solid var(--border); border-radius: 10px; color: var(--fg); background: var(--surface); }
.question-viewer[open] { display: flex; flex-direction: column; }
.question-viewer::backdrop { background: rgb(0 0 0 / .45); }
.viewer-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.viewer-header h2 { margin: 0; font-size: 16px; }
.viewer-header h2 span { font-size: 12px; margin-left: 8px; font-weight: 400; }
.question-versions { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.version-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.version-pane + .version-pane { border-left: 1px solid var(--border); }
.version-pane > header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--border-muted); }
.version-pane h3 { font-size: 13px; margin: 0; }
.version-pane pre, .version-image { flex: 1; min-height: 0; margin: 0; padding: 12px; overflow: auto; }
.version-pane pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.65 ui-monospace, Consolas, monospace; background: var(--inset); }
.version-image { background: white; color: #1f2328; }
.version-image img { display: block; max-width: 100%; height: auto; border: 0; border-radius: 0; }
.version-image.natural-size img { max-width: none; }
.viewer-notice { margin: 0; padding: 6px 16px; font-size: 12px; border-top: 1px solid var(--border); }
@media (max-width: 640px) { .question-versions { overflow-x: auto; grid-template-columns: minmax(260px, 1fr) minmax(260px, 1fr); } .board-hint { margin-left: 0; } }
</style>
