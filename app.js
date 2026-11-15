
const stocks = [];

const search = document.getElementById("search");
const sort = document.getElementById("sort");
const container = document.getElementById("stocks");
const updated = document.getElementById("updated");

async function loadStocks() {
  try {
    const response = await fetch("./data/stocks.json");
    if (!response.ok) throw new Error("데이터를 불러오지 못했습니다.");

    const data = await response.json();
    stocks.push(...(data.stocks || []));
    updated.textContent = "자료 기준일: " + (data.updated || "미확인");
  } catch (error) {
    updated.textContent = "자료 연결 대기 중";
  }

  render();
}

function render() {
  const keyword = search.value.trim().toLowerCase();

  let list = stocks.filter(stock =>
    (stock.name || "").toLowerCase().includes(keyword) ||
    (stock.code || "").includes(keyword)
  );

  if (sort.value === "upside") {
    list.sort((a, b) => (b.upside ?? -Infinity) - (a.upside ?? -Infinity));
  } else {
    list.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko"));
  }

  if (!list.length) {
    container.innerHTML =
      '<p class="stock">표시할 종목 데이터가 없습니다. 공식 자료 연동을 기다려 주세요.</p>';
    return;
  }

  container.innerHTML = list.map(stock => `
    <article class="stock">
      <h3>${escapeHTML(stock.name)} (${escapeHTML(stock.code)})</h3>
      <p>최근 종가: ${stock.price ?? "자료 없음"}</p>
      <p>등락률: ${stock.changeRate ?? "자료 없음"}</p>
      <p>평균 목표주가: ${stock.targetPrice ?? "자료 없음"}</p>
      <p>목표주가 상승여력: ${stock.upside == null ? "자료 없음" : stock.upside + "%"}</p>
      <p>배당금: ${stock.dividend ?? "자료 없음"}</p>
      <p>배당기준일: ${stock.recordDate ?? "미정"}</p>
      <p>마지막 매수일: ${stock.lastBuyDate ?? "미정"}</p>
      <p>배당락일: ${stock.exDate ?? "미정"}</p>
    </article>
  `).join("");
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[char]);
}

search.addEventListener("input", render);
sort.addEventListener("change", render);

loadStocks();
