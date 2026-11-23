import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo
import re

import exchange_calendars

from market_data import (MASTER, RECEIPT, annual_data, cash_notices, corp_codes, decision_data,
                         read_members, read_url)

DATA = Path(__file__).resolve().parents[1] / "data/stocks.json"
ROSTER = DATA.with_name("kospi200.json")
IR_URL = "https://www.samsung.com/sec/ir/stock-information/shareholder-return/"

class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hidden = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden = True

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.hidden = False

    def handle_data(self, data):
        if not self.hidden and data.strip():
            self.parts.append(data.strip())


def get_quarter(today):
    request = Request(IR_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=25) as response:
        page = response.read().decode("utf-8")
    parser = VisibleText()
    parser.feed(page)
    body = " ".join(" ".join(parser.parts).split())
    match = re.search(
        r"(\d{4})년\s*([1-4]분기|기말|결산|중간)\s*배당\s+주당\s*배당금\s*[:：]\s*"
        r"보통주\s*([\d,]+)\s*원\s*/\s*우선주\s*[\d,]+\s*원\s*"
        r"배당\s*기준일\s*[:：]\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일", body)
    if not match:
        raise ValueError("삼성전자 IR의 분기 배당 표기 확인 필요")
    year, period, amount, y, m, d = match.groups()
    return {"period": f"{year}년 {period}", "amount": int(amount.replace(",", "")),
            "recordDate": date(int(y), int(m), int(d)).isoformat(),
            "source": IR_URL, "checkedOn": today.isoformat()}


def save(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def refresh_members():
    saved = json.loads(ROSTER.read_text())
    try:
        current = read_members(read_url(MASTER))
        if current["updated"] < saved["updated"]:
            return saved
        return current
    except Exception as err:
        if not saved["stocks"]:
            raise
        print(f"::warning::이전 구성종목 목록 유지 ({type(err).__name__})")
        return saved


def main():
    key = os.environ.get("OPENDART_API_KEY")
    if not key:
        sys.exit("OpenDART 인증키 미설정")
    today = datetime.now(ZoneInfo("Asia/Seoul")).date()
    data = json.loads(DATA.read_text())
    roster = refresh_members()
    old = {s["code"]: s for s in data["stocks"]}
    stocks = {r["code"]: {**old.get(r["code"], {}), **r} for r in roster["stocks"]}
    try:
        mapping = corp_codes(key)
    except Exception as err:
        print(f"::warning::저장된 기업 고유번호 사용 ({type(err).__name__})")
        mapping = {}
    for code, stock in stocks.items():
        if code in mapping:
            stock["corpCode"] = mapping[code]

    first = today - timedelta(days=85)
    checkpoint = data.get("noticesThrough")
    start = max(first, date.fromisoformat(checkpoint) - timedelta(days=5)) if checkpoint else first
    notices_ok = False
    try:
        notices = cash_notices(key, stocks, start, today)
        notices_ok = True
    except Exception as err:
        print(f"::warning::배당결정 목록 수집 지연 ({type(err).__name__})")
        notices = {}
    calendar = exchange_calendars.get_calendar("XKRX")
    try:
        stock = stocks.get("005930")
        if stock is not None:
            event = get_quarter(today)
            prev = stock.get("quarter", {})
            if event["recordDate"] >= prev.get("recordDate", ""):
                stock["quarter"] = {**(prev if event["recordDate"] == prev.get("recordDate") else {}), **event}
    except Exception as err:
        print(f"::warning::삼성전자 IR 갱신 지연 ({type(err).__name__})")

    def update(stock):
        code = stock["code"]
        checked = False
        if stock.get("corpCode"):
            try:
                annual = annual_data(key, stock["corpCode"], today)
                prior = stock.get("annual", {})
                if annual and annual["reportYear"] >= prior.get("reportYear", 0):
                    stock["annual"] = annual
                checked = True
            except Exception as err:
                print(f"::warning::{code} 연간 공시 갱신 지연 ({type(err).__name__})")
        candidates = {row["rcept_no"]: row for row in notices.get(code, [])}
        pending = stock.pop("pendingNotice", None)
        if pending:
            candidates.setdefault(pending["rcept_no"], pending)
        for receipt in sorted(candidates, reverse=True):
            if receipt <= stock.get("decision", {}).get("receipt", ""):
                break
            row = candidates[receipt]
            try:
                event = decision_data(row, today, calendar)
            except Exception as err:
                print(f"::warning::{code} 결정 공시 본문 확인 대기 ({type(err).__name__})")
                stock["pendingNotice"] = {k: row.get(k, "") for k in ("rcept_no", "rcept_dt", "report_nm", "rm")}
                break
            if event is not None:
                stock["decision"] = event
                break
        return checked

    with ThreadPoolExecutor(max_workers=4) as executor:
        checked_count = sum(executor.map(update, stocks.values()))
    if not checked_count and not notices_ok:
        sys.exit("배당자료 수집 실패 · 기존 자료 유지")
    if notices_ok:
        data["noticesThrough"] = today.isoformat()
    data.update(updated=today.isoformat(), updatedAt=datetime.now(ZoneInfo("Asia/Seoul")).isoformat(timespec="seconds"),
                membershipDate=roster["updated"], stocks=list(stocks.values()))
    save(ROSTER, roster)
    save(DATA, data)
    annual_count = sum(bool(s.get("annual", {}).get("history")) for s in stocks.values())
    dates = sum(bool(s.get("decision", {}).get("recordDate") or s.get("quarter")) for s in stocks.values())
    print(f"구성종목 {len(stocks)}개 · 연간 자료 조회 {checked_count}개 · 연간 금액 {annual_count}개 · 배당 일정 {dates}개")


if __name__ == "__main__":
    main()
