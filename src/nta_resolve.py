#!/usr/bin/env python3
import argparse
import html
import json
import re
import sys
from datetime import datetime, timezone
from html.parser import HTMLParser

try:
    from curl_cffi import requests
except ImportError:
    print(
        json.dumps(
            {
                "error": "curl_cffi is required. Install it with: python3 -m pip install curl_cffi"
            },
            ensure_ascii=False,
        ),
        file=sys.stderr,
    )
    sys.exit(2)


HOME_URL = "https://www.houjin-bangou.nta.go.jp/"
SEARCH_URL = "https://www.houjin-bangou.nta.go.jp/kensaku-kekka.html"
TOKEN_NAME = "jp.go.nta.houjin_bangou.framework.web.common.CNSFWTokenProcessor.request.token"


class SelectParser(HTMLParser):
    def __init__(self, select_id):
        super().__init__()
        self.select_id = select_id
        self.in_select = False
        self.in_option = False
        self.current_value = ""
        self.current_text = []
        self.options = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "select" and attrs.get("id") == self.select_id:
            self.in_select = True
        elif self.in_select and tag == "option":
            self.in_option = True
            self.current_value = attrs.get("value", "")
            self.current_text = []

    def handle_data(self, data):
        if self.in_option:
            self.current_text.append(data)

    def handle_endtag(self, tag):
        if self.in_select and tag == "option":
            text = normalize_text("".join(self.current_text))
            if text and text != "選択してください":
                self.options[text] = self.current_value
            self.in_option = False
            self.current_value = ""
            self.current_text = []
        elif self.in_select and tag == "select":
            self.in_select = False


def normalize_text(value):
    return re.sub(r"[ \t\r\n]+", " ", html.unescape(value or "").replace("\u00a0", " ")).strip()


def strip_tags(value):
    value = re.sub(r"<br\s*/?>", "\n", value or "", flags=re.I)
    value = re.sub(r"<script[\s\S]*?</script>", "", value, flags=re.I)
    value = re.sub(r"<style[\s\S]*?</style>", "", value, flags=re.I)
    value = re.sub(r"<[^>]+>", " ", value)
    return html.unescape(value)


def normalize_search(value):
    return (
        normalize_text(value)
        .replace("　", "")
        .replace(" ", "")
        .replace("東京都", "")
        .replace("道", "")
        .replace("府", "")
        .replace("県", "")
        .replace("番地", "")
        .replace("番", "")
        .replace("号", "")
        .translate(str.maketrans("０１２３４５６７８９－ー―−", "0123456789----"))
    )


def token_from(page_html):
    match = re.search(rf'name="{re.escape(TOKEN_NAME)}"[^>]*value="([^"]*)"', page_html)
    if not match:
        raise RuntimeError("Could not find NTA search token.")
    return html.unescape(match.group(1))


def select_options(page_html, select_id):
    parser = SelectParser(select_id)
    parser.feed(page_html)
    return parser.options


def looks_kana(value):
    return bool(value) and re.fullmatch(r"[\u30a0-\u30ff\u30fc\s　・･]+", value) is not None


def city_name_from_address(address, city_options):
    if not address:
        return None
    normalized_address = normalize_search(address)
    candidates = sorted(city_options.keys(), key=len, reverse=True)
    for city in candidates:
        if normalize_search(city) and normalize_search(city) in normalized_address:
            return city
    return None


def town_from_address(address, city_name):
    if not address or not city_name:
        return ""
    without_pref = normalize_text(address)
    for marker in ["都", "道", "府", "県"]:
        if marker in without_pref:
            without_pref = without_pref.split(marker, 1)[1]
            break
    return without_pref.replace(city_name, "", 1).strip()


def build_form(token, args, pref_code, city_code="", town=""):
    name = args.kana or args.name or ""
    use_kana = bool(args.kana) or looks_kana(args.name or "")
    form = {
        TOKEN_NAME: token,
        "houzinNmTxtf": name,
        "houzinNmShTypeRbtn": "1" if use_kana else "2",
        "_kanaCkbx": "on",
        "_noconvCkbx": "on",
        "_enCkbx": "on",
        "houzinAddrShTypeRbtn": "1",
        "prefectureLst": pref_code,
        "cityLst": city_code,
        "tyoumeTxtf": town,
        "houzinNoShTyoumeSts": "1" if town else "0",
        "houzinNoShSonotaZyoukenSts": "0",
        "_historyCkbx": "on",
        "_hideCkbx": "on",
        "closeCkbx": "1",
        "_closeCkbx": "on",
        "_chgYmdShTargetCkbx": "on",
        "chgYmdEyFromLst": "000",
        "chgYmdMFromLst": "00",
        "chgYmdDFromLst": "00",
        "chgYmdEyToLst": "000",
        "chgYmdMToLst": "00",
        "chgYmdDToLst": "00",
        "orderRbtn": "1",
        "searchFlg": "1",
        "preSyousaiScreenId": "KJSCR0101010",
        "viewNumAnc": "100",
        "viewPageNo": "1",
    }
    if use_kana:
        form["kanaCkbx"] = "3"
    return form


