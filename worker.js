/**
 * Cloudflare Worker: shared JSON storage for the static GitHub Pages app.
 * Required Worker settings:
 *   GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH (plain text)
 *   GITHUB_TOKEN (secret)
 */
const ALLOWED_ORIGIN = 'https://bizjtkim.github.io';
const FILE_PATH = 'data.json';
const API = 'https://api.github.com';
const MAX_BODY_BYTES = 2_000_000;
const MAX_AUDIT_ENTRIES = 200;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function reply(request, body, status = 200) {
  const headers = corsHeaders(request.headers.get('Origin') || '');
  headers['Content-Type'] = 'application/json; charset=utf-8';
  headers['Cache-Control'] = 'no-store, max-age=0';
  return new Response(JSON.stringify(body), { status, headers });
}
function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function base64ToUtf8(value) {
  const binary = atob(value.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function githubHeaders(env) {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wellshomecare-shared-data-worker'
  };
}
function settingsError(env) {
  return !env.GITHUB_OWNER || !env.GITHUB_REPO || !env.GITHUB_BRANCH || !env.GITHUB_TOKEN;
}
async function readFile(env) {
  const url = `${API}/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/contents/${FILE_PATH}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`;
  const response = await fetch(url, { headers: githubHeaders(env) });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub 읽기 실패 ${response.status}: ${detail.slice(0, 300)}`);
  }
  const file = await response.json();
  if (file.type !== 'file' || !file.content) throw new Error('저장소 루트에 data.json 파일이 없습니다.');
  return { sha: file.sha, data: JSON.parse(base64ToUtf8(file.content)) };
}
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return '요청 내용이 비어 있습니다.';
  const name = String(payload.editorName || '').trim();
  if (!name || name.length > 40) return '수정자 이름을 입력해 주세요. (최대 40자)';
  if (!payload.state || !Array.isArray(payload.state.regions) || !Array.isArray(payload.state.people)) return '배정 상태 데이터 형식이 올바르지 않습니다.';
  if (payload.state.regions.length > 1000 || payload.state.people.length > 500) return '데이터 항목 수가 허용 범위를 넘었습니다.';
  if (!payload.expectedSha || typeof payload.expectedSha !== 'string') return '기존 파일 버전 정보가 없습니다. 페이지를 새로고침해 주세요.';
  return '';
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (origin && origin !== ALLOWED_ORIGIN) return reply(request, { error: '허용되지 않은 웹페이지 주소입니다.' }, 403);
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return reply(request, { ok: true, configured: !settingsError(env) });
    if (url.pathname !== '/state') return reply(request, { error: '주소를 찾을 수 없습니다.' }, 404);
    if (settingsError(env)) return reply(request, { error: 'Worker의 GitHub 설정이 완료되지 않았습니다.' }, 500);
    if (request.method === 'GET') {
      try {
        const current = await readFile(env);
        return reply(request, current);
      } catch (error) {
        return reply(request, { error: error.message }, 502);
      }
    }
    if (request.method !== 'POST') return reply(request, { error: '지원하지 않는 요청입니다.' }, 405);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return reply(request, { error: '전송 데이터가 너무 큽니다.' }, 413);
    let payload;
    try { payload = JSON.parse(raw); } catch { return reply(request, { error: 'JSON 형식이 올바르지 않습니다.' }, 400); }
    const invalid = validatePayload(payload);
    if (invalid) return reply(request, { error: invalid }, 400);
    try {
      const current = await readFile(env);
      if (current.sha !== payload.expectedSha) return reply(request, { error: '다른 사용자가 먼저 저장했습니다. 최신 데이터를 다시 불러와 주세요.', sha: current.sha, data: current.data }, 409);
      const now = new Date().toISOString();
      const name = String(payload.editorName).trim();
      const summary = payload.event && typeof payload.event === 'object' ? payload.event : {};
      const event = {
        at: now,
        editorName: name,
        label: String(summary.label || '지역 배정 데이터 수정').slice(0, 160),
        summary: String(summary.summary || '담당자 또는 지역 배정 정보를 변경했습니다.').slice(0, 500),
        changedRegions: Array.isArray(summary.changedRegions) ? summary.changedRegions.map(x => String(x).slice(0, 120)).slice(0, 100) : [],
        version: String(summary.version || '').slice(0, 40)
      };
      const history = Array.isArray(payload.history) ? payload.history.slice(0, 100) : [];
      if (history.length && history[0] && typeof history[0] === 'object') history[0].editorName = name;
      const auditLog = [...(Array.isArray(current.data.auditLog) ? current.data.auditLog : []), event].slice(-MAX_AUDIT_ENTRIES);
      const next = {
        schemaVersion: 1,
        appVersion: '26111201',
        updatedAt: now,
        updatedBy: name,
        state: payload.state,
        history,
        auditLog
      };
      const path = `${API}/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/contents/${FILE_PATH}`;
      const put = await fetch(path, {
        method: 'PUT', headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `배정 자료 수정: ${name} · ${event.label}`.slice(0, 120),
          content: utf8ToBase64(JSON.stringify(next)),
          sha: current.sha,
          branch: env.GITHUB_BRANCH
        })
      });
      const result = await put.json();
      if (!put.ok) {
        const status = put.status === 409 || put.status === 422 ? 409 : 502;
        return reply(request, { error: `GitHub 저장 실패 ${put.status}: ${result.message || '응답 오류'}` }, status);
      }
      return reply(request, { sha: result.content?.sha || '', data: next });
    } catch (error) {
      return reply(request, { error: error.message || '공유 저장 중 오류가 발생했습니다.' }, 502);
    }
  }
};
