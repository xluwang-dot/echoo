#!/usr/bin/env python3
"""
按句子生成 TTS 并修正 SRT 时间轴

流程:
    1. 读 SRT → 提取每句文本
    2. 每句独立调用 MiMo TTS → 生成临时音频
    3. 实测每句时长 → 累加计算准确时间轴
    4. 输出修正后的 SRT + 合并后的完整音频

使用方法:
    # 预置音色（茉莉/冰糖/苏打/白桦）
    python3 tts-from-srt.py --input script.srt --output voice.mp3 --srt-out script.srt --preset-voice 茉莉

    # 自定义音色（voicedesign 模型）
    python3 tts-from-srt.py --input script.srt --output voice.mp3 --srt-out script.srt --voice "女性 中学老师 温暖"

环境变量:
    MIMO_API_KEY: MiMo API 密钥（必须）
"""

import argparse
import base64
import os
import re
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    from openai import OpenAI
except ImportError:
    print("错误: 需要安装 openai 库")
    print("运行: pip install openai")
    sys.exit(1)

MIMO_BASE_URL = "https://api.xiaomimimo.com/v1"
PRESET_MODEL = "mimo-v2.5-tts"
VOICEDESIGN_MODEL = "mimo-v2.5-tts-voicedesign"
SAMPLE_RATE = 24000
NUM_CHANNELS = 1
BITS_PER_SAMPLE = 16

TIMESTAMP_RE = re.compile(
    r'^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})'
)

API_KEY = os.environ.get('MIMO_API_KEY', '')
if not API_KEY:
    print("错误: 请设置 MIMO_API_KEY 环境变量")
    sys.exit(1)

CLIENT = OpenAI(api_key=API_KEY, base_url=MIMO_BASE_URL)

TMP_DIR = None


