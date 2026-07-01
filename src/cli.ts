#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Page } from "playwright";

type LookupQuery = {
  name?: string;
  kanaName?: string;
  address?: string;
  prefecture?: string;
  corporateNumber?: string;
  includeClosed: "active" | "closed" | "both";
};

type BrowserMode = "auto" | "http-only" | "visible" | "headless-new" | "cdp" | "http-replay";
type OutputFormat = "table" | "json" | "csv";

type NenkinResult = {
  officeName: string;
  address: string;
  corporateNumber: string;
  expansionApplicable: string;
  status: string;
  pensionOffice: string;
  appliedAt: string;
  insuredCount: number | null;
};

type LookupResponse = {
  query: LookupQuery;
  searchedAt: string;
  dataUpdatedAt: string | null;
  countText: string | null;
  results: NenkinResult[];
  sourceCountText?: string | null;
  clientSideFiltered?: boolean;
  partialResults?: boolean;
};

type BatchInputRow = {
  rowNumber: number;
  source: Record<string, string>;
  name?: string;
  kanaName?: string;
  prefecture?: string;
  address?: string;
};

type BatchOutputRow = {
  rowNumber: number;
  inputName: string;
  inputKana: string;
  inputPrefecture: string;
  inputAddress: string;
  status: "matched" | "no_results" | "multiple_results" | "error";
  resultCount: number;
  dataUpdatedAt: string;
  officeName: string;
  address: string;
  corporateNumber: string;
  officeStatus: string;
  insuredCount: string;
  error: string;
};

type ResolveCandidate = {
  corporateNumber: string;
  name: string;
  kana: string;
  address: string;
  confidence: number;
  reasons: string[];
};

type ResolveResponse = {
  query: {
    name?: string;
    kanaName?: string;
    prefecture?: string;
    address?: string;
  };
  searchedAt: string;
  source: string;
  status: "matched" | "needs_review" | "no_results";
  countText: string | null;
  narrowedBy: string[];
  recommended: ResolveCandidate | null;
  candidates: ResolveCandidate[];
};

type ResolveOutputRow = {
  rowNumber: number;
  inputName: string;
  inputKana: string;
  inputPrefecture: string;
  inputAddress: string;
  status: "matched" | "needs_review" | "no_results" | "error";
  resultCount: number;
  corporateNumber: string;
  corporateName: string;
  corporateKana: string;
  corporateAddress: string;
  confidence: string;
  reason: string;
  source: string;
  error: string;
};

type EnrichOutputRow = ResolveOutputRow & {
  dataUpdatedAt: string;
  officeName: string;
  officeAddress: string;
  officeStatus: string;
  insuredCount: string;
};

type ParsedPage = {
  dataUpdatedAt: string | null;
  countText: string | null;
  rows: Array<{
    officeName: string;
    address: string;
    corporateNumber: string;
    expansionApplicable: string;
    status: string;
    pensionOffice: string;
    appliedAt: string;
    insuredCountText: string;
  }>;
};

const SEARCH_URL = "https://www.nenkin.go.jp/do/search_section/";
const PREFECTURE_PLACEHOLDER = "選択してください";
const execFileAsync = promisify(execFile);
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const POSITIONAL_KEY = "__positionals";

function httpOnlyHelperPath() {
  const candidates = [
    join(CURRENT_DIR, "http_only.py"),
    join(CURRENT_DIR, "..", "src", "http_only.py"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Could not find http_only.py. Checked: ${candidates.join(", ")}`);
  }
  return found;
}

function ntaResolveHelperPath() {
  const candidates = [
    join(CURRENT_DIR, "nta_resolve.py"),
    join(CURRENT_DIR, "..", "src", "nta_resolve.py"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Could not find nta_resolve.py. Checked: ${candidates.join(", ")}`);
  }
  return found;
}

class BrowserBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserBlockedError";
  }
}

function exampleLines() {
  return [
    '  nenkin "トヨタ自動車" --pref 愛知県',
    '  nenkin --kana "トヨタ" --pref 愛知県',
    '  nenkin --corp 1180301018771',
    '  nenkin batch companies.csv --out results.csv',
    '  nenkin resolve --kana フィールドエックス --pref 東京都 --address 神泉町',
    '  nenkin resolve companies.csv --out corporate-numbers.csv',
    '  nenkin enrich --kana スペース --pref 東京都 --address 中野区新井',
    '  nenkin enrich companies.csv --out enriched.csv',
    '  nenkin lookup --name "トヨタ自動車" --prefecture "愛知県" --csv',
  ].join("\n");
}

function commandHint() {
  return `Use the lookup command before options.

Examples:
${exampleLines()}`;
}

function parseArgs(argv: string[]) {
  const [rawCommand, ...rawRest] = argv;
  const knownCommands = new Set(["lookup", "batch", "resolve", "enrich", "help", "doctor"]);
  const command =
    rawCommand == null
      ? undefined
      : knownCommands.has(rawCommand)
        ? rawCommand
        : rawCommand.startsWith("--")
          ? "lookup"
          : "lookup";
  const rest = rawCommand == null ? [] : knownCommands.has(rawCommand) ? rawRest : argv;
  const options = new Map<string, string | boolean>();
  const positionals: string[] = [];

  if (rawCommand === "--") {
    throw new Error(`Invalid option separator: --

Options should not contain a space after "--".

${commandHint()}`);
  }

  if (rawCommand === "--lookup") {
    throw new Error(`Unknown option: --lookup

Did you mean this?
  nenkin-insured-count lookup --name <事業所名>`);
  }

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--") {
      const maybeOption = rest[i + 1];
      const suggestion =
        maybeOption && /^[A-Za-z][\w-]*$/.test(maybeOption)
          ? `--${maybeOption}`
          : "--name";
      throw new Error(`Invalid option separator: --

Options should not contain a space after "--".
Did you mean ${suggestion}?

Example:
  nenkin-insured-count lookup ${suggestion} <value>`);
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const key = normalizeOptionKey(arg.slice(2));
    const next = rest[i + 1];
    if (next == null || next.startsWith("--")) {
      options.set(key, true);
    } else {
      options.set(key, next);
      i += 1;
    }
  }

  if (positionals.length > 0) {
    options.set(POSITIONAL_KEY, positionals.join(" "));
  }

  return { command, options };
}

function normalizeOptionKey(key: string) {
  const aliases: Record<string, string> = {
    corp: "corporate-number",
    corporate: "corporate-number",
    kana_name: "kana",
    pref: "prefecture",
  };
  return aliases[key] ?? key;
}

