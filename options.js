/**
 * options.js
 * 设置页脚本：读取/保存 chrome.storage.sync 中的 DeepSeek 配置、答题策略、
 * 兜底题库（参考 OCS AnswererWrapper 模式）、答案缓存开关/清理入口，
 * 以及共享云端题库配置（baseUrl / token / 最低票数 / 上传开关）+ 测试连接与队列管理。
 * 默认值与 lib/llm.js 的 DEFAULT_CONFIG 保持一致（sharedBank 与 lib/shared-bank.js 一致）。
 */
'use strict';

const NS = globalThis.AUTOQUIZ || {};

const DEFAULT_CONFIG = {
  apiKey: '',
  model: 'deepseek-chat',
  apiUrl: 'https://api.deepseek.com/chat/completions',
  batchSize: 10,
  autoFill: true,
  speedLevel: 'normal',
  blankSeparator: ',',
  cacheEnabled: true,
  questionBank: {
    enabled: false,
    url: '',
    method: 'POST',
    headers: '{"Content-Type":"application/json"}',
    dataTemplate: '{"title":"${title}"}',
    parseHandler:
      'return (res) => { const d = (res && res.data) || res || {}; const ans = d.answer !== undefined ? d.answer : d.answers; return [null, Array.isArray(ans) ? ans.join(",") : ans]; }',
    timeout: 15,
  },
  sharedBank: {
    enabled: false,
    baseUrl: '',
    token: '',
    minVotes: 2,
    officialFirst: true,
    uploadOnAnswer: true,
    uploadOnFeedback: true,
    timeout: 10,
  },
};

const els = {
  apiKey: document.getElementById('apiKey'),
  model: document.getElementById('model'),
  apiUrl: document.getElementById('apiUrl'),
  batchSize: document.getElementById('batchSize'),
  autoFill: document.getElementById('autoFill'),
  speedLevel: document.getElementById('speedLevel'),
  blankSeparator: document.getElementById('blankSeparator'),
  cacheEnabled: document.getElementById('cacheEnabled'),
  qbEnabled: document.getElementById('qbEnabled'),
  qbUrl: document.getElementById('qbUrl'),
  qbMethod: document.getElementById('qbMethod'),
  qbTimeout: document.getElementById('qbTimeout'),
  qbHeaders: document.getElementById('qbHeaders'),
  qbDataTemplate: document.getElementById('qbDataTemplate'),
  qbParseHandler: document.getElementById('qbParseHandler'),
  sbEnabled: document.getElementById('sbEnabled'),
  sbBaseUrl: document.getElementById('sbBaseUrl'),
  sbToken: document.getElementById('sbToken'),
  sbMinVotes: document.getElementById('sbMinVotes'),
  sbUploadOnAnswer: document.getElementById('sbUploadOnAnswer'),
  sbUploadOnFeedback: document.getElementById('sbUploadOnFeedback'),
  sbTestBtn: document.getElementById('sbTestBtn'),
  sbFlushBtn: document.getElementById('sbFlushBtn'),
  sbClearQueueBtn: document.getElementById('sbClearQueueBtn'),
  sbQueueInfo: document.getElementById('sbQueueInfo'),
  cacheStats: document.getElementById('cacheStats'),
  clearCacheBtn: document.getElementById('clearCacheBtn'),
  saveBtn: document.getElementById('saveBtn'),
  resetBtn: document.getElementById('resetBtn'),
  status: document.getElementById('status'),
};

function setStatus(text, ok) {
  els.status.textContent = text;
  els.status.className = ok ? 'ok' : 'err';
}

/** 深合并默认值（questionBank / sharedBank 子字段齐全） */
function mergeDefaults(stored) {
  const cfg = { ...DEFAULT_CONFIG, ...stored };
  cfg.questionBank = { ...DEFAULT_CONFIG.questionBank, ...(stored.questionBank || {}) };
  cfg.sharedBank = { ...DEFAULT_CONFIG.sharedBank, ...(stored.sharedBank || {}) };
  return cfg;
}

