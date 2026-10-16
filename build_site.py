"""CSV -> docs/games.json 변환 (GitHub Pages 배포용)

사용법:
    python build_site.py            # 현재 CSV로 games.json만 다시 생성
    python build_site.py --crawl 3  # 카페 3페이지 크롤링 후 games.json 생성
    python build_site.py --trailers 300  # 트레일러 없는 게임 최대 300개의 Steam 트레일러 수집
"""
import argparse
import json
import os
import re
import shutil
import time

import pandas as pd
import requests

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


def steam_app_id(row):
    for key in ('링크', '스팀이미지'):
        m = re.search(r'(?:steampowered\.com/app/|/apps/)(\d+)', str(row.get(key, '')))
        if m: return m.group(1)
    return None


def fetch_trailer(app_id):
    """Steam 트레일러 HLS 주소. 트레일러가 없으면 '-', 요청 제한(429)이면 None"""
    res = requests.get(f"https://store.steampowered.com/api/appdetails?appids={app_id}&filters=movies", timeout=10)
    if res.status_code == 429: return None
    data = (res.json() or {}).get(app_id) or {}
    movies = (data.get('data') or {}).get('movies') or [] if data.get('success') else []
    movie = next((m for m in movies if m.get('highlight')), movies[0] if movies else None)
    return (movie or {}).get('hls_h264') or '-'


def fill_trailers(limit):
    df = pd.read_csv(CSV_FILE, encoding='utf-8-sig')
    if '트레일러' not in df.columns: df['트레일러'] = ''
    todo = [i for i, row in df.iterrows() if pd.isna(row['트레일러']) or row['트레일러'] == '']
    done = 0
    for i in todo[:limit]:
        app_id = steam_app_id(df.loc[i])
        try: trailer = fetch_trailer(app_id) if app_id else '-'
        except Exception as e:
            print(f"트레일러 에러 ({app_id}): {e}")
            continue
        if trailer is None:
            print("⏸ Steam 요청 제한에 걸려 다음 실행에서 이어서 수집합니다")
            break
        df.at[i, '트레일러'] = trailer
        done += 1
        time.sleep(0.4)
    df.to_csv(CSV_FILE, index=False, encoding="utf-8-sig")
    print(f"🎬 트레일러 {done}개 수집 (남은 {len(todo) - done}개)")


def build():
    try: df = pd.read_csv(CSV_FILE, encoding='utf-8-sig').fillna('-')
    except UnicodeDecodeError: df = pd.read_csv(CSV_FILE, encoding='cp949').fillna('-')

    if '스팀이미지' not in df.columns: df['스팀이미지'] = '-'
    if '스팀할인' not in df.columns: df['스팀할인'] = 0
    if '유저평가' not in df.columns: df['유저평가'] = '-'
    if '트레일러' not in df.columns: df['트레일러'] = '-'
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
    parser.add_argument('--trailers', type=int, metavar='N', help='트레일러를 수집할 최대 게임 수')
    args = parser.parse_args()
    if args.crawl: run_crawl(args.crawl)
    if args.trailers: fill_trailers(args.trailers)
    build()
