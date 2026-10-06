/**
 * content.js
 * 内容脚本主入口：注入浮动控制条（"开始AI答题"按钮 + 进度显示），
 * 点击后：extractor 抓题 -> chrome.runtime.sendMessage(GET_ANSWERS) 交给 background 调 LLM
 * -> 拿到答案 JSON 后 filler 自动填写 -> 悬浮条显示"已完成 n 题"。
 * 页面为 SPA 时用 MutationObserver 监听 .mark_name 出现后再绑定按钮。
 *
 * 依赖：lib/types.js、lib/adapters/*.js、lib/extractor.js、lib/filler.js（已在 manifest 中前置加载）
 */
(function () {
  'use strict';

  if (!globalThis.AUTOQUIZ) {
    console.warn('[AutoQuiz] 基础模块未加载，脚本中止');
    return;
  }
  if (window.__autoquizInjected) return;
  window.__autoquizInjected = true;

  const NS = globalThis.AUTOQUIZ;
  const extractor = NS.extractor;
  const filler = NS.filler;
  const TYPES = NS.QUESTION_TYPES;

  /** 当前页面命中的适配器（优先走注册表，便于后续接入雨课堂） */
  let activeAdapter = null;

  /** 解析适配器：优先用注册表 detect，找不到时按已知页面结构回退到学习通通用提取 */
  function resolveAdapter(root) {
    if (NS.adapters && typeof NS.adapters.detectAdapter === 'function') {
      const adapter = NS.adapters.detectAdapter(root);
      if (adapter) return adapter;
    }
    // 兜底：仍是学习通结构时直接使用通用 extractor/filler
    if (hasQuestions(root)) {
      return { id: 'chaoxing-fallback', extract: (r) => extractor.extractAll(r), fill: (r, q, a, s) => filler.fillQuestion(r, q, a, s) };
    }
    return null;
  }

  /** 运行状态 */
  const state = {
    running: false, // 是否正在答题
    total: 0, // 题目总数
    done: 0, // 已完成题数
    failed: 0, // 失败题数
  };

  /** 悬浮条 DOM 引用 */
  let bar = null;
  let btnStart = null;
  let statusEl = null;

  /** 归一化页面根：优先使用 shadow-root 场景中可用的 document */
  function getRoot() {
    return document;
  }

  /** 判断当前页面是否存在题目 */
  function hasQuestions(root) {
    const doc = root.document ?? root;
    return (
      doc.querySelector('[id^="sigleQuestionDiv_"]') !== null ||
      doc.querySelector('.questionLi') !== null ||
      doc.querySelector('.singleQuesId[data] .TiMu[data]') !== null
    );
  }

  /** 更新悬浮条状态文本 */
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  /**
   * 抓题 -> 发消息 -> 填写 的完整流程。
   */
  async function startAnswering() {
    if (state.running) {
      setStatus('正在答题中，请勿重复点击');
      return;
    }

    const root = getRoot();
    // 解析当前页面适配器（学习通 / 雨课堂）
    activeAdapter = resolveAdapter(root);
    if (!activeAdapter) {
      setStatus('未识别到可答题的页面（学习通/雨课堂考试作业页）');
      return;
    }
    const questions = activeAdapter.extract(root);
    if (!questions || questions.length === 0) {
      setStatus('未找到题目，请确认已进入考试/作业页面');
      return;
    }

    state.running = true;
    state.total = questions.length;
    state.done = 0;
    state.failed = 0;
    btnStart.disabled = true;
    setStatus(`已抓取 ${questions.length} 题，正在请求 AI...`);

    try {
      // 1) 分页请求答案：按 batchSize 分批发送给 background
      const config = await getConfig();
      const batchSize = Math.max(1, config.batchSize || 10);
      const allAnswers = new Map(); // questionId -> answer

      for (let offset = 0; offset < questions.length; offset += batchSize) {
        const batch = questions.slice(offset, offset + batchSize);
        setStatus(`AI 请求中...（${offset + 1}-${Math.min(offset + batchSize, questions.length)}/${questions.length}）`);
        const resp = await sendGetAnswers(batch);
        if (!resp || !resp.ok) {
          setStatus(`AI 请求失败：${(resp && resp.error) || '未知错误'}`);
          state.running = false;
          btnStart.disabled = false;
          return;
        }
        if (Array.isArray(resp.answers)) {
          resp.answers.forEach((a) => {
            if (a && a.id !== undefined) allAnswers.set(String(a.id), a.answer);
          });
        }
      }

      // 2) 只读回顾页（如雨课堂成绩/结果页）：不自动填写，展示答案面板
      if (activeAdapter.isReadonly && activeAdapter.isReadonly(root)) {
        renderAnswersPanel(questions, allAnswers);
        setStatus(`回顾页只读：已展示 ${allAnswers.size} 题答案（自动填写已跳过）`);
        return;
      }

      // 3) 自动填写（若配置开启）
      if (config.autoFill !== false) {
        const speed = filler.speedFromConfig(config);
        for (const q of questions) {
          const answer = allAnswers.get(String(q.id));
          if (answer === undefined || answer === null) {
            state.failed++;
            continue;
          }
          try {
            const ok = await activeAdapter.fill(root, q, answer, speed);
            if (ok) state.done++;
            else state.failed++;
          } catch (err) {
            console.warn('[AutoQuiz] 填写失败：', q.id, err);
            state.failed++;
          }
        }
        setStatus(`已完成 ${state.done} 题（失败 ${state.failed}）`);
      } else {
        setStatus(`AI 已返回 ${allAnswers.size} 题答案（自动填写已关闭，请手动填写）`);
      }
    } catch (err) {
      console.error('[AutoQuiz] 答题流程异常：', err);
      setStatus(`发生异常：${err && err.message ? err.message : err}`);
    } finally {
      state.running = false;
      btnStart.disabled = false;
    }
  }

  /** 读取配置 */
  async function getConfig() {
    try {
      const defaults = (NS.llm && NS.llm.DEFAULT_CONFIG) || {};
      const stored = await chrome.storage.sync.get(defaults);
      return { ...defaults, ...stored };
    } catch {
      return { batchSize: 10, autoFill: true, speedLevel: 'normal' };
    }
  }

  /** 向 background 发送 GET_ANSWERS 消息 */
  function sendGetAnswers(questions) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'GET_ANSWERS', questions },
          (response) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(response);
            }
          },
        );
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  /** 接收 popup 下发的一键答题指令 */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'START_ANSWER') {
      void startAnswering();
      sendResponse({ success: true });
      return true;
    }
    return false;
  });

  /** 渲染答案面板（只读回顾页场景：展示 AI 答案，不自动填写） */
  function renderAnswersPanel(questions, answersMap) {
    const old = document.getElementById('autoquiz-answer-panel');
    if (old) old.remove();

    const panel = document.createElement('div');
    panel.id = 'autoquiz-answer-panel';
    panel.style.cssText = [
      'position:fixed',
      'top:150px',
      'right:16px',
      'z-index:2147483646',
      'width:300px',
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

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-weight:bold;color:#fff;';
    const title = document.createElement('span');
    title.textContent = 'AI 参考答案（回顾页只读）';
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'cursor:pointer;color:#aaa;font-size:16px;line-height:1;';
    closeBtn.addEventListener('click', () => panel.remove());
    head.appendChild(title);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    questions.forEach((q, idx) => {
      const answer = answersMap.get(String(q.id));
      const row = document.createElement('div');
      row.style.cssText = 'padding:4px 0;border-bottom:1px solid #333;word-break:break-all;';
      const text =
        answer === undefined || answer === null || answer === ''
          ? '（未获取）'
          : Array.isArray(answer)
            ? answer.join(', ')
            : String(answer);
      row.textContent = `${idx + 1}. ${text}`;
      panel.appendChild(row);
    });

    document.documentElement.appendChild(panel);
  }

  /** 创建并注入浮动控制条 */
  function createBar() {
    if (bar) return;

    bar = document.createElement('div');
    bar.id = 'autoquiz-bar';
    bar.style.cssText = [
      'position:fixed',
      'top:80px',
      'right:16px',
      'z-index:2147483647',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'gap:6px',
      'padding:10px 12px',
      'background:rgba(30,30,30,0.92)',
      'color:#fff',
      'border-radius:10px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.3)',
      'font-family:"Microsoft YaHei",sans-serif',
      'font-size:12px',
      'max-width:180px',
      'user-select:none',
    ].join(';');

    btnStart = document.createElement('button');
    btnStart.textContent = '开始AI答题';
    btnStart.style.cssText = [
      'padding:8px 14px',
      'border:none',
      'border-radius:6px',
      'background:#3b82f6',
      'color:#fff',
      'font-size:13px',
      'font-weight:bold',
      'cursor:pointer',
    ].join(';');
    btnStart.addEventListener('click', () => void startAnswering());

    statusEl = document.createElement('div');
    statusEl.textContent = '等待开始';
    statusEl.style.cssText = 'color:#ddd;text-align:center;word-break:break-all;';

    bar.appendChild(btnStart);
    bar.appendChild(statusEl);
    document.documentElement.appendChild(bar);
  }

  /** 初始化：注入控制条；SPA 场景监听题目出现 */
  function init() {
    createBar();

    if (hasQuestions(getRoot())) {
      return;
    }

    // SPA：等待题目渲染后再提示可答题
    const observer = new MutationObserver(() => {
      if (hasQuestions(getRoot())) {
        setStatus('检测到题目，点击"开始AI答题"');
        observer.disconnect();
      }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
    // 兜底：8 秒后若仍无题目则停止监听
    setTimeout(() => observer.disconnect(), 8000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
