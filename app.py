import sys
import os
import webbrowser
from threading import Timer
import threading
from flask import Flask, render_template, request, Response, stream_with_context, jsonify
import pandas as pd
import time
import re
import json
import random
import requests 
import concurrent.futures 
from concurrent.futures import ThreadPoolExecutor 
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from subprocess import CREATE_NO_WINDOW 

def get_data_path(filename):
    if getattr(sys, 'frozen', False):
        application_path = os.path.dirname(sys.executable)
    else:
        application_path = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(application_path, filename)

CSV_FILE = get_data_path('harry_game_list_final.csv')

def resource_path(relative_path):
    try:
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

app = Flask(__name__, 
            template_folder=resource_path('templates'),
            static_folder=resource_path('static'))

# --- 💓 하트비트(생존 신고) 기능 ---
LAST_PING_TIME = time.time()

@app.route('/ping')
def ping():
    global LAST_PING_TIME
    LAST_PING_TIME = time.time() 
    return "ok"

def monitor_heartbeat():
    global LAST_PING_TIME
    time.sleep(10) 
    while True:
        time.sleep(2)
        
        if time.time() - LAST_PING_TIME > 500:
            print(" 브라우저 종료 감지! 백그라운드 서버를 완전히 종료합니다.")
            os._exit(0)
# -----------------------------------

@app.route('/shutdown', methods=['POST'])
def shutdown():
    def kill_server():
        os._exit(0)
    Timer(0.1, kill_server).start()
    return jsonify({"status": "success", "msg": "종료 중..."})

CLUB_ID = "27646284"

def extract_steam_id(url):
    if not url or 'steampowered.com/app/' not in url: return None
    match = re.search(r'steampowered\.com/app/(\d+)', url)
    return match.group(1) if match else None

REVIEW_MAP = {
    "Overwhelmingly Positive": "압도적으로 긍정적",
    "Very Positive": "매우 긍정적",
    "Positive": "긍정적",
    "Mostly Positive": "대체로 긍정적",
    "Mixed": "복합적",
    "Mostly Negative": "대체로 부정적",
    "Negative": "부정적",
    "Very Negative": "매우 부정적",
    "Overwhelmingly Negative": "압도적으로 부정적",
}

def fetch_steam_review(app_id):
    if not app_id: return "-"
    try:
        url = f"https://store.steampowered.com/appreviews/{app_id}?json=1&language=all&purchase_type=all&num_per_page=0"
        res = requests.get(url, timeout=10)
        if res.status_code == 200:
            data = res.json()
            desc = data.get('query_summary', {}).get('review_score_desc', '-')
            return REVIEW_MAP.get(desc, desc) if desc else "-"
    except Exception as e: print(f"Steam 리뷰 API 에러: {e}")
    return "-"

def fetch_steam_api(app_id):
    if not app_id: return None, 0, "-", "-", "-", ""
    api_url = f"https://store.steampowered.com/api/appdetails?appids={app_id}&cc=kr&l=korean"
    try:
        res = requests.get(api_url, timeout=10)
        if res.status_code == 200:
            data = res.json()
            if data and data[app_id]['success']:
                game_data = data[app_id]['data']
                img_url = game_data.get('header_image')
                review_desc = fetch_steam_review(app_id)
                is_free = game_data.get('is_free', False)
                price_info = game_data.get('price_overview', {})
                discount_pct = price_info.get('discount_percent', 0)
                steam_price = "무료" if is_free else price_info.get('final_formatted', "-")
                languages = game_data.get('supported_languages', "")
                is_korean = "O" if ("Korean" in languages or "한국어" in languages) else "X"
                steam_url = f"https://store.steampowered.com/app/{app_id}/"
                return img_url, discount_pct, review_desc, steam_price, is_korean, steam_url
    except Exception as e: print(f"Steam API 에러: {e}") 
    return None, 0, "-", "-", "-", ""

def search_steam_by_name(game_name):
    if not game_name or game_name == "-": return None
    clean_name = re.sub(r'[\[\]\(\)]', ' ', game_name).strip()
    search_url = f"https://store.steampowered.com/api/storesearch/?term={clean_name}&l=korean&cc=kr"
    try:
        res = requests.get(search_url, timeout=10)
        if res.status_code == 200:
            data = res.json()
            if data.get('total', 0) > 0:
                return str(data['items'][0]['id'])
    except Exception as e: print(f"Steam 검색 에러: {e}")
    return None

