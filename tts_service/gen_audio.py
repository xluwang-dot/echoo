#!/usr/bin/env python3
"""
T012 TTS 阶段一：mimo 整句音频生成 + 落盘 + 写 audio 表。

音频（二进制）落盘到 AUDIO_DIR，绝不进数据库；DB 只存文件路径引用。

环境变量:
    MIMO_API_KEY  必需
    MIMO_VOICE    预设英文女声（默认 Mia）
    DB_PATH       SQLite 路径（默认 ../data/word_typer.db）
    AUDIO_DIR     音频目录（默认 ../data/audio）

用法:
    python3 gen_audio.py --limit 10     # 生成前 10 句（断点续跑）
    python3 gen_audio.py --sentence 5    # 指定生成某句
"""
import argparse
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

AUDIO_SCHEMA = """
CREATE TABLE IF NOT EXISTS audio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sentence_id INTEGER NOT NULL,
  file_path TEXT,
  duration_ms INTEGER,
  word_offsets TEXT
);
"""


def _audio_dir():
    return Path(os.environ.get("AUDIO_DIR", str(Path(__file__).resolve().parent.parent / "data" / "audio")))


def load_sentences(conn):
    """读全部句子（id, en）"""
    rows = conn.execute("SELECT id, en FROM sentences ORDER BY id").fetchall()
    return [{"id": r["id"], "en": r["en"]} for r in rows]


def find_pending_sentences(conn):
    """未生成音频的句子（audio 表无记录）→ 断点续跑"""
    rows = conn.execute(
        "SELECT s.id, s.en FROM sentences s "
        "WHERE NOT EXISTS (SELECT 1 FROM audio a WHERE a.sentence_id = s.id) "
        "ORDER BY s.id"
    ).fetchall()
    return [{"id": r["id"], "en": r["en"]} for r in rows]


def upsert_audio(conn, sentence_id, file_path, duration_ms):
    exists = conn.execute(
        "SELECT id FROM audio WHERE sentence_id = ?", (sentence_id,)
    ).fetchone()
    if exists:
        conn.execute(
            "UPDATE audio SET file_path = ?, duration_ms = ? WHERE sentence_id = ?",
            (file_path, duration_ms, sentence_id),
        )
    else:
        conn.execute(
            "INSERT INTO audio (sentence_id, file_path, duration_ms, word_offsets) VALUES (?, ?, ?, NULL)",
            (sentence_id, file_path, duration_ms),
        )
    conn.commit()


def probe_duration(wav_path):
    """ffprobe 实测时长（毫秒）"""
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(wav_path)],
        capture_output=True, text=True,
    )
    return int(float(result.stdout.strip()) * 1000)


def synthesize(en_text, voice=None):
    """调 mimo TTS 返回 (wav_bytes)。网络层，测试用 mock 替换。"""
    voice = voice or os.environ.get("MIMO_VOICE", "Mia")
    from openai import OpenAI
    api_key = os.environ.get("MIMO_API_KEY")
    if not api_key:
        raise RuntimeError("请设置 MIMO_API_KEY")
    client = OpenAI(api_key=api_key, base_url="https://api.xiaomimimo.com/v1")
    completion = client.chat.completions.create(
        model="mimo-v2.5-tts",
        messages=[
            {"role": "user", "content": "缓慢清晰，语速适中，适合英语学习者跟读。"},
            {"role": "assistant", "content": en_text},
        ],
        audio={"format": "wav", "voice": voice},
    )
    import base64
    return base64.b64decode(completion.choices[0].message.audio.data)


def generate_one(conn, sentence, audio_dir=None, synth=None):
    """生成单句音频并写 audio 表。synth 可注入（测试用伪音频）。"""
    audio_dir = Path(audio_dir) if audio_dir else _audio_dir()
    audio_dir.mkdir(parents=True, exist_ok=True)
    out_path = audio_dir / f"{sentence['id']}.wav"
    wav_bytes = (synth or synthesize)(sentence["en"])
    out_path.write_bytes(wav_bytes)
    duration = probe_duration(out_path)
    rel = f"data/audio/{sentence['id']}.wav"
    upsert_audio(conn, sentence["id"], rel, duration)
    return out_path


def main():
    parser = argparse.ArgumentParser(description="TTS 整句音频生成")
    parser.add_argument("--limit", type=int, default=None, help="最多生成 N 句")
    parser.add_argument("--sentence", type=int, default=None, help="指定句子 id")
    args = parser.parse_args()

    import sqlite3
    db_path = os.environ.get("DB_PATH", str(Path(__file__).resolve().parent.parent / "data" / "word_typer.db"))
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    # 确保 audio 表存在
    conn.executescript(AUDIO_SCHEMA)
    conn.commit()

    if args.sentence is not None:
        targets = [s for s in load_sentences(conn) if s["id"] == args.sentence]
    else:
        targets = find_pending_sentences(conn)
    if args.limit:
        targets = targets[: args.limit]

    voice = os.environ.get("MIMO_VOICE", "Mia")
    done = 0
    for s in targets:
        try:
            generate_one(conn, s, synth=synthesize)
            print(f"[{s['id']}] ok: {s['en']}")
            done += 1
        except Exception as e:
            print(f"❌ [{s['id']}] {s['en']} -> {e}")
    print(f"完成 {done}/{len(targets)}")


if __name__ == "__main__":
    main()