/**
 * lib/extractor.js
 * 超星学习通考试页 / 作业页 / 章节测验页 题目提取器。
 * DOM 结构参考 MultiAI-Answer-cx 项目确认的选择器：
 *   - 考试页每题根元素: [id^="sigleQuestionDiv_"]
 *   - 作业页每题根元素: .questionLi
 *   - 章节测验每题根元素: .singleQuesId[data]
 *   - 题目标题: .mark_name（作业/考试通用）；章节页: .Zy_TItle
 *   - 题型来源: input[name^="typeName"] 的 value，或 (题型) 文本
 *   - 选项行: .answerBg 或 li[onclick*="addChoice"]；选项标签: .num_option / .num_option_dx；选项文本: .answer_p
 *   - 填空空位: .textTarget / .tiankong
 *
 * 依赖：AUTOQUIZ.types
 * 导出：AUTOQUIZ.extractor = { extractAll, extractExamQuestions, extractWorkQuestions, extractChapterQuestions, getQuestionRoot }
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});
  const TYPES = NS.QUESTION_TYPES || {};
  const detectQuestionType = NS.detectQuestionType || function () { return TYPES.OTHER || 'other'; };

  /** 统一空白：连续空白折叠为单个空格 */
  function normalizeInlineText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /** 从根元素中解析题型：input[name^="typeName"] value -> typename 属性 -> (题型) 文本 -> 其他 */
  function extractRawType(div, typeSpan) {
    const typeNameInput = div.querySelector('input[name^="typeName"]');
    if (typeNameInput && typeNameInput.value) {
      return typeNameInput.value.trim();
    }
    const typeFromAttr = div.getAttribute('typename');
    if (typeFromAttr) {
      return typeFromAttr.trim();
    }
    if (typeSpan && typeSpan.textContent) {
      const typeText = typeSpan.textContent.trim();
      // "(单选题, 2分)" -> "单选题"
      const typeMatch = typeText.match(/\((.*?)(?:,|，|\s)/);
      if (typeMatch && typeMatch[1]) {
        return typeMatch[1].trim();
      }
      // 直接就是 "单选题"
      if (typeText && !typeText.includes('(')) {
        return typeText.trim();
      }
    }
    return '其他';
  }

  /** 提取题目正文：优先取 .mark_name 下 div 的纯文本，否则去题号与题型括号 */
  function extractContent(titleElem, questionType) {
    let content = '';
    const contentDiv = titleElem.querySelector('div');
    if (contentDiv) {
      content = normalizeInlineText(contentDiv.textContent || '');
    } else {
      const fullText = normalizeInlineText(titleElem.textContent || '');
      const typeIndex = fullText.indexOf('(');
      if (typeIndex === -1) {
        content = fullText;
      } else {
        const withoutNumber = fullText.split('.').slice(1).join('.').trim();
        const closingParen = withoutNumber.indexOf(')');
        content = closingParen === -1 ? withoutNumber : withoutNumber.substring(closingParen + 1).trim();
      }
    }

    // 填空题：把连续下划线/连续空格统一为占位符，便于 LLM 理解空位数量
    if (questionType === TYPES.FILL_BLANK) {
      content = content.replace(/_{3,}/g, '____').replace(/\s{3,}/g, '____').replace(/_{2,}/g, '____');
    }
    return content;
  }

  /** 提取题号（标题开头的数字，如 "1." -> "1"） */
  function extractDisplayNumber(titleElem) {
    const clone = titleElem.cloneNode(true);
    const shallow = clone.querySelector('.colorShallow');
    if (shallow) shallow.remove();
    const normalized = normalizeInlineText(clone.textContent || '');
    const match = normalized.match(/^(\d+)\s*[.、．]/);
    return match ? match[1] : '';
  }

  /** 解析选项行（.answerBg 或 li[onclick*="addChoice"]），label 来自 span[data]/num_option，text 来自 .answer_p */
  function parseOptionsFromRows(rows) {
    return rows
      .map((row) => {
        const labelSpan =
          row.querySelector('span[data]') ||
          row.querySelector('.num_option') ||
          row.querySelector('.num_option_dx');
        const label = normalizeInlineText(labelSpan ? labelSpan.textContent || '' : '');
        const text = normalizeInlineText(row.querySelector('.answer_p')?.textContent || '');
        return { label, text };
      })
      .filter((o) => o.label && o.text);
  }

  /** 通用选项解析：.stem_answer .answerBg 结构 */
  function parseOptions(questionDiv) {
    const rows = questionDiv.querySelectorAll('.stem_answer .answerBg');
    return parseOptionsFromRows(Array.from(rows));
  }

  /** 按题型解析选项 */
  function parseOptionsForType(questionDiv, type) {
    switch (type) {
      case TYPES.WORD_FILL: {
        // 选词填空词库: .blanksBox span[draggable]
        const spans = questionDiv.querySelectorAll('.blanksBox span[draggable]');
        return Array.from(spans)
          .map((s) => ({
            label: s.getAttribute('data-choose-name') || '',
            text: normalizeInlineText(s.textContent || ''),
          }))
          .filter((o) => o.label && o.text);
      }
      case TYPES.SHARED_OPTIONS: {
        // 共用选项: .stem_answer.padBom20 .clearfix
        const rows = questionDiv.querySelectorAll('.stem_answer.padBom20 .clearfix');
        return Array.from(rows)
          .map((row) => ({
            label: normalizeInlineText(row.querySelector('span.fl')?.textContent || '').replace(/\.$/, ''),
            text: normalizeInlineText(row.querySelector('.p_wid805')?.textContent || ''),
          }))
          .filter((o) => o.label && o.text);
      }
      default:
        return parseOptions(questionDiv);
    }
  }

  /** 填空题空位数量：优先 .textTarget，其次 .stem_answer .tiankong */
  function detectBlankCount(questionDiv, type) {
    if (type === TYPES.WORD_FILL) {
      return questionDiv.querySelectorAll('.textTarget').length;
    }
    const textTargets = questionDiv.querySelectorAll('.textTarget');
    if (textTargets.length > 0) return textTargets.length;
    return questionDiv.querySelectorAll('.stem_answer .tiankong').length;
  }

  /** 阅读理解子题提取 */
  function extractReadingSubQuestions(div) {
    const passage = normalizeInlineText(div.querySelector('.mark_name div')?.textContent || '');
    const blocks = Array.from(div.querySelectorAll('.reading_answer'));
    const subQuestions = blocks.map((block, index) => {
      const titleElem = block.querySelector('.reader_answer_tit');
      const clone = titleElem ? titleElem.cloneNode(true) : null;
      if (clone) clone.querySelector('.read_type')?.remove();
      const rawTitle = normalizeInlineText(clone?.textContent || titleElem?.textContent || '');
      const content = rawTitle.replace(/^\(\d+\)\s*/, '').trim();
      const optionRows = Array.from(block.querySelectorAll('.stem_answer .hoverDiv'));
      return { index: index + 1, content, options: parseOptionsFromRows(optionRows) };
    });

    const contentLines = ['[阅读理解]', passage];
    subQuestions.forEach((sq) => {
      contentLines.push(`(${sq.index}) ${sq.content}`);
      const optionLine = sq.options.map((o) => `${o.label}. ${o.text}`).join(' ');
      if (optionLine) contentLines.push(optionLine);
    });
    return { content: contentLines.filter(Boolean).join('\n'), subQuestions };
  }

  /** 完形填空子题提取：.stem_answer 内嵌 .answerBg 选项组 */
  function extractClozeSubQuestions(div) {
    const passage = normalizeInlineText(div.querySelector('.mark_name div')?.textContent || '');
    const containers = Array.from(div.querySelectorAll('.stem_answer')).filter((c) => c.querySelector('.answerBg'));
    const optionGroups =
      containers.length > 0
        ? containers.map((c) => Array.from(c.querySelectorAll('.answerBg')))
        : [Array.from(div.querySelectorAll('.stem_answer .answerBg'))];

    const subQuestions = optionGroups
      .map((rows, index) => ({ index: index + 1, options: parseOptionsFromRows(rows) }))
      .filter((sq) => sq.options.length > 0);

    const contentLines = ['[完形填空]', passage];
    subQuestions.forEach((sq) => {
      const optionLine = sq.options.map((o) => `${o.label}. ${o.text}`).join(' ');
      contentLines.push(`(${sq.index}) ${optionLine}`);
    });
    return { content: contentLines.filter(Boolean).join('\n'), subQuestions };
  }

  /** 共用选项题子题提取 */
  function extractSharedOptionsSubQuestions(div) {
    const rows = Array.from(div.querySelectorAll('.stem_answer.padBom20 .clearfix'));
    const sharedOptions = rows
      .map((row) => ({
        label: normalizeInlineText(row.querySelector('span.fl')?.textContent || '').replace(/\.$/, ''),
        text: normalizeInlineText(row.querySelector('.p_wid805')?.textContent || ''),
      }))
      .filter((o) => o.label && o.text);

    const subQuestions = Array.from(div.querySelectorAll('.B-answer-ct')).map((block, index) => {
      const title = normalizeInlineText(block.querySelector('.B-tit')?.textContent || '').replace(/^\(\d+\)\s*/, '').trim();
      return { index: index + 1, content: title, options: sharedOptions };
    });

    const sharedLine = sharedOptions.map((o) => `${o.label}. ${o.text}`).join(' ');
    const contentLines = ['[共用选项题]', `共用选项: ${sharedLine}`];
    subQuestions.forEach((sq) => contentLines.push(`(${sq.index}) ${sq.content}`));
    return { content: contentLines.filter(Boolean).join('\n'), subQuestions };
  }

  /** 选词填空子题提取 */
  function extractWordFillSubQuestions(div) {
    const textContentDiv = div.querySelector('.textContent');
    let passage = '';
    if (textContentDiv) {
      const clone = textContentDiv.cloneNode(true);
      const targets = Array.from(clone.querySelectorAll('.textTarget'));
      targets.forEach((target, index) => {
        const marker = document.createTextNode(`____${index + 1}____`);
        target.parentNode?.replaceChild(marker, target);
      });
      passage = normalizeInlineText(clone.textContent || '');
    }
    const wordBank = parseOptionsForType(div, TYPES.WORD_FILL);
    const blankCount = detectBlankCount(div, TYPES.WORD_FILL);
    const subQuestions = Array.from({ length: blankCount }, (_, index) => ({
      index: index + 1,
      content: `第${index + 1}空`,
      options: wordBank,
    }));
    const wordLine = wordBank.map((o) => `${o.label}. ${o.text}`).join(' ');
    const contentLines = ['[选词填空]', passage, `词库: ${wordLine}`];
    return { content: contentLines.filter(Boolean).join('\n'), subQuestions, blankCount };
  }

  /**
   * 从一组题目根元素中提取 Question 对象。
   * @param {ArrayLike<Element>} questionDivs 题目根元素集合
   * @returns {Array<object>} [{ id, number, type, content, options, blankCount }]
   */
  function extractQuestionsFromElements(questionDivs) {
    const questions = [];
    Array.from(questionDivs).forEach((div, index) => {
      const titleElem = div.querySelector('.mark_name');
      if (!titleElem) return;

      const typeSpan = titleElem.querySelector('.colorShallow');
      const rawType = extractRawType(div, typeSpan);
      const questionType = detectQuestionType(rawType);
      const displayNumber = extractDisplayNumber(titleElem);
      const id = div.getAttribute('data') || (div.getAttribute('id') || '').replace(/^sigleQuestionDiv_/, '');

      let content = extractContent(titleElem, questionType);
      let options = [];
      let subQuestions = [];
      let blankCount = 0;

      switch (questionType) {
        case TYPES.READING_COMPREHENSION: {
          const r = extractReadingSubQuestions(div);
          content = r.content;
          subQuestions = r.subQuestions;
          break;
        }
        case TYPES.CLOZE: {
          const r = div.querySelector('.reading_answer')
            ? extractReadingSubQuestions(div)
            : extractClozeSubQuestions(div);
          content = r.content;
          subQuestions = r.subQuestions;
          break;
        }
        case TYPES.SHARED_OPTIONS: {
          const r = extractSharedOptionsSubQuestions(div);
          content = r.content;
          subQuestions = r.subQuestions;
          break;
        }
        case TYPES.WORD_FILL: {
          const r = extractWordFillSubQuestions(div);
          content = r.content;
          subQuestions = r.subQuestions;
          blankCount = r.blankCount;
          break;
        }
        default: {
          options = parseOptionsForType(div, questionType);
          break;
        }
      }

      if (questionType === TYPES.FILL_BLANK || questionType === TYPES.WORD_FILL) {
        blankCount = detectBlankCount(div, questionType);
      }

      questions.push({
        id: id || String(index + 1),
        number: displayNumber || String(index + 1),
        type: questionType,
        content,
        options,
        blankCount,
        subQuestions,
      });
    });
    return questions;
  }

  /** 章节测验页题目提取（.singleQuesId[data] 结构，题型来自 .TiMu[data]） */
  function extractChapterQuestions(root) {
    const doc = root.document ?? root;
    const CHAPTER_TYPE_MAP = {
      '0': TYPES.SINGLE_CHOICE,
      '1': TYPES.MULTIPLE_CHOICE,
      '3': TYPES.JUDGE,
      '4': TYPES.QA,
    };
    return Array.from(doc.querySelectorAll('.singleQuesId[data]'))
      .map((div, index) => {
        const id = div.getAttribute('data') || '';
        const rawType = div.querySelector('.TiMu[data]')?.getAttribute('data') || '';
        const type = CHAPTER_TYPE_MAP[rawType] || TYPES.OTHER;
        const title = div.querySelector('.Zy_TItle');
        if (!id || !title) return null;

        const clone = title.cloneNode(true);
        clone.querySelector('i')?.remove();
        clone.querySelector('.newZy_TItle')?.remove();
        const content = normalizeInlineText(clone.textContent || '');

        const optionSelector = type === TYPES.MULTIPLE_CHOICE ? '.num_option_dx' : '.num_option';
        const options = Array.from(div.querySelectorAll(optionSelector))
          .map((optNode) => {
            const label = normalizeInlineText(optNode.textContent || optNode.getAttribute('data') || '');
            const value = optNode.getAttribute('data') || '';
            const text =
              type === TYPES.JUDGE
                ? value === 'true'
                  ? '正确'
                  : value === 'false'
                    ? '错误'
                    : normalizeInlineText(optNode.closest('li')?.querySelector('.after')?.textContent || '')
                : normalizeInlineText(optNode.closest('li')?.querySelector('.after')?.textContent || '');
            return { label, text };
          })
          .filter((o) => o.label && o.text);

        return {
          id,
          number: String(index + 1),
          type,
          content,
          options,
          blankCount: 0,
          subQuestions: [],
        };
      })
      .filter((q) => q !== null);
  }

  /**
   * 统一提取入口：自动识别考试页/作业页/章节测验页并返回题目数组。
   * @param {Document|object} root 页面根（Document 或 {document, win}）
   */
  function extractAll(root) {
    const doc = root.document ?? root;

    // 章节测验页
    if (doc.querySelector('.singleQuesId[data] .TiMu[data]')) {
      return extractChapterQuestions(root);
    }

    // 考试页
    const examDivs = doc.querySelectorAll('[id^="sigleQuestionDiv_"]');
    if (examDivs.length > 0) {
      return extractQuestionsFromElements(examDivs);
    }

    // 作业页（含预览/章节作业）
    const workDivs = doc.querySelectorAll('.questionLi');
    if (workDivs.length > 0) {
      return extractQuestionsFromElements(workDivs);
    }

    return [];
  }

  NS.extractor = {
    extractAll,
    extractQuestionsFromElements,
    extractExamQuestions: (root) => extractQuestionsFromElements((root.document ?? root).querySelectorAll('[id^="sigleQuestionDiv_"]')),
    extractWorkQuestions: (root) => extractQuestionsFromElements((root.document ?? root).querySelectorAll('.questionLi')),
    extractChapterQuestions,
    parseOptions,
    detectBlankCount,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
