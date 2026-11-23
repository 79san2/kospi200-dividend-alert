import json
import re
from datetime import date
from io import BytesIO
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zipfile import ZipFile

from lxml import etree, html

MASTER = "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip"
DART = "https://opendart.fss.or.kr/api/"
RECEIPT = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo="
TRADING_RULE = "https://global.krx.co.kr/contents/GLB/06/0602/0602010204/GLB0602010204T1.jsp"


def read_url(url):
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=25) as response:
        return response.read()


def read_members(raw):
    with ZipFile(BytesIO(raw)) as archive:
        entry = archive.getinfo("kospi_code.mst")
        as_of = date(*entry.date_time[:3]).isoformat()
        lines = archive.read(entry).decode("cp949").splitlines()
    members = {}
    for line in lines:
        # KIS fixed-width suffix: stock group at 0:2, KOSPI200 sector at 18.
        tail = line[-227:]
        if tail[:2] != "ST" or tail[18] in ("0", " ", "N"):
            continue
        code, name = line[:9].strip(), line[21:-227].strip()
        if not re.fullmatch(r"[0-9A-Z]{6}", code) or not name or code in members:
            raise ValueError("구성종목 파일 형식 확인 필요")
        members[code] = {"code": code, "name": name}
    if not 185 <= len(members) <= 215:
        raise ValueError("구성종목 파일 건수 확인 필요")
    return {"updated": as_of, "source": MASTER, "stocks": list(members.values())}


def corp_codes(key):
    raw = read_url(DART + "corpCode.xml?" + urlencode({"crtfc_key": key}))
    with ZipFile(BytesIO(raw)) as archive:
        root = etree.fromstring(archive.read("CORPCODE.xml"), parser=etree.XMLParser(resolve_entities=False, no_network=True))
    return {n.findtext("stock_code", "").strip(): n.findtext("corp_code")
            for n in root.iter("list") if n.findtext("stock_code", "").strip()}


def dart_json(endpoint, key, **params):
    report = json.loads(read_url(DART + endpoint + "?" + urlencode({"crtfc_key": key, **params})))
    if report.get("status") not in ("000", "013"):
        raise ValueError("OpenDART 응답 " + str(report.get("status")))
    return report


def number(value):
    value = str(value).strip().replace(",", "")
    if re.fullmatch(r"\d+(?:\.\d+)?", value):
        numeric = float(value)
        return int(numeric) if numeric.is_integer() else numeric
    return None


def annual_history(rows, year):
    classes = [re.sub(r"\s+", "", row.get("stock_knd") or "") for row in rows]
    common = [row for row, label in zip(rows, classes)
              if label in ("보통주", "보통주식", "기명식보통주", "기명식보통주식", "의결권있는주식")]
    fields = ("thstrm", "frmtrm", "lwfr")
    if rows and not common and all(label in ("", "-") for label in classes):
        # Some single-class issuers leave both class labels blank and the second row empty.
        if all(all(number(row.get(field)) is None for field in fields) for row in rows[1:]):
            common = rows[:1]
    history = []
    if len(common) == 1:
        for offset, field in enumerate(fields):
            amount = number(common[0].get(field))
            if amount is not None:
                history.append({"year": year-offset, "amount": amount})
    return history


def annual_data(key, corp, today):
    for year in (today.year - 1, today.year - 2):
        resp = dart_json("alotMatter.json", key, corp_code=corp, bsns_year=year, reprt_code="11011")
        if resp["status"] == "013":
            continue
        rows = [r for r in resp.get("list", [])
                if "".join(r["se"].split()).replace("ㆍ", "") == "주당현금배당금(원)"]
        receipt = resp["list"][0]["rcept_no"]
        history = annual_history(rows, year)
        return {"history": history, "reportYear": year, "source": RECEIPT + receipt, "checkedOn": today.isoformat()}
    return None


