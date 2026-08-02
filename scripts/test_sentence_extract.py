# -*- coding: utf-8 -*-
"""T002 阶段A：答案区解析测试（表格格式 2015-2020 + 行式格式 2021-2025）"""
import unittest
import sys
import os
import re

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import sentence_extract as se


TABLE_2015 = """| 题号 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|------|---|---|---|---|---|---|---|---|
| 答案 | B | C | B | C | A | C | B | A |"""

TABLE_READING = """| 题号 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 |
|------|----|----|----|----|----|----|----|----|----|----|
| 答案 | B | C | A | C | D | A | B | D | C | A |"""

LINES_2021 = "**答案：1. B  2. C  3. D  4. C  5. D  6. B  7. D  8. A  9. C  10. B**"

LINES_SPLIT = "**答案：31. B    32. D**\n33. C    34. F\n35. A"


class TestParseAnswerTables(unittest.TestCase):
    def test_single_table(self):
        seg = se.parse_answer_tables(TABLE_2015)
        self.assertEqual(len(seg), 1)
        self.assertEqual(seg[0], {1: "B", 2: "C", 3: "B", 4: "C", 5: "A", 6: "C", 7: "B", 8: "A"})

    def test_multiple_tables(self):
        text = TABLE_2015 + "\n\n" + TABLE_READING
        seg = se.parse_answer_tables(text)
        self.assertEqual(len(seg), 2)
        self.assertEqual(seg[1][26], "B")
        self.assertEqual(seg[1][35], "A")

    def test_reading_table_10_cols(self):
        seg = se.parse_answer_tables(TABLE_READING)
        self.assertEqual(len(seg[0]), 10)


class TestParseAnswerLines(unittest.TestCase):
    def test_single_line(self):
        ans = se.parse_answer_lines(LINES_2021)
        self.assertEqual(ans[1], "B")
        self.assertEqual(ans[10], "B")
        self.assertEqual(len(ans), 10)

    def test_split_across_lines(self):
        ans = se.parse_answer_lines(LINES_SPLIT)
        self.assertEqual(ans, {31: "B", 32: "D", 33: "C", 34: "F", 35: "A"})

    def test_empty(self):
        self.assertEqual(se.parse_answer_lines(""), {})


class TestGetAnswers(unittest.TestCase):
    def test_table_and_lines_dispatch(self):
        seg = se.get_answers("2015", TABLE_2015)
        self.assertEqual(seg[1], "B")
        ans = se.get_answers("2021", LINES_2021)
        self.assertEqual(ans[1], "B")
        ans2 = se.get_answers("2022", LINES_SPLIT)
        self.assertEqual(ans2[35], "A")


# ---------- 画线词提取 ----------

UNDER_U = "--- <u>In my opinion</u>, studying abroad is not suitable for teenagers."
UNDER_STAR = "1. — **More than** 400 street gardens will be built in Shenzhen next year."


class TestUnderline(unittest.TestCase):
    def test_u_tag(self):
        self.assertEqual(se.extract_underline(UNDER_U), ["In my opinion"])

    def test_star_tag(self):
        self.assertEqual(se.extract_underline(UNDER_STAR), ["More than"])

    def test_mark_convert_u_to_star(self):
        marked, words = se.mark_underline(UNDER_U)
        self.assertIn("**In my opinion**", marked)
        self.assertNotIn("<u>", marked)
        self.assertEqual(words, ["In my opinion"])

    def test_mark_keep_star(self):
        marked, words = se.mark_underline(UNDER_STAR)
        self.assertEqual(marked, "1. — **More than** 400 street gardens will be built in Shenzhen next year.")
        self.assertEqual(words, ["More than"])

    def test_no_underline(self):
        self.assertEqual(se.extract_underline("plain sentence."), [])


# ---------- 近义词题提取 ----------

NEAR_2015 = """ⅰ. 从下面每小题的 A、B、C三个选项中选出可以替换划线部分的最佳选项。

(   ) 1. ---Dad, I’m considering going to Italy to study art this year.

--- <u>In my opinion</u>, studying abroad is not suitable for teenagers.

A. I don’t agree			B. I think					C. In general

(   ) 2. ---Have you <u>heard from</u> Sarah recently?

---No. I lost touch with her two years ago.

A. heard about				B. written to				C. got a letter from

(   ) 3. ---We are going to hold a party to raise money for our club this weekend.

---Sounds great! I will help you if I am <u>available</u>.

A. busy					B. free					C. pleased"""

