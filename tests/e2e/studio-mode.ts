// The workspace opens in Guided mode (no code, terminal or source control): these scripts drive Studio, where all of
// it shows. Every page the browser opens starts with Studio remembered (unless the page already chose a mode).
import type { Browser } from "@playwright/test";

export function studioMode(browser: Browser) {
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    await page.addInitScript(() => {
      try {
        const p = JSON.parse(localStorage.getItem("cresslet.workspace") ?? "{}");
        if (!p.mode) localStorage.setItem("cresslet.workspace", JSON.stringify({ ...p, mode: "studio" }));
      } catch { /* storage blocked */ }
    });
    return page;
  };
}
