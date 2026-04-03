# minsnote-api

[minsnote](https://jinwonmin.github.io/minsnote.github.io/) 블로그의 백엔드 API. Cloudflare Workers + KV + D1으로 구성.

## 기능

- **조회수** — 포스트별 조회수 기록 (IP 기반 하루 1회 카운트)
- **방문자 카운터** — 투데이 / 토탈 방문자 수
- **댓글** — 닉네임 + 4자리 비밀번호 방식, 스레드 답글 지원
- **인증** — X-API-Key 헤더 검증
- **CORS** — 허용된 Origin만 통과
- **Rate Limit** — 댓글 작성 60초 제한

## API

| Method | Path | 설명 |
| --- | --- | --- |
| POST | `/api/views` | 조회수 +1 |
| GET | `/api/views?slug=xxx` | 조회수 조회 |
| POST | `/api/visitors` | 방문자 기록 |
| GET | `/api/visitors` | 투데이/토탈 조회 |
| GET | `/api/comments?slug=xxx` | 댓글 목록 |
| POST | `/api/comments` | 댓글 작성 |
| PUT | `/api/comments` | 댓글 수정 |
| DELETE | `/api/comments` | 댓글 삭제 |

모든 요청에 `X-API-Key` 헤더 필요.

## 기술 스택

| 구성 | 역할 |
| --- | --- |
| Cloudflare Workers | 서버리스 API |
| KV | 조회수, 방문자, Rate Limit |
| D1 (SQLite) | 댓글 저장 |

## 설정

### 1. 의존성 설치

```bash
npm install
```

### 2. Cloudflare 리소스 생성

```bash
wrangler kv namespace create VIEWS
wrangler d1 create minsnote-db
```

### 3. wrangler.toml 설정

`wrangler.toml.example`을 복사하고 생성된 KV/D1 ID를 채워넣기.

```bash
cp wrangler.toml.example wrangler.toml
```

### 4. D1 테이블 생성

```bash
wrangler d1 execute minsnote-db --remote --file=schema/001_init.sql
wrangler d1 execute minsnote-db --remote --file=schema/002_add_password.sql
```

### 5. API Key 등록

```bash
echo "your_api_key" | wrangler secret put API_KEY
```

### 6. 배포

```bash
wrangler deploy
```