NEAR_2018 = """**i. 从下面每小题的A、B、C三个选项中选出可以替换画线部分的最佳选项。**

1. — **More than** 400 street gardens will be built in Shenzhen next year.
—Good news! Our city is becoming more and more beautiful.
A. Over      B. Around      C. Nearly

2. —Tim, you spend too much time on computers. It's **harmful** to your eyes.
—I see. Thank you. I'll do more sports instead.
A. is good for      B. is bad for      C. is useful to"""


class TestNearSynonym(unittest.TestCase):
    def test_u_tag_2015(self):
        qs = se.near_synonym_questions(NEAR_2015, "2015")
        self.assertEqual(len(qs), 3)
        self.assertEqual(qs[0]["n"], 1)
        self.assertIn("<u>In my opinion</u>", qs[0]["stem"])  # 原始标记保留
        self.assertEqual(qs[0]["underline"], ["In my opinion"])

    def test_u_tag_marked(self):
        qs = se.near_synonym_questions(NEAR_2015, "2015")
        marked, _ = se.mark_underline(qs[0]["stem"])
        self.assertIn("**In my opinion**", marked)
        self.assertNotIn("<u>", marked)

    def test_star_tag_2018(self):
        qs = se.near_synonym_questions(NEAR_2018, "2018")
        self.assertEqual(len(qs), 2)
        self.assertEqual(qs[0]["underline"], ["More than"])
        self.assertIn("**More than**", qs[0]["stem"])

    def test_only_underline_questions(self):
        qs = se.near_synonym_questions(NEAR_2015, "2015")
        for q in qs:
            self.assertTrue(q["underline"])


# ---------- 完形填空选项解析 ----------

OPT_TAB = "(   ) 16. A. nobody\t\t\tB. somebody\t\t\tC. anybody"
OPT_GLUED = "16.A.usually  B.only  C.hardly"
OPT_NEW = "1. A. house  B. flat  C. street  D. area"
OPT_EMSP = "16. A. loved &emsp; B. missed &emsp; C. called"


class TestParseOptions(unittest.TestCase):
    def test_tab_sep(self):
        self.assertEqual(se.parse_options(OPT_TAB), {16: {"A": "nobody", "B": "somebody", "C": "anybody"}})

    def test_glued(self):
        self.assertEqual(se.parse_options(OPT_GLUED), {16: {"A": "usually", "B": "only", "C": "hardly"}})

    def test_four_options(self):
        self.assertEqual(se.parse_options(OPT_NEW), {1: {"A": "house", "B": "flat", "C": "street", "D": "area"}})

    def test_emsp(self):
        self.assertEqual(se.parse_options(OPT_EMSP), {16: {"A": "loved", "B": "missed", "C": "called"}})


# ---------- 完形填空填空位替换 ----------

CLOZE_SUB = "It started 30 years ago with a squirrel. A few months after I had moved into a downtown_1_ my next-door neighbor, Nicole Figaro, knocked."
CLOZE_SPACE = "When I was in Grade Seven, I volunteered at a hospital. I usually stayed with Mr. Gillespie---a patient in a coma（昏迷）. He never had any visitors, and    16    seemed to care about him."
CLOZE_UNDER = "I was young, I went to a boarding school. It was far from home because I __16__ on an island in the north of Scotland."


class TestFillCloze(unittest.TestCase):
    def test_subscript(self):
        out, word = se.fill_cloze(CLOZE_SUB, 1, "flat")
        self.assertIn("**flat**", out)
        self.assertNotIn("_1_", out)

    def test_space_wrapped(self):
        out, word = se.fill_cloze(CLOZE_SPACE, 16, "nobody")
        self.assertIn("**nobody**", out)
        self.assertNotIn(" 16 ", out)

    def test_underscore(self):
        out, word = se.fill_cloze(CLOZE_UNDER, 16, "lived")
        self.assertIn("**lived**", out)
        self.assertNotIn("__16__", out)

    def test_no_slot(self):
        out, word = se.fill_cloze("no slot here", 5, "word")
        self.assertIsNone(word)


# ---------- 完形区域定位 ----------

REGION_2015 = [
    "## Ⅱ.\t完形填空（15分）",
    "",
    "阅读下面短文，从短文后所给的 A、B、C 三个选项中选出最佳选项。(共10小题)",
    "He never had any visitors, and    16    seemed to care about him.",
    "(   ) 16. A. nobody\t\t\tB. somebody\t\t\tC. anybody",
    "## Ⅲ. 阅读理解",
    "### A",
]

REGION_2016 = [
    "II.完形填空(15分)",
    "阅读下面短文，从短文后所给的A、B、C三个选项中选出最佳选项。",
    "During my whole life I have received the  24  from many strangers.",
    "### A",
]

