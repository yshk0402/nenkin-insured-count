#!/usr/bin/env python3
import argparse
import html
import json
import re
import sys
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urlencode

try:
    from curl_cffi import requests
except ImportError:
    print(
        json.dumps(
            {
                "error": "curl_cffi is required for --browser http-only. Install it with: python3 -m pip install curl_cffi"
            },
            ensure_ascii=False,
        ),
        file=sys.stderr,
    )
    sys.exit(2)


SEARCH_URL = "https://www.nenkin.go.jp/do/search_section/"
POST_URL = "https://www.nenkin.go.jp/do/search_section"


class PrefectureParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_prefecture_select = False
        self.in_option = False
        self.current_value = ""
        self.current_text = []
        self.options = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "select" and attrs.get("id") == "hdnPrefectureCode":
            self.in_prefecture_select = True
        elif self.in_prefecture_select and tag == "option":
            self.in_option = True
            self.current_value = attrs.get("value", "")
            self.current_text = []

    def handle_data(self, data):
        if self.in_option:
            self.current_text.append(data)

    def handle_endtag(self, tag):
        if self.in_prefecture_select and tag == "option":
            text = normalize_text("".join(self.current_text))
            self.options[text] = self.current_value
            self.in_option = False
            self.current_value = ""
            self.current_text = []
        elif self.in_prefecture_select and tag == "select":
            self.in_prefecture_select = False


def normalize_text(value):
    return re.sub(r"[ \t\r\n]+", " ", html.unescape(value or "").replace("\u00a0", " ")).strip()


def strip_tags(value):
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.I)
    value = re.sub(r"<script[\s\S]*?</script>", "", value, flags=re.I)
    value = re.sub(r"<style[\s\S]*?</style>", "", value, flags=re.I)
    value = re.sub(r"<[^>]+>", " ", value)
    return html.unescape(value)


def input_value(page_html, field_id, fallback=""):
    pattern = rf'id="{re.escape(field_id)}"[^>]*value="([^"]*)"'
    match = re.search(pattern, page_html)
    if match:
        return html.unescape(match.group(1))
    pattern = rf'name="{re.escape(field_id)}"[^>]*value="([^"]*)"'
    match = re.search(pattern, page_html)
    return html.unescape(match.group(1)) if match else fallback


def prefecture_code(page_html, prefecture):
    if not prefecture:
        return ""
    parser = PrefectureParser()
    parser.feed(page_html)
    if prefecture not in parser.options:
        raise ValueError(f"Unknown prefecture: {prefecture}")
    return parser.options[prefecture]


def build_post_data(page_html, args):
    search_criteria = "3" if args.corporate_number else "2" if args.kana else "1"
    office_name = "" if args.corporate_number else args.kana or args.name or ""
    fields = [
        ("cx", "017195973908334352974:7ey5fiy0xwe"),
        ("ie", "UTF-8"),
        ("q", ""),
        ("hdnPrefectureCode", prefecture_code(page_html, args.prefecture)),
        (
            "hdnSearchOffice",
            "2" if args.include_closed == "closed" else "3" if args.include_closed == "both" else "1",
        ),
        ("hdnSearchCriteria", search_criteria),
        ("txtOfficeName", office_name),
        ("txtOfficeAddress", "" if args.corporate_number else (args.address or "")),
        ("txtHoujinNo", args.corporate_number or ""),
        ("hdnDisplayItemsRestorationScreenDto", ""),
        (
            "hdnDisplayItemsRestorationScreenDtoKeepParam",
            input_value(page_html, "hdnDisplayItemsRestorationScreenDtoKeepParam", "false"),
        ),
        ("hdnTransactionToken", input_value(page_html, "hdnTransactionToken")),
        ("hdnTokenKeepParam", "true"),
        ("gmnId", input_value(page_html, "gmnId", "GB10001SC010")),
        ("hdnErrorFlg", ""),
        ("eventId", "/SEARCH.HTML"),
        ("/search.html", ""),
    ]
    return urlencode(fields)


def parse_insured_count(value):
    normalized = value.replace(",", "").strip()
    return int(normalized) if re.fullmatch(r"\d+", normalized) else None


def parse_table_rows(table_html):
    row_htmls = re.findall(r"<tr[\s\S]*?</tr>", table_html, flags=re.I)
    rows = []
    for row_html in row_htmls:
        cell_htmls = re.findall(r"<t[dh][^>]*>[\s\S]*?</t[dh]>", row_html, flags=re.I)
        cells = [normalize_text(strip_tags(cell_html)) for cell_html in cell_htmls]
        if len(cells) >= 8 and cells[0] != "事業所名称":
            rows.append(cells)
    return rows


def parse_result(page_html, query):
    text = normalize_text(strip_tags(page_html))
    data_updated_at_match = re.search(r"データ更新日：([0-9年月日]+)", text)
    count_text_match = re.search(r"([0-9,]+件が該当しました。)", text)
    tables = re.findall(r"<table[\s\S]*?</table>", page_html, flags=re.I)
    result_table = next((table for table in tables if "被保険者数" in normalize_text(strip_tags(table))), None)
    rows = parse_table_rows(result_table or "")
    return {
        "query": query,
        "searchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "dataUpdatedAt": data_updated_at_match.group(1) if data_updated_at_match else None,
        "countText": count_text_match.group(1) if count_text_match else None,
        "results": [
            {
                "officeName": row[0] if len(row) > 0 else "",
                "address": row[1] if len(row) > 1 else "",
                "corporateNumber": row[2] if len(row) > 2 else "",
                "expansionApplicable": row[3] if len(row) > 3 else "",
                "status": row[4] if len(row) > 4 else "",
                "pensionOffice": row[5] if len(row) > 5 else "",
                "appliedAt": row[6] if len(row) > 6 else "",
                "insuredCount": parse_insured_count(row[7] if len(row) > 7 else ""),
            }
            for row in rows
        ],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name")
    parser.add_argument("--kana")
    parser.add_argument("--address")
    parser.add_argument("--prefecture")
    parser.add_argument("--corporate-number")
    parser.add_argument("--include-closed", choices=["active", "closed", "both"], default="active")
    args = parser.parse_args()

    query = {
        "includeClosed": args.include_closed,
    }
    if args.name:
        query["name"] = args.name
    if args.kana:
        query["kanaName"] = args.kana
    if args.address:
        query["address"] = args.address
    if args.prefecture:
        query["prefecture"] = args.prefecture
    if args.corporate_number:
        query["corporateNumber"] = args.corporate_number

    session = requests.Session(impersonate="chrome")
    get_response = session.get(SEARCH_URL, timeout=30)
    if get_response.status_code != 200 or "hdnTransactionToken" not in get_response.text:
        raise RuntimeError(f"Could not open search page over HTTP. Status: {get_response.status_code}")

    post_response = session.post(
        POST_URL,
        data=build_post_data(get_response.text, args),
        headers={
            "content-type": "application/x-www-form-urlencoded",
            "origin": "https://www.nenkin.go.jp",
            "referer": SEARCH_URL,
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "accept-language": "ja,en-US;q=0.9,en;q=0.8",
        },
        timeout=30,
    )
    if post_response.status_code != 200:
        raise RuntimeError(f"Search POST failed over HTTP. Status: {post_response.status_code}")

    print(json.dumps(parse_result(post_response.text, query), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
