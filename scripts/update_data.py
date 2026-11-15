
import json
from pathlib import Path

DATA_FILE = Path("data/stocks.json")

def main():
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)

    if DATA_FILE.exists():
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    else:
        data = {"updated": "데이터 연결 전", "stocks": []}

    # 실제 주가·배당 데이터 수집 기능은
    # 공식 데이터 공급원 연결 후 추가합니다.
    print("데이터 파일 확인 완료")
    print("현재 등록 종목:", len(data.get("stocks", [])))

if __name__ == "__main__":
    main()
