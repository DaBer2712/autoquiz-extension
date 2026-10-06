/**
 * lib/llm.js
 * DeepSeek API 调用封装（OpenAI 兼容协议）。
 * 运行环境：background service worker（经 importScripts 加载），也可在 options/popup 页面复用。
 *
 * 依赖：AUTOQUIZ.types（题型枚举/中文名）
 * 导出：AUTOQUIZ.llm = { DEFAULT_CONFIG, loadConfig, saveConfig, buildMessages, requestAnswers, parseJsonResponse }
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});
  const TYPES = NS.QUESTION_TYPES || {};
  const LABELS = NS.QUESTION_TYPE_LABELS || {};

  /** 默认配置（chrome.storage.sync 中缺省值） */
  const DEFAULT_CONFIG = {
    apiKey: '', // DeepSeek API Key
    model: 'deepseek-chat', // 模型名
    apiUrl: 'https://api.deepseek.com/chat/completions', // OpenAI 兼容端点
    batchSize: 10, // 每批题目数
    autoFill: true, // 获取答案后是否自动填写
    speedLevel: 'normal', // 答题速度档位: slow / normal / fast
  };

  /** 速度档位 -> [最小延迟ms, 最大延迟ms] */
  const SPEED_RANGES = {
    slow: [1000, 2500],
    normal: [500, 1500],
    fast: [150, 500],
  };

  /** 单次请求超时时间（ms） */
  const REQUEST_TIMEOUT_MS = 120000;

  /** 从 chrome.storage.sync 读取配置（缺失字段用默认值补齐） */
  async function loadConfig() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_CONFIG);
      return { ...DEFAULT_CONFIG, ...stored };
    } catch (err) {
      console.warn('[AutoQuiz] 读取配置失败，使用默认配置：', err);
      return { ...DEFAULT_CONFIG };
    }
  }

  /** 保存配置到 chrome.storage.sync */
  async function saveConfig(patch) {
    const current = await loadConfig();
    const merged = { ...current, ...patch };
    await chrome.storage.sync.set(merged);
    return merged;
  }

  /**
   * 构造系统提示词：要求 LLM 严格按 JSON 返回答案。
   * 单选/判断 -> 大写字母；多选 -> 字母数组；填空/问答 -> 文本。
   */
  function buildSystemPrompt() {
    return [
      '你是一个在线答题助手。用户会给你一批题目（JSON 数组），每道题包含 id、number、type、content、options、blankCount 字段。',
      '请逐题作答，并【严格】返回一个 JSON 对象（不要输出任何解释、注释或多余文字），格式为：',
      '{"answers":[{"id":"题目id","answer":<答案>}]}',
      '答案字段规则：',
      '1. 单选题：返回一个大写字母，如 "A"；',
      '2. 多选题：返回字母数组，如 ["A","C"]；',
      '3. 判断题：返回大写字母（A=正确/对，B=错误/错）；',
      '4. 填空题：返回字符串；若有多个空（blankCount>1），用换行分隔每个空的答案；',
      '5. 简答题/问答题/名词解释：返回一段文本答案；',
      '6. 阅读理解/完形填空/共用选项题/选词填空等复合题：返回数组，每项对应一个子题答案（字母或文本）；',
      '7. 无法确定的题目：answer 填 null。',
      '务必保证 JSON 合法可解析，id 必须与题目 id 完全一致。',
    ].join('\n');
  }

  /**
   * 构造用户内容：把题目列表序列化为 JSON 字符串，附带每题选项文本。
   * @param {Array<object>} questions Question 对象数组
   */
  function buildUserContent(questions) {
    const payload = questions.map((q) => {
      const typeLabel = LABELS[q.type] || q.type || '未知';
      return {
        id: q.id,
        number: q.number,
        type: typeLabel,
        content: q.content,
        options: (q.options || []).map((o) => `${o.label}. ${o.text}`),
        blankCount: q.blankCount || 0,
      };
    });
    return `请作答以下题目，严格返回 JSON：\n${JSON.stringify(payload, null, 2)}`;
  }

  /**
   * JSON 容错解析：剥离 ```json 围栏，提取首个 { } 块。
   * @param {string} text LLM 原始返回文本
   * @returns {object|null} 解析后的对象
   */
  function parseJsonResponse(text) {
    if (typeof text !== 'string') return null;
    let t = text.trim();

    // 1) 剥离 ```json ... ``` 或 ``` ... ``` 围栏
    const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) t = fenceMatch[1].trim();

    // 2) 若整体不是以 { 开头，尝试提取第一个 { ... } 块
    if (!t.startsWith('{')) {
      const start = t.indexOf('{');
      const end = t.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) return null;
      t = t.slice(start, end + 1);
    }

    // 3) 标准 JSON.parse，失败则做最后一层容错（去掉尾随逗号后重试）
    try {
      return JSON.parse(t);
    } catch {
      try {
        const cleaned = t.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(cleaned);
      } catch {
        return null;
      }
    }
  }

  /**
   * 调用 DeepSeek（OpenAI 兼容协议）获取一批题目的答案。
   * @param {Array<object>} questions 题目数组
   * @param {object} config 配置（可省略，自动 loadConfig）
   * @returns {Promise<{ok: boolean, answers: object[], raw: string, error?: string}>}
   */
  async function requestAnswers(questions, config) {
    const cfg = config || (await loadConfig());
    if (!cfg.apiKey) {
      return { ok: false, answers: [], raw: '', error: '未配置 DeepSeek API Key，请先在设置页填写' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: cfg.model || 'deepseek-chat',
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: buildUserContent(questions) },
          ],
          temperature: 0.3,
          max_tokens: 4096,
          stream: false,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          ok: false,
          answers: [],
          raw: body,
          error: `DeepSeek API 请求失败（HTTP ${res.status}）：${body.slice(0, 300)}`,
        };
      }

      const data = await res.json();
      const content =
        data?.choices?.[0]?.message?.content ??
        data?.choices?.[0]?.text ??
        '';

      const parsed = parseJsonResponse(content);
      if (!parsed) {
        return {
          ok: false,
          answers: [],
          raw: content,
          error: 'LLM 返回内容无法解析为 JSON，请重试或降低每批题目数',
        };
      }

      const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
      return { ok: true, answers, raw: content };
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      return {
        ok: false,
        answers: [],
        raw: '',
        error: aborted ? `请求超时（超过 ${REQUEST_TIMEOUT_MS / 1000}s），请检查网络或 API 地址` : `请求异常：${err && err.message ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 根据速度档位生成随机延迟（ms） */
  function randomDelayForSpeed(speedLevel) {
    const [min, max] = SPEED_RANGES[speedLevel] || SPEED_RANGES.normal;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  NS.llm = {
    DEFAULT_CONFIG,
    SPEED_RANGES,
    loadConfig,
    saveConfig,
    buildSystemPrompt,
    buildUserContent,
    parseJsonResponse,
    requestAnswers,
    randomDelayForSpeed,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
