/**
 * background.js
 * MV3 service worker：监听 chrome.runtime.onMessage，
 * 收到 GET_ANSWERS 消息后读取 chrome.storage 配置，调用 lib/llm.js 请求 DeepSeek，
 * 将答案（或错误）返回给 content script，并透传错误消息。
 *
 * 依赖：lib/types.js、lib/llm.js（经 importScripts 加载）
 */
'use strict';

importScripts('lib/types.js', 'lib/llm.js');

const NS = globalThis.AUTOQUIZ;
const llm = NS && NS.llm;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 仅处理 GET_ANSWERS 消息
  if (!message || message.type !== 'GET_ANSWERS') {
    return false;
  }

  const questions = Array.isArray(message.questions) ? message.questions : [];

  if (!llm) {
    sendResponse({ ok: false, error: 'LLM 模块未加载（lib/llm.js 缺失）' });
    return false;
  }

  // 异步处理，返回 true 以保持消息通道开启
  (async () => {
    try {
      const config = await llm.loadConfig();
      if (!config.apiKey) {
        sendResponse({ ok: false, error: '未配置 DeepSeek API Key，请先点击插件图标打开设置页填写' });
        return;
      }

      const result = await llm.requestAnswers(questions, config);
      if (result.ok) {
        // 透传答案列表（background 不校验答案结构，交给 content 侧处理）
        sendResponse({ ok: true, answers: result.answers, raw: result.raw });
      } else {
        // 错误透传：未配置 / 网络失败 / 解析失败等
        sendResponse({ ok: false, error: result.error || 'DeepSeek 请求失败', raw: result.raw });
      }
    } catch (err) {
      sendResponse({ ok: false, error: `后台执行异常：${err && err.message ? err.message : String(err)}` });
    }
  })();

  return true; // 异步 sendResponse
});

// 服务存活期日志（便于调试）
console.log('[AutoQuiz] background service worker 已启动');
