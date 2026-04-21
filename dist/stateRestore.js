// Remembers the last in-app page so a forced WebView reload
// (or relaunch) can restore where the user left off.
//
// Works with this project’s multi-page HTML navigation.
(function () {
  const KEY = "avap:lastPath";

  function isLikelyHtmlPath(pathname) {
    return typeof pathname === "string" && pathname.endsWith(".html");
  }

  function isSafeInAppPath(pathname) {
    // Only allow restoring to our known subfolders.
    return (
      typeof pathname === "string" &&
      pathname.startsWith("/app/")
    );
  }

  function saveCurrent() {
    try {
      const u = new URL(window.location.href);
      if (!isLikelyHtmlPath(u.pathname)) return;
      if (!isSafeInAppPath(u.pathname)) return;
      localStorage.setItem(KEY, u.pathname + u.search + u.hash);
    } catch {
      // ignore
    }
  }

  function restoreIfRoot() {
    try {
      const u = new URL(window.location.href);
      const p = u.pathname;
      const isRoot = p === "" || p === "/" || p.endsWith("/index.html");
      if (!isRoot) return;

      const saved = localStorage.getItem(KEY);
      if (saved && isSafeInAppPath(saved.split("?")[0].split("#")[0])) {
        window.location.replace(saved.replace(/^\//, ""));
        return;
      }

      window.location.replace("app/home.html");
    } catch {
      window.location.replace("app/home.html");
    }
  }

  // If we’re at the app entry, restore immediately.
  restoreIfRoot();

  // Persist as the user navigates around.
  window.addEventListener("pagehide", saveCurrent);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveCurrent();
  });
  window.addEventListener("beforeunload", saveCurrent);

  // Also save once after load for the current page.
  if (document.readyState === "complete") {
    saveCurrent();
  } else {
    window.addEventListener("load", saveCurrent, { once: true });
  }
})();

