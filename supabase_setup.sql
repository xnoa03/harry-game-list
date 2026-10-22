-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번만 실행하세요.

create table if not exists public.categories (
    link text primary key,          -- 게시글링크
    category text not null,
    updated_at timestamptz not null default now()
);

alter table public.categories enable row level security;

-- 사이트 방문자(anon) 누구나 카테고리를 읽고 바꿀 수 있음 (삭제는 불가)
drop policy if exists "anyone can read"   on public.categories;
drop policy if exists "anyone can insert" on public.categories;
drop policy if exists "anyone can update" on public.categories;
create policy "anyone can read"   on public.categories for select to anon using (true);
create policy "anyone can insert" on public.categories for insert to anon with check (category in ('게임','공겜','할 게임','일단 킵','협동','한 게임'));
create policy "anyone can update" on public.categories for update to anon using (true) with check (category in ('게임','공겜','할 게임','일단 킵','협동','한 게임'));

-- ===== 접속 시 실시간 카페 수집 + AI 장르/설명 (live-games 함수용) =====
-- 쓰기는 Edge Function(service role)만, 사이트 방문자는 읽기만 가능

create table if not exists public.live_games (
    link text primary key,          -- 아직 games.json에 없는 새 글의 게시글링크
    data jsonb not null,
    updated_at timestamptz not null default now()
);

create table if not exists public.game_ai (
    link text primary key,          -- 게시글링크
    genres text[] not null default '{}',
    summary text not null default '',
    updated_at timestamptz not null default now()
);

alter table public.live_games enable row level security;
alter table public.game_ai enable row level security;

drop policy if exists "anyone can read" on public.live_games;
drop policy if exists "anyone can read" on public.game_ai;
create policy "anyone can read" on public.live_games for select to anon using (true);
create policy "anyone can read" on public.game_ai   for select to anon using (true);
