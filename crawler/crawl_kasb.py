#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KASB(한국회계기준원) 회계기준열람서비스(db.kasb.or.kr) 크롤러
================================================================
회계팀용 KASB Accounting MCP의 데이터 수집 스크립트.

db.kasb.or.kr 은 로그인 없이 접근 가능한 REST API를 제공한다 (2026-07 확인).
이 스크립트는 그 API를 이용해 아래 데이터를 수집하여 data/ 폴더에 JSON으로 저장한다.

    1) K-IFRS (한국채택국제회계기준)      : stdNum 4자리 (예: 1001, 1002 ...)
    2) 일반기업회계기준                    : stdNum = 장 번호 (1~33)
    3) 기타기준서(특수분야)                : stdNum 5000번대 (예: 5001~5004)
    4) 질의회신요약(회계기준원/금융감독원)  : /api/qnas/v2 페이지네이션

※ 중소기업회계기준은 db.kasb.or.kr에 없음 — 법무부 고시로 법제처(국가법령정보센터)
  행정규칙에 등록되어 있으므로, 이미 연결된 Korean-law-mcp(search_admin_rule /
  get_admin_rule)로 조회한다. 이 크롤러의 대상이 아니다.

사용된 API (2026-07-21 확인, 인증/쿠키 불필요):
    GET /api/standard-indexes/{stdNum}
        -> {"status":200,"standardIndexes":[{documentId, stdNum, level, title, ref,
                                              documentType, parentDocumentIds, sort, ...}, ...]}
    GET /api/paragraphs/{stdNum}/{documentId}?searchWord=
        -> {"status":200,"clauses":[{uniqueKey, paraNum, paraContent(html), fullContent(text)}],
            "mainTitle":..., "mainTitleLevel":...}
    GET /api/qnas/v2?types=all&page={n}&rows=100
        -> {"status":200,
            "facilityQnas":[{id, type, docNumber, date, title, reference, fullContent,
                              relStds, tags, prevDocNumber, nextDocNumber, ...}],
            "facilityQnaCountData": {"11":117, "12":557, ...}}

주의:
- 위 API에 keyword/search/q 파라미터를 붙여도 서버 사이드 필터링이 되지 않는 것을 확인함
  (2026-07-21). 따라서 검색은 이 크롤러가 만든 로컬 인덱스(JSON)에서 수행한다.
- standard-indexes는 "목차/문단 메타데이터"만 담고 있고 실제 조문 본문은
  paragraphs API를 문서(documentId) 단위로 별도 호출해야 얻을 수 있다.
- stdNum 유효 범위는 KASB가 임의로 늘릴 수 있으므로, 하드코딩된 번호 목록 대신
  후보 범위를 순회하며 200 & 데이터 존재 여부로 자동 판별한다(자기 갱신형).

v2 변경사항 (2026-07-21, 첫 GitHub Actions 실행에서 발견한 문제 수정):
- 모든 print()에 flush=True 추가 + 워크플로우에서 `python3 -u` 사용 권장
  (버퍼링 때문에 로그가 실시간으로 안 보이던 문제 수정)
- 기준서를 하나 완료할 때마다, 질의회신을 한 페이지 받을 때마다 즉시 디스크에
  체크포인트 저장. 예전 버전은 전체 크롤링이 끝나야 파일을 저장해서, 타임아웃/취소
  시 그동안 모은 데이터가 전부 날아가는 문제가 있었음.
