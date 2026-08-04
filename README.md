# 在线背单词平台（word-typer）

抽取句子 → 给汉译 + 播语音 → 逐字符拼写（大小写一致）→ 拼对记已掌握、点「提示词」则词+句入生词本。基于深圳中考真题句子与词频，覆盖 1405 句、2378 词。

## 功能

- **练习**：随机抽句（默认未掌握:生词本 = 3:7），展示汉译并朗读整句，用户逐字符拼写单词，拼对自动前进。
- **生词本**：拼不出的词点「提示词」即入生词本（保存「单词 + 所在句子」）；复习句整句拼对后自动移除，被提示过的词保留在生词本。
- **人名免拼写**：人名词（如 Tom）直接显示，不计入掌握统计。
- **语音朗读**：全句真人女声（mimo TTS），`/api/audio/:sentenceId` 提供 WAV 播放。
- **会话计时**：每次练习记录用时，统计当天已测句子。

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node.js + TypeScript + Express 5 + `node:sqlite` + express-session（内存存储） |
| 前端 | Vue 3 + Vite + Vue Router（history 模式，无 UI 库） |
| TTS | 独立 Python 脚本，调用 mimo-v2.5-tts 接口（女声 Mia）合成整句音频 |
| 测试 | Vitest（后端 66 用例）+ Python `unittest`（TTS 8 用例） |

## 目录结构

```
├── src/               # 后端 TS 源码
│   ├── routes/        # auth / practice / audio 路由
│   ├── db/            # schema + seed 建库种子
│   ├── practice.ts    # 句子/词/token 处理
│   └── practiceSession.ts  # 练习会话状态机
├── web/               # Vue 3 前端
│   └── src/views/     # LoginView / PracticeView
├── tts_service/       # TTS 音频生成（Python）
├── tests/             # 后端 vitest 测试
├── docs/tts_ref/      # TTS 参考脚本
├── res/               # 词表/真题/句子素材（git 排除）
└── data/              # 运行时产物：SQLite 库 + 音频（git 排除）
```

## 快速开始

### 环境要求

- Node.js ≥ 22（内置 `node:sqlite`）
- Python 3（仅 TTS 生成需要）
- [可选] MIMO API Key（合成音频用；库内置的 `data/audio/` 已含全量 1405 句音频则无需）

### 安装

```bash
npm install          # 后端
npm install --prefix web   # 前端
```

### 初始化数据库

首次运行需建库并灌入句子/词表数据（需先准备素材 `res/grammar_sentences.md`）：

```bash
npm run dev          # 首次启动会自动建库/补种子
```

### 启动（开发）

```bash
npm run dev          # 后端，http://localhost:3000
npm run dev:web      # 前端，http://localhost:5173（vite 代理 /api → 3000）
```

浏览器打开 `http://localhost:5173`，注册账号后即可开始练习。

### 启动（生产构建）

```bash
npm run build                    # tsc 编译 → dist/
npm run start                    # node dist/index.js
npm run build --prefix web       # 前端产物在 web/dist/
```

## TTS 音频生成

全量音频已预生成于 `data/audio/`（1405 句）。如需自行合成/补齐：

```bash
cd tts_service
python3 -m pip install --user --break-system-packages -r requirements.txt
MIMO_API_KEY=xxx python3 gen_audio.py --limit 10   # 生成 10 句；不带 --limit 生成全部
```

支持断点续跑（已存在的句子自动跳过），音频落盘 `data/audio/{sentenceId}.wav`，二进制不入库。

## 测试

```bash
npm test                          # 后端 vitest（66 用例）
cd tts_service && python3 -m unittest test_gen_audio   # TTS 测试（8 用例）
```

## API 概要

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册（username/password/nickname） |
| POST | `/api/auth/login` | 登录（session） |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 当前用户 |
| POST | `/api/practice/start` | 开始练习（body: `targetCount`） |
| POST | `/api/practice/check` | 提交一个字符（body: `{char}`） |
| POST | `/api/practice/hint` | 提示当前词（词+句入生词本） |
| POST | `/api/practice/complete` | 完成当前句（body: `wordResults`） |
| POST | `/api/practice/finish` | 结束练习 |
| GET | `/api/audio/:sentenceId` | 整句朗读 WAV（无需登录） |

除 `/api/audio/*` 外均需登录（session Cookie）。

## 数据说明

- 素材（`res/`）：深圳中考 2015–2025 真题词频统计、2498 词全量词表、1512 句带汉译的语法记忆句；句子入库前已清洗去重。
- 运行时数据（`data/`）：`word_typer.db`（SQLite：users / words / sentences / sentence_words / user_vocab / word_status / test_records / practice_sessions / audio）+ 全量音频。

## 后续规划

- 单词语音（Whisper 词级对齐，点当前词单独发音）
- 「当日已测」列表重听按钮
- 报告句子有误