def smart_extract(curr, idx, all_l, keys):
    tmp = curr
    for u in ["O,X", "O/X", "(O,X)", "(O/X)", "o,x", "o/x", "OX", "ox", "(필수아님)", "필수아님"]: tmp = tmp.replace(u, "")
    for sep in [":", "-", ")"]:
        if sep in tmp:
            parts = tmp.split(sep, 1)
            if any(k in parts[0].replace(" ", "") for k in keys):
                val = parts[1].strip()
                if "2025/" in val or "2024/" in val: return "-"
                if ".kr" in val or ".jpg" in val or ".png" in val: return "-"
                if val: return val
    cln = re.sub(r'^[0-9]+[\.]?', '', tmp)
    for k in keys: cln = cln.replace(k, "")
    cln = cln.replace("여부", "").strip()
    cln_alpha = re.sub(r'[^a-zA-Z0-9가-힣]', '', cln)
    if len(cln_alpha) > 0 and len(cln) < 30:
        if "2025/" in cln or ".kr" in cln: return "-"
        return cln
    for k in range(idx + 1, min(idx + 15, len(all_l))):
        val = all_l[k].strip()
        if not val: continue 
        if re.match(r'^[0-9]+\.', val) or any(f in val.replace(" ", "") for f in ["게임이름", "출시일", "가격", "링크", "주소", "한글", "플레이타임", "추천이유"]):
            break
        if len(val) < 100: return val
    return "-"

def process_single_target(item, old_games_map):
    app_id = item.get('id', '')
    pc_link = f"https://cafe.naver.com/ArticleRead.nhn?clubid={CLUB_ID}&articleid={app_id}"
    final_category = item.get('category', '미분류')
    cached_img, cached_discount, cached_meta = '-', 0, '-' 
    
    if pc_link in old_games_map:
        old = old_games_map[pc_link]
        final_category = old.get('카테고리', item.get('category', '미분류'))
        cached_img = old.get('스팀이미지', '-')
        cached_discount = old.get('스팀할인', 0)
        cached_meta = old.get('유저평가', '-') 
    
    info = {"카테고리": final_category, "글제목": item.get('title', ''), "게임이름": "-", "출시일": "-", "가격": "-", "링크": "-", "한글화": "-", "플레이타임": "-", "게시글링크": pc_link, "스팀이미지": cached_img, "스팀할인": cached_discount, "유저평가": cached_meta}
    headers = {"User-Agent": "Mozilla/5.0"}
    content = ""
    
    try:
        api_url = f"https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/{CLUB_ID}/articles/{app_id}"
        res = requests.get(api_url, headers=headers, timeout=10)
        if res.status_code == 200:
            content = BeautifulSoup(res.json()['result']['article']['contentHtml'], "html.parser").get_text(separator="\n")
    except Exception as e: print(f"카페 API 에러: {e}")

    if not content or len(content) < 10:
        try:
            iframe_url = f"https://cafe.naver.com/ca-fe/ArticleRead.nhn?clubid={CLUB_ID}&articleid={app_id}"
            res2 = requests.get(iframe_url, headers=headers, timeout=10)
            soup = BeautifulSoup(res2.text, "html.parser")
            container = soup.select_one(".se-main-container") or soup.select_one("#tbody")
            if container: content = container.get_text(separator="\n")
        except Exception as e: print(f"카페 iframe 에러: {e}")

    if content:
        lines = content.split('\n')
        for i, l in enumerate(lines):
            ls = l.replace(" ", "")
            if "게임이름" in ls: info["게임이름"] = smart_extract(l, i, lines, ["게임이름", "게임명"])
            elif "출시일" in ls: info["출시일"] = smart_extract(l, i, lines, ["출시일", "필수아님"])
            elif "가격" in ls: info["가격"] = smart_extract(l, i, lines, ["가격", "금액"])
            elif ("링크" in ls or "주소" in ls) and "http" not in ls:
                val = smart_extract(l, i, lines, ["링크", "주소"])
                if "http" in val: info["링크"] = val
            elif "http" in l and info["링크"] == "-": info["링크"] = l.strip()
            elif any(x in ls for x in ["한글", "한국어", "언어", "패치"]): info["한글화"] = smart_extract(l, i, lines, ["한글", "한국어", "언어", "패치", "화", "여부"])
            elif "플레이타임" in ls or "플타" in ls: info["플레이타임"] = smart_extract(l, i, lines, ["플레이타임", "플타"])
        if info["링크"] == "-":
            steam_match = re.search(r'(https://store\.steampowered\.com/app/\d+[^ \n\r"\'<>]+)', content)
            if steam_match: info["링크"] = steam_match.group(1)

    title_raw = item.get('title', '')
    if info["플레이타임"] == "-" or len(info["플레이타임"]) < 2:
        m_time = re.search(r'(\d+(?:\.\d+)?\s*(?:시간|분))', title_raw)
        if m_time: info["플레이타임"] = m_time.group(1).strip()
    if info["게임이름"] == "-" or len(info["게임이름"]) < 2:
        t_clean = re.sub(r'\[.*?\]', ' ', title_raw, count=1)
        t_clean = re.sub(r'\(?\d+(?:\.\d+)?\s*(?:시간|분)\)?', ' ', t_clean)
        m_quote = re.search(r'["\'](.*?)["\']', title_raw) 
        m_bracket = re.search(r'\[(.*?)\]', title_raw[title_raw.find(']')+1:]) 
        if m_quote: info["게임이름"] = m_quote.group(1).strip()
        elif m_bracket: info["게임이름"] = m_bracket.group(1).strip()
        else:
            info["게임이름"] = t_clean.split(":")[-1].strip() if ":" in t_clean else t_clean.strip()

    if pc_link in old_games_map:
        old = old_games_map[pc_link]
        for key in ["게임이름", "출시일", "가격", "링크", "한글화", "플레이타임"]:
            if info.get(key, "-") == "-" and str(old.get(key, "-")) != "-":
                info[key] = str(old[key])

    steam_id_to_fetch = extract_steam_id(info['링크']) if 'steampowered.com/app/' in info['링크'] else search_steam_by_name(info["게임이름"]) if info["링크"] == "-" and info["게임이름"] != "-" else None
    if steam_id_to_fetch:
        img_url, discount, meta, s_price, s_kor, s_url = fetch_steam_api(steam_id_to_fetch)
        if img_url: info['스팀이미지'] = img_url
        if discount > 0: info['스팀할인'] = discount
        if str(meta) != "-": info['유저평가'] = meta
        if info["링크"] == "-": info["링크"] = s_url
        if info["가격"] == "-": info["가격"] = s_price
        if info["한글화"] == "-": info["한글화"] = s_kor

    return info

