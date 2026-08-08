import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), "utf8");
const html = read("src/dashboard.html");
const worker = read("src/index.js");
const readme = read("README.md");
let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log(`PASS ${name}`); };

test("runtime dashboard uses liquidity chip", () => {
  assert.match(html, /id="tb-liq"/);
  assert.doesNotMatch(html, /id="tb-freeze"/);
});
test("Brent is context-only in dashboard", () => {
  assert.match(html, /getElementById\('tb-brent'\)\.className='val';/);
  assert.doesNotMatch(html, /m\.brent>90\?'neg':'pos'/);
});
test("rotation surface is review-only", () => {
  assert.match(html, /Rotation & Time Reviews/);
  assert.match(html, /D\.rotationReviews\|\|\[\]/);
  assert.doesNotMatch(html, /⚡ ROTATE/);
});
test("holdings surface leader and giveback state", () => {
  assert.match(html, /<th class="hm">Leader<\/th>/);
  assert.match(html, /giveback_alert/);
});
test("regime rationale is rendered", () => assert.match(html, /D\.macro&&D\.macro\.rationale/));
test("baseline is data-driven, not a committed portfolio snapshot", () => {
  assert.match(html, /Baseline \$\{fmt\(D\.baseline\)\}/);
  assert.doesNotMatch(html, /Baseline ₹[0-9]/);
});
test("Worker imports src/dashboard.html by relative runtime import", () => assert.match(worker, /import DASHBOARD_HTML from ["']\.\/dashboard\.html["'];/));
test("dashboard handler derives fallback baseline after capital accounting", () => {
  const handler = worker.slice(worker.indexOf("async function handleDashboardData"));
  const capPos = handler.indexOf("const cap = S.capitalAccounting");
  const baselinePos = handler.indexOf('const baseline = parseFloat(config.baseline || "0") || cap.net_worth || 1;');
  assert.ok(capPos >= 0, "capital accounting declaration missing");
  assert.ok(baselinePos > capPos, "baseline fallback must not reference cap before initialization");
});
test("root dashboard is documented as non-runtime", () => {
  assert.match(readme, /repository-root `dashboard\.html` is a legacy\/reference copy/);
  assert.match(readme, /Worker imports `src\/dashboard\.html`/);
});
test("patcher still applies all eight anchors to synthetic fixture", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-dashboard-"));
  const target = path.join(dir, "dashboard.html");
  fs.copyFileSync(new URL("test/dashboard.fixture.html", root), target);
  const out = execFileSync("python3", [new URL("migrations/patch_dashboard.py", root).pathname, target], { encoding: "utf8" });
  assert.match(out, /patched: 8 anchors/);
  const patched = fs.readFileSync(target, "utf8");
  assert.match(patched, /id="tb-liq"/);
  assert.match(patched, /Rotation & Time Reviews/);
});
test("patched runtime file contains all eight expected outcomes", () => {
  const markers = ["tb-liq", "className='val';", "Rotation & Time Reviews", "rotationReviews", ">Leader<", "giveback_alert", "macro.rationale", "Baseline ${fmt(D.baseline)}"];
  for (const marker of markers) assert.ok(html.includes(marker), `missing ${marker}`);
});

console.log(`\nDASHBOARD ASSERTIONS pass=${pass} fail=0`);
