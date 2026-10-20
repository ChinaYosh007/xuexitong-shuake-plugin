<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import type { StudyAnswer } from "@study/contracts";
import {
  PRESETS, askLocalProvider, ensureOriginPermission, fetchLocalModels, loadActiveProvider,
  loadLocalProviders, normalizeProvider, originPattern, saveLocalProviders, setActiveProvider
} from "../local/provider";
import type { LocalProvider } from "../local/provider";
import UpdateMenu from "../updates/UpdateMenu.vue";

const providers = ref<LocalProvider[]>([]);
const activeId = ref<string | null>(null);
const draft = reactive<LocalProvider>(normalizeProvider(PRESETS[0]!));
const models = ref<string[]>([]);
const notice = ref("");
const error = ref("");
const busy = ref(false);

async function refresh(): Promise<void> {
  providers.value = await loadLocalProviders();
  activeId.value = (await loadActiveProvider())?.id ?? null;
}

function select(provider: LocalProvider): void {
  Object.assign(draft, JSON.parse(JSON.stringify(provider)) as LocalProvider);
  draft.supportsImages = provider.supportsImages !== false;
  models.value = [];
  notice.value = "";
  error.value = "";
}

function blank(): void {
  // Keep the placeholder invalid without naming a public API host (security-static.test.ts
  // allows public origins only in the provider presets module). Validation happens on save.
  Object.assign(draft, {
    id: "lp_" + crypto.randomUUID(),
    name: "新供应商",
    baseUrl: "https://",
    protocol: "CHAT_COMPLETIONS",
    model: "",
    apiKey: "",
    instructionRole: "system",
    outputMode: "PROMPT_JSON",
    tokenLimitField: "max_tokens",
    supportsTemperature: false,
    supportsStoreFalse: false,
    maxOutputTokens: 2048,
    temperature: null,
    supportsImages: true
  } as LocalProvider);
  models.value = [];
  notice.value = "";
  error.value = "";
}

function applyPreset(index: number): void {
  const preset = PRESETS[index];
  if (!preset) return;
  // Never carry the previous provider's API key to a preset endpoint: it would be sent to a
  // different host on the first test/request. The user must paste the key again.
  Object.assign(draft, normalizeProvider({ ...preset, apiKey: "" }));
  models.value = [];
  notice.value = "已填入预设，请补充 API Key 与模型。";
}

async function saveProvider(): Promise<void> {
  error.value = ""; notice.value = "";
  try {
    const normalized = normalizeProvider(draft);
    if (!normalized.model) throw new Error("请填写模型名称");
    if (!normalized.apiKey) throw new Error("请填写 API Key（仅保存在本机扩展存储）");
    const next = providers.value.filter(provider => provider.id !== normalized.id).concat(normalized);
    await saveLocalProviders(next);
    if (!activeId.value) await setActiveProvider(normalized.id);
    Object.assign(draft, normalized);
    await refresh();
    activeId.value = (await loadActiveProvider())?.id ?? null;
    notice.value = "已保存。可在侧边栏直接使用，无需登录。";
  } catch (e) {
    error.value = e instanceof Error ? e.message : "保存失败";
  }
}

async function removeProvider(id: string): Promise<void> {
  const next = providers.value.filter(provider => provider.id !== id);
  await saveLocalProviders(next);
  if (activeId.value === id) {
    const fallback = next[0];
    if (fallback) await setActiveProvider(fallback.id);
  }
  await refresh();
}

async function makeActive(id: string): Promise<void> {
  await setActiveProvider(id);
  activeId.value = id;
  notice.value = "已设为默认供应商。";
}

async function authorize(): Promise<void> {
  error.value = "";
  try {
    const normalized = normalizeProvider(draft);
    const granted = await ensureOriginPermission(normalized.baseUrl);
    notice.value = granted ? "已授权访问 " + originPattern(normalized.baseUrl) : "授权被取消，无法请求该供应商。";
  } catch (e) {
    error.value = e instanceof Error ? e.message : "授权失败";
  }
}

async function loadModels(): Promise<void> {
  error.value = ""; busy.value = true;
  try {
    const normalized = normalizeProvider(draft);
    await ensureOriginPermission(normalized.baseUrl);
    models.value = await fetchLocalModels(normalized);
    if (!models.value.includes(draft.model)) {
      if (draft.model) notice.value = "当前模型「" + draft.model + "」不在供应商列表，已改为 " + models.value[0] + "；请确认后保存。";
      draft.model = models.value[0]!;
    }
    notice.value = (notice.value || "已读取 " + models.value.length + " 个模型。");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "读取模型失败";
  } finally {
    busy.value = false;
  }
}

