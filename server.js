const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_API = "http://103.249.117.229:17227/api/68gb/tx";
const CACHE_TTL_MS = 1200;
const HISTORY_FILE = path.join(__dirname, "history_68gb_tx.json");

let cache = {
  data: null,
  expiresAt: 0,
};

let historyStore = loadHistory();

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
      if (Array.isArray(parsed)) return parsed.slice(-400);
    }
  } catch (_) {}
  return [];
}

function saveHistory() {
  try {
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(historyStore.slice(-400), null, 2),
      "utf8"
    );
  } catch (_) {}
}

function toTX(item) {
  if (typeof item.result === "string") {
    const r = item.result.trim().toLowerCase();
    if (r === "tài" || r === "tai" || r === "t") return "T";
    if (r === "xỉu" || r === "xiu" || r === "x") return "X";
  }
  if (typeof item.sum === "number") {
    return item.sum >= 11 ? "T" : "X";
  }
  return "X";
}

function mergeHistory(incomingList) {
  if (!Array.isArray(incomingList) || incomingList.length === 0) {
    throw new Error("Danh sách phiên trống");
  }

  const map = new Map();
  for (const item of historyStore) {
    if (item && item.phien !== undefined) {
      map.set(Number(item.phien), item);
    }
  }

  for (const raw of incomingList) {
    if (raw && raw.phien !== undefined) {
      const phienNum = Number(raw.phien);
      map.set(phienNum, {
        phien: phienNum,
        sum: typeof raw.sum === "number" ? raw.sum : null,
        dice: raw.dice ?? null,
        sign: toTX(raw),
      });
    }
  }

  historyStore = [...map.values()]
    .sort((a, b) => a.phien - b.phien)
    .slice(-400);

  saveHistory();
  return historyStore;
}

function analyzeBridges(seqArr) {
  const n = seqArr.length;
  const last = seqArr[n - 1];
  const opp = last === "T" ? "X" : "T";

  let streakLen = 1;
  for (let i = n - 2; i >= 0; i--) {
    if (seqArr[i] === last) streakLen++;
    else break;
  }

  const is11 =
    n >= 4 &&
    seqArr[n - 1] !== seqArr[n - 2] &&
    seqArr[n - 2] !== seqArr[n - 3] &&
    seqArr[n - 3] !== seqArr[n - 4];

  const is22Tail =
    n >= 4 &&
    seqArr[n - 1] === seqArr[n - 2] &&
    seqArr[n - 3] === seqArr[n - 4] &&
    seqArr[n - 1] !== seqArr[n - 3];

  let scoreT = 0.5;
  let scoreX = 0.5;
  let bridgeType = "cầu tự do / biến thiên";
  let actionNote = "";

  if (streakLen >= 5) {
    bridgeType = `bệt ${last} dài ${streakLen} phiên`;
    actionNote = `bệt kéo dài nên ưu tiên bẻ sang ${opp}`;
    scoreT = opp === "T" ? 0.68 : 0.32;
    scoreX = opp === "X" ? 0.68 : 0.32;
  } else if (streakLen >= 3) {
    if (streakLen === 3) {
      bridgeType = `cầu bệt ${last} (${streakLen} phiên)`;
      actionNote = `bệt đang vào nhịp, ưu tiên theo bệt ${last}`;
      scoreT = last === "T" ? 0.65 : 0.35;
      scoreX = last === "X" ? 0.65 : 0.35;
    } else {
      bridgeType = `cầu bệt ${last} (${streakLen} phiên)`;
      actionNote = `bệt 4 phiên sát ngưỡng đảo, thiên nhẹ về bẻ ${opp}`;
      scoreT = opp === "T" ? 0.58 : 0.42;
      scoreX = opp === "X" ? 0.58 : 0.42;
    }
  } else if (is11) {
    bridgeType = `cầu ngắn 1-1 (${seqArr.slice(-4).join("")})`;
    actionNote = `nhịp đảo đều 1-1, thiên về tiếp tục đảo sang ${opp}`;
    scoreT = opp === "T" ? 0.64 : 0.36;
    scoreX = opp === "X" ? 0.64 : 0.36;
  } else if (is22Tail) {
    bridgeType = `cầu ngắn nhịp 2 (${seqArr.slice(-4).join("")})`;
    actionNote = `cụm đôi vừa khép nhịp, thiên về đổi sang ${opp}`;
    scoreT = opp === "T" ? 0.6 : 0.4;
    scoreX = opp === "X" ? 0.6 : 0.4;
  } else {
    const win = seqArr.slice(-10);
    const tCnt = win.filter((c) => c === "T").length;
    const xCnt = win.length - tCnt;
    const tot = Math.max(win.length, 1);
    bridgeType = `cầu ngắn hỗn hợp (${tCnt}T/${xCnt}X trong ${win.length} phiên)`;
    actionNote = `theo tỷ trọng gần nhất (${tCnt >= xCnt ? "T" : "X"})`;
    scoreT = tCnt / tot;
    scoreX = xCnt / tot;
  }

  return { scoreT, scoreX, bridgeType, actionNote };
}

