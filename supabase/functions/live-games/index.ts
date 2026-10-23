// 사이트를 열 때(F5) 호출되는 함수.
// 1) 카페 게시판 첫 페이지를 바로 긁어서 games.json에 아직 없는 새 글을 분석해 live_games 테이블에 저장
// 2) 장르/한 줄 설명이 없는 게임을 채워 game_ai 테이블에 저장 (한 번에 일부씩)
//    ANTHROPIC_API_KEY가 있으면 Claude Haiku로 작성, 없거나 실패하면 Steam의 장르/소개문을 대신 사용(무료)
//    나중에 키를 추가하면 Steam으로 채운 것도 AI로 다시 작성함
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 자동으로 넣어줌

import Anthropic from 'npm:@anthropic-ai/sdk@0.135.0';

const CLUB_ID = '27646284';
const MENU_ID = '44';
const GAMES_JSON = 'https://xnoa03.github.io/harry-game-list/games.json';
const CATEGORIES = ['게임', '공겜', '할게임', '일단킵', '협동', '한게임'];
const NEW_PER_CALL = 8;       // 한 번에 분석할 새 글 수
const BACKFILL_PER_CALL = 20; // 한 번에 AI로 채울 기존 게임 수
const MODEL = 'claude-haiku-5-5';  // 가장 저렴한 모델 (819개 전부 채워도 1달러 미만)

const GENRES = ['액션', '어드벤처', 'RPG', '로그라이크', '전략', '시뮬레이션', '퍼즐', '공포', '생존', '슈팅',
  '플랫포머', '레이싱', '스포츠', '리듬', '격투', '샌드박스', '파티', '추리', '비주얼노벨', '카드', '방치형', '오픈월드', '힐링', '턴제'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const UA = { 'User-Agent': 'Mozilla/5.0' };
const articleLink = (id: string) => `https://cafe.naver.com/ArticleRead.nhn?clubid=${CLUB_ID}&articleid=${id}`;

// --- Supabase REST (service role) ---
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...init.headers },
  });
// Supabase는 한 번에 최대 1000행만 주므로 나눠서 끝까지 읽음
async function sbAll(path: string) {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await (await sb(path, { headers: { Range: `${from}-${from + 999}` } })).json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}
const upsert = (table: string, rows: unknown[]) =>
  rows.length ? sb(table, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows) }) : null;

// --- 카페 ---
async function cafeList() {
  const url = `https://apis.naver.com/cafe-web/cafe2/ArticleListV2dot1.json?search.clubid=${CLUB_ID}&search.queryType=lastArticle&search.menuid=${MENU_ID}&search.page=1&search.perPage=50`;
  const result = (await (await fetch(url, { headers: UA })).json()).message.result;
  return (result.articleList ?? [])
    .map((p: any) => ({ id: String(p.articleId), category: p.headName || '미분류', subject: p.subject ?? '' }))
    .filter((p: any) => CATEGORIES.includes(p.category.replace(/\s/g, '')));
}

function htmlToText(html: string) {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n\s*\n+/g, '\n').trim();
}

async function cafeContent(id: string) {
  try {
    const res = await fetch(`https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/${CLUB_ID}/articles/${id}`, { headers: UA });
    return htmlToText((await res.json()).result.article.contentHtml ?? '');
  } catch { return ''; }
}

