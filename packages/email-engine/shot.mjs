#!/usr/bin/env node
// Takes a full-page PNG of an HTML file with a Chrome the caller names.
//   node shot.mjs <chrome binary> <html file> <png file> <width>
import puppeteer from "puppeteer-core";

const [executablePath, htmlFile, pngFile, width] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: Number(width) || 640, height: 800, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlFile}`, { waitUntil: "load", timeout: 20_000 });
  await page.screenshot({ path: pngFile, fullPage: true });
} finally {
  await browser.close();
}
