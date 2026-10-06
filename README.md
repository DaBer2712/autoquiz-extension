# AutoQuiz 智能答题助手

自动抓取超星学习通 / 雨课堂考试作业题目，调用 DeepSeek 等大模型智能作答并自动填写；支持多用户共享云端题库，答题命中共享答案时不再调用 LLM API（省 token），并在回顾页自动回馈官方正确答案。

> 免责声明：本项目仅供学习浏览器扩展开发（Manifest V3）、内容脚本注入与 LLM API 集成技术参考。请勿在真实考试或作业中使用，由此产生的后果由使用者自行承担。

## 功能

- 超星学习通（chaoxing.com）考试 / 作业页自动答题
- 雨课堂（yuketang.cn / examination.xuetangx.com）考试页自动答题
- 雨课堂成绩回顾页（只读）识别：自动跳过填写，改为展示 AI 参考答案
- 共享云端题库（多用户）：答题前命中其他用户上传的题目直接使用答案（省 LLM token），答题后自动上传 LLM 答案，回顾页读取官方正确答案回馈（最高权重）
- DeepSeek 接入（OpenAI 兼容），支持超时、JSON 容错与速度档位
- 本地答案缓存 + 共享题库预检 + LLM 三级取答链路
- 页面悬浮条一键开始，实时进度反馈
- 原生 JavaScript、零构建、Manifest V3

## 安装

