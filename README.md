# GoJIRA Mock ADFS SSO

GoJIRA / Platform-App 의 SSO 로그인 흐름을 로컬에서 모킹하는 **의존성 없는** Node.js 서버입니다.
실제 ADFS 없이도 `USE_SSO=true` 상태의 인증 리다이렉트를 검증할 수 있습니다.

## 모킹하는 흐름

앱(`Platform-App/src/utils/auth.js`, `GoJIRA-App/src/utils/auth.js`)의 로직:

```js
window.location.href = `${config.SSO_URL}/Account/ADFSLogin?client=${window.location.origin}`;
// 복귀 후 document.cookie 의 ADSSO_UID 를 읽어 사용자 식별
```

1. 로그인 안 된 앱 → `${SSO_URL}/Account/ADFSLogin?client=<app-origin>` 으로 이동
2. 이 서버가 **`ADSSO_UID`** 쿠키(= 설정에 지정된 사용자)를 심고 `client` 로 302 리다이렉트
3. 앱이 `document.cookie` 로 `ADSSO_UID` 를 읽음 (그래서 쿠키는 **HttpOnly 아님**)

## 실행

```bash
node server.js
# 또는
npm start
```

기본 포트 `8443`, 기본 사용자 `duke.kimm`.

### 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `8443` | 리슨 포트 |
| `HOST` | `0.0.0.0` | 바인드 주소 |
| `MOCK_USER` | `duke.kimm` | 발급할 `ADSSO_UID` 값 (설정에 지정된 사용자) |
| `COOKIE_MAX_AGE` | `31536000` | 쿠키 유효기간(초, 기본 1년) |
| `COOKIE_DOMAIN` | (없음) | 다른 호스트 간 공유가 필요할 때만 부모 도메인 지정 (예: `.example.com`) |

예:

```bash
MOCK_USER=hong.gildong PORT=8443 node server.js
```

## 앱 연동

앱(Platform-App / GoJIRA-App) 쪽 설정:

```
REACT_APP_SSO_URL=http://localhost:8443
USE_SSO=true
```

`USE_SSO` 는 `src/config.js` 에서 `true` 로 바꾸거나(또는 빌드 시 주입), dev 모드에서 적용합니다.

> **쿠키 공유 주의**: 쿠키는 포트로 격리되지 않으므로, 이 서버를 앱과 **같은 호스트명(`localhost`)** 에서 실행하면 다른 포트라도 `ADSSO_UID` 가 공유됩니다.
> 앱과 SSO 가 서로 다른 호스트라면 `COOKIE_DOMAIN` 으로 공통 부모 도메인을 지정해야 브라우저가 쿠키를 전송합니다.

## 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/Account/ADFSLogin?client=<app-origin>` | `ADSSO_UID` 쿠키 발급 후 `client` 로 리다이렉트. `&user=` 로 사용자 오버라이드 가능 |
| GET | `/Account/Logout?client=<app-origin>` | 쿠키 만료 후 리다이렉트 (`/logout` 별칭) |
| GET | `/whoami` | 현재 모킹 사용자(JSON) |
| GET | `/health` | 헬스체크 |
| GET | `/` | 안내 페이지 |

## 빠른 테스트

```bash
node server.js &
curl -i "http://localhost:8443/Account/ADFSLogin?client=http://localhost:3000"
# → 302, Set-Cookie: ADSSO_UID=duke.kimm; ...  Location: http://localhost:3000
curl -s http://localhost:8443/whoami   # → {"user":"duke.kimm"}
```