def generate_crawl_stream(max_pages):
    yield f"data: {json.dumps({'progress': 5, 'msg': '🚀 엔진 가동 중...'})}\n\n"
    old_games = []
    try:
        if os.path.exists(CSV_FILE):
            try: df = pd.read_csv(CSV_FILE, encoding='utf-8-sig')
            except UnicodeDecodeError: df = pd.read_csv(CSV_FILE, encoding='cp949')
            if '스팀이미지' not in df.columns: df['스팀이미지'] = '-'
            if '스팀할인' not in df.columns: df['스팀할인'] = 0
            if '유저평가' not in df.columns: df['유저평가'] = '-'
            old_games = df.to_dict('records')
            yield f"data: {json.dumps({'progress': 8, 'msg': f'💾 기존 데이터 {len(old_games)}개 로드 완료'})}\n\n"
    except Exception as e: pass

    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--log-level=3")
    chrome_options.page_load_strategy = 'eager'
    service = Service(); service.creation_flags = CREATE_NO_WINDOW
    
    driver = None
    crawl_targets = []
    
    try:
        driver = webdriver.Chrome(service=service, options=chrome_options)
        
        for page in range(1, max_pages + 1):
            yield f"data: {json.dumps({'progress': 10 + (page/max_pages*5), 'msg': f'📋 {page}페이지 탐색...'})}\n\n"
            driver.get(f"https://cafe.naver.com/ArticleList.nhn?search.clubid={CLUB_ID}&search.menuid=44&search.page={page}")
            time.sleep(0.1)
            try: WebDriverWait(driver, 3).until(EC.presence_of_element_located((By.CSS_SELECTOR, "a.article")))
            except: pass
            for post in driver.find_elements(By.CSS_SELECTOR, "a.article"):
                try:
                    full_title = post.text.strip().replace('\n', ' ')
                    category = full_title[1:full_title.find("]")] if full_title.startswith("[") else "미분류"
                    if category.replace(" ", "") in ["게임", "공겜", "할게임", "일단킵", "협동", "한게임"] and category != "공지":
                        match = re.search(r'(?:articleid=|articles/)(\d+)', post.get_attribute('href'))
                        if match and not any(d.get('id') == match.group(1) for d in crawl_targets):
                            crawl_targets.append({"id": match.group(1), "category": category, "title": full_title})
                except Exception as e: continue
                
    except GeneratorExit:
        print("사용자가 웹페이지 창을 닫아 크롤링이 중단되었습니다.")
        return
    except Exception as e:
        yield f"data: {json.dumps({'progress': 100, 'msg': '🚨 크롬 브라우저를 실행할 수 없습니다 (크롬 설치 확인)', 'done': True})}\n\n"
        return
    finally:
        if driver:
            try: driver.quit()
            except: pass
    
    if not crawl_targets:
        yield f"data: {json.dumps({'progress': 100, 'msg': '새로운 데이터 없음', 'done': True})}\n\n"
        return

    total = len(crawl_targets)
    yield f"data: {json.dumps({'progress': 20, 'msg': f' 2단계: {total}개 데이터 분석 중...'})}\n\n"
    new_data = []
    old_games_map = {old.get('게시글링크'): old for old in old_games if '게시글링크' in old}
    
    try:
        with ThreadPoolExecutor(max_workers=20) as executor:
            futures = {executor.submit(process_single_target, item, old_games_map): item for item in crawl_targets}
            done_count = 0
            for future in concurrent.futures.as_completed(futures):
                try: new_data.append(future.result())
                except Exception as e: print(f"개별 데이터 수집 에러: {e}")
                done_count += 1
                if done_count % 3 == 0 or done_count == total:
                    progress = 20 + int((done_count / total) * 75)
                    yield f"data: {json.dumps({'progress': progress, 'msg': f'⚡ 안전 수집 중 ({done_count}/{total}) 완료...'})}\n\n"
    except GeneratorExit:
        print("사용자가 중간에 창을 닫아 병렬 수집이 중단되었습니다.")
        return

    yield f"data: {json.dumps({'progress': 98, 'msg': ' 데이터 최종 병합 중...'})}\n\n"
    merged_map = {item['게시글링크']: item for item in new_data if item.get('게시글링크')}
    for item in old_games:
        if item.get('게시글링크') and item['게시글링크'] not in merged_map: merged_map[item['게시글링크']] = item
            
    final_list = list(merged_map.values())
    
    try:
        final_list.sort(key=lambda x: int(re.search(r'(?:articleid=|articles/)(\d+)', str(x.get('게시글링크', ''))).group(1)) if re.search(r'(?:articleid=|articles/)(\d+)', str(x.get('게시글링크', ''))) else 0, reverse=True)
        
        if final_list: pd.DataFrame(final_list).to_csv(CSV_FILE, index=False, encoding="utf-8-sig")
        yield f"data: {json.dumps({'progress': 100, 'msg': f'✨ 초고속 완료! ({len(final_list)}개 저장)', 'done': True})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'progress': 100, 'msg': f'🚨 에러 발생: {str(e)}', 'done': True})}\n\n"