// --- Steam ---
const REVIEW_MAP: Record<string, string> = {
  'Overwhelmingly Positive': '압도적으로 긍정적', 'Very Positive': '매우 긍정적', 'Positive': '긍정적',
  'Mostly Positive': '대체로 긍정적', 'Mixed': '복합적', 'Mostly Negative': '대체로 부정적',
  'Negative': '부정적', 'Very Negative': '매우 부정적', 'Overwhelmingly Negative': '압도적으로 부정적',
};
// Steam 사용자 태그(영문) -> 사이트 장르. 공식 장르(액션/어드벤처/인디)보다 훨씬 구체적임
const TAG_GENRE: Record<string, string> = {
  'Action': '액션', 'Hack and Slash': '액션', 'Souls-like': '액션', 'Character Action Game': '액션',
  'Adventure': '어드벤처', 'Action-Adventure': '어드벤처', 'Point & Click': '어드벤처', 'Walking Simulator': '어드벤처',
  'RPG': 'RPG', 'Action RPG': 'RPG', 'JRPG': 'RPG', 'CRPG': 'RPG', 'Party-Based RPG': 'RPG', 'Dungeon Crawler': 'RPG',
  'Roguelike': '로그라이크', 'Roguelite': '로그라이크', 'Rogue-like': '로그라이크', 'Rogue-lite': '로그라이크',
  'Action Roguelike': '로그라이크', 'Roguelike Deckbuilder': '로그라이크', 'Roguevania': '로그라이크',
  'Strategy': '전략', 'RTS': '전략', 'Grand Strategy': '전략', 'Tower Defense': '전략', '4X': '전략', 'Real Time Tactics': '전략', 'Tactical': '전략',
  'Simulation': '시뮬레이션', 'Management': '시뮬레이션', 'Building': '시뮬레이션', 'Life Sim': '시뮬레이션', 'Farming Sim': '시뮬레이션',
  'Automation': '시뮬레이션', 'Colony Sim': '시뮬레이션', 'City Builder': '시뮬레이션', 'Base Building': '시뮬레이션', 'Job Simulator': '시뮬레이션',
  'Puzzle': '퍼즐', 'Puzzle Platformer': '퍼즐', 'Logic': '퍼즐',
  'Horror': '공포', 'Psychological Horror': '공포', 'Survival Horror': '공포', 'Supernatural': '공포', 'Thriller': '공포', 'Demons': '공포', 'Gore': '공포', 'Zombies': '공포', 'Cosmic Horror': '공포',
  'Survival': '생존', 'Open World Survival Craft': '생존', 'Crafting': '생존',
  'Shooter': '슈팅', 'FPS': '슈팅', 'Third-Person Shooter': '슈팅', 'Bullet Hell': '슈팅', "Shoot 'Em Up": '슈팅', 'Looter Shooter': '슈팅', 'Hero Shooter': '슈팅', 'Extraction Shooter': '슈팅',
  'Platformer': '플랫포머', '2D Platformer': '플랫포머', '3D Platformer': '플랫포머', 'Precision Platformer': '플랫포머', 'Metroidvania': '플랫포머', 'Parkour': '플랫포머',
  'Racing': '레이싱', 'Driving': '레이싱', 'Arcade Racing': '레이싱',
  'Sports': '스포츠', 'Football (Soccer)': '스포츠', 'Golf': '스포츠', 'Basketball': '스포츠', 'Baseball': '스포츠', 'Skateboarding': '스포츠',
  'Rhythm': '리듬', 'Music': '리듬',
  'Fighting': '격투', "Beat 'em up": '격투', '2D Fighter': '격투', '3D Fighter': '격투',
  'Sandbox': '샌드박스',
  'Party Game': '파티', 'Party': '파티',
  'Detective': '추리', 'Mystery': '추리', 'Investigation': '추리', 'Crime': '추리',
  'Visual Novel': '비주얼노벨', 'Dating Sim': '비주얼노벨',
  'Card Game': '카드', 'Deckbuilding': '카드', 'Card Battler': '카드',
  'Idler': '방치형', 'Clicker': '방치형',
  'Open World': '오픈월드',
  'Cozy': '힐링', 'Relaxing': '힐링', 'Wholesome': '힐링',
  'Turn-Based': '턴제', 'Turn-Based Strategy': '턴제', 'Turn-Based Combat': '턴제', 'Turn-Based Tactics': '턴제',
};
// 거의 모든 게임에 붙는 넓은 태그. 구체적인 장르가 부족할 때만 사용
const BROAD_TAGS = new Set(['Action', 'Adventure', 'Action-Adventure', 'Simulation']);

// 태그는 투표 많은 순. 구체적인 태그의 장르를 먼저 최대 3개, 2개가 안 되면 넓은 태그로 채움
function tagGenres(tags: string[]) {
  const top = tags.slice(0, 15);
  const specific = [...new Set(top.filter(t => !BROAD_TAGS.has(t)).map(t => TAG_GENRE[t]).filter(Boolean))].slice(0, 3);
  const broad = [...new Set(top.filter(t => BROAD_TAGS.has(t)).map(t => TAG_GENRE[t]))].filter(x => !specific.includes(x));
  return [...specific, ...broad].slice(0, Math.max(2, specific.length));
}

