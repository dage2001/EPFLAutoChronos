const MS_PER_DAY = 86400000;

// 生成当月所有日期的毫秒时
function daysInMonthUTC(year, month /* 1-12 */) {
  const start = Date.UTC(year, month - 1, 1);
  const nextMonth = Date.UTC(year, month, 1);
  const n = Math.round((nextMonth - start) / MS_PER_DAY);
  return Array.from({ length: n }, (_, i) => start + i * MS_PER_DAY);
}

// 将UTC毫秒时转化为ISO格式（yyyy-mm-dd）
function isoYmdUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// 判断毫秒时是否为工作日
function isWeekdayUTC(ms) {
  const d = new Date(ms).getUTCDay(); // 0 Sun ... 6 Sat
  return d >= 1 && d <= 5;
}

// 生成[a,b]的均匀分布
function randUniform(a, b) {
  return a + Math.random() * (b - a);
}

// 四舍五入到小数点后p位
function roundTo(x, decimals = 1) {
  const p = 10 ** decimals;
  return Math.round(x * p) / p;
}

// array随机排序
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 生成post请求需要的boundary
function makeBoundary(prefix = "b") {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

// 毫秒值转化为post请求要求的格式
function odataWorkdateFromMs(ms) {
  return `/Date(${ms})/`;
}

// 生成某年某月每天的 catshours 映射，并满足：
// total > weekdayCount * baselinePerWeekday
function generateCatshoursMap(year, month, opts = {}) {
  const weekdayRange = opts.weekdayRange ?? [7.8, 9.2];
  const weekendRange = opts.weekendRange ?? [2.5, 6.3];
  const baselinePerWeekday = opts.baselinePerWeekday ?? 8.2;
  const epsilon = opts.epsilon ?? 0.01;        // “严格大于”的最小余量
  const decimals = opts.decimals ?? 1;         // 保留 1 位小数更像你示例
  const maxRetries = opts.maxRetries ?? 200;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const dates = daysInMonthUTC(year, month);
    const hoursByDate = {}; // ISO->hours
    const weekdayKeys = [];
    let weekdayCount = 0;
    let weekendCount = 0;

    // 1) 初始随机采样
    for (const ms of dates) {
      const key = isoYmdUTC(ms);
      if (isWeekdayUTC(ms)) {
        weekdayCount++;
        weekdayKeys.push(key);
        hoursByDate[key] = randUniform(weekdayRange[0], weekdayRange[1]);
      } else {
        weekendCount++;
        hoursByDate[key] = randUniform(weekendRange[0], weekendRange[1]);
      }
    }

    // 2) 计算总和与目标（只算一次 baselineHours）
    const baselineHours = weekdayCount * baselinePerWeekday;
    let total = Object.values(hoursByDate).reduce((a, b) => a + b, 0);
    const target = baselineHours + epsilon;

    // 3) 不够就只在工作日补足（不超过 weekdayRange[1]）
    if (total <= target) {
      let need = target - total;

      // 可用“抬升空间”
      const headroom = {};
      let totalHeadroom = 0;
      for (const k of weekdayKeys) {
        const room = Math.max(0, weekdayRange[1] - hoursByDate[k]);
        headroom[k] = room;
        totalHeadroom += room;
      }

      // 如果工作日空间都不够，重采样整月
      if (totalHeadroom < need) continue;

      // 用随机权重分配 need（更自然）
      const keys = shuffle([...weekdayKeys]);
      let remaining = need;

      const weights = keys.map(() => Math.random());
      const wsum = weights.reduce((a, b) => a + b, 0);

      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const room = headroom[k];
        if (room <= 0) continue;
        const share = (weights[i] / wsum) * need;
        const add = Math.min(room, share);
        hoursByDate[k] += add;
        remaining -= add;
      }

      // 剩余没分完就顺序补齐
      if (remaining > 1e-12) {
        for (const k of keys) {
          const room = weekdayRange[1] - hoursByDate[k];
          if (room <= 0) continue;
          const add = Math.min(room, remaining);
          hoursByDate[k] += add;
          remaining -= add;
          if (remaining <= 1e-12) break;
        }
      }
    }

    // 4) 四舍五入（保留 1 位小数），并确保 rounding 后仍严格大于 baselineHours
    for (const k of Object.keys(hoursByDate)) {
      hoursByDate[k] = roundTo(hoursByDate[k], decimals);
    }
    total = Object.values(hoursByDate).reduce((a, b) => a + b, 0);

    if (total <= baselineHours) {
      // rounding 可能把优势抹平：给某个工作日 +step（不超过上限）
      const step = 1 / (10 ** decimals); // 例如 0.1
      const keys = shuffle([...weekdayKeys]);
      let fixed = false;

      for (const k of keys) {
        if (hoursByDate[k] + step <= weekdayRange[1] + 1e-12) {
          hoursByDate[k] = roundTo(hoursByDate[k] + step, decimals);
          fixed = true;
          break;
        }
      }
      if (!fixed) continue; // 实在没法修就重采样

      total = Object.values(hoursByDate).reduce((a, b) => a + b, 0);
      if (total <= baselineHours) continue;
    }

    return {
      hoursByDate,
      totalHours: total,
      weekdayCount,
      weekendCount,
      baselineHours,
    };
  }

  throw new Error("Failed to generate a valid month within maxRetries");
}

