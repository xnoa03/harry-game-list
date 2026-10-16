"""CSV -> docs/games.json 변환 (GitHub Pages 배포용)

사용법:
    python build_site.py            # 현재 CSV로 games.json만 다시 생성
    python build_site.py --crawl 3  # 카페 3페이지 크롤링 후 games.json 생성
"""
import argparse
import json
import os
import re
import shutil

import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DOCS_DIR = os.path.join(BASE_DIR, 'docs')
CSV_FILE = os.path.join(BASE_DIR, 'harry_game_list_final.csv')


# app.py의 parse_time과 동일 (selenium 없이도 빌드되도록 복사)
def parse_time(text):
    text = str(text).lower()
    if text == '-' or text == '': return 0.0
    nums = re.findall(r"[-+]?\d*\.\d+|\d+", text)
    if not nums: return 0.0
    vals = [float(n) for n in nums]
    avg = sum(vals) / len(vals)
    return avg / 60 if ('분' in text or 'min' in text) and '시간' not in text else avg


def run_crawl(pages):
    from app import generate_crawl_stream  # selenium 필요
    for chunk in generate_crawl_stream(pages):
        payload = json.loads(chunk[len('data: '):].strip())
        print(f"[{payload['progress']:>5.1f}%] {payload['msg']}")


def build():
    try: df = pd.read_csv(CSV_FILE, encoding='utf-8-sig').fillna('-')
    except UnicodeDecodeError: df = pd.read_csv(CSV_FILE, encoding='cp949').fillna('-')

    if '스팀이미지' not in df.columns: df['스팀이미지'] = '-'
    if '스팀할인' not in df.columns: df['스팀할인'] = 0
    if '유저평가' not in df.columns: df['유저평가'] = '-'
    df['time_num'] = df['플레이타임'].apply(parse_time)
    df['스팀할인'] = pd.to_numeric(df['스팀할인'], errors='coerce').fillna(0).astype(int)

    games = [{k: (v if k in ('스팀할인', 'time_num') else str(v)) for k, v in row.items()} for row in df.to_dict(orient='records')]

    os.makedirs(DOCS_DIR, exist_ok=True)
    with open(os.path.join(DOCS_DIR, 'games.json'), 'w', encoding='utf-8') as f:
        json.dump(games, f, ensure_ascii=False)
    shutil.copy(os.path.join(BASE_DIR, 'static', 'logo.ico'), os.path.join(DOCS_DIR, 'logo.ico'))
    print(f"✅ docs/games.json 생성 완료 ({len(games)}개)")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--crawl', type=int, metavar='PAGES', help='크롤링할 페이지 수')
    args = parser.parse_args()
    if args.crawl: run_crawl(args.crawl)
    build()
