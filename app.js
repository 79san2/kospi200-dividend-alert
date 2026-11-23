const search = document.getElementById("search");
const sort = document.getElementById("sort");
const container = document.getElementById("stocks");
const updated = document.getElementById("updated");
const won = new Intl.NumberFormat("ko-KR");
const koreaDate = new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Seoul"});
const more = document.getElementById("more");
const pageSize = 15;
let limit = pageSize;
let stocks = [];
let receivedData = false;
let period = "upcoming";
let currentView = "schedule";
const dayMs = 86400000;
const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
const bookmarkKey = "kospi200-dividend-alert.favorites";
const overview = document.getElementById("overview");
const viewTitles = {schedule: "매수 마감 일정", all: "전체 종목", saved: "관심 종목"};
let favorites = new Set();
try {
  const saved = JSON.parse(localStorage.getItem(bookmarkKey));
  if (Array.isArray(saved)) favorites = new Set(saved.filter(value => typeof value === "string"));
} catch { /* Browsers with storage disabled can still use favorites for the session. */ }

function visibleEvent(stock) {
  if (stock.pendingNotice) {
    return {unavailable: "새 공시 확인 중", source: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + stock.pendingNotice.rcept_no};
  }
  const reported = stock.decision;
  const ir = stock.quarter;
  if (!reported) return ir;
  if (ir && reported.recordDate && ir.recordDate > reported.recordDate) return ir;
  if (ir && ir.recordDate && ir.recordDate === reported.recordDate && !reported.paymentDate && ir.paymentDate) {
    return {...reported, paymentDate: ir.paymentDate, paymentSource: ir.source};
  }
  return reported;
}

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
  if (q.unavailable) return `<p class="caption">${escapeHTML(q.unavailable)} · ${sourceLink(q.source, "공시 원문")}</p>`;
  const today = koreaDate.format(new Date());
  let status = "";
  if (q.lastBuyDate) {
    if (today > q.lastBuyDate) status = "매수 기한 지남";
    else if (today === q.lastBuyDate) status = "오늘이 마지막 매수일";
    else status = "매수 기한 전";
  } else if (q.recordDate && today > q.recordDate) {
    status = "기준일 지남";
  }
  return `<section><h3>${escapeHTML(q.period)}${q.period?.endsWith("배당") ? "" : " 배당"}</h3>
    <p class="amount">${q.amount == null ? "금액 확인 대기" : won.format(q.amount) + "원 <small>/ 1주</small>"}</p>
    ${status ? `<p class="status">${status}</p>` : ""}
    <dl>
      ${line("마지막 매수·보유일", q.lastBuyDate || "확인 대기")}
      ${line("배당락일 · 매도 가능", q.exDate || "확인 대기")}
      ${line("배당기준일", q.recordDate || "공시 확인 대기")}
      ${line("지급예정일", q.paymentDate || "확인 대기")}
    </dl>
    ${q.differential ? '<p class="caption">차등배당 적용 · 대상별 금액은 공시 원문을 확인하세요.</p>' : ""}
    <p class="sources">${q.publishedOn ? "공시 " + escapeHTML(q.publishedOn) : "분기 배당 확인 " + escapeHTML(q.checkedOn)} ·
      ${sourceLink(q.source, q.receipt ? "배당결정 공시" : "삼성전자 IR")}
      ${q.decisionSource ? " · " + sourceLink(q.decisionSource, "배당결정 공시") : ""}
      ${q.paymentSource ? " · " + sourceLink(q.paymentSource, "지급일 확인 · 삼성전자 IR") : ""}
      ${q.tradingSource ? " · " + sourceLink(q.tradingSource, q.receipt ? "매수·배당락일 계산 근거" : "매수일 근거") : ""}</p></section>`;
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

