
import os
import json
import urllib.parse
import urllib.request
from datetime import date

API_KEY = os.environ.get("OPENDART_API_KEY", "")

def fetch_dividend(corp_code, year):
    params = urllib.parse.urlencode({
        "crtfc_key": API_KEY,
        "corp_code": corp_code,
        "bsns_year": str(year),
        "reprt_code": "11011"
    })
    url = "https://opendart.fss.or.kr/api/alotMatter.json?" + params

    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)

def main():
    if not API_KEY:
        print("인증키가 등록되지 않았습니다.")
        return

    print("OpenDART 연결 시험 시작")

    try:
        # 삼성전자 기업 고유번호
        result = fetch_dividend("00126380", date.today().year - 1)
        print("응답 상태:", result.get("status"))
        print("응답 메시지:", result.get("message"))
        print("배당정보 건수:", len(result.get("list", [])))
    except Exception as error:
        print("데이터 수집 오류:", str(error))

if __name__ == "__main__":
    main()
