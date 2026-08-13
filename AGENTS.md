# AGENTS.md

在线背单词平台（echoo）：深圳中考真题句子为素材，听写句子定位生词。后端 TS + 前端 Vue 均已实现并已部署。需求文档 `docs/requirements.md`（当前 v2.1）为开发依据，开始前先读。

## 开发命令

- 后端 dev：`npm run dev`（tsx src/index.ts，端口 3008）
- 前端 dev：`npm run dev:web`（vite 端口 5173，代理 /api → 3008）
- 一键起停：`./start.sh dev`（开发） / `./start.sh`（生产：build 后在 3008 单端口托管 web/dist + API）
- 测试：`npm test`（vitest，globals 开，匹配 `tests/**/*.test.ts`）；watch：`npm run test:watch`
- 类型检查：后端 `npm run typecheck`（tsc --noEmit）；前端 `npm run typecheck --prefix web`（vue-tsc --noEmit）
- 构建：后端 `npm run build`（tsc → dist/）；前端 `npm run build --prefix web`（vue-tsc -b && vite build → web/dist）
- **Node ≥ 22**：后端用内置 `node:sqlite`（实验特性），启动打印 ExperimentalWarning 属正常

## 架构要点

- 入口 `src/index.ts`：启动时建库 + 空库自动 seed，然后挂 HTTP（挂在 3008）。
- `src/db.ts`：`initDb` + 轻量迁移——`MIGRATIONS` 数组对旧库自动 `ALTER TABLE` 补列。**改表结构时务必同时追加迁移条目**，否则线上旧库缺列。
- `src/practice.ts`（核心业务 ~668 行，无 HTTP）：抽取、SM-2 复习调度、掌握判定、结果落库；逐字符拼写判定纯函数在 `checker.ts`；练习会话为**服务端权威**状态机，存内存（`practiceSession.ts`）——重启即丢登录态与会话。
- `src/routes/`（auth/practice/audio/vocab）：HTTP 薄层，逻辑复用 practice.ts/vocab.ts。
- schema 在 `src/db/schema.ts`；`TABLES` / `EXPECTED_COLUMNS` 供测试核对。
- 前端 `web/src/views/`（Login/Practice/Vocab/Settings），`web/src/api.ts` 封装 session-cookie API；vue-router history 模式（生产单页回退已在 `src/index.ts` 实现，勿手动加哈希路由）。

## 数据与素材（重要）

- 运行时数据 `data/`（git 排除）：`word_typer.db` + `data/audio/*.wav`，**二进制不入库**，靠本地拷贝带到部署机。
- 空库自动 seed 读 `res/sentence_pool.json`（默认相对 CWD）。池结构：`meta{source,count}` + `sentences[]`（en/zh/round/topic/section/tokens/bold）。
- **`res/`、`scripts/`、`tts_service/` 被 git 排除（本机/生产机保留，远程部署机不存在）**：seed 测试依赖 `res/sentence_pool.json`（clone 后该目录缺失时 `tests/seed.test.ts` 会失败，其余用例不受影响）；冷启动空库需 pool 文件。运行时数据全部在 `data/word_typer.db` + `data/audio/` + `data/nce/audio/`——**部署只需拷贝 `data/` 目录**（远程 clone 后 `./update_remote.sh` 自动迁移补列/回填课序与词音频路径）。课序数据内置 `src/data/wordLessons.ts`（进 git）。
- 池规模：1405 句、2378 词（唯一词形）、10687 个 sentence_words；`audio.word_offsets` 暂未使用。
- 内容分级（T047/T053）：words 有 level/meaning/phonetic/audio_path（词发音，路径相对项目根或绝对）；sentences 有 prev_en/next_en（对话语境提示）；用户有 level 与 `levelup_history` 表。`user_vocab` 主键 (user_id, word_id, sentence_id) —— 生词本条目 = 「单词+句子」多对多。

## 约定

- 代码与注释用中文。
- 提交信息带任务号：`feat:|fix:|docs:|chore: … (T###)`，bug 沿 `B0009` 这种编号（tasker/ 工作流目录已被 git 排除，本机亦不存在）。
- 克隆/下载外部仓库一律用 SSH（`git@github.com:…`）。
