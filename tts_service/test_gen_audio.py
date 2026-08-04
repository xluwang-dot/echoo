#!/usr/bin/env python3
"""T012 gen_audio 生成逻辑单元测试（TDD）

用 sqlite 内存库 + 临时音频目录，覆盖：
  - 主流程函数（生成单句音频、upsert audio 表）
  - 断点续跑（已生成句子跳过）
  - duration 解析
"""
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from gen_audio import (
    AUDIO_SCHEMA,
    find_pending_sentences,
    generate_one,
    upsert_audio,
    load_sentences,
    probe_duration,
)


class GenAudioTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.audio_dir = self.tmp.name
        self.db_path = os.path.join(self.tmp.name, "test.db")
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(AUDIO_SCHEMA)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS sentences (id INTEGER PRIMARY KEY, en TEXT, zh TEXT)"
        )
        # 3 句
        self.conn.execute("INSERT INTO sentences (id, en, zh) VALUES (1, 'Hello world.', '你好世界。')")
        self.conn.execute("INSERT INTO sentences (id, en, zh) VALUES (2, 'Good morning.', '早上好。')")
        self.conn.execute("INSERT INTO sentences (id, en, zh) VALUES (3, 'How are you?', '你好吗？')")
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_load_sentences(self):
        rows = load_sentences(self.conn)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["id"], 1)
        self.assertEqual(rows[0]["en"], "Hello world.")

    def test_find_pending_all(self):
        pending = find_pending_sentences(self.conn)
        self.assertEqual({p["id"] for p in pending}, {1, 2, 3})

    def test_find_pending_skips_generated(self):
        # 已有 1 号句的音频记录 → 跳过
        self.conn.execute(
            "INSERT INTO audio (sentence_id, file_path, duration_ms) VALUES (1, 'data/audio/1.wav', 1500)"
        )
        self.conn.commit()
        pending = find_pending_sentences(self.conn)
        self.assertEqual({p["id"] for p in pending}, {2, 3})

    def test_upsert_audio_insert(self):
        upsert_audio(self.conn, 1, "data/audio/1.wav", 1200)
        row = self.conn.execute("SELECT * FROM audio WHERE sentence_id = 1").fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row[2], "data/audio/1.wav")
        self.assertEqual(row[3], 1200)

    def test_upsert_audio_idempotent(self):
        upsert_audio(self.conn, 1, "data/audio/1.wav", 1200)
        upsert_audio(self.conn, 1, "data/audio/1.wav", 1400)
        rows = self.conn.execute("SELECT COUNT(*) FROM audio WHERE sentence_id = 1").fetchone()
        self.assertEqual(rows[0], 1)
        row = self.conn.execute("SELECT duration_ms FROM audio WHERE sentence_id = 1").fetchone()
        self.assertEqual(row[0], 1400)

    def test_word_offsets_null_by_default(self):
        upsert_audio(self.conn, 1, "data/audio/1.wav", 1000)
        row = self.conn.execute("SELECT word_offsets FROM audio WHERE sentence_id = 1").fetchone()
        self.assertIsNone(row[0])

    def test_generate_one_with_fake_audio(self):
        # ffmpeg 生成 1 秒静音 wav 作为伪音频（不联网）
        import subprocess

        def fake_synth(en_text):
            wav = os.path.join(self.tmp.name, "fake.wav")
            subprocess.run(
                ["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                 "-t", "1", "-ar", "24000", wav],
                capture_output=True, check=True,
            )
            with open(wav, "rb") as f:
                return f.read()

        out = generate_one(self.conn, {"id": 1, "en": "Hello world."}, self.tmp.name, fake_synth)
        self.assertTrue(out.exists())
        # 文件落盘在 audio_dir
        self.assertEqual(out.name, "1.wav")
        # audio 表有记录
        row = self.conn.execute("SELECT * FROM audio WHERE sentence_id = 1").fetchone()
        self.assertEqual(row[2], "data/audio/1.wav")
        # 时长 ~1s
        self.assertAlmostEqual(row[3], 1000, delta=100)

    def test_probe_duration(self):
        import subprocess
        wav = os.path.join(self.tmp.name, "t.wav")
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
             "-t", "2", "-ar", "24000", wav],
            capture_output=True, check=True,
        )
        self.assertAlmostEqual(probe_duration(wav), 2000, delta=100)


if __name__ == "__main__":
    unittest.main()
