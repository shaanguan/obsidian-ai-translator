# AI Translator

一个 Obsidian 翻译插件，支持 Google AI Studio / Gemini API 和 OpenAI 兼容 API。

## 功能

- 支持将选中内容翻译到新笔记，不覆盖原文。
- 支持将当前笔记全文翻译到新笔记，不覆盖原文。
- 支持编辑器右键菜单翻译选中内容或当前笔记到新笔记。
- 支持左侧 Ribbon 按钮一键翻译当前笔记到新笔记。
- 翻译期间会显示正在翻译提示，并让 Ribbon 图标进入 loading 状态。
- 默认开启流式输出，会先创建新笔记，再边翻译边写入内容。
- 默认目标语言为中文；源语言和目标语言都支持下拉选择，并提供自动判断。
- 默认按官方 API ID `gemini-3-flash-preview`、`gemini-3.1-pro-preview`、`gemini-3.1-flash-lite` 的顺序尝试；额度、限流、模型不可用或服务不可用时会降级到下一个模型。
- 支持 OpenAI 兼容 API，可配置 Base URL、API Key，并手动填写模型名称。
- 支持让模型自动判断源语言。
- 翻译前会保护 Markdown 中不应被翻译的内容，包括 frontmatter、代码块、行内代码、Markdown 链接、图片、Obsidian wikilink、URL、HTML、数学公式、标签、脚注标记和引用块。
- 已预留翻译服务 Provider 字段，后续可扩展到其他模型服务。

## 使用

1. 运行 `npm install`。
2. 运行 `npm run build`。
3. 将 `manifest.json`、`main.js`、`styles.css` 复制到 Obsidian vault 的 `.obsidian/plugins/ai-translator/` 目录。
4. 在 Obsidian 中启用插件，并在插件设置里选择翻译服务、填写对应 API Key。
5. 使用命令面板、编辑器右键菜单或左侧 Ribbon 按钮执行翻译。

## 开发

- `npm run dev`：监听构建。
- `npm run build`：类型检查并生产构建。
