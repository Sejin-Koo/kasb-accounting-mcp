// KASB Accounting MCP — Vercel Serverless Function
// -----------------------------------------------------------------------------
// 회계팀용 MCP 서버. 아래 4개 도구를 JSON-RPC 2.0(over HTTP, SSE 응답) 방식으로 제공한다.
// KRX Regulation MCP(krx-regulation-mcp.vercel.app)와 동일한 프로토콜/배포 구조를 따른다.
//
//   1) search_kasb_standard : 회계기준서(K-IFRS/일반기업회계기준/기타기준서) 조문 키워드 검색
//                              -> data/standards_search_index.json 에서 검색 (주간 재크롤링, 캐시)
//   2) get_kasb_standard_text : 특정 기준서(stdNum)의 조문 전문을 db.kasb.or.kr에서 실시간 조회
//                                (캐시 없음, 항상 최신)
//   3) search_kasb_qna : 질의회신요약 키워드 검색 -> data/qna_search_index.json 에서 검색(캐시)
//   4) get_kasb_qna_detail : 특정 질의회신 전문 조회 -> data/qna_full.json 에서 조회
//                             (목록 API 자체에 전문이 포함되어 있어 별도 실시간 상세 API가 불필요함,
//                              2026-07-21 확인)
//
// 참고: 중소기업회계기준은 이 MCP의 대상이 아님 — 법무부 고시로 법제처 행정규칙에 등록되어
// 있으므로 이미 연결된 Korean-law-mcp(search_admin_rule/get_admin_rule)로 조회할 것.

const fs = require("fs");
const path = require("path");
const https = require("https");

const DATA_DIR = path.join(__dirname, "..", "data");
const KASB_HOST = "db.kasb.or.kr";

function loadJson(filename, fallback) {
  try {
    const p = path.join(DATA_DIR, filename);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    return fallback;
  }
}

// 매 요청마다 새로 읽지 않도록 콜드스타트 시 1회 로드 (Vercel 함수 인스턴스 재사용 시 캐시됨)
let STANDARDS_INDEX = null;
let QNA_INDEX = null;
let QNA_FULL = null;
let META = null;

function ensureLoaded() {
  if (STANDARDS_INDEX === null) STANDARDS_INDEX = loadJson("standards_search_index.json", []);
  if (QNA_INDEX === null) QNA_INDEX = loadJson("qna_search_index.json", []);
  if (QNA_FULL === null) QNA_FULL = loadJson("qna_full.json", []);
  if (META === null) META = loadJson("meta.json", {});
}

function httpsGetJson(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: KASB_HOST,
        path: pathAndQuery,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PonyLink-KASB-MCP/1.0",
          Accept: "application/json",
        },
        timeout: 15000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode === 404) return resolve(null);
          if (res.statusCode !== 200) {
            return reject(new Error(`KASB API ${res.statusCode}: ${pathAndQuery}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("KASB API timeout")));
    req.on("error", reject);
    req.end();
  });
}

function normalize(s) {
  return (s || "").toString().toLowerCase().replace(/\s+/g, "");
}

// ---- Tool implementations ---------------------------------------------------

function toolSearchKasbStandard({ keyword, category, limit }) {
  ensureLoaded();
  if (!keyword || !keyword.trim()) {
    return { error: "keyword는 필수입니다." };
  }
  const nk = normalize(keyword);
  const max = Math.min(Math.max(parseInt(limit || 20, 10), 1), 100);
  let results = STANDARDS_INDEX.filter((r) => {
    if (category && r.category !== category) return false;
    return (
      normalize(r.docTitle).includes(nk) ||
      normalize(r.stdTitle).includes(nk) ||
      normalize(r.snippet).includes(nk)
    );
  });
  const total = results.length;
  results = results.slice(0, max);
  return {
    total,
    returned: results.length,
    dataAsOf: META.crawledAt || null,
    note:
      "이 결과는 주간 재크롤링 캐시(dataAsOf 기준)입니다. 조문 전문과 최신 개정 여부는 " +
      "get_kasb_standard_text로 실시간 재조회하세요.",
    results,
  };
}

async function toolGetKasbStandardText({ stdNum, documentId }) {
  if (!stdNum) return { error: "stdNum은 필수입니다. (예: K-IFRS는 1001, 일반기업회계기준은 1~33)" };
  const idx = await httpsGetJson(`/api/standard-indexes/${encodeURIComponent(stdNum)}`);
  if (!idx || idx.status !== 200 || !idx.standardIndexes || idx.standardIndexes.length === 0) {
    return { error: `stdNum=${stdNum} 에 해당하는 기준서를 찾지 못했습니다.` };
  }
  const entries = idx.standardIndexes;

  if (documentId) {
    const entry = entries.find((e) => e.documentId === documentId);
    const para = await httpsGetJson(
      `/api/paragraphs/${encodeURIComponent(stdNum)}/${encodeURIComponent(documentId)}?searchWord=`
    );
    if (!para || para.status !== 200) {
      return { error: `documentId=${documentId} 조문을 찾지 못했습니다.` };
    }
    const fullText = (para.clauses || []).map((c) => c.fullContent).filter(Boolean).join("\n");
    return {
      stdNum,
      documentId,
      title: entry ? entry.title : para.mainTitle,
      ref: entry ? entry.ref : null,
      fullText,
      sourceUrl: `https://${KASB_HOST}/s/${stdNum}/${documentId}`,
      fetchedAt: new Date().toISOString(),
    };
  }

  // documentId 미지정 시: 목차(개요)만 반환 — 전체 조문을 한 번에 다 가져오면 매우 커지므로
  // 목차에서 documentId를 확인한 뒤 다시 조회하도록 안내한다.
  const toc = entries.map((e) => ({
    documentId: e.documentId,
    level: e.level,
    title: e.title,
    ref: e.ref,
  }));
  return {
    stdNum,
    tableOfContentsCount: toc.length,
    tableOfContents: toc,
    note:
      "documentId를 지정하지 않으면 목차만 반환합니다. 특정 조문 전문이 필요하면 " +
      "documentId를 지정해 다시 호출하세요.",
    sourceUrl: `https://${KASB_HOST}/standard/index/${stdNum}`,
    fetchedAt: new Date().toISOString(),
  };
}