REGION_2022 = [
    "## I. 完 形 填 空 ( 1 0 分 )",
    "阅读下面短文，从短文后所给的A、B、C、D四个选项中选出最佳选项。",
    "When she was ten, she asked her parents if they could ___1___ a cow.",
    "## Ⅱ . 阅 读 理 解 ( 4 0 分 )",
]


class TestClozeRegion(unittest.TestCase):
    def test_2015_format(self):
        self.assertEqual(se._cloze_region(REGION_2015), (0, 5))

    def test_2016_no_reading_title(self):
        self.assertEqual(se._cloze_region(REGION_2016), (0, 3))

    def test_2022_spaced_title(self):
        self.assertEqual(se._cloze_region(REGION_2022), (0, 3))

    def test_no_cloze(self):
        self.assertIsNone(se._cloze_region(["### A", "plain text"]))


# ---------- 完形填空填空位特殊格式 ----------

CLOZE_GLUED_UNDER = "Without her, I couldn't go through  9_times."
CLOZE_QUOTED = 'I feel sorry that I can\'t find them and say " 25  ".'
CLOZE_TRIPLE = "her parents if they could ___1___ a cow."


class TestFillClozeExtras(unittest.TestCase):
    def test_glued_underscore(self):
        out, word = se.fill_cloze(CLOZE_GLUED_UNDER, 9, "difficult")
        self.assertIn("**difficult**", out)
        self.assertNotIn(" 9_", out)
        self.assertNotIn("_t", out)  # 粘连下划线应被吃掉

    def test_quoted_slot(self):
        out, word = se.fill_cloze(CLOZE_QUOTED, 25, "Thank you")
        self.assertIn("**Thank you**", out)

    def test_triple_underscore(self):
        out, word = se.fill_cloze(CLOZE_TRIPLE, 1, "keep")
        self.assertIn("**keep**", out)


# ---------- 完形 correct 句端到端 ----------

BODY_2015 = """## Ⅱ.\t完形填空（15分）

阅读下面短文，从短文后所给的 A、B、C 三个选项中选出能填入相应空白处的最佳选项。(共10小题，每小题1分)

I volunteered at a hospital. He never had any visitors, and    16    seemed to care about him. As a volunteer, I spent many days   17    his hand.

(   ) 16. A. nobody\t\t\tB. somebody\t\t\tC. anybody
(   ) 17. A. holding\t\t\tB. holding up\t\t\tC. hold

## Ⅲ.	阅读理解

### A
The group of boys decided to play a game to see who could climb to the top first.

What does paragraph 3 mainly talk about?
"""

ANS_2015 = {16: "A", 17: "A"}


class TestClozeCorrectSentences(unittest.TestCase):
    def test_extracts_marked_sentences(self):
        cs = se.cloze_correct_sentences(BODY_2015, ANS_2015)
        self.assertEqual(len(cs), 2)
        self.assertEqual(cs[0]["n"], 16)
        self.assertIn("**nobody**", cs[0]["sent"])
        self.assertIn("**holding**", cs[1]["sent"])

    def test_spec_line_excluded(self):
        cs = se.cloze_correct_sentences(BODY_2015, ANS_2015)
        for c in cs:
            self.assertNotIn("共10小题", c["sent"])

    def test_reading_region_excluded(self):
        cs = se.cloze_correct_sentences(BODY_2015, ANS_2015)
        self.assertEqual(len(cs), 2)  # 阅读区句子（含数字/选项词）不入完形


# ---------- 阅读题解析 ----------

READING_2015 = """### A
**Photography Club**
Miss Yang will teach you how to take better photos.
Time: 3:30 p.m.---4:30 p.m.

(   ) 26. Miss Yang will teach you __________.

A. how to take better photos\t\t\t\t\tB. how to realize your dream

C. how to make a piece of music\t\t\t\tD. how to study insects

(   ) 27. Which club should you join to make a robot?

A. The Robot Club\t\t\tB. The Music Club

C. The Crazy Team\t\t\t\tD. The Insect Club
"""

READING_2020 = """### A
An exhibition showing late master Frank Yang's old photos.

26. Which line can you take to enjoy Cassie Chen's Photos?
A. Line 11. B. Line 4. C. Line 3. D. Line 1.

27. Where can you probably read the passage?
A. In a storybook. B. In a newspaper. C. In a science book. D. In a travel guide.
"""

READING_2021 = """### A
In the 1940s, villagers in Shashiyu had little food and few clothes. Led by the Communist Party, the villagers carried water and soil to their village to improve their lands.

**12. From 1966 to 1971, what did the villagers do to improve their living situation?**
A. They planted grapes to earn money.
B. They carried water and soil to their village to improve their lands.
C. They moved to another place to live a better life.
D. They built a lot of factories.
"""