def parse_time(text):
    text = str(text).lower()
    if text == '-' or text == '': return 0.0
    nums = re.findall(r"[-+]?\d*\.\d+|\d+", text)
    if not nums: return 0.0
    vals = [float(n) for n in nums]
    avg = sum(vals) / len(vals)
    return avg / 60 if ('분' in text or 'min' in text) and '시간' not in text else avg

@app.route('/update_category', methods=['POST'])
def update_category():
    try:
        data = request.json
        try: df = pd.read_csv(CSV_FILE, encoding='utf-8-sig')
        except UnicodeDecodeError: df = pd.read_csv(CSV_FILE, encoding='cp949')
        df.loc[df['게시글링크'] == data.get('link'), '카테고리'] = data.get('category')
        df.to_csv(CSV_FILE, index=False, encoding="utf-8-sig")
        return jsonify({"status": "success"})
    except Exception as e: return jsonify({"status": "error", "msg": str(e)})

@app.route('/')
def index():
    error_msg = ""
    games = []
    try:
        if not os.path.exists(CSV_FILE):
            error_msg = f"🚨 파일을 찾을 수 없습니다. (경로: {CSV_FILE})"
        else:
            try:
                df = pd.read_csv(CSV_FILE, encoding='utf-8-sig').fillna('-')
            except UnicodeDecodeError:
                df = pd.read_csv(CSV_FILE, encoding='cp949').fillna('-')
                
            if '스팀이미지' not in df.columns: df['스팀이미지'] = '-'
            if '스팀할인' not in df.columns: df['스팀할인'] = 0
            if '유저평가' not in df.columns: df['유저평가'] = '-'
            df['time_num'] = df['플레이타임'].apply(parse_time)
            games = df.to_dict(orient='records')
    except Exception as e: 
        error_msg = f"🚨 데이터를 읽는 중 에러가 발생했습니다: {str(e)}"
        
    return render_template('index.html', games=games, error_msg=error_msg)

@app.route('/crawl_stream')
def crawl_stream():
    pages = int(request.args.get('pages', 3))
    return Response(stream_with_context(generate_crawl_stream(pages)), mimetype='text/event-stream')

if __name__ == '__main__':
    import socket
    def find_free_port(start_port=5000):
        port = start_port
        while True:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex(('127.0.0.1', port)) != 0: return port
            port += 1
    free_port = find_free_port()

    def open_browser():
        url = f"http://127.0.0.1:{free_port}"
        for path in ["C:/Program Files/Google/Chrome/Application/chrome.exe %s", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe %s", os.path.expanduser("~") + "/AppData/Local/Google/Chrome/Application/chrome.exe %s"]:
            try:
                webbrowser.get(path).open_new(url)
                return
            except webbrowser.Error: continue
        webbrowser.open_new(url)

    Timer(1, open_browser).start()
    

    threading.Thread(target=monitor_heartbeat, daemon=True).start()
    
    app.run(port=free_port)