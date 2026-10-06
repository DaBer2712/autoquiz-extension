/**
 * server.js — AutoQuiz 共享题库服务端（单文件、零 npm 依赖）
 *
 * 运行环境：Node.js >= 22.13（内置 node:sqlite，免 flag）
 * 启动方式：node server.js
 *
 * 功能：
 *  - POST /api/search  批量查题（单请求上限 100 题）
 *  - POST /api/upload  批量上传题目+答案（单请求上限 200 条；source 仅 llm|user|official）
 *  - GET  /api/stats   总览统计
 *  - GET  /health      健康检查（不鉴权）
 *
 * 鉴权：/api/* 校验 X-AutoQuiz-Token 请求头或 ?token= 查询参数，与 SHARED_TOKEN 一致才放行。
 * CORS：全部响应带允许跨域头，OPTIONS 预检直接 204。
 *
 * 配置：同目录 config.json（可选）或环境变量：
 *  - PORT          监听端口（默认 3000）
 *  - SHARED_TOKEN  共享 Token（必填；缺失则随机生成并打印到启动日志）
 *  - DB_PATH       数据库路径（可选，默认同目录 data.db）
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ------------------------------ 配置加载 ------------------------------ */

function loadConfig() {
  const cfg = { port: 3000, token: '', dbPath: '' };
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (parsed.port) cfg.port = parsed.port;
        if (parsed.token) cfg.token = String(parsed.token);
        if (parsed.dbPath) cfg.dbPath = parsed.dbPath;
      }
    } catch (err) {
      console.error('[shared-bank] config.json 解析失败，忽略并使用默认配置：', err.message);
    }
  }
  if (process.env.PORT) cfg.port = Number(process.env.PORT) || 3000;
  if (process.env.SHARED_TOKEN) cfg.token = String(process.env.SHARED_TOKEN);
  if (process.env.DB_PATH) cfg.dbPath = process.env.DB_PATH;

  if (!cfg.token) {
    cfg.token = crypto.randomBytes(16).toString('hex');
    console.warn('[shared-bank] 未配置 SHARED_TOKEN，已随机生成：' + cfg.token);
  }
  if (!cfg.dbPath) cfg.dbPath = path.join(__dirname, 'data.db');
  return cfg;
}

const CONFIG = loadConfig();

/* ------------------------------ 数据库 ------------------------------ */

const db = new DatabaseSync(CONFIG.dbPath);
db.exec(`
CREATE TABLE IF NOT EXISTS questions (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT DEFAULT '',
  options_json TEXT DEFAULT '',
  first_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS answers (
  hash TEXT NOT NULL,
  answer TEXT NOT NULL,
  source TEXT NOT NULL,
  votes INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (hash, answer, source)
);
CREATE INDEX IF NOT EXISTS idx_answers_hash ON answers(hash);
`);

const stmtInsertQuestion = db.prepare(
  'INSERT INTO questions (hash, content, type, options_json, first_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING',
);
const stmtUpsertAnswer = db.prepare(
  'INSERT INTO answers (hash, answer, source, votes, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(hash, answer, source) DO UPDATE SET votes = votes + 1, updated_at = excluded.updated_at',
);
const stmtTopAnswer = db.prepare(
  `SELECT answer, source, votes FROM answers WHERE hash = ?
   ORDER BY CASE WHEN source = 'official' THEN 0 ELSE 1 END, votes DESC LIMIT 1`,
);
const stmtCountQuestions = db.prepare('SELECT COUNT(*) AS n FROM questions');
const stmtCountAnswers = db.prepare('SELECT COUNT(*) AS n FROM answers');

/* 运行期累计统计（内存计数，重启归零） */
let uploadTotal = 0;
let hitTotal = 0;

/* ------------------------------ 工具函数 ------------------------------ */

/** 安全 token 比较（常数时间） */
function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 提取请求提供的 token：优先 X-AutoQuiz-Token 头，其次 ?token= */
function extractToken(req, url) {
  const fromHeader = req.headers['x-autoquiz-token'];
  if (fromHeader) return fromHeader;
  return url.searchParams.get('token') || '';
}

/** 读取并解析 JSON body（限制 5MB） */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

/** 写 JSON 响应（带 CORS 头） */
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-AutoQuiz-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 规范化 options 数组为可存储字符串 */
function serializeOptions(options) {
  if (!Array.isArray(options)) return '';
  try {
    return JSON.stringify(options.map((o) => ({ label: o && o.label, text: o && o.text })));
  } catch {
    return '';
  }
}

/** 规范化 source：仅接受 llm|user|official，非法回退 llm */
function normalizeSource(source) {
  return source === 'user' || source === 'official' ? source : 'llm';
}

/* ------------------------------ API 处理 ------------------------------ */

