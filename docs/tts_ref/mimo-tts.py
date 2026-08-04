#!/usr/bin/env python3
"""
MiMo TTS v2.5 语音合成脚本
使用 mimo-v2.5-tts-voicedesign 模型生成知性女性声音

使用方法:
    # 直接喂 SRT 文件或纯文本
    python3 mimo-tts.py --input script.srt --output voice.mp3

输入支持:
    - SRT 字幕文件（自动跳过编号、时间轴、场景标记）
    - 纯文本文件（narration.txt）

环境变量:
    MIMO_API_KEY: MiMo API 密钥（必须）

API 文档: https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/speech-synthesis-v2.5
"""

import argparse
import base64
import os
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from openai import OpenAI
except ImportError:
    print("错误: 需要安装 openai 库")
    print("运行: pip install openai")
    sys.exit(1)


# MiMo TTS API 配置
MIMO_BASE_URL = "https://api.xiaomimimo.com/v1"
MIMO_MODEL = "mimo-v2.5-tts-voicedesign"

# 音频参数
SAMPLE_RATE = 24000
NUM_CHANNELS = 1
BITS_PER_SAMPLE = 16

# SRT 时间轴正则
TIMESTAMP_RE = re.compile(r'^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}')


def read_script(input_path: str) -> str:
    """读取输入文件，自动识别 SRT 或纯文本格式"""
    with open(input_path, 'r', encoding='utf-8') as f:
        content = f.read()

    lines = content.split('\n')
    is_srt = any(TIMESTAMP_RE.match(line.strip()) for line in lines)

    if is_srt:
        print("检测到 SRT 字幕格式，自动提取旁白文本...")
        narration = []
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith('==='):
                continue
            if stripped.isdigit():
                continue
            if TIMESTAMP_RE.match(stripped):
                continue
            if stripped.startswith('字幕旁白：'):
                text = stripped[len('字幕旁白：'):].strip()
                if text:
                    narration.append(text)
                continue
            narration.append(stripped)

        text = ' '.join(narration)
        print(f"提取到 {len(narration)} 段旁白，共 {len(text)} 字符")
        return text

    return content.strip()


def pcm_to_wav(pcm_data: bytes, wav_path: str):
    """将 PCM 数据转换为 WAV 格式（添加 WAV 头）"""
    data_size = len(pcm_data)
    byte_rate = SAMPLE_RATE * NUM_CHANNELS * BITS_PER_SAMPLE // 8
    block_align = NUM_CHANNELS * BITS_PER_SAMPLE // 8

    with open(wav_path, 'wb') as f:
        # RIFF 头
        f.write(b'RIFF')
        f.write(struct.pack('<I', 36 + data_size))
        f.write(b'WAVE')

        # fmt 子块
        f.write(b'fmt ')
        f.write(struct.pack('<I', 16))  # 子块大小
        f.write(struct.pack('<H', 1))   # PCM 格式
        f.write(struct.pack('<H', NUM_CHANNELS))
        f.write(struct.pack('<I', SAMPLE_RATE))
        f.write(struct.pack('<I', byte_rate))
        f.write(struct.pack('<H', block_align))
        f.write(struct.pack('<H', BITS_PER_SAMPLE))

        # data 子块
        f.write(b'data')
        f.write(struct.pack('<I', data_size))
        f.write(pcm_data)


def wav_to_mp3(wav_path: str, mp3_path: str):
    """使用 ffmpeg 将 WAV 转换为 MP3"""
    try:
        cmd = [
            'ffmpeg', '-y',
            '-i', wav_path,
            '-codec:a', 'libmp3lame',
            '-qscale:a', '2',
            mp3_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"ffmpeg 警告: {result.stderr}")
    except FileNotFoundError:
        print("警告: ffmpeg 未安装，将保存为 WAV 格式")
        # 如果 ffmpeg 不可用，直接复制 WAV 文件
        import shutil
        shutil.copy(wav_path, mp3_path)


def generate_speech(text: str, voice_description: str, output_path: str):
    """调用 MiMo TTS API 生成语音"""

    api_key = os.environ.get('MIMO_API_KEY')
    if not api_key:
        print("错误: 请设置 MIMO_API_KEY 环境变量")
        print("获取方式: 访问 https://platform.xiaomimimo.com 获取 API 密钥")
        sys.exit(1)

    print(f"正在调用 MiMo TTS API...")
    print(f"语音描述: {voice_description}")
    print(f"文本长度: {len(text)} 字符")

    try:
        # 创建 OpenAI 客户端
        client = OpenAI(
            api_key=api_key,
            base_url=MIMO_BASE_URL
        )

        # 调用 TTS API
        completion = client.chat.completions.create(
            model=MIMO_MODEL,
            messages=[
                {
                    "role": "user",
                    "content": voice_description
                },
                {
                    "role": "assistant",
                    "content": text
                }
            ],
            audio={
                "format": "pcm16"
            }
        )

        # 获取音频数据
        message = completion.choices[0].message
        pcm_data = base64.b64decode(message.audio.data)

        # 创建临时 WAV 文件
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            wav_path = tmp.name

        # 转换为 WAV 格式
        pcm_to_wav(pcm_data, wav_path)

        # 如果输出路径是 MP3，使用 ffmpeg 转换
        if output_path.lower().endswith('.mp3'):
            wav_to_mp3(wav_path, output_path)
            os.unlink(wav_path)  # 删除临时 WAV 文件
        else:
            # 如果不是 MP3，直接移动 WAV 文件
            os.rename(wav_path, output_path)

        # 获取文件大小
        file_size = os.path.getsize(output_path)

        print(f"✅ 语音已生成: {output_path}")
        print(f"   文件大小: {file_size / 1024:.1f} KB")
        print(f"   格式: {'MP3' if output_path.lower().endswith('.mp3') else 'WAV'}")

    except Exception as e:
        print(f"❌ API 调用失败: {e}")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description='MiMo TTS v2.5 语音合成')
    parser.add_argument('--input', required=True, help='输入脚本文件路径')
    parser.add_argument('--output', required=True, help='输出音频文件路径（支持 .mp3 或 .wav）')
    parser.add_argument('--voice',
                       default='女性 中学老师 语速较慢 温暖 字正腔圆',
                       help='语音描述（默认: 温暖的中学女老师）')

    args = parser.parse_args()

    # 检查输入文件
    if not os.path.exists(args.input):
        print(f"错误: 输入文件不存在: {args.input}")
        sys.exit(1)

    # 读取脚本
    print(f"读取脚本: {args.input}")
    text = read_script(args.input)

    if not text:
        print("错误: 无法从输入文件中提取旁白内容")
        sys.exit(1)

    print(f"旁白总字符: {len(text)}")

    # 生成语音
    generate_speech(text, args.voice, args.output)


if __name__ == '__main__':
    main()
