/**
 * lib/answer-feedback.js
 * 官方答案回馈模块：在平台成绩/回顾页读取官方正确答案，解析后上传共享题库（source=official，最高权重）。
 *
 * 解析策略：
 *  1. 复用当前页面适配器的 extract() 获取题目结构（content / type / options / blankCount），
 *     保证 hash 与答题阶段一致（lib/cache.js hashQuestion）；
 *  2. 在题目根内按常见选择器定位"正确答案"区域，按题型归一化答案：
 *     - 单选：提取字母（A-H）并大写
 *     - 判断：文本 对/正确/√ -> A，错/错误/× -> B（与答题阶段字母表示一致）
 *     - 多选：提取全部字母，去重升序拼接
 *     - 填空/简答：取完整答案文本（保留原始内容）
 *  3. 幂等：已回馈成功的 hash|answer 记录在 chrome.storage.local（feedbackSent），重复回顾不重复上传。
 *
 * 依赖：AUTOQUIZ.adapters.detectAdapter、AUTOQUIZ.cache.hashQuestion、AUTOQUIZ.sharedBank
 * 导出：AUTOQUIZ.answerFeedback
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});
  const AF = (NS.answerFeedback = NS.answerFeedback || {});

  const SENT_KEY = 'feedbackSent';
  const SENT_LIMIT = 5000;

  /* ------------------------------ DOM 解析 ------------------------------ */

  /** 统一空白 */
  function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /** 按题目序号定位题目根（雨课堂优先，其次通用选择题卡） */
  function locateQuestionRoot(doc, index) {
    const selectors = [
      '.subject-item.J_order',
      '.subject-item',
      '.exam-question-item',
      '.question-card-list li',
      '.question-card__item',
      '[id^="sigleQuestionDiv_"]',
      '.questionLi',
      '.singleQuesId[data] .TiMu[data]',
    ];
    const seen = new Set();
    const roots = [];
    for (const sel of selectors) {
      for (const el of doc.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        roots.push(el);
      }
      if (roots.length > 0) break;
    }
    const mainContent = doc.querySelector('.exam-main--content');
    const scoped = mainContent ? roots.filter((el) => mainContent.contains(el)) : roots;
    const target = scoped[index] || roots[index];
    if (target) return target;

    // 兜底：按内容匹配（content 前 20 字符）
    return null;
  }

  /** 在题目根内查找"正确答案"文本（常见回顾页/答案解析区域） */
  function findCorrectAnswerText(root) {
    if (!root) return '';
    const selectors = [
      '.answer-analysis',
      '.answerAnalysis',
      '.correct-answer',
      '.question-answer',
      '.answer-box',
      '.analysis-box .answer',
      '.answer-area',
      '.cu-right-answer',
      '.answer-text',
    ];
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el && clean(el.textContent)) {
        const text = clean(el.textContent);
        if (/(?:正确答案|标准答案|答案|解析)/.test(text)) return text;
        return text;
      }
    }
    // 文本兜底：题目根内匹配"正确答案/标准答案"
    const full = clean(root.textContent);
    const m = full.match(/(?:正确答案|标准答案|答案)\s*[:：]?\s*([^。；\n]+)/);
    return m ? m[1] : '';
  }

  /** 从答案文本中提取字母（含"答案: A"等前缀） */
  function extractLetters(text) {
    const t = String(text || '');
    const letters = t.match(/[A-Ha-h]/g) || [];
    return letters.map((c) => c.toUpperCase());
  }

  /** 判断文本是否是判断题答案（对/错/正确/错误/√/×） */
  function looksLikeJudge(text) {
    return /^(对|错|正确|错误|√|×|x|X|A|B)$/.test(clean(text));
  }

  /** 按题型归一化官方答案文本 */
  function normalizeAnswer(questionType, rawText) {
    const text = clean(rawText);
    if (!text) return '';
    // 去掉 "正确答案："/"答案：" 等前缀，只保留最末一段候选
    let candidate = text;
    const m = text.match(/(?:正确答案|标准答案|答案)\s*[:：]?\s*(.+)$/);
    if (m) candidate = clean(m[1]);

    const single = questionType === 'single' || questionType === 'judge';
    if (single) {
      if (questionType === 'judge' || /^(对|错|正确|错误|√|×|x|X)$/.test(candidate)) {
        if (/^(对|正确|√)$/.test(candidate)) return 'A';
        if (/^(错|错误|×|x|X)$/.test(candidate)) return 'B';
      }
      const letters = extractLetters(candidate);
      return letters.length > 0 ? letters[0] : candidate;
    }
    if (questionType === 'multiple') {
      const letters = extractLetters(candidate);
      if (letters.length > 0) {
        return Array.from(new Set(letters)).sort().join('');
      }
      return candidate;
    }
    // 填空 / 简答 / 其他：保留完整答案文本（可能含逗号分隔的多个空）
    return candidate;
  }

  /**
   * 解析回顾页官方答案，返回上传条目 [{hash, answer, content, type, options, source:'official'}]
   */
  async function parseOfficialAnswers(root) {
    const doc = root.document || root;
    if (!doc) return [];

    // 1) 提取题目结构：优先复用适配器 extract
    let questions = [];
    let adapter = null;
    if (NS.adapters && NS.adapters.detectAdapter) {
      try {
        adapter = NS.adapters.detectAdapter(root);
      } catch (e) {
        adapter = null;
      }
    }
    if (adapter && typeof adapter.extract === 'function') {
      try {
        questions = adapter.extract(root);
      } catch (e) {
        questions = [];
      }
    }
    if (!Array.isArray(questions) || questions.length === 0) return [];

    const items = [];
    questions.forEach((q, index) => {
      const answerText = findCorrectAnswerText(locateQuestionRoot(doc, index));
      const answer = normalizeAnswer(String(q.type || ''), answerText);
      if (!answer) return;

      const hashFn =
        (NS.cache && NS.cache.hashQuestion) ||
        (NS.sharedBank && NS.sharedBank.hashQuestion) ||
        null;
      if (!hashFn) return;
      // 与答题阶段保持一致：platform 必须纳入 hash，否则回馈答案无法命中共享题库查询
      const platform = (adapter && adapter.id) || 'unknown';
      const hash = hashFn(q, platform);
      if (!hash) return;

      items.push({
        hash,
        answer,
        source: 'official',
        content: String(q.content || ''),
        type: String(q.type || ''),
        options: Array.isArray(q.options) ? q.options : undefined,
      });
    });
    return items;
  }
  AF.parseOfficialAnswers = parseOfficialAnswers;

  /* ------------------------------ 幂等与上传 ------------------------------ */

  async function getSentSet() {
    const d = await chrome.storage.local.get(SENT_KEY);
    return new Set(Array.isArray(d[SENT_KEY]) ? d[SENT_KEY] : []);
  }

  async function markSent(keys) {
    const d = await chrome.storage.local.get(SENT_KEY);
    const arr = Array.isArray(d[SENT_KEY]) ? d[SENT_KEY] : [];
    const set = new Set(arr);
    keys.forEach((k) => set.add(k));
    // 控制体积：超出上限时丢弃最旧一半
    const list = Array.from(set);
    if (list.length > SENT_LIMIT) {
      list.splice(0, list.length - Math.floor(SENT_LIMIT / 2));
    }
    await chrome.storage.local.set({ [SENT_KEY]: list });
  }

  /**
   * 回馈并上传官方答案。
   * @returns {Promise<{parsed:number, sent:number, skipped:number, queued:number, uploaded:number, failed:number}>}
   */
  async function sendOfficialFeedback(root) {
    const items = await parseOfficialAnswers(root);
    if (items.length === 0) {
      return { parsed: 0, sent: 0, skipped: 0, queued: 0, uploaded: 0, failed: 0 };
    }

    const sentSet = await getSentSet();
    const fresh = items.filter((it) => !sentSet.has(it.hash + '|' + it.answer));
    const skipped = items.length - fresh.length;
    if (fresh.length === 0) {
      return { parsed: items.length, sent: 0, skipped, queued: 0, uploaded: 0, failed: 0 };
    }

    if (!NS.sharedBank) {
      return { parsed: items.length, sent: 0, skipped, queued: 0, uploaded: 0, failed: 0 };
    }

    const result = await NS.sharedBank.uploadItems(fresh, { retryOnError: true });
    // 上传成功（含入队重试）即标记已回馈，避免重复
    if (result.uploaded > 0 || result.queued > 0) {
      await markSent(fresh.map((it) => it.hash + '|' + it.answer));
    }
    return {
      parsed: items.length,
      sent: fresh.length,
      skipped,
      queued: result.queued || 0,
      uploaded: result.uploaded || 0,
      failed: result.failed || 0,
    };
  }
  AF.sendOfficialFeedback = sendOfficialFeedback;
})(typeof globalThis !== 'undefined' ? globalThis : window);