async function testProvider(): Promise<void> {
  error.value = ""; notice.value = ""; busy.value = true;
  try {
    const normalized = normalizeProvider(draft);
    await ensureOriginPermission(normalized.baseUrl);
    const question = {
      id: "probe_1", type: "SINGLE_CHOICE" as const, stem: "1 + 1 等于多少？",
      options: [{ id: "opt_1", text: "2" }, { id: "opt_2", text: "3" }], blanks: []
    };
    const answer: StudyAnswer = await askLocalProvider(normalized, question);
    notice.value = "测试成功：" + answer.status + (answer.selectedOptionIds.length ? " · " + answer.selectedOptionIds.join(",") : "");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "测试失败";
  } finally {
    busy.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <main class="app options">
    <header class="topbar">
      <div>
        <h1>学习助手设置</h1>
        <p class="muted">本地直连：API Key 只保存在本机扩展存储，不经过任何本产品服务器。</p>
      </div>
      <UpdateMenu :disabled="busy" />
    </header>

    <section class="card">
      <h2>已保存的供应商</h2>
      <table v-if="providers.length">
        <thead><tr><th>名称</th><th>协议</th><th>模型</th><th>默认</th><th></th></tr></thead>
        <tbody>
          <tr v-for="provider in providers" :key="provider.id">
            <td>{{ provider.name }}</td>
            <td>{{ provider.protocol }}</td>
            <td>{{ provider.model }}</td>
            <td><span v-if="provider.id === activeId">默认</span><button v-else class="link" @click="makeActive(provider.id)">设为默认</button></td>
            <td class="row">
              <button class="link" @click="select(provider)">编辑</button>
              <button class="link" @click="removeProvider(provider.id)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">还没有供应商，使用下面预设或自定义后保存，即可无需登录直接使用。</p>
      <div class="row">
        <button class="link" @click="applyPreset(0)">用 DeepSeek 预设</button>
        <button class="link" @click="applyPreset(1)">用 OpenAI 兼容预设</button>
        <button class="link" @click="blank">新建空白配置</button>
      </div>
    </section>

    <section class="card">
      <h2>编辑供应商</h2>
      <label>名称<input v-model="draft.name" /></label>
      <label>Base URL（API 根路径）
        <input v-model="draft.baseUrl" placeholder="供应商 API 根地址（可先用上方预设自动填入）" @input="draft.apiKey = ''" />
      </label>
      <p class="hint">手动修改 Base URL 会清空当前编辑中的旧 Key，请确认地址后重新填写。</p>
      <label>协议
        <select v-model="draft.protocol">
          <option value="CHAT_COMPLETIONS">Chat Completions</option>
          <option value="RESPONSES">Responses</option>
        </select>
      </label>
      <label>API Key（本机保存）
        <input v-model="draft.apiKey" type="password" autocomplete="off" />
      </label>
      <label>模型
        <select v-if="models.length" v-model="draft.model">
          <option v-for="model in models" :key="model" :value="model">{{ model }}</option>
        </select>
        <input v-else v-model="draft.model" placeholder="先点下方「读取模型」，或手动填写供应商支持的模型名" />
      </label>
      <div class="row">
        <button class="link" :disabled="busy" @click="authorize">授权此站点</button>
        <button class="link" :disabled="busy" @click="loadModels">{{ busy ? "读取中…" : "读取模型" }}</button>
        <button class="link" :disabled="busy" @click="testProvider">测试连接</button>
        <button :disabled="busy" @click="saveProvider">保存</button>
      </div>
      <p class="hint">首次使用需点「授权此站点」，Chrome 会弹出该供应商域名的访问授权；可随时在扩展详情页撤销。</p>
      <p class="hint">输出模式：默认按提示词要求 JSON；如供应商支持 JSON 模式可在高级项切换。</p>
      <label>输出模式
        <select v-model="draft.outputMode">
          <option value="JSON_OBJECT">JSON_OBJECT</option>
          <option value="PROMPT_JSON">PROMPT_JSON</option>
        </select>
      </label>
      <label>指令角色
        <select v-model="draft.instructionRole">
          <option value="system">system</option>
          <option value="developer">developer</option>
        </select>
      </label>
      <label>最大输出 token<input v-model.number="draft.maxOutputTokens" type="number" min="128" max="4096" /></label>
      <label><input v-model="draft.supportsImages" type="checkbox" />
        支持图像输入（多模态）——图片题会把渲染的题图随请求发送；文字模型请取消勾选</label>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="notice" class="hint">{{ notice }}</p>
    </section>

    <section class="card">
      <h2>隐私与安全</h2>
      <ul class="plain">
        <li>不读取学习通 Cookie、Local Storage 或完整页面 HTML。</li>
        <li>API Key 仅保存在本机 chrome.storage.local，不发送给本产品服务器；题目只发给你选择的供应商。</li>
        <li>题目与答案仅在本次面板内存中处理，关闭面板即清除。</li>
        <li>回填仅对已验证的适配页面开放；正式考试与计分页不提供回填。</li>
      </ul>
    </section>
  </main>
</template>
