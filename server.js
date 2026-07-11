'use strict';

// ──────────────────────────────────────────────────────────────────────────
// Mock ADFS/MobilAve SSO 서버 (의존성 없는 순수 Node.js) — contract 2.0.0
//
// 셸(Platform-App/src/App.jsx)의 실제 SSO 흐름 = code 교환 + introspect:
//   1. 미인증 → ${SSO_URL}/Account/ADFSLogin?client=<origin> 로 top-level 이동 (App.jsx:147)
//   2. 이 서버가 1회용 code 를 발급하고 <client>?auth=1&code=<code> 로 302 리다이렉트
//      (App.jsx:114-115 가 auth, code 둘 다 있어야 콜백을 처리)
//   3. 앱이 GET /Account/exchange?code=<code> 호출 → { sessionToken } 수신 (App.jsx:117-120)
//      앱이 스스로 SSO_SESSION 쿠키를 자기 origin 에 저장 (App.jsx:121)
//   4. 앱이 GET /Account/introspect?token=<sessionToken> 호출 → { loginid, active } (App.jsx:122-125,141-144)
//      유효 판정(openapi-auth.yaml): HTTP 200 AND loginid != "" AND active != "false"
//
// 중요: exchange/introspect 는 앱이 authFetch 로 cross-origin fetch 호출한다
// (앱 origin ≠ SSO origin). 따라서 CORS 응답 헤더 + OPTIONS 프리플라이트 처리가 필수다.
// (getToken() 이 토큰을 돌려주면 authFetch 가 Authorization: Bearer 를 붙여 프리플라이트를 유발)
//
// 구(舊) ADSSO_UID 쿠키 방식은 contract 2.0.0 에서 폐기됐다. 하위호환용 흔적은 남기지 않는다.
// ──────────────────────────────────────────────────────────────────────────

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8443', 10);
const HOST = process.env.HOST || '0.0.0.0';
// 기본 모킹 사용자 (Platform-App/src/config.js 의 DEV_USER 기본값과 동일).
// 시작값은 env 로 정하되, 런타임에 POST/GET /set-user 로 바꿀 수 있다(currentUser).
const DEFAULT_USER = process.env.MOCK_USER || 'duke.kimm';
// 현재 활성 모킹 사용자. 기본 로그인(ADFSLogin) · 폴백 · whoami 가 모두 이 값을 따른다.
// ?user= 오버라이드는 이 값과 무관하게 그 요청에만 적용된다.
let currentUser = DEFAULT_USER;
// code 유효기간(초). SSO 콜백~exchange 사이 짧게. 기본 5분.
const CODE_TTL = parseInt(process.env.CODE_TTL || '300', 10);
// sessionToken 유효기간(초). 셸 쿠키 max-age(8h)와 맞춘다.
const SESSION_TTL = parseInt(process.env.SESSION_TTL || String(60 * 60 * 8), 10);
// 서버 재시작 등으로 code/token 을 잃었을 때, 알 수 없는 code/token 을 MOCK_USER 로
// 관대하게 처리해 무한 루프를 막는다. 엄격 모드가 필요하면 LENIENT=false.
const LENIENT = process.env.LENIENT !== 'false';

// ── 인메모리 저장소 ─────────────────────────────────────────────────────────
// code → { user, exp } (1회용).  sessionToken → { user, exp }.
const codes = new Map();
const sessions = new Map();

function now() {
  return Math.floor(Date.now() / 1000);
}

