# Fun fun

URL을 등록해 **만들기 / 요리 / 상식 / 기타** 4개 탭으로 모아보는 링크 모음 PWA.
유튜브는 썸네일, 일반 링크는 OG 대표이미지·제목으로 미리보기 카드 표시. 탭 시 원본 열림.

## 구조

```
[PWA: GitHub Pages] index.html · assets/{app.js,app.css,icon*} · sw.js · manifest
   │ fetch
   ▼
[Cloudflare Worker]  GET/PUT /api/data (X-Edit-Token) · GET /api/preview (OG·YouTube)
   ▼
[Cloudflare KV]  key "funfun-data" → { version, items[] }
```

- 열람: 누구나. 등록·삭제: 헤더 🔒 에 편집 비밀번호 입력 시.
- 등록 시 `/api/preview` 로 제목·대표이미지·도메인을 1회 추출해 저장 → 카드 렌더 빠름.

## 데이터 모델 (`funfun-data`)

```json
{ "version": 1, "items": [
  { "id": "f_..", "category": "make|cook|trivia|etc", "url": "https://...",
    "title": "...", "image": "...", "domain": "youtube.com", "note": "", "added_at": "ISO" }
] }
```
카테고리: 만들기=make · 요리=cook · 상식=trivia · 기타=etc.

## 로컬 실행

```sh
python3 -m http.server 8080
open http://localhost:8080/
```

## Worker 배포

```sh
cd worker
npx wrangler kv namespace create FUNFUN     # 출력 id 를 wrangler.toml 에 기입
echo "편집비밀번호" | npx wrangler secret put EDIT_TOKEN
npx wrangler deploy
```
배포 후 workers.dev URL 을 `assets/app.js` 의 `API_BASE` 에 반영.

## API

| 엔드포인트 | 인증 | 용도 |
|---|---|---|
| `GET  /api/data` | (없음) | 전체 목록 읽기 |
| `PUT  /api/data` | `X-Edit-Token` | 전체 저장 |
| `GET  /api/preview?url=` | `X-Edit-Token` | 미리보기(YouTube 썸네일/일반 OG) 추출 |
| `GET  /api/health` | (없음) | 헬스체크 |
