/**
 * content.js
 * 内容脚本主入口：注入浮动控制条（"开始AI答题"按钮 + 进度显示），
 * 点击后：extractor 抓题 -> 答案缓存预检（lib/cache.js） -> 共享题库预检（lib/shared-bank.js，命中免 LLM）
 * -> chrome.runtime.sendMessage(GET_ANSWERS) 交 background 调 LLM + 题库兜底
* -> resolver 答案规范化（lib/resolver.js：判断题词表/单选越界/多选去重排序/填空拆分）
 * -> filler 自动填写 -> result-panel（lib/result-panel.js）展示答题结果。
 * 答题过程中将 LLM/题库答案上传共享题库；回顾页（只读）读取官方正确答案回馈（最高权重）。
 * 页面为 SPA 时用 MutationObserver 监听 .mark_name 出现后再绑定按钮。
 *
 * 依赖：lib/types.js、lib/adapters/*.js、lib/extractor.js、lib/filler.js、
 *       lib/resolver.js、lib/cache.js、lib/shared-bank.js、lib/answer-feedback.js、lib/result-panel.js
 *       （已在 manifest 中前置加载）
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
  const resolver = NS.resolver;
  const answerCache = NS.answerCache;
  const resultPanel = NS.resultPanel;
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

  /** 答案来源的展示文案 */
  function sourceLabel(source) {
    if (source === 'cache') return '缓存';
    if (source === 'question_bank') return '题库';
    if (source === 'shared_bank') return '共享题库';
    if (source === 'official') return '官方答案';
    if (source === 'llm') return 'LLM';
    return '';
  }

  /** 共享题库是否可用（配置启用 + 模块已加载） */
  function sharedBankEnabled(config) {
    return !!(config.sharedBank && config.sharedBank.enabled && NS.sharedBank);
  }

  /**
   * 抓题 -> 缓存预检 -> 共享题库预检 -> 发消息 -> 规范化 -> 填写 -> 结果面板 的完整流程。
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
      // 1) 读取配置（questionBank / sharedBank 嵌套对象深合并）
      const config = await getConfig();
      const batchSize = Math.max(1, config.batchSize || 10);
      const platform = (activeAdapter && activeAdapter.id) || 'unknown';
      const allAnswers = new Map(); // id -> { answer, source }

      // 2) 答案缓存预检：同一套卷子（题目内容 hash）命中后直接复用，跳过 API 调用
      let needAsk = questions;
      if (config.cacheEnabled !== false && answerCache) {
        const toAsk = [];
        let cachedCount = 0;
        for (const q of questions) {
          const hit = await answerCache.get(q, platform);
          if (hit) {
            allAnswers.set(String(q.id), hit);
            cachedCount++;
          } else {
            toAsk.push(q);
          }
        }
        if (cachedCount > 0) {
          setStatus(`缓存命中 ${cachedCount} 题，剩余 ${toAsk.length} 题请求 AI...`);
        }
        needAsk = toAsk;
      }

      // 3) 共享题库预检：命中后直接使用答案，省 LLM token
      let sharedHits = 0;
      if (sharedBankEnabled(config) && needAsk.length > 0) {
        setStatus(`共享题库预检 ${needAsk.length} 题...`);
        try {
          // 先尝试重试上传队列（断网恢复后优先补传，避免答案丢失）
          try {
            await NS.sharedBank.flushQueue();
          } catch (e) {
            console.warn('[AutoQuiz] 共享题库上传队列重试失败（不影响答题）：', e);
          }
          const r = await NS.sharedBank.searchQuestions(needAsk);
          if (r && r.hits) {
            const sbCfg = config.sharedBank || {};
            const minVotes = Number(sbCfg.minVotes) >= 0 ? Number(sbCfg.minVotes) : 2;
            const remaining = [];
            for (const q of needAsk) {
              const hash = NS.sharedBank.hashQuestion(q, platform);
              const hit = r.hits[hash];
              // 命中条件：official 无条件采用；非 official 需达到最低票数（防单次错误答案污染）
              const pass =
                hit &&
                hit.answer !== undefined &&
                hit.answer !== null &&
                hit.answer !== '' &&
                (hit.official === true || Number(hit.votes) >= minVotes);
              if (pass) {
                allAnswers.set(String(q.id), { answer: hit.answer, source: 'shared_bank' });
                sharedHits++;
              } else {
                remaining.push(q);
              }
            }
            needAsk = remaining;
            if (sharedHits > 0) {
              setStatus(`共享题库命中 ${sharedHits} 题，剩余 ${needAsk.length} 题请求 AI...`);
            }
          }
        } catch (err) {
          console.warn('[AutoQuiz] 共享题库预检失败（降级 LLM）：', err);
        }
      }

      // 4) 分批请求答案（background 内完成 LLM + 题库接口兜底）
      if (needAsk.length > 0) {
        for (let offset = 0; offset < needAsk.length; offset += batchSize) {
          const batch = needAsk.slice(offset, offset + batchSize);
          setStatus(`AI 请求中...（${offset + 1}-${Math.min(offset + batchSize, needAsk.length)}/${needAsk.length}）`);
          const resp = await sendGetAnswers(batch);
          if (!resp || !resp.ok) {
            setStatus(`AI 请求失败：${(resp && resp.error) || '未知错误'}`);
            state.running = false;
            btnStart.disabled = false;
            return;
          }
          if (Array.isArray(resp.answers)) {
            resp.answers.forEach((a) => {
              if (a && a.id !== undefined) {
                allAnswers.set(String(a.id), { answer: a.answer, source: a.source || 'llm' });
              }
            });
          }
        }
      }

      // 5) 写入答案缓存（命中且非 null 的答案）
      if (config.cacheEnabled !== false && answerCache) {
        for (const q of questions) {
          const item = allAnswers.get(String(q.id));
          if (item && item.answer !== undefined && item.answer !== null && item.source !== 'cache') {
            await answerCache.set(q, item.answer, platform);
          }
        }
      }

      // 6) 上传 LLM/题库答案到共享题库（源：llm / user），失败自动入队重试
      const sbCfg6 = config.sharedBank || {};
      if (sharedBankEnabled(config) && sbCfg6.uploadOnAnswer !== false) {
        const uploadItems = [];
        for (const q of questions) {
          const item = allAnswers.get(String(q.id));
          if (!item || item.answer === undefined || item.answer === null) continue;
          if (item.source === 'cache' || item.source === 'shared_bank') continue;
          const hash = NS.sharedBank.hashQuestion(q, platform);
          uploadItems.push({
            hash,
            answer: Array.isArray(item.answer) ? item.answer.join(',') : String(item.answer),
            source: 'llm',
            content: String(q.content || ''),
            type: String(q.type || ''),
            options: Array.isArray(q.options) ? q.options : undefined,
          });
        }
        if (uploadItems.length > 0) {
          NS.sharedBank
            .uploadItems(uploadItems)
            .then((r) => {
              if (r.uploaded > 0) console.info(`[AutoQuiz] 共享题库上传成功 ${r.uploaded} 条`);
              if (r.queued > 0) console.info(`[AutoQuiz] 共享题库上传失败已入队 ${r.queued} 条（待重试）`);
            })
            .catch((e) => console.warn('[AutoQuiz] 共享题库上传异常：', e));
        }
      }

      // 7) 只读回顾页（如雨课堂成绩/结果页）：不自动填写，展示答案面板 + 官方答案回馈
      if (activeAdapter.isReadonly && activeAdapter.isReadonly(root)) {
        // 官方正确答案回馈：解析并上传（source=official，最高权重）
        const sbCfg7 = config.sharedBank || {};
        if (sharedBankEnabled(config) && sbCfg7.uploadOnFeedback !== false && NS.answerFeedback) {
          try {
            const fb = await NS.answerFeedback.sendOfficialFeedback(root);
            if (fb.parsed > 0) {
              console.info(
                `[AutoQuiz] 官方答案回馈：解析 ${fb.parsed} 题，新回馈 ${fb.sent} 题（队列 ${fb.queued}）`,
              );
            }
          } catch (err) {
            console.warn('[AutoQuiz] 官方答案回馈失败：', err);
          }
        }
        const items = questions.map((q) => {
          const item = allAnswers.get(String(q.id)) || { answer: null, source: null };
          const hasAnswer = item.answer !== undefined && item.answer !== null;
          return {
            number: q.number || q.id,
            status: hasAnswer ? 'view' : 'missed',
            answer: hasAnswer ? item.answer : null,
            reason: hasAnswer ? '' : '未获取答案',
            source: sourceLabel(item.source),
          };
        });
        resultPanel.render(items, { title: 'AI 参考答案（回顾页只读）' });
        setStatus(`回顾页只读：已展示 ${allAnswers.size} 题答案（自动填写已跳过）`);
        return;
      }

      // 8) 自动填写（若配置开启）+ 收集结果面板数据
      const results = [];
      if (config.autoFill !== false) {
        const speed = filler.speedFromConfig(config);
        for (const q of questions) {
          const item = allAnswers.get(String(q.id));
          const rawAnswer = item ? item.answer : null;
          const base = { number: q.number || q.id, source: sourceLabel(item ? item.source : null) };

          if (rawAnswer === undefined || rawAnswer === null) {
            state.failed++;
            results.push({ ...base, status: 'skipped', answer: null, reason: '跳过（无答案）' });
            continue;
          }

          // 答案规范化：判断题词表归一化 / 单选越界校验 / 多选去重排序 / 填空多空拆分
          const norm = resolver.normalizeAnswer(q, rawAnswer, config);
          if (!norm.ok) {
            state.failed++;
            results.push({ ...base, status: 'missed', answer: rawAnswer, reason: norm.reason || '答案无法识别' });
            continue;
          }

          try {
            const ok = await activeAdapter.fill(root, q, norm.value, speed);
            if (ok) {
              state.done++;
              results.push({ ...base, status: 'filled', answer: norm.value, reason: norm.reason || '' });
            } else {
              state.failed++;
              results.push({ ...base, status: 'error', answer: norm.value, reason: '填写器未命中页面元素' });
            }
          } catch (err) {
            console.warn('[AutoQuiz] 填写失败：', q.id, err);
            state.failed++;
            results.push({ ...base, status: 'error', answer: norm.value, reason: err && err.message ? err.message : String(err) });
          }
        }
        setStatus(`已完成 ${state.done} 题（失败 ${state.failed}）`);
      } else {
        // 自动填写关闭：仅展示答案面板
        for (const q of questions) {
          const item = allAnswers.get(String(q.id));
          const hasAnswer = item && item.answer !== undefined && item.answer !== null;
          results.push({
            number: q.number || q.id,
            status: hasAnswer ? 'view' : 'skipped',
            answer: hasAnswer ? item.answer : null,
            reason: hasAnswer ? '自动填写已关闭' : '跳过（无答案）',
            source: sourceLabel(item ? item.source : null),
          });
        }
        setStatus(`AI 已返回 ${allAnswers.size} 题答案（自动填写已关闭，请手动填写）`);
      }

      // 9) 答题结果面板（题号/状态/答案或原因，可关闭）
      if (resultPanel && results.length > 0) {
        resultPanel.render(results, { title: '答题结果' });
      }
    } catch (err) {
      console.error('[AutoQuiz] 答题流程异常：', err);
      setStatus(`发生异常：${err && err.message ? err.message : err}`);
    } finally {
      state.running = false;
      btnStart.disabled = false;
    }
  }

  /** 读取配置（questionBank / sharedBank 嵌套对象深合并默认值） */
  async function getConfig() {
    try {
      const defaults = (NS.llm && NS.llm.DEFAULT_CONFIG) || {};
      const stored = await chrome.storage.sync.get(defaults);
      const merged = { ...defaults, ...stored };
      if (defaults.questionBank && stored.questionBank && typeof stored.questionBank === 'object') {
        merged.questionBank = { ...defaults.questionBank, ...stored.questionBank };
      }
      const sbDefaults = { enabled: false, baseUrl: '', token: '', minVotes: 2, officialFirst: true, uploadOnAnswer: true, uploadOnFeedback: true, timeout: 10 };
      if (stored.sharedBank && typeof stored.sharedBank === 'object') {
        merged.sharedBank = { ...sbDefaults, ...stored.sharedBank };
      } else if (defaults.sharedBank && typeof defaults.sharedBank === 'object') {
        merged.sharedBank = { ...sbDefaults, ...defaults.sharedBank };
      } else {
        merged.sharedBank = { ...sbDefaults };
      }
      return merged;
    } catch {
      return {
        batchSize: 10,
        autoFill: true,
        speedLevel: 'normal',
        blankSeparator: ',',
        cacheEnabled: true,
        questionBank: {},
        sharedBank: { enabled: false, baseUrl: '', token: '', minVotes: 2, uploadOnAnswer: true, uploadOnFeedback: true },
      };
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
