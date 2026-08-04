#!/usr/bin/env python3
"""
从 script.txt 提取纯旁白文字

支持两种脚本格式：
  格式A: 「字幕旁白：」前缀格式
  格式B: SRT 字幕格式（编号 + 时间轴 + 文本）

使用方法:
    python3 extract-narration.py --input script.txt --output narration.txt

输出: narration.txt — 纯旁白文字，供 TTS 使用
"""

import argparse
import re
import sys


TIMESTAMP_RE = re.compile(r'^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}')


def extract_format_a(lines):
    """格式A: 「字幕旁白：xxx」"""
    narration = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('字幕旁白：'):
            text = stripped[len('字幕旁白：'):].strip()
            if text:
                narration.append(text)
    return narration


def extract_format_b(lines):
    """格式B: VTT 时间轴格式"""
    narration = []
    for line in lines:
        stripped = line.strip()
        # 跳过场景标记
        if stripped.startswith('==='):
            continue
        # 跳过空行
        if not stripped:
            continue
        # 跳过纯数字行（VTT 序号）
        if stripped.isdigit():
            continue
        # 跳过时间戳行
        if TIMESTAMP_RE.match(stripped):
            continue
        # 剩下的就是字幕文本
        narration.append(stripped)
    return narration


def extract_narration(input_path: str, output_path: str):
    with open(input_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    narration = extract_format_a(lines)

    if narration:
        print("检测到格式: 「字幕旁白：」前缀格式")
    else:
        narration = extract_format_b(lines)
        if narration:
            print("检测到格式: VTT 时间轴格式")
        else:
            print("错误: 未识别任何旁白内容", file=sys.stderr)
            print("支持的格式:", file=sys.stderr)
            print("  A: 字幕旁白：xxx", file=sys.stderr)
            print("  B: VTT 时间轴 + 文本", file=sys.stderr)
            sys.exit(1)

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(narration) + '\n')

    chars = sum(len(t) for t in narration)
    estimated_seconds = chars / 3.3
    print(f"提取到 {len(narration)} 句旁白")
    print(f"总字数: {chars} 字")
    print(f"估算时长: {estimated_seconds:.0f} 秒 ({estimated_seconds/60:.1f} 分钟)")
    print(f"已写入: {output_path}")


def main():
    parser = argparse.ArgumentParser(description='从 script.txt 提取纯旁白文字')
    parser.add_argument('--input', required=True, help='输入脚本文件（script.txt）')
    parser.add_argument('--output', required=True, help='输出旁白文件（narration.txt）')
    args = parser.parse_args()

    extract_narration(args.input, args.output)


if __name__ == '__main__':
    main()
