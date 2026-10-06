/**
 * lib/filler.js
 * 超星学习通自动填写执行器。
 * 参考 MultiAI-Answer-cx 的 fill-choice / fill-blank / fill-judge / fill-qa / fill-composite 实现。
 *
 * 依赖：AUTOQUIZ.types
 * 导出：AUTOQUIZ.filler = { fillQuestion, clearQuestionState, fillChoiceAnswer, fillBlankAnswers, fillJudgeAnswer, fillQAAnswer, fillReadingAnswer, fillClozeAnswer, fillSharedOptionsAnswer, fillWordFillAnswer }
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});
  const TYPES = NS.QUESTION_TYPES || {};

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

  /** 触发 input / change 事件（富文本与隐藏 textarea 同步需要） */
  function dispatchValueEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  /**
   * 获取单/多选选项元素。单选含 .answerBg 与 li[onclick*="addChoice"]；多选同理。
   * 注意：考试页 .answerBg 单选用 .num_option，多选用 .num_option_dx。
   */
  function getChoiceOptions(questionDiv, isMultiple) {
    const selector = isMultiple
      ? '.answerBg, li[onclick*="addMultipleChoice"]'
      : '.answerBg, li[onclick*="addChoice"]';
    return Array.from(questionDiv.querySelectorAll(selector));
  }

  /**
   * 填写单选题：点击 .num_option 文本匹配字母的选项，并加 .check_answer 类。
   * @returns {boolean} 是否成功填写
   */
  async function fillSingleChoice(questionDiv, letter, clickDelayMs) {
    const options = getChoiceOptions(questionDiv, false);
    for (const option of options) {
      const span = option.querySelector('.num_option');
      if (!span) continue;
      const label = (span.textContent || '').trim();
      const isChecked = span.classList.contains('check_answer');
      if (label === letter.toUpperCase() && !isChecked) {
        clickElement(option);
        await delay(clickDelayMs);
        return true;
      }
    }
    return false;
  }

  /**
   * 填写多选题：先取消多余已选项，再点选目标字母（.num_option_dx 加 .check_answer_dx）。
   * @returns {boolean} 是否有新选中
   */
  async function fillMultipleChoice(questionDiv, letters, clickDelayMs, randomRange) {
    const options = getChoiceOptions(questionDiv, true);
    const selected = letters.map((l) => String(l).toUpperCase());

    // 1) 取消不在目标中的已选项
    for (const option of options) {
      const span = option.querySelector('.num_option_dx');
      if (!span) continue;
      const label = (span.textContent || '').trim();
      const isChecked = span.classList.contains('check_answer_dx');
      if (isChecked && !selected.includes(label)) {
        clickElement(option);
        await randomDelay(randomRange[0], randomRange[1]);
      }
    }

    // 2) 点选目标中未选的项
    let filled = false;
    for (const option of options) {
      const span = option.querySelector('.num_option_dx');
      if (!span) continue;
      const label = (span.textContent || '').trim();
      const isChecked = span.classList.contains('check_answer_dx');
      if (selected.includes(label) && !isChecked) {
        clickElement(option);
        filled = true;
        await randomDelay(randomRange[0], randomRange[1]);
      }
    }
    return filled;
  }

  /**
   * 选择题统一入口：answer 为数组 -> 多选；单个字母串 -> 单选（多个字母则按多选处理）。
   */
  async function fillChoiceAnswer(questionDiv, answer, speed) {
    const clickDelayMs = speed.singleClickDelay;
    if (Array.isArray(answer)) {
      return fillMultipleChoice(questionDiv, answer, clickDelayMs, speed.randomRange);
    }
    const cleaned = String(answer).replace(/[^A-Za-z]/g, '').toUpperCase();
    if (cleaned.length > 1) {
      return fillMultipleChoice(questionDiv, cleaned.split(''), clickDelayMs, speed.randomRange);
    }
    return fillSingleChoice(questionDiv, cleaned, clickDelayMs);
  }

  /** 判断题：按答案归一化为 true/false，点击 .num_option[data="true"/"false"] 或字母项 */
  async function fillJudgeAnswer(questionDiv, answer, speed) {
    const trimmed = String(answer).trim();
    let targetValue = 'false';
    if (
      trimmed === 'A' ||
      trimmed.includes('对') ||
      trimmed.includes('√') ||
      trimmed === 'true' ||
      trimmed === '1' ||
      trimmed === '正确'
    ) {
      targetValue = 'true';
    }

    const options = getChoiceOptions(questionDiv, false);
    for (const option of options) {
      const span = option.querySelector('.num_option');
      if (!span) continue;
      const optionValue = span.getAttribute('data');
      const isChecked = span.classList.contains('check_answer');
      // 优先匹配 data 值；无 data 时匹配文本（A/B 或 正确/错误）
      const label = (span.textContent || '').trim();
      const matches =
        optionValue === targetValue ||
        (targetValue === 'true' && (label === 'A' || label === '正确' || label === '对')) ||
        (targetValue === 'false' && (label === 'B' || label === '错误' || label === '错'));
      if (matches && !isChecked) {
        clickElement(option);
        await delay(speed.singleClickDelay);
        return true;
      }
    }
    return false;
  }

  /**
   * 填空题：逐个写入 .textTarget（或富文本编辑器），触发 input 事件，并同步隐藏 textarea。
   */
  async function fillBlankAnswers(questionDiv, answers, speed) {
    const blankDivs = Array.from(questionDiv.querySelectorAll('.sub_que_div, .Answer'));
    let filledAny = false;

    for (let i = 0; i < blankDivs.length; i++) {
      const answer = answers[i];
      if (!answer) continue;
      const container = blankDivs[i];
      if (!container) continue;
      if (filledAny) await randomDelay(speed.randomRange[0], speed.randomRange[1]);

      const filled = setEditorContent(container, answer, questionDiv.getAttribute('data'), i, speed);
      if (filled) filledAny = true;
    }

    // 无 .sub_que_div 时，直接处理 .textTarget 空位
    if (!filledAny) {
      const textTargets = Array.from(questionDiv.querySelectorAll('.textTarget'));
      for (let i = 0; i < textTargets.length; i++) {
        const answer = answers[i];
        if (!answer) continue;
        const target = textTargets[i];
        if (!target) continue;
        if (filledAny) await randomDelay(speed.randomRange[0], speed.randomRange[1]);
        target.innerHTML = answer;
        target.classList.add('hasFill');
        dispatchValueEvents(target);
        filledAny = true;
      }
    }
    return filledAny;
  }

  /**
   * 向富文本编辑器 iframe 与隐藏 textarea 写入内容。
   */
  function setEditorContent(answerContainer, text, questionId, blankIndex, speed) {
    const editorFrame = answerContainer.querySelector('.edui-editor-iframeholder iframe');
    if (editorFrame) {
      editorFrame.click();
      const editorDoc = editorFrame.contentDocument || editorFrame.contentWindow?.document;
      if (editorDoc) {
        editorDoc.body.innerHTML = `<p>${escapeHtml(text)}</p>`;
        editorDoc.body.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      }
    }

    // 同步隐藏 textarea（学习通常见：name^="answerEditor" 或 name="answerEditor{id}{n}"）
    const examDiv = answerContainer.querySelector('.divText.examAnswer, .divText.fl.wid750');
    const searchRoot = examDiv || answerContainer;
    let textarea = searchRoot.querySelector('textarea[name^="answerEditor"]');
    if (!textarea && questionId) {
      const name = `answerEditor${questionId}${blankIndex + 1}`;
      textarea = searchRoot.querySelector(`textarea[name="${name}"]`);
    }
    if (textarea) {
      textarea.value = `<p>${escapeHtml(text)}</p>`;
      textarea.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }

    const saveBtn = answerContainer.querySelector('.savebtndiv .jb_btn, .saveAnswer');
    if (saveBtn) {
      saveBtn.addEventListener('click', (e) => e.preventDefault(), { once: true });
      saveBtn.click();
    }
    return true;
  }

  /** HTML 转义（避免答案中的 < > & 破坏富文本） */
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * 简答题/问答题：写入富文本编辑器并同步 textarea[name^="answer"]，触发 input 事件。
   */
  async function fillQAAnswer(questionDiv, answer, speed) {
    const answerDiv = questionDiv.querySelector('.stem_answer.examAnswer, .stem_answer');
    if (!answerDiv) return false;

    const formatted = String(answer)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('');

    const editorFrame = answerDiv.querySelector('.edui-editor-iframeholder iframe');
    if (editorFrame) {
      editorFrame.click();
      await delay(speed.editorClickDelay);
      const editorDoc = editorFrame.contentDocument || editorFrame.contentWindow?.document;
      if (editorDoc) {
        editorDoc.body.innerHTML = formatted;
        editorDoc.body.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      }
    }

    const textarea = answerDiv.querySelector('textarea[name^="answer"]');
    if (textarea) {
      textarea.value = formatted;
      textarea.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }

    const saveBtn = answerDiv.querySelector('.savebtndiv .jb_btn');
    if (saveBtn) {
      await delay(speed.editorClickDelay);
      saveBtn.addEventListener('click', (e) => e.preventDefault(), { once: true });
      saveBtn.click();
    }
    return true;
  }

  /**
   * 复合题子答案解析：支持 "(1) A (2) B"、"1.A 2.B"、空白/逗号分隔字母串。
   */
  function parseSubAnswers(answer) {
    if (Array.isArray(answer)) return answer;
    const text = String(answer);
    const parenMatches = [...text.matchAll(/\(\d+\)\s*([A-Za-z]+)/g)];
    if (parenMatches.length > 0) return parenMatches.map((m) => (m[1] || '').toUpperCase());
    const dotMatches = [...text.matchAll(/\d+[.、]\s*([A-Za-z]+)/g)];
    if (dotMatches.length > 0) return dotMatches.map((m) => (m[1] || '').toUpperCase());
    return text
      .split(/[\s\n,，]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]+$/.test(s));
  }

  /** 阅读理解：逐 .reading_answer 块点选 .stem_answer .hoverDiv 中字母匹配的选项 */
  async function fillReadingAnswer(questionDiv, answer, speed) {
    const subAnswers = parseSubAnswers(answer);
    const blocks = Array.from(questionDiv.querySelectorAll('.reading_answer'));
    let filled = false;
    for (let i = 0; i < blocks.length; i++) {
      const letter = subAnswers[i];
      if (!blocks[i] || !letter) continue;
      if (filled) await randomDelay(speed.randomRange[0], speed.randomRange[1]);
      const options = Array.from(blocks[i].querySelectorAll('.stem_answer .hoverDiv'));
      for (const option of options) {
        const span = option.querySelector('span[class*="num_option"]');
        if (!span) continue;
        if ((span.textContent || '').trim().toUpperCase() === letter) {
          clickElement(option);
          await delay(speed.singleClickDelay);
          filled = true;
          break;
        }
      }
    }
    return filled;
  }

  /** 完形填空：逐 .stem_answer（含 .answerBg）点选对应字母 */
  async function fillClozeAnswer(questionDiv, answer, speed) {
    const subAnswers = parseSubAnswers(answer);
    const containers = Array.from(questionDiv.querySelectorAll('.stem_answer')).filter((c) => c.querySelector('.answerBg'));
    let filled = false;
    for (let i = 0; i < containers.length; i++) {
      const letter = subAnswers[i];
      if (!containers[i] || !letter) continue;
      if (filled) await randomDelay(speed.randomRange[0], speed.randomRange[1]);
      const options = Array.from(containers[i].querySelectorAll('.answerBg'));
      for (const option of options) {
        const span = option.querySelector('.num_option');
        if (!span) continue;
        if ((span.textContent || '').trim().toUpperCase() === letter) {
          clickElement(option);
          await delay(speed.singleClickDelay);
          filled = true;
          break;
        }
      }
    }
    return filled;
  }

  /** 共用选项题：逐 .B-answer-ct 块点选 span[choice_name="{letter}"] */
  async function fillSharedOptionsAnswer(questionDiv, answer, speed) {
    const subAnswers = parseSubAnswers(answer);
    const blocks = Array.from(questionDiv.querySelectorAll('.B-answer-ct'));
    let filled = false;
    for (let i = 0; i < blocks.length; i++) {
      const letter = subAnswers[i];
      if (!blocks[i] || !letter) continue;
      if (filled) await randomDelay(speed.randomRange[0], speed.randomRange[1]);
      const span = blocks[i].querySelector(`.B-answerCon span[choice_name="${letter}"]`);
      if (span) {
        clickElement(span);
        await delay(speed.singleClickDelay);
        filled = true;
      }
    }
    return filled;
  }

  /** 选词填空：把词库词写入 .textTarget 空位并同步隐藏 input */
  async function fillWordFillAnswer(questionDiv, answer, speed) {
    const subAnswers = parseSubAnswers(answer);
    const blanks = Array.from(questionDiv.querySelectorAll('.textTarget'));
    const fillBlanksJson = [];
    let filled = false;

    for (let i = 0; i < blanks.length; i++) {
      const letter = subAnswers[i] || '';
      if (!blanks[i] || !letter) continue;
      if (filled) await randomDelay(speed.randomRange[0], speed.randomRange[1]);

      const optionSpan = questionDiv.querySelector(`.blanksBox span[data-choose-name="${letter}"]`);
      const wordText = optionSpan ? optionSpan.textContent : letter;
      blanks[i].innerHTML = wordText;
      blanks[i].classList.add('hasFill');
      blanks[i].dataset.chooseName = letter;
      blanks[i].draggable = true;
      filled = true;
      fillBlanksJson.push({ name: i + 1, content: letter });
    }

    if (filled) {
      const qid =
        questionDiv.getAttribute('data') ||
        questionDiv.querySelector('.fillBlanksChoose')?.getAttribute('data') ||
        questionDiv.querySelector('.textTarget')?.getAttribute('data-qid') ||
        '';
      if (qid) {
        const hiddenInput = document.querySelector(`#answer${qid}, input[name="answer${qid}"]`);
        if (hiddenInput) hiddenInput.value = JSON.stringify(fillBlanksJson);
        try {
          chrome.runtime.sendMessage({ type: 'EXEC_PAGE_FUNC', funcName: 'saveFillinBlanks', args: [qid] }).catch(() => {});
        } catch { /* 页面上下文无 chrome.runtime 时忽略 */ }
      }
    }
    return filled;
  }

  /**
   * 清除已选状态：单选/判断清 .check_answer，多选清 .check_answer_dx，复合题两者都清，选词填空清空 .textTarget。
   */
  function clearQuestionState(questionDiv, questionType) {
    switch (questionType) {
      case TYPES.SINGLE_CHOICE:
      case TYPES.JUDGE:
        questionDiv.querySelectorAll('.check_answer').forEach((el) => el.classList.remove('check_answer'));
        break;
      case TYPES.MULTIPLE_CHOICE:
        questionDiv.querySelectorAll('.check_answer_dx').forEach((el) => el.classList.remove('check_answer_dx'));
        break;
      case TYPES.READING_COMPREHENSION:
      case TYPES.CLOZE:
      case TYPES.SHARED_OPTIONS:
        questionDiv.querySelectorAll('.check_answer').forEach((el) => el.classList.remove('check_answer'));
        questionDiv.querySelectorAll('.check_answer_dx').forEach((el) => el.classList.remove('check_answer_dx'));
        break;
      case TYPES.WORD_FILL:
        questionDiv.querySelectorAll('.textTarget').forEach((blank) => {
          blank.innerHTML = '';
          blank.classList.remove('hasFill');
          delete blank.dataset.chooseName;
          blank.draggable = false;
        });
        break;
      default:
        break;
    }
  }

  /**
   * 根据题目类型派发到对应填写函数。
   * @param {Element} questionDiv 题目根元素（考试页 sigleQuestionDiv_ / 作业页 questionLi）
   * @param {string|string[]} answer LLM 返回的答案
   * @param {string} questionType QUESTION_TYPES 枚举值
   * @param {object} speed 速度参数 { singleClickDelay, editorClickDelay, randomRange }
   */
  async function fillByType(questionDiv, answer, questionType, speed) {
    switch (questionType) {
      case TYPES.SINGLE_CHOICE:
      case TYPES.MULTIPLE_CHOICE:
        return fillChoiceAnswer(questionDiv, answer, speed);
      case TYPES.FILL_BLANK:
        return fillBlankAnswers(questionDiv, Array.isArray(answer) ? answer : [answer], speed);
      case TYPES.JUDGE:
        return fillJudgeAnswer(questionDiv, Array.isArray(answer) ? answer[0] || '' : answer, speed);
      case TYPES.QA:
      case TYPES.WORD_DEFINITION:
      case TYPES.OTHER:
        return fillQAAnswer(questionDiv, Array.isArray(answer) ? answer.join('\n') : answer, speed);
      case TYPES.READING_COMPREHENSION:
        return fillReadingAnswer(questionDiv, answer, speed);
      case TYPES.CLOZE:
        if (questionDiv.querySelector('.reading_answer')) {
          return fillReadingAnswer(questionDiv, answer, speed);
        }
        return fillClozeAnswer(questionDiv, answer, speed);
      case TYPES.SHARED_OPTIONS:
        return fillSharedOptionsAnswer(questionDiv, answer, speed);
      case TYPES.WORD_FILL:
        return fillWordFillAnswer(questionDiv, answer, speed);
      default:
        return false;
    }
  }

  /**
   * 单题填写入口：定位题目根元素 -> 清除已选 -> 按题型填写。
   * 支持多种根元素定位（考试页 id、作业页 data 属性、章节页 data 属性）。
   * @param {Document|object} root 页面根
   * @param {object} question Question 对象（含 id / type）
   * @param {string|string[]} answer
   * @param {object} [speedConfig]
   * @returns {Promise<boolean>}
   */
  async function fillQuestion(root, question, answer, speedConfig) {
    const doc = root.document ?? root;
    const speed = speedConfig || {
      singleClickDelay: 1000,
      editorClickDelay: 500,
      randomRange: [500, 1500],
    };

    // 1) 考试页：id -> [id^="sigleQuestionDiv_{id}"]
    let questionDiv = doc.getElementById(`sigleQuestionDiv_${question.id}`);
    // 2) 作业页 / 章节页：.questionLi[data="{id}"] / .singleQuesId[data="{id}"]
    if (!questionDiv) {
      questionDiv = doc.querySelector(`.questionLi[data="${question.id}"], .singleQuesId[data="${question.id}"]`);
    }
    // 3) 兜底：没有匹配时按序号位置取题目根
    if (!questionDiv) {
      const candidates = doc.querySelectorAll('[id^="sigleQuestionDiv_"], .questionLi, .singleQuesId[data]');
      const index = Number(question.number) - 1;
      questionDiv = candidates[index] || null;
    }
    if (!questionDiv) return false;

    clearQuestionState(questionDiv, question.type);
    return fillByType(questionDiv, answer, question.type, speed);
  }

  /** 从配置 speedLevel 换算速度参数 */
  function speedFromConfig(config) {
    const ranges = (NS.llm && NS.llm.SPEED_RANGES) || { slow: [1000, 2500], normal: [500, 1500], fast: [150, 500] };
    const range = ranges[config && config.speedLevel] || ranges.normal;
    return {
      singleClickDelay: 800,
      editorClickDelay: 400,
      randomRange: range,
    };
  }

  NS.filler = {
    fillQuestion,
    fillByType,
    clearQuestionState,
    fillChoiceAnswer,
    fillBlankAnswers,
    fillJudgeAnswer,
    fillQAAnswer,
    fillReadingAnswer,
    fillClozeAnswer,
    fillSharedOptionsAnswer,
    fillWordFillAnswer,
    speedFromConfig,
    dispatchValueEvents,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