async function steamTags(appId: string): Promise<string[]> {
  try {
    const html = await (await fetch(`https://store.steampowered.com/app/${appId}/?l=english`, {
      headers: { ...UA, Cookie: 'birthtime=0; lastagecheckage=1-0-1990; wants_mature_content=1' },
    })).text();
    const m = html.match(/InitAppTagModal\(\s*\d+,\s*(\[[\s\S]*?\])\s*,/);
    return m ? JSON.parse(m[1]).map((t: any) => t.name) : [];
  } catch { return []; }
}
const steamId = (s: string) => s.match(/(?:steampowered\.com\/app\/|\/apps\/)(\d+)/)?.[1] ?? null;

async function steamSearch(name: string) {
  try {
    const res = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name.replace(/[\[\]()]/g, ' '))}&l=korean&cc=kr`);
    return String((await res.json()).items?.[0]?.id ?? '') || null;
  } catch { return null; }
}

async function steamDetails(appId: string, withReview = true) {
  try {
    const d = (await (await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=kr&l=korean`)).json())?.[appId];
    if (!d?.success) return null;
    const g = d.data;
    let review = '-';
    if (withReview) try {
      const r = await (await fetch(`https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all&num_per_page=0`)).json();
      const desc = r.query_summary?.review_score_desc;
      if (desc) review = REVIEW_MAP[desc] ?? desc;
    } catch { /* 평가 없이 진행 */ }
    const tags = await steamTags(appId);
    const movies = g.movies ?? [];
    const movie = movies.find((m: any) => m.highlight) ?? movies[0];
    return {
      image: g.header_image ?? '-',
      discount: g.price_overview?.discount_percent ?? 0,
      price: g.is_free ? '무료' : g.price_overview?.final_formatted ?? '-',
      korean: /Korean|한국어/.test(g.supported_languages ?? '') ? 'O' : 'X',
      release: g.release_date?.date || '-',
      trailer: movie?.hls_h264 ?? '-',
      review,
      url: `https://store.steampowered.com/app/${appId}/`,
      genres: (g.genres ?? []).map((x: any) => x.description).join(', '),
      tags,
      desc: htmlToText(g.short_description ?? ''),
    };
  } catch { return null; }
}

// --- Claude ---
const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
const claude = apiKey ? new Anthropic({ apiKey }) : null;
let lastAiError = '';  // 마지막 Claude 오류 (응답에 같이 돌려줘서 원인 확인용)
let aiBlocked = false;  // 크레딧 부족/키 오류처럼 재시도해도 소용없는 오류면 이번 호출에선 AI를 건너뜀

const AI_SCHEMA = {
  type: 'object',
  properties: {
    game_name: { type: 'string', description: '게임 이름. 모르면 "-"' },
    release_date: { type: 'string', description: '출시일. 모르면 "-"' },
    price: { type: 'string', description: '가격. 모르면 "-"' },
    korean: { type: 'string', description: '한글 지원 여부 O / X. 모르면 "-"' },
    playtime: { type: 'string', description: '예상 플레이타임 (예: "3시간"). 글에 없으면 "-"' },
    genres: { type: 'array', items: { type: 'string', enum: GENRES }, description: '가장 잘 맞는 장르 1~3개' },
    summary: { type: 'string', description: '게임을 소개하는 한국어 한 문장 (40자 안팎)' },
  },
  required: ['game_name', 'release_date', 'price', 'korean', 'playtime', 'genres', 'summary'],
  additionalProperties: false,
};

const SYSTEM = `너는 스트리머 시청자들이 추천한 게임 목록을 정리하는 도우미야.
카페 추천글과 Steam 정보를 보고 게임 정보를 JSON으로 정리해.
- summary는 어떤 게임인지 바로 알 수 있게 장르와 핵심 재미를 담은 한 문장으로 써. 추천글 말투를 따라하지 말고 담백하게.
- genres는 Steam 사용자 태그가 있으면 그것을 가장 많이 참고해서, 게임의 핵심 장르를 구체적인 것부터 골라. 액션/어드벤처는 더 맞는 장르가 없을 때만 넣어.
- 제목 앞의 [공겜], [협동공겜] 같은 대괄호 말머리는 게임 이름이 아니야.
- 정보가 글에 없고 확실하지 않으면 지어내지 말고 "-"로 둬.`;

type AiInfo = { game_name: string; release_date: string; price: string; korean: string; playtime: string; genres: string[]; summary: string };

async function askClaude(input: string): Promise<AiInfo | null> {
  if (!claude || aiBlocked) return null;
  try {
    const res: any = await claude.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: input }],
    } as any);
    if (res.stop_reason === 'refusal') return null;  // 거절되면 Steam 정보로 대신 채움
    const text = res.content.find((b: any) => b.type === 'text')?.text;
    return text ? JSON.parse(text) : null;
  } catch (e) {
    console.error('Claude 에러', e);
    lastAiError = e instanceof Error ? e.message : String(e);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError ||
        (e instanceof Anthropic.BadRequestError && /credit balance/i.test(lastAiError))) aiBlocked = true;
    return null;
  }
}

