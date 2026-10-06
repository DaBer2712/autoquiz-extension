/**
 * lib/adapters/chaoxing.js
 * 超星学习通页面适配器：负责"检测当前页面是否是学习通答题页"并委托 extractor / filler 执行提取与填写。
 * 后续雨课堂适配器（rain-classroom.js）按同一接口实现后注册进 registry 即可。
 *
 * 依赖：AUTOQUIZ.types（detectQuestionType）、AUTOQUIZ.extractor、AUTOQUIZ.filler
 * 导出：AUTOQUIZ.adapters.chaoxing
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});
  const adapters = (NS.adapters = NS.adapters || {});

  /**
   * 适配器接口约定（供 registry 使用）：
   * - id: string 唯一标识
   * - name: string 展示名
   * - detect(root): boolean 当前 DOM 是否属于本适配器页面
   * - extract(root): Question[] 提取题目
   * - fill(root, question, answer): Promise<boolean> 填写单题答案
   * - submit?(root): Promise<boolean> 可选：提交/保存整页
   */
  adapters.chaoxing = {
    id: 'chaoxing',
    name: '超星学习通',

    /** 考试页：存在 [id^="sigleQuestionDiv_"]；作业页：存在 .questionLi；章节测验：.singleQuesId[data] */
    detect(root) {
      const doc = root.document ?? root;
      return (
        doc.querySelector('[id^="sigleQuestionDiv_"]') !== null ||
        doc.querySelector('.questionLi') !== null ||
        doc.querySelector('.singleQuesId[data] .TiMu[data]') !== null
      );
    },

    /** 委托提取器抓取全部题目 */
    extract(root) {
      const extractor = NS.extractor;
      if (!extractor) {
        throw new Error('[AutoQuiz] extractor 未加载（lib/extractor.js 缺失）');
      }
      return extractor.extractAll(root);
    },

    /** 委托填写器填写单题答案（speedConfig 可选：{singleClickDelay, editorClickDelay, randomRange}） */
    async fill(root, question, answer, speedConfig) {
      const filler = NS.filler;
      if (!filler) {
        throw new Error('[AutoQuiz] filler 未加载（lib/filler.js 缺失）');
      }
      return filler.fillQuestion(root, question, answer, speedConfig);
    },

    /** 可选：提交当前作业（学习通作业页有 saveWork 按钮） */
    async submit(root) {
      const doc = root.document ?? root;
      const saveBtn = doc.querySelector('a[onclick="saveWork();"]');
      if (!saveBtn) return false;
      // 防止插件触发的保存被页面重复监听
      saveBtn.addEventListener('click', (e) => e.preventDefault(), { once: true });
      saveBtn.click();
      return true;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