function getString(options: Map<string, string | boolean>, key: string) {
  const value = options.get(key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function buildQuery(options: Map<string, string | boolean>): LookupQuery {
  const includeClosed = getString(options, "include-closed");
  const positionalName = getString(options, POSITIONAL_KEY);
  if (positionalName && (options.has("name") || options.has("kana") || options.has("corporate-number"))) {
    throw new Error(`Unexpected positional argument: ${positionalName}

Use either a positional company name or explicit options, not both.

Examples:
${exampleLines()}`);
  }

  const name = getString(options, "name") ?? positionalName;
  const kanaName = getString(options, "kana");
  const corporateNumber = getString(options, "corporate-number");
  const searchModeCount = [name, kanaName, corporateNumber].filter(Boolean).length;
  if (searchModeCount > 1) {
    throw new Error(`Use only one search mode: company name, --kana, or --corp.

Examples:
${exampleLines()}`);
  }

  const query: LookupQuery = {
    name,
    kanaName,
    address: getString(options, "address"),
    prefecture: getString(options, "prefecture"),
    corporateNumber,
    includeClosed:
      includeClosed === "closed" || includeClosed === "both" ? includeClosed : "active",
  };

  if (!query.corporateNumber && !query.name && !query.kanaName) {
    throw new Error(`Either --corp, --name, --kana, or a positional company name is required.

Examples:
${exampleLines()}`);
  }

  if (query.corporateNumber && !/^\d{13}$/.test(query.corporateNumber)) {
    throw new Error("--corporate-number must be 13 digits.");
  }

  return query;
}

function getBrowserMode(options: Map<string, string | boolean>): BrowserMode {
  const browser = getString(options, "browser") ?? "auto";
  if (
    browser === "auto" ||
    browser === "http-only" ||
    browser === "visible" ||
    browser === "headless-new" ||
    browser === "cdp" ||
    browser === "http-replay"
  ) {
    return browser;
  }
  throw new Error("--browser must be auto, http-only, visible, headless-new, cdp, or http-replay.");
}

function getOutputFormat(options: Map<string, string | boolean>): OutputFormat {
  if (options.has("json") && options.has("csv")) {
    throw new Error("Use either --json or --csv, not both.");
  }
  if (options.has("json")) {
    return "json";
  }
  if (options.has("csv")) {
    return "csv";
  }

  const format = getString(options, "format") ?? "table";
  if (format === "table" || format === "json" || format === "csv") {
    return format;
  }
  throw new Error("--format must be table, json, or csv.");
}

function getBatchInputPath(options: Map<string, string | boolean>) {
  const input = getString(options, "input") ?? getString(options, POSITIONAL_KEY);
  if (!input) {
    throw new Error(`Batch input CSV is required.

Example:
  nenkin batch companies.csv --out results.csv`);
  }
  return input;
}

function getDelayMs(options: Map<string, string | boolean>) {
  const raw = getString(options, "delay-ms");
  if (!raw) {
    return 500;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("--delay-ms must be a non-negative number.");
  }
  return value;
}

async function selectSearchMode(page: Page, query: LookupQuery) {
  if (query.corporateNumber) {
    await page.locator("#hdnSearchCriteria3").check({ force: true });
    await page.evaluate("window.changeDisabled && window.changeDisabled()");
    await page.locator("#txtHoujinNo").fill(query.corporateNumber ?? "");
    return;
  }

  await page.locator(query.kanaName ? "#hdnSearchCriteria2" : "#hdnSearchCriteria1").check({ force: true });
  await page.evaluate("window.changeDisabled && window.changeDisabled()");
  await page.locator("#txtOfficeName").fill(query.kanaName ?? query.name ?? "");

  if (query.address) {
    await page.locator("#txtOfficeAddress").fill(query.address);
  }
}

async function selectOfficeStatus(page: Page, includeClosed: LookupQuery["includeClosed"]) {
  const id =
    includeClosed === "closed"
      ? "#hdnSearchOffice2"
      : includeClosed === "both"
        ? "#hdnSearchOffice3"
        : "#hdnSearchOffice1";
  await page.locator(id).check({ force: true });
}

async function selectPrefecture(page: Page, prefecture: string | undefined) {
  if (!prefecture || prefecture === PREFECTURE_PLACEHOLDER) {
    return;
  }

  await page.locator("#hdnPrefectureCode").selectOption({ label: prefecture });
}

async function lookup(
  query: LookupQuery,
  browserMode: BrowserMode,
  options: Map<string, string | boolean>,
): Promise<LookupResponse> {
  const remoteQuery = buildRemoteQuery(query);
  let response: LookupResponse;
  if (browserMode === "auto") {
    response = await lookupWithHttpOnly(remoteQuery);
  } else if (browserMode === "cdp") {
    response = await lookupWithCdp(remoteQuery, getString(options, "cdp-endpoint") ?? "http://127.0.0.1:9222");
  } else if (browserMode === "http-only") {
    response = await lookupWithHttpOnly(remoteQuery);
  } else if (browserMode === "http-replay") {
    response = await lookupWithHttpReplay(remoteQuery);
  } else {
    response = await lookupWithLaunchedChrome(remoteQuery, browserMode);
  }

  return applyClientSideFilters(response, query);
}

function buildRemoteQuery(query: LookupQuery): LookupQuery {
  if (query.kanaName && query.address) {
    const kanaAddress = toKanaAddressSearchTerm(query.address);
    return {
      ...query,
      address: kanaAddress,
    };
  }
  return query;
}

function applyClientSideFilters(response: LookupResponse, originalQuery: LookupQuery): LookupResponse {
  const address = normalizeSearchText(originalQuery.address ?? "");
  if (!address) {
    return {
      ...response,
      query: originalQuery,
    };
  }

  const results = response.results.filter((result) => normalizeSearchText(result.address).includes(address));
  const sourceTotal = parseCountText(response.countText);
  const partialResults = sourceTotal == null ? false : sourceTotal > response.results.length;

  return {
    ...response,
    query: originalQuery,
    sourceCountText: response.countText,
    countText: `${results.length}件が該当しました。`,
    results,
    clientSideFiltered: true,
    partialResults,
  };
}

async function lookupWithHttpOnly(query: LookupQuery): Promise<LookupResponse> {
  const args = [httpOnlyHelperPath(), "--include-closed", query.includeClosed];
  if (query.name) {
    args.push("--name", query.name);
  }
  if (query.kanaName) {
    args.push("--kana", query.kanaName);
  }
  if (query.address) {
    args.push("--address", query.address);
  }
  if (query.prefecture) {
    args.push("--prefecture", query.prefecture);
  }
  if (query.corporateNumber) {
    args.push("--corporate-number", query.corporateNumber);
  }

  try {
    const { stdout } = await execFileAsync("python3", args, {
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout) as LookupResponse;
  } catch (error) {
    const stderr = typeof error === "object" && error != null && "stderr" in error ? String(error.stderr) : "";
    const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`HTTP-only lookup failed. ${message}`);
  }
}

async function lookupWithLaunchedChrome(
  query: LookupQuery,
  browserMode: Exclude<BrowserMode, "auto" | "cdp">,
): Promise<LookupResponse> {
  const context = await chromium.launchPersistentContext("playwright-profile", {
    channel: "chrome",
    headless: false,
    args: browserMode === "headless-new" ? ["--headless=new"] : [],
  });

  try {
    return await runLookupInContext(context, query, browserMode);
  } finally {
    await context.close();
  }
}

async function lookupWithCdp(query: LookupQuery, endpoint: string): Promise<LookupResponse> {
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect to Chrome CDP at ${endpoint}.

Start a dedicated Chrome first:
  npm run chrome:cdp

Then run:
  npm run dev -- lookup --corporate-number 1180301018771 --browser cdp

Original error:
${detail}`);
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();

  try {
    return await runLookupOnPage(page, query, "cdp");
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function lookupWithHttpReplay(query: LookupQuery): Promise<LookupResponse> {
  const context = await chromium.launchPersistentContext("playwright-profile", {
    channel: "chrome",
    headless: false,
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(SEARCH_URL, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(300);
    await assertSearchPageAvailable(page, "http-replay");

    const postData = await buildPostDataFromPage(page, query);
    const response = await context.request.post("https://www.nenkin.go.jp/do/search_section", {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://www.nenkin.go.jp",
        referer: SEARCH_URL,
        "user-agent": await page.evaluate("navigator.userAgent"),
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "accept-language": "ja,en-US;q=0.9,en;q=0.8",
      },
      data: postData,
    });
    const html = await response.text();
    if (response.status() !== 200) {
      throw new Error(`HTTP replay failed with status ${response.status()}.`);
    }
    return parseResultHtml(html, query);
  } finally {
    await context.close();
  }
}

async function buildPostDataFromPage(page: Page, query: LookupQuery) {
  return await page.evaluate(
    ({ query: serializedQuery }) => {
      const query = serializedQuery as LookupQuery;
      const form = document.querySelector("form#GB10001SC010Dto") as HTMLFormElement | null;
      if (!form) {
        throw new Error("Nenkin search form was not found.");
      }

      const params = new URLSearchParams();
      for (const element of Array.from(form.elements)) {
        const field = element as HTMLInputElement | HTMLSelectElement | HTMLButtonElement;
        if (!field.name || field.disabled) {
          continue;
        }
        if (
          (field instanceof HTMLInputElement && field.type === "radio" && !field.checked) ||
          (field instanceof HTMLInputElement && field.type === "checkbox" && !field.checked)
        ) {
          continue;
        }
        params.append(field.name, field.value ?? "");
      }

      params.set(
        "hdnSearchOffice",
        query.includeClosed === "closed" ? "2" : query.includeClosed === "both" ? "3" : "1",
      );

      if (query.corporateNumber) {
        params.set("hdnSearchCriteria", "3");
        params.set("txtHoujinNo", query.corporateNumber);
        params.set("txtOfficeName", "");
        params.set("txtOfficeAddress", "");
      } else {
        params.set("hdnSearchCriteria", query.kanaName ? "2" : "1");
        params.set("txtOfficeName", query.kanaName ?? query.name ?? "");
        params.set("txtOfficeAddress", query.address ?? "");
        params.set("txtHoujinNo", "");
      }

      if (query.prefecture) {
        const select = form.querySelector("#hdnPrefectureCode") as HTMLSelectElement | null;
        const option = Array.from(select?.options ?? []).find((item) => item.text === query.prefecture);
        if (!option) {
          throw new Error(`Unknown prefecture: ${query.prefecture}`);
        }
        params.set("hdnPrefectureCode", option.value);
      }

      params.set("eventId", "/SEARCH.HTML");
      params.set("hdnTokenKeepParam", "true");
      params.set("/search.html", "");
      return params.toString();
    },
    { query },
  );
}

async function runLookupInContext(
  context: BrowserContext,
  query: LookupQuery,
  browserMode: Exclude<BrowserMode, "auto">,
) {
  const page = context.pages()[0] ?? (await context.newPage());
  return await runLookupOnPage(page, query, browserMode);
}

async function runLookupOnPage(
  page: Page,
  query: LookupQuery,
  browserMode: Exclude<BrowserMode, "auto">,
): Promise<LookupResponse> {
  await page.goto(SEARCH_URL, { waitUntil: "load", timeout: 30_000 });
  await page.waitForTimeout(300);
  await assertSearchPageAvailable(page, browserMode);

  await selectPrefecture(page, query.prefecture);
  await selectOfficeStatus(page, query.includeClosed);
  await selectSearchMode(page, query);

  await page.locator("#search").click();
  await page.waitForLoadState("load", { timeout: 30_000 });

  return await parseResultPage(page, query);
}

async function assertSearchPageAvailable(page: Page, browserMode: Exclude<BrowserMode, "auto">) {
  const title = await page.title();
  const searchButtonCount = await page.locator("#search").count();
  if (title.includes("403") || searchButtonCount === 0) {
    throw new BrowserBlockedError(
      `${browserMode} could not open the search page. Title: ${title || "(no title)"}`,
    );
  }
}

async function parseResultPage(page: Page, query: LookupQuery): Promise<LookupResponse> {
  const parsed = (await page.evaluate(`(() => {
    const normalize = (text) =>
      (text ?? "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
    const dataUpdatedAt =
      normalize(document.body.textContent).match(/データ更新日：([0-9年月日]+)/)?.[1] ?? null;
    const main = document.querySelector("main#CONT");
    const countText =
      normalize(main?.textContent).match(/([0-9,]+件が該当しました。)/)?.[1] ?? null;
    const tables = Array.from(main?.querySelectorAll("table") ?? []);
    const resultTable = tables.find((table) =>
      normalize(table.textContent).includes("被保険者数"),
    );

    if (!resultTable) {
      return { dataUpdatedAt, countText, rows: [] };
    }

    const rows = Array.from(resultTable.querySelectorAll("tr"))
      .map((tr) => Array.from(tr.children).map((cell) => normalize(cell.textContent)))
      .filter((cells) => cells.length >= 8 && cells[0] !== "事業所名称")
      .map((cells) => ({
        officeName: cells[0] ?? "",
        address: cells[1] ?? "",
        corporateNumber: cells[2] ?? "",
        expansionApplicable: cells[3] ?? "",
        status: cells[4] ?? "",
        pensionOffice: cells[5] ?? "",
        appliedAt: cells[6] ?? "",
        insuredCountText: cells[7] ?? "",
      }));

    return { dataUpdatedAt, countText, rows };
  })()`)) as ParsedPage;

  return {
    query,
    searchedAt: new Date().toISOString(),
    dataUpdatedAt: parsed.dataUpdatedAt,
    countText: parsed.countText,
    results: parsed.rows.map((row) => ({
      officeName: row.officeName,
      address: row.address,
      corporateNumber: row.corporateNumber,
      expansionApplicable: row.expansionApplicable,
      status: row.status,
      pensionOffice: row.pensionOffice,
      appliedAt: row.appliedAt,
      insuredCount: parseInsuredCount(row.insuredCountText),
    })),
  };
}

function parseResultHtml(html: string, query: LookupQuery): LookupResponse {
  const text = normalizeText(stripTags(html));
  const dataUpdatedAt = text.match(/データ更新日：([0-9年月日]+)/)?.[1] ?? null;
  const countText = text.match(/([0-9,]+件が該当しました。)/)?.[1] ?? null;
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  const resultTable = tables.find((table) => normalizeText(stripTags(table)).includes("被保険者数"));
  const rows = resultTable == null ? [] : parseHtmlTableRows(resultTable);

  return {
    query,
    searchedAt: new Date().toISOString(),
    dataUpdatedAt,
    countText,
    results: rows.map((row) => ({
      officeName: row[0] ?? "",
      address: row[1] ?? "",
      corporateNumber: row[2] ?? "",
      expansionApplicable: row[3] ?? "",
      status: row[4] ?? "",
      pensionOffice: row[5] ?? "",
      appliedAt: row[6] ?? "",
      insuredCount: parseInsuredCount(row[7] ?? ""),
    })),
  };
}

function parseHtmlTableRows(tableHtml: string) {
  const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  return rowMatches
    .map((rowHtml) => {
      const cellMatches = rowHtml.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? [];
      return cellMatches.map((cellHtml) => normalizeText(stripTags(cellHtml)));
    })
    .filter((cells) => cells.length >= 8 && cells[0] !== "事業所名称");
}

function stripTags(html: string) {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " "),
  );
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeText(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/[ \t\r\n]+/g, " ").trim();
}

function parseInsuredCount(value: string) {
  const normalized = value.replace(/,/g, "").trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  return Number(normalized);
}

function toCsv(response: LookupResponse) {
  const header = [
    "searchedAt",
    "dataUpdatedAt",
    "queryName",
    "queryKana",
    "queryPrefecture",
    "queryCorporateNumber",
    "officeName",
    "address",
    "corporateNumber",
    "expansionApplicable",
    "status",
    "pensionOffice",
    "appliedAt",
    "insuredCount",
  ];
  const rows = response.results.map((result) => [
    response.searchedAt,
    response.dataUpdatedAt ?? "",
    response.query.name ?? "",
    response.query.kanaName ?? "",
    response.query.prefecture ?? "",
    response.query.corporateNumber ?? "",
    result.officeName,
    result.address,
    result.corporateNumber,
    result.expansionApplicable,
    result.status,
    result.pensionOffice,
    result.appliedAt,
    result.insuredCount == null ? "" : String(result.insuredCount),
  ]);

  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

async function runBatch(options: Map<string, string | boolean>) {
  const inputPath = getBatchInputPath(options);
  const browserMode = getBrowserMode(options);
  const format = getOutputFormat(options);
  const outPath = getString(options, "out");
  const delayMs = getDelayMs(options);
  const includeClosed = getString(options, "include-closed");
  const defaultIncludeClosed =
    includeClosed === "closed" || includeClosed === "both" ? includeClosed : "active";
  const content = await readFile(inputPath, "utf8");
  const inputRows = parseBatchInput(content);
  const outputRows: BatchOutputRow[] = [];

  for (const [index, row] of inputRows.entries()) {
    const label = row.name ?? row.kanaName ?? `row ${row.rowNumber}`;
    process.stderr.write(`[${index + 1}/${inputRows.length}] ${label}\n`);

    if (!row.prefecture) {
      outputRows.push(toBatchErrorRow(row, "都道府県が空です。"));
      continue;
    }
    if (!row.name && !row.kanaName) {
      outputRows.push(toBatchErrorRow(row, "会社名またはカナが空です。"));
      continue;
    }

    const query: LookupQuery = {
      name: row.name,
      kanaName: row.kanaName,
      address: row.address,
      prefecture: row.prefecture,
      includeClosed: defaultIncludeClosed,
    };

    try {
      const response = await lookup(query, browserMode, options);
      outputRows.push(toBatchOutputRow(row, response));
    } catch (error) {
      outputRows.push(toBatchErrorRow(row, error instanceof Error ? error.message : String(error)));
    }

    if (delayMs > 0 && index < inputRows.length - 1) {
      await sleep(delayMs);
    }
  }

  const output =
    format === "json"
      ? JSON.stringify(outputRows, null, 2)
      : toBatchCsv(outputRows);
  if (outPath) {
    await writeFile(outPath, `${output}\n`, "utf8");
    process.stderr.write(`wrote: ${outPath}\n`);
  } else {
    console.log(output);
  }
}

async function runResolve(options: Map<string, string | boolean>) {
  const format = getOutputFormat(options);
  const outPath = getString(options, "out");
  const delayMs = getDelayMs(options);
  const inputRows = await getResolveInputRows(options);
  const outputRows: ResolveOutputRow[] = [];
  const isSingle = inputRows.length === 1 && inputRows[0]?.rowNumber === 1;

  for (const [index, row] of inputRows.entries()) {
    const label = row.kanaName ?? row.name ?? `row ${row.rowNumber}`;
    process.stderr.write(`[${index + 1}/${inputRows.length}] resolve ${label}\n`);

    if (!row.prefecture) {
      outputRows.push(toResolveErrorRow(row, "都道府県が空です。"));
      continue;
    }
    if (!row.name && !row.kanaName) {
      outputRows.push(toResolveErrorRow(row, "会社名またはカナが空です。"));
      continue;
    }

    try {
      const response = await resolveCorporateNumber(row);
      outputRows.push(toResolveOutputRow(row, response));
    } catch (error) {
      outputRows.push(toResolveErrorRow(row, error instanceof Error ? error.message : String(error)));
    }

    if (delayMs > 0 && index < inputRows.length - 1) {
      await sleep(delayMs);
    }
  }

  await writeStructuredOutput(outputRows, format, outPath, toResolveCsv, isSingle ? toResolveTable : undefined);
}

async function runEnrich(options: Map<string, string | boolean>) {
  const browserMode = getBrowserMode(options);
  const format = getOutputFormat(options);
  const outPath = getString(options, "out");
  const delayMs = getDelayMs(options);
  const includeClosed = getString(options, "include-closed");
  const defaultIncludeClosed =
    includeClosed === "closed" || includeClosed === "both" ? includeClosed : "active";
  const inputRows = await getResolveInputRows(options);
  const outputRows: EnrichOutputRow[] = [];
  const isSingle = inputRows.length === 1 && inputRows[0]?.rowNumber === 1;

  for (const [index, row] of inputRows.entries()) {
    const label = row.kanaName ?? row.name ?? `row ${row.rowNumber}`;
    process.stderr.write(`[${index + 1}/${inputRows.length}] enrich ${label}\n`);

    if (!row.prefecture) {
      outputRows.push(toEnrichErrorRow(row, "都道府県が空です。"));
      continue;
    }
    if (!row.name && !row.kanaName) {
      outputRows.push(toEnrichErrorRow(row, "会社名またはカナが空です。"));
      continue;
    }

    try {
      const resolveResponse = await resolveCorporateNumber(row);
      const resolveRow = toResolveOutputRow(row, resolveResponse);
      if (resolveRow.status !== "matched" || !resolveRow.corporateNumber) {
        outputRows.push({
          ...resolveRow,
          dataUpdatedAt: "",
          officeName: "",
          officeAddress: "",
          officeStatus: "",
          insuredCount: "",
        });
      } else {
        const lookupResponse = await lookup(
          {
            corporateNumber: resolveRow.corporateNumber,
            includeClosed: defaultIncludeClosed,
          },
          browserMode,
          options,
        );
        const office = pickRecommended(lookupResponse) ?? lookupResponse.results[0] ?? null;
        outputRows.push({
          ...resolveRow,
          dataUpdatedAt: lookupResponse.dataUpdatedAt ?? "",
          officeName: office?.officeName ?? "",
          officeAddress: office?.address ?? "",
          officeStatus: office?.status ?? "",
          insuredCount: office?.insuredCount == null ? "" : String(office.insuredCount),
        });
      }
    } catch (error) {
      outputRows.push(toEnrichErrorRow(row, error instanceof Error ? error.message : String(error)));
    }

    if (delayMs > 0 && index < inputRows.length - 1) {
      await sleep(delayMs);
    }
  }

  await writeStructuredOutput(outputRows, format, outPath, toEnrichCsv, isSingle ? toEnrichTable : undefined);
}

async function resolveCorporateNumber(row: BatchInputRow): Promise<ResolveResponse> {
  const args = [ntaResolveHelperPath(), "--prefecture", row.prefecture ?? ""];
  if (row.name) {
    args.push("--name", row.name);
  }
  if (row.kanaName) {
    args.push("--kana", row.kanaName);
  }
  if (row.address) {
    args.push("--address", row.address);
  }

  try {
    const { stdout } = await execFileAsync("python3", args, {
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout) as ResolveResponse;
  } catch (error) {
    const stderr = typeof error === "object" && error != null && "stderr" in error ? String(error.stderr) : "";
    const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`Corporate number resolve failed. ${message}`);
  }
}

async function writeStructuredOutput<T>(
  rows: T[],
  format: OutputFormat,
  outPath: string | undefined,
  csvFormatter: (rows: T[]) => string,
  tableFormatter?: (rows: T[]) => string,
) {
  const output =
    format === "json"
      ? JSON.stringify(rows, null, 2)
      : format === "table" && tableFormatter
        ? tableFormatter(rows)
        : csvFormatter(rows);
  if (outPath) {
    await writeFile(outPath, `${output}\n`, "utf8");
    process.stderr.write(`wrote: ${outPath}\n`);
  } else {
    console.log(output);
  }
}

async function getResolveInputRows(options: Map<string, string | boolean>) {
  if (isInlineResolveInput(options)) {
    return [buildInlineResolveRow(options)];
  }

  const inputPath = getBatchInputPath(options);
  const content = await readFile(inputPath, "utf8");
  return parseBatchInput(content);
}

function isInlineResolveInput(options: Map<string, string | boolean>) {
  return (
    options.has("name") ||
    options.has("kana") ||
    ((options.has("prefecture") || options.has("address")) && options.has(POSITIONAL_KEY))
  );
}

function buildInlineResolveRow(options: Map<string, string | boolean>): BatchInputRow {
  const positionalName = getString(options, POSITIONAL_KEY);
  if (positionalName && (options.has("name") || options.has("kana"))) {
    throw new Error(`Unexpected positional argument: ${positionalName}

Use either a positional company name or explicit --name/--kana, not both.

Examples:
  nenkin resolve フィールドエックス --pref 東京都 --address 神泉町
  nenkin resolve --kana フィールドエックス --pref 東京都 --address 神泉町`);
  }

  const name = getString(options, "name") ?? (options.has("kana") ? undefined : positionalName);
  const kanaName = getString(options, "kana");
  const prefecture = getString(options, "prefecture");
  const address = getString(options, "address");

  if (!name && !kanaName) {
    throw new Error(`Either --name, --kana, or a positional company name is required.

Examples:
  nenkin resolve フィールドエックス --pref 東京都 --address 神泉町
  nenkin enrich --kana スペース --pref 東京都 --address 中野区新井`);
  }

  return {
    rowNumber: 1,
    source: {},
    name,
    kanaName,
    prefecture,
    address,
  };
}

function parseBatchInput(content: string): BatchInputRow[] {
  const rows = parseCsv(content);
  if (rows.length === 0) {
    return [];
  }
  const [header, ...body] = rows;
  if (!header || header.length === 0) {
    return [];
  }
  return body
    .filter((cells) => cells.some((cell) => cell.trim() !== ""))
    .map((cells, index) => {
      const source = Object.fromEntries(header.map((name, columnIndex) => [name.trim(), cells[columnIndex]?.trim() ?? ""]));
      return {
        rowNumber: index + 2,
        source,
        name: pickColumn(source, ["name", "companyName", "company_name", "officeName", "会社名", "事業所名"]),
        kanaName: pickColumn(source, ["kana", "kanaName", "kana_name", "officeKana", "カナ", "会社名カナ", "事業所名カナ"]),
        prefecture: pickColumn(source, ["prefecture", "pref", "都道府県", "都道府県名"]),
        address: pickColumn(source, ["address", "住所", "所在地"]),
      };
    });
}

function parseCsv(content: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function pickColumn(source: Record<string, string>, names: string[]) {
  for (const name of names) {
    const value = source[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function toBatchOutputRow(row: BatchInputRow, response: LookupResponse): BatchOutputRow {
  const recommended = pickRecommended(response);
  const candidate = recommended ?? response.results[0] ?? null;
  const status =
    response.results.length === 0
      ? "no_results"
      : isPartialClientSideFilter(response)
        ? "multiple_results"
        : response.results.length === 1 || recommended
        ? "matched"
        : "multiple_results";
  return {
    rowNumber: row.rowNumber,
    inputName: row.name ?? "",
    inputKana: row.kanaName ?? "",
    inputPrefecture: row.prefecture ?? "",
    inputAddress: row.address ?? "",
    status,
    resultCount: response.results.length,
    dataUpdatedAt: response.dataUpdatedAt ?? "",
    officeName: candidate?.officeName ?? "",
    address: candidate?.address ?? "",
    corporateNumber: candidate?.corporateNumber ?? "",
    officeStatus: candidate?.status ?? "",
    insuredCount: candidate?.insuredCount == null ? "" : String(candidate.insuredCount),
    error: "",
  };
}

function toBatchErrorRow(row: BatchInputRow, error: string): BatchOutputRow {
  return {
    rowNumber: row.rowNumber,
    inputName: row.name ?? "",
    inputKana: row.kanaName ?? "",
    inputPrefecture: row.prefecture ?? "",
    inputAddress: row.address ?? "",
    status: "error",
    resultCount: 0,
    dataUpdatedAt: "",
    officeName: "",
    address: "",
    corporateNumber: "",
    officeStatus: "",
    insuredCount: "",
    error,
  };
}

function toResolveOutputRow(row: BatchInputRow, response: ResolveResponse): ResolveOutputRow {
  const candidate = response.recommended ?? response.candidates[0] ?? null;
  return {
    rowNumber: row.rowNumber,
    inputName: row.name ?? "",
    inputKana: row.kanaName ?? "",
    inputPrefecture: row.prefecture ?? "",
    inputAddress: row.address ?? "",
    status: response.status,
    resultCount: response.candidates.length,
    corporateNumber: candidate?.corporateNumber ?? "",
    corporateName: candidate?.name ?? "",
    corporateKana: candidate?.kana ?? "",
    corporateAddress: candidate?.address ?? "",
    confidence: candidate == null ? "" : String(candidate.confidence),
    reason: candidate?.reasons.join(" / ") ?? "",
    source: response.source,
    error: "",
  };
}

function toResolveErrorRow(row: BatchInputRow, error: string): ResolveOutputRow {
  return {
    rowNumber: row.rowNumber,
    inputName: row.name ?? "",
    inputKana: row.kanaName ?? "",
    inputPrefecture: row.prefecture ?? "",
    inputAddress: row.address ?? "",
    status: "error",
    resultCount: 0,
    corporateNumber: "",
    corporateName: "",
    corporateKana: "",
    corporateAddress: "",
    confidence: "",
    reason: "",
    source: "nta-web",
    error,
  };
}

function toEnrichErrorRow(row: BatchInputRow, error: string): EnrichOutputRow {
  return {
    ...toResolveErrorRow(row, error),
    dataUpdatedAt: "",
    officeName: "",
    officeAddress: "",
    officeStatus: "",
    insuredCount: "",
  };
}

function toBatchCsv(rows: BatchOutputRow[]) {
  const header: Array<keyof BatchOutputRow> = [
    "rowNumber",
    "inputName",
    "inputKana",
    "inputPrefecture",
    "inputAddress",
    "status",
    "resultCount",
    "dataUpdatedAt",
    "officeName",
    "address",
    "corporateNumber",
    "officeStatus",
    "insuredCount",
    "error",
  ];
  return [
    header,
    ...rows.map((row) => header.map((key) => String(row[key]))),
  ]
    .map((line) => line.map(csvEscape).join(","))
    .join("\n");
}

function toResolveCsv(rows: ResolveOutputRow[]) {
  const header: Array<keyof ResolveOutputRow> = [
    "rowNumber",
    "inputName",
    "inputKana",
    "inputPrefecture",
    "inputAddress",
    "status",
    "resultCount",
    "corporateNumber",
    "corporateName",
    "corporateKana",
    "corporateAddress",
    "confidence",
    "reason",
    "source",
    "error",
  ];
  return rowsToCsv(header, rows);
}

function toEnrichCsv(rows: EnrichOutputRow[]) {
  const header: Array<keyof EnrichOutputRow> = [
    "rowNumber",
    "inputName",
    "inputKana",
    "inputPrefecture",
    "inputAddress",
    "status",
    "resultCount",
    "corporateNumber",
    "corporateName",
    "corporateKana",
    "corporateAddress",
    "confidence",
    "reason",
    "source",
    "dataUpdatedAt",
    "officeName",
    "officeAddress",
    "officeStatus",
    "insuredCount",
    "error",
  ];
  return rowsToCsv(header, rows);
}

function toResolveTable(rows: ResolveOutputRow[]) {
  const row = rows[0];
  if (!row) {
    return "No result.";
  }
  const lines = [
    `resolve: ${row.status}`,
    `入力: ${row.inputKana || row.inputName} ${row.inputPrefecture} ${row.inputAddress}`.trim(),
  ];
  if (row.error) {
    lines.push(`error: ${row.error}`);
    return lines.join("\n");
  }
  lines.push(`法人番号: ${row.corporateNumber || "-"}`);
  lines.push(`商号: ${row.corporateName || "-"}`);
  lines.push(`カナ: ${row.corporateKana || "-"}`);
  lines.push(`所在地: ${row.corporateAddress || "-"}`);
  lines.push(`confidence: ${row.confidence || "-"}`);
  if (row.reason) {
    lines.push(`理由: ${row.reason}`);
  }
  return lines.join("\n");
}

function toEnrichTable(rows: EnrichOutputRow[]) {
  const row = rows[0];
  if (!row) {
    return "No result.";
  }
  const lines = [toResolveTable(rows)];
  if (!row.error) {
    lines.push(`データ更新日: ${row.dataUpdatedAt || "-"}`);
    lines.push(`年金機構事業所名: ${row.officeName || "-"}`);
    lines.push(`年金機構所在地: ${row.officeAddress || "-"}`);
    lines.push(`状態: ${row.officeStatus || "-"}`);
    lines.push(`被保険者数: ${row.insuredCount || "-"}`);
  }
  return lines.join("\n");
}

function rowsToCsv<T>(header: Array<keyof T>, rows: T[]) {
  return [
    header.map(String),
    ...rows.map((row) => header.map((key) => String(row[key]))),
  ]
    .map((line) => line.map(csvEscape).join(","))
    .join("\n");
}

function csvEscape(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toTable(response: LookupResponse) {
  const lines: string[] = [];
  if (response.clientSideFiltered && response.sourceCountText) {
    lines.push(`検索結果: ${response.sourceCountText}`);
    lines.push(`住所フィルタ後: ${response.countText ?? `${response.results.length}件`}`);
  } else {
    lines.push(`検索結果: ${response.countText ?? `${response.results.length}件`}`);
  }
  if (response.dataUpdatedAt) {
    lines.push(`データ更新日: ${response.dataUpdatedAt}`);
  }
  if (isPartialClientSideFilter(response)) {
    lines.push("注意: 住所フィルタは表示中の候補に対して行っています。検索全体の唯一候補とは限りません。");
    lines.push("CRM精緻化では `nenkin resolve` または `nenkin enrich` で法人番号を先に確定してください。");
  }
  lines.push("");

  if (response.results.length === 0) {
    lines.push("該当する事業所は見つかりませんでした。");
    return lines.join("\n");
  }

  const rows = response.results.map((result, index) => ({
    no: String(index + 1),
    officeName: compact(result.officeName, 30),
    corporateNumber: result.corporateNumber || "-",
    insuredCount: formatNumber(result.insuredCount),
    status: result.status || "-",
    address: compact(result.address, 32),
  }));

  const columns = [
    { key: "no", label: "#", width: maxWidth("#", rows.map((row) => row.no)) },
    {
      key: "officeName",
      label: "事業所名",
      width: maxWidth("事業所名", rows.map((row) => row.officeName)),
    },
    {
      key: "corporateNumber",
      label: "法人番号",
      width: maxWidth("法人番号", rows.map((row) => row.corporateNumber)),
    },
    {
      key: "insuredCount",
      label: "被保険者数",
      width: maxWidth("被保険者数", rows.map((row) => row.insuredCount)),
    },
    { key: "status", label: "状態", width: maxWidth("状態", rows.map((row) => row.status)) },
    { key: "address", label: "所在地", width: maxWidth("所在地", rows.map((row) => row.address)) },
  ] as const;

  lines.push(columns.map((column) => pad(column.label, column.width)).join("  "));
  lines.push(columns.map((column) => "-".repeat(column.width)).join("  "));
  for (const row of rows) {
    lines.push(columns.map((column) => pad(row[column.key], column.width)).join("  "));
  }

  const recommended = pickRecommended(response);
  if (recommended) {
    lines.push("");
    lines.push(`推奨候補: ${recommended.officeName}`);
    lines.push(`被保険者数: ${formatNumber(recommended.insuredCount)}`);
    lines.push(`理由: ${recommendReason(response, recommended)}`);
  }

  return lines.join("\n");
}

function pickRecommended(response: LookupResponse) {
  if (response.query.corporateNumber) {
    return (
      response.results.find((result) => result.corporateNumber === response.query.corporateNumber) ??
      null
    );
  }

  if (isPartialClientSideFilter(response)) {
    return null;
  }

  if (response.results.length === 1) {
    return response.results[0] ?? null;
  }

  const normalizedQueryName = normalizeCompanyName(response.query.kanaName ?? response.query.name ?? "");
  return (
    response.results.find(
      (result) =>
        result.status === "現存" && normalizeCompanyName(result.officeName) === normalizedQueryName,
    ) ?? null
  );
}

function recommendReason(response: LookupResponse, result: NenkinResult) {
  if (response.query.corporateNumber && result.corporateNumber === response.query.corporateNumber) {
    return "法人番号が一致しました。";
  }
  if (response.results.length === 1) {
    return "候補が1件のみでした。";
  }
  return "名称が一致し、現存事業所でした。";
}

function isPartialClientSideFilter(response: LookupResponse) {
  return response.clientSideFiltered === true && response.partialResults === true;
}

function parseCountText(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const match = value.match(/([0-9,]+)件/);
  if (!match) {
    return null;
  }
  return Number(match[1].replace(/,/g, ""));
}

function normalizeCompanyName(value: string) {
  return value
    .replace(/\s+/g, "")
    .replace(/　+/g, "")
    .replace(/[（(]株[）)]/g, "株式会社")
    .trim();
}

function normalizeSearchText(value: string) {
  return value
    .replace(/\s+/g, "")
    .replace(/　+/g, "")
    .replace(/[‐‑‒–—―ー－]/g, "-")
    .trim();
}

function toKanaAddressSearchTerm(value: string) {
  const normalized = normalizeSearchText(value);
  if (!normalized) {
    return undefined;
  }
  if (/^[ァ-ヶー・･]+$/.test(normalized)) {
    return normalized;
  }

  const municipalities: Array<[string, string]> = [
    ["千代田区", "チヨダク"],
    ["中央区", "チュウオウク"],
    ["港区", "ミナトク"],
    ["新宿区", "シンジュクク"],
    ["文京区", "ブンキョウク"],
    ["台東区", "タイトウク"],
    ["墨田区", "スミダク"],
    ["江東区", "コウトウク"],
    ["品川区", "シナガワク"],
    ["目黒区", "メグロク"],
    ["大田区", "オオタク"],
    ["世田谷区", "セタガヤク"],
    ["渋谷区", "シブヤク"],
    ["中野区", "ナカノク"],
    ["杉並区", "スギナミク"],
    ["豊島区", "トシマク"],
    ["北区", "キタク"],
    ["荒川区", "アラカワク"],
    ["板橋区", "イタバシク"],
    ["練馬区", "ネリマク"],
    ["足立区", "アダチク"],
    ["葛飾区", "カツシカク"],
    ["江戸川区", "エドガワク"],
  ];
  const match = municipalities.find(([kanji]) => normalized.includes(kanji));
  return match?.[1];
}

function compact(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatNumber(value: number | null) {
  return value == null ? "-" : value.toLocaleString("ja-JP");
}

function maxWidth(label: string, values: string[]) {
  return Math.max(displayWidth(label), ...values.map(displayWidth));
}

function pad(value: string, width: number) {
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
}

function displayWidth(value: string) {
  let width = 0;
  for (const char of value) {
    width += char.charCodeAt(0) <= 0x7f ? 1 : 2;
  }
  return width;
}

function banner() {
  return String.raw`
 _   _            _    _
| \ | | ___ _ __ | | _(_)_ __
|  \| |/ _ \ '_ \| |/ / | '_ \
| |\  |  __/ | | |   <| | | | |
|_| \_|\___|_| |_|_|\_\_|_| |_|

Nenkin insured-count lookup
`.trim();
}

function commandGuide() {
  return `Quick commands:
  nenkin "トヨタ自動車" --pref 愛知県
  nenkin --corp 1180301018771
  nenkin --corp 1180301018771 --json
  nenkin resolve --kana フィールドエックス --pref 東京都 --address 神泉町
  nenkin resolve companies.csv --out corporate-numbers.csv
  nenkin enrich --kana スペース --pref 東京都 --address 中野区新井
  nenkin enrich companies.csv --out enriched.csv`;
}

async function withSpinner<T>(message: string, enabled: boolean, task: () => Promise<T>) {
  if (!enabled) {
    return await task();
  }

  const frames = ["|", "/", "-", "\\"];
  let index = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  if (process.stderr.isTTY) {
    process.stderr.write(`${frames[index]} ${message}`);
    timer = setInterval(() => {
      index = (index + 1) % frames.length;
      process.stderr.write(`\r${frames[index]} ${message}`);
    }, 100);
  } else {
    process.stderr.write(`${message}\n`);
  }

  try {
    const result = await task();
    if (timer) {
      clearInterval(timer);
      process.stderr.write(`\rdone: ${message}\n`);
    }
    return result;
  } catch (error) {
    if (timer) {
      clearInterval(timer);
      process.stderr.write(`\r! ${message}\n`);
    }
    throw error;
  }
}

function printHelp() {
  console.log(`${banner()}

${commandGuide()}

Usage:
  nenkin <事業所名> [--pref <都道府県>]
  nenkin --kana <事業所名カナ> [--pref <都道府県>]
  nenkin --corp <13桁>
  nenkin batch <input.csv> [--out <output.csv>] [--json]
  nenkin resolve <input.csv> [--out <output.csv>] [--json]
  nenkin resolve --name <会社名> --pref <都道府県> [--address <住所>]
  nenkin resolve --kana <会社名カナ> --pref <都道府県> [--address <住所>]
  nenkin enrich <input.csv> [--out <output.csv>] [--json]
  nenkin enrich --name <会社名> --pref <都道府県> [--address <住所>]
  nenkin enrich --kana <会社名カナ> --pref <都道府県> [--address <住所>]
  nenkin doctor
  nenkin lookup --name <事業所名> [--prefecture <都道府県>] [--address <所在地>]
  nenkin lookup --kana <事業所名カナ> [--prefecture <都道府県>] [--address <所在地>]
  nenkin lookup --corporate-number <13桁>

Options:
  --include-closed active|closed|both  Default: active
  --browser auto|http-only|visible|headless-new|cdp|http-replay  Default: auto
  --cdp-endpoint <url>                                  Default: http://127.0.0.1:9222
  --format table|json|csv                               Default: table
  --json                                                Same as --format json
  --csv                                                 Same as --format csv
  --out <path>                                          Write CSV/JSON output to a file
  --delay-ms <number>                                   Delay between batch requests. Default: 500

Examples:
${exampleLines()}
  nenkin --corp 1180301018771 --browser http-only
  nenkin --corp 1180301018771 --browser cdp
  nenkin --corp 1180301018771 --browser http-replay`);
}

async function runDoctor() {
  console.log(`${banner()}\n`);
  const checks: Array<[string, () => Promise<string>]> = [
    [
      "node",
      async () => process.version,
    ],
    [
      "python3",
      async () => {
        const { stdout } = await execFileAsync("python3", ["--version"]);
        return stdout.trim();
      },
    ],
    [
      "curl_cffi",
      async () => {
        const { stdout } = await execFileAsync("python3", [
          "-c",
          "import curl_cffi; print(getattr(curl_cffi, '__version__', 'installed'))",
        ]);
        return stdout.trim();
      },
    ],
  ];

  for (const [label, check] of checks) {
    try {
      const value = await check();
      console.log(`ok   ${label}: ${value}`);
    } catch {
      console.log(`fail ${label}`);
      if (label === "curl_cffi") {
        console.log("     run: python3 -m pip install --user curl_cffi");
      }
    }
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command) {
    console.log(`Missing command.

${commandHint()}`);
    return;
  }

  if (command === "help" || options.has("help")) {
    printHelp();
    return;
  }

  if (command === "doctor") {
    await runDoctor();
    return;
  }

  if (command === "batch") {
    await runBatch(options);
    return;
  }

  if (command === "resolve") {
    await runResolve(options);
    return;
  }

  if (command === "enrich") {
    await runEnrich(options);
    return;
  }

  if (command !== "lookup") {
    throw new Error(`Unknown command: ${command}

${commandHint()}`);
  }

  const query = buildQuery(options);
  const browserMode = getBrowserMode(options);
  const format = getOutputFormat(options);
  const isHumanOutput = format === "table";
  if (isHumanOutput) {
    console.log(`${banner()}\n`);
  }

  const response = await withSpinner("Searching nenkin office data...", isHumanOutput, () =>
    lookup(query, browserMode, options),
  );
  if (format === "csv") {
    console.log(toCsv(response));
  } else if (format === "json") {
    console.log(JSON.stringify(response, null, 2));
  } else if (format === "table") {
    console.log(toTable(response));
  } else {
    throw new Error("--format must be table, json, or csv.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

declare global {
  interface Window {
    changeDisabled?: () => void;
  }
}
