"""Collect dated KRW quotes and published analyst target means from Naver Finance."""
import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
POLLING = "https://polling.finance.naver.com/api/realtime/domestic/stock/"
STOCK = "https://m.stock.naver.com/api/stock/"


def fetch_json(url):
    request = Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    for attempt in range(2):
        try:
            with urlopen(request, timeout=12) as response:
                return json.load(response)
        except (HTTPError, URLError, TimeoutError) as err:
            if attempt or isinstance(err, HTTPError) and err.code not in (429, 500, 502, 503, 504):
                raise
            time.sleep(1)


def price(value):
    number = str(value).strip().replace(",", "")
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", number) and float(number) > 0:
        return round(float(number))
    raise ValueError("금액 형식 확인 필요")


def quote(row):
    if (row.get("currencyType") or {}).get("code", "KRW") != "KRW":
        raise ValueError("시세 통화 확인 필요")
    extended = row.get("overMarketPriceInfo") or {}
    candidates = []
    for amount, stamp in [(row.get("closePrice"), row.get("localTradedAt")),
                          (extended.get("overPrice"), extended.get("localTradedAt"))]:
        try:
            moment = datetime.fromisoformat(stamp)
            if moment.tzinfo:
                candidates.append((moment.astimezone(KST), price(amount)))
        except (ValueError, TypeError):
            continue
    if not candidates:
        raise ValueError("거래 시각 또는 체결가 없음")
    moment, amount = max(candidates, key=lambda pair: pair[0])
    return {"amount": amount, "tradedAt": moment.isoformat(timespec="seconds")}


def consensus(code, today):
    row = fetch_json(STOCK + code + "/integration")
    if row.get("itemCode") != code or "consensusInfo" not in row:
        raise ValueError("컨센서스 응답 확인 필요")
    entry = row["consensusInfo"]
    if entry is None:
        return {"amount": None, "checkedOn": today.isoformat()}
    if not isinstance(entry, dict) or entry.get("itemCode", code) != code or "priceTargetMean" not in entry:
        raise ValueError("컨센서스 항목 확인 필요")
    if entry["priceTargetMean"] in (None, "", "-", "N/A", 0, "0"):
        return {"amount": None, "checkedOn": today.isoformat()}
    return {"amount": price(entry["priceTargetMean"]), "asOf": date.fromisoformat(entry["createDate"]).isoformat()}


def update_chart(stock, today):
    code = stock["code"]
    try:
        rows = fetch_json(STOCK + code + "/price?page=1&pageSize=21")
        if not isinstance(rows, list):
            raise ValueError("일별 시세 형식 확인 필요")
        now = datetime.now(KST)
        # The integrated daily series includes after-hours trades. Skip a live bar.
        closed_today = today == now.date() and (now.hour, now.minute) >= (20, 10)
        closes = {}
        for row in rows:
            day = date.fromisoformat(row["localTradedAt"])
            if day < today or day == today and closed_today:
                closes[day.isoformat()] = price(row["closePrice"])
        previous = stock.get("dailyCloses", {})
        if not closes or previous and max(closes) < max(previous):
            raise ValueError("최신 일별 시세 없음")
        stock["dailyCloses"] = dict(sorted(closes.items())[-20:])
        stock.pop("chartDelayed", None)
    except (OSError, ValueError, KeyError, TypeError) as err:
        stock["chartDelayed"] = True
        logging.warning("%s 종가 갱신 지연 (%s)", code, type(err).__name__)


def refresh_prices(stocks, today):
    codes = list(stocks)
    quotes = {}
    for start in range(0, len(codes), 20):
        batch = codes[start:start + 20]
        try:
            for row in fetch_json(POLLING + ",".join(batch))["datas"]:
                code = row.get("itemCode")
                if code in batch:
                    try:
                        quotes[code] = quote(row)
                    except ValueError:
                        continue
        except (OSError, ValueError, KeyError, TypeError) as err:
            logging.warning("시세 일괄 조회 지연 %s (%s)", batch[0], type(err).__name__)

    def update(code):
        stock = stocks[code]
        for field, stamp in [("quote", "tradedAt"), ("consensus", "asOf")]:
            try:
                if field == "consensus":
                    fresh = consensus(code, today)
                elif code in quotes:
                    fresh = quotes[code]
                else:
                    row = fetch_json(STOCK + code + "/basic")
                    if row.get("itemCode") != code:
                        raise ValueError("시세 종목 불일치")
                    fresh = quote(row)
                previous = stock.get(field, {})
                if fresh.get(stamp) and fresh[stamp] < previous.get(stamp, ""):
                    raise ValueError("이전 시점 응답")
                if field == "consensus" and fresh.get("amount") and fresh.get("asOf"):
                    history = stock.get("targetHistory", {})
                    if previous.get("amount") and previous.get("asOf"):
                        history.setdefault(previous["asOf"], previous["amount"])
                    history[fresh["asOf"]] = fresh["amount"]
                    stock["targetHistory"] = dict(sorted(history.items())[-60:])
                stock[field] = fresh
                stock.pop(field + "Delayed", None)
            except (OSError, ValueError, TypeError, KeyError) as err:
                stock[field + "Delayed"] = True
                logging.warning("%s %s 갱신 지연 (%s)", code, field, type(err).__name__)

        update_chart(stock, today)

    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(update, codes))
    quotes_ok = sum(not s.get("quoteDelayed") and bool(s.get("quote")) for s in stocks.values())
    checked = sum(not s.get("consensusDelayed") and "consensus" in s for s in stocks.values())
    targets = sum(not s.get("consensusDelayed") and bool(s.get("consensus", {}).get("amount")) for s in stocks.values())
    print(f"주가 {quotes_ok}/{len(codes)} · 평균 목표주가 {targets}개 · 목표주가 조회 완료 {checked}/{len(codes)}")
    return bool(quotes_ok or checked)
