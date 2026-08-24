import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const url = "file://" + path.join(dir, "index.html");
const [, , outPrefix, theme] = process.argv;

const browser = await chromium.launch();
for (const width of [820, 1180]) {
  const page = await browser.newPage({
    viewport: { width, height: 1400 },
    deviceScaleFactor: 2,
    colorScheme: theme === "light" ? "light" : "dark",
  });
  page.on("console", (m) => console.log(`[console:${m.type()}]`, m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message, "\n", e.stack?.split("\n").slice(0, 6).join("\n")));
  page.on("requestfailed", (r) => console.log("[reqfail]", r.url(), r.failure()?.errorText));
  await page.goto(url, { waitUntil: "load" });
  if (theme === "light") await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.waitForTimeout(1500);
  const html = await page.evaluate(() => document.getElementById("root")?.innerHTML.length ?? -1);
  console.log("root innerHTML length:", html);
  await page.screenshot({ path: `${outPrefix}-${theme}-${width}.png`, fullPage: true });
  console.log("shot", `${outPrefix}-${theme}-${width}.png`);
  await page.close();
}
await browser.close();
