/**
 * lib/types.js
 * 题型常量定义 + 题型识别映射（含正则兜底识别）。
 * 通过 IIFE 挂载到全局命名空间 AUTOQUIZ，兼容 content script / service worker / 页面脚本。
 *
 * 依赖：无
 * 导出：AUTOQUIZ.QUESTION_TYPES / QUESTION_TYPE_LABELS / TYPE_NAME_MAP / detectQuestionType
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});

  /** 题型常量（内部统一使用英文枚举，避免中文歧义） */
  const QUESTION_TYPES = {
    SINGLE_CHOICE: 'single_choice', // 单选题
    MULTIPLE_CHOICE: 'multiple_choice', // 多选题
    FILL_BLANK: 'fill_blank', // 填空题
    JUDGE: 'judge', // 判断题
    QA: 'qa', // 简答题/问答题/论述题
    WORD_DEFINITION: 'word_definition', // 名词解释
    READING_COMPREHENSION: 'reading_comprehension', // 阅读理解
    CLOZE: 'cloze', // 完形填空
    SHARED_OPTIONS: 'shared_options', // 共用选项题
    WORD_FILL: 'word_fill', // 选词填空
    OTHER: 'other', // 其他/未知
  };

  /** 题型 -> 中文展示名（供日志、提示、LLM 提示词使用） */
  const QUESTION_TYPE_LABELS = {
    [QUESTION_TYPES.SINGLE_CHOICE]: '单选题',
    [QUESTION_TYPES.MULTIPLE_CHOICE]: '多选题',
    [QUESTION_TYPES.FILL_BLANK]: '填空题',
    [QUESTION_TYPES.JUDGE]: '判断题',
    [QUESTION_TYPES.QA]: '简答题',
    [QUESTION_TYPES.WORD_DEFINITION]: '名词解释',
    [QUESTION_TYPES.OTHER]: '其他',
    [QUESTION_TYPES.READING_COMPREHENSION]: '阅读理解',
    [QUESTION_TYPES.CLOZE]: '完形填空',
    [QUESTION_TYPES.SHARED_OPTIONS]: '共用选项题',
    [QUESTION_TYPES.WORD_FILL]: '选词填空',
  };

  /** 显式题型名映射（如 input[name^="typeName"] 的 value 或 (题型) 文本） */
  const TYPE_NAME_MAP = {
    '单选题': QUESTION_TYPES.SINGLE_CHOICE,
    '单选': QUESTION_TYPES.SINGLE_CHOICE,
    '多选题': QUESTION_TYPES.MULTIPLE_CHOICE,
    '多选': QUESTION_TYPES.MULTIPLE_CHOICE,
    '填空题': QUESTION_TYPES.FILL_BLANK,
    '填空': QUESTION_TYPES.FILL_BLANK,
    '判断题': QUESTION_TYPES.JUDGE,
    '判断': QUESTION_TYPES.JUDGE,
    '是非题': QUESTION_TYPES.JUDGE,
    '简答题': QUESTION_TYPES.QA,
    '简答': QUESTION_TYPES.QA,
    '问答题': QUESTION_TYPES.QA,
    '论述题': QUESTION_TYPES.QA,
    '计算题': QUESTION_TYPES.QA,
    '名词解释': QUESTION_TYPES.WORD_DEFINITION,
    '其他': QUESTION_TYPES.OTHER,
    '阅读理解': QUESTION_TYPES.READING_COMPREHENSION,
    '完形填空': QUESTION_TYPES.CLOZE,
    '完型填空': QUESTION_TYPES.CLOZE,
    '共用选项题': QUESTION_TYPES.SHARED_OPTIONS,
    '共用选项': QUESTION_TYPES.SHARED_OPTIONS,
    '选词填空': QUESTION_TYPES.WORD_FILL,
  };

  /** 正则兜底识别规则：按特异性从高到低排列（先匹配更精确的复合题型） */
  const DETECTION_RULES = [
    { pattern: /阅读理解/, type: QUESTION_TYPES.READING_COMPREHENSION },
    { pattern: /完[形型]填空/, type: QUESTION_TYPES.CLOZE },
    { pattern: /共用选项/, type: QUESTION_TYPES.SHARED_OPTIONS },
    { pattern: /选词填空/, type: QUESTION_TYPES.WORD_FILL },
    { pattern: /多选/, type: QUESTION_TYPES.MULTIPLE_CHOICE },
    { pattern: /单选/, type: QUESTION_TYPES.SINGLE_CHOICE },
    { pattern: /判断|是非/, type: QUESTION_TYPES.JUDGE },
    { pattern: /填空/, type: QUESTION_TYPES.FILL_BLANK },
    { pattern: /名词解释/, type: QUESTION_TYPES.WORD_DEFINITION },
    { pattern: /简答|问答|论述|计算/, type: QUESTION_TYPES.QA },
  ];

  /**
   * 识别题型：先查显式映射表，再用正则兜底。
   * @param {string} text 原始题型文本（如 "单选题" / "(单选题, 2分)" 已抽取出的部分）
   * @returns {string} QUESTION_TYPES 中的枚举值
   */
  function detectQuestionType(text) {
    if (typeof text !== 'string') return QUESTION_TYPES.OTHER;
    const trimmed = text.trim();

    const direct = TYPE_NAME_MAP[trimmed];
    if (direct !== undefined) return direct;

    for (const rule of DETECTION_RULES) {
      if (rule.pattern.test(trimmed)) return rule.type;
    }

    return QUESTION_TYPES.OTHER;
  }

  NS.QUESTION_TYPES = QUESTION_TYPES;
  NS.QUESTION_TYPE_LABELS = QUESTION_TYPE_LABELS;
  NS.TYPE_NAME_MAP = TYPE_NAME_MAP;
  NS.detectQuestionType = detectQuestionType;
})(typeof globalThis !== 'undefined' ? globalThis : window);