function collectConfig() {
  return {
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    apiUrl: els.apiUrl.value.trim(),
    batchSize: Math.max(1, parseInt(els.batchSize.value, 10) || 10),
    autoFill: els.autoFill.checked,
    speedLevel: els.speedLevel.value,
    blankSeparator: els.blankSeparator.value || ',',
    cacheEnabled: els.cacheEnabled.checked,
    questionBank: {
      enabled: els.qbEnabled.checked,
      url: els.qbUrl.value.trim(),
      method: els.qbMethod.value,
      headers: els.qbHeaders.value.trim(),
      dataTemplate: els.qbDataTemplate.value,
      parseHandler: els.qbParseHandler.value,
      timeout: Math.max(1, parseInt(els.qbTimeout.value, 10) || 15),
    },
    sharedBank: {
      enabled: els.sbEnabled.checked,
      baseUrl: els.sbBaseUrl.value.trim(),
      token: els.sbToken.value.trim(),
      minVotes: Math.max(1, parseInt(els.sbMinVotes.value, 10) || 2),
      officialFirst: true,
      uploadOnAnswer: els.sbUploadOnAnswer.checked,
      uploadOnFeedback: els.sbUploadOnFeedback.checked,
      timeout: 10,
    },
  };
}

function applyConfig(cfg) {
  els.apiKey.value = cfg.apiKey || '';
  els.model.value = cfg.model || '';
  els.apiUrl.value = cfg.apiUrl || '';
  els.batchSize.value = cfg.batchSize || 10;
  els.autoFill.checked = !!cfg.autoFill;
  els.speedLevel.value = cfg.speedLevel || 'normal';
  els.blankSeparator.value = cfg.blankSeparator || ',';
  els.cacheEnabled.checked = !!cfg.cacheEnabled;
  els.qbEnabled.checked = !!cfg.questionBank.enabled;
  els.qbUrl.value = cfg.questionBank.url || '';
  els.qbMethod.value = cfg.questionBank.method || 'POST';
  els.qbHeaders.value = cfg.questionBank.headers || '{"Content-Type":"application/json"}';
  els.qbDataTemplate.value = cfg.questionBank.dataTemplate || '';
  els.qbParseHandler.value = cfg.questionBank.parseHandler || '';
  els.qbTimeout.value = cfg.questionBank.timeout || 15;
  els.sbEnabled.checked = !!cfg.sharedBank.enabled;
  els.sbBaseUrl.value = cfg.sharedBank.baseUrl || '';
  els.sbToken.value = cfg.sharedBank.token || '';
  els.sbMinVotes.value = cfg.sharedBank.minVotes != null ? cfg.sharedBank.minVotes : 2;
  els.sbUploadOnAnswer.checked = cfg.sharedBank.uploadOnAnswer !== false;
  els.sbUploadOnFeedback.checked = cfg.sharedBank.uploadOnFeedback !== false;
}

async function loadOptions() {
  try {
    // 顶层存储（与 llm.loadConfig / content.getConfig 一致）；兼容旧版嵌套 config 数据
    let data = await chrome.storage.sync.get(DEFAULT_CONFIG);
    if (!data.apiKey && data.config && typeof data.config === 'object') {
      data = Object.assign({}, data.config);
    }
    applyConfig(mergeDefaults(data));
  } catch (err) {
    applyConfig(mergeDefaults({}));
  }
}

async function saveOptions() {
  const cfg = collectConfig();
  await chrome.storage.sync.set(cfg);
  return cfg;
}

async function refreshCacheStats() {
  if (!els.cacheStats) return;
  try {
    if (NS && NS.answerCache && typeof NS.answerCache.stats === 'function') {
      const s = await NS.answerCache.stats();
      els.cacheStats.textContent = `${s.count} 条 / ${(s.bytes / 1024).toFixed(1)} KB`;
    } else {
      els.cacheStats.textContent = '未加载';
    }
  } catch (err) {
    els.cacheStats.textContent = '未加载';
  }
}

