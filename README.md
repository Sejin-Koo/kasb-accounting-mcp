# KASB Accounting MCP

회계팀(포니링크/링크아이 IT사업본부)이 K-IFRS·일반기업회계기준·기타기준서·질의회신요약을
Claude에서 바로 검색·조회할 수 있도록 만든 MCP 서버입니다. `krx-regulation-mcp`와 동일한
구조(GitHub + Vercel 서버리스 + GitHub Actions 주간 재크롤링)로 만들어졌습니다.

세법(소득세법·법인세법·부가가치세법 등)과 중소기업회계기준은 **이 MCP의 대상이 아닙니다.**
이미 연결되어 있는 Korean-law-mcp(법제처 국가법령정보센터 기반)로 실시간 조회가 가능하기
때문입니다. 자세한 내용은 `docs/세법_및_중소기업회계기준_조회가이드.md` 참고.

## 왜 크롤링 방식인가

한국회계기준원의 회계기준열람서비스(`db.kasb.or.kr`)는 공식 Open API를 공개하지 않습니다.
다만 2026-07-21 확인 결과, 프런트엔드가 사용하는 아래 REST 엔드포인트는 로그인/쿠키 없이
호출 가능함을 실제 요청으로 검증했습니다.

| 엔드포인트 | 용도 | 인증 |
|---|---|---|
| `GET /api/standard-indexes/{stdNum}` | 기준서 목차(조문 트리) | 불필요 |
| `GET /api/paragraphs/{stdNum}/{documentId}?searchWord=` | 조문 전문 | 불필요 |
| `GET /api/qnas/v2?types=all&page=N&rows=100` | 질의회신요약 목록(전문 포함) | 불필요 |

`keyword`/`search`/`q` 같은 검색 파라미터는 서버가 무시하는 것을 확인했습니다(2026-07-21).
그래서 검색 기능은 이 저장소가 주기적으로 만드는 로컬 인덱스에서 수행하고, 조문 "전문"이
필요할 때는 매번 KASB 서버에 실시간으로 재조회해 항상 최신 내용을 보장합니다
(KRX Regulation MCP의 `get_krx_rule_fulltext`와 동일한 설계).

stdNum 네임스페이스:

- K-IFRS: 1001~1117 부근의 4자리 코드 (예: 1001 재무제표 표시)
- 일반기업회계기준: 1~33 (장 번호, 예: 1=제1장 목적·구성 및 적용)
- 기타기준서(특수분야): 5001~ (예: 5001 결합재무제표)

크롤러(`crawler/crawl_kasb.py`)는 이 번호들을 하드코딩하지 않고 후보 범위를 순회하며
실제 존재 여부(200 응답 + 데이터 유무)로 자동 판별합니다. KASB가 기준서를 추가해도
크롤러 수정 없이 다음 주간 재크롤링에서 자동으로 반영됩니다.

## 제공 도구 (4개)

1. **search_kasb_standard**(keyword, category?, limit?) — K-IFRS/일반기업회계기준/기타기준서
   조문을 키워드로 검색. 캐시(주간 재크롤링) 기반, 결과에 `dataAsOf` 포함.
2. **get_kasb_standard_text**(stdNum, documentId?) — 특정 기준서의 목차 또는 조문 전문을
   KASB 서버에서 실시간 조회. 캐시 없음, 항상 최신.
3. **search_kasb_qna**(keyword, limit?) — 질의회신요약 키워드 검색. 캐시 기반.
4. **get_kasb_qna_detail**(qnaId) — 질의회신 전문 조회(목록 API 자체에 전문이 포함되어 있어
   캐시에서 바로 반환, 별도 실시간 상세 API가 없어도 됨을 확인함).

## 검증 상태 (2026-07-21)

샌드박스에서 실제 db.kasb.or.kr에 대해 다음을 직접 실행/검증했습니다.

- 크롤러로 일반기업회계기준 제1장(4개 조문), 제5장(13개 조문), 질의회신 100건을 실제 수집
  → `data/` 폴더에 시드 데이터로 포함되어 있음 (`data/meta.json`의 `seed: true` 참고).
- `api/mcp.js`의 4개 도구를 Node.js로 직접 호출해 `tools/list`, `search_kasb_standard`,
  `search_kasb_qna`, `get_kasb_standard_text`(실시간), `get_kasb_qna_detail` 모두
  정상 동작 확인.

**아직 하지 않은 것:** 전체 K-IFRS(약 20개 기준서)·전체 일반기업회계기준(33개 장)·
전체 질의회신(2,255건)의 전수 크롤링. 기준서 1개당 조문이 수십~수백 개라 전수 크롤링은
API 호출이 매우 많아(수천~수만 건) 이 세션의 실행 환경에서는 끝까지 돌릴 수 없었습니다.
아래 배포 절차의 "최초 전체 크롤링" 단계에서 GitHub Actions(6시간 한도)로 한 번 실행하면
됩니다.

## 배포 절차 (KRX Regulation MCP와 동일)

1. **GitHub 저장소 생성**: 이 폴더(`kasb-accounting-mcp/`) 전체를 새 저장소로 push.
   ```bash
   cd kasb-accounting-mcp
   git init && git add . && git commit -m "init"
   git remote add origin https://github.com/Sejin-Koo/kasb-accounting-mcp.git
   git push -u origin main
   ```
2. **Vercel 연결**: vercel.com에서 New Project → 위 GitHub 저장소 선택 → 그대로 Deploy
   (환경변수/빌드설정 불필요, Node.js 서버리스 함수 자동 인식).
3. **최초 전체 크롤링 실행**: GitHub 저장소 Actions 탭 → "KASB 주간 재크롤링" →
   "Run workflow" 클릭. 완료되면 `data/` 폴더가 전체 데이터로 갱신되어 자동 commit/push되고
   Vercel이 자동 재배포합니다. (기준서 전수 크롤링은 시간이 걸릴 수 있어 workflow
   timeout을 350분으로 넉넉히 잡아두었습니다.)
4. **Claude에 연결**: Settings → Connectors → "+" → Add custom connector
   - URL: `https://kasb-accounting-mcp.vercel.app/api/mcp` (실제 배포 URL로 교체)
   - 인증 불필요
   - claude.ai가 정식 도구로 인식하지 못하면 KRX/DCF MCP와 동일하게 bash의 curl로
     JSON-RPC POST 직접 호출 (`Content-Type: application/json`,
     `Accept: application/json, text/event-stream` 헤더 필수, 응답은 SSE라
     `data:` 뒤 JSON이 실제 결과).
5. **이후 유지보수**: 매주 월요일 14:00(KST) 자동 재크롤링. 로컬 PC 상태와 무관하게
   GitHub Actions에서 클라우드로 동작. 새 기준서/질의회신이 KASB에 올라오면 다음 주간
   실행 때 자동 반영.

## 알려진 제약

- 중소기업회계기준은 db.kasb.or.kr에 없습니다(법무부 고시로 법제처 행정규칙에 등록되어
  있음, 행정규칙ID 41522). 이 MCP가 아니라 Korean-law-mcp의 `search_admin_rule`/
  `get_admin_rule`로 조회하세요.
- `db.kasb.or.kr`에는 `/esg`(지속가능성공시기준) 섹션도 있으며 동일한 API 패턴을
  따를 가능성이 높지만 이번 범위에는 포함하지 않았습니다. 필요 시 크롤러에
  카테고리를 추가하면 됩니다.
- 별표·서식 등 첨부파일 다운로드는 이번 조사에서 확인하지 않았습니다.
