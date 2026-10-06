/**
 * options.js
 * 设置页脚本：读取/保存 chrome.storage.sync 中的 DeepSeek 配置与答题策略。
 * 默认值与 lib/llm.js 的 DEFAULT_CONFIG 保持一致。
 */
'use strict';

const DEFAULT_CONFIG = {
  apiKey: '',
  model: 'deepseek-chat',
  apiUrl: 'https://api.deepseek.com/chat/completions',
  batchSize: 10,
  autoFill: true,
  speedLevel: 'normal',
};

const els = {
  apiKey: document.getElementById('apiKey'),
  model: document.getElementById('model'),
  apiUrl: document.getElementById('apiUrl'),
  batchSize: document.getElementById('batchSize'),
  autoFill: document.getElementById('autoFill'),
  speedLevel: document.getElementById('speedLevel'),
  saveBtn: document.getElementById('saveBtn'),
  resetBtn: document.getElementById('resetBtn'),
  status: document.getElementById('status'),
};

function setStatus(text, ok) {
  els.status.textContent = text;
  els.status.className = ok ? 'ok' : 'err';
}

async function loadConfig() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_CONFIG);
    const cfg = { ...DEFAULT_CONFIG, ...stored };
    els.apiKey.value = cfg.apiKey || '';
    els.model.value = cfg.model || 'deepseek-chat';
    els.apiUrl.value = cfg.apiUrl || 'https://api.deepseek.com/chat/completions';
    els.batchSize.value = String(cfg.batchSize || 10);
    els.autoFill.checked = cfg.autoFill !== false;
    els.speedLevel.value = cfg.speedLevel || 'normal';
  } catch (err) {
    setStatus('读取配置失败：' + (err && err.message ? err.message : err), false);
  }
}

async function saveConfig() {
  const apiKey = els.apiKey.value.trim();
  const model = els.model.value.trim() || 'deepseek-chat';
  const apiUrl = els.apiUrl.value.trim() || 'https://api.deepseek.com/chat/completions';
  const batchSize = Math.min(50, Math.max(1, parseInt(els.batchSize.value, 10) || 10));

  if (!apiKey) {
    setStatus('请先填写 DeepSeek API Key', false);
    return;
  }

  const patch = {
    apiKey,
    model,
    apiUrl,
    batchSize,
    autoFill: els.autoFill.checked,
    speedLevel: els.speedLevel.value,
  };

  try {
    await chrome.storage.sync.set(patch);
    setStatus('保存成功（已同步到浏览器）', true);
  } catch (err) {
    setStatus('保存失败：' + (err && err.message ? err.message : err), false);
  }
}

async function resetConfig() {
  try {
    await chrome.storage.sync.set(DEFAULT_CONFIG);
    await loadConfig();
    setStatus('已恢复默认配置', true);
  } catch (err) {
    setStatus('重置失败：' + (err && err.message ? err.message : err), false);
  }
}

els.saveBtn.addEventListener('click', saveConfig);
els.resetBtn.addEventListener('click', resetConfig);

document.addEventListener('DOMContentLoaded', loadConfig);
