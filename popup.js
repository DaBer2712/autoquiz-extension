/**
 * popup.js
 * 弹出面板脚本：显示当前配置状态（是否已填 Key）、打开设置页、
 * 一键向当前标签页发送 START_ANSWER 消息（复用 content.js 的答题流程）。
 */
'use strict';

const configStatusEl = document.getElementById('configStatus');
const startBtn = document.getElementById('startBtn');
const openOptionsBtn = document.getElementById('openOptionsBtn');

/** 获取当前活动标签页 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** 判断当前标签页是否为学习通答题页（依据 URL） */
function isChaoxingPage(url) {
  if (!url) return false;
  return /https:\/\/([a-z0-9-]+\.)*chaoxing\.com\/.*\/(work|exam|test)/i.test(url);
}

/** 刷新配置状态展示 */
async function refreshStatus() {
  try {
    const cfg = await chrome.storage.sync.get({ apiKey: '', model: 'deepseek-chat', autoFill: true, speedLevel: 'normal' });
    const hasKey = !!(cfg.apiKey && cfg.apiKey.trim());
    const tab = await getActiveTab();
    const onPage = isChaoxingPage(tab && tab.url);

    if (!hasKey) {
      configStatusEl.className = 'status-box warn';
      configStatusEl.querySelector('.value').textContent = '未配置 API Key，请先打开设置页填写';
      startBtn.disabled = true;
    } else {
      configStatusEl.className = 'status-box ok';
      configStatusEl.querySelector('.value').textContent =
        `已配置 · ${cfg.model || 'deepseek-chat'} · 自动填写${cfg.autoFill !== false ? '开' : '关'} · 档位${cfg.speedLevel || 'normal'}`;
      startBtn.disabled = !onPage;
      if (!onPage) {
        configStatusEl.className = 'status-box warn';
        configStatusEl.querySelector('.value').textContent = '当前页面不是学习通答题页，无法一键答题';
      }
    }
  } catch (err) {
    configStatusEl.className = 'status-box warn';
    configStatusEl.querySelector('.value').textContent = '读取配置失败：' + (err && err.message ? err.message : err);
    startBtn.disabled = true;
  }
}

/** 向当前标签页 content script 发送 START_ANSWER 消息 */
async function startAnswerInTab() {
  startBtn.disabled = true;
  startBtn.textContent = '指令已发送…';
  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      startBtn.textContent = '开始AI答题';
      startBtn.disabled = false;
      return;
    }
    // 向当前标签页 content script 投递 START_ANSWER
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'START_ANSWER' });
    } catch {
      // content script 未注入（页面未加载完成/扩展刚安装），提示刷新
      startBtn.textContent = '页面脚本未就绪，请刷新后重试';
      startBtn.disabled = false;
      return;
    }
    startBtn.textContent = '指令已发送，请查看页面悬浮条';
    setTimeout(() => {
      startBtn.textContent = '开始AI答题';
      startBtn.disabled = false;
      refreshStatus();
    }, 2500);
  } catch (err) {
    startBtn.textContent = '发送失败：' + (err && err.message ? err.message : err);
    setTimeout(() => {
      startBtn.textContent = '开始AI答题';
      startBtn.disabled = false;
    }, 2500);
  }
}

startBtn.addEventListener('click', startAnswerInTab);
openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

document.addEventListener('DOMContentLoaded', refreshStatus);
