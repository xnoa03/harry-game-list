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
// Steam 한국어 장르 -> 사이트 장르
const STEAM_GENRE: Record<string, string> = {
  '액션': '액션', '어드벤처': '어드벤처', '롤플레잉': 'RPG', 'RPG': 'RPG', '시뮬레이션': '시뮬레이션',
  '전략': '전략', '스포츠': '스포츠', '레이싱': '레이싱',
};
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
function aiRow(link: string, ai: AiInfo | null, steam: Steam) {
  const base = { link, updated_at: new Date().toISOString() };
  if (ai) return { ...base, genres: ai.genres, summary: ai.summary, source: 'ai' };
  if (steam) {
    const genres = [...new Set(steam.genres.split(', ').map((x: string) => STEAM_GENRE[x]).filter(Boolean))].slice(0, 3);
    return { ...base, genres, summary: steam.desc, source: 'steam' };
  }
  return { ...base, genres: [], summary: '', source: 'none' };
}

function steamBlock(s: Steam) {
  return s ? `\n\n[Steam 정보]\n장르: ${s.genres}\n소개: ${s.desc}\n출시일: ${s.release}\n가격: ${s.price}\n한국어: ${s.korean}` : '';
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
async function backfillOne(g: Record<string, string>) {
  const appId = steamId(g['링크']) ?? steamId(g['스팀이미지']);
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
      sbAll('game_ai?select=link,source'),
    ]);
    const knownLinks = new Set(known.map(g => g['게시글링크']));
    const cachedLinks = new Set((cached as any[]).map(r => r.link));
    const rowLinks = new Set((aiDone as any[]).map(r => r.link));
    // 키가 있으면 AI로 쓴 것만 완료로 봄 (Steam으로 임시로 채운 건 AI로 다시 작성)
    const aiLinks = new Set((aiDone as any[]).filter(r => !claude || r.source === 'ai').map(r => r.link));

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
    const filled = await inBatches(todo.slice(0, backfillLimit), 10, backfillOne);
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
