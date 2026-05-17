# AI Translator for Obsidian

AI Translator is an Obsidian plugin for translating notes while keeping Markdown structure intact. It can translate the current note or selected text into a new note, so your original writing is never overwritten.

The plugin supports Google AI Studio / Gemini and OpenAI-compatible chat completion APIs.

## Features

- Translate the current note into a new note.
- Translate selected text into a new note.
- Keep the original note unchanged.
- Use the left ribbon button, editor context menu, or command palette.
- Stream translation output into the new note when the provider supports it.
- Choose source and target languages from presets, including auto-detection.
- Default target language is Chinese.
- Protect Markdown syntax and Obsidian-specific content before sending text to the model.
- Support Google AI Studio models with automatic fallback.
- Support OpenAI-compatible APIs with custom Base URL, API Key, and model name.

## Markdown Protection

Before translation, the plugin protects content that should not be rewritten by the model, including:

- YAML frontmatter
- Code blocks and inline code
- Markdown links and images
- Obsidian wikilinks and embedded files
- URLs and email links
- HTML tags and comments
- Math blocks and inline math
- Tags and footnote markers
- Blockquotes, when enabled in settings

The goal is that only the natural-language prose changes, while links, images, syntax, spacing, lists, headings, and note structure remain the same.

## Providers

### Google AI Studio

Use a Google AI Studio API key. The default model order is:

1. `gemini-3-flash-preview`
2. `gemini-3.1-pro-preview`
3. `gemini-3.1-flash-lite`

The selected model is tried first. Other preset Google models are used as fallback when the selected model is rate-limited, unavailable, or out of quota.

### OpenAI Compatible API

Use any provider that supports the OpenAI Chat Completions API shape.

Configure:

- Base URL, for example `https://api.openai.com/v1` or `https://openrouter.ai/api/v1`
- API Key
- Model name, for example `gpt-4o-mini`, `deepseek-chat`, or `moonshot-v1-8k`

Model names are entered manually because each provider uses different names.

## Usage

1. Open Obsidian settings.
2. Enable AI Translator.
3. Open the plugin settings.
4. Choose a provider in `模型`.
5. Fill in the API settings for that provider.
6. Choose source language and target language.
7. Run translation from one of these entry points:
   - Ribbon language icon: translate current note.
   - Editor right-click menu: translate selection or current note.
   - Command palette: `Translate selection to new note` or `Translate current note to new note`.

Translated output is created as a new note in the same folder as the source note.

## Manual Installation

1. Download or build the plugin files.
2. Create this folder in your vault:

```text
.obsidian/plugins/ai-translator/
```

3. Copy these files into that folder:

```text
manifest.json
main.js
styles.css
```

4. Restart Obsidian.
5. Enable `AI Translator` in Community plugins.

## Development

Install dependencies:

```bash
npm install
```

Run a production build:

```bash
npm run build
```

Run a watch build while developing:

```bash
npm run dev
```

## Privacy

API keys are stored locally in Obsidian plugin data. Note content selected for translation is sent to the configured model provider. Review your provider's privacy policy before translating sensitive notes.