function toolSearchKasbQna({ keyword, limit }) {
  ensureLoaded();
  if (!keyword || !keyword.trim()) {
    return { error: "keyword는 필수입니다." };
  }
  const nk = normalize(keyword);
  const max = Math.min(Math.max(parseInt(limit || 20, 10), 1), 100);
  let results = QNA_INDEX.filter(
    (r) => normalize(r.title).includes(nk) || normalize(r.snippet).includes(nk)
  );
  const total = results.length;
  results = results.slice(0, max);
  return {
    total,
    returned: results.length,
    dataAsOf: META.crawledAt || null,
    note: "이 결과는 주간 재크롤링 캐시(dataAsOf 기준)입니다. 전문은 get_kasb_qna_detail로 조회하세요.",
    results,
  };
}

function toolGetKasbQnaDetail({ qnaId }) {
  ensureLoaded();
  if (!qnaId) return { error: "qnaId는 필수입니다." };
  const item = QNA_FULL.find((q) => String(q.id) === String(qnaId));
  if (!item) return { error: `qnaId=${qnaId} 를 찾지 못했습니다.` };
  return { ...item, dataAsOf: META.crawledAt || null };
}

// ---- MCP protocol plumbing ---------------------------------------------------

const TOOLS = [
  {
    name: "search_kasb_standard",
    description:
      "[회계기준서 검색] K-IFRS/일반기업회계기준/기타기준서 조문을 키워드로 검색(주간 캐시). " +
      "category: kifrs|gaap|etc 로 필터 가능.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "검색 키워드 (예: '리스', '수익인식')" },
        category: {
          type: "string",
          enum: ["kifrs", "gaap", "etc"],
          description: "kifrs=K-IFRS, gaap=일반기업회계기준, etc=기타기준서(특수분야)",
        },
        limit: { type: "number", description: "최대 결과 수 (기본 20, 최대 100)" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "get_kasb_standard_text",
    description:
      "[회계기준서 조문 실시간 조회] stdNum(K-IFRS는 1001식 4자리, 일반기업회계기준은 1~33 장 번호)으로 " +
      "목차 또는 특정 조문(documentId) 전문을 db.kasb.or.kr에서 실시간으로 가져온다(캐시 없음, 항상 최신). " +
      "documentId를 모르면 먼저 documentId 없이 호출해 목차를 확인할 것.",
    inputSchema: {
      type: "object",
      properties: {
        stdNum: { type: "string", description: "기준서 번호 (예: '1001', '16')" },
        documentId: { type: "string", description: "목차에서 확인한 조문 documentId (선택)" },
      },
      required: ["stdNum"],
    },
  },
  {
    name: "search_kasb_qna",
    description: "[질의회신요약 검색] 회계기준원/금융감독원 질의회신요약을 키워드로 검색(주간 캐시).",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "검색 키워드" },
        limit: { type: "number", description: "최대 결과 수 (기본 20, 최대 100)" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "get_kasb_qna_detail",
    description: "[질의회신 전문 조회] search_kasb_qna 결과의 id로 질의회신 전문을 조회한다.",
    inputSchema: {
      type: "object",
      properties: {
        qnaId: { type: "string", description: "질의회신 id (search_kasb_qna 결과의 id 필드)" },
      },
      required: ["qnaId"],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "search_kasb_standard":
      return toolSearchKasbStandard(args || {});
    case "get_kasb_standard_text":
      return await toolGetKasbStandardText(args || {});
    case "search_kasb_qna":
      return toolSearchKasbQna(args || {});
    case "get_kasb_qna_detail":
      return toolGetKasbQnaDetail(args || {});
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP 프로토콜 버전 협상 ──────────────────────────────────────────────────
// 규격 근거 두 가지.
//  (1) Lifecycle "Version Negotiation": 서버는 요청받은 버전을 지원하면 같은 값으로,
//      지원하지 않으면 "자기가 지원하는" 다른 버전으로 응답해야 한다(MUST).
//  (2) Transports "Protocol Version Header": MCP-Protocol-Version 헤더가 미지원
//      버전이면 400 Bad Request 로 응답해야 한다(MUST). 이 400은 신형(2026-07-28)
//      클라이언트가 HTTP에서 구형 서버를 판별해 폴백하는 유일한 신호이기도 하므로,
//      200 으로 통과시키면 신형 클라이언트가 이 서버를 신형으로 오인한다.
// 목록은 @modelcontextprotocol/sdk 의 SUPPORTED_PROTOCOL_VERSIONS 와 동일하게 맞춰,
// SDK 기반 서버들과 협상 결과가 갈리지 않도록 한다.
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

// 헤더가 없으면 통과한다(규격상 서버는 2025-03-26 으로 간주). 값이 있으면 대조한다.
function protocolVersionHeaderError(req) {
  const raw = req.headers && req.headers["mcp-protocol-version"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || SUPPORTED_PROTOCOL_VERSIONS.includes(v)) return null;
  return {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: `Bad Request: Unsupported protocol version: ${v} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
    },
    id: null,
  };
}

function sendSse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ─── 접근 게이트 ─────────────────────────────────────────────────────────────
// 엔드포인트 주소만 알면 누구나 호출할 수 있는 상태를 막기 위해, 호출자는 URL
// 쿼리스트링으로 발급받은 게이트키를 전달한다:  https://<도메인>/api/mcp?k=<발급키>
//   MCP_GATE_KEYS : 허용 키 목록(쉼표 구분). **비어 있으면 게이트 비활성**(모두 통과).
//   MCP_GATE_MODE : "enforce"면 키가 없거나 목록에 없을 때 401 차단.
//                   그 밖(기본 "observe")이면 통과시키되 로그만 남긴다.
// 로그에는 키 전문 대신 발급 대상 식별자(plk_<대상>_… 의 <대상>)만 남긴다.
// 상세 운영 절차는 sys-mcp-gatekey 스킬 참조.
const GATE_KEYS = (process.env.MCP_GATE_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const GATE_MODE = (process.env.MCP_GATE_MODE || "observe").trim().toLowerCase();

function gateKeyLabel(k) {
  if (!k) return "(none)";
  const m = String(k).match(/^plk_([A-Za-z0-9]+)_/);
  return m ? m[1] : `${String(k).slice(0, 8)}…`;
}

/** 통과하면 true. 차단하면 401 응답을 보내고 false를 돌려준다. */
function gateCheck(req, res) {
  let k = (req.query && req.query.k) || null;
  if (!k) {
    try {
      k = new URL(req.url, "http://localhost").searchParams.get("k");
    } catch (e) {
      k = null;
    }
  }
  const allowed = GATE_KEYS.length === 0 || (!!k && GATE_KEYS.includes(k));
  console.log(
    `[gate] mode=${GATE_MODE} method=${req.method} caller=${gateKeyLabel(k)} allowed=${allowed}`
  );
  if (!allowed && GATE_MODE === "enforce") {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message:
            "접근 권한이 없습니다. 이 서버는 발급받은 게이트키가 포함된 주소(…/api/mcp?k=<발급키>)로만 호출할 수 있습니다.",
        },
      })
    );
    return false;
  }
  return true;
}

module.exports = async (req, res) => {
  if (!gateCheck(req, res)) return;

  const pvError = protocolVersionHeaderError(req);
  if (pvError) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(pvError));
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, message: "KASB Accounting MCP. Use POST JSON-RPC 2.0." }));
    return;
  }

  let body = "";
  await new Promise((resolve) => {
    req.on("data", (c) => (body += c));
    req.on("end", resolve);
  });

  let rpc;
  try {
    rpc = JSON.parse(body || "{}");
  } catch (e) {
    res.statusCode = 400;
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }));
    return;
  }

  const { id, method, params } = rpc;

  // 알림(notification)에는 응답 본문이 없어야 한다 — 규격상 202 Accepted.
  if (typeof method === "string" && method.startsWith("notifications/")) {
    res.statusCode = 202;
    res.end();
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    if (method === "ping") {
      sendSse(res, { jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      sendSse(res, { jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const toolName = params && params.name;
      const args = params && params.arguments;
      const result = await callTool(toolName, args);
      sendSse(res, {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      });
    } else if (method === "initialize") {
      sendSse(res, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(params && params.protocolVersion),
          serverInfo: { name: "kasb-accounting-mcp", version: "1.0.0" },
          capabilities: { tools: {} },
        },
      });
    } else {
      sendSse(res, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  } catch (e) {
    sendSse(res, { jsonrpc: "2.0", id, error: { code: -32000, message: e.message } });
  }

  res.end();
};
