const search = document.getElementById("search");
const sort = document.getElementById("sort");
const container = document.getElementById("stocks");
const updated = document.getElementById("updated");
const won = new Intl.NumberFormat("ko-KR");
const koreaDate = new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Seoul"});
let stocks = [];

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function sourceLink(url, label) {
  if (!url || !/^https:\/\//.test(url)) return "";
  return `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function line(label, value) {
  return `<div><dt>${label}</dt><dd>${escapeHTML(value)}</dd></div>`;
}

function quarterSection(q) {
  const today = koreaDate.format(new Date());
  let status = "";
  if (q.lastBuyDate) {
    if (today > q.lastBuyDate) status = "매수 기한 지남";
    else if (today === q.lastBuyDate) status = "오늘이 마지막 매수일";
  } else if (today > q.recordDate) {
    status = "기준일 지남";
  }
  return `<section><h3>${escapeHTML(q.period)} 배당</h3>
    <p class="amount">${won.format(q.amount)}원 <small>/ 1주</small></p>
    ${status ? `<p class="status">${status}</p>` : ""}
    <dl>
      ${line("마지막 매수·보유일", q.lastBuyDate || "확인 대기")}
      ${line("배당락일 · 매도 가능", q.exDate || "확인 대기")}
      ${line("배당기준일", q.recordDate)}
      ${line("지급예정일", q.paymentDate || "확인 대기")}
    </dl>
    <p class="sources">분기 배당 확인 ${escapeHTML(q.checkedOn)} ·
      ${sourceLink(q.source, "삼성전자 IR")}
      ${q.decisionSource ? " · " + sourceLink(q.decisionSource, "배당결정 공시") : ""}
      ${q.tradingSource ? " · " + sourceLink(q.tradingSource, "매수일 근거") : ""}</p></section>`;
}

function annualSection(annual) {
  const history = annual.history;
  const max = Math.max(1, ...history.map(item => item.amount));
  const bars = history.map(item => `<li>
    <span>${escapeHTML(item.year)}년</span>
    <span class="track" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, item.amount / max * 100))}%"></i></span>
    <strong>${won.format(item.amount)}원</strong></li>`).join("");
  return `<section><h3>연간 주당배당금</h3>
    <p class="caption">각 사업연도에 해당하는 현금배당 합계</p>
    <ul class="history">${bars}</ul>
    <p class="sources">연간 배당 확인 ${escapeHTML(annual.checkedOn)} ·
      ${sourceLink(annual.source, "연간 배당 근거")}</p></section>`;
}

function stockCard(stock) {
  const market = [
    ["최근 종가", stock.price], ["등락률", stock.changeRate],
    ["평균 목표주가", stock.targetPrice],
    ["목표주가 상승여력", stock.upside == null ? null : stock.upside + "%"]
  ].filter(([, value]) => value != null);
  const previous = [["배당금", stock.dividend], ["마지막 매수일", stock.lastBuyDate],
    ["배당락일", stock.exDate], ["배당기준일", stock.recordDate]]
    .filter(([, value]) => value != null);
  return `<article class="stock">
    <h2>${escapeHTML(stock.name)} <small>${escapeHTML(stock.code)}</small></h2>
    ${stock.quarter ? quarterSection(stock.quarter) : ""}
    ${stock.annual?.history?.length ? annualSection(stock.annual) : ""}
    ${!stock.quarter && previous.length ? "<dl>" + previous.map(pair => line(...pair)).join("") + "</dl>" : ""}
    ${market.length ? "<section><h3>주가 정보</h3><dl>" + market.map(pair => line(...pair)).join("") + "</dl></section>" : ""}
  </article>`;
}

function render() {
  const keyword = search.value.trim().toLowerCase();
  const list = stocks.filter(stock =>
    stock.name.toLowerCase().includes(keyword) || stock.code.includes(keyword));
  if (sort.value === "upside") {
    list.sort((a, b) => (b.upside ?? -Infinity) - (a.upside ?? -Infinity));
  } else {
    list.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }
  container.innerHTML = list.length ? list.map(stockCard).join("") :
    `<p class="stock">${keyword ? "검색 결과가 없습니다." : "표시할 종목이 없습니다."}</p>`;
}

async function readData(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {cache: "no-store", signal: controller.signal});
    if (!response.ok) throw new Error("자료 요청 실패");
    const data = await response.json();
    if (!Array.isArray(data.stocks)) throw new Error("종목 자료 오류");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function loadStocks() {
  // The scheduled job commits the data even when Pages does not rebuild.
  const urls = ["./data/stocks.json"];
  if (location.hostname === "79san2.github.io") {
    urls.push("https://raw.githubusercontent.com/79san2/kospi200-dividend-alert/main/data/stocks.json");
  }
  let latest = null;
  let shown = -1;
  await Promise.allSettled(urls.map(async (url, index) => {
    const data = await readData(url);
    const stamp = /^\d{4}-\d{2}-\d{2}$/.test(data.updated) ? data.updated : "";
    if (latest !== null && (stamp < latest || (stamp === latest && index < shown))) return;
    latest = stamp;
    shown = index;
    stocks = data.stocks;
    updated.textContent = `등록 종목 ${stocks.length}개 · 자료 확인 ${data.updated || "미확인"}`;
    render();
  }));
  if (latest === null) updated.textContent = "배당자료를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.";
}

search.addEventListener("input", render);
sort.addEventListener("change", render);
loadStocks();
