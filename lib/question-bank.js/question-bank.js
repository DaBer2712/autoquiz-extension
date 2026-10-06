/**
 * lib/question-bank.js
 * 题库接口兜底模块：当 LLM 对某题返回 answer=null 时，自动调用用户配置的查题接口。
 * 参考 OCS answer.wrapper.handler.ts 的 AnswererWrapper 模式：
 *  - url / method / headers / data 模板 + ${title} 等占位符替换
 *  - GET 请求将 dataTemplate 字段拼接到 URL query；POST 请求将 dataTemplate 作为请求体
 *  - 响应解析函数（parseHandler，用户可自定义，参考 OCS handler 返回函数）
 *
 * 运行环境：background service worker（经 importScripts 加载）。
 * 依赖：无（独立 IIFE 模块）
 * 导出：AUTOQUIZ.questionBank = { DEFAULT_QUESTION_BANK, resolveTemplate, parseJsonish, runHandler, queryQuestion, queryForQuestions }
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});

  /** 兜底题库默认配置（options 页持久化到 chrome.storage.sync 的 questionBank 字段） */
  const DEFAULT_QUESTION_BANK = {
    enabled: false,
    url: '', // 查题接口 URL 模板，支持 ${title}（自动 encodeURIComponent）
    method: 'POST', // GET / POST
    headers: '{"Content-Type":"application/json"}',
    // POST 请求体模板（JSON 字符串，值支持 ${title}）；GET 时按 JSON 对象字段拼接到 URL query
    dataTemplate: '{"title":"${title}"}',
    // 响应解析函数：接收响应体（已尝试 JSON.parse），返回 [question, answer] 或 { answer / answers }
    parseHandler:
      'return (res) => { const d = (res && res.data) || res || {}; const ans = d.answer !== undefined ? d.answer : d.answers; return [null, Array.isArray(ans) ? ans.join(",") : ans]; }',
    timeout: 15, // 单次查题超时（秒）
  };

  /** 替换 ${xxx} 占位符（参考 OCS resolvePlaceHolder；GET 场景对值做 encodeURIComponent） */
  function resolveTemplate(template, env, encodeUri) {
    if (typeof template !== 'string') return template;
    return String(template).replace(/\${(.*?)}/g, (whole, key) => {
      const k = key.trim();
      const value = env[k] !== undefined ? env[k] : '';
      return encodeUri ? encodeURIComponent(String(value)) : String(value);
    });
  }

  /** 解析用户配置的 headers / dataTemplate（JSON 字符串 -> 对象；失败返回 fallback） */
  function parseJsonish(text, fallback) {
    if (!text || typeof text !== 'string') return fallback;
    try {
      return JSON.parse(text);
    } catch (err) {
      console.warn('[AutoQuiz] 题库 headers/dataTemplate 不是合法 JSON，已使用默认值：', text);
      return fallback;
    }
  }

  /**
   * 执行响应解析函数（参考 OCS：Function(handler)() 返回处理函数后调用）。
   * 兼容返回形态：
   *  - 一维数组 [question, answer]
   *  - 二维数组 [[q,a], [q,a], ...]（取首个 question 非空项）
   *  - 对象 { question, answer } / { answer } / { answers }
   * @returns {{question: (string|null), answer: *}}
   */
  function runHandler(handlerText, response) {
    // eslint-disable-next-line no-new-func
    const handler = new Function(handlerText)();
    if (typeof handler !== 'function') {
      throw new Error('题库响应解析函数必须返回一个函数');
    }
    const info = handler(response);
    if (Array.isArray(info)) {
      if (info.length >= 2 && !Array.isArray(info[0]) && !Array.isArray(info[1])) {
        return { question: info[0] === undefined ? null : info[0], answer: info[1] };
      }
      if (info.every((item) => Array.isArray(item))) {
        const match = info.find((item) => item[0] !== undefined && item[0] !== null);
        return { question: match ? match[0] : null, answer: match ? match[1] : undefined };
      }
    }
    if (info && typeof info === 'object') {
      const answer = info.answer !== undefined ? info.answer : info.answers;
      return { question: info.question !== undefined ? info.question : null, answer };
    }
    return { question: null, answer: undefined };
  }

  /**
   * 查询单题：命中返回 { answer, source: 'question_bank' }，失败/未命中返回 null。
   * @param {object} question 题目对象（content/options/type/id/number）
   * @param {object} [cfg] 覆盖默认的题库配置
   */
  async function queryQuestion(question, cfg) {
    const config = Object.assign({}, DEFAULT_QUESTION_BANK, cfg || {});
    const urlTemplate = config.url || '';
    if (!urlTemplate) return null;

    const env = {
      title: (question && (question.content || question.title)) || '',
      id: question && question.id !== undefined ? String(question.id) : '',
      type: question && question.type ? String(question.type) : '',
      number: question && question.number ? String(question.number) : '',
      options: Array.isArray(question && question.options)
        ? question.options.map((o) => `${o.label || ''}. ${o.text || ''}`).join(' ')
        : '',
    };

    const method = String(config.method || 'POST').toUpperCase();
    const timeoutMs = Math.max(1, Number(config.timeout) || 15) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let url = resolveTemplate(urlTemplate, env, true);
      const headers = parseJsonish(config.headers, {});
      let body = null;

      if (method === 'GET') {
        // GET：dataTemplate 按 JSON 对象字段拼接到 URL query（参考 OCS searchParams.set）
        const data = parseJsonish(config.dataTemplate, null);
        if (data && typeof data === 'object') {
          const u = new URL(url);
          Object.keys(data).forEach((k) => {
            u.searchParams.set(k, resolveTemplate(data[k], env, false));
          });
          url = u.toString();
        }
      } else {
        // POST 等：dataTemplate 模板替换后作为请求体
        const data = resolveTemplate(config.dataTemplate, env, false);
        body = data || null;
        if (body && !headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn('[AutoQuiz] 题库请求失败：HTTP', res.status, url);
        return null;
      }

      const text = await res.text().catch(() => '');
      let response = null;
      if (text) {
        try {
          response = JSON.parse(text);
        } catch {
          response = text;
        }
      }

      const parsed = runHandler(config.parseHandler || DEFAULT_QUESTION_BANK.parseHandler, response);
      const answer = parsed.answer;
      if (answer === undefined || answer === null) return null;
      return { answer, question: parsed.question, source: 'question_bank' };
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      console.warn(
        '[AutoQuiz] 题库兜底查询异常：',
        aborted ? `超时（${timeoutMs / 1000}s）` : (err && err.message ? err.message : err),
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 对多题并发查题（单题失败不影响其他）。
   * @param {Array<object>} questions 题目数组
   * @param {object} [cfg] 题库配置
   * @returns {Promise<Object<string, {answer: *, source: string}>>} id -> 命中结果
   */
  async function queryForQuestions(questions, cfg) {
    if (!Array.isArray(questions) || questions.length === 0) return {};
    const results = await Promise.allSettled(questions.map((q) => queryQuestion(q, cfg)));
    const map = {};
    results.forEach((r, i) => {
      const q = questions[i];
      if (r.status === 'fulfilled' && r.value) {
        map[String(q.id)] = r.value;
      }
    });
    return map;
  }

  NS.questionBank = {
    DEFAULT_QUESTION_BANK,
    resolveTemplate,
    parseJsonish,
    runHandler,
    queryQuestion,
    queryForQuestions,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