def parse_srt(input_path):
    """解析 SRT 文件，返回 [(序号, 原文时间轴, 文本, 场景标记)]"""
    with open(input_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    entries = []
    scene = ''
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith('==='):
            scene = stripped
            i += 1
            continue
        if not stripped:
            i += 1
            continue
        if not stripped.isdigit():
            i += 1
            continue

        num = stripped
        i += 1
        if i >= len(lines):
            break

        ts_match = TIMESTAMP_RE.match(lines[i].strip())
        if not ts_match:
            i += 1
            continue

        original_ts = lines[i].strip()
        i += 1

        text_parts = []
        while i < len(lines) and lines[i].strip() and not TIMESTAMP_RE.match(lines[i].strip()):
            t = lines[i].strip()
            if not t.isdigit():
                text_parts.append(t)
            i += 1

        text = ' '.join(text_parts)
        if text:
            entries.append({
                'num': num,
                'original_ts': original_ts,
                'text': text,
                'scene': scene
            })

    return entries


def ts_to_seconds(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def seconds_to_ts(total_seconds):
    h = int(total_seconds // 3600)
    m = int((total_seconds % 3600) // 60)
    s = int(total_seconds % 60)
    ms = int((total_seconds - int(total_seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def pcm_to_wav(pcm_data, wav_path):
    data_size = len(pcm_data)
    byte_rate = SAMPLE_RATE * NUM_CHANNELS * BITS_PER_SAMPLE // 8
    block_align = NUM_CHANNELS * BITS_PER_SAMPLE // 8
    with open(wav_path, 'wb') as f:
        f.write(b'RIFF')
        f.write(struct.pack('<I', 36 + data_size))
        f.write(b'WAVE')
        f.write(b'fmt ')
        f.write(struct.pack('<I', 16))
        f.write(struct.pack('<H', 1))
        f.write(struct.pack('<H', NUM_CHANNELS))
        f.write(struct.pack('<I', SAMPLE_RATE))
        f.write(struct.pack('<I', byte_rate))
        f.write(struct.pack('<H', block_align))
        f.write(struct.pack('<H', BITS_PER_SAMPLE))
        f.write(b'data')
        f.write(struct.pack('<I', data_size))
        f.write(pcm_data)


def generate_speech(text, voice_desc, tmp_wav, preset_voice=None):
    """调用 MiMo TTS 生成一句语音，返回 WAV 文件路径"""
    if preset_voice:
        completion = CLIENT.chat.completions.create(
            model=PRESET_MODEL,
            messages=[
                {"role": "user", "content": voice_desc},
                {"role": "assistant", "content": text}
            ],
            audio={"format": "pcm16", "voice": preset_voice}
        )
    else:
        completion = CLIENT.chat.completions.create(
            model=VOICEDESIGN_MODEL,
            messages=[
                {"role": "user", "content": voice_desc},
                {"role": "assistant", "content": text}
            ],
            audio={"format": "pcm16"}
        )
    message = completion.choices[0].message
    pcm_data = base64.b64decode(message.audio.data)
    pcm_to_wav(pcm_data, tmp_wav)
    return tmp_wav


def get_duration(audio_path):
    """获取音频时长（秒）"""
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=noprint_wrappers=1:nokey=1', audio_path],
        capture_output=True, text=True
    )
    return float(result.stdout.strip())


def concat_audio(file_list, output_path):
    """用 ffmpeg 合并音频文件"""
    list_path = output_path + '.list'
    with open(list_path, 'w') as f:
        for fp in file_list:
            f.write(f"file '{fp}'\n")
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'concat', '-safe', '0',
         '-i', list_path, '-c', 'copy', output_path],
        capture_output=True, check=True
    )
    os.unlink(list_path)


def format_time(secs):
    m = int(secs) // 60
    s = int(secs) % 60
    return f"{m:02d}:{s:02d}"


def main():
    global TMP_DIR
    parser = argparse.ArgumentParser(description='按句生成 TTS 并修正 SRT')
    parser.add_argument('--input', required=True, help='输入 SRT 文件')
    parser.add_argument('--output', required=True, help='输出合并音频（.mp3）')
    parser.add_argument('--srt-out', required=True, help='输出修正后的 SRT')
    parser.add_argument('--preset-voice', help='预置音色（茉莉/冰糖/苏打/白桦）')
    parser.add_argument('--voice', default='温暖亲切的年轻女老师，语速适中，吐字清晰',
                        help='语音描述（voicedesign 模型用）')
    parser.add_argument('--gap', type=float, default=0.3,
                        help='句间停顿（秒，默认 0.3）')
    args = parser.parse_args()

    if args.preset_voice:
        print(f"使用预置音色: {args.preset_voice}")
    else:
        print(f"使用自定义音色: {args.voice}")

    TMP_DIR = tempfile.mkdtemp(prefix='tts-srt-')
    print(f"临时目录: {TMP_DIR}")

    entries = parse_srt(args.input)
    total = len(entries)
    print(f"解析到 {total} 句字幕\n")

    wav_files = []
    corrected_lines = []
    elapsed = 0.0
    current_scene = ''

    for idx, entry in enumerate(entries, 1):
        text = entry['text']
        scene = entry['scene']

        if scene and scene != current_scene:
            current_scene = scene
            corrected_lines.append(scene)

        print(f"[{idx}/{total}] {format_time(elapsed)} | {text[:40]}{'...' if len(text)>40 else ''}")

        tmp_wav = os.path.join(TMP_DIR, f'sub_{idx:03d}.wav')
        generate_speech(text, args.voice, tmp_wav, preset_voice=args.preset_voice)

        duration = get_duration(tmp_wav)
        wav_files.append(tmp_wav)

        start = elapsed
        end = elapsed + duration
        elapsed = end + args.gap

        ts_line = f"{seconds_to_ts(start)} --> {seconds_to_ts(end)}"
        corrected_lines.append(entry['num'])
        corrected_lines.append(ts_line)
        corrected_lines.append(text)
        corrected_lines.append('')

        print(f"      实测时长: {duration:.1f}s | 累计到: {format_time(elapsed)}")

    with open(args.srt_out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(corrected_lines) + '\n')

    print(f"\n合并 {len(wav_files)} 个音频文件...")
    if args.output.endswith('.mp3'):
        tmp_merged = os.path.join(TMP_DIR, 'merged.wav')
        concat_audio(wav_files, tmp_merged)
        subprocess.run(
            ['ffmpeg', '-y', '-i', tmp_merged, '-codec:a', 'libmp3lame',
             '-qscale:a', '2', args.output],
            capture_output=True, check=True
        )
    else:
        concat_audio(wav_files, args.output)

    file_size = os.path.getsize(args.output)
    print(f"\n✅ 完成!")
    print(f"   音频: {args.output} ({file_size/1024:.0f} KB, {format_time(elapsed)})")
    print(f"   SRT:  {args.srt_out}")

    import shutil
    shutil.rmtree(TMP_DIR, ignore_errors=True)


if __name__ == '__main__':
    main()
