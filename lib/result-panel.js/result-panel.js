/**
 * lib/result-panel.js
 * 答题结果面板：每次答题完成后在页面右上角展示悬浮面板，逐题列出：
 * 题号、状态（已填/跳过/未命中/错误）、命中的答案或错误原因；支持关闭。
 * 参考 OCS work.ts workResultPanel 思路做轻量实现，同时兼容只读回顾页展示。
 *
 * 依赖：无（独立 IIFE 模块）
 * 导出：AUTOQUIZ.resultPanel = { STATUS_META, render, close }
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});

  /** 状态 -> 展示文案与徽标颜色 */
  const STATUS_META = {
    filled: { label: '已填', color: '#16a34a' },
    skipped: { label: '跳过', color: '#6b7280' },
    missed: { label: '未命中', color: '#d97706' },
    error: { label: '错误', color: '#dc2626' },
    view: { label: '仅查看', color: '#2563eb' },
  };

  function formatAnswer(answer) {
    if (Array.isArray(answer)) return answer.join(', ');
    if (answer === undefined || answer === null || answer === '') return '（无）';
    return String(answer);
  }

  /**
   * 渲染答题结果面板。
   * @param {Array<{number: (string|number), status: string, answer: *, reason: string, source: string}>} results
   * @param {object} [options] { title }
   */
  function render(results, options) {
    close();
    const opts = options || {};
    const doc = document;

    const panel = doc.createElement('div');
    panel.id = 'autoquiz-result-panel';
    panel.style.cssText = [
      'position:fixed',
      'top:150px',
      'right:16px',
      'z-index:2147483646',
      'width:340px',
      'max-height:60vh',
      'overflow-y:auto',
      'background:#1e1e1e',
      'color:#e8e8e8',
      'border-radius:10px',
      'padding:12px',
      'font-family:"Microsoft YaHei",sans-serif',
      'font-size:13px',
      'box-shadow:0 6px 20px rgba(0,0,0,0.4)',
      'user-select:none',
    ].join(';');

    // 头部：标题 + 关闭按钮
    const head = doc.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-weight:bold;color:#fff;';
    const title = doc.createElement('span');
    title.textContent = opts.title || '答题结果';
    const closeBtn = doc.createElement('span');
    closeBtn.textContent = '×';
    closeBtn.title = '关闭面板';
    closeBtn.style.cssText = 'cursor:pointer;color:#aaa;font-size:16px;line-height:1;padding:2px 6px;';
    closeBtn.addEventListener('click', () => panel.remove());
    head.appendChild(title);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    if (!Array.isArray(results) || results.length === 0) {
      const empty = doc.createElement('div');
      empty.textContent = '（无题目结果）';
      empty.style.cssText = 'color:#999;padding:6px 0;';
      panel.appendChild(empty);
    } else {
      results.forEach((r, idx) => {
        const meta = STATUS_META[r.status] || STATUS_META.skipped;
        const row = doc.createElement('div');
        row.style.cssText = 'padding:5px 0;border-bottom:1px solid #333;word-break:break-all;';

        const line = doc.createElement('div');
        line.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const num = doc.createElement('span');
        num.style.cssText = 'color:#9ca3af;min-width:26px;';
        num.textContent = `${r.number || idx + 1}.`;
        const badge = doc.createElement('span');
        badge.style.cssText = `flex-shrink:0;padding:1px 7px;border-radius:10px;font-size:11px;color:#fff;background:${meta.color};`;
        badge.textContent = meta.label;
        line.appendChild(num);
        line.appendChild(badge);
        if (r.source) {
          const src = doc.createElement('span');
          src.style.cssText = 'color:#888;font-size:11px;';
          src.textContent = r.source;
          line.appendChild(src);
        }
        row.appendChild(line);

        const detail = doc.createElement('div');
        detail.style.cssText = 'color:#c9c9c9;font-size:12px;padding:2px 0 0 32px;';
        if (r.status === 'filled' || r.status === 'view') {
          detail.textContent = `答案：${formatAnswer(r.answer)}`;
        } else if (r.reason) {
          detail.textContent = r.reason;
        } else if (r.answer !== undefined && r.answer !== null && r.answer !== '') {
          detail.textContent = `答案：${formatAnswer(r.answer)}`;
        } else {
          detail.textContent = '（无）';
        }
        row.appendChild(detail);
        panel.appendChild(row);
      });
    }

    const foot = doc.createElement('div');
    foot.style.cssText = 'margin-top:8px;font-size:11px;color:#777;text-align:center;';
    foot.textContent = `共 ${Array.isArray(results) ? results.length : 0} 题 · 点击右上角 × 关闭`;
    panel.appendChild(foot);

    (doc.documentElement || doc.body).appendChild(panel);
  }

  /** 关闭结果面板 */
  function close() {
    const old = document.getElementById('autoquiz-result-panel');
    if (old) old.remove();
  }

  NS.resultPanel = { STATUS_META, render, close };
})(typeof globalThis !== 'undefined' ? globalThis : window);
