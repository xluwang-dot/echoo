<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { useRouter } from "vue-router";
import { api, type Sentence, type Token, type VocabStateItem } from "../api";

const router = useRouter();

// 阶段：menu（三区首页）→ running（拼写）→ done（完成）→ menu
const phase = ref<"menu" | "running" | "done">("menu");
const targetCount = ref(10);
const practiceMode = ref<"practice" | "review" | "test">("practice");
const testScope = ref<"all" | "near" | "fail" | "mastered" | "levelup">("all"); // 测试范围（T028）
const scopeOpen = ref(false); // 测试范围选择弹窗
const failSet = ref<Set<number>>(new Set()); // 测试模式：本句标「不会」的词
const testStats = ref<{ total: number; pass: number; fails: string[] }>({ total: 0, pass: 0, fails: [] }); // 测试会话统计
const total = ref(0);
const sentence = ref<Sentence | null>(null);

// 会话推进状态
const wordIdx = ref(0); // 当前拼写词下标
const typed = ref(""); // 当前词已输入字符
const hintSet = ref<Set<number>>(new Set()); // 本句已提示词的 token 下标
const zhRevealed = ref(false); // T043：复习模式一级提示——已显示汉译（语义锚点）
const flashError = ref(false); // 错误红闪
const error = ref("");
const reportInfo = ref(""); // 报告句子成功的短暂反馈
let reportTimer: number | null = null;
const reportOpen = ref(false); // 报告描述输入框
const reportDesc = ref(""); // 报告描述内容
const busy = ref(false);

// 计时
const startMs = ref(0);
const elapsed = ref(0);
const elapsedText = ref("0s");
let timerId: number | null = null;

// 当日已测（本次会话内完成句子 + 用时）
const todayList = ref<{ en: string; ms: number }[]>([]);
const finishDone = ref(false);
const dueBanner = ref(0); // 到期复习数量（T029）
const forceReview = ref(false); // 偏好：登录后强制进入复习
const bannerLoaded = ref(false);

// T031：到期横幅「查看单词」弹窗
const dueWordsModal = ref(false);
const dueWordsList = ref<VocabStateItem[]>([]);
// T053b：升级测试
const userLevel = ref(1);
const levelTimeLeft = ref(0);
const levelTimerId = ref<number | null>(null);
const levelUpResult = ref<{ newLevel: number } | null>(null);
const isLevelUp = computed(() => practiceMode.value === "test" && testScope.value === "levelup");
// T031：复习会话累计词 + 总结表格
const sessionWordIds = ref<Set<number>>(new Set());
const sessionSentenceIds = ref<number[]>([]); // T037：本次练习句子 id（立即复习必含）
const summaryWords = ref<VocabStateItem[]>([]);

// T035：练习模式整句完成待回车 + 点击单词入本
const sentenceDoneWait = ref(false);
const wordConfirmOpen = ref(false);
const wordConfirm = ref<{ word: string; wordId: number } | null>(null);

// 间隔表格列（记忆曲线：1→3→7→16→35 天）
const INTERVAL_COLS = [1, 3, 7, 16, 35];

// T058：当前句是否为问句（决定语境提示上句/下句）
const isQuestion = computed(() => (sentence.value?.en.trim().endsWith("?") ?? false));

// T051：长句动态字号（不拆句，句子越长字号越小）
const enSize = computed(() => {
  const n = sentence.value?.en.split(/\s+/).length ?? 0;
  if (n > 35) return "xl"; // 19px
  if (n > 25) return "l"; // 21px
  if (n > 15) return "m"; // 24px
  return "s"; // 28px 默认
});

// T043：中文提示分阶段——练习完成后显示/复习一级提示后显示/测试永不显示
const showZh = computed(() => {
  if (practiceMode.value === "test") return false;
  if (practiceMode.value === "review") return zhRevealed.value;
  return sentenceDoneWait.value; // 练习：整句拼完显示汉译
});
watch(phase, async (p) => {
  if (p === "menu" && bannerLoaded.value) {
    try {
      const d = await api.dueCount();
      dueBanner.value = d.due;
    } catch {
      // 静默
    }
  }
});

// T033/T037：同步拉取统计表格数据（只统计生词本中的词）
async function loadSummaryWords() {
  if (practiceMode.value === "test" || sessionWordIds.value.size === 0) return;
  try {
    const r = await api.vocabState([...sessionWordIds.value]);
    summaryWords.value = r.words;
  } catch {
    summaryWords.value = [];
  }
}

// 特效状态
const slideState = ref<"idle" | "exit" | "enter">("idle");
const streak = ref(0); // 连击：连续无提示完成的句子数

// 片段：词（对应 token 下标）或原样文本（标点/空格/数字/连字符）
interface Seg {
  type: "word" | "text";
  text: string;
  ti?: number; // word 时对应 token 下标
}
// 按 token 顺序在原文中定位（大小写不敏感、词边界）。tokens 来自词表分词，
// 粒度与原文不一致（如 warm-up 拆成 warm/up、25th 拆成 th），用 \b 顺序匹配可对齐。
function buildSegments(en: string, tokens: Token[]): Seg[] {
  const segs: Seg[] = [];
  let cursor = 0;
  for (let ti = 0; ti < tokens.length; ti++) {
    const word = tokens[ti].word;
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 边界用「前后非字母」而非 \b：\b 在撇号/连字符（非词字符）后接非词字符时无边界，
    // 会导致 students' 这类带撇号 token 匹配失败。非字母边界可覆盖撇号、数字后缀。
    const m = new RegExp(`(?<![A-Za-z])${esc}(?![A-Za-z])`, "i").exec(en.slice(cursor));
    if (!m) {
      // 原文中定位不到（异常数据），兜底输出原文
      continue;
    }
    const matchStart = cursor + m.index;
    if (matchStart > cursor) segs.push({ type: "text", text: en.slice(cursor, matchStart) });
    segs.push({ type: "word", text: m[0], ti });
    cursor = matchStart + m[0].length;
  }
  if (cursor < en.length) segs.push({ type: "text", text: en.slice(cursor) });
  return segs;
}

const segments = computed(() =>
  sentence.value ? buildSegments(sentence.value.en, sentence.value.tokens) : []
);

