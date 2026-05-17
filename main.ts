import {
  App,
  Editor,
  MarkdownView,
  normalizePath,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFile
} from "obsidian";

type ProviderId = "google-ai-studio" | "openai-compatible";

interface TranslatorSettings {
  provider: ProviderId;
  apiKey: string;
  model: string;
  fallbackModels: string;
  openAiApiKey: string;
  openAiBaseUrl: string;
  openAiModel: string;
  openAiFallbackModels: string;
  sourceLanguage: string;
  targetLanguage: string;
  autoDetectSource: boolean;
  preserveBlockquotes: boolean;
  streamOutput: boolean;
}

interface ProtectedMarkdown {
  text: string;
  tokens: Record<string, string>;
}

interface GeminiResponsePart {
  text?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiResponsePart[];
    };
  }>;
  error?: {
    message?: string;
  };
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    delta?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

const PRIMARY_MODEL = "gemini-3-flash-preview";
const LEGACY_DEFAULT_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3.1-flash",
  "gemini-3.1-pro",
  "gemini-3-flash-lite"
];
const DEFAULT_FALLBACK_MODELS = ["gemini-3.1-pro-preview", "gemini-3.1-flash-lite"];
const GOOGLE_MODEL_OPTIONS = [PRIMARY_MODEL, ...DEFAULT_FALLBACK_MODELS];
const AUTO_LANGUAGE = "自动判断";
const LANGUAGE_OPTIONS = [AUTO_LANGUAGE, "中文", "English", "Español", "हिन्दी", "العربية"];
const MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-flash": "gemini-3-flash-preview",
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "gemini-3-flash-lite": "gemini-3.1-flash-lite"
};

const DEFAULT_SETTINGS: TranslatorSettings = {
  provider: "google-ai-studio",
  apiKey: "",
  model: PRIMARY_MODEL,
  fallbackModels: DEFAULT_FALLBACK_MODELS.join("\n"),
  openAiApiKey: "",
  openAiBaseUrl: "https://api.openai.com/v1",
  openAiModel: "gpt-4o-mini",
  openAiFallbackModels: "",
  sourceLanguage: AUTO_LANGUAGE,
  targetLanguage: "中文",
  autoDetectSource: true,
  preserveBlockquotes: true,
  streamOutput: true
};

const TOKEN_PREFIX = "@@AI_TRANSLATOR_TOKEN_";

export default class AiTranslatorPlugin extends Plugin {
  settings: TranslatorSettings = { ...DEFAULT_SETTINGS };
  private isTranslating = false;
  private loadingNotice: Notice | null = null;
  private ribbonIconEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();

    this.ribbonIconEl = this.addRibbonIcon("languages", "Translate current note to new note", async () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) {
        new Notice("请先打开一篇 Markdown 笔记。");
        return;
      }

