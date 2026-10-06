/**
 * lib/resolver.js
 * 答案规范化/校验模块：在填写前对 LLM / 题库返回的原始答案做归一化处理，
 * 参考 OCS resolver.single.ts / resolver.multiple.ts / resolver.judgement.ts / resolver.completion.ts：
 *  - 判断题词表归一化（对/错/√/×/true/false/正确/错误 -> 选项字母），防止文本答案与选项错位
 *  - 单选字母越界校验（字母索引超出选项数量视为无效并降级跳过）
 *  - 多选答案字母去重 + 升序排序 + 越界剔除后再填写
 *  - 填空多空答案按分隔符拆分（默认逗号，可配置），逐空填入
 *
 * 依赖：AUTOQUIZ.types
 * 导出：AUTOQUIZ.resolver = { normalizeSingle, normalizeMultiple, normalizeJudgement, splitBlankAnswers, normalizeAnswer }
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});
  const TYPES = NS.QUESTION_TYPES || {};

  /** 判断题正确词表（参考 OCS resolver.judgement.ts CORRECT_WORDS） */
  const CORRECT_WORDS = [
    '是', '对', '正确', '确定', '√', '对的', '是的', '正确的',
    'true', 'True', 'T', 'yes', '1',
  ];
  /** 判断题错误词表（参考 OCS resolver.judgement.ts INCORRECT_WORDS） */
  const INCORRECT_WORDS = [
    '非', '否', '错', '错误', '×', 'X', '错的', '不对',
    '不正确的', '不正确', '不是', '不是的',
    'false', 'False', 'F', 'no', '0',
  ];
  /** 填空多空常用分隔符（参考 OCS splitAnswer 默认分隔符集 + 中文标点） */
  const DEFAULT_BLANK_SEPARATORS = [',', '，', '、', '===', '#', '---', '###', '|', '\n', ';', '；'];

  /** 归一化文本：去空白/常见标点/引号，转小写（参考 OCS clearString/removeRedundant 思路） */
  function clearString(text) {
    return String(text || '')
      .replace(/[\s\u3000·.,，。、:：;；()（）\[\]【】"'“”‘’\-]/g, '')
      .toLowerCase();
  }

  /** 词表匹配：归一化后精确比较 */
  function matchesWord(target, words) {
    const t = clearString(target);
    if (!t) return false;
    return words.some((w) => clearString(w) === t);
  }

  /** 从任意值中提取首个英文字母（大写） */
  function extractLetter(value) {
    if (value === undefined || value === null) return '';
    const m = String(value).match(/[A-Za-z]/);
    return m ? m[0].toUpperCase() : '';
  }

  /** 取选项的字母 label：优先使用 options[i].label 中的字母，缺失时按位置 A/B/C... */
  function optionLetter(option, index) {
    if (option && typeof option === 'object' && option.label) {
      const m = String(option.label).match(/[A-Za-z]/);
      if (m) return m[0].toUpperCase();
    }
    return String.fromCharCode(65 + index);
  }

  /** 校验字母索引是否越界 */
  function isOutOfRange(letter, optCount) {
    return optCount > 0 && letter.charCodeAt(0) - 65 >= optCount;
  }

  /**
   * 单选题归一化：提取字母；字母索引超出选项数量视为无效（参考 resolver.single.ts 阶段3）。
   * @returns {{ok: boolean, value: (string|null), reason: string}}
   */
  function normalizeSingle(answer, options) {
    const optCount = Array.isArray(options) ? options.length : 0;
    const letter = extractLetter(Array.isArray(answer) ? answer[0] : answer);
    if (!letter) {
      return { ok: false, value: null, reason: '未识别到单选题字母答案' };
    }
    if (isOutOfRange(letter, optCount)) {
      return { ok: false, value: null, reason: `单选答案 ${letter} 越界（选项数 ${optCount}），已降级跳过` };
    }
    return { ok: true, value: letter, reason: '' };
  }

  /**
   * 多选题归一化：去重 + 升序排序 + 越界剔除（参考 resolver.multiple.ts 兜底 [...new Set(plainOptions)]）。
   * @returns {{ok: boolean, value: (string[]|null), reason: string}}
   */
  function normalizeMultiple(answer, options) {
    const optCount = Array.isArray(options) ? options.length : 0;
    let rawLetters = [];
    if (Array.isArray(answer)) {
      rawLetters = answer.map((v) => extractLetter(v)).filter(Boolean);
    } else {
      rawLetters = String(answer || '')
        .split(/[\s,，、;；]+/)
        .map((s) => extractLetter(s))
        .filter(Boolean);
    }
    if (rawLetters.length === 0) {
      return { ok: false, value: null, reason: '未识别到多选字母答案' };
    }
    const unique = [...new Set(rawLetters)].sort();
    const valid = optCount > 0 ? unique.filter((l) => !isOutOfRange(l, optCount)) : unique;
    if (valid.length === 0) {
      return { ok: false, value: null, reason: '多选答案字母均越界，已降级跳过' };
    }
    const dropped = unique.filter((l) => !valid.includes(l));
    return {
      ok: true,
      value: valid,
      reason: dropped.length > 0 ? `已剔除越界字母 ${dropped.join('')}` : '',
    };
  }

  /**
   * 判断题归一化：LLM 可能返回文本（对/错/√/×/true/false/正确/错误...），
   * 按词表归一化为对应选项字母，防止文本答案与选项错位（参考 resolver.judgement.ts）。
   * 规则：先看答案文本属于正确词表还是错误词表，再到选项文本中找同性质选项返回其字母；
   *       选项文本无法识别性质时按 A=对/正确、B=错/错误 兜底。
   * @returns {{ok: boolean, value: (string|null), reason: string}}
   */
  function normalizeJudgement(answer, options) {
    const optCount = Array.isArray(options) ? options.length : 0;
    const text = Array.isArray(answer) ? String(answer[0] || '') : String(answer || '');
    const trimmed = text.trim();

    // 1) 已是字母 A/B（可带括号），越界校验后直接使用
    const letterMatch = trimmed.match(/^[（(]?\s*([ABab])\s*[)）]?$/);
    if (letterMatch) {
      const letter = letterMatch[1].toUpperCase();
      if (isOutOfRange(letter, optCount)) {
        return { ok: false, value: null, reason: `判断题答案 ${letter} 越界（选项数 ${optCount}）` };
      }
      return { ok: true, value: letter, reason: '' };
    }

    // 2) 词表归一化：判定答案性质
    const answerCorrect = matchesWord(trimmed, CORRECT_WORDS);
    const answerIncorrect = matchesWord(trimmed, INCORRECT_WORDS);
    if (!answerCorrect && !answerIncorrect) {
      return { ok: false, value: null, reason: `判断题答案无法按词表识别：${text.slice(0, 30)}` };
    }
    const wantCorrect = answerCorrect;

    // 3) 在选项文本中找同性质选项，返回其字母
    for (let i = 0; i < optCount; i++) {
      const raw = options[i];
      const optText = String((raw && typeof raw === 'object' && raw.text) || raw || '');
      const optCorrect = matchesWord(optText, CORRECT_WORDS);
      const optIncorrect = matchesWord(optText, INCORRECT_WORDS);
      if (wantCorrect && optCorrect) {
        const letter = optionLetter(raw, i);
        return { ok: true, value: letter, reason: `文本答案归一化为选项 ${letter}` };
      }
      if (!wantCorrect && optIncorrect) {
        const letter = optionLetter(raw, i);
        return { ok: true, value: letter, reason: `文本答案归一化为选项 ${letter}` };
      }
    }

    // 4) 选项文本无法识别性质时，按 A=对/正确、B=错/错误 兜底
    if (optCount >= 2) {
      return { ok: true, value: wantCorrect ? 'A' : 'B', reason: '选项文本未识别出对/错性质，按 A=对 B=错 兜底' };
    }
    return { ok: false, value: null, reason: '判断题选项无法匹配词表' };
  }

  /** 转义正则特殊字符 */
  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 按分隔符拆分文本（优先用户配置分隔符，其次常用分隔符，取拆分段数最多的结果） */
  function splitBySeparators(text, userSeparator) {
    const userSep = typeof userSeparator === 'string' && userSeparator.trim() ? userSeparator.trim() : '';
    const seps = userSep
      ? [userSep, ...DEFAULT_BLANK_SEPARATORS.filter((s) => s !== userSep)]
      : DEFAULT_BLANK_SEPARATORS;

    if (userSep) {
      const parts = text.split(escapeRegExp(userSep)).map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1) return parts;
    }
    let best = [text];
    for (const sep of seps) {
      const parts = text.split(escapeRegExp(sep)).map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1 && parts.length > best.length) best = parts;
    }
    return best;
  }

  /**
   * 填空多空拆分（参考 resolver.completion.ts splitAnswer 思路）：
   * 字符串按分隔符拆成数组逐空填入；数组直接规范化；支持 JSON 数组字符串。
   * 拆分段数与空位数不一致时，由填写器按空位顺序对齐（不足的跳过、多余的截断）。
   * @returns {{ok: boolean, value: (string[]|null), reason: string}}
   */
  function splitBlankAnswers(answer, blankCount, separator) {
    let parts = [];
    if (Array.isArray(answer)) {
      parts = answer.map((v) => String(v).trim()).filter(Boolean);
    } else {
      const text = String(answer || '').trim();
      if (!text) return { ok: false, value: null, reason: '填空答案为空' };
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          parts = parsed.map((v) => String(v).trim()).filter(Boolean);
        }
      } catch {
        /* 非 JSON，走分隔符拆分 */
      }
      if (parts.length === 0) {
        parts = splitBySeparators(text, separator);
      }
    }
    if (parts.length === 0) {
      return { ok: false, value: null, reason: '填空答案无法拆分' };
    }
    const count = Number(blankCount) || 0;
    const reason =
      count > 0 && parts.length > count
        ? `拆分为 ${parts.length} 段（空位数 ${count}），已按前 ${count} 空截断`
        : '';
    return { ok: true, value: parts, reason };
  }

  /**
   * 答案统一规范化入口：按题型分发。
   * @param {object} question 题目对象（含 type/options/blankCount）
   * @param {*} rawAnswer LLM / 题库返回的原始答案
   * @param {object} [config] 配置（blankSeparator）
   * @returns {{ok: boolean, value: *, reason: string}}
   */
  function normalizeAnswer(question, rawAnswer, config) {
    const q = question || {};
    const cfg = config || {};
    if (rawAnswer === undefined || rawAnswer === null) {
      return { ok: false, value: null, reason: '无答案' };
    }
    switch (q.type) {
      case TYPES.SINGLE_CHOICE:
        return normalizeSingle(rawAnswer, q.options);
      case TYPES.MULTIPLE_CHOICE:
        return normalizeMultiple(rawAnswer, q.options);
      case TYPES.JUDGE:
        return normalizeJudgement(rawAnswer, q.options);
      case TYPES.FILL_BLANK:
        return splitBlankAnswers(rawAnswer, q.blankCount, cfg.blankSeparator);
      default: {
        const isEmpty = Array.isArray(rawAnswer)
          ? rawAnswer.length === 0
          : String(rawAnswer).trim() === '';
        return isEmpty
          ? { ok: false, value: null, reason: '答案为空' }
          : { ok: true, value: rawAnswer, reason: '' };
      }
    }
  }

  NS.resolver = {
    CORRECT_WORDS,
    INCORRECT_WORDS,
    DEFAULT_BLANK_SEPARATORS,
    clearString,
    normalizeSingle,
    normalizeMultiple,
    normalizeJudgement,
    splitBlankAnswers,
    normalizeAnswer,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