function matchHistoricalPatterns(seqArr) {
  const historyBeforeLatest = seqArr.slice(0, -1).join("");
  let bestScoreT = 0.5;
  let bestScoreX = 0.5;
  let summary = "chưa có mẫu lặp trùng khớp trước đó";

  for (const len of [5, 4, 3, 2]) {
    if (seqArr.length <= len) continue;
    const suffix = seqArr.slice(-len).join("");
    let cT = 0;
    let cX = 0;

    for (let i = 0; i <= historyBeforeLatest.length - len - 1; i++) {
      if (historyBeforeLatest.slice(i, i + len) === suffix) {
        const nxt = historyBeforeLatest[i + len];
        if (nxt === "T") cT++;
        else if (nxt === "X") cX++;
      }
    }

    if (cT + cX > 0) {
      bestScoreT = cT / (cT + cX);
      bestScoreX = cX / (cT + cX);
      summary = `mẫu ${suffix} khớp ${cT + cX} lần trước đó (sau đó: ${cT}T / ${cX}X)`;
      break;
    }
  }

  return { scoreT: bestScoreT, scoreX: bestScoreX, summary };
}

function analyzeSession(list) {
  const ordered = mergeHistory(list);
  const latest = ordered[ordered.length - 1];
  const predictedSession = Number(latest.phien) + 1;

  const seqArr = ordered.map((x) => x.sign);
  const currentPattern = seqArr.join("");
  const recent12 = seqArr.slice(-12).join("");

  const bridge = analyzeBridges(seqArr);
  const patternMatch = matchHistoricalPatterns(seqArr);

  const finalT = bridge.scoreT * 0.55 + patternMatch.scoreT * 0.45;
  const finalX = bridge.scoreX * 0.55 + patternMatch.scoreX * 0.45;

  const prediction = finalT >= finalX ? "T" : "X";
  const topScore = Math.max(finalT, finalX);
  const sumScore = Math.max(finalT + finalX, 0.0001);

  const confidence = Number(
    Math.min(90, Math.max(51, (topScore / sumScore) * 100)).toFixed(1)
  );

  const reason = `Soi ${seqArr.length} phiên (gần nhất: ${recent12}) -> ${bridge.bridgeType}: ${bridge.actionNote}; ${patternMatch.summary}.`;

  return {
    phien_du_doan: predictedSession,
    du_doan: prediction,
    do_tin_cay: `${confidence}%`,
    patten: currentPattern,
    ly_do: reason,
  };
}

async function fetchAndPredict() {
  const now = Date.now();
  if (cache.data && cache.expiresAt > now) {
    return cache.data;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(SOURCE_API, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
      },
    });
    if (!res.ok) {
      throw new Error(`API gốc trả về status ${res.status}`);
    }
    const json = await res.json();
    const list = Array.isArray(json) ? json : json.data ?? json.list;
    const result = analyzeSession(list);

    cache = {
      data: result,
      expiresAt: now + CACHE_TTL_MS,
    };
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/vanhoa", async (req, res) => {
  try {
    const data = await fetchAndPredict();
    res.json(data);
  } catch (err) {
    res.status(502).json({
      error: "Không thể lấy hoặc phân tích dữ liệu từ API gốc",
      detail: err.message,
    });
  }
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    endpoint: "/vanhoa",
    stored_sessions: historyStore.length,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
