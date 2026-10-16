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
