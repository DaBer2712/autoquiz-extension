/**
 * lib/adapters/rain-classroom.js
 * 雨课堂页面适配器：负责"检测当前页面是否是雨课堂答题页"并完成题目提取与答案填写。
 * DOM 结构参考 YuketangGoodbye（翔子酱）与 isHarryh/Yuketang-JS 项目实测选择器：
 *   - 题目根: .subject-item / .exam-question-item / .question-card-list li
 *   - 内容区: .item-body / .question-body / .question-content / .item-wrapper（题型标识 .item-type 在其父级）
 *   - 选项容器: .list-inline.list-unstyled-radio（判断题）/ .list-unstyled.list-unstyled-radio（选择题）/ .list-unstyled / ul.list
 *   - 选项行: li 内 label.el-radio / label.el-checkbox / .el-radio__label / .el-checkbox__label / input
 *   - 已作答: input:checked / .el-radio.is-checked / .el-checkbox.is-checked
 *   - 提交按钮: .el-button--primary（含"提交"）；交卷按钮: 含"交卷|提交作业|提交考试|提交测验|完成答题"
 *
 * 依赖：AUTOQUIZ.types（detectQuestionType）
 * 导出：AUTOQUIZ.adapters.rainClassroom
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});
  const adapters = (NS.adapters = NS.adapters || {});
  const TYPES = NS.QUESTION_TYPES || {};
  const detectQuestionType = NS.detectQuestionType || function () { return TYPES.OTHER || 'other'; };

  /** 统一空白：连续空白折叠为单个空格 */
  function normalizeInlineText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /** 延迟工具 */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function randomDelay(min, max) {
    return delay(Math.floor(Math.random() * (max - min + 1)) + min);
  }

  /** 稳健点击：优先原生 click，失败则派发 MouseEvent */
  function clickElement(el) {
    try {
      el.click();
    } catch {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  }

  /** 触发 input / change 事件（Vue/Element UI 组件需要事件通知） */
  function dispatchValueEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  /** 题目根候选选择器（按优先级排列） */
  const QUESTION_ROOT_SELECTORS = [
    '.subject-item.J_order',
    '.subject-item',
    '.exam-question-item',
    '.question-card-list li',
    '.question-card__item',
  ];

  /** 内容区候选选择器 */
  const CONTENT_SELECTORS = [
    '.item-body',
    '.question-body',
    '.question-content',
    '.item-wrapper',
  ];

  /** 查找页面上的题目根集合（去重，保持 DOM 顺序；排除左侧题号导航） */
  function queryQuestionRoots(doc) {
    const seen = new Set();
    const roots = [];
    for (const sel of QUESTION_ROOT_SELECTORS) {
      for (const el of doc.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        roots.push(el);
      }
    }
    // 雨课堂成绩回顾页左侧题号导航为 div.subject-item.primary（与题目卡同名），
    // 存在主内容区 .exam-main--content 时只保留其内部的题目根，避免把导航当题目。
    const mainContent = doc.querySelector('.exam-main--content');
    if (mainContent) {
      return roots.filter((el) => mainContent.contains(el));
    }
    return roots;
  }

  /** 获取题目内容区：优先 .item-body，其次其他内容选择器，最后退回题目根本身 */
  function resolveContent(questionDiv) {
    const typeEl = questionDiv.querySelector('.item-type');
    if (typeEl && typeEl.parentElement) return typeEl.parentElement;
    for (const sel of CONTENT_SELECTORS) {
      const candidate = questionDiv.querySelector(sel);
      if (candidate) return candidate;
    }
    return questionDiv;
  }

  /** 从题型标记 / 文本中解析原始题型字符串（如 "单选题(2分)" -> "单选题"） */
  function extractRawType(questionDiv, contentEl) {
    const typeEl = questionDiv.querySelector('.item-type');
    if (typeEl && typeEl.textContent) {
      const text = normalizeInlineText(typeEl.textContent);
      const m = text.match(/^\s*(单选题|多选题|判断题|是非题|填空题|简答题|问答题|论述题|名词解释|计算题|阅读理解|完形填空|完型填空|共用选项题|选词填空)/);
      if (m) return m[1];
      return text.replace(/[()（）]\d*\s*分?\s*[)）]?$/, '').trim();
    }
    if (contentEl && contentEl.textContent) {
      const m = contentEl.textContent.match(/[（(]\s*(单选题|多选题|判断题|填空题|简答题)\s*[)）]/);
      if (m) return m[1];
    }
    return '其他';
  }

  /** 提取题目正文：去掉题号与题型括号 */
  function extractContent(contentEl, rawType) {
    if (!contentEl) return '';
    const clone = contentEl.cloneNode(true);
    clone.querySelector('.item-type')?.remove();
    clone.querySelector('.colorShallow')?.remove();
    clone.querySelector('.question-type')?.remove();
    let text = normalizeInlineText(clone.textContent || '');
    text = text.replace(/^\s*\d+\s*[.、．]\s*/, '');
    if (rawType) {
      text = text.replace(new RegExp(`[（(]\\s*${rawType}[^)）]*[)）]`), '');
    }
    if (TYPES.FILL_BLANK === detectQuestionType(rawType)) {
      text = text.replace(/_{3,}/g, '____').replace(/\s{3,}/g, '____');
    }
    return text;
  }

  /** 解析单题选项：选项行 li 的字母键与文本 */
  function parseOptions(questionDiv) {
    const list = findOptionList(questionDiv);
    if (!list) return [];
    return Array.from(list.querySelectorAll('li'))
      .map((item, index) => {
        const labelEl = item.querySelector('.el-radio__label, .el-checkbox__label');
        const text = normalizeInlineText(labelEl ? labelEl.textContent : item.textContent || '');
        // 去掉前缀字母（"A." / "A、" / "A ）"
        const cleanText = text.replace(/^\s*[A-Ha-h]\s*[.、．)）]?\s*/, '').trim();
        const keyMatch = text.match(/^\s*([A-Ha-h])\s*[.、．)）]/);
        const key = keyMatch ? keyMatch[1].toUpperCase() : String.fromCharCode(65 + index);
        return { key, text: cleanText || text, item };
      })
      .filter((o) => o.text);
  }

  /** 查找题目内的选项列表容器 */
  function findOptionList(questionDiv) {
    const contentEl = resolveContent(questionDiv);
    const root = contentEl !== questionDiv ? contentEl : questionDiv;
    return (
      root.querySelector('.list-inline.list-unstyled-radio') ||
      root.querySelector('.list-unstyled.list-unstyled-radio') ||
      root.querySelector('.list-unstyled') ||
      root.querySelector('ul.list') ||
      root.querySelector('ul')
    );
  }

  /** 填空题空位数量：统计内容区可输入控件 */
  function detectBlankCount(questionDiv) {
    const contentEl = resolveContent(questionDiv);
    const inputs = contentEl.querySelectorAll(
      'textarea, .el-textarea__inner, input.el-input__inner, [contenteditable="true"]',
    );
    if (inputs.length > 0) return inputs.length;
    const blanks = contentEl.querySelectorAll('.__blank, .blank, .fill-blank');
    return blanks.length;
  }

  /** 检查题目是否已作答（有选中或已填写） */
  function isAnswered(questionDiv) {
    if (questionDiv.querySelector('.el-radio.is-checked, .el-checkbox.is-checked')) return true;
    const checkedInputs = questionDiv.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked');
    if (checkedInputs.length > 0) return true;
    const contentEl = resolveContent(questionDiv);
    const textInputs = contentEl.querySelectorAll('textarea, .el-textarea__inner, input.el-input__inner');
    for (const input of textInputs) {
      if (input.value && input.value.trim()) return true;
    }
    return false;
  }

  /** 单选/判断/多选：把答案字母（或数组）映射为选项索引并点击 */
  async function selectOptionsByAnswer(questionDiv, answer, isMultiple, speed) {
    const list = findOptionList(questionDiv);
    if (!list) return false;
    const items = Array.from(list.querySelectorAll('li'));
    if (items.length === 0) return false;

    const answers = isMultiple
      ? Array.isArray(answer)
        ? answer.map((a) => String(a).replace(/[^A-Za-z对错正确错误]/g, '').trim()).filter(Boolean)
        : String(answer)
            .split(/[\s,，、]+/)
            .map((s) => s.trim())
            .filter(Boolean)
      : [String(answer).replace(/[^A-Za-z对错正确错误]/g, '').trim()];
    if (answers.length === 0) return false;

    // 答案 -> 目标选项索引（A->0, B->1 ...；对/正确->0，错/错误->1；也可按选项文本匹配）
    const keyToIndex = (key) => {
      const letter = key.match(/^[A-Za-z]$/);
      if (letter) return letter[0].toUpperCase().charCodeAt(0) - 65;
      if (/对|正确|√/.test(key)) return 0;
      if (/错|错误|×|x/i.test(key)) return 1;
      return -1;
    };

    const targetIndices = [];
    for (const key of answers) {
      let idx = keyToIndex(key);
      if (idx < 0) {
        // 文本兜底：在选项文本中找包含 key 的项
        idx = items.findIndex((item) => {
          const labelEl = item.querySelector('.el-radio__label, .el-checkbox__label');
          const text = labelEl ? labelEl.textContent : item.textContent || '';
          return text.includes(key);
        });
      }
      if (idx >= 0 && idx < items.length && !targetIndices.includes(idx)) {
        targetIndices.push(idx);
      }
    }
    if (targetIndices.length === 0) return false;

    // 1) 取消多余已选项
    for (let i = 0; i < items.length; i++) {
      if (targetIndices.includes(i)) continue;
      const input = items[i].querySelector('input[type="radio"], input[type="checkbox"]');
      const isChecked = input ? input.checked : items[i].querySelector('.is-checked') !== null;
      if (isChecked) {
        clickOptionElement(items[i]);
        await randomDelay(speed.randomRange[0], speed.randomRange[1]);
      }
    }

    // 2) 点选目标中未选的项
    let filled = false;
    for (const idx of targetIndices) {
      const input = items[idx].querySelector('input[type="radio"], input[type="checkbox"]');
      const isChecked = input ? input.checked : items[idx].querySelector('.is-checked') !== null;
      if (!isChecked) {
        clickOptionElement(items[idx]);
        filled = true;
        await randomDelay(speed.randomRange[0], speed.randomRange[1]);
      }
    }
    return filled;
  }

  /** 点击选项行内可点击元素（label 优先） */
  function clickOptionElement(item) {
    const clickable =
      item.querySelector('label.el-radio') ||
      item.querySelector('label.el-checkbox') ||
      item.querySelector('.el-radio__label') ||
      item.querySelector('.el-checkbox__label') ||
      item.querySelector('input') ||
      item;
    clickElement(clickable);
  }

  /** 填空题/简答题：逐个写入输入控件 */
  async function fillTextAnswers(questionDiv, answers, speed) {
    const contentEl = resolveContent(questionDiv);
    const fields = Array.from(
      contentEl.querySelectorAll('textarea, .el-textarea__inner, input.el-input__inner, [contenteditable="true"]'),
    );
    let filled = false;
    for (let i = 0; i < fields.length; i++) {
      const answer = answers[i];
      if (answer === undefined || answer === null || String(answer).trim() === '') continue;
      if (filled) await randomDelay(speed.randomRange[0], speed.randomRange[1]);
      const field = fields[i];
      if (field.isContentEditable) {
        field.textContent = String(answer);
      } else {
        field.value = String(answer);
      }
      dispatchValueEvents(field);
      filled = true;
    }
    return filled;
  }

  /**
   * 适配器对象（接口约定与 chaoxing.js 一致）：
   * - id: 'rain-classroom'
   * - name: '雨课堂'
   * - detect(root): boolean
   * - extract(root): Question[]
   * - fill(root, question, answer, speedConfig): Promise<boolean>
   * - submit?(root): Promise<boolean>
   */
  adapters.rainClassroom = {
    id: 'rain-classroom',
    name: '雨课堂',

    /** 雨课堂答题页：存在题目根且内容区/选项结构可辨识 */
    detect(root) {
      const doc = root.document ?? root;
      const roots = queryQuestionRoots(doc);
      if (roots.length === 0) return false;
      // 至少有一题包含内容区或选项容器，避免误判普通列表页
      return roots.some((el) => {
        const content = resolveContent(el);
        return content && content !== el && (content.textContent || '').trim().length > 10;
      });
    },

    /**
     * 判断页面是否为只读回顾页（成绩/结果页，选项已禁用无法作答）。
     * 用于 content.js 分流：回顾页不自动填写，仅展示 AI 答案。
     */
    isReadonly(root) {
      const doc = root.document ?? root;
      if (doc.querySelector('.exam.exam-result, .exam-result')) return true;
      const roots = queryQuestionRoots(doc);
      if (roots.length === 0) return false;
      const sample = roots[0];
      return (
        sample.querySelector('input[disabled], .el-radio.is-disabled, .el-checkbox.is-disabled, .el-radio__original[disabled]') !== null
      );
    },

    /** 提取全部题目 */
    extract(root) {
      const doc = root.document ?? root;
      const roots = queryQuestionRoots(doc);
      const questions = [];
      roots.forEach((div, index) => {
        const contentEl = resolveContent(div);
        if (!contentEl) return;
        const rawType = extractRawType(div, contentEl);
        const questionType = detectQuestionType(rawType);
        const content = extractContent(contentEl, rawType);
        if (content.length < 2) return;

        const id =
          div.getAttribute('data-id') ||
          div.getAttribute('data-problem-id') ||
          div.getAttribute('id') ||
          div.getAttribute('data') ||
          String(index + 1);

        const options = parseOptions(div).map((o) => ({ label: o.key, text: o.text }));
        const blankCount = detectBlankCount(div);
        const number = (content.match(/^\d+/) || [String(index + 1)])[0];

        questions.push({
          id,
          number: String(index + 1),
          type: questionType,
          content,
          options,
          blankCount,
          subQuestions: [],
        });
      });
      return questions;
    },

    /** 填写单题答案 */
    async fill(root, question, answer, speedConfig) {
      const doc = root.document ?? root;
      const speed = speedConfig || {
        singleClickDelay: 1000,
        editorClickDelay: 500,
        randomRange: [500, 1500],
      };

      // 定位题目根
      let questionDiv = doc.querySelector(
        `.subject-item[data-id="${question.id}"], .exam-question-item[data-id="${question.id}"], .question-card-list li[data-id="${question.id}"]`,
      );
      if (!questionDiv) {
        const candidates = queryQuestionRoots(doc);
        const index = Number(question.number) - 1;
        questionDiv = candidates[index] || null;
      }
      if (!questionDiv) return false;
      if (answer === undefined || answer === null || String(answer).trim() === '') return false;

      switch (question.type) {
        case TYPES.SINGLE_CHOICE:
        case TYPES.JUDGE:
          return selectOptionsByAnswer(questionDiv, answer, false, speed);
        case TYPES.MULTIPLE_CHOICE:
          return selectOptionsByAnswer(questionDiv, answer, true, speed);
        case TYPES.FILL_BLANK:
          return fillTextAnswers(questionDiv, Array.isArray(answer) ? answer : [answer], speed);
        case TYPES.QA:
        case TYPES.WORD_DEFINITION:
        case TYPES.OTHER:
          return fillTextAnswers(questionDiv, Array.isArray(answer) ? answer : [answer], speed);
        default:
          // 复合题型无专门 DOM 时退回选择填写
          return selectOptionsByAnswer(questionDiv, answer, true, speed);
      }
    },

    /** 可选：提交/交卷（含"交卷/提交作业/提交考试/提交测验/完成答题"的主按钮） */
    async submit(root) {
      const doc = root.document ?? root;
      const buttons = Array.from(doc.querySelectorAll('button.el-button--primary, button'));
      const finalBtn = buttons.find(
        (btn) =>
          /交卷|提交作业|提交考试|提交测验|完成答题|保存并提交/.test(btn.innerText || '') &&
          !btn.disabled &&
          btn.offsetParent !== null,
      );
      if (!finalBtn) return false;
      clickElement(finalBtn);
      await delay(500);
      // Element UI 确认弹窗
      const confirmBtn = doc.querySelector('.el-message-box__btns .el-button--primary');
      if (confirmBtn && !confirmBtn.disabled) {
        clickElement(confirmBtn);
      }
      return true;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