"""

import json
import os
import sys
import time
import argparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = "https://db.kasb.or.kr"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PonyLink-KASB-MCP-Crawler/1.0"
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")

# 후보 stdNum 범위. 실제 존재 여부는 API 응답으로 최종 확인한다.
CANDIDATE_RANGES = {
    "kifrs": range(1000, 1121),        # K-IFRS 4자리 코드 (1001~1117 근방, 여유있게 스캔)
    "gaap": range(1, 34),               # 일반기업회계기준 1장~33장
    "etc": range(5001, 5011),           # 기타기준서(특수분야) 5001~ (여유있게 스캔)
}

CATEGORY_LABELS = {
    "kifrs": "K-IFRS(한국채택국제회계기준)",
    "gaap": "일반기업회계기준",
    "etc": "기타기준서(특수분야)",
}


def log(msg, **kwargs):
    print(msg, flush=True, **kwargs)


def http_get_json(url, timeout=15, retries=3, backoff=1.5):
    last_err = None
    for attempt in range(retries):
        try:
            req = Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                return json.loads(body)
        except HTTPError as e:
            if e.code == 404:
                return None  # 존재하지 않는 stdNum -> 정상적인 "없음" 신호
            last_err = e
        except (URLError, TimeoutError) as e:
            last_err = e
        time.sleep(backoff * (attempt + 1))
    log(f"  [WARN] 요청 실패(재시도 소진): {url} ({last_err})", file=sys.stderr)
    return None


def build_search_index(standards):
    """검색용 평탄화 인덱스: 기준서 조문 단위 레코드."""
    records = []
    for std_num, std in standards.items():
        for doc in std["documents"]:
            snippet = doc["fullText"][:200]
            records.append({
                "type": "standard",
                "category": std["category"],
                "categoryLabel": std["categoryLabel"],
                "stdNum": std["stdNum"],
                "stdTitle": std["title"],
                "documentId": doc["documentId"],
                "docTitle": doc["title"],
                "ref": doc["ref"],
                "snippet": snippet,
                "url": f"{BASE}/s/{std_num}/{doc['documentId']}",
            })
    return records


def build_qna_index(qna_list):
    records = []
    for q in qna_list:
        snippet = (q.get("fullContent") or "")[:200]
        records.append({
            "type": "qna",
            "id": q["id"],
            "docNumber": q.get("docNumber"),
            "date": q.get("date"),
            "title": q.get("title"),
            "relStds": q.get("relStds"),
            "snippet": snippet,
            "url": q.get("url"),
        })
    return records


def write_json(filename, obj):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp_path = os.path.join(DATA_DIR, filename + ".tmp")
    final_path = os.path.join(DATA_DIR, filename)
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, final_path)  # 원자적 교체 (쓰다가 죽어도 기존 파일은 안전)


def write_meta(standards_count, qna_count, seed=False, note=None):
    meta = {
        "crawledAt": time.strftime("%Y-%m-%dT%H:%M:%S+09:00", time.localtime()),
        "standardsCount": standards_count,
        "qnaCount": qna_count,
    }
    if seed:
        meta["seed"] = True
    if note:
        meta["note"] = note
    write_json("meta.json", meta)


def checkpoint_standards(all_standards, qna_count_so_far):
    """기준서 크롤링 도중 언제든 호출 가능한 체크포인트 저장."""
    write_json("standards_full.json", all_standards)
    write_json("standards_search_index.json", build_search_index(all_standards))
    write_meta(len(all_standards), qna_count_so_far, seed=True,
               note="크롤링 진행 중 체크포인트 - 완료 전 중단된 데이터일 수 있음")


def checkpoint_qna(all_qna, standards_count_so_far):
    write_json("qna_full.json", all_qna)
    write_json("qna_search_index.json", build_qna_index(all_qna))
    write_meta(standards_count_so_far, len(all_qna), seed=True,
               note="크롤링 진행 중 체크포인트 - 완료 전 중단된 데이터일 수 있음")


def crawl_standards(sleep_sec=0.3, verbose=True, checkpoint_every=1):
    """K-IFRS / 일반기업회계기준 / 기타기준서 전체를 순회하며 조문 본문까지 수집.
    stdNum 하나가 끝날 때마다(checkpoint_every개마다) 디스크에 즉시 저장한다."""
    all_standards = {}
    since_checkpoint = 0

    for category, num_range in CANDIDATE_RANGES.items():
        for std_num in num_range:
            idx = http_get_json(f"{BASE}/api/standard-indexes/{std_num}")
            if not idx or idx.get("status") != 200:
                continue
            entries = idx.get("standardIndexes") or []
            if not entries:
                continue

            top_title = None
            for e in entries:
                if e.get("level") in (1,) and e.get("title"):
                    top_title = e["title"]
                    break
            if not top_title:
                top_title = entries[0].get("title", f"{category}-{std_num}")

            if verbose:
                log(f"[{category}] stdNum={std_num} '{top_title}' ({len(entries)}개 목차 항목) 수집 중...")

            documents = []
            for e in entries:
                doc_id = e.get("documentId")
                if not doc_id:
                    continue
                para = http_get_json(
                    f"{BASE}/api/paragraphs/{std_num}/{doc_id}?searchWord="
                )
                time.sleep(sleep_sec)
                if not para or para.get("status") != 200:
                    continue
                clauses = para.get("clauses") or []
                if not clauses:
                    continue
                full_text = "\n".join(
                    c.get("fullContent", "") for c in clauses if c.get("fullContent")
                )
                if not full_text.strip():
                    continue
                documents.append({
                    "documentId": doc_id,
                    "level": e.get("level"),
                    "title": e.get("title"),
                    "ref": e.get("ref"),
                    "mainTitle": para.get("mainTitle"),
                    "fullText": full_text,
                })

            all_standards[str(std_num)] = {
                "category": category,
                "categoryLabel": CATEGORY_LABELS[category],
                "stdNum": std_num,
                "title": top_title,
                "documentCount": len(documents),
                "documents": documents,
                "url": f"{BASE}/standard/index/{std_num}",
            }
            time.sleep(sleep_sec)

            since_checkpoint += 1
            if since_checkpoint >= checkpoint_every:
                checkpoint_standards(all_standards, qna_count_so_far=0)
                since_checkpoint = 0
                if verbose:
                    log(f"  [체크포인트] 기준서 {len(all_standards)}개까지 저장 완료")

    checkpoint_standards(all_standards, qna_count_so_far=0)
    return all_standards


def crawl_qna(rows_per_page=100, sleep_sec=0.3, verbose=True, max_pages=None,
              standards_count_so_far=0):
    """질의회신요약 전체 페이지네이션 수집. 페이지 하나 받을 때마다 즉시 저장한다."""
    all_qna = []
    page = 1
    total_seen = 0
    while True:
        if max_pages and page > max_pages:
            break
        data = http_get_json(
            f"{BASE}/api/qnas/v2?types=all&page={page}&rows={rows_per_page}"
        )
        if not data or data.get("status") != 200:
            break
        items = data.get("facilityQnas") or []
        if not items:
            break
        for it in items:
            all_qna.append({
                "id": it.get("id"),
                "type": it.get("type"),
                "docNumber": it.get("docNumber"),
                "date": it.get("date"),
                "title": it.get("title"),
                "reference": it.get("reference"),
                "fullContent": it.get("fullContent"),
                "relStds": it.get("relStds"),
                "tags": it.get("tags"),
                "url": f"{BASE}/qnas/{it.get('id')}" if it.get("id") else None,
            })
        total_seen += len(items)
        if verbose:
            log(f"[qna] page={page} 누적 {total_seen}건 수집")
        checkpoint_qna(all_qna, standards_count_so_far)
        if len(items) < rows_per_page:
            break
        page += 1
        time.sleep(sleep_sec)
    return all_qna


def main():
    ap = argparse.ArgumentParser(description="KASB db.kasb.or.kr 크롤러")
    ap.add_argument("--skip-standards", action="store_true", help="기준서 수집 생략(테스트용)")
    ap.add_argument("--skip-qna", action="store_true", help="질의회신 수집 생략(테스트용)")
    ap.add_argument("--max-qna-pages", type=int, default=None, help="질의회신 최대 페이지 수(테스트용)")
    ap.add_argument("--std-num-limit", type=int, default=None,
                     help="카테고리별 스캔할 최대 후보 개수(테스트용, 전체 스캔 시간을 줄이고 싶을 때)")
    ap.add_argument("--checkpoint-every", type=int, default=1,
                     help="기준서 몇 개마다 디스크에 저장할지 (기본 1 = 매번)")
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)

    if args.std_num_limit:
        for k in CANDIDATE_RANGES:
            CANDIDATE_RANGES[k] = list(CANDIDATE_RANGES[k])[: args.std_num_limit]

    standards = {}
    if not args.skip_standards:
        standards = crawl_standards(checkpoint_every=args.checkpoint_every)
        log(f"[완료] 기준서 {len(standards)}개 수집")

    qna = []
    if not args.skip_qna:
        qna = crawl_qna(max_pages=args.max_qna_pages, standards_count_so_far=len(standards))
        log(f"[완료] 질의회신 {len(qna)}건 수집")

    # 최종 저장 (seed 플래그 없이 = 완전히 끝난 정식 데이터임을 표시)
    write_json("standards_full.json", standards)
    write_json("standards_search_index.json", build_search_index(standards))
    write_json("qna_full.json", qna)
    write_json("qna_search_index.json", build_qna_index(qna))
    write_meta(len(standards), len(qna), seed=False)
    log(f"[전체 완료] 기준서 {len(standards)}개, 질의회신 {len(qna)}건 저장 완료")


if __name__ == "__main__":
    main()