// 复习/测试模式：需默写的词下标列表（in_vocab 且非人名词；B0003 修复：过滤 is_name 防止光标跳到人名词）
const vocabIndices = computed(() => {
  if (practiceMode.value !== "review" && practiceMode.value !== "test") return null;
  if (!sentence.value) return null;
  return sentence.value.tokens
    .map((t, i) => (t.in_vocab && t.is_name !== 1 ? i : -1))
    .filter((i) => i >= 0);
});

// 复习/测试模式：跳到下一个需默写的词
function advanceToNextVocabWord() {
  if (!vocabIndices.value) return false; // 非复习/测试模式
  const pos = vocabIndices.value.indexOf(wordIdx.value);
  if (pos >= 0 && pos < vocabIndices.value.length - 1) {
    wordIdx.value = vocabIndices.value[pos + 1];
    typed.value = "";
    return true; // 还有生词
  }
  return false; // 没有更多生词
}

// 复习/测试模式：跳过非生词/人名，将 wordIdx 调整到第一个生词
function skipNonVocabWords() {
  if (practiceMode.value !== "review" && practiceMode.value !== "test") return;
  if (!sentence.value) return;
  const firstVocab = sentence.value.tokens.findIndex(
    (t) => t.in_vocab && t.is_name !== 1
  );
  if (firstVocab >= 0) {
    wordIdx.value = firstVocab;
    typed.value = "";
  }
}

// 复习/测试模式：当前词是否为非生词（需跳过，灰色显示）
function isSkippable(seg: Seg): boolean {
  if (practiceMode.value !== "review" && practiceMode.value !== "test") return false;
  if (!sentence.value) return false;
  return sentence.value.tokens[seg.ti!].in_vocab === false;
}

function renderWord(seg: Seg): string {
  if (seg.type === "text") return seg.text;
  const t = sentence.value!.tokens[seg.ti!];
  if (t.is_name === 1) return t.word;
  if (seg.ti! < wordIdx.value) return t.word; // 已完成（颜色由 class 决定）
  return t.word; // 当前/未到：由模板或透明渲染
}

// 是否为当前输入词（word 段且光标在该词）
function isActive(seg: Seg): boolean {
  if (seg.type !== "word" || seg.ti !== wordIdx.value || isName(seg)) return false;
  // 复习模式：非生词不激活
  if (isSkippable(seg)) return false;
  return true;
}

// 当前词未输入部分（透明占位，保持等宽）
function blankRemain(seg: Seg): string {
  const t = sentence.value!.tokens[seg.ti!];
  return t.word.slice(typed.value.length);
}

function isName(seg: Seg): boolean {
  return seg.type === "word" && sentence.value!.tokens[seg.ti!].is_name === 1;
}

function renderSegClass(seg: Seg): string {
  if (seg.type === "text") return "punct";
  const t = sentence.value!.tokens[seg.ti!];
  if (t.is_name === 1) return "name";
  // 复习/测试模式：非生词灰色显示（不参与默写）
  if (isSkippable(seg)) return "skipped";
  const hinted = hintSet.value.has(seg.ti!);
  if (seg.ti! < wordIdx.value) return hinted ? "hint-done" : "word-done";
  if (seg.ti === wordIdx.value) return hinted ? "hint-active" : "active";
  return "todo";
}