class TestParseReadingQuestions(unittest.TestCase):
    def test_2015_cross_line(self):
        lines = READING_2015.splitlines()
        qs = se.parse_reading_questions(lines, 2, len(lines))
        self.assertEqual([q["n"] for q in qs], [26, 27])
        self.assertEqual(qs[0]["options"]["A"], "how to take better photos")
        self.assertEqual(qs[0]["options"]["D"], "how to study insects")
        self.assertEqual(qs[1]["options"]["C"], "The Crazy Team")

    def test_2020_one_line_four(self):
        lines = READING_2020.splitlines()
        qs = se.parse_reading_questions(lines, 2, len(lines))
        self.assertEqual(len(qs), 2)
        self.assertEqual(qs[0]["options"], {"A": "Line 11.", "B": "Line 4.", "C": "Line 3.", "D": "Line 1."})

    def test_2021_one_per_line(self):
        lines = READING_2021.splitlines()
        qs = se.parse_reading_questions(lines, 2, len(lines))
        self.assertEqual(qs[0]["n"], 12)
        self.assertEqual(
            qs[0]["options"]["B"],
            "They carried water and soil to their village to improve their lands.",
        )


# ---------- 阅读 correct 回溯 ----------

READING_MATCH = """### A
Shashiyu was once a poor village in Hebei Province. Led by the Communist Party, the villagers carried water and soil to their village to improve their lands.

**12. What did the villagers do to improve their lands?**
A. They planted grapes to earn money.
B. They carried water and soil to their village to improve their lands.
C. They moved to another place to live a better life.
D. They built a lot of factories.

### B
Another village story. The villagers grew grapes and built new houses.

**15. What did the villagers in the second village do?**
A. They planted grapes. B. They carried water. C. They grew grapes. D. They built factories.
"""

READING_NO_MATCH = """### A
An exhibition showing late master Frank Yang's old photos.

26. Which line can you take to enjoy Cassie Chen's Photos?
A. Line 11. B. Line 4. C. Line 3. D. Line 1.
"""


class TestReadingCorrect(unittest.TestCase):
    def test_backtrack_to_passage_sentence(self):
        cs = se.reading_correct_sentences(READING_MATCH, {12: "B", 15: "C"}, "2021")
        self.assertEqual(len(cs), 2)
        c12 = [c for c in cs if c["n"] == 12][0]
        self.assertIn("**carried**", c12["sent"])
        self.assertIn("water", c12["sent"])
        self.assertIn("carried", c12["words"])

    def test_passage_b_sentence(self):
        cs = se.reading_correct_sentences(READING_MATCH, {12: "B", 15: "C"}, "2021")
        c15 = [c for c in cs if c["n"] == 15][0]
        self.assertIn("**grew**", c15["sent"])
        self.assertIn("grow", c15["words"])

    def test_no_backtrack(self):
        cs = se.reading_correct_sentences(READING_NO_MATCH, {26: "A"}, "2020")
        self.assertEqual(cs, [])


# ---------- 覆盖检查与聚合 ----------

import word_freq as wf

_FULL = os.path.join(os.path.dirname(__file__), "..", "res", "vocabulary_full.md")


def _lm():
    return se._get_lemmatizer()


class TestWordsInSent(unittest.TestCase):
    def test_extract_wordset_words(self):
        ws = se.words_in_sent("He carried water and soil to the village.", _lm())
        self.assertIn("carried", ws)
        self.assertIn("water", ws)
        self.assertNotIn("the", ws)
        self.assertNotIn("and", ws)

    def test_variant_normalized(self):
        ws = se.words_in_sent("She is learning English.", _lm())
        self.assertIn("learn", ws)
        self.assertIn("english", ws)


class TestAggregate(unittest.TestCase):
    def test_all_types_included(self):
        aggs = se.aggregate_correct()
        self.assertIn("2015", aggs)
        by_year = aggs["2015"]
        marks = {m for _, m in by_year}
        self.assertTrue(any("词汇" in m for m in marks))
        self.assertTrue(any("完形" in m for m in marks))
        self.assertTrue(any("阅读" in m for m in marks))

    def test_coverage_count(self):
        _, covered, total = se.build_coverage()
        self.assertGreater(covered, 0)  # 部分词有 correct 句（其余由 body 补全）
        self.assertEqual(total, 2498)

    def test_generate_full_coverage(self):
        path, _, _ = se.generate_study_sentences()
        words_with = set(re.findall(r"^### (\w+)$", open(path, encoding="utf-8").read(), flags=re.M))
        wordset, _ = wf.parse_vocab(_FULL)
        self.assertEqual(len(words_with), len(wordset))
        self.assertEqual(words_with, wordset)


if __name__ == "__main__":
    unittest.main()
