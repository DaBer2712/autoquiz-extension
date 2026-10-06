/**
 * lib/adapters/index.js
 * 适配器注册表（registry）：管理所有页面适配器，后续新增平台只需注册新适配器。
 *
 * 依赖：lib/adapters/chaoxing.js、lib/adapters/rain-classroom.js（均先于本文件加载）
 * 导出：AUTOQUIZ.adapters.registry
 */
(function (global) {
  'use strict';

  const NS = (global.AUTOQUIZ = global.AUTOQUIZ || {});
  const adapters = (NS.adapters = NS.adapters || {});

  /** 已注册的适配器列表（按注册顺序，检测时逐个尝试） */
  const registry = [];

  /**
   * 注册一个适配器。重复 id 时跳过并告警。
   * @param {object} adapter 符合 chaoxing.js 中注释的接口约定
   */
  function register(adapter) {
    if (!adapter || typeof adapter.id !== 'string' || typeof adapter.detect !== 'function') {
      console.warn('[AutoQuiz] 适配器格式不合法，已跳过', adapter);
      return;
    }
    if (registry.some((a) => a.id === adapter.id)) {
      console.warn('[AutoQuiz] 适配器 id 重复，已跳过：', adapter.id);
      return;
    }
    registry.push(adapter);
  }

  /** 按 id 获取适配器 */
  function get(id) {
    return registry.find((a) => a.id === id) ?? null;
  }

  /** 返回全部适配器（只读副本） */
  function getAll() {
    return registry.slice();
  }

  /**
   * 探测当前页面命中的第一个适配器。
   * @param {Document|object} root 页面根（Document 或 {document, win} 包装）
   * @returns {object|null} 适配器或 null
   */
  function detect(root) {
    for (const adapter of registry) {
      try {
        if (adapter.detect(root)) return adapter;
      } catch (err) {
        console.warn(`[AutoQuiz] 适配器 ${adapter.id} detect 异常：`, err);
      }
    }
    return null;
  }

  // 注册已实现的适配器：超星学习通 / 雨课堂（含考试系统成绩回顾页）
  if (adapters.chaoxing) {
    register(adapters.chaoxing);
  }
  if (adapters.rainClassroom) {
    register(adapters.rainClassroom);
  }

  NS.adapters.registry = registry;
  NS.adapters.registerAdapter = register;
  NS.adapters.getAdapter = get;
  NS.adapters.getAllAdapters = getAll;
  NS.adapters.detectAdapter = detect;
})(typeof globalThis !== 'undefined' ? globalThis : window);