type Steam = Awaited<ReturnType<typeof steamDetails>>;

// game_ai 한 줄: AI 결과가 있으면 그걸, 없으면 Steam 장르/소개문, 둘 다 없으면 빈 줄(다시 시도하지 않도록 표시)
// source: ai2 = AI 설명 + 장르(Steam 태그 우선) / tags = Steam 태그·소개문 / none = 정보 없음
//         ai = 예전 방식(장르도 AI가 고름, 정확도가 낮아 장르만 다시 계산함)
function aiRow(link: string, ai: AiInfo | null, steam: Steam) {
  const base = { link, updated_at: new Date().toISOString() };
  // 장르는 Steam 태그가 AI보다 정확해서 태그가 있으면 태그로, 없을 때(비 Steam 게임)만 AI 장르 사용
  if (ai) return { ...base, genres: steam?.tags.length ? tagGenres(steam.tags) : ai.genres, summary: ai.summary, source: 'ai2' };
  if (steam) {
    return { ...base, genres: tagGenres(steam.tags), summary: steam.desc, source: 'tags' };
  }
  return { ...base, genres: [], summary: '', source: 'none' };
}

function steamBlock(s: Steam) {
  return s ? `\n\n[Steam 정보]\n장르: ${s.genres}\n사용자 태그(많이 붙은 순): ${s.tags.slice(0, 15).join(', ')}\n소개: ${s.desc}\n출시일: ${s.release}\n가격: ${s.price}\n한국어: ${s.korean}` : '';
}

