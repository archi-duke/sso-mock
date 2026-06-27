'use strict';

// ──────────────────────────────────────────────────────────────────────────
// Mock ADFS SSO 서버 (의존성 없음, 순수 Node.js)
//
// GoJIRA / Platform-App 의 SSO 흐름(Platform-App/src/utils/auth.js)을 모킹한다:
//   1. 앱이 로그인 안 된 상태에서
//        ${SSO_URL}/Account/ADFSLogin?client=${window.location.origin}
//      로 top-level 이동한다.
//   2. 이 서버가 ADSSO_UID 쿠키(= 사용자 ID)를 심고
//      client(앱 origin) 으로 302 리다이렉트한다.
//   3. 앱이 document.cookie 로 ADSSO_UID 를 읽어 사용자를 식별한다.
//      (앱이 JS 로 읽으므로 쿠키는 HttpOnly 가 아니어야 한다.)
//
// 쿠키는 포트로 격리되지 않으므로, 이 서버를 앱과 같은 호스트명(localhost)에서
// 실행하면 다른 포트라도 ADSSO_UID 가 공유된다. 다른 호스트면 부모 도메인을
// COOKIE_DOMAIN 으로 지정해야 한다.
// ──────────────────────────────────────────────────────────────────────────

const http = require('http');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8443', 10);
const HOST = process.env.HOST || '0.0.0.0';
// 설정에 지정된 사용자 (Platform-App/src/config.js 의 DEV_USER 기본값과 동일)
const MOCK_USER = process.env.MOCK_USER || 'duke.kimm';
// 쿠키 유효기간(초). 기본 1년.
const COOKIE_MAX_AGE = parseInt(process.env.COOKIE_MAX_AGE || String(60 * 60 * 24 * 365), 10);
// 다른 호스트 간 공유가 필요할 때만 부모 도메인 지정 (예: ".example.com")
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '';
// 쿠키 이름 — 앱(auth.js)이 읽는 이름과 일치해야 한다.
const COOKIE_NAME = 'ADSSO_UID';

function log(...args) {
  // eslint 흉내 없이 단순 로깅
  console.log('[sso-mock]', ...args);
}

function buildSetCookie(value, maxAge) {
  // HttpOnly 를 붙이지 않는다 — 앱이 document.cookie 로 읽어야 하므로.
  // SameSite=Lax: top-level GET 내비게이션(리다이렉트 복귀)에서 쿠키 전송 허용.
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (COOKIE_DOMAIN) parts.push(`Domain=${COOKIE_DOMAIN}`);
  return parts.join('; ');
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

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = u.pathname;

  // ── SSO 로그인 엔드포인트 ──────────────────────────────────────────────
  // 앱이 리다이렉트해 오는 경로. 사용자 쿠키를 심고 client 로 되돌려보낸다.
  if (path === '/Account/ADFSLogin') {
    const client = u.searchParams.get('client');
    // 데모/테스트용으로 ?user= 로 사용자 오버라이드 가능, 없으면 설정값 사용.
    const user = u.searchParams.get('user') || MOCK_USER;

    const setCookie = buildSetCookie(user, COOKIE_MAX_AGE);
    log(`ADFSLogin user="${user}" client="${client}"`);

    if (isSafeClient(client)) {
      res.writeHead(302, { 'Set-Cookie': setCookie, Location: client });
      res.end();
      return;
    }

    // client 가 없거나 잘못된 경우: 쿠키만 심고 안내 페이지 표시.
    res.writeHead(200, {
      'Set-Cookie': setCookie,
      'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(
      `<!doctype html><meta charset="utf-8">
       <title>Mock SSO</title>
       <h2>Mock ADFS SSO</h2>
       <p>쿠키 <code>${COOKIE_NAME}=${user}</code> 를 발급했습니다.</p>
       <p><code>client</code> 파라미터가 없어 리다이렉트를 생략했습니다.</p>`
    );
    return;
  }

  // ── 로그아웃 ─────────────────────────────────────────────────────────
  if (path === '/Account/Logout' || path === '/logout') {
    const client = u.searchParams.get('client');
    const expire = buildSetCookie('', 0);
    if (isSafeClient(client)) {
      res.writeHead(302, { 'Set-Cookie': expire, Location: client });
      res.end();
      return;
    }
    res.writeHead(200, { 'Set-Cookie': expire, 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><p>로그아웃되었습니다.</p>');
    return;
  }

  // ── 편의용: 현재 모킹 사용자 확인 ──────────────────────────────────────
  if (path === '/whoami') {
    sendJson(res, 200, { user: MOCK_USER });
    return;
  }

  if (path === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── 루트 안내 페이지 ─────────────────────────────────────────────────
  if (path === '/') {
    sendHtml(
      res,
      200,
      `<!doctype html><meta charset="utf-8">
       <title>Mock ADFS SSO</title>
       <style>body{font-family:system-ui,Segoe UI,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;line-height:1.6}code{background:#f3f3f3;padding:2px 5px;border-radius:4px}</style>
       <h1>Mock ADFS SSO</h1>
       <p>현재 모킹 사용자: <strong>${MOCK_USER}</strong></p>
       <h3>엔드포인트</h3>
       <ul>
         <li><code>GET /Account/ADFSLogin?client=&lt;app-origin&gt;</code> — ADSSO_UID 쿠키 발급 후 client 로 리다이렉트 (<code>&amp;user=</code> 로 사용자 오버라이드 가능)</li>
         <li><code>GET /Account/Logout?client=&lt;app-origin&gt;</code> — 쿠키 만료 후 리다이렉트</li>
         <li><code>GET /whoami</code> — 현재 모킹 사용자(JSON)</li>
         <li><code>GET /health</code> — 헬스체크</li>
       </ul>
       <h3>앱 연동</h3>
       <p>앱의 환경변수 / config 를 다음과 같이 설정:</p>
       <pre>REACT_APP_SSO_URL=http://localhost:${PORT}
USE_SSO=true</pre>
       <p>쿠키는 포트로 격리되지 않으므로 이 서버를 앱과 같은 호스트(localhost)에서 실행하면 됩니다.</p>`
    );
    return;
  }

  sendJson(res, 404, { error: 'not found', path });
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  (mock user: ${MOCK_USER})`);
  log(`set app:  REACT_APP_SSO_URL=http://localhost:${PORT}  &  USE_SSO=true`);
});