function newToken(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sweep() {
  const t = now();
  for (const [k, v] of codes) if (v.exp <= t) codes.delete(k);
  for (const [k, v] of sessions) if (v.exp <= t) sessions.delete(k);
}

function log(...args) {
  console.log('[sso-mock]', ...args);
}

function isSafeClient(client) {
  if (!client) return false;
  try {
    const u = new URL(client);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// cross-origin fetch(authFetch) 를 허용한다. credentials 를 켜므로 ACAO 에 '*' 대신
// 요청 Origin 을 그대로 반향한다. Origin 이 없으면(top-level 내비게이션 등) '*'.
function corsHeaders(req) {
  const origin = req.headers.origin;
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, X-User-Id, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Credentials'] = 'true';
  } else {
    h['Access-Control-Allow-Origin'] = '*';
  }
  return h;
}

function sendJson(req, res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(obj, null, 2));
}

function sendHtml(req, res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    ...corsHeaders(req),
  });
  res.end(html);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = u.pathname;

  // ── CORS 프리플라이트 ──────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  sweep();

  // ── 1) 로그인 진입: 1회용 code 발급 후 콜백으로 리다이렉트 ─────────────────
  //    <client>?auth=1&code=<code>  (App.jsx 가 auth+code 로 콜백 인식)
  if (path === '/Account/ADFSLogin') {
    const client = u.searchParams.get('client');
    const user = u.searchParams.get('user') || currentUser; // ?user= 로 이 요청만 오버라이드
    const code = newToken(16);
    codes.set(code, { user, exp: now() + CODE_TTL });
    log(`ADFSLogin user="${user}" client="${client}" -> code=${code.slice(0, 8)}…`);

    if (isSafeClient(client)) {
      const cb = new URL(client);
      cb.searchParams.set('auth', '1');
      cb.searchParams.set('code', code);
      res.writeHead(302, { Location: cb.toString(), ...corsHeaders(req) });
      res.end();
      return;
    }
    // client 누락/부적합: 콜백 대신 code 를 안내 (수동 테스트용).
    sendHtml(
      req, res, 200,
      `<!doctype html><meta charset="utf-8"><title>Mock SSO</title>
       <h2>Mock ADFS SSO</h2>
       <p>code 발급: <code>${code}</code> (user=<strong>${user}</strong>)</p>
       <p><code>client</code> 파라미터가 없어 리다이렉트를 생략했습니다.</p>
       <p>교환: <code>GET /Account/exchange?code=${code}</code></p>`
    );
    return;
  }

  // ── 2) code → sessionToken 교환 ────────────────────────────────────────
  if (path === '/Account/exchange') {
    const code = u.searchParams.get('code');
    let entry = code ? codes.get(code) : null;
    if (entry) codes.delete(code); // 1회용

    if (!entry) {
      if (!LENIENT || !code) {
        sendJson(req, res, 400, { error: 'invalid_or_expired_code' });
        return;
      }
      // 관대 모드: 서버 재시작 등으로 code 유실 시 currentUser 로 세션 발급 (루프 방지).
      log(`exchange: unknown code=${String(code).slice(0, 8)}… -> fallback user=${currentUser}`);
      entry = { user: currentUser };
    }

    const sessionToken = newToken(24);
    sessions.set(sessionToken, { user: entry.user, exp: now() + SESSION_TTL });
    log(`exchange -> sessionToken=${sessionToken.slice(0, 8)}… user="${entry.user}"`);
    sendJson(req, res, 200, { sessionToken });
    return;
  }

  // ── 3) sessionToken 검증(신원 확정) ────────────────────────────────────
  //    유효: 200 AND loginid != "" AND active != "false"
  if (path === '/Account/introspect') {
    const token = u.searchParams.get('token');
    const sess = token ? sessions.get(token) : null;

    if (sess) {
      sendJson(req, res, 200, { loginid: sess.user, active: 'true' });
      return;
    }
    if (LENIENT && token) {
      // 관대 모드: 알 수 없는 토큰도 currentUser 로 확정 (재시작 후 세션 복원 실패로 인한 루프 방지).
      log(`introspect: unknown token=${String(token).slice(0, 8)}… -> fallback user=${currentUser}`);
      sendJson(req, res, 200, { loginid: currentUser, active: 'true' });
      return;
    }
    // 엄격 모드 또는 토큰 없음: 무효.
    sendJson(req, res, 200, { loginid: '', active: 'false' });
    return;
  }

  // ── 로그아웃: 서버 세션 무효화 후 client 로 복귀 ─────────────────────────
  //    (SSO_SESSION 쿠키는 앱 origin 소유라 여기서 지울 수 없다 — 앱이 클라이언트에서 삭제)
  if (path === '/Account/Logout' || path === '/logout') {
    const client = u.searchParams.get('client');
    const token = u.searchParams.get('token');
    if (token) sessions.delete(token);
    if (isSafeClient(client)) {
      res.writeHead(302, { Location: client, ...corsHeaders(req) });
      res.end();
      return;
    }
    sendHtml(req, res, 200, '<!doctype html><meta charset="utf-8"><p>로그아웃되었습니다.</p>');
    return;
  }

  // ── 활성 사용자 변경 API ────────────────────────────────────────────────
  //    런타임에 기본 모킹 사용자(currentUser)를 바꾼다. 이후 일반 로그인(ADFSLogin,
  //    ?user= 없이)·폴백·whoami 가 이 사용자로 동작한다. 재기동 없이 즉시 반영.
  //    - GET  /set-user?user=batman        (브라우저에서 바로 호출 가능)
  //    - POST /set-user   body: user=batman  또는  {"user":"batman"}
  //    빈 값이면 DEFAULT_USER(env MOCK_USER) 로 리셋.
  if (path === '/set-user' || path === '/Account/set-user') {
    const applyUser = (raw) => {
      const next = (raw == null || raw === '') ? DEFAULT_USER : String(raw).trim();
      const prev = currentUser;
      currentUser = next;
      log(`set-user: "${prev}" -> "${currentUser}"`);
      sendJson(req, res, 200, { user: currentUser, previous: prev, default: DEFAULT_USER });
    };
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let user = u.searchParams.get('user');
        if (!user && body) {
          const ct = req.headers['content-type'] || '';
          try {
            if (ct.includes('application/json')) user = JSON.parse(body).user;
            else user = new URLSearchParams(body).get('user');
          } catch (_) { /* 무시 — user 는 null 로 남아 리셋 */ }
        }
        applyUser(user);
      });
      return;
    }
    // GET (또는 기타 메서드): 쿼리스트링 user 사용.
    applyUser(u.searchParams.get('user'));
    return;
  }

  // ── 편의 엔드포인트 ────────────────────────────────────────────────────
  if (path === '/whoami') {
    sendJson(req, res, 200, { user: currentUser, default: DEFAULT_USER });
    return;
  }
  if (path === '/health') {
    sendJson(req, res, 200, { ok: true, codes: codes.size, sessions: sessions.size });
    return;
  }

  if (path === '/') {
    sendHtml(
      req, res, 200,
      `<!doctype html><meta charset="utf-8">
       <title>Mock ADFS SSO (contract 2.0.0)</title>
       <style>body{font-family:system-ui,Segoe UI,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.6}code{background:#f3f3f3;padding:2px 5px;border-radius:4px}</style>
       <h1>Mock ADFS/MobilAve SSO <small>(contract 2.0.0)</small></h1>
       <p>현재 모킹 사용자: <strong>${currentUser}</strong> (기본값 <code>${DEFAULT_USER}</code>) · 관대모드: <strong>${LENIENT ? 'on' : 'off'}</strong></p>
       <h3>SSO 흐름 (code 교환 + introspect)</h3>
       <ol>
         <li><code>GET /Account/ADFSLogin?client=&lt;origin&gt;</code> — 1회용 code 발급 후 <code>&lt;origin&gt;?auth=1&amp;code=…</code> 로 302 (<code>&amp;user=</code> 오버라이드)</li>
         <li><code>GET /Account/exchange?code=…</code> — <code>{ "sessionToken": "…" }</code></li>
         <li><code>GET /Account/introspect?token=…</code> — <code>{ "loginid": "…", "active": "true" }</code></li>
       </ol>
       <h3>기타</h3>
       <ul>
         <li><code>GET /set-user?user=batman</code> (또는 <code>POST /set-user</code>) — 활성 사용자 런타임 변경(재기동 불필요). user 생략 시 기본값으로 리셋</li>
         <li><code>GET /Account/Logout?client=&lt;origin&gt;&amp;token=…</code> — 세션 무효화 후 복귀</li>
         <li><code>GET /whoami</code> · <code>GET /health</code></li>
       </ul>
       <h3>앱 연동</h3>
       <pre>REACT_APP_SSO_URL=http://localhost:${PORT}
REACT_APP_USE_SSO=true</pre>
       <p>exchange/introspect 는 cross-origin fetch 이므로 CORS 응답 헤더가 포함되어 있습니다.</p>`
    );
    return;
  }

  sendJson(req, res, 404, { error: 'not found', path });
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  (contract 2.0.0, mock user: ${currentUser}, lenient: ${LENIENT})`);
  log(`set app:  REACT_APP_SSO_URL=http://localhost:${PORT}  &  REACT_APP_USE_SSO=true`);
});
