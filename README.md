# GoJIRA Mock ADFS/MobilAve SSO — contract 2.0.0

GoJIRA / Platform-App 의 SSO 로그인 흐름을 로컬에서 모킹하는 **의존성 없는** Node.js 서버입니다.
실제 SSO 없이도 `REACT_APP_USE_SSO=true` 상태의 **code 교환 + introspect** 인증 흐름을 검증할 수 있습니다.

> **contract 2.0.0 안내:** 구(舊) `ADSSO_UID` 쿠키 방식은 폐기됐습니다. 새 셸(`Platform-App/src/App.jsx`)은
> `?auth=1&code=` 콜백 → `/Account/exchange` → `/Account/introspect` 방식을 사용합니다.
> (계약: `GoJIRA/docs/platform-contract/02-auth-contract.md`, `openapi-auth.yaml`)

## 모킹하는 흐름

셸(`Platform-App/src/App.jsx`)의 SSO 로직:

1. 미인증 → `${SSO_URL}/Account/ADFSLogin?client=<origin>` 으로 top-level 이동 (App.jsx:147)
2. 이 서버가 **1회용 `code`** 를 발급하고 `<origin>?auth=1&code=<code>` 로 302 리다이렉트
   (App.jsx:114-115 가 `auth`, `code` 둘 다 있어야 콜백을 인식)
3. 앱이 `GET /Account/exchange?code=<code>` 호출 → `{ sessionToken }` 수신 (App.jsx:117-120)
   앱이 스스로 `SSO_SESSION` 쿠키를 **자기 origin** 에 저장 (App.jsx:121)
4. 앱이 `GET /Account/introspect?token=<sessionToken>` 호출 → `{ loginid, active }` (App.jsx:122-125, 141-144)
   유효 판정: **HTTP 200 AND `loginid` != "" AND `active` != "false"**

> **CORS 필수:** exchange/introspect 는 앱이 `authFetch` 로 **cross-origin fetch** 호출합니다
> (앱 origin ≠ SSO origin). 이 서버는 요청 Origin 을 반향하는 CORS 응답 헤더와 `OPTIONS`
> 프리플라이트를 처리합니다. `getToken()` 이 Bearer 토큰을 붙이면 프리플라이트가 유발됩니다.

## 실행

```bash
node server.js   # 또는 npm start
```

기본 포트 `8443`, 기본 사용자 `duke.kimm`.

### 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `8443` | 리슨 포트 |
| `HOST` | `0.0.0.0` | 바인드 주소 |
| `MOCK_USER` | `duke.kimm` | 기본 모킹 사용자(loginid) |
| `CODE_TTL` | `300` | 1회용 code 유효기간(초) |
| `SESSION_TTL` | `28800` | sessionToken 유효기간(초, 기본 8h — 셸 쿠키 max-age 와 동일) |
| `LENIENT` | `true` | 서버 재시작 등으로 알 수 없는 code/token 을 `MOCK_USER` 로 관대하게 처리(무한 루프 방지). 엄격 검증은 `LENIENT=false` |

예:

```bash
MOCK_USER=hong.gildong PORT=8443 node server.js
```

## 앱 연동

앱(Platform-App / GoJIRA-App) 쪽 설정:

```
REACT_APP_SSO_URL=http://localhost:8443
REACT_APP_USE_SSO=true
```

> **dev 모드로 바로 쓰기:** SSO 없이 즉시 쓰려면 `REACT_APP_USE_SSO=false` — 셸이 `DEV_USER` +
> `X-User-Id` 폴백으로 동작해 루프 없이 사용 가능합니다(단 SSO 경로는 미검증). SSO 흐름 자체를
> 검증하려면 위처럼 `true` 로 두고 이 mock 을 사용하세요.

## 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/Account/ADFSLogin?client=<origin>` | 1회용 code 발급 후 `<origin>?auth=1&code=…` 로 302. `&user=` 로 사용자 오버라이드 |
| GET | `/Account/exchange?code=…` | `{ "sessionToken": "…" }` |
| GET | `/Account/introspect?token=…` | `{ "loginid": "…", "active": "true" }` (무효 시 `loginid:""`, `active:"false"`) |
| GET | `/Account/Logout?client=<origin>&token=…` | 서버 세션 무효화 후 복귀 (`/logout` 별칭) |
| GET | `/whoami` | 현재 기본 모킹 사용자(JSON) |
| GET | `/health` | 헬스체크 (발급된 code/session 수 포함) |
| GET | `/` | 안내 페이지 |
| OPTIONS | `*` | CORS 프리플라이트(204) |

## 빠른 테스트

```bash
node server.js &

# 1) 로그인 진입 → 콜백에서 code 추출
LOC=$(curl -s -i "http://localhost:8443/Account/ADFSLogin?client=http://localhost:3000" \
  | grep -i location: | tr -d '\r' | awk '{print $2}')
CODE=$(echo "$LOC" | sed -n 's/.*code=\([a-f0-9]*\).*/\1/p')
echo "callback: $LOC"

# 2) code → sessionToken
TOKEN=$(curl -s "http://localhost:8443/Account/exchange?code=$CODE" \
  | sed -n 's/.*"sessionToken": *"\([a-f0-9]*\)".*/\1/p')

# 3) sessionToken → loginid
curl -s "http://localhost:8443/Account/introspect?token=$TOKEN"
# → {"loginid":"duke.kimm","active":"true"}
```
