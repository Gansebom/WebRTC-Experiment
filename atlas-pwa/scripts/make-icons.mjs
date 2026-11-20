// Renders public/icons/icon.svg to the PNG sizes iOS and Android need.
// Uses Playwright's Chromium: `npm run icons`.
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const svg = await readFile(new URL("../public/icons/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, rounded] of [
  ["apple-touch-icon.png", 180, false], // iOS applies its own mask
  ["icon-192.png", 192, true],
  ["icon-512.png", 512, false], // also used as maskable
]) {
  const art = rounded ? svg : svg.replace(/rx="112"/, 'rx="0"');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${art}`);
  await page.screenshot({ path: new URL(`../public/icons/${name}`, import.meta.url).pathname, omitBackground: true });
}
await browser.close();
console.log("icons written");
