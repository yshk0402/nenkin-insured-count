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
nenkin batch companies.csv --out results.csv
nenkin resolve companies.csv --out corporate-numbers.csv
nenkin enrich companies.csv --out enriched.csv
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
npm run dev -- batch companies.csv --out results.csv
npm run dev -- resolve companies.csv --out corporate-numbers.csv
npm run dev -- enrich companies.csv --out enriched.csv
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

## まとめて検索する

会社名またはカナと、都道府県名を持つCSVを入力して、まとめて検索できます。

```csv
会社名,都道府県
トヨタ自動車,愛知県
ソニーグループ,東京都
```

```bash
nenkin batch companies.csv --out results.csv
```

カナ検索の場合:

```csv
カナ,都道府県
トヨタジドウシャ,愛知県
ソニーグループ,東京都
```

対応している入力列名:

- 会社名: `会社名`, `事業所名`, `name`, `companyName`, `company_name`, `officeName`
- カナ: `カナ`, `会社名カナ`, `事業所名カナ`, `kana`, `kanaName`, `kana_name`, `officeKana`
- 都道府県: `都道府県`, `都道府県名`, `prefecture`, `pref`
- 住所/所在地: `住所`, `所在地`, `address`

出力CSVには、入力値、検索ステータス、候補件数、推奨候補、法人番号、被保険者数、エラー内容が含まれます。

JSONで出力したい場合:

```bash
nenkin batch companies.csv --json
```

検索間隔を調整したい場合:

```bash
nenkin batch companies.csv --out results.csv --delay-ms 1000
```

## 法人番号を解決してから取得する

カナや短い会社名だけで年金機構側を検索すると、候補が多すぎて別法人を拾うことがあります。
`resolve` は国税庁の法人番号公表サイトで会社名/カナ、都道府県、住所から法人番号候補を先に特定します。

```csv
カナ,都道府県,住所
フィールドエックス,東京都,神泉町
スペース,東京都,中野区新井
```

```bash
nenkin resolve companies.csv --out corporate-numbers.csv
```

出力CSVには、法人番号、商号、所在地、confidence、判定理由が含まれます。
法人番号が確定した行について、そのまま年金機構側の被保険者数まで取得したい場合は `enrich` を使います。

```bash
nenkin enrich companies.csv --out enriched.csv
```

`enrich` は内部で `resolve` した法人番号を使って、既存の `nenkin --corp <13桁>` と同じ検索を実行します。

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
