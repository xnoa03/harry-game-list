// 사이트의 "데이터 갱신" 버튼이 호출하는 함수.
// GitHub 토큰을 브라우저에 노출하지 않고 GitHub Actions 워크플로를 실행한다.
// 필요한 시크릿: GH_TOKEN (harry-game-list 저장소의 Actions: Read and write 권한을 가진 fine-grained 토큰)

const REPO = 'xnoa03/harry-game-list';
const WORKFLOW = 'update-data.yml';
const COOLDOWN_MIN = 10;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ status: 'error', msg: 'POST only' }, 405);

  const token = Deno.env.get('GH_TOKEN');
  if (!token) return json({ status: 'error', msg: 'GH_TOKEN 시크릿이 설정되지 않았습니다' }, 500);

  const gh = (path: string, init: RequestInit = {}) =>
    fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'harry-game-list' },
    });

  // 이미 실행 중이거나 방금 실행됐으면 새로 실행하지 않음 (버튼 연타 방지)
  const runsRes = await gh('/runs?per_page=1');
  if (!runsRes.ok) return json({ status: 'error', msg: `GitHub ${runsRes.status}` }, 502);
  const last = (await runsRes.json()).workflow_runs?.[0];
  if (last && last.status !== 'completed') return json({ status: 'running', run_id: last.id });
  if (last) {
    const mins = (Date.now() - Date.parse(last.created_at)) / 60000;
    if (mins < COOLDOWN_MIN) return json({ status: 'cooldown', wait: Math.ceil(COOLDOWN_MIN - mins) });
  }

  const res = await gh('/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { pages: '3' } }) });
  if (!res.ok) return json({ status: 'error', msg: `GitHub ${res.status}: ${await res.text()}` }, 502);
  return json({ status: 'started' });
});