def cash_notices(key, tickers, start, end):
    params = dict(corp_cls="Y", pblntf_ty="I", last_reprt_at="Y", page_count=100,
                  bgn_de=start.strftime("%Y%m%d"), end_de=end.strftime("%Y%m%d"))
    results = {}
    page = 1
    while True:
        res = dart_json("list.json", key, page_no=page, **params)
        for row in res.get("list", []):
            title = re.sub(r"[\s·ㆍ・]", "", row["report_nm"])
            code = row.get("stock_code")
            if (code in tickers and "현금현물배당결정" in title
                    and not any(term in title for term in ("자회사", "종속회사", "주요경영사항", "타법인"))):
                results.setdefault(code, []).append(row)
        if page >= int(res.get("total_page", 0)):
            return results
        page += 1


def iso_date(value):
    try:
        return date.fromisoformat(value.strip()).isoformat()
    except (ValueError, AttributeError):
        return None


def decision_data(row, today, calendar):
    receipt = row["rcept_no"]
    source = RECEIPT + receipt
    filed = date.fromisoformat(row["rcept_dt"]).isoformat()
    event = {"receipt": receipt, "source": source, "publishedOn": filed, "checkedOn": today.isoformat()}
    if any(s in row["report_nm"] or s in row.get("rm", "") for s in ("철회", "취소")) or "철" in row.get("rm", ""):
        return {**event, "unavailable": "철회 공시 · 원문 확인"}
    page = read_url(source).decode("utf-8")
    match = re.search(r'viewDoc\(\s*"' + receipt + r'"\s*,\s*"(\d+)"\s*,\s*"(\d+)"\s*,\s*"(\d+)"\s*,\s*"(\d+)"\s*,\s*"(HTML)"', page)
    if not match:
        raise ValueError("배당결정 공시 본문 연결 확인 필요")
    doc, element, offset, length, dtd = match.groups()
    url = "https://dart.fss.or.kr/report/viewer.do?" + urlencode(dict(rcpNo=receipt, dcmNo=doc,
              eleId=element, offset=offset, length=length, dtd=dtd))
    raw = read_url(url)
    try:
        body = raw.decode("utf-8")
    except UnicodeDecodeError:
        body = raw.decode("cp949")
    tree = html.fromstring(body)
    header = "".join(tree.xpath("//body")[0].itertext())
    header = re.sub(r"\s+", "", header).partition("배당구분")[0]
    if any(term in header for term in ("자회사", "종속회사", "주요경영사항", "타법인")):
        return None
    for tr in tree.xpath("//tr"):
        cells = [" ".join(" ".join(cell.itertext()).split()) for cell in tr.xpath("./th|./td")]
        if len(cells) < 2:
            continue
        label = re.sub(r"^(?:\d+\.|-)\s*", "", cells[0]).replace(" ", "")
        if label == "배당구분":
            event["period"] = cells[-1]
        elif label == "1주당배당금(원)" and len(cells) >= 3 and "보통주" in cells[1]:
            event["amount"] = number(cells[2])
        elif label == "배당기준일":
            event["recordDate"] = iso_date(cells[-1])
        elif label == "배당금지급예정일자":
            event["paymentDate"] = iso_date(cells[-1])
        elif label == "차등배당여부" and cells[-1].replace(" ", "") == "해당":
            event["differential"] = True
    if not event.get("period") or "recordDate" not in event:
        raise ValueError("배당결정 공시 양식 확인 필요")
    if event["recordDate"] and calendar is not None:
        day = date.fromisoformat(event["recordDate"])
        if calendar.first_session.date() <= day <= calendar.last_session.date():
            settlement = calendar.date_to_session(day.isoformat(), direction="previous")
            ex = calendar.previous_session(settlement)
            event.update(exDate=ex.date().isoformat(), lastBuyDate=calendar.previous_session(ex).date().isoformat(),
                         tradingSource=TRADING_RULE)
    return event