1. 下载本仓库并解压（或直接下载 `autoquiz-extension.zip` 后解压）
2. 打开浏览器扩展管理页：Chrome 为 `chrome://extensions`，Edge 为 `edge://extensions`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择 `autoquiz-extension` 目录
5. 点击浏览器工具栏的 AutoQuiz 图标，在设置页填入 DeepSeek API Key（在 [platform.deepseek.com](https://platform.deepseek.com/) 申请），保存

## 使用流程

### 一、首次配置

1. **DeepSeek Key**：设置页填入 API Key、模型、API 地址，保存。
2. **共享题库（可选）**：
   - 先部署服务端（见下节「共享云端题库」）；
   - 在设置页「共享题库」卡片填入服务端地址（如 `http://127.0.0.1:3000`）与 Token；
   - 按需调整「最低票数」「答题后上传」「回馈页上传」开关；
   - 点击「测试连接」，显示正常后保存。

### 二、日常答题

进入学习通 / 雨课堂的考试或作业页面，点击页面右上角悬浮条「开始AI答题」，插件按以下链路取答：

1. **本地缓存**：对每道题先查本地答案缓存（`chrome.storage.local`），命中直接填写；
2. **共享题库预检**：未缓存题目若已启用共享题库，批量查询服务端 `/api/search`：
   - 命中且满足采信条件则直接使用（来源显示「共享题库」），**不调用 LLM API**；
   - 采信条件：`official` 官方答案无条件优先；非官方答案需 `votes >= 最低票数`（默认 2）；
3. **LLM 取答**：本地缓存与共享题库均未命中时，批量调用 DeepSeek 生成答案；
4. **自动填写**：解析并规范化答案后自动填写（单选越界降级 / 多选去重排序 / 判断题词表归一 / 填空多空拆分）；
5. **答案上传**：答题完成后，LLM / 兜底题库给出的答案自动上传共享题库（`source=llm`）；上传失败自动进入本地重试队列（上限 500 条，下次答题前自动冲刷）；
6. **官方答案回馈**：在雨课堂成绩回顾页（只读）打开时，插件自动解析页面中的官方正确答案并上传（`source=official`，最高权重）；同一题目同一答案只回馈一次（幂等，`feedbackSent` 记录）。

悬浮条显示完成进度；回顾页仅弹出 AI 参考答案面板，不会尝试自动填写。

## 配置项

| 配置 | 说明 | 默认值 |
|---|---|---|
| API Key | DeepSeek API Key，仅保存在浏览器本地（chrome.storage.sync） | 空 |
| 模型 / API 地址 | OpenAI 兼容接口参数 | deepseek-chat |
| 批量大小 | 每批发送给大模型的题目数 | 10 |
| 速度档位 | 填写点击间隔，越低越快、越容易被检测 | 中 |
| 自动填写 | 关闭后仅获取答案，不自动点击 | 开 |
| 共享题库开关 | 启用后答题前先查共享云端题库，命中免 LLM；答题后自动上传答案 | 关 |
| 共享题库地址 | 自托管服务端地址（如 `http://127.0.0.1:3000`），需先运行 server.js | 空 |
| 共享 Token | 与服务端 config.json / 环境变量 `SHARED_TOKEN` 保持一致 | 空 |
| 最低票数 | 非官方答案被采信所需的最低 `votes`（官方答案不受此限） | 2 |
| 官方优先 | 服务端排序规则：official 答案无条件排最前 | 开 |
| 答题后上传 | 答题完成自动上传 LLM 答案到共享题库（source=llm） | 开 |
| 回馈页上传 | 成绩回顾页自动解析并上传官方答案（source=official） | 开 |
| 请求超时 | 共享题库接口请求超时（秒） | 10 |

## 共享云端题库（自托管服务端）

共享题库允许**多用户协同**：A 用户答过的题会上传，B 用户遇到相同题目时直接命中共享答案，不再调用 LLM API（省 token）。官方答案回馈优先级最高。

### 部署服务端

服务端为零依赖 Node.js 单文件（`node:http` + 内置 `node:sqlite`），要求 **Node.js >= 22.13**：

```bash
node server.js                      # 默认 127.0.0.1:3000，Token 打印在启动日志
# 或自定义端口 / Token：
PORT=8080 SHARED_TOKEN=mys3cret node server.js
# 或同目录放 config.json：
# { "port": 3000, "token": "your_token", "dbPath": "C:/data/shared-bank.db" }
```

### 启用共享题库

1. 运行服务端，记录启动日志打印的监听地址与 Token（未配置则随机生成并打印）；
2. 在插件设置页「共享题库」卡片中填入服务端地址与 Token，勾选启用，点击「测试连接」；
3. 确认设置页显示连接正常、统计可见。

### 多用户共享机制

- **同一服务端、全员共享**：所有用户连接同一服务端即共享同一题库（SQLite 单库）；
- **共识采信**：同一 `hash + answer + source` 被重复上传时 `votes` 累加；非官方答案需达到「最低票数」（默认 2）才被插件采信，防止单人错答污染题库；
- **官方答案最高权重**：回顾页回馈的 `official` 答案在服务端排序中无条件优先，且不受最低票数限制，直接采信；
- **断网自动重试**：上传失败（网络中断 / 服务端不可用）自动进入本地队列（`sharedQueue`，上限 500 条，超出丢弃最旧），下次答题或手动「冲刷队列」时重试；
- **幂等回馈**：官方答案回馈记录在 `feedbackSent`，同一题目同一答案不会重复上传。

### 使用流程

- 答题前：自动对未缓存题目做共享题库预检，命中则直接使用（来源显示「共享题库」）；
- 答题后：LLM / 题库兜底答案自动上传（source=llm），失败自动进入上传队列；
- 回顾页：在雨课堂成绩回顾页等只读页打开时，自动解析官方正确答案并上传（source=official，权重最高），同一套卷子重复回顾不会重复上传。

服务端部署与 API 详见 `autoquiz-shared-bank-server/README-server.md`。

## 项目结构

```
autoquiz-extension/
├── manifest.json          # Manifest V3 配置
├── content.js             # 内容脚本：悬浮条 + 答题主流程
├── background.js          # Service Worker：调用 LLM API + 共享题库代理
├── options.html/js        # 设置页
├── popup.html/js          # 插件弹窗
├── server.js              # 共享题库服务端（自托管，零依赖 Node.js）
├── README-server.md       # 服务端部署与 API 文档
├── lib/
│   ├── llm.js             # DeepSeek/OpenAI 兼容调用封装
│   ├── extractor.js       # 学习通通用题目提取
│   ├── filler.js          # 学习通通用答案填写
│   ├── resolver.js        # 答案规范化（判断题/单选越界/多选排序/填空拆分）
│   ├── cache.js           # 本地题目答案缓存
│   ├── shared-bank.js     # 共享云端题库：查题/上传/队列/测试连接
│   ├── answer-feedback.js # 回顾页官方答案回馈解析与上传
│   ├── types.js           # 题型定义
│   └── adapters/
│       ├── index.js       # 适配器注册表
│       ├── chaoxing.js    # 学习通适配器
│       └── rain-classroom.js # 雨课堂适配器
└── icons/
```

> 共享题库服务端（自托管）独立部署：`autoquiz-shared-bank-server/server.js`（零依赖 Node.js 单文件，含 SQLite 存储与 Token 鉴权）。

## 技术栈

- Chrome / Edge 扩展（Manifest V3）
- 原生 JavaScript，零构建、零运行时依赖
- 共享题库服务端：Node.js 内置模块（node:http / node:sqlite），零 npm 依赖
- 适配器模式：新增平台只需实现 `detect / extract / fill / submit` 并注册

## License

MIT