function quoteAmount(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[,원\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function marketValues(stock) {
  const price = quoteAmount(stock.quote ? stock.quote.amount : stock.price);
  const target = quoteAmount(stock.consensus ? stock.consensus.amount : stock.targetPrice);
  const upside = price && target ? (target / price - 1) * 100 : null;
  return {price, target, upside};
}

function marketDetails(stock, upside) {
  const q = stock.quote, c = stock.consensus;
  const traded = q?.tradedAt?.replace("T", " ").slice(0, 16);
  const url = "https://m.stock.naver.com/domestic/stock/" + encodeURIComponent(stock.code) + "/total";
  return `<section><h3>주가 기준</h3><dl>
    ${line("시세 기준 (한국시간)", (traded || "확인 대기") + (stock.quoteDelayed ? " · 갱신 지연" : ""))}
    ${line(c?.asOf ? "평균 목표주가 집계일" : "목표주가 확인일", (c?.asOf || c?.checkedOn || "확인 대기") + (stock.consensusDelayed ? " · 갱신 지연" : ""))}
    ${upside == null ? "" : line("현재가 대비 목표주가", (upside > 0 ? "+" : "") + upside.toFixed(1) + "%")}
    ${stock.changeRate == null ? "" : line("등락률", stock.changeRate)}
    </dl><p class="sources">${sourceLink(url, "네이버페이 증권에서 확인")}</p></section>`;
}

function stockCard(stock) {
  const event = visibleEvent(stock);
  const {price, target, upside} = marketValues(stock);
  const priceText = price ? won.format(price) + "원" : "확인 대기";
  const quoteStamp = stock.quote?.tradedAt?.slice(5, 16).replace("-", ".").replace("T", " ");
  const targetText = target ? won.format(target) + "원" :
    stock.consensus?.amount === null && !stock.consensusDelayed ? "자료 없음" : "확인 대기";
  const previous = [["배당금", stock.dividend], ["마지막 매수일", stock.lastBuyDate],
    ["배당락일", stock.exDate], ["배당기준일", stock.recordDate]]
    .filter(([, value]) => value != null);
  const history = stock.annual?.history || [];
  const annual = history[0];
  const useAnnual = !event && annual;
  const amount = useAnnual ? annual.amount : event?.amount;
  const label = useAnnual ? annual.year + "년 연간" : event?.period || "";
  const saved = favorites.has(stock.code);
  const name = escapeHTML(stock.name);
  const code = escapeHTML(stock.code);
  return `<article class="stock" data-code="${code}">
    <button type="button" class="bookmark" aria-label="${name} 관심 종목" aria-pressed="${saved}">
      <svg class="icon" aria-hidden="true"><use href="#i-bookmark"/></svg></button>
    <details><summary>
      <span class="identity"><strong>${name}</strong><small>${code}</small></span>
      <span class="quote"><strong>${amount == null ? "확인 대기" : won.format(amount) + '<small>원</small>'}</strong>
        <small>${escapeHTML(label || (event?.unavailable ? "공시 확인 중" : "주당 배당금"))}</small></span>
      <svg class="icon chevron" aria-hidden="true"><use href="#i-chevron"/></svg>
      <span class="market-preview">
        <span>현재가 <b>${priceText}</b>${stock.quoteDelayed && price ? " (이전)" : ""}</span>
        <span>평균 목표주가 <b>${targetText}</b>${stock.consensusDelayed && target ? " (이전)" : ""}</span>
        ${quoteStamp ? '<small>' + escapeHTML(quoteStamp) + ' 시세</small>' : ""}
      </span>
    </summary><div class="detail">
    ${marketDetails(stock, upside)}
    ${event ? quarterSection(event) : '<p class="caption">확인된 배당 일정 없음</p>'}
    ${history.length ? annualSection(stock.annual) :
      (stock.annual ? '<p class="sources">' + escapeHTML(stock.annual.reportYear) + '년 보통주 주당배당금 확인 대기 · ' + sourceLink(stock.annual.source, "연간 공시") + '</p>' : "")}
    ${!event && previous.length ? "<dl>" + previous.map(pair => line(...pair)).join("") + "</dl>" : ""}
    </div></details></article>`;
}

function shortDate(iso) {
  const day = new Date(iso + "T00:00:00Z");
  return `${day.getUTCMonth() + 1}월 ${day.getUTCDate()}일 (${weekdays[day.getUTCDay()]})`;
}

function renderOverview(upcoming, today) {
  const next = upcoming[0]?.day;
  overview.hidden = currentView !== "schedule" || !receivedData;
  if (overview.hidden) return;
  if (!next) {
    overview.innerHTML = '<div class="hero"><p class="hero-label">가장 가까운 매수 마감</p><h2 class="no-date">예정된 일정이 없습니다</h2><p class="hero-info">배당 결정 공시를 확인하면 날짜가 표시됩니다.</p></div>';
    return;
  }
  const day = new Date(next + "T00:00:00Z");
  const diff = Math.round((day.getTime() - Date.parse(today + "T00:00:00Z")) / dayMs);
  const monday = day.getTime() - ((day.getUTCDay() + 6) % 7) * dayMs;
  const scheduledDays = new Set(upcoming.map(item => item.day));
  const week = Array.from({length: 7}, (_, i) => {
    const date = new Date(monday + i * dayMs);
    const iso = date.toISOString().slice(0, 10);
    return `<li class="${iso === next ? "selected" : ""}" aria-label="${shortDate(iso)}${scheduledDays.has(iso) ? " 매수 마감" : ""}">
      <span>${weekdays[date.getUTCDay()]}</span><b>${date.getUTCDate()}</b><i class="${scheduledDays.has(iso) ? "dot" : ""}"></i></li>`;
  }).join("");
  overview.innerHTML = `<div class="hero"><div class="hero-top"><p class="hero-label">가장 가까운 매수 마감</p>
    <span class="dday">${diff ? "D−" + diff : "D-DAY"}</span></div>
    <h2>${day.getUTCMonth() + 1}월 ${day.getUTCDate()}일</h2>
    <p class="hero-info">${weekdays[day.getUTCDay()]}요일 · ${upcoming.filter(item => item.day === next).length}개 종목 매수 마감</p>
    <ul class="week" aria-label="매수 마감 주간">${week}</ul></div>`;
}

function render() {
  const keyword = search.value.trim().toLowerCase();
  const today = koreaDate.format(new Date());
  const byDate = stocks.map(stock => ({stock, day: visibleEvent(stock)?.lastBuyDate})).filter(item => item.day)
    .sort((a, b) => a.day.localeCompare(b.day) || a.stock.name.localeCompare(b.stock.name, "ko"));
  const upcoming = byDate.filter(item => item.day >= today);
  renderOverview(upcoming, today);
  const schedule = currentView === "schedule";
  document.getElementById("main").classList.toggle("schedule-layout", schedule);
  document.getElementById("view-title").textContent = viewTitles[currentView];
  document.getElementById("schedule-filter").hidden = !schedule;
  document.getElementById("list-tools").hidden = schedule;
  let list;
  if (schedule) {
    const dated = period === "upcoming" ? upcoming : byDate.filter(item => item.day < today).sort((a,b) => b.day.localeCompare(a.day));
    list = dated.map(item => item.stock);
  } else {
    list = stocks.filter(stock => (currentView !== "saved" || favorites.has(stock.code)) &&
      (stock.name.toLowerCase().includes(keyword) || stock.code.toLowerCase().includes(keyword)));
    list.sort((a,b) => {
      if (sort.value === "deadline") {
        const da = visibleEvent(a)?.lastBuyDate || "", db = visibleEvent(b)?.lastBuyDate || "";
        const order = (da >= today ? da : "9999").localeCompare(db >= today ? db : "9999") || db.localeCompare(da);
        if (order) return order;
      } else if (sort.value === "upside") {
        const order = (marketValues(b).upside ?? -Infinity) - (marketValues(a).upside ?? -Infinity);
        if (order) return order;
      }
      return a.name.localeCompare(b.name, "ko");
    });
  }
  document.getElementById("count").textContent = receivedData ? list.length + "종목" : "";
  more.hidden = list.length <= limit;
  more.textContent = `종목 더 보기 (${Math.min(list.length, limit)}/${list.length})`;
  const opened = new Set([...container.querySelectorAll("details[open]")].map(el => el.closest(".stock").dataset.code));
  let lastDay = "";
  const rows = list.slice(0,limit).map(stock => {
    const day = visibleEvent(stock)?.lastBuyDate;
    const heading = schedule && day !== lastDay ? `<h3 class="date-heading"><span>${shortDate(day)}</span><small>1주당 배당금</small></h3>` : "";
    lastDay = day;
    return heading + stockCard(stock);
  }).join("");
  const empty = keyword && !schedule ? "검색 결과가 없습니다." : currentView === "saved" ? "종목 옆 북마크를 누르면 여기에 모입니다." :
    schedule ? (period === "upcoming" ? "새 매수 마감 일정을 기다리고 있습니다." : "확인된 지난 일정이 없습니다.") : "표시할 종목이 없습니다.";
  container.innerHTML = rows || (receivedData ? '<p class="empty">' + empty + '</p>' : "");
  for (const card of container.querySelectorAll(".stock")) {
    if (opened.has(card.dataset.code) || (!schedule && keyword && list.length === 1)) card.querySelector("details").open = true;
  }
}

function selectView() {
  const hash = location.hash.slice(1);
  currentView = Object.hasOwn(viewTitles, hash) ? hash : "schedule";
  for (const button of document.querySelectorAll("[data-view]")) {
    if (button.dataset.view === currentView) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  search.value = "";
  limit = pageSize;
  container.replaceChildren();
  render();
  window.scrollTo(0,0);
}

function navigate(view) {
  if (currentView === view) return;
  history.pushState(null, "", "#" + view);
  selectView();
}

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => navigate(button.dataset.view));
}
window.addEventListener("hashchange", selectView);
document.getElementById("open-search").addEventListener("click", () => {
  navigate("all");
  search.focus();
});
for (const button of document.querySelectorAll("[data-period]")) {
  button.addEventListener("click", () => {
    period = button.dataset.period;
    for (const control of document.querySelectorAll("[data-period]")) {
      control.setAttribute("aria-pressed", String(control.dataset.period === period));
    }
    resetList();
  });
}
container.addEventListener("click", event => {
  const button = event.target.closest(".bookmark");
  if (!button) return;
  const card = button.closest(".stock");
  const code = card.dataset.code;
  const save = !favorites.has(code);
  if (save) favorites.add(code);
  else favorites.delete(code);
  let message = save ? "관심 종목에 추가했습니다." : "관심 종목에서 삭제했습니다.";
  try { localStorage.setItem(bookmarkKey, JSON.stringify([...favorites])); }
  catch { message += " 현재 브라우저에서는 앱을 닫을 때까지 유지됩니다."; }
  document.getElementById("feedback").textContent = message;
  button.setAttribute("aria-pressed", String(save));
  if (currentView === "saved" && !save) {
    render();
    (container.querySelector(".bookmark") || search).focus();
  }
});

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
    const stamp = data.updatedAt || (/^\d{4}-\d{2}-\d{2}$/.test(data.updated) ? data.updated : "");
    if (latest !== null && (stamp < latest || (stamp === latest && index < shown))) return;
    latest = stamp;
    shown = index;
    stocks = data.stocks;
    receivedData = true;
    updated.textContent = `구성종목 ${stocks.length}개 · 구성 기준 ${data.membershipDate || data.updated || "미확인"} · 배당자료 확인 ${data.updated || "미확인"}`;
    render();
  }));
  if (latest === null) updated.textContent = "배당자료를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.";
}

function resetList() {
  limit = pageSize;
  render();
}
search.addEventListener("input", resetList);
sort.addEventListener("change", resetList);
more.addEventListener("click", () => {
  limit += pageSize;
  render();
});
selectView();
loadStocks();
