import json
import os
import re
import sys
from datetime import date, datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

DATA = Path(__file__).resolve().parents[1] / "data/stocks.json"
IR_URL = "https://www.samsung.com/sec/ir/stock-information/shareholder-return/"
DART_URL = "https://opendart.fss.or.kr/api/alotMatter.json"
CODE = "005930"


def get_annual(key, today):
    if not key:
        raise ValueError("OpenDART 인증키 미설정")
    for year in (today.year - 1, today.year - 2):
        params = urlencode({"crtfc_key": key, "corp_code": "00126380",
                            "bsns_year": year, "reprt_code": "11011"})
        with urlopen(DART_URL + "?" + params, timeout=25) as response:
            report = json.load(response)
        if report.get("status") == "013":
            continue
        if report.get("status") != "000":
            raise ValueError("OpenDART 응답 코드 " + str(report.get("status")))
        rows = [row for row in report["list"]
                if "".join(row["se"].split()) == "주당현금배당금(원)"
                and row["stock_knd"].strip() in ("보통주", "보통주식")]
        if len(rows) != 1:
            raise ValueError("삼성전자 보통주 주당 현금배당금 행 확인 필요")
        row = rows[0]
        receipt = row["rcept_no"]
        if not re.fullmatch(r"[0-9]{14}", receipt):
            raise ValueError("사업보고서 접수번호 확인 필요")
        history = []
        for offset, column in enumerate(("thstrm", "frmtrm", "lwfr")):
            amount = str(row.get(column, "")).replace(",", "").strip()
            if amount in ("-", "", "None") and offset:
                continue
            if not re.fullmatch(r"[0-9]+", amount):
                raise ValueError("연간 배당금 확인 필요")
            history.append({"year": year - offset, "amount": int(amount)})
        return {"history": history, "source": "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + receipt,
                "checkedOn": today.isoformat()}
    raise ValueError("최근 두 사업연도의 연간 공시를 찾지 못함")


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


def main():
    today = datetime.now(ZoneInfo("Asia/Seoul")).date()
    data = json.loads(DATA.read_text(encoding="utf-8"))
    stock = next((item for item in data["stocks"] if item["code"] == CODE), None)
    if stock is None:
        stock = {"name": "삼성전자", "code": CODE}
        data["stocks"].append(stock)

    failures = 0
    for field, fetch in (("annual", lambda: get_annual(os.getenv("OPENDART_API_KEY"), today)),
                         ("quarter", lambda: get_quarter(today))):
        try:
            fresh = fetch()
            previous = stock.get(field, {})
            if field == "quarter":
                if fresh["recordDate"] < previous.get("recordDate", ""):
                    raise ValueError("기존 공시보다 오래된 분기 자료")
                if fresh["recordDate"] == previous.get("recordDate"):
                    fresh = {**previous, **fresh}
            elif previous and fresh["history"][0]["year"] < previous["history"][0]["year"]:
                raise ValueError("기존 공시보다 오래된 연간 자료")
            stock[field] = fresh
            print(f"{field}: {fresh.get('period') or fresh['history'][0]['year']} "
                  f"{fresh['amount'] if field == 'quarter' else fresh['history'][0]['amount']}원")
        except (OSError, ValueError, KeyError, TypeError) as error:
            # Network errors can contain a request URL with the DART credential.
            reason = str(error) if type(error) is ValueError else type(error).__name__
            print(f"::warning::{field} 갱신 실패, 이전 자료 유지 ({reason})")
            failures += 1
    if failures == 2:
        sys.exit("두 출처 모두 갱신하지 못했습니다.")
    data["updated"] = today.isoformat()
    temp = DATA.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(DATA)


if __name__ == "__main__":
    main()