// ---------- 输入 ----------
async function onChar(ch: string) {
  if (phase.value !== "running" || busy.value) return;
  if (!/[A-Za-z0-9'-]/.test(ch)) return; // 只接受词内字符
  const t = sentence.value!.tokens[wordIdx.value];
  if (!t || t.is_name === 1) return;
  busy.value = true;
  try {
    const r = await api.check(ch);
    if (r.correct) {
      typed.value += ch;
      flashError.value = false;
      if (r.wordDone) {
        // 整词完成
        if (r.sentenceDone) {
          // T035：练习模式整句完成后等待回车，不自动切句；复习/测试模式自动推进
          if (practiceMode.value === "practice") {
            sentenceDoneWait.value = true;
          } else {
            await finishSentence();
          }
        } else if (vocabIndices.value) {
          // 复习/测试模式：跳到下一个生词，或完成句子
          if (!advanceToNextVocabWord()) {
            await finishSentence();
          }
        } else {
          wordIdx.value += 1;
          typed.value = "";
        }
      }
    } else {
      flashError.value = true;
      setTimeout(() => (flashError.value = false), 300);
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function onBackspace() {
  if (phase.value !== "running" || busy.value) return;
  if (typed.value === "") return;
  busy.value = true;
  try {
    const r = await api.backspace();
    typed.value = r.typed;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function onHint() {
  if (phase.value !== "running" || busy.value) return;
  const t = sentence.value!.tokens[wordIdx.value];
  if (!t || t.is_name === 1) return;
  if (hintSet.value.has(wordIdx.value)) return; // 已提示
  // T043：复习模式两级提示——第一次只显示汉译（锚点，不入本、不算失败）
  if (practiceMode.value === "review" && !zhRevealed.value) {
    zhRevealed.value = true;
    return;
  }
  busy.value = true;
  try {
    await api.hint();
    hintSet.value.add(wordIdx.value); // 浅色显示未输入部分，已输入部分保持原色
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

// 报告句子有误（§3.6/T020）：弹出描述输入框，可输入具体问题、可留空直接提交
function openReport() {
  if (phase.value !== "running" || busy.value) return;
  reportDesc.value = "";
  reportOpen.value = true;
}

function cancelReport() {
  reportOpen.value = false;
}

async function submitReport() {
  if (busy.value) return;
  busy.value = true;
  try {
    await api.report(sentence.value!.sentenceId, reportDesc.value.trim() || undefined);
    reportOpen.value = false;
    reportInfo.value = "已上报，感谢反馈 🙏";
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = window.setTimeout(() => (reportInfo.value = ""), 3000);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

// 整句完成：提交全词结果，推进下一句或结束
async function finishSentence() {
  const tokens = sentence.value!.tokens;
  const isTest = practiceMode.value === "test";
  const wordResults = tokens
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.is_name !== 1 && (isTest ? (isLevelUp.value || t.in_vocab) : true)) // T053b：升级测试提交全部词
    .map(({ t, i }) =>
      isTest
        ? { wordId: t.word_id, result: failSet.value.has(i) ? ("test_fail" as const) : ("mastered" as const) }
        : { wordId: t.word_id, result: hintSet.value.has(i) ? ("hint" as const) : ("mastered" as const) }
    );
  // 测试模式：累计统计（结果页用）
  if (isTest) {
    for (const w of wordResults) {
      testStats.value.total += 1;
      if (w.result === "mastered") {
        testStats.value.pass += 1;
      } else {
        const tok = tokens.find((t) => t.word_id === w.wordId);
        if (tok) testStats.value.fails.push(tok.word);
      }
    }
  }
  // 复习/练习总结（T031/T037）：累计本次会话涉及词与句子
  for (const w of wordResults) {
    sessionWordIds.value.add(w.wordId);
  }
  sessionSentenceIds.value.push(sentence.value!.sentenceId); // T037：立即复习必含本句
  const ms = Date.now() - startMs.value;
  const r = await api.complete(wordResults);
  // T045：掌握特效（新掌握词徽章 + 金色粒子 + 音效）与里程碑
  if (r.masteredWordIds?.length) {
    const wNames = r.masteredWordIds.map((id) => tokens.find((t) => t.word_id === id)?.word ?? "");
    triggerMasteryEffect(wNames);
  }
  checkMasteryMilestone(r.masteryCount ?? 0);
  todayList.value.push({ en: sentence.value!.en, ms });

  // 连击：本句无提示/无失败 → +1，有 → 归零
  const hadHint = wordResults.some((w) => w.result === "hint" || w.result === "test_fail");
  streak.value = hadHint ? 0 : streak.value + 1;
  // T057：每句不再触发粒子（避免竖条/色块困扰）；掌握/里程碑大特效保留

  // 滑动翻页：当前句向左滑出
  slideState.value = "exit";
  await new Promise((r) => setTimeout(r, 420));

  if (r.done) {
    finishDone.value = true;
    stopLevelTimer(); // T053b
    if (timerId) clearInterval(timerId); // T037：统计页停止计时
    // T053b：升级测试通过 → 升级结果 + 大特效
    if (r.levelUp) {
      levelUpResult.value = { newLevel: r.newLevel ?? 0 };
      createGoldConfetti(120);
      playDing(660);
      setTimeout(() => playDing(880), 200);
      setTimeout(() => playDing(1320), 400);
    }
    await loadSummaryWords(); // T033：统计表格数据在 done 渲染前就绪
    phase.value = "done";
  } else {
    error.value = ""; // T054：换句清除残留提示
    // 替换句子，新句从右侧滑入
    sentence.value = r.next!;
    wordIdx.value = r.next!.wordIdx;
    typed.value = "";
    hintSet.value = new Set();
    zhRevealed.value = false; // T043：换句重置一级提示
    skipNonVocabWords(); // 复习模式：跳到第一个生词
    await nextTick();
    slideState.value = "enter";
    await new Promise((r) => setTimeout(r, 420));
    slideState.value = "idle";
    // 播放整句音频（T041：单次播放）
    playSentence();
    if (isLevelUp.value) startLevelTimer(); // T053b：升级测试换句重新计时
  }
}

// ---------- 开始/结束 ----------
async function onStart(mode: "practice" | "review" | "test" = "practice", scope?: "all" | "near" | "fail" | "mastered" | "levelup", includeSentenceIds?: number[]) {
  error.value = "";
  busy.value = true;
  practiceMode.value = mode;
  if (mode === "test") testScope.value = scope ?? "all";
  slideState.value = "idle"; // 重置滑动状态，避免上一轮 slide-exit 残留
  try {
    const r = await api.start(targetCount.value, mode, mode === "test" ? testScope.value : undefined, includeSentenceIds);
    total.value = r.total;
    sentence.value = r.current;
    wordIdx.value = r.current.wordIdx;
    typed.value = "";
    hintSet.value = new Set();
    failSet.value = new Set();
    zhRevealed.value = false; // T043：复习一级提示状态重置
    if (mode === "test") testStats.value = { total: 0, pass: 0, fails: [] }; // 测试会话统计重置
    sessionWordIds.value = new Set(); // 新会话重新累计
    sessionSentenceIds.value = []; // T037
    summaryWords.value = [];
    sentenceDoneWait.value = false; // T035：整句完成待回车状态重置
    skipNonVocabWords(); // 复习/测试模式：跳到第一个生词
    todayList.value = [];
    finishDone.value = false;
    phase.value = "running";
    startMs.value = Date.now();
    elapsed.value = 0;
    if (timerId) clearInterval(timerId);
    timerId = window.setInterval(() => {
      elapsed.value = Math.floor((Date.now() - startMs.value) / 1000);
      elapsedText.value = elapsed.value + "s";
    }, 1000);
    // 播放整句音频（T041：单次播放）
    playSentence();
    if (isLevelUp.value) startLevelTimer(); // T053b
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

// 测试模式：弹范围选择后开始
function openTestScope() {
  scopeOpen.value = true;
}
function startTest(scope: "all" | "near" | "fail" | "mastered" | "levelup") {
  scopeOpen.value = false;
  onStart("test", scope);
}

// T052：播放单词发音（词音频端点）
function playWordAudio(seg: Seg) {
  const t = sentence.value!.tokens[seg.ti!];
  if (!t) return;
  if (!audioEl) audioEl = new Audio();
  audioEl.src = api.wordAudioUrl(t.word);
  audioEl.currentTime = 0;
  audioEl.play().catch(() => {});
}

// 点击单词：完成态（练习）弹入本确认；非完成态播词音（测试模式禁用，防提示）
function onWordClick(seg: Seg) {
  if (seg.type !== "word") return;
  if (practiceMode.value === "practice" && sentenceDoneWait.value) {
    const t = sentence.value!.tokens[seg.ti!];
    if (t.is_name === 1) return;
    if (t.in_vocab) {
      reportInfo.value = `「${t.word}」已在生词本`;
      setTimeout(() => (reportInfo.value = ""), 1800);
      return;
    }
    wordConfirm.value = { word: t.word, wordId: t.word_id };
    wordConfirmOpen.value = true;
    return;
  }
  if (practiceMode.value !== "test") {
    playWordAudio(seg);
  }
}

// 确认加入生词本
async function confirmAddWord() {
  const w = wordConfirm.value;
  if (!w) return;
  wordConfirmOpen.value = false;
  wordConfirm.value = null;
  try {
    await api.addVocab(w.wordId);
    // 本地刷新 token 状态（in_vocab=true）
    const tok = sentence.value!.tokens.find((t) => t.word_id === w.wordId);
    if (tok) tok.in_vocab = true;
    reportInfo.value = `「${w.word}」已加入生词本`;
    setTimeout(() => (reportInfo.value = ""), 1800);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// T037：练习统计页「立即复习」——必含本次练习中入生词本的句子
function onImmediateReview() {
  const include = [...new Set(sessionSentenceIds.value)];
  onStart("review", undefined, include);
}

// T053b：升级测试限时（句时限 = 词数×5s×150%）
function startLevelTimer() {
  stopLevelTimer();
  const words = sentence.value?.en.split(/\s+/).length ?? 1;
  levelTimeLeft.value = Math.ceil(words * 5 * 1.5);
  levelTimerId.value = window.setInterval(() => {
    levelTimeLeft.value -= 1;
    if (levelTimeLeft.value <= 0) {
      stopLevelTimer();
      timeoutSentence();
    }
  }, 1000);
}
function stopLevelTimer() {
  if (levelTimerId.value) {
    clearInterval(levelTimerId.value);
    levelTimerId.value = null;
  }
}
// 超时：当前句未完成词全部 test_fail → 提交（整句算错）
function timeoutSentence() {
  if (phase.value !== "running") return;
  const tokens = sentence.value!.tokens;
  for (let i = wordIdx.value; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.is_name !== 1 && t.in_vocab) failSet.value.add(i);
  }
  finishSentence();
}

// 升级按钮：有活跃邀请 → 进升级测试；否则提示规则
async function onLevelUpClick() {
  try {
    const st = await api.levelupStatus();
    userLevel.value = st.level;
    if (st.ready) {
      onStart("test", "levelup");
    } else {
      error.value = `当前等级 ${st.level}。${st.rule}`;
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// 到期横幅「查看单词」：拉取到期词并弹窗展示（T031）
async function openDueWords() {
  try {
    const r = await api.dueWords();
    dueWordsList.value = r.words;
    dueWordsModal.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// 测试模式「不会」：标记当前词 test_fail，跳到下一词（无提示，§3.3）
function onGiveUp() {
  if (phase.value !== "running" || busy.value) return;
  const t = sentence.value!.tokens[wordIdx.value];
  if (!t || t.is_name === 1) return;
  if (failSet.value.has(wordIdx.value)) return;
  failSet.value.add(wordIdx.value);
  wordIdx.value += 1;
  typed.value = "";
  skipNonVocabWords(); // 跳到下一个需测试的词
  if (wordIdx.value >= sentence.value!.tokens.length) {
    finishSentence();
  }
}

async function onFinish() {
  if (phase.value !== "running") return;
  try {
    await api.finish();
  } catch {
    // 忽略：会话可能已结束
  }
  if (timerId) clearInterval(timerId);
  await loadSummaryWords(); // T033：提前结束时也可靠显示统计
  phase.value = "done";
}

async function onLogout() {
  await api.logout();
  router.push("/login");
}

// 播放整句音频（T012：mimo 合成 + 后端静态服务）
let audioEl: HTMLAudioElement | null = null;
async function playSentence() {
  if (!sentence.value) return;
  // T069：占位句（单词听写）播词音频；真实句播句音频
  const url = sentence.value.is_word_only
    ? api.wordAudioUrl(sentence.value.tokens[0]?.word ?? sentence.value.en)
    : api.audioUrl(sentence.value.sentenceId);
  if (!audioEl) audioEl = new Audio();
  audioEl.src = url;
  audioEl.currentTime = 0;
  try {
    await audioEl.play();
  } catch {
    // 音频缺失或未生成时静默（按钮仍可用，后续提示）
  }
}

// 彩色纸屑奖励特效
const CONFETTI_COLORS = ["#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4", "#ffeaa7", "#dda0dd", "#ff9ff3", "#48dbfb", "#feca57"];
function createConfetti(count = 40, colors: string[] = CONFETTI_COLORS) {
  // T057 调试：?noconfetti 参数禁用粒子特效（验证左侧色块是否特效所致）
  if (window.location.search.includes("noconfetti")) return;
  const container = document.querySelector(".confetti-container");
  if (!container) return;
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "confetti-particle";
    p.style.left = "50%"; // 正中心
    p.style.top = "45%";
    p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    p.style.width = (4 + Math.random() * 5) + "px";
    p.style.height = (4 + Math.random() * 5) + "px";
    // 扇形散开（上半圆随机角度）：横向必然错开，杜绝竖条/左边缘聚集
    const angle = Math.random() * Math.PI;
    const dist = 60 + Math.random() * 200;
    p.style.setProperty("--tx", (Math.cos(angle) * dist) + "px");
    p.style.setProperty("--ty", (-Math.sin(angle) * dist) + "px");
    p.style.setProperty("--tr", (Math.random() * 1080) + "deg");
    p.style.setProperty("--dur", (0.8 + Math.random() * 0.8) + "s");
    p.style.setProperty("--del", (Math.random() * 0.15) + "s");
    container.appendChild(p);
    setTimeout(() => p.remove(), 2200);
  }
}

// T045：掌握特效——徽章浮窗 + 金色粒子 + 音效；里程碑大特效
const masteryBadge = ref<string | null>(null);
const milestoneBadge = ref<{ title: string; desc: string } | null>(null);
let badgeTimer: number | null = null;
const GOLD_COLORS = ["#ffd700", "#ffb300", "#ffe066", "#fff3b0"];

function createGoldConfetti(count: number) {
  createConfetti(count, GOLD_COLORS);
}

// 轻音效（Web Audio 合成叮声，无需音频文件）
let audioCtx: AudioContext | null = null;
function playDing(freq = 880, dur = 0.25) {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.22, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch {
    // 浏览器策略/无音频设备：静默
  }
}

// 核心特效：新掌握词 → 徽章印章 + 金色粒子 + 叮咚音
function triggerMasteryEffect(words: string[]) {
  if (!words.length) return;
  if (badgeTimer) clearTimeout(badgeTimer);
  masteryBadge.value = words.join(" · ");
  createGoldConfetti(50);
  playDing(880);
  setTimeout(() => playDing(1320), 160);
  badgeTimer = window.setTimeout(() => (masteryBadge.value = null), 2000);
}

// 里程碑：10/50/100 掌握词 → 大特效（localStorage 防重复）
const MILESTONES = [10, 50, 100];
function checkMasteryMilestone(count: number) {
  for (const m of MILESTONES) {
    if (count < m) break;
    if (localStorage.getItem(`echoo_milestone_${m}`)) continue;
    localStorage.setItem(`echoo_milestone_${m}`, "1");
    createGoldConfetti(120);
    playDing(660);
    setTimeout(() => playDing(880), 200);
    setTimeout(() => playDing(1320), 400);
    milestoneBadge.value = {
      title: `🎖️ 已掌握 ${m} 个单词`,
      desc: m >= 100 ? "词汇大师！" : m >= 50 ? "词汇达人！" : "初露锋芒！",
    };
    setTimeout(() => (milestoneBadge.value = null), 3200);
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // B0002：输入控件（textarea/input）内放行，避免全局监听拦截浏览器默认行为（报告描述输入框等）
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
  if (e.key === "Backspace") {
    e.preventDefault();
    onBackspace();
    return;
  }
  // T035：练习模式整句完成态回车进入下一句
  if (e.key === "Enter" && sentenceDoneWait.value) {
    e.preventDefault();
    sentenceDoneWait.value = false;
    finishSentence();
    return;
  }
  if (e.key.length === 1) {
    e.preventDefault();
    onChar(e.key);
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  // T029：登录后强引导——拉取到期数量与偏好，强制偏好时自动进入复习
  try {
    const me = await api.me();
    forceReview.value = me.preferences?.login_force_review === true;
    const d = await api.dueCount();
    dueBanner.value = d.due;
    bannerLoaded.value = true;
    if (forceReview.value && d.due > 0 && phase.value === "menu") {
      onStart("review");
    }
  } catch {
    // 未登录等：静默
  }
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  if (timerId) clearInterval(timerId);
});
</script>

<template>
  <div class="practice">
    <div class="confetti-container"></div>
    <div class="main">
      <div class="topbar">
        <span class="title">背单词 · 听写</span>
        <div class="topbar-right">
          <span v-if="streak >= 3" class="streak-badge">🔥 连击 ×{{ streak }}</span>
          <button class="ghost" @click="router.push('/settings')">⚙️ 设置</button>
          <button class="ghost" @click="onLogout">退出</button>
        </div>
      </div>

      <!-- 设置页 -->
      <!-- 三区首页 -->
      <div v-if="phase === 'menu'" class="menu">
        <div v-if="bannerLoaded && dueBanner > 0" class="due-banner">
          <span>📢 有 <strong>{{ dueBanner }}</strong> 个到期词待复习（按记忆曲线）</span>
          <button class="danger" @click="onStart('review')">立即复习</button>
          <button class="plain" @click="openDueWords">查看单词</button>
        </div>
        <div class="menu-cards">
          <!-- T069：单词听写入口（练习左边） -->
          <div class="menu-card" @click="router.push('/dictation')">
            <div class="card-icon">🎧</div>
            <h2>单词听写</h2>
            <p>按课文顺序扫描生词</p>
          </div>
          <div class="menu-card" @click="onStart('practice')">
            <div class="card-icon">📝</div>
            <h2>练习</h2>
            <p>开始新的练习，默认10个句子</p>
          </div>
          <div class="menu-card" @click="onStart('review')">
            <div class="card-icon">🔄</div>
            <h2>复习</h2>
            <p>只复习生词本中的句子</p>
          </div>
          <div class="menu-card" @click="openTestScope">
            <div class="card-icon">📋</div>
            <h2>测试</h2>
            <p>验收生词掌握度（禁提示）</p>
          </div>
          <!-- T053b：升级入口 -->
          <div class="menu-card" @click="onLevelUpClick">
            <div class="card-icon">🏅</div>
            <h2>升级</h2>
            <p>等级 {{ userLevel }} · 测试解锁下一级</p>
          </div>
          <div class="menu-card" @click="router.push('/vocab')">
            <div class="card-icon">📖</div>
            <h2>生词本</h2>
            <p>查看生词本中的句子</p>
          </div>
        </div>
        <!-- 测试范围选择（T028） -->
        <div v-if="scopeOpen" class="modal-mask" @click.self="scopeOpen = false">
          <div class="modal">
            <h3>测试范围</h3>
            <p class="modal-tip">选择本次测试的验收对象（可留空直接提交）</p>
            <div class="modal-actions wrap">
              <button class="primary" @click="startTest('all')">全部生词</button>
              <button @click="startTest('near')">临近掌握</button>
              <button @click="startTest('fail')">高错词</button>
              <button @click="startTest('mastered')">已掌握复测</button>
              <button @click="scopeOpen = false">取消</button>
            </div>
          </div>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
      </div>

      <!-- 拼写 -->
      <div v-else-if="phase === 'running'" class="spell-wrap">
        <div class="progress">
          第 {{ todayList.length + 1 }}/{{ total }} 句 · 用时 {{ elapsedText }}
        </div>
        <div v-if="showZh" class="zh">
          {{ sentence?.zh }}
          <!-- T058：对话语境提示（问句显下句/答句显上句，互补语境；小字不抢主内容） -->
          <div v-if="isQuestion && sentence?.next_en" class="ctx">↳ 下句：{{ sentence.next_en }}</div>
          <div v-else-if="!isQuestion && sentence?.prev_en" class="ctx">↳ 上句：{{ sentence.prev_en }}</div>
        </div>
        <div class="input-card">
          <!-- T069：占位句 → 听音拼写（不显示单词文本） -->
          <div v-if="sentence?.is_word_only" class="en dict-mode">
            <span class="typed">{{ typed }}</span><span class="dict-caret">▍</span>
          </div>
          <div v-else class="en" :class="['mode-' + practiceMode, 'size-' + enSize, { flash: flashError, 'slide-exit': slideState === 'exit', 'slide-enter': slideState === 'enter' }]">
            <span v-for="(seg, i) in segments" :key="i" :class="renderSegClass(seg)" @click="onWordClick(seg)">
              <template v-if="seg.type === 'word' && isActive(seg)">
                <span class="typed">{{ typed }}</span><span class="blank">{{ blankRemain(seg) }}</span>
              </template>
              <template v-else>{{ renderWord(seg) }}</template>
            </span>
          </div>
          <!-- T035：练习模式整句完成待回车提示 -->
          <div v-if="sentenceDoneWait" class="done-wait">
            ✅ 已输入完成，按 <strong>回车</strong> 进入下一句；点击单词可加入生词本
          </div>
          <!-- T053b：升级测试限时 -->
          <div v-if="isLevelUp" class="level-timer">⏱ 本句剩余 {{ levelTimeLeft }}s（超时整句算错）</div>
          <div class="actions">
            <button :disabled="busy" @click="playSentence">朗读</button>
            <template v-if="practiceMode === 'test'">
              <button :disabled="busy" @click="onGiveUp">不会</button>
            </template>
            <template v-else>
              <button v-if="!sentenceDoneWait" :disabled="busy" @click="onHint">{{ practiceMode === 'review' && !zhRevealed ? '提示（看中文）' : '提示' }}</button>
            </template>
            <button :disabled="busy" @click="openReport">报告句子有误</button>
            <button class="danger" @click="onFinish">结束</button>
          </div>
          <!-- T035：点击单词加入生词本确认 -->
          <div v-if="wordConfirmOpen" class="modal-mask" @click.self="wordConfirmOpen = false">
            <div class="modal">
              <h3>加入生词本</h3>
              <p class="modal-tip">是否将单词 <span class="highlight-word">{{ wordConfirm?.word }}</span> 加入生词本？<br>加入后该词会出现在复习与测试中。</p>
              <div class="modal-actions">
                <button @click="wordConfirmOpen = false">取消</button>
                <button class="primary" @click="confirmAddWord">确认加入</button>
              </div>
            </div>
          </div>

          <!-- 报告描述输入框（T020） -->
          <div v-if="reportOpen" class="modal-mask" @click.self="cancelReport">
            <div class="modal">
              <h3>报告句子有误</h3>
              <p class="modal-tip">描述你遇到的问题（可选）</p>
              <textarea
                v-model="reportDesc"
                rows="3"
                placeholder="如：这段语音播放了两个句子…"
              ></textarea>
              <div class="modal-actions">
                <button @click="cancelReport">取消</button>
                <button class="primary" :disabled="busy" @click="submitReport">提交报告</button>
              </div>
            </div>
          </div>
          <p v-if="reportInfo" class="info">{{ reportInfo }}</p>
          <p v-if="error" class="error">{{ error }}</p>
          <p class="tip">逐字输入英文；<code>'</code> 与 <code>-</code> 直接敲。</p>
        </div>
      </div>

      <!-- 完成 -->
      <div v-else class="done">
        <!-- T053b：升级结果 -->
        <div v-if="levelUpResult" class="levelup-result">
          <div class="levelup-title">🎉 升级成功！</div>
          <div class="levelup-level">当前等级 {{ levelUpResult.newLevel }}（{{ levelUpResult.newLevel === 2 ? '初中' : levelUpResult.newLevel === 3 ? '高中' : levelUpResult.newLevel === 4 ? '大学' : '小学' }}级内容已解锁）</div>
        </div>
        <h2>{{ practiceMode === 'review' ? '复习完成' : practiceMode === 'test' ? (levelUpResult ? '升级测试完成' : '测试完成') : '练习完成' }}</h2>
        <!-- 总结表格（T031/T034/T036）：表头=间隔天数，每行一个单词（复习/练习模式） -->
        <div v-if="practiceMode !== 'test' && summaryWords.length" class="summary-wrap">
          <h3>{{ practiceMode === 'review' ? '本次复习单词间隔状态' : '本次练习单词状态' }}</h3>
          <table class="vocab-table">
            <thead>
              <tr><th>单词</th><th>状态</th><th v-for="iv in INTERVAL_COLS" :key="iv">{{ iv }}天</th><th>已掌握</th></tr>
            </thead>
            <tbody>
              <tr v-for="w in summaryWords" :key="w.wordId">
                <td class="word">{{ w.word }}</td>
                <td :class="'status ' + w.status">{{ w.status === 'mastered' ? '已掌握' : w.status === 'candidate' ? '待测试' : '学习中' }}</td>
                <td v-for="iv in INTERVAL_COLS" :key="iv" :class="{ on: w.status === 'learning' && w.interval === iv }">
                  {{ w.status === 'learning' && w.interval === iv ? "✓" : "" }}
                </td>
                <td :class="{ on: w.status === 'mastered' }">{{ w.status === 'mastered' ? "✓" : "" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- T037：无入本词时的提示 -->
        <div v-else-if="practiceMode === 'practice'" class="summary-wrap empty">
          <p>本次练习没有加入生词本的单词（拼不出时点「提示」即可加入）</p>
        </div>
        <div v-if="practiceMode === 'test'" class="stats">
          <div class="stat">
            <span class="num">{{ testStats.pass }}/{{ testStats.total }}</span>
            <span class="label">拼对 / 测试词数（{{ testStats.total ? Math.round((testStats.pass / testStats.total) * 100) + "%" : "—" }}）</span>
          </div>
          <div class="stat">
            <span class="num">{{ todayList.length }}/{{ total }}</span>
            <span class="label">完成句子（T044：与进度一致，1 句含多个生词）</span>
          </div>
          <div class="stat">
            <span class="num">{{ elapsedText }}</span>
            <span class="label">总用时</span>
          </div>
        </div>
        <div v-else class="stats">
          <div class="stat">
            <span class="num">{{ todayList.length }}</span>
            <span class="label">完成句子</span>
          </div>
          <div class="stat">
            <span class="num">{{ elapsedText }}</span>
            <span class="label">总用时</span>
          </div>
        </div>
        <div v-if="practiceMode === 'test' && testStats.fails.length" class="fail-list">
          <h3>本次错词（已自动进复习队列）</h3>
          <p class="fail-words">{{ testStats.fails.join(" · ") }}</p>
        </div>
        <div v-if="practiceMode === 'test' && !testStats.fails.length" class="fail-list">
          <h3>🎉 全部拼对，无错词</h3>
        </div>
        <div class="done-actions">
          <button @click="phase = 'menu'; sentence = null">返回首页</button>
          <!-- T037：练习统计页「立即复习」（必含本次练习入本句） -->
          <button v-if="practiceMode === 'practice'" class="danger" @click="onImmediateReview">立即复习</button>
          <button class="primary" @click="onStart(practiceMode)">再来一轮</button>
        </div>
      </div>

      <!-- T045：掌握徽章浮窗 -->
      <div v-if="masteryBadge" class="mastery-badge">
        <div class="badge-stamp">MASTERED ✓</div>
        <div class="badge-words">{{ masteryBadge }}</div>
      </div>
      <!-- T045：里程碑徽章 -->
      <div v-if="milestoneBadge" class="milestone-badge">
        <div class="milestone-title">{{ milestoneBadge.title }}</div>
        <div class="milestone-desc">{{ milestoneBadge.desc }}</div>
      </div>

      <!-- 到期词查看（T031） -->
      <div v-if="dueWordsModal" class="modal-mask" @click.self="dueWordsModal = false">
        <div class="modal">
          <h3>到期词（{{ dueWordsList.length }} 个）</h3>
          <div class="modal-scroll">
            <table class="vocab-table">
              <thead>
                <tr><th>单词</th><th>状态</th><th v-for="iv in INTERVAL_COLS" :key="iv">{{ iv }}天</th><th>已掌握</th></tr>
              </thead>
              <tbody>
                <tr v-for="w in dueWordsList" :key="w.wordId">
                  <td class="word">{{ w.word }}</td>
                  <td :class="'status ' + w.status">{{ w.status === 'mastered' ? '已掌握' : w.status === 'candidate' ? '待测试' : '学习中' }}</td>
                  <td v-for="iv in INTERVAL_COLS" :key="iv" :class="{ on: w.status === 'learning' && w.interval === iv }">
                    {{ w.status === 'learning' && w.interval === iv ? "✓" : "" }}
                  </td>
                  <td :class="{ on: w.status === 'mastered' }">{{ w.status === 'mastered' ? "✓" : "" }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="modal-actions">
            <button @click="dueWordsModal = false">关闭</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.practice {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.main {
  flex: 1;
  width: 100%;
  max-width: 860px;
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
}
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}
.title {
  font-size: 22px;
  font-weight: 700;
}
.ghost {
  background: transparent;
  color: #3b6ef6;
  border: 1px solid #3b6ef6;
}
.menu {
  margin: auto;
  width: 100%;
  max-width: 720px;
  text-align: center;
}
.menu-cards {
  display: flex;
  gap: 20px;
  justify-content: center;
}
.menu-card {
  flex: 1;
  background: #fff;
  border-radius: 16px;
  padding: 36px 20px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(31, 36, 48, 0.06);
  transition: transform 0.15s, box-shadow 0.15s;
}
.menu-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 8px 24px rgba(31, 36, 48, 0.1);
}
.card-icon {
  font-size: 40px;
  margin-bottom: 12px;
}
.menu-card h2 {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 8px;
  color: #1f2430;
}
.menu-card p {
  font-size: 13px;
  color: #6b7382;
  line-height: 1.5;
}
.progress {
  color: #6b7382;
  margin-bottom: 12px;
  font-size: 15px;
  text-align: center;
}
.spell-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center; /* T042：input-card(fit-content) 水平居中，短句不再靠左 */
  transform: translateY(-12%);
  overflow: hidden auto; /* T051：纵向滚动兜底，横向禁止（防滚动条） */
}
.input-card {
  background: #fff;
  border-radius: 20px;
  box-shadow: 0 8px 30px rgba(31, 36, 48, 0.08);
  padding: 28px 36px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: fit-content;
  min-width: 360px;
}
.zh .ctx {
  margin-top: 8px;
  font-size: 13px;
  color: #9aa1af;
  font-weight: 400;
}
.en.dict-mode {
  font-size: 36px;
  font-weight: 700;
  color: #1e293b;
  letter-spacing: 2px;
  display: flex;
  align-items: center;
}
.dict-caret {
  color: #2563eb;
  animation: blink 1s step-end infinite;
}
.zh {
  font-size: 34px;
  font-weight: 700;
  margin-bottom: 28px;
  text-align: center;
}
.en {
  font-size: 28px;
  font-weight: 700;
  line-height: 2;
  font-family: "Courier New", monospace;
  min-height: 80px;
  text-align: center;
  white-space: pre-wrap;
  word-break: keep-all;
  overflow-wrap: anywhere; /* T038：超长/无空格粘连句可断行，避免 span 超宽导致居中向左溢出 */
}
/* T051：长句动态字号与行高（句子越长越小） */
.en.size-m {
  font-size: 24px;
  line-height: 1.7;
}
.en.size-l {
  font-size: 21px;
  line-height: 1.6;
}
.en.size-xl {
  font-size: 19px;
  line-height: 1.5;
}
.en > span {
  display: inline-block;
  text-align: center;
}
.en > span + span {
  margin-left: 10px;
}
.en .punct {
  color: #9aa1af;
}
.en .name {
  color: #1f2430;
  font-weight: 700;
}
.en .word-done {
  color: #1d9e54;
}
/* T030：复习模式拼对词红色（与练习/测试绿色区分）；非生词灰色 */
.en.mode-review .word-done {
  color: #c0392b;
}
.en .skipped {
  color: #999;
}
.en .hint-done {
  color: #d66;
  font-weight: 700;
}
.en .hint-active {
  color: #bbb;
  background: #f0f0f4;
}
.en .hint-active .typed {
  color: #1f2430;
}
.en .hint-active .blank {
  color: #bbb;
}
.en .active {
  background: #e6f0ff;
  border-bottom: 4px solid #3b6ef6;
  animation: blink 1s step-end infinite;
}
.en .active .typed {
  color: #1f2430;
}
.en .active .blank {
  color: transparent;
}
.en .todo {
  color: transparent;
}
.en.flash .active {
  border-bottom-color: #e33;
  color: #e33;
  animation: none;
}
@keyframes blink {
  50% {
    border-bottom-color: transparent;
  }
}
.actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 16px;
}
.actions button {
  font-size: 15px;
  padding: 10px 22px;
}
.danger {
  background: #d66;
}
.tip {
  margin-top: 14px;
  color: #9aa1af;
  font-size: 14px;
  text-align: center;
}
.error {
  color: #d33;
  margin-top: 10px;
  text-align: center;
}
.info {
  color: #2a7d32;
  margin-top: 10px;
  text-align: center;
}

/* 报告描述输入框（T020） */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: #fff;
  border-radius: 12px;
  padding: 20px 24px;
  width: min(420px, 90vw);
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
}
.modal h3 {
  margin: 0 0 6px;
}
.modal-tip {
  margin: 0 0 10px;
  color: #888;
  font-size: 13px;
}
.modal textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #ccc;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  resize: vertical;
}
.modal-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 14px;
}
.modal-actions.wrap {
  flex-wrap: wrap;
}
.fail-list {
  margin-top: 16px;
  text-align: center;
}
.fail-list h3 {
  margin: 0 0 6px;
  font-size: 15px;
}
.fail-words {
  color: #c0392b;
  margin: 0;
}

/* T035：整句完成待回车提示 */
.done-wait {
  margin-top: 12px;
  padding: 10px 14px;
  background: #e8f7ee;
  border: 1px solid #b7e4c7;
  border-radius: 8px;
  color: #1d9e54;
  text-align: center;
}
.done-wait strong {
  font-size: 16px;
}
/* T035：完成态单词可点击（hover 提示） */
.en .word-done,
.en .hint-done {
  cursor: default;
}

/* T029/T031 到期横幅 */
.due-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  background: linear-gradient(135deg, #fff3e0, #ffe0b2);
  border: 2px solid #ff9800;
  border-radius: 12px;
  padding: 14px 18px;
  margin-bottom: 18px;
  box-shadow: 0 2px 8px rgba(255, 152, 0, 0.25);
}
.due-banner span {
  flex: 1;
}
.due-banner strong {
  color: #d46b08;
  font-size: 18px;
}
.due-banner button.plain {
  background: transparent;
  border: 1px solid #ccc;
}

/* T031 总结表格 / 到期词弹窗表格 */
.summary-wrap {
  margin-top: 16px;
  text-align: center;
}
.summary-wrap h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.summary-wrap.empty p {
  color: #999;
  margin: 0;
}
.vocab-table {
  margin: 0 auto;
  border-collapse: collapse;
  font-size: 14px;
}
.vocab-table th,
.vocab-table td {
  border: 1px solid #ddd;
  padding: 6px 10px;
  text-align: center;
  min-width: 44px;
}
.vocab-table td.word {
  font-weight: 700;
}
.vocab-table td.on {
  color: #d46b08;
  font-weight: 700;
  background: #fff7e6;
}
.modal-scroll {
  max-height: 60vh;
  overflow: auto;
  margin: 12px 0;
}

/* T036：状态列配色 */
.vocab-table td.status.new {
  color: #999;
}
.vocab-table td.status.learning {
  color: #1d9e54;
}
.vocab-table td.status.mastered {
  color: #d46b08;
  font-weight: 700;
}
.vocab-table td.status.candidate {
  color: #c0392b;
  font-weight: 700;
}
/* T036：加入生词本弹窗突出单词 */
.highlight-word {
  font-size: 24px;
  font-weight: 800;
  color: #c0392b;
  letter-spacing: 1px;
  margin: 0 4px;
}

/* T053b：升级测试限时 + 升级结果 */
.level-timer {
  margin-top: 12px;
  color: #c0392b;
  font-weight: 700;
  font-size: 15px;
}
.levelup-result {
  text-align: center;
  margin-bottom: 16px;
  padding: 16px;
  background: linear-gradient(135deg, #fffbe6, #ffe58f);
  border: 2px solid #ffd700;
  border-radius: 14px;
}
.levelup-title {
  font-size: 26px;
  font-weight: 800;
  color: #d48806;
}
.levelup-level {
  margin-top: 6px;
  font-size: 16px;
  color: #6b4e00;
}

/* T045：掌握徽章浮窗（居中印章） */
.mastery-badge {
  position: fixed;
  top: 32%;
  left: 50%;
  transform: translateX(-50%);
  background: linear-gradient(135deg, #fffbe6, #ffe58f);
  border: 3px solid #ffd700;
  border-radius: 16px;
  padding: 18px 34px;
  text-align: center;
  z-index: 200;
  box-shadow: 0 8px 30px rgba(255, 193, 7, 0.45);
  animation: badge-pop 0.35s ease-out;
}
.badge-stamp {
  font-size: 22px;
  font-weight: 800;
  color: #d48806;
  letter-spacing: 2px;
}
.badge-words {
  margin-top: 6px;
  font-size: 26px;
  font-weight: 800;
  color: #c0392b;
}
@keyframes badge-pop {
  0% { transform: translateX(-50%) scale(0.4); opacity: 0; }
  70% { transform: translateX(-50%) scale(1.08); opacity: 1; }
  100% { transform: translateX(-50%) scale(1); }
}
/* T045：里程碑徽章（全屏居中大卡） */
.milestone-badge {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  z-index: 300;
  animation: fade-in 0.3s;
}
.milestone-title {
  font-size: 40px;
  font-weight: 800;
  color: #ffd700;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
}
.milestone-desc {
  margin-top: 10px;
  font-size: 22px;
  color: #fff;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.done {
  margin: auto;
  text-align: center;
  background: #fff;
  padding: 36px 48px;
  border-radius: 12px;
}
.done h2 {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 24px;
}
.stats {
  display: flex;
  justify-content: center;
  gap: 48px;
  margin-bottom: 28px;
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.stat .num {
  font-size: 42px;
  font-weight: 700;
  color: #3b6ef6;
}
.stat .label {
  margin-top: 6px;
  color: #6b7382;
  font-size: 14px;
}
.done button {
  font-size: 16px;
  padding: 12px 32px;
}
.done-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}
.done-actions .primary {
  background: #3b6ef6;
  color: #fff;
}

/* ---- 顶栏右侧 ---- */
.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* ---- 连击徽章 ---- */
.streak-badge {
  background: linear-gradient(135deg, #ff6b6b, #ff9ff3);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  padding: 4px 14px;
  border-radius: 20px;
  animation: streak-pulse 1.2s ease-in-out infinite;
}
@keyframes streak-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.08); }
}

/* ---- 滑动翻页 ---- */
.slide-exit {
  animation: slide-out 0.4s ease-in; /* T038：去掉 forwards，异常残留时元素仍居中 */
}
.slide-enter {
  animation: slide-in 0.4s ease-out;
}
@keyframes slide-out {
  0% { transform: translateX(0); opacity: 1; }
  100% { transform: translateX(-60px); opacity: 0; }
}
@keyframes slide-in {
  0% { transform: translateX(60px); opacity: 0; }
  100% { transform: translateX(0); opacity: 1; }
}

/* ---- 彩色纸屑 ---- */
.confetti-container {
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  pointer-events: none;
  z-index: 999;
  overflow: hidden;
}
.confetti-particle {
  position: absolute;
  border-radius: 2px;
  pointer-events: none;
  opacity: 0;
  animation: confetti-burst var(--dur) ease-out var(--del) forwards;
}
@keyframes confetti-burst {
  0% {
    transform: translate(0, 0) rotate(0deg);
    opacity: 1;
  }
  60% {
    opacity: 1;
  }
  100% {
    transform: translate(var(--tx), var(--ty)) rotate(var(--tr));
    opacity: 0;
  }
}
</style>
