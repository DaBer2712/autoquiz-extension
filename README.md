# AutoQuiz 智能答题助手

自动抓取超星学习通 / 雨课堂考试作业题目，调用 DeepSeek 等大模型智能作答并自动填写。

> 免责声明：本项目仅供学习浏览器扩展开发（Manifest V3）、内容脚本注入与 LLM API 集成技术参考。请勿在真实考试或作业中使用，由此产生的后果由使用者自行承担。

## 功能

- 超星学习通（chaoxing.com）考试 / 作业页自动答题
- 雨课堂（yuketang.cn / examination.xuetangx.com）考试页自动答题
- 雨课堂成绩回顾页（只读）识别：自动跳过填写，改为展示 AI 参考答案
- DeepSeek 接入（OpenAI 兼容），支持超时、JSON 容错与速度档位
- 页面悬浮条一键开始，实时进度反馈
- 原生 JavaScript、零构建、Manifest V3

## 安装

1. 下载本仓库并解压（或直接下载 `autoquiz-extension.zip` 后解压）
2. 打开浏览器扩展管理页：Chrome 为 `chrome://extensions`，Edge 为 `edge://extensions`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择 `autoquiz-extension` 目录
5. 点击浏览器工具栏的 AutoQuiz 图标，在设置页填入 DeepSeek API Key（在 [platform.deepseek.com](https://platform.deepseek.com/) 申请），保存

## 使用

进入学习通 / 雨课堂的考试或作业页面，点击页面右上角悬浮条「开始AI答题」，插件自动抓题 → 调大模型 → 自动填写，悬浮条显示完成进度。

雨课堂成绩回顾页（只读）会直接弹出 AI 参考答案面板，不会尝试自动填写。

## 配置项

| 配置 | 说明 |
|---|---|
| API Key | DeepSeek API Key，仅保存在浏览器本地（chrome.storage.sync） |
| 批量大小 | 每批发送给大模型的题目数 |
| 速度档位 | 填写点击间隔，越低越快、越容易被检测 |
| 自动填写 | 关闭后仅获取答案，不自动点击 |

## 项目结构

```
autoquiz-extension/
├── manifest.json          # Manifest V3 配置
├── content.js             # 内容脚本：悬浮条 + 答题主流程
├── background.js          # Service Worker：调用 LLM API
├── options.html/js        # 设置页
├── popup.html/js          # 插件弹窗
├── lib/
│   ├── llm.js             # DeepSeek/OpenAI 兼容调用封装
│   ├── extractor.js       # 学习通通用题目提取
│   ├── filler.js          # 学习通通用答案填写
│   ├── types.js           # 题型定义
│   └── adapters/
│       ├── index.js       # 适配器注册表
│       ├── chaoxing.js    # 学习通适配器
│       └── rain-classroom.js # 雨课堂适配器
└── icons/
```

## 技术栈

- Chrome / Edge 扩展（Manifest V3）
- 原生 JavaScript，零构建、零运行时依赖
- 适配器模式：新增平台只需实现 `detect / extract / fill / submit` 并注册

## License

MIT
