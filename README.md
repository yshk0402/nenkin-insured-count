# nenkin-insured-count

[![npm version](https://img.shields.io/npm/v/nenkin-insured-count.svg)](https://www.npmjs.com/package/nenkin-insured-count)

日本年金機構の「厚生年金保険・健康保険 適用事業所検索システム」を利用するための調査・取得CLIです。

## 方針

- デフォルトではChromeを起動しません。
- `--browser http-only` は `curl_cffi` でChrome相当のHTTP fingerprintを使い、検索画面GETと検索POSTをHTTPだけで実行します。
- `--browser http-replay` では、Chromeで検索画面を開いて未使用トークンを取得し、検索POST自体はHTTPで再現します。Chromeを開かない方針では通常使いません。
- ヘッドレスChromiumは対象サイトで `403 Forbidden` になります。`visible` / `headless-new` / `cdp` は検証・フォールバック用です。
- 新しいChromeウィンドウを毎回立ち上げたくない場合は、専用ChromeをCDPで起動して `--browser cdp` で接続できます。
- 検索結果は表/JSON/CSVとして出力します。
- 法人番号、事業所名、カナ、都道府県、所在地を指定して検索できます。

## 使い方

インストールすると `nenkin` コマンドが有効になります。

```bash
npm install -g nenkin-insured-count
nenkin doctor
nenkin --corp 1180301018771
nenkin "トヨタ自動車" --pref 愛知県
nenkin --kana トヨタジドウシャ --pref 愛知県
```

ローカル開発で試す場合:

```bash
npm install
python3 -m pip install curl_cffi
npm run build

npm run dev -- "トヨタ自動車" --pref 愛知県
npm run dev -- --kana "トヨタ" --pref 愛知県
npm run dev -- --corp "1180301018771"
npm run dev -- "トヨタ自動車" --pref 愛知県 --csv
```

ビルド後に `npm link` すると、短い `nenkin` コマンドで使えます。

```bash
npm link
nenkin "トヨタ自動車" --pref 愛知県
nenkin --kana "トヨタ" --pref 愛知県
nenkin --corp 1180301018771
```

`npm install -g` / `npm link` 時に `curl_cffi` の自動セットアップを試します。CIなどでスキップしたい場合:

```bash
NENKIN_SKIP_PY_DEPS=1 npm install
```

デフォルトは人間が読みやすい表形式です。機械処理したい場合は `--json` または `--csv` を付けます。

```bash
npm run dev -- --corp "1180301018771" --json
npm run dev -- --corp "1180301018771" --csv
```

明示的にHTTP-onlyを指定する場合:

```bash
npm run dev -- --corp "1180301018771" --browser http-only
```

HTTP replay 実験モード:

```bash
npm run dev -- --corp "1180301018771" --browser http-replay
npm run dev -- "トヨタ自動車" --pref 愛知県 --browser http-replay
```

## Chromeを毎回立ち上げない使い方

別ターミナルで専用Chromeを起動します。

```bash
npm run chrome:cdp
```

そのままCLIから接続します。

```bash
npm run dev -- --corp "1180301018771" --browser cdp
```

CDP接続先を変える場合:

```bash
npm run dev -- --corp "1180301018771" --browser cdp --cdp-endpoint http://127.0.0.1:9222
```

## 出力

表出力では、候補一覧と推奨候補を表示します。

```text
検索結果: 1件が該当しました。
データ更新日: 2026年06月02日

#  事業所名                法人番号       被保険者数  状態  所在地
-  ----------------------  -------------  ----------  ----  ------------------
1  トヨタ自動車　株式会社  1180301018771  85,176      現存  豊田市トヨタ町　１

推奨候補: トヨタ自動車　株式会社
被保険者数: 85,176
理由: 法人番号が一致しました。
```

JSON出力には、検索条件、検索日時、データ更新日、候補事業所、被保険者数を含めます。

```json
{
  "query": {
    "name": "トヨタ自動車",
    "prefecture": "愛知県"
  },
  "searchedAt": "2026-07-02T00:00:00.000Z",
  "dataUpdatedAt": "2026年06月02日",
  "results": [
    {
      "officeName": "トヨタ自動車　株式会社",
      "address": "豊田市トヨタ町　１",
      "corporateNumber": "1180301018771",
      "insuredCount": 85176
    }
  ]
}
```

## 注意

このCLIは公開検索画面を人間の利用に近い速度で操作します。大量取得ではなく、法人・事業所を段階的に照合する用途を想定しています。