/** POST /api/search */
function handleSearch(payload) {
  const questions = Array.isArray(payload && payload.questions) ? payload.questions : [];
  if (questions.length > 100) {
    return { status: 400, body: { error: 'too many questions (max 100)' } };
  }
  const now = Date.now();
  const results = {};
  let localHits = 0;

  for (const q of questions) {
    const hash = q && typeof q.hash === 'string' && q.hash ? q.hash : '';
    if (!hash) continue;
    const content = q && typeof q.content === 'string' ? q.content : '';
    const type = q && typeof q.type === 'string' ? q.type : '';
    const optionsJson = serializeOptions(q && q.options);

    stmtInsertQuestion.run(hash, content || hash, type, optionsJson, now);

    const top = stmtTopAnswer.get(hash);
    if (top) {
      results[hash] = {
        answer: top.answer,
        source: top.source,
        votes: top.votes,
        official: top.source === 'official',
      };
      localHits++;
    } else {
      results[hash] = null;
    }
  }

  hitTotal += localHits;
  return { status: 200, body: { results } };
}

/** POST /api/upload */
function handleUpload(payload) {
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  if (items.length > 200) {
    return { status: 400, body: { error: 'too many items (max 200)' } };
  }
  const now = Date.now();
  let accepted = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const hash = item.hash && typeof item.hash === 'string' ? item.hash : '';
    if (!hash) continue;
    const answer = item.answer === undefined || item.answer === null ? '' : String(item.answer).trim();
    if (answer === '') continue;
    const source = normalizeSource(item.source);

    const content = item.content && typeof item.content === 'string' ? item.content : '';
    const type = item.type && typeof item.type === 'string' ? item.type : '';
    const optionsJson = serializeOptions(item.options);

    // content 为空时只更新 answers 表，不覆盖原题 content
    if (content || optionsJson) {
      stmtInsertQuestion.run(hash, content || hash, type, optionsJson, now);
    } else {
      // 确保 questions 表存在该 hash（无内容时用 hash 占位，避免外键/关联缺失）
      stmtInsertQuestion.run(hash, hash, '', '', now);
    }

    stmtUpsertAnswer.run(hash, answer, source, now);
    accepted++;
  }

  uploadTotal += accepted;
  return { status: 200, body: { ok: true, accepted } };
}

/** GET /api/stats */
function handleStats() {
  const qCount = stmtCountQuestions.get().n;
  const aCount = stmtCountAnswers.get().n;
  return {
    status: 200,
    body: {
      total_questions: qCount,
      total_answers: aCount,
      upload_total: uploadTotal,
      hit_total: hitTotal,
    },
  };
}

/* ------------------------------ 路由与鉴权 ------------------------------ */

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-AutoQuiz-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  // 健康检查：不鉴权
  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true, uptime: process.uptime() });
    return;
  }

  // /api/* 统一鉴权
  if (url.pathname.startsWith('/api/')) {
    const provided = extractToken(req, url);
    if (!tokenMatches(provided, CONFIG.token)) {
      sendJson(res, 401, { error: 'invalid token' });
      return;
    }
  }

  // 路由分发
  if (url.pathname === '/api/search' && req.method === 'POST') {
    readJsonBody(req)
      .then((payload) => {
        const result = handleSearch(payload);
        sendJson(res, result.status, result.body);
      })
      .catch((err) => {
        sendJson(res, 400, { error: err.message || 'bad request' });
      });
    return;
  }

  if (url.pathname === '/api/upload' && req.method === 'POST') {
    readJsonBody(req)
      .then((payload) => {
        const result = handleUpload(payload);
        sendJson(res, result.status, result.body);
      })
      .catch((err) => {
        sendJson(res, 400, { error: err.message || 'bad request' });
      });
    return;
  }

  if (url.pathname === '/api/stats' && req.method === 'GET') {
    const result = handleStats();
    sendJson(res, result.status, result.body);
    return;
  }

  // 未匹配路由
  sendJson(res, 404, { error: 'not found' });
});

/* 未处理异常统一返回 500 JSON */
server.on('error', (err) => {
  console.error('[shared-bank] 服务错误：', err);
});

/* ------------------------------ 启动 ------------------------------ */

server.listen(CONFIG.port, () => {
  const maskedToken = CONFIG.token.length > 4 ? CONFIG.token.slice(0, 4) + '****' : '****';
  console.log('[shared-bank] AutoQuiz 共享题库服务已启动');
  console.log('[shared-bank] 监听端口：' + CONFIG.port);
  console.log('[shared-bank] 共享 Token（掩码）：' + maskedToken);
  console.log('[shared-bank] 数据库文件：' + CONFIG.dbPath);
  console.log('[shared-bank] 健康检查：http://127.0.0.1:' + CONFIG.port + '/health');
});
