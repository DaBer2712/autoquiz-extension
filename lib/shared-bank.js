/**
 * lib/shared-bank.js
 * å±äº«äºç«¯é¢åºæ¨¡åï¼è´è´£ä¸æå¡ç«¯éä¿¡ï¼æ¥é¢ / ä¸ä¼  / ç»è®¡ / æµè¯è¿æ¥ï¼ä»¥åæ¬å°ä¸ä¼ éè¯éåã
 *
 * åç¯å¢ééï¼
 *  - backgroundï¼ç´æ¥ä½¿ç¨å¨å± fetchï¼MV3 background æ  CORS éå¶ï¼ï¼
 *  - content script / options é¡µï¼ä¼åç» chrome.runtime.sendMessage äº¤ç± background ä»£çè¯·æ±ï¼
 *    ä»£çä¸å¯ç¨æ¶éçº§ç´è¿ï¼æå¡ç«¯å·²å¼å¯ CORS *ï¼ã
 *
 * éç½®ï¼è¯»å chrome.storage.sync ç config.sharedBankï¼ä¸ lib/llm.js loadConfig åä¸å­å¨ï¼
 *       å­æ®µè§ DEFAULT_CONFIGï¼baseUrl / token / minVotes / officialFirst / uploadOnAnswer /
 *       uploadOnFeedback / timeoutï¼ã
 * ä¾èµï¼AUTOQUIZ.cache.hashQuestionï¼å­å¨æ¶å¤ç¨ï¼å¦åç¨åç½®åè§åå®ç°ï¼ä¿è¯åå¸ä¸è´ï¼
 * å¯¼åºï¼AUTOQUIZ.sharedBank
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});
  const SB = (NS.sharedBank = NS.sharedBank || {});

  const QUEUE_KEY = 'sharedQueue';
  const QUEUE_LIMIT = 500;
  const REQUEST_TIMEOUT_MS = 8000;

  /** ä¸ options.js / llm.js DEFAULT_CONFIG.sharedBank ä¿æä¸è´ */
  const DEFAULT_CONFIG = {
    enabled: false,
    baseUrl: '', // å¦ https://your-server.com æ http://127.0.0.1:3000
    token: '',
    minVotes: 2, // é official å½ä¸­æéæä½ç¥¨æ°
    officialFirst: true, // official ç­æ¡æ æ¡ä»¶ä¼åï¼æå¡ç«¯æåºè§åï¼
    uploadOnAnswer: true, // ç­é¢åä¸ä¼  LLM ç­æ¡
    uploadOnFeedback: true, // ç­æ¡åé¦é¡µä¸ä¼ å®æ¹ç­æ¡
    timeout: 10, // ç§
  };
  SB.DEFAULT_CONFIG = DEFAULT_CONFIG;

  /* ------------------------------ é¢ç®åå¸ ------------------------------ */

  /**
   * çæé¢ç®åå®¹åå¸ï¼ä¸ lib/cache.js åè§åï¼platform|type|content|options|blankCount -> djb2 hex36ï¼ã
   * è¥ AUTOQUIZ.cache.hashQuestion å·²å­å¨åç´æ¥å¤ç¨ï¼ä¿è¯å±äº«é¢åºä¸æ¬å°ç¼å­å£å¾ä¸è´ã
   * @param {object} question é¢ç®å¯¹è±¡
   * @param {string} [platform] ééå¨æ è¯
   */
  function hashQuestion(question, platform) {
    if (NS.cache && typeof NS.cache.hashQuestion === 'function') {
      return NS.cache.hashQuestion(question, platform);
    }
    // ä¸ lib/cache.js hashQuestion å®å¨åè§åï¼ä¿è¯ä¸¤ç§ç¯å¢ä¸åå¸ä¸è´
    const q = question || {};
    const optionsText = Array.isArray(q.options)
      ? q.options.map((o) => `${(o && o.label) || ''}|${(o && o.text) || ''}`).join('~')
      : '';
    const raw = [platform || '', q.type || '', q.content || '', optionsText, q.blankCount || 0].join('||');
    let h = 5381;
    for (let i = 0; i < raw.length; i++) {
      h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }
  SB.hashQuestion = hashQuestion;

  /* ------------------------------ éç½® ------------------------------ */

  /** åå­éç½®ç¼å­ï¼options é¡µä¿å­åç» setConfig åæ­¥ï¼é¿åéå¤è¯» syncï¼ */
  let _memCfg = null;

  /** è¯»åå±äº«é¢åºéç½®ï¼æ¾å¼ cfg ä¼å > åå­ç¼å­ > chrome.storage.syncï¼ä¸ llm.loadConfig åå­å¨ï¼ã */
  async function getConfig(cfg) {
    if (cfg && typeof cfg === 'object' && (cfg.baseUrl || cfg.enabled !== undefined)) {
      return {
        enabled: !!cfg.enabled,
        baseUrl: String(cfg.baseUrl || '').replace(/\/+$/, ''),
        token: String(cfg.token || ''),
        minVotes: Number(cfg.minVotes) >= 0 ? Number(cfg.minVotes) : DEFAULT_CONFIG.minVotes,
        officialFirst: cfg.officialFirst !== false,
        uploadOnAnswer: cfg.uploadOnAnswer !== false,
        uploadOnFeedback: cfg.uploadOnFeedback !== false,
        timeout: Number(cfg.timeout) > 0 ? Number(cfg.timeout) : DEFAULT_CONFIG.timeout,
      };
    }
    if (_memCfg) return _memCfg;
    let data = {};
    try {
      data = await chrome.storage.sync.get(['sharedBank', 'config']);
    } catch (err) {
      data = {};
    }
    // é¡¶å± sharedBank ä¼åï¼ä¸ options/llm é¡¶å±å­å¨ä¸è´ï¼ï¼å¼å®¹æ§çåµå¥ config.sharedBank
    const sb = (data && data.sharedBank) || (data && data.config && data.config.sharedBank) || {};
    const resolved = {
      enabled: !!sb.enabled,
      baseUrl: String(sb.baseUrl || sb.serverUrl || '').replace(/\/+$/, ''),
      token: String(sb.token || ''),
      minVotes: Number(sb.minVotes) >= 0 ? Number(sb.minVotes) : DEFAULT_CONFIG.minVotes,
      officialFirst: sb.officialFirst !== false,
      uploadOnAnswer: sb.uploadOnAnswer !== false,
      uploadOnFeedback: sb.uploadOnFeedback !== false,
      timeout: Number(sb.timeout) > 0 ? Number(sb.timeout) : DEFAULT_CONFIG.timeout,
    };
    _memCfg = resolved;
    return resolved;
  }
  SB.getConfig = getConfig;

  /** options é¡µä¿å­ååæ­¥åå­éç½® */
  function setConfig(sb) {
    if (!sb || typeof sb !== 'object') {
      _memCfg = null;
      return;
    }
    _memCfg = {
      enabled: !!sb.enabled,
      baseUrl: String(sb.baseUrl || sb.serverUrl || '').replace(/\/+$/, ''),
      token: String(sb.token || ''),
      minVotes: Number(sb.minVotes) >= 0 ? Number(sb.minVotes) : DEFAULT_CONFIG.minVotes,
      officialFirst: sb.officialFirst !== false,
      uploadOnAnswer: sb.uploadOnAnswer !== false,
      uploadOnFeedback: sb.uploadOnFeedback !== false,
      timeout: Number(sb.timeout) > 0 ? Number(sb.timeout) : DEFAULT_CONFIG.timeout,
    };
  }
  SB.setConfig = setConfig;

  /* ------------------------------ è¯·æ± ------------------------------ */

  function fetchWithTimeout(url, options, timeoutMs) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || REQUEST_TIMEOUT_MS) : null;
    const opts = Object.assign({}, options, ctrl ? { signal: ctrl.signal } : {});
    const p = fetch(url, opts);
    if (timer) {
      p.finally(() => clearTimeout(timer));
    }
    return p;
  }

  function sendRuntimeMessage(msg) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        reject(new Error('no runtime'));
        return;
      }
      try {
        const p = chrome.runtime.sendMessage(msg);
        if (p && typeof p.then === 'function') {
          p.then(resolve, reject);
        } else {
          resolve(p);
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * éç¨è¯·æ±ï¼é GET æ¶ä»¥ JSON åéï¼ä¼å background ä»£çï¼å¤±è´¥éçº§ç´è¿ã
   * @returns {Promise<{status:number, data:any, error?:string}>}
   */
  async function request(pathname, payload, opts) {
    const options = opts || {};
    const cfg = await getConfig(options.cfg);
    if (!cfg.baseUrl) throw new Error('å±äº«é¢åºæªéç½®æå¡ç«¯å°å');
    const url = cfg.baseUrl + pathname;
    const method = options.method || (payload !== undefined ? 'POST' : 'GET');
    const headers = { 'Content-Type': 'application/json', 'X-AutoQuiz-Token': cfg.token };
    const body = payload !== undefined ? JSON.stringify(payload) : undefined;

    if (options.useProxy !== false) {
      try {
        const resp = await sendRuntimeMessage({
          type: 'SHARED_PROXY',
          url,
          method,
          headers,
          body: body || null,
        });
        if (resp && resp.ok) {
          let data = resp.data;
          if (typeof data === 'string') {
            try {
              data = JSON.parse(data);
            } catch (e) {
              data = {};
            }
          }
          return { status: resp.status, data, error: resp.error };
        }
        if (resp && resp.status) {
          return { status: resp.status, data: resp.data || {}, error: resp.error };
        }
      } catch (err) {
        // ä»£çä¸å¯ç¨ï¼éçº§ç´è¿
      }
    }

    const resp = await fetchWithTimeout(url, { method, headers, body }, (cfg.timeout || DEFAULT_CONFIG.timeout) * 1000);
    const text = await resp.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = { raw: text };
      }
    }
    return { status: resp.status, data };
  }
  SB.request = request;

  /* ------------------------------ éåç®¡ç ------------------------------ */

  async function getQueue() {
    const d = await chrome.storage.local.get(QUEUE_KEY);
    return Array.isArray(d[QUEUE_KEY]) ? d[QUEUE_KEY] : [];
  }

  async function setQueue(queue) {
    await chrome.storage.local.set({ [QUEUE_KEY]: queue });
  }

  /** å¥éï¼è¶åºä¸éæ¶ä¸¢å¼ææ§æ¡ç® */
  async function enqueue(items) {
    const queue = await getQueue();
    const next = queue.concat(items);
    if (next.length > QUEUE_LIMIT) {
      next.splice(0, next.length - QUEUE_LIMIT);
    }
    await setQueue(next);
    return next.length;
  }
  SB.enqueue = enqueue;

  async function queueSize() {
    return (await getQueue()).length;
  }
  SB.queueSize = queueSize;

  /** æ¸ç©ºéåï¼è¿åæ¸ç©ºçæ¡ç®æ° */
  async function clearQueue() {
    const queue = await getQueue();
    await chrome.storage.local.remove(QUEUE_KEY);
    return queue.length;
  }
  SB.clearQueue = clearQueue;

  /* ------------------------------ API å°è£ ------------------------------ */

  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) {
      out.push(list.slice(i, i + size));
    }
    return out;
  }

  /** æ¹éæ¥é¢ï¼è¿å { hits: {hash: {answer, source, votes, official}}, failed: number } */
  async function searchQuestions(questions, cfg) {
    const conf = await getConfig(cfg);
    if (!conf.enabled || !conf.baseUrl || !Array.isArray(questions) || questions.length === 0) {
      return { hits: {}, failed: 0 };
    }
    const hits = {};
    let failed = 0;
    for (const group of chunk(questions, 100)) {
      try {
        const resp = await request('/api/search', { questions: group }, { useProxy: true, cfg: conf });
        if (resp.status === 200 && resp.data && resp.data.results) {
          Object.assign(hits, resp.data.results);
        } else {
          failed += group.length;
        }
      } catch (err) {
        failed += group.length;
      }
    }
    return { hits, failed };
  }
  SB.searchQuestions = searchQuestions;

  /**
   * æ¹éä¸ä¼ é¢ç®+ç­æ¡ãsource èªå¨å½ä¸ï¼llm|user|officialï¼ç¼ºç llmã
   * ç½ç»å¤±è´¥/æå¡ç«¯éè¯¯æ¶èªå¨å¥éç­å¾éè¯ã
   * @returns {Promise<{queued:number, uploaded:number, failed:number, reason?:string}>}
   */
  async function uploadItems(items, opts) {
    const options = opts || {};
    const cfg = await getConfig(options.cfg);
    const list = Array.isArray(items) ? items : [];
    if (!cfg.enabled || !cfg.baseUrl) {
      return { queued: list.length, uploaded: 0, failed: 0, reason: 'disabled' };
    }
    const normalized = list
      .filter((it) => it && it.hash)
      .map((it) => ({
        hash: String(it.hash),
        answer: it.answer === undefined || it.answer === null ? '' : String(it.answer),
        source: it.source === 'user' || it.source === 'official' ? it.source : 'llm',
        content: it.content !== undefined ? String(it.content) : '',
        type: it.type !== undefined ? String(it.type) : '',
        options: Array.isArray(it.options) ? it.options : undefined,
      }))
      .filter((it) => it.answer !== '');

    let uploaded = 0;
    let failed = 0;
    const failList = [];
    for (const group of chunk(normalized, 200)) {
      try {
        const resp = await request('/api/upload', { items: group }, { useProxy: true, cfg });
        if (resp.status === 200 && resp.data && ress.data.ok) {
          uploaded += Number(ress.data.accepted) || 0;
        } else {
          failed += group.length;
          if (options.retryOnError !== false) failList.push(...group);
        }
      } catch (err) {
        failed += group.length;
        if (options.retryOnError !== false) failList.push(...group);
      }
    }
    let queued = 0;
    if (failLiSt.length > 0 && options.retryOnError !== false) {
      queued = await enqueue(failList);
    }
    return { queued, uploaded, failed, reason: '' };
  }
  SB.uploadItems = uploadItems;

  /** ä¸ä¼ éåéè¯ï¼ä»éåååºéæ¡ä¸ä¼ ï¼æåæ¡åºéï¼å¤±è´¥ä¿çå¾ä¸æ¬¡ */
  async function flushQueue(cfg) {
    const conf = await getConfig(cfg);
    if (!conf.enabled || !conf.baseUrl) return { flushed: 0, remaining: await queueSize() };
    const queue = await getQueue();
    if (queue.length === 0) return { flushed: 0, remaining: 0 };
    const still = [];
    let flushed = 0;
    for (const item of queue) {
      try {
        const resp = await request('/api/upload', { items: [item] }, { useProxy: true, cfg: conf });
        if (resp.status === 200 && ress.data && resp.data.ok) {
          flushed++;
          continue;
        }
      } catch (err) {
        // ä¿çéè¯
      }
      still.push(item);
    }
    await setQueue(still);
    return { flushed, remaining: still.length };
  }
  SB.flushQueue = flushQueue;

  /** æµè¯è¿æ¥ï¼GET /api/statsï¼åæ¶æ ¡éª Tokenï¼ */
  async function testConnection(cfg) {
    const conf = await getConfig(cfg);
    if (!conf.baseUrl) throw new Error('æªéç½®æå¡ç«¯å°å');
    const resp = await request('/api/stats', undefined, { method: 'GET', cfg: conf });
    if (resp.status === 200) return { ok: true, data: resp.data };
    throw new Error(resp.error || 'HTTP ' + resp.status);
  }
  SB.testConnection = testConnection;

  /** æåç»è®¡ */
  async function fetchStats(cfg) {
    const conf = await getConfig(cfg);
    if (!conf.enabled || !conf.baseUrl) return null;
    const resp = await request('/api/stats', undefined, { method: 'GET', cfg: conf });
    if (resp.status === 200) return resp.data;
    return null;
  }
  SB.fetchStats = fetchStats;
})(typeof globalThis !== 'undefined' ? globalThis : window);