// --- 새 글 분석 ---
async function processNewPost(p: { id: string; category: string; subject: string }) {
  const title = `[${p.category}]${p.subject}`;
  const content = await cafeContent(p.id);
  const contentLink = content.match(/https?:\/\/store\.steampowered\.com\/app\/\d+[^\s"'<>]*/)?.[0]
    ?? content.match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? '-';

  let appId = steamId(contentLink);
  let steam = appId ? await steamDetails(appId) : null;
  // 원문을 자르지 않고 넘기되, 비정상적으로 긴 글만 앞부분 사용
  const ai = await askClaude(`[추천글 제목]\n${title}\n\n[추천글 본문]\n${content.slice(0, 8000) || '(본문 없음)'}${steamBlock(steam)}`);

  // AI가 없을 때: 제목에서 [말머리]와 플레이타임을 뺀 나머지를 게임명으로
  const fallbackName = p.subject.replace(/\[.*?\]/g, ' ').replace(/\(?\d+(?:\.\d+)?\s*(?:시간|분)\)?/g, '').trim() || p.subject;
  const name = ai?.game_name && ai.game_name !== '-' ? ai.game_name : fallbackName;
  if (!steam && contentLink === '-') {
    appId = await steamSearch(name);
    steam = appId ? await steamDetails(appId) : null;
  }
  const pick = (a: string | undefined, b: string | undefined) => (a && a !== '-' ? a : b && b !== '-' ? b : '-');

  const game = {
    '카테고리': p.category,
    '글제목': title,
    '게임이름': name,
    '출시일': pick(ai?.release_date, steam?.release),
    '가격': pick(ai?.price, steam?.price),
    '링크': contentLink !== '-' ? contentLink : steam?.url ?? '-',
    '한글화': pick(ai?.korean, steam?.korean),
    '플레이타임': pick(ai?.playtime, p.subject.match(/(\d+(?:\.\d+)?\s*(?:시간|분))/)?.[1]),
    '게시글링크': articleLink(p.id),
    '스팀이미지': steam?.image ?? '-',
    '스팀할인': steam?.discount ?? 0,
    '유저평가': steam?.review ?? '-',
    '트레일러': steam?.trailer ?? '-',
  };
  return { game, info: aiRow(game['게시글링크'], ai, steam) };
}

// --- 기존 게임 AI 채우기 ---
async function backfillOne(g: Record<string, string>, prev?: { source: string; genres: string[]; summary: string }) {
  const appId = steamId(g['링크']) ?? steamId(g['스팀이미지']);
  // 예전 방식 AI 결과: 설명은 그대로 두고 장르만 Steam 태그로 다시 계산 (AI 재호출 없음)
  if (prev?.source === 'ai' && prev.summary) {
    const tags = appId ? await steamTags(appId) : [];
    return { link: g['게시글링크'], genres: tags.length ? tagGenres(tags) : prev.genres, summary: prev.summary, source: 'ai2', updated_at: new Date().toISOString() };
  }
  const steam = appId ? await steamDetails(appId, false) : null;
  let body = '';
  if (!steam && claude) {
    const id = g['게시글링크'].match(/articleid=(\d+)/)?.[1];
    if (id) body = (await cafeContent(id)).slice(0, 8000);
  }
  const ai = await askClaude(`[추천글 제목]\n${g['글제목']}\n[게임 이름]\n${g['게임이름']}${body ? `\n\n[추천글 본문]\n${body}` : ''}${steamBlock(steam)}`);
  return aiRow(g['게시글링크'], ai, steam);
}

async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ status: 'error', msg: 'POST only' }, 405);
  const opts = await req.json().catch(() => ({}));
  const backfillLimit = Math.min(Number(opts.backfill ?? BACKFILL_PER_CALL) || 0, 60);

  try {
    const [posts, known, cached, aiDone] = await Promise.all([
      cafeList(),
      fetch(GAMES_JSON, { cache: 'no-store' }).then(r => r.json()) as Promise<Record<string, string>[]>,
      sbAll('live_games?select=link'),
      sbAll('game_ai?select=link,source,genres,summary'),
    ]);
    const knownLinks = new Set(known.map(g => g['게시글링크']));
    const cachedLinks = new Set((cached as any[]).map(r => r.link));
    const rowLinks = new Set((aiDone as any[]).map(r => r.link));
    // 키가 있으면 AI로 쓴 것만 완료로 봄 (Steam으로 임시로 채운 건 AI로 다시 작성)
    // (키가 없으면 태그 기반·정보 없음도 완료. 예전 방식(steam, 공식 장르)으로 채운 건 태그로 다시 채움)
    const done = (src: string) => src === 'ai2' || (!claude && (src === 'tags' || src === 'none'));
    const prevRows = new Map((aiDone as any[]).map(r => [r.link, r]));
    const aiLinks = new Set((aiDone as any[]).filter(r => done(r.source)).map(r => r.link));

    // games.json에 이미 반영된 임시 글은 정리
    const stale = [...cachedLinks].filter(l => knownLinks.has(l));
    if (stale.length) await sb(`live_games?link=in.(${stale.map(l => `"${l}"`).join(',')})`, { method: 'DELETE' });

    // 1) 새 글
    const fresh = posts.filter((p: any) => !knownLinks.has(articleLink(p.id)) && !cachedLinks.has(articleLink(p.id))).slice(0, NEW_PER_CALL);
    const processed = await inBatches(fresh, 4, processNewPost);
    await upsert('live_games', processed.map(x => ({ link: x.game['게시글링크'], data: x.game, updated_at: new Date().toISOString() })));
    const newInfo = processed.map(x => x.info);
    newInfo.forEach(r => aiLinks.add(r.link));

    // 2) 장르/설명 채우기 (최신 글부터)
    // 아직 아무 정보도 없는 게임 먼저, 그다음 Steam으로 채워둔 게임을 AI로 다시 작성
    // (AI가 계속 실패해도 같은 게임만 반복하지 않고 나머지가 Steam 정보로라도 채워지게)
    const todo = known.filter(g => !aiLinks.has(g['게시글링크']))
      .sort((a, b) => Number(rowLinks.has(a['게시글링크'])) - Number(rowLinks.has(b['게시글링크'])));
    const filled = await inBatches(todo.slice(0, backfillLimit), 10, g => backfillOne(g, prevRows.get(g['게시글링크'])));
    await upsert('game_ai', [...newInfo, ...filled]);

    // 아직 games.json에 반영되지 않은 글(이번에 찾은 것 + 예전에 찾아둔 것)을 함께 반환
    const live = await (await sb('live_games?select=data&order=link.desc')).json();
    return json({
      status: 'ok',
      ai: !!claude,
      ai_error: lastAiError || undefined,
      new_count: processed.length,
      ai_filled: newInfo.length + filled.length,
      ai_remaining: todo.length - filled.length,
      games: (live as any[]).map(r => r.data).filter(g => !knownLinks.has(g['게시글링크'])),
    });
  } catch (e) {
    console.error(e);
    return json({ status: 'error', msg: String(e) }, 500);
  }
});
