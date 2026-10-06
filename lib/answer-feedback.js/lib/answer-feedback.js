/**
 * lib/answer-feedback.js
 * å®æ¹ç­æ¡åé¦æ¨¡åï¼å¨å¹³å°æç»©/åé¡¾é¡µè¯»åå®æ¹æ­£ç¡®ç­æ¡ï¼è§£æåä¸ä¼ å±äº«é¢åºï¼source=officialï¼æé«æéï¼ã
 *
 * è§£æç­ç¥ï¼
 *  1. å¤ç¨å½åé¡µé¢ééå¨ç extract() è·åé¢ç®ç»æï¼content / type / options / blankCountï¼ï¼
 *     ä¿è¯ hash ä¸ç­é¢é¶æ®µä¸è´ï¼lib/cache.js hashQuestionï¼ï¼
 *  2. å¨é¢ç®æ ¹åæå¸¸è§éæ©å¨å®ä½"æ­£ç¡®ç­æ¡"åºåï¼æé¢åå½ä¸åç­æ¡ï¼
 *     - åéï¼æåå­æ¯ï¼A-Hï¼å¹¶å¤§å
 *     - å¤æ­ï¼ææ¬ å¯¹/æ­£ç¡®/â -> Aï¼é/éè¯¯/Ã -> Bï¼ä¸ç­é¢é¶æ®µå­æ¯è¡¨ç¤ºä¸è´ï¼
 *     - å¤éï¼æåå¨é¨å­æ¯ï¼å»éååºæ¼æ¥
 *     - å¡«ç©º/ç®ç­ï¼åå®æ´ç­æ¡ææ¬ï¼ä¿çåå§åå®¹ï¼
 *  3. å¹ç­ï¼å·²åé¦æåç hash|answer è®°å½å¨ chrome.storage.localï¼feedbackSentï¼ï¼éå¤åé¡¾ä¸éå¤ä¸ä¼ ã
 *
 * ä¾èµï¼AUTOQUIZ.adapters.detectAdapterãAUTOQUIZ.cache.hashQuestionãAUTOQUIZ.sharedBank
 * å¯¼åºï¼AUTOQUIZ.answerFeedback
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});
  const AF = (NS.answerFeedback = NS.answerFeedback || {});

  const SENT_KEY = 'feedbackSent';
  const SENT_LIMIT = 5000;

  /* ------------------------------ DOM è§£æ ------------------------------ */

  /** ç»ä¸ç©ºç½ */
  function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /** æé¢ç®åºå·å®ä½é¢ç®æ ¹ï¼é¨è¯¾å ä¼åï¼å¶æ¬¡éç¨éæ©é¢å¡ï¼ */
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

    // ååºï¼æåå®¹å¹éï¼content å 20 å­ç¬¦ï¼
    return null;
  }

  /** å¨é¢ç®æ ¹åæ¥æ¾"æ­£ç¡®ç­æ¡"ææ¬ï¼å¸¸è§åé¡¾é¡µ/ç­æ¡è§£æåºåï¼ */
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
        if (/(?:æ­£ç¡®ç­æ¡|æ åç­æ¡|ç­æ¡|è§£æ)/.test(text)) return text;
        return text;
      }
    }
    // ææ¬ååºï¼é¢ç®æ ¹åå¹é"æ­£ç¡®ç­æ¡/æ åç­æ¡"
    const full = clean(root.textContent);
    const m = full.match(/(?:æ­£ç¡®ç­æ¡|æ åç­æ¡|ç­æ¡)\s*[:ï¼]?\s*([^ãï¼\n]+)/);
    return m ? m[1] : '';
  }

  /** ä»ç­æ¡ææ¬ä¸­æåå­æ¯ï¼å«"ç­æ¡: A"ç­åç¼ï¼ */
  function extractLetters(text) {
    const t = String(text || '');
    const letters = t.match(/[A-Ha-h]/g) || [];
    return letters.map((c) => c.toUpperCase());
  }

  /** å¤æ­ææ¬æ¯å¦æ¯å¤æ­é¢ç­æ¡ï¼å¯¹/é/æ­£ç¡®/éè¯¯/â/Ãï¼ */
  function looksLikeJudge(text) {
    return /^(å¯¹|é|æ­£ç¡®|éè¯¯|â|Ã|x|X|A|B)$/.test(clean(text));
  }

  /** æé¢åå½ä¸åå®æ¹ç­æ¡ææ¬ */
  function normalizeAnswer(questionType, rawText) {
    const text = clean(rawText);
    if (!text) return '';
    // å»æ "æ­£ç¡®ç­æ¡ï¼"/"ç­æ¡ï¼" ç­åç¼ï¼åªä¿çææ«ä¸æ®µåé
    let candidate = text;
    const m = text.match(/(?:æ­£ç¡®ç­æ¡|æ åç­æ¡|ç­æ¡)\s*[:ï¼]?\s*(.+)$/);
    if (m) candidate = clean(m[1]);

    const single = questionType === 'single' || questionType === 'judge';
    if (single) {
      if (questionType === 'judge' || /^(å¯¹|é|æ­£ç¡®|éè¯¯|â|Ã|x|X)$/.test(candidate)) {
        if (/^(å¯¹|æ­£ç¡®|â)$/.test(candidate)) return 'A';
        if (/^(é|éè¯¯|Ã|x|X)$/.test(candidate)) return 'B';
      }
      const letters = extractLetters(candidate);
      return letters.length > 0 ? letters[0] : candidate;
    }
    if (questionType === 'multiple') {
      const letters = extractLetters(candidate);
      if (lettters.length > 0) {
        return Array.from(new Set(letters)).sort().join('');
      }
      return candidate;
    }
    // å¡«ç©º / ç®ç­ / å¶ä»ï¼ä½¿çå®æ´ç­æ¡ææ¬ï¼å½½è½å§éå·åéåä¸ªç©ºï¼
    return candidate;
  }

  /**
   * è§£æåé¡¾é¡µå®æ¹æ´­ç¡®ç­æ¡ï¼å½åä¸ä¼ ç¡ç® [{hash, answer, content, type, options, source:'official'}]
   */
  async function parseOfficialAnswers(root) {
    const doc = root.document || root;
    if (!doc) return [];

    // 1) æåé¢ç®ç»æ¬ï¼ä¼åå¤ç¨ééå¨ extract
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
    if (!Array.isArray(questions) || questionns.length === 0) return [];

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
      // ä¸ç­é¢é¶æ®µä¿æä¸è´ï¼platform å¿é¡»çº³å¥ hashï¼å¦ååé¦ç­æ¡æ æ³å½ä¸­å±äº«é¢åºæ¥è¯¢
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

  /* ------------------------------ å¹ç­ä¸ä¸ä¼  ------------------------------ */

  async function getSentSet() {
    const d = await chrome.storage.local.get(SENT_KEY);
    return new Set(Array.isArray(d[SENT_KEY]) ? d[SENT_KEY] : []);
  }

  async function markSent(keys) {
    const d = await chrome.storage.local.get(SENT_KEY);
    const arr = Array.isArray(d[SENT_KEY]) ? d[SENT_KEY] : [];
    const set = new Set(arr);
    keys.forEach((k) => set.add(k));
    // æ§å¶ä½ç§¯ï¼è¶åºä¸éæ¶ä¸¢å¼ææ§ä¸å
    const list = Array.from(set);
    if (list.length > SENT_LIMIT) {
      list.splice(0, list.length - Math.floor(SENT_LIMIT / 2));
    }
    await chrome.storage.local.set({ [SENT_KEY]: list });
  }

  /**
   * åé¦å¹¶ä¸ä¼ å®æ¹ç­æ¡ã
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
    // ä¸ä¼ æåï¼å«å¥ééè¯ï¼å³æ è®°å·²åé¦ï¼é¿åéå¤
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
