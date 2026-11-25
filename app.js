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
let calendarOffset = 0;
let selectedDay = "";
let currentView = "schedule";
let selectedCode = "";
let restoreList = null;
const backButton = document.getElementById("back-to-list");
const title = document.getElementById("view-title");
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

function priceChart(stock) {
  const days = Object.entries(stock.dailyCloses || {})
    .filter(([day,value]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(value) && value > 0)
    .sort(([a],[b]) => a.localeCompare(b));
  if (!days.length) return '<section><h3>주가 그래프</h3><p class="caption">일별 종가 자료를 기다리고 있습니다.</p></section>';
  const values = days.map(([,value]) => value);
  const low = Math.min(...values), high = Math.max(...values);
  const last = days.length - 1;
  const x = i => last ? 8 + 274 * i / last : 145;
  const y = value => high === low ? 67 : 116 - 98 * (value - low) / (high - low);
  const points = values.map((value,i) => x(i).toFixed(1) + "," + y(value).toFixed(1)).join(" ");
  const ticks = [...new Set([high,low])].map(value =>
    `<line x1="8" x2="282" y1="${y(value)}" y2="${y(value)}"/><text x="354" y="${y(value)+4}" text-anchor="end">${won.format(value)}</text>`).join("");
  const label = day => day.slice(5).replace("-", ".");
  return `<section><h3>최근 ${days.length}거래일 종가</h3>
    <p class="caption">시간외 거래 포함 · 단위 원${stock.chartDelayed ? " · 갱신 지연" : ""}</p>
    <svg class="price-chart" viewBox="0 0 360 145" role="img" aria-labelledby="chart-title">
      <title id="chart-title">${escapeHTML(stock.name)} ${days[0][0]}부터 ${days[last][0]}까지 종가. 최저 ${won.format(low)}원, 최고 ${won.format(high)}원.</title>
      <g>${ticks}</g>
      <polyline points="${points}" fill="none" stroke="#196547" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(last)}" cy="${y(values[last])}" r="3.4" fill="#196547"/>
      <text x="8" y="139">${label(days[0][0])}</text>
      ${last ? `<text x="282" y="139" text-anchor="end">${label(days[last][0])}</text>` : ""}
    </svg>
    <details class="daily-table"><summary>날짜별 종가 보기</summary>
      <table><thead><tr><th>거래일</th><th>종가</th></tr></thead><tbody>
        ${days.reverse().map(([day,v]) => `<tr><td>${day}</td><td>${won.format(v)}원</td></tr>`).join("")}
      </tbody></table></details></section>`;
}

function investmentSection(stock) {
  const {upside} = marketValues(stock);
  const stale = stock.quoteDelayed || stock.consensusDelayed;
  const days = Object.entries(stock.dailyCloses || {}).filter(([d,v]) => /^\\d{4}-\\d{2}-\\d{2}$/.test(d) && Number.isFinite(v) && v > 0).sort(([a],[b]) => a.localeCompare(b));
  const change = days.length > 1 ? (days[days.length-1][1] / days[0][1] - 1) * 100 : null;
  const pct = n => (n > 0 ? "+" : "") + n.toFixed(1) + "%";
  const url = "https://finance.naver.com/item/coinfo.naver?code=" + encodeURIComponent(stock.code);
  const history = Object.entries(stock.targetHistory || {}).filter(([d,v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(v) && v > 0).sort(([a],[b]) => a.localeCompare(b));
  const last = history.at(-1), prior = history.at(-2);
  const targetChange = last && prior && !stock.consensusDelayed && stock.consensus?.amount === last[1] ? pct((last[1]/prior[1]-1)*100) + " (" + prior[0] + " → " + last[0] + ")" : "비교 자료 축적 중";
  const risk = upside == null || stale ? "최신 목표주가·시세 확인 필요" : upside < 0 ? "현재가가 평균 목표주가보다 높음" : "목표주가와 실제 수익률은 다를 수 있음";
  const reports = "https://finance.naver.com/research/company_list.naver?searchType=itemCode&itemCode=" + encodeURIComponent(stock.code);

  return `<section><h3>투자 핵심정보</h3><dl>${line("목표주가 대비 상승여력", upside == null || stale ? "최신 자료 확인 대기" : pct(upside))}${line("최근 종가 변동", change == null || stock.chartDelayed ? "확인 대기" : pct(change) + " (" + days.length + "거래일)")}${line("평균 목표주가 변동", targetChange)}${line("투자 유의사항", risk)}${line("실적·주주환원 분석", "공식 자료 연동 대기")}</dl><p class="caption">목표주가는 전망치이며 상승을 보장하지 않습니다.</p><p class="sources">${sourceLink(url, "기업 실적·투자정보 확인")} · ${sourceLink(reports, "증권사 리포트 검색")}</p></section>`;
}

function stockCard(stock, detail = false) {
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
  const bookmark = `<button type="button" class="bookmark" aria-label="${name} 관심 종목" aria-pressed="${saved}">
      <svg class="icon" aria-hidden="true"><use href="#i-bookmark"/></svg></button>`;
  if (!detail) return `<article class="stock" data-code="${code}">${bookmark}
    <a class="stock-link" href="#stock/${code}">
      <span class="identity"><strong>${name}</strong><small>${code}</small></span>
      <span class="quote"><strong>${amount == null ? "확인 대기" : won.format(amount) + '<small>원</small>'}</strong>
        <small>${escapeHTML(label || (event?.unavailable ? "공시 확인 중" : "주당 배당금"))}</small></span>
      <svg class="icon chevron" aria-hidden="true"><use href="#i-chevron"/></svg>
      <span class="market-preview">
        <span>현재가 <b>${priceText}</b>${stock.quoteDelayed && price ? " (이전)" : ""}</span>
        <span>평균 목표주가 <b>${targetText}</b>${stock.consensusDelayed && target ? " (이전)" : ""}</span>
        ${quoteStamp ? '<small>' + escapeHTML(quoteStamp) + ' 시세</small>' : ""}
      </span>
    </a></article>`;
  const bar = value => price && target ? `<span class="compare-track" aria-hidden="true"><i style="width:${100 * value / Math.max(price,target)}%"></i></span>` : "";
  return `<article class="stock detail-stock" data-code="${code}">
    <div class="ticker">${code}${bookmark}</div>
    <dl class="price-pair"><div><dt>현재가</dt><dd>${priceText}${stock.quoteDelayed && price ? " (이전)" : ""}${bar(price)}</dd></div>
      <div><dt>평균 목표주가</dt><dd>${targetText}${stock.consensusDelayed && target ? " (이전)" : ""}${bar(target)}</dd></div></dl>
    <div class="detail">${investmentSection(stock)}${priceChart(stock)}${marketDetails(stock, upside)}
    ${event ? quarterSection(event) : '<p class="caption">확인된 배당 일정 없음</p>'}
    ${history.length ? annualSection(stock.annual) :
      (stock.annual ? '<p class="sources">' + escapeHTML(stock.annual.reportYear) + '년 보통주 주당배당금 확인 대기 · ' + sourceLink(stock.annual.source, "연간 공시") + '</p>' : "")}
    ${!event && previous.length ? "<dl>" + previous.map(pair => line(...pair)).join("") + "</dl>" : ""}
    </div></article>`;
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

function renderCalendar(upcoming, today) {
  const el = document.getElementById("calendar");
  if (!el) return;
  el.hidden = currentView !== "schedule" || !receivedData;
  if (el.hidden) return;
  const [y,m] = today.split("-").map(Number);
  const first = new Date(Date.UTC(y,m-1+calendarOffset,1));
  const year = first.getUTCFullYear(), month = first.getUTCMonth();
  const total = new Date(Date.UTC(year,month+1,0)).getUTCDate();
  const counts = new Map();
  for (const item of upcoming) counts.set(item.day,(counts.get(item.day)||0)+1);
  const cells = Array.from({length:first.getUTCDay()},()=>'<span></span>');
  for(let d=1;d<=total;d++){
    const iso = new Date(Date.UTC(year,month,d)).toISOString().slice(0,10);
    const n = counts.get(iso)||0;
    cells.push('<button type="button" data-day="'+iso+'" aria-pressed="'+(selectedDay===iso)+'" aria-label="'+iso+' 매수 마감 '+n+'종목" '+(iso<today?'disabled':'')+' class="'+(n?'has-event ':'')+(iso===today?'today':'')+'"><b>'+d+'</b><small>'+(n?n+'종목':'&nbsp;')+'</small></button>');
  }
  el.innerHTML = '<div class="cal-head"><button type="button" data-month="-1" aria-label="이전 달" '+(calendarOffset===0?'disabled':'')+'>‹</button><h3>'+year+'년 '+(month+1)+'월</h3><button type="button" data-month="1" aria-label="다음 달" '+(calendarOffset===2?'disabled':'')+'>›</button></div><div class="cal-grid">'+weekdays.map(w=>'<span class="cal-weekday">'+w+'</span>').join('')+cells.join('')+'</div><div class="cal-footer"><span>● 확정 매수 마감일</span><button type="button" data-clear-day aria-pressed="'+(!selectedDay)+'">전체 예정 일정</button></div><p class="caption">공식 자료로 확인된 날짜만 표시합니다. 일정이 없는 날짜는 미발표일 수 있습니다.</p>';
}

function render() {
  backButton.hidden = !selectedCode;
  document.getElementById("count").hidden = Boolean(selectedCode);
  if (selectedCode) {
    overview.hidden = true;
    if (document.getElementById("calendar")) document.getElementById("calendar").hidden = true;
    document.getElementById("main").classList.remove("schedule-layout");
    for (const id of ["list-tools", "schedule-filter", "more"]) document.getElementById(id).hidden = true;
    const stock = stocks.find(s => s.code === selectedCode);
    title.textContent = stock?.name || "종목 상세";
    document.title = stock ? stock.name + " · 배당 알리미" : "코스피200 배당 알리미";
    const tableOpen = container.querySelector(".stock")?.dataset.code === selectedCode && container.querySelector(".daily-table")?.open;
    container.innerHTML = stock ? stockCard(stock, true) : receivedData ? '<p class="empty">목록에서 찾을 수 없는 종목입니다.</p>' : "";
    if (tableOpen && container.querySelector(".daily-table")) container.querySelector(".daily-table").open = true;
    updated.hidden = Boolean(stock);
    return;
  }
  updated.hidden = false;
  document.title = "코스피200 배당 알리미";
  const keyword = search.value.trim().toLowerCase();
  const today = koreaDate.format(new Date());
  const byDate = stocks.map(stock => ({stock, day: visibleEvent(stock)?.lastBuyDate})).filter(item => item.day)
    .sort((a, b) => a.day.localeCompare(b.day) || a.stock.name.localeCompare(b.stock.name, "ko"));
  const upcoming = byDate.filter(item => item.day >= today);
  renderOverview(upcoming, today);
  renderCalendar(upcoming, today);
  const schedule = currentView === "schedule";
  document.getElementById("main").classList.toggle("schedule-layout", schedule);
  document.getElementById("view-title").textContent = viewTitles[currentView];
  document.getElementById("schedule-filter").hidden = true;
  document.getElementById("list-tools").hidden = schedule;
  let list;
  if (schedule) {
    const dated = selectedDay ? upcoming.filter(item => item.day === selectedDay) : upcoming;
    title.textContent = selectedDay ? shortDate(selectedDay) + " 매수 마감" : "다가오는 매수 마감 일정";
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
        const valid = s => s.quoteDelayed || s.consensusDelayed ? -Infinity : (marketValues(s).upside ?? -Infinity);
        const order = valid(b) - valid(a);
        if (order) return order;
      }
      return a.name.localeCompare(b.name, "ko");
    });
  }
  document.getElementById("count").textContent = receivedData ? list.length + "종목" : "";
  more.hidden = list.length <= limit;
  more.textContent = `종목 더 보기 (${Math.min(list.length, limit)}/${list.length})`;
  let lastDay = "";
  const rows = list.slice(0,limit).map(stock => {
    const day = visibleEvent(stock)?.lastBuyDate;
    const heading = schedule && day !== lastDay ? `<h3 class="date-heading"><span>${shortDate(day)}</span><small>1주당 배당금</small></h3>` : "";
    lastDay = day;
    return heading + stockCard(stock);
  }).join("");
  const empty = keyword && !schedule ? "검색 결과가 없습니다." : currentView === "saved" ? "종목 옆 북마크를 누르면 여기에 모입니다." :
    schedule ? (selectedDay ? "선택한 날짜에 확인된 매수 마감 일정이 없습니다." : "새 매수 마감 일정을 기다리고 있습니다.") : "표시할 종목이 없습니다.";
  container.innerHTML = rows || (receivedData ? '<p class="empty">' + empty + '</p>' : "");
  if (restoreList && receivedData) {
    const saved = restoreList;
    restoreList = null;
    container.querySelector(`a[href="#stock/${saved.code}"]`)?.focus({preventScroll:true});
    window.scrollTo(0,saved.y);
  }
}

function selectView() {
  const hash = location.hash.slice(1);
  selectedCode = /^stock\/([A-Z0-9]{6})$/.exec(hash)?.[1] || "";
  currentView = selectedCode ? "stock" : Object.hasOwn(viewTitles, hash) ? hash : "schedule";
  restoreList = currentView === history.state?.list?.view ? history.state.list : null;
  for (const button of document.querySelectorAll("[data-view]")) {
    if (button.dataset.view === currentView) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  search.value = restoreList?.keyword || "";
  limit = restoreList?.limit || pageSize;
  if (restoreList) {
    sort.value = restoreList.sort;
    period = restoreList.period;
    for (const button of document.querySelectorAll("[data-period]")) {
      button.setAttribute("aria-pressed", String(button.dataset.period === period));
    }
  } else {
    window.scrollTo(0,0);
  }
  render();
  if (selectedCode) title.focus({preventScroll:true});
}

function navigate(view) {
  if (currentView === view) return;
  history.pushState(null, "", "#" + view);
  selectView();
}

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => navigate(button.dataset.view));
}
backButton.addEventListener("click", () => {
  if (history.state?.fromList) history.back();
  else {
    history.replaceState(null, "", "#all");
    selectView();
  }
});
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
  const link = event.target.closest(".stock-link");
  if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
    event.preventDefault();
    const code = link.closest(".stock").dataset.code;
    history.replaceState({list:{view:currentView,code,keyword:search.value,sort:sort.value,period,limit,y:window.scrollY}}, "");
    history.pushState({fromList:true}, "", link.hash);
    selectView();
    return;
  }
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
document.getElementById("calendar")?.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.month) {
    calendarOffset = Math.max(0, Math.min(2, calendarOffset + Number(button.dataset.month)));
    selectedDay = "";
  } else if (button.dataset.day) {
    selectedDay = selectedDay === button.dataset.day ? "" : button.dataset.day;
  } else if (button.hasAttribute("data-clear-day")) {
    selectedDay = "";
  }
  resetList();
});
selectView();
loadStocks();
