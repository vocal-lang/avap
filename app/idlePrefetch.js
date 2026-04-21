/**
 * After first paint, prefetch same-origin HTML routes (idle / low-priority).
 * Complements touch-based navigation on mobile where hover prefetch does not exist.
 */
const prefetched = new Set();

function sameOriginHtmlUrlsFromDom(here) {
  const out = new Set();
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    if (/^(mailto:|tel:|sms:|javascript:)/i.test(href)) return;
    let u;
    try {
      u = new URL(href, here);
    } catch {
      return;
    }
    if (u.origin !== here.origin) return;
    if (!u.pathname.endsWith(".html")) return;
    if (u.pathname === here.pathname) return;
    out.add(u.href);
  });
  return out;
}

function portalPageUrls(here) {
  const names = ["home.html", "about.html", "calendar.html", "hotline.html"];
  const out = new Set();
  const path = here.pathname.replace(/\\/g, "/");

  if (path.includes("/app/")) {
    const base = new URL(".", here);
    for (const name of names) {
      const u = new URL(name, base);
      if (u.pathname !== here.pathname) out.add(u.href);
    }
  }

  return out;
}

function collectPrefetchUrls() {
  const here = new URL(window.location.href);
  const urls = new Set([...sameOriginHtmlUrlsFromDom(here), ...portalPageUrls(here)]);
  return [...urls];
}

function injectPrefetchLinks(urls) {
  for (const href of urls) {
    if (prefetched.has(href)) continue;
    prefetched.add(href);
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = href;
    link.as = "document";
    document.head.appendChild(link);
  }
}

function runPrefetch() {
  try {
    injectPrefetchLinks(collectPrefetchUrls());
  } catch (e) {
    console.warn("idlePrefetch:", e);
  }
}

export function scheduleIdlePrefetch() {
  const idle =
    typeof window.requestIdleCallback === "function"
      ? (cb) => window.requestIdleCallback(cb, { timeout: 4000 })
      : (cb) => window.setTimeout(cb, 2000);

  const start = () => idle(runPrefetch);

  if (document.readyState === "complete") {
    start();
  } else {
    window.addEventListener("load", start, { once: true });
  }
}

scheduleIdlePrefetch();
