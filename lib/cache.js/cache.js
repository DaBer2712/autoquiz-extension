/**
 * lib/cache.js
 * 题目答案缓存模块：同一套卷子（题目内容 hash 作为 key，含平台维度）重复作答时
 * 直接复用上次 LLM / 题库返回的答案并跳过 API 调用。
 * 缓存存 chrome.storage.local（键 autoquiz_cache_v1），options 页提供统计与清理入口。
 *
 * 依赖：无（独立 IIFE 模块）
 * 导出：AUTOQUIZ.answerCache = { STORE_KEY, hashQuestion, get, set, clear, stats }
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});
  const STORE_KEY = 'autoquiz_cache_v1';

  /** djb2 风格字符串 hash（转 36 进制短串） */
  function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  /**
   * 生成题目缓存 key：平台 + 题型 + 题干 + 选项文本 + 空位数 的 hash。
   * @param {object} question 题目对象
   * @param {string} [platform] 适配器标识（如 chaoxing / rain-classroom）
   */
  function hashQuestion(question, platform) {
    const q = question || {};
    const optionsText = Array.isArray(q.options)
      ? q.options.map((o) => `${o.label || ''}|${o.text || ''}`).join('~')
      : '';
    const raw = [platform || '', q.type || '', q.content || '', optionsText, q.blankCount || 0].join('||');
    return hashString(raw);
  }

  async function readStore() {
    try {
      const data = await chrome.storage.local.get(STORE_KEY);
      return (data && data[STORE_KEY]) || {};
    } catch {
      return {};
    }
  }

  /**
   * 读取缓存答案：命中返回 { value, source: 'cache' }，未命中返回 null。
   * @param {object} question 题目对象
   * @param {string} [platform] 平台标识
   */
  async function get(question, platform) {
    try {
      const store = await readStore();
      const key = hashQuestion(question, platform);
      const entry = store[key];
      if (!entry || entry.value === undefined) return null;
      return { value: entry.value, source: 'cache', key };
    } catch {
      return null;
    }
  }

  /**
   * 写入缓存（answer 可为字符串/数组；null/undefined 不缓存）。
   * @param {object} question 题目对象
   * @param {*} answer 答案
   * @param {string} [platform] 平台标识
   */
  async function set(question, answer, platform) {
    if (answer === undefined || answer === null) return;
    try {
      const store = await readStore();
      store[hashQuestion(question, platform)] = { value: answer, ts: Date.now() };
      await chrome.storage.local.set({ [STORE_KEY]: store });
    } catch (err) {
      console.warn('[AutoQuiz] 答案缓存写入失败：', err);
    }
  }

  /** 清空全部答案缓存 */
  async function clear() {
    try {
      await chrome.storage.local.remove(STORE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  /** 缓存统计：条目数 + 估算字节数 */
  async function stats() {
    try {
      const store = await readStore();
      const keys = Object.keys(store);
      let bytes = 0;
      try {
        bytes = new Blob([JSON.stringify(store)]).size;
      } catch {
        bytes = 0;
      }
      return { count: keys.length, bytes };
    } catch {
      return { count: 0, bytes: 0 };
    }
  }

  NS.answerCache = {
    STORE_KEY,
    hashQuestion,
    get,
    set,
    clear,
    stats,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