async function refreshQueueInfo() {
  if (!els.sbQueueInfo) return;
  try {
    if (NS && NS.sharedBank && typeof NS.sharedBank.queueSize === 'function') {
      const n = await NS.sharedBank.queueSize();
      els.sbQueueInfo.textContent = `上传队列：${n} 条待重试（下次答题时自动补传）`;
    }
  } catch (err) {
    els.sbQueueInfo.textContent = '上传队列：-';
  }
}

function sbConfigFromForm() {
  return {
    enabled: els.sbEnabled.checked,
    baseUrl: els.sbBaseUrl.value.trim(),
    token: els.sbToken.value.trim(),
    minVotes: Math.max(1, parseInt(els.sbMinVotes.value, 10) || 2),
    uploadOnAnswer: els.sbUploadOnAnswer.checked,
    uploadOnFeedback: els.sbUploadOnFeedback.checked,
    timeout: 10,
  };
}

async function onTestSharedBank() {
  if (!NS || !NS.sharedBank) {
    setStatus('共享题库模块未加载', false);
    return;
  }
  const cfg = sbConfigFromForm();
  if (!cfg.baseUrl) {
    setStatus('请先填写服务端地址', false);
    return;
  }
  try {
    setStatus('正在测试连接...');
    const r = await NS.sharedBank.testConnection(cfg);
    const st = r.data || {};
    setStatus(
      `连接成功：题库 ${st.total_questions || 0} 题 / 答案 ${st.total_answers || 0} 条 / 累计上传 ${st.upload_total || 0} / 命中 ${st.hit_total || 0}`,
      true
    );
  } catch (err) {
    setStatus('连接失败：' + (err && err.message ? err.message : String(err)), false);
  }
}

async function onFlushQueue() {
  if (!NS || !NS.sharedBank) {
    setStatus('共享题库模块未加载', false);
    return;
  }
  try {
    setStatus('正在重试上传队列...');
    const cfg = sbConfigFromForm();
    const r = await NS.sharedBank.flushQueue(cfg);
    setStatus(`队列重试完成：已补传 ${r.flushed || 0} 条，剩余 ${r.remaining || 0} 条`, true);
    await refreshQueueInfo();
  } catch (err) {
    setStatus('队列重试失败：' + (err && err.message ? err.message : String(err)), false);
  }
}

async function onClearQueue() {
  if (!NS || !NS.sharedBank) {
    setStatus('共享题库模块未加载', false);
    return;
  }
  try {
    const n = await NS.sharedBank.clearQueue();
    setStatus(`已清空上传队列（${n} 条）`, true);
    await refreshQueueInfo();
  } catch (err) {
    setStatus('清空队列失败：' + (err && err.message ? err.message : String(err)), false);
  }
}

async function onSave() {
  try {
    const cfg = await saveOptions();
    // 保存后同步 shared-bank 模块内存配置，避免后续调用读到旧值
    if (NS && NS.sharedBank && typeof NS.sharedBank.setConfig === 'function') {
      NS.sharedBank.setConfig(cfg.sharedBank);
    }
    setStatus('设置已保存', true);
  } catch (err) {
    setStatus('保存失败：' + (err && err.message ? err.message : String(err)), false);
  }
}

async function onReset() {
  const cfg = mergeDefaults({});
  applyConfig(cfg);
  try {
    await chrome.storage.sync.set(cfg);
  } catch (err) {
    // 忽略
  }
  setStatus('已恢复默认设置', true);
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadOptions();
  await refreshCacheStats();
  await refreshQueueInfo();
  els.saveBtn.addEventListener('click', onSave);
  els.resetBtn.addEventListener('click', onReset);
  if (els.clearCacheBtn) {
    els.clearCacheBtn.addEventListener('click', async () => {
      if (NS && NS.answerCache) {
        await NS.answerCache.clear();
        await refreshCacheStats();
        setStatus('答案缓存已清空', true);
      }
    });
  }
  if (els.sbTestBtn) els.sbTestBtn.addEventListener('click', onTestSharedBank);
  if (els.sbFlushBtn) els.sbFlushBtn.addEventListener('click', onFlushQueue);
  if (els.sbClearQueueBtn) els.sbClearQueueBtn.addEventListener('click', onClearQueue);
});