def parse_rows(page_html):
    rows = []
    table_match = re.search(r"<table[^>]*class=\"[^\"]*normal[^\"]*\"[\s\S]*?</table>", page_html, flags=re.I)
    if not table_match:
        return rows
    for row_html in re.findall(r"<tr[\s\S]*?</tr>", table_match.group(0), flags=re.I):
        cells = re.findall(r"<t[dh][^>]*>[\s\S]*?</t[dh]>", row_html, flags=re.I)
        if len(cells) < 4:
            continue
        number = normalize_text(strip_tags(cells[0]))
        if not re.fullmatch(r"\d{13}", number):
            continue
        kana_match = re.search(r'<div[^>]*class="furigana"[^>]*>([\s\S]*?)</div>', cells[1], flags=re.I)
        kana = normalize_text(strip_tags(kana_match.group(1))) if kana_match else ""
        name_cell = re.sub(r'<div[^>]*class="furigana"[^>]*>[\s\S]*?</div>', "", cells[1], flags=re.I)
        rows.append(
            {
                "corporateNumber": number,
                "name": normalize_text(strip_tags(name_cell)),
                "kana": kana,
                "address": normalize_text(strip_tags(cells[2])),
            }
        )
    return rows


def score_candidate(candidate, args):
    score = 0.0
    reasons = []
    query_name = args.kana or args.name or ""
    normalized_query = normalize_search(query_name)
    normalized_name = normalize_search(candidate["name"])
    normalized_kana = normalize_search(candidate["kana"])
    normalized_address = normalize_search(candidate["address"])
    normalized_input_address = normalize_search(args.address or "")

    if normalized_query and (normalized_query in normalized_kana or normalized_query in normalized_name):
        score += 0.3
        reasons.append("名称またはカナが一致しました")
    if args.prefecture and args.prefecture in candidate["address"]:
        score += 0.15
        reasons.append("都道府県が一致しました")
    if normalized_input_address and normalized_input_address in normalized_address:
        score += 0.45
        reasons.append("住所が一致しました")
    elif normalized_input_address:
        address_parts = [part for part in re.split(r"[、,/\s　]+", normalized_input_address) if part]
        if address_parts and all(part in normalized_address for part in address_parts):
            score += 0.35
            reasons.append("住所の主要語が一致しました")
    if normalized_query and (normalized_name == normalized_query or normalized_kana == normalized_query):
        score += 0.1
        reasons.append("名称が完全一致しました")
    return min(score, 1.0), reasons


def parse_count(page_html):
    text = normalize_text(strip_tags(page_html))
    match = re.search(r"([0-9,]+)件\s*見つかりました", text)
    return match.group(1) if match else None


def post_search(session, token, args, pref_code, city_code="", town=""):
    return session.post(
        SEARCH_URL,
        data=build_form(token, args, pref_code, city_code, town),
        headers={
            "referer": HOME_URL,
            "origin": "https://www.houjin-bangou.nta.go.jp",
            "content-type": "application/x-www-form-urlencoded",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "accept-language": "ja,en-US;q=0.9,en;q=0.8",
        },
        timeout=30,
    )


def resolve(args):
    session = requests.Session(impersonate="chrome")
    home = session.get(HOME_URL, timeout=30)
    if home.status_code != 200:
        raise RuntimeError(f"Could not open NTA search page. Status: {home.status_code}")

    token = token_from(home.text)
    prefectures = select_options(home.text, "addr_pref")
    pref_code = prefectures.get(args.prefecture or "")
    if args.prefecture and not pref_code:
        raise RuntimeError(f"Unknown prefecture: {args.prefecture}")

    first = post_search(session, token, args, pref_code or "")
    if first.status_code != 200:
        raise RuntimeError(f"NTA search failed. Status: {first.status_code}")

    search_html = first.text
    narrowed_by = []
    if args.address:
        city_options = select_options(first.text, "addr_city")
        city_name = city_name_from_address(args.address, city_options)
        if city_name:
            city_code = city_options[city_name]
            town = town_from_address(args.address, city_name)
            second = post_search(session, token_from(first.text), args, pref_code or "", city_code, town)
            if second.status_code == 200 and parse_rows(second.text):
                search_html = second.text
                narrowed_by = [city_name] + ([town] if town else [])

    candidates = parse_rows(search_html)
    for candidate in candidates:
        score, reasons = score_candidate(candidate, args)
        candidate["confidence"] = round(score, 3)
        candidate["reasons"] = reasons
    candidates.sort(key=lambda item: item["confidence"], reverse=True)

    top = candidates[0] if candidates else None
    second = candidates[1] if len(candidates) > 1 else None
    status = "no_results"
    if top:
        if top["confidence"] >= 0.85 and (second is None or top["confidence"] - second["confidence"] >= 0.1):
            status = "matched"
        elif top["confidence"] >= 0.75 and args.address and normalize_search(args.address) in normalize_search(top["address"]):
            status = "matched"
        else:
            status = "needs_review"

    return {
        "query": {
            "name": args.name,
            "kanaName": args.kana,
            "prefecture": args.prefecture,
            "address": args.address,
        },
        "searchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "nta-web",
        "status": status,
        "countText": parse_count(search_html),
        "narrowedBy": [value for value in narrowed_by if value],
        "recommended": top if status == "matched" else None,
        "candidates": candidates[: args.max_candidates],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name")
    parser.add_argument("--kana")
    parser.add_argument("--prefecture")
    parser.add_argument("--address")
    parser.add_argument("--max-candidates", type=int, default=20)
    args = parser.parse_args()
    if not args.name and not args.kana:
        raise RuntimeError("--name or --kana is required.")
    print(json.dumps(resolve(args), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
