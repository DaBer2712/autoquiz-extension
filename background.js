/**
 * background.js
 * MV3 service worker：监听 chrome.runtime.onMessage，
 * 收到 GET_ANSWERS 消息后读取 chrome.storage 配置，调用 lib/llm.js 请求 DeepSeek，
 * 将答案（或错误）返回给 content script，并透传错误消息。
 *
 * 依赖：lib/types.js、lib/llm.js（经 importScripts 加载）
 */
'use strict';

importScripts('lib/types.js', 'lib/llm.js', 'lib/question-bank.js', 'lib/shared-bank.js');

const NS = globalThis.AUTOQUIZ;
const llm = NS && NS.llm;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;
  const type = message.type;
  const sb = NS && NS.sharedBank;

  // ---------- 共享题库消息（SHARED_PROXY / SHARED_SEARCH / SHARED_UPLOAD / SHARED_STATS / SHARED_TEST） ----------

  // SHARED_PROXY：由 lib/shared-bank.js 请求代理，background 直接 fetch（无 CORS 限制）
  if (type === 'SHARED_PROXY') {
    (async () => {
      try {
        const url = message.url || '';
        const method = message.method || 'GET';
        const headers = message.headers || {};
        const body = message.body;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        try {
          const resp = await fetch(url, {
            method,
            headers,
            body: body !== null && body !== undefined ? body : undefined,
            signal: ctrl.signal,
          });
          const text = await resp.text();
          let data = text;
          try {
            data = JSON.parse(text);
          } catch (e) {
            // 保留原始文本
          }
          sendResponse({ ok: true, status: resp.status, data, error: '' });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        sendResponse({ ok: false, status: 0, data: null, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 共享题库：查题
  if (type === 'SHARED_SEARCH') {
    (async () => {
      if (!sb) {
        sendResponse({ ok: false, error: '共享题库模块未加载（lib/shared-bank.js 缺失）' });
        return;
      }
      try {
        const r = await sb.searchQuestions(Array.isArray(message.questions) ? message.questions : []);
        sendResponse({ ok: true, hits: r.hits || {}, failed: r.failed || 0 });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 共享题库：上传
  if (type === 'SHARED_UPLOAD') {
    (async () => {
      if (!sb) {
        sendResponse({ ok: false, error: '共享题库模块未加载（lib/shared-bank.js 缺失）' });
        return;
      }
      try {
        const r = await sb.uploadItems(Array.isArray(message.items) ? message.items : []);
        sendResponse({ ok: true, queued: r.queued || 0, uploaded: r.uploaded || 0, failed: r.failed || 0, reason: r.reason || '' });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 共享题库：统计
  if (type === 'SHARED_STATS') {
    (async () => {
      if (!sb) {
        sendResponse({ ok: false, error: '共享题库模块未加载（lib/shared-bank.js 缺失）' });
        return;
      }
      try {
        const stats = await sb.fetchStats();
        sendResponse({ ok: true, stats });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 共享题库：测试连接
  if (type === 'SHARED_TEST') {
    (async () => {
      if (!sb) {
        sendResponse({ ok: false, error: '共享题库模块未加载（lib/shared-bank.js 缺失）' });
        return;
      }
      try {
        const r = await sb.testConnection();
        sendResponse({ ok: true, data: r.data || {} });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // ---------- 原有 GET_ANSWERS：调用 LLM 答题 ----------

  // 仅处理 GET_ANSWERS 消息
  if (type !== 'GET_ANSWERS') {
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
        // 每项答案标记来源：llm / question_bank / miss
        let answers = Array.isArray(result.answers) ? result.answers : [];
        answers = answers.map((a) => ({
          id: a && a.id !== undefined ? a.id : undefined,
          answer: a && a.answer !== undefined ? a.answer : null,
          source: a && a.answer !== undefined && a.answer !== null ? 'llm' : 'miss',
        }));

        // 题库接口兜底：LLM answer=null 的题目自动查用户配置的题库（参考 OCS AnswererWrapper）
        const qbConfig = config.questionBank || {};
        if (questionBank && qbConfig.enabled && qbConfig.url) {
          const idSet = new Set();
          answers.forEach((a) => {
            if (a.answer === null) idSet.add(String(a.id));
          });
          if (idSet.size > 0) {
            const missing = questions.filter((q) => idSet.has(String(q.id)));
            const hits = await questionBank.queryForQuestions(missing, qbConfig);
            answers = answers.map((a) => {
              if (a.answer === null && hits[String(a.id)]) {
                return { id: a.id, answer: hits[String(a.id)].answer, source: 'question_bank' };
              }
              return a;
            });
          }
        }
        sendResponse({ ok: true, answers, raw: result.raw });
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