      await this.translateWholeNote(view.editor);
    });

    this.addCommand({
      id: "translate-selection",
      name: "Translate selection to new note",
      editorCallback: async (editor: Editor) => {
        await this.translateSelection(editor);
      }
    });

    this.addCommand({
      id: "translate-current-note",
      name: "Translate current note to new note",
      editorCallback: async (editor: Editor) => {
        await this.translateWholeNote(editor);
      }
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const hasSelection = Boolean(editor.getSelection().trim());

        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle("Translate selection to new note")
            .setIcon("languages")
            .setDisabled(!hasSelection)
            .onClick(async () => {
              await this.translateSelection(editor);
            })
        );

        menu.addItem((item) =>
          item
            .setTitle("Translate current note to new note")
            .setIcon("file-text")
            .onClick(async () => {
              await this.translateWholeNote(editor);
            })
        );
      })
    );

    this.addSettingTab(new AiTranslatorSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.model = MODEL_ALIASES[this.settings.model] ?? this.settings.model;
    this.settings.fallbackModels = this.settings.fallbackModels
      .split(/\r?\n|,/)
      .map((model) => MODEL_ALIASES[model.trim()] ?? model.trim())
      .filter(Boolean)
      .join("\n");
    if (LEGACY_DEFAULT_MODELS.includes(this.settings.model)) {
      this.settings.model = PRIMARY_MODEL;
      this.settings.fallbackModels = DEFAULT_SETTINGS.fallbackModels;
    }
    this.settings.openAiBaseUrl = this.settings.openAiBaseUrl || DEFAULT_SETTINGS.openAiBaseUrl;
    this.settings.openAiModel = this.settings.openAiModel || DEFAULT_SETTINGS.openAiModel;
    this.settings.sourceLanguage = this.settings.sourceLanguage || AUTO_LANGUAGE;
    if (!LANGUAGE_OPTIONS.includes(this.settings.sourceLanguage)) {
      this.settings.sourceLanguage = DEFAULT_SETTINGS.sourceLanguage;
    }
    if (!LANGUAGE_OPTIONS.includes(this.settings.targetLanguage)) {
      this.settings.targetLanguage = DEFAULT_SETTINGS.targetLanguage;
    }
    if (!GOOGLE_MODEL_OPTIONS.includes(this.settings.model)) {
      this.settings.model = DEFAULT_SETTINGS.model;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async translateSelection(editor: Editor) {
    if (!this.startTranslating("正在翻译选中内容...")) {
      return;
    }

    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice("请先选中要翻译的内容。");
      this.finishTranslating();
      return;
    }

    try {
      const file = await this.translateMarkdownToNewNote(selection, "selection");
      if (file) {
        new Notice("选中内容已翻译，并已创建新笔记。");
      }
    } finally {
      this.finishTranslating();
    }
  }

  private async translateWholeNote(editor: Editor) {
    if (!this.startTranslating("正在翻译当前笔记...")) {
      return;
    }

    const note = editor.getValue();
    if (!note.trim()) {
      new Notice("当前笔记没有可翻译内容。");
      this.finishTranslating();
      return;
    }

    try {
      const file = await this.translateMarkdownToNewNote(note, "note");
      if (file) {
        new Notice("当前笔记已翻译，并已创建新笔记。");
      }
    } finally {
      this.finishTranslating();
    }
  }

  private startTranslating(message: string): boolean {
    if (this.isTranslating) {
      new Notice("已有翻译任务正在进行，请稍等。");
      return false;
    }

    this.isTranslating = true;
    this.ribbonIconEl?.addClass("ai-translator-ribbon-loading");
    this.loadingNotice = new Notice(message, 0);
    return true;
  }

  private finishTranslating() {
    this.isTranslating = false;
    this.loadingNotice?.hide();
    this.loadingNotice = null;
    this.ribbonIconEl?.removeClass("ai-translator-ribbon-loading");
  }

  private async createTranslatedNote(content: string, kind: "note" | "selection"): Promise<TFile> {
    const targetPath = this.getUniqueTranslatedPath(kind);
    const file = await this.app.vault.create(targetPath, content);
    await this.app.workspace.getLeaf(true).openFile(file);
    return file;
  }

  private async updateTranslatedNote(file: TFile, content: string) {
    await this.app.vault.modify(file, content);
  }

  private getUniqueTranslatedPath(kind: "note" | "selection"): string {
    const sourceFile = this.app.workspace.getActiveFile();
    const folder = sourceFile ? getFolderPath(sourceFile.path) : "";
    const baseName = sourceFile?.basename ?? "Translated note";
    const language = sanitizeFileNamePart(this.settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage);
    const suffix = kind === "selection" ? ` - selection - ${language}` : ` - ${language}`;
    let index = 0;
    let candidate = "";

    do {
      const counter = index === 0 ? "" : ` ${index + 1}`;
      candidate = normalizePath(`${folder ? `${folder}/` : ""}${baseName}${suffix}${counter}.md`);
      index += 1;
    } while (this.app.vault.getAbstractFileByPath(candidate));

    return candidate;
  }

  private async translateMarkdown(markdown: string): Promise<string | null> {
    const missingCredential = this.getMissingCredentialMessage();
    if (missingCredential) {
      new Notice(missingCredential);
      return null;
    }

    const protectedMarkdown = protectMarkdown(markdown, this.settings.preserveBlockquotes);
    if (!hasTranslatableContent(protectedMarkdown.text)) {
      return markdown;
    }

    try {
      const translated = await this.translateWithProvider(protectedMarkdown.text);
      return restoreProtectedMarkdown(cleanModelOutput(translated), protectedMarkdown.tokens);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`翻译失败：${message}`);
      return null;
    }
  }

  private async translateMarkdownToNewNote(
    markdown: string,
    kind: "note" | "selection"
  ): Promise<TFile | null> {
    const missingCredential = this.getMissingCredentialMessage();
    if (missingCredential) {
      new Notice(missingCredential);
      return null;
    }

    const protectedMarkdown = protectMarkdown(markdown, this.settings.preserveBlockquotes);
    if (!hasTranslatableContent(protectedMarkdown.text)) {
      new Notice("没有检测到需要翻译的正文内容。");
      return null;
    }

    const file = await this.createTranslatedNote("", kind);

    try {
      if (this.settings.streamOutput) {
        const streamed = await this.streamTranslateWithProvider(protectedMarkdown.text, async (partial) => {
          await this.updateTranslatedNote(file, restoreProtectedMarkdown(partial, protectedMarkdown.tokens));
        });
        await this.updateTranslatedNote(
          file,
          restoreProtectedMarkdown(cleanModelOutput(streamed), protectedMarkdown.tokens)
        );
        return file;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`流式翻译不可用，正在改用普通翻译：${message}`, 5000);
    }

    try {
      const translated = await this.translateWithProvider(protectedMarkdown.text);
      await this.updateTranslatedNote(
        file,
        restoreProtectedMarkdown(cleanModelOutput(translated), protectedMarkdown.tokens)
      );
      return file;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.updateTranslatedNote(file, `翻译失败：${message}`);
      new Notice(`翻译失败：${message}`);
      return null;
    }
  }

  private async translateWithProvider(markdown: string): Promise<string> {
    switch (this.settings.provider) {
      case "google-ai-studio":
        return this.translateWithGoogleAiStudio(markdown);
      case "openai-compatible":
        return this.translateWithOpenAiCompatible(markdown);
      default:
        throw new Error("暂不支持当前翻译服务。");
    }
  }

  private async streamTranslateWithProvider(
    markdown: string,
    onPartial: (partial: string) => Promise<void>
  ): Promise<string> {
    switch (this.settings.provider) {
      case "google-ai-studio":
        return this.streamWithGoogleAiStudio(markdown, onPartial);
      case "openai-compatible":
        return this.streamWithOpenAiCompatible(markdown, onPartial);
      default:
        throw new Error("暂不支持当前翻译服务。");
    }
  }

  private getMissingCredentialMessage(): string | null {
    if (this.settings.provider === "google-ai-studio" && !this.settings.apiKey.trim()) {
      return "请先在插件设置中填写 Google AI Studio API Key。";
    }

    if (this.settings.provider === "openai-compatible") {
      if (!this.settings.openAiApiKey.trim()) {
        return "请先在插件设置中填写 OpenAI 兼容 API Key。";
      }
      if (!this.settings.openAiBaseUrl.trim()) {
        return "请先在插件设置中填写 Base URL。";
      }
      if (!this.settings.openAiModel.trim()) {
        return "请先在插件设置中填写 OpenAI 兼容 API 模型名称。";
      }
    }

    return null;
  }

  private async translateWithGoogleAiStudio(markdown: string): Promise<string> {
    const models = getModelCandidates(this.settings);
    let lastError: unknown = null;

    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      try {
        return await this.requestGoogleAiStudioTranslation(markdown, model);
      } catch (error) {
        lastError = error;
        if (index === models.length - 1 || !shouldTryFallback(error)) {
          throw error;
        }

        new Notice(`${model} 当前受限或不可用，正在尝试 ${models[index + 1]}。`);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("所有 Gemini 模型都没有返回翻译结果。");
  }

  private async requestGoogleAiStudioTranslation(markdown: string, modelName: string): Promise<string> {
    const model = encodeURIComponent(modelName);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      this.settings.apiKey.trim()
    )}`;

    const response = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: buildTranslationPrompt(markdown, this.settings)
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          topP: 0.8
        }
      })
    });

    const json = response.json as GeminiResponse;
    if (json.error?.message) {
      throw new Error(`${modelName}: ${json.error.message}`);
    }

    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((part) => part.text ?? "").join("");
    if (!text.trim()) {
      throw new Error(`${modelName}: Google AI Studio 没有返回翻译结果。`);
    }

    return text;
  }

  private async translateWithOpenAiCompatible(markdown: string): Promise<string> {
    const models = getOpenAiModelCandidates(this.settings);
    let lastError: unknown = null;

    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      try {
        return await this.requestOpenAiCompatibleTranslation(markdown, model);
      } catch (error) {
        lastError = error;
        if (index === models.length - 1 || !shouldTryFallback(error)) {
          throw error;
        }

        new Notice(`${model} 当前受限或不可用，正在尝试 ${models[index + 1]}。`);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("OpenAI 兼容 API 模型没有返回翻译结果。");
  }

  private async requestOpenAiCompatibleTranslation(markdown: string, modelName: string): Promise<string> {
    const response = await requestUrl({
      url: buildOpenAiChatCompletionsUrl(this.settings.openAiBaseUrl),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.openAiApiKey.trim()}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          {
            role: "system",
            content: "You are a precise Markdown translation engine."
          },
          {
            role: "user",
            content: buildTranslationPrompt(markdown, this.settings)
          }
        ],
        temperature: 0.1,
        stream: false
      })
    });

    const json = response.json as OpenAiChatResponse;
    if (json.error?.message) {
      throw new Error(`${modelName}: ${json.error.message}`);
    }

    const text = json.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      throw new Error(`${modelName}: OpenAI 兼容 API 没有返回翻译结果。`);
    }

    return text;
  }

  private async streamWithGoogleAiStudio(
    markdown: string,
    onPartial: (partial: string) => Promise<void>
  ): Promise<string> {
    const models = getModelCandidates(this.settings);
    let lastError: unknown = null;

    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      try {
        return await this.requestGoogleAiStudioStream(markdown, model, onPartial);
      } catch (error) {
        lastError = error;
        if (index === models.length - 1 || !shouldTryFallback(error)) {
          throw error;
        }

        new Notice(`${model} 当前受限或不可用，正在尝试 ${models[index + 1]}。`);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("所有 Gemini 模型都没有返回翻译结果。");
  }

  private async requestGoogleAiStudioStream(
    markdown: string,
    modelName: string,
    onPartial: (partial: string) => Promise<void>
  ): Promise<string> {
    if (typeof fetch !== "function") {
      throw new Error("当前 Obsidian 环境不支持流式请求。");
    }

    const model = encodeURIComponent(modelName);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
      this.settings.apiKey.trim()
    )}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: buildTranslationPrompt(markdown, this.settings)
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          topP: 0.8
        }
      })
    });

    if (!response.ok) {
      throw new Error(`${modelName}: ${await response.text()}`);
    }

    if (!response.body) {
      throw new Error("当前 Obsidian 环境不支持流式响应。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    let lastEmit = 0;

    const emit = async (force = false) => {
      if (!force && Date.now() - lastEmit < 350) {
        return;
      }
      lastEmit = Date.now();
      await onPartial(accumulated);
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") {
          continue;
        }

        const json = JSON.parse(data) as GeminiResponse;
        if (json.error?.message) {
          throw new Error(`${modelName}: ${json.error.message}`);
        }

        const text = (json.candidates?.[0]?.content?.parts ?? [])
          .map((part) => part.text ?? "")
          .join("");
        if (text) {
          accumulated += text;
          await emit();
        }
      }

      if (done) {
        break;
      }
    }

    await emit(true);
    if (!accumulated.trim()) {
      throw new Error(`${modelName}: Google AI Studio 没有返回翻译结果。`);
    }

    return accumulated;
  }

  private async streamWithOpenAiCompatible(
    markdown: string,
    onPartial: (partial: string) => Promise<void>
  ): Promise<string> {
    const models = getOpenAiModelCandidates(this.settings);
    let lastError: unknown = null;

    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      try {
        return await this.requestOpenAiCompatibleStream(markdown, model, onPartial);
      } catch (error) {
        lastError = error;
        if (index === models.length - 1 || !shouldTryFallback(error)) {
          throw error;
        }

        new Notice(`${model} 当前受限或不可用，正在尝试 ${models[index + 1]}。`);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("OpenAI 兼容 API 模型没有返回翻译结果。");
  }

  private async requestOpenAiCompatibleStream(
    markdown: string,
    modelName: string,
    onPartial: (partial: string) => Promise<void>
  ): Promise<string> {
    if (typeof fetch !== "function") {
      throw new Error("当前 Obsidian 环境不支持流式请求。");
    }

    const response = await fetch(buildOpenAiChatCompletionsUrl(this.settings.openAiBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.openAiApiKey.trim()}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          {
            role: "system",
            content: "You are a precise Markdown translation engine."
          },
          {
            role: "user",
            content: buildTranslationPrompt(markdown, this.settings)
          }
        ],
        temperature: 0.1,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(`${modelName}: ${await response.text()}`);
    }

    if (!response.body) {
      throw new Error("当前 Obsidian 环境不支持流式响应。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    let lastEmit = 0;

    const emit = async (force = false) => {
      if (!force && Date.now() - lastEmit < 350) {
        return;
      }
      lastEmit = Date.now();
      await onPartial(accumulated);
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") {
          continue;
        }

        const json = JSON.parse(data) as OpenAiChatResponse;
        if (json.error?.message) {
          throw new Error(`${modelName}: ${json.error.message}`);
        }

        const text = json.choices?.map((choice) => choice.delta?.content ?? "").join("") ?? "";
        if (text) {
          accumulated += text;
          await emit();
        }
      }

      if (done) {
        break;
      }
    }

    await emit(true);
    if (!accumulated.trim()) {
      throw new Error(`${modelName}: OpenAI 兼容 API 没有返回翻译结果。`);
    }

    return accumulated;
  }
}

class AiTranslatorSettingTab extends PluginSettingTab {
  plugin: AiTranslatorPlugin;

  constructor(app: App, plugin: AiTranslatorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "AI Translator" });

    new Setting(containerEl)
      .setName("模型")
      .setDesc("选择模型接口。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("google-ai-studio", "google-ai-studio")
          .addOption("openai-compatible", "OpenAI 兼容 API")
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            this.plugin.settings.provider = value as ProviderId;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.provider === "google-ai-studio") {
      new Setting(containerEl)
        .setName("API Key")
        .setDesc("Google AI Studio API Key，只保存在本地 Obsidian 插件数据中。")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("AIza...")
            .setValue(this.plugin.settings.apiKey)
            .onChange(async (value) => {
              this.plugin.settings.apiKey = value.trim();
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("模型名称")
        .setDesc("选中的模型优先使用，其他模型自动作为降级模型。")
        .addDropdown((dropdown) => {
          for (const model of GOOGLE_MODEL_OPTIONS) {
            dropdown.addOption(model, model);
          }

          dropdown.setValue(this.plugin.settings.model).onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          });
        });
    }

    if (this.plugin.settings.provider === "openai-compatible") {
      new Setting(containerEl)
        .setName("Base URL")
        .setDesc("例如 https://api.openai.com/v1、https://openrouter.ai/api/v1；也可以直接填到 /chat/completions。")
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_SETTINGS.openAiBaseUrl)
            .setValue(this.plugin.settings.openAiBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.openAiBaseUrl = value.trim() || DEFAULT_SETTINGS.openAiBaseUrl;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("API Key")
        .setDesc("只保存在本地 Obsidian 插件数据中。")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.openAiApiKey)
            .onChange(async (value) => {
              this.plugin.settings.openAiApiKey = value.trim();
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("模型名称")
        .setDesc("填写服务商支持的模型名称，例如 gpt-4o-mini、deepseek-chat、moonshot-v1-8k。")
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_SETTINGS.openAiModel)
            .setValue(this.plugin.settings.openAiModel)
            .onChange(async (value) => {
              this.plugin.settings.openAiModel = value.trim() || DEFAULT_SETTINGS.openAiModel;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("源语言")
      .setDesc("选择原文语言。")
      .addDropdown((dropdown) => {
        for (const language of LANGUAGE_OPTIONS) {
          dropdown.addOption(language, language);
        }

        dropdown.setValue(this.plugin.settings.sourceLanguage).onChange(async (value) => {
          this.plugin.settings.sourceLanguage = value;
          this.plugin.settings.autoDetectSource = value === AUTO_LANGUAGE;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("目标语言")
      .setDesc("默认翻译为中文。")
      .addDropdown((dropdown) => {
        for (const language of LANGUAGE_OPTIONS) {
          dropdown.addOption(language, language);
        }

        dropdown.setValue(this.plugin.settings.targetLanguage).onChange(async (value) => {
          this.plugin.settings.targetLanguage = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("流式输出")
      .setDesc("开启后会先创建新笔记，再边翻译边写入内容；如果当前环境不支持，会自动回退到普通翻译。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.streamOutput).onChange(async (value) => {
          this.plugin.settings.streamOutput = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("保留 Markdown 引用块")
      .setDesc("开启后不会翻译以 > 开头的引用块，适合保留原文摘录。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.preserveBlockquotes).onChange(async (value) => {
          this.plugin.settings.preserveBlockquotes = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

function getFolderPath(path: string): string {
  const lastSlashIndex = path.lastIndexOf("/");
  return lastSlashIndex === -1 ? "" : path.slice(0, lastSlashIndex);
}

function sanitizeFileNamePart(value: string): string {
  const sanitized = value.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim();
  return sanitized || "translated";
}

function buildTranslationPrompt(markdown: string, settings: TranslatorSettings): string {
  const sourceLanguage =
    settings.sourceLanguage === AUTO_LANGUAGE ? "auto-detect" : settings.sourceLanguage;
  const targetLanguage =
    settings.targetLanguage === AUTO_LANGUAGE
      ? "a natural target language different from the source language"
      : settings.targetLanguage;

  return [
    "You are a precise Markdown translation engine for Obsidian notes.",
    `Translate natural-language prose from ${sourceLanguage} to ${targetLanguage}.`,
    "Return only the translated Markdown. Do not add explanations, code fences, titles, or notes.",
    "Preserve the original structure, spacing, line breaks, Markdown syntax, indentation, tables, task lists, headings, and list markers.",
    "Copy placeholder tokens exactly, character for character, whenever they appear. Tokens look like @@AI_TRANSLATOR_TOKEN_000001@@.",
    "Do not translate code, URLs, file names, wiki links, Markdown links, images, tags, YAML/frontmatter, math, HTML, footnote markers, or protected quoted blocks.",
    "Only translate human-readable prose that is not protected by a placeholder token.",
    "If text is already in the target language, keep it natural and avoid unnecessary rewriting.",
    "",
    "Input:",
    markdown
  ].join("\n");
}

function getModelCandidates(settings: TranslatorSettings): string[] {
  return orderSelectedFirst(GOOGLE_MODEL_OPTIONS, settings.model || DEFAULT_SETTINGS.model);
}

function getOpenAiModelCandidates(settings: TranslatorSettings): string[] {
  return [settings.openAiModel.trim() || DEFAULT_SETTINGS.openAiModel];
}

function orderSelectedFirst(options: string[], selected: string): string[] {
  const normalizedSelected = selected.trim();
  const rest = options.filter((option) => option !== normalizedSelected);
  return options.includes(normalizedSelected) ? [normalizedSelected, ...rest] : [...options];
}

function buildOpenAiChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}/chat/completions`;
}

function shouldTryFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/api key|permission_denied|unauthenticated|invalid api key/i.test(message)) {
    return false;
  }

  return /400|404|429|500|503|quota|rate|limit|resource_exhausted|unavailable|overload|timeout|deadline|not found|not supported|not available/i.test(
    message
  );
}

function protectMarkdown(markdown: string, preserveBlockquotes: boolean): ProtectedMarkdown {
  const tokens: Record<string, string> = {};
  let index = 0;
  let text = markdown;

  const protect = (pattern: RegExp) => {
    text = text.replace(pattern, (match: string) => {
      const token = `${TOKEN_PREFIX}${String(index).padStart(6, "0")}@@`;
      tokens[token] = match;
      index += 1;
      return token;
    });
  };

  protect(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/);
  protect(/(^|\r?\n)(```|~~~)[\s\S]*?(?:\r?\n\2[^\r\n]*|$)/g);
  protect(/<!--[\s\S]*?-->/g);
  protect(/\$\$[\s\S]*?\$\$/g);

  if (preserveBlockquotes) {
    protect(/(^|\r?\n)(?:[ \t]*>[^\r\n]*(?:\r?\n|$))+/g);
  }

  protect(/!\[\[[^\]\r\n]+\]\]/g);
  protect(/\[\[[^\]\r\n]+\]\]/g);
  protect(/!\[[^\]\r\n]*\]\([^) \r\n]+(?:\s+"[^"]*")?\)/g);
  protect(/\[[^\]\r\n]+\]\([^) \r\n]+(?:\s+"[^"]*")?\)/g);
  protect(/^\s*\[[^\]\r\n]+\]:\s+\S+.*$/gm);
  protect(/\[\^[^\]\r\n]+\]/g);
  protect(/`[^`\r\n]+`/g);
  protect(/\$[^$\r\n]+\$/g);
  protect(/<(?:https?:\/\/|mailto:)[^>\s]+>/g);
  protect(/\bhttps?:\/\/[^\s<>()]+/g);
  protect(/<\/?[A-Za-z][^>\r\n]*>/g);
  protect(/(^|[\s([{])#[\p{L}\p{N}_/-]+/gu);

  return { text, tokens };
}

function restoreProtectedMarkdown(markdown: string, tokens: Record<string, string>): string {
  let restored = markdown;
  for (const [token, value] of Object.entries(tokens)) {
    restored = restored.split(token).join(value);
  }
  return restored;
}

function hasTranslatableContent(markdown: string): boolean {
  const withoutTokens = markdown.replace(new RegExp(`${TOKEN_PREFIX}\\d{6}@@`, "g"), "");
  return /[\p{L}\p{N}]/u.test(withoutTokens);
}

function cleanModelOutput(output: string): string {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return fenced ? fenced[1] : output;
}
