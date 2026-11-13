# English Reader

영어 뉴스(Tech · Business · World · Europe)를 읽다가 모르는 단어를 **클릭**하거나 여러 단어를 **드래그**하면
한글 뜻 · 품사 · 발음 · 예문 · 문장 해석이 바로 뜨는 개인용 리더예요.

## 실행

```bash
npm install
npm start
```
→ http://localhost:5173

## 기능
- 기사 소스: The Guardian, BBC, NPR의 RSS (무료). URL을 붙여넣으면 아무 영어 기사나 열 수 있어요.
- 기사마다 대략적인 난이도(≈B1~C2), 단어 수, 읽는 시간을 보여줘요.
- 단어 클릭 → 한글 뜻, 품사, 발음기호, 발음 듣기, 영영 풀이, 예문, 유의어, 문장 번역
- 드래그 → 숙어나 구동사(rule out, go too far 등)를 조회
- 단어장: 저장한 단어는 본문에서 형광펜으로 표시돼요. 플래시카드 복습과 CSV 내보내기(Anki용)를 지원해요.
  데이터는 `data/words.json`에 저장돼요.

## 사전 모드
| 모드 | 설정 | 특징 |
|---|---|---|
| 무료 (기본) | 없음 | Free Dictionary API(영영) + MyMemory 번역. 하루 약 5,000단어까지 무료 |
| 무료 + DeepL | `.env`에 `DEEPL_API_KEY` | 번역 품질 향상 (월 50만 자 무료) |
| Claude | `.env`에 `ANTHROPIC_API_KEY` | **문장 문맥에 맞는 뜻**, 뉘앙스 설명, 한글 해석이 달린 예문, 연어(collocation), CEFR 수준 |

`.env.example`을 `.env`로 복사해서 키를 넣으면 돼요.

### 비용
API는 쓴 만큼 과금돼요 (Claude 구독과는 별도). 기본 모델은 `claude-haiku-5-5`라서 아주 저렴해요.

| 모델 | 1회 조회 (대략) | 하루 30단어 × 한 달 |
|---|---|---|
| `claude-haiku-5-5` (기본값) | ≈0.4원 | ≈400원 |
| `claude-opus-5-5` | ≈17원 | ≈15,000원 |

다른 모델을 쓰려면 `.env`에 `CLAUDE_MODEL=...`을 넣으면 돼요. 콘솔에서 크레딧을 선불로 충전해 쓰고,
월 사용 한도도 걸어 둘 수 있어요. 같은 단어와 같은 문장을 다시 찾으면 저장해 둔 결과를 보여줘서 추가 과금이 없어요.

## 웹 배포 (Vercel)

배포하면 휴대폰에서도 쓸 수 있어요. Claude 과금을 막기 위해 **비밀번호를 걸어야만** API가 동작해요.
`APP_PASSWORD`가 없으면 배포된 앱은 아무 요청도 처리하지 않아요.

1. Vercel 로그인 및 첫 배포
   ```bash
   npx vercel login
   npx vercel
   ```
2. 환경변수 설정 (Vercel 대시보드 → 프로젝트 → Settings → Environment Variables, 또는 CLI)
   | 이름 | 값 |
   |---|---|
   | `APP_PASSWORD` | 로그인 비밀번호 (길게) |
   | `ANTHROPIC_API_KEY` | Claude 키 |
   | `CLAUDE_MODEL` | `claude-haiku-5-5` |
3. 단어장 저장소: 대시보드 → Storage → **Upstash for Redis**(무료) 생성 → 이 프로젝트에 연결
   (`KV_REST_API_URL`, `KV_REST_API_TOKEN`이 자동으로 추가돼요.) 휴대폰과 PC가 같은 단어장을 써요.
4. 운영 배포
   ```bash
   npx vercel --prod
   ```

로컬에서는 `APP_PASSWORD`를 비워 두면 로그인 없이 쓰고, `data/words.json`에 저장돼요.

### 구조
- `lib/app.js` — 기사·사전·단어장·로그인 로직 (공통)
- `server.js` — 로컬 서버
- `api/index.js` — Vercel 함수 (`/api/*`가 모두 여기로 와요)
- `public/` — 화면