// 获取 CSRF 口令
async function fetchCsrfToken() {
  const r = await fetch(
    "https://sesame.epfl.ch/sap/opu/odata/sap/ZPR_FI_TIMESHEET_SRV/?sap-client=500",
    {
      method: "GET",
      credentials: "include",
      headers: { "X-CSRF-Token": "Fetch", "Accept": "application/json" },
    }
  );
  const token = r.headers.get("x-csrf-token");
  if (!token) throw new Error("No CSRF token returned");
  return token;
}

// POST 一天到 SAP 服务器
async function postOneDayBatch({ token, username, wbs, wbsDesc, ms, catshours }) {
  const url = "https://sesame.epfl.ch/sap/opu/odata/sap/ZPR_FI_TIMESHEET_SRV/$batch?sap-client=500";
  const batchBoundary = makeBoundary("batch");
  const changeSetBoundary = makeBoundary("changeset");

  const payloadObj = {
    Username: username,
    Workdate: odataWorkdateFromMs(ms),
    Wbs: wbs,
    WbsDescription: wbsDesc,
    Catshours: String(catshours),
    Unit: "",
    IsLeave: false,
  };

  const body =
`\r
--${batchBoundary}\r
Content-Type: multipart/mixed; boundary=${changeSetBoundary}\r
\r
--${changeSetBoundary}\r
Content-Type: application/http\r
Content-Transfer-Encoding: binary\r
\r
POST TimeRecordSet?sap-client=500 HTTP/1.1\r
Accept: application/json\r
Content-Type: application/json\r
\r
${JSON.stringify(payloadObj)}\r
--${changeSetBoundary}--\r
\r
--${batchBoundary}--\r
`;

  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Accept": "multipart/mixed",
      "Content-Type": `multipart/mixed; boundary=${batchBoundary}`,
      "X-CSRF-Token": token,
      "X-Requested-With": "XMLHttpRequest",
      "DataServiceVersion": "2.0",
      "MaxDataServiceVersion": "2.0",
    },
    body,
  });

  const text = await res.text();
  return { status: res.status, text };
}

// ======== 主循环：生成 + 逐日提交 ========
async function submitMonthTimesheet(year, month, config = {}) {
  
    // 使用前请根据用户情况修改
  const username = config.username ?? "xxxxxx"; // Gaspar No.
  const wbs = config.wbs ?? "xxxxx.xxxx.x"; // Funding No.
  const wbsDesc = config.wbsDesc ?? "xxxxxxxx"; // Funding Name

  // 生成符合分布和总额要求的当月 map
  const gen = generateCatshoursMap(year, month, {
    weekdayRange: [7.8, 9.2],
    weekendRange: [2.5, 6.3],
    baselinePerWeekday: 8.2,
    epsilon: 0.01,
    decimals: 1,
  });

  // 将生成信息打印到 console
  console.log("Generated:", {
    month: `${year}-${String(month).padStart(2,"0")}`,
    weekdayCount: gen.weekdayCount,
    weekendCount: gen.weekendCount,
    baselineHours: gen.baselineHours,
    totalHours: gen.totalHours
  });

  // 获取 CSRF 口令
  const token = await fetchCsrfToken();

  // 获取相应日期的UTC毫秒值
  const dates = daysInMonthUTC(year, month);
  for (const ms of dates) {
    const key = isoYmdUTC(ms);
    const catshours = gen.hoursByDate[key];

    const r = await postOneDayBatch({
      token,
      username,
      wbs,
      wbsDesc,
      ms,
      catshours,
    });

    console.log(key, "hours=", catshours, "HTTP", r.status);

    if (r.status >= 400) {
      console.log("Response body (first 800 chars):", r.text.slice(0, 800));
      throw new Error("Failed on " + key);
    }
  }

  return gen; // 返回 hoursByDate 方便你留存/对照
}

// ======== 示例调用：提交 2026 年 1 月 ========
submitMonthTimesheet(2026, 1);
