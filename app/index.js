import "./idlePrefetch.js";
import { app, logPageView, trackEvent } from './firebaseInit.js';
import {getFirestore, collection, getDocs, getDoc, updateDoc, addDoc, deleteDoc, doc, setDoc, writeBatch, query, limit, deleteField} from 'firebase/firestore';
import {getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject} from 'firebase/storage';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { getAuth, onAuthStateChanged } from 'firebase/auth';

const availableCollections = [ //list must be updated with collection names
  "District Attorney",
  "Sheriffs",
  "Domestic Violence",
  "Child Advocacy",
  "Compensation",
  "Human Trafficking",
  "Sexual Assault",
  "Victim Resources",
  "Pardon & Parole",
  "Hotlines",
  "Tribal", // Resources for Native Americans in Alabama
  "Coroner",
  "Misc",
];

// Dynamic category tags fetched from Firestore "Resource Tags" collection (doc IDs are the tag names)
// Keep defaults empty so categories come from Firestore rather than hardcoded values.
const DEFAULT_CATEGORIES = [];
let resourceCategories = [];
/** Each Firestore doc in "Resource Tags": raw document id + display label (whitespace normalized). */
let resourceTagDocMetas = [];

/** First N words shown on home resource cards before "Show more" (Services / Description). */
const SERVICES_CARD_PREVIEW_WORD_COUNT = 15;

/** Trim/collapse internal whitespace; decode HTML entity ampersands in pasted text. */
function normalizeCategoryTag(val) {
  if (val == null || val === undefined) return "";
  return String(val)
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Category comparison key: lowercase; "&" stays "&" so it matches Resource Tags text. */
function normalizeCategoryTagKey(val) {
  const base = normalizeCategoryTag(val).toLowerCase();
  if (!base) return "";
  return base
    .replace(/\s*&\s*/g, " & ")
    .replace(/[^a-z0-9&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Optional synonym groups for home category filter (keys = normalizeCategoryTagKey output).
 * Pardon/Parole: canonical matches Resource Tag "Pardon & Parole"; includes common and/& plural variants.
 */
const CATEGORY_TAG_EQUIVALENCE_GROUPS = [
  [
    "pardon & parole",
    "pardons & paroles",
    "pardons and paroles",
    "pardons and parole",
    "pardon and paroles",
    "pardon and parole",
  ],
];

const categoryEquivalenceCanonicalByKey = (() => {
  const m = new Map();
  for (const group of CATEGORY_TAG_EQUIVALENCE_GROUPS) {
    const leader = group[0];
    for (const k of group) {
      if (k) m.set(k, leader);
    }
  }
  return m;
})();

/** Stable id for category filter matching (synonyms collapse to one key). */
function getCategoryEquivalenceId(val) {
  const k = normalizeCategoryTagKey(val);
  if (!k) return "";
  return categoryEquivalenceCanonicalByKey.get(k) || k;
}

function normalizeCategoryTagList(raw) {
  if (raw == null || raw === undefined) return null;
  const pieces = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const normalized = pieces.map((t) => normalizeCategoryTag(t)).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const t of normalized) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.length ? out : null;
}

async function fetchResourceTags() {
  try {
    const tagsRef = collection(firestore, "Resource Tags");
    const snapshot = await getDocs(tagsRef);
    resourceTagDocMetas = snapshot.docs
      .map((d) => ({ rawId: d.id, display: normalizeCategoryTag(d.id) }))
      .filter((m) => m.display)
      .sort(
        (a, b) =>
          a.display.localeCompare(b.display, undefined, { sensitivity: "base" }) ||
          a.rawId.localeCompare(b.rawId)
      );
    const fetched = resourceTagDocMetas.map((m) => m.display);
    resourceCategories = [...new Set([...fetched, ...DEFAULT_CATEGORIES.map(normalizeCategoryTag)])].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
    return resourceCategories;
  } catch (err) {
    console.error("Error fetching Resource Tags:", err);
    resourceTagDocMetas = [];
    resourceCategories = [...new Set([...resourceCategories.map(normalizeCategoryTag), ...DEFAULT_CATEGORIES.map(normalizeCategoryTag)])].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
    return resourceCategories;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const safetyExitButton = document.getElementById("safety-exit");
  if (safetyExitButton) {
    safetyExitButton.addEventListener("click", () => {
      try {
        // No localStorage/sessionStorage used for privacy
      } catch (error) {
        console.warn("Safety exit storage clear failed.", error);
      }
      window.location.replace("https://www.google.com");
    });
  }

  // Hotline dropdown (top-bar copy on mobile + in-nav copy on desktop)
  document.querySelectorAll(".hotline-block").forEach((hotlineBlock) => {
    const hotlineTrigger = hotlineBlock.querySelector(".hotline-block__trigger");
    const hotlinePanel = hotlineBlock.querySelector(".hotline-block__panel");
    if (!hotlineTrigger || !hotlinePanel) return;
    hotlineTrigger.addEventListener("click", () => {
      const isOpen = hotlineBlock.classList.toggle("hotline-block--open");
      hotlineTrigger.setAttribute("aria-expanded", String(isOpen));
      hotlinePanel.setAttribute("aria-hidden", String(!isOpen));
    });
  });

  // Hamburger menu toggle (mobile nav + mid-width when links do not fit one row)
  const menuToggle = document.getElementById("menu-toggle");
  const mainMenu = document.getElementById("main-menu");
  if (menuToggle && mainMenu) {
    const NAV_COMPACT_DEBOUNCE_MS = 80;
    let navCompactTimer = null;
    let navCompactRaf = null;

    function isNavCompactMode() {
      return (
        window.innerWidth <= 600 ||
        document.body.classList.contains("site-nav--compact")
      );
    }

    function setMenuOpen(open) {
      const shouldOpen = open;
      menuToggle.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
      mainMenu.setAttribute("aria-hidden", shouldOpen ? "false" : "true");
      mainMenu.classList.toggle("main-menu--open", shouldOpen);
    }

    function updateSiteNavCompact() {
      const inner = mainMenu.querySelector(".main-menu__inner");
      if (!inner) return;

      if (window.innerWidth <= 600) {
        document.body.classList.remove("site-nav--compact");
        return;
      }

      // Avoid forced synchronous reflow during resize; measure on next frame.
      document.body.classList.remove("site-nav--compact");
      if (navCompactRaf) window.cancelAnimationFrame(navCompactRaf);
      navCompactRaf = window.requestAnimationFrame(() => {
        navCompactRaf = null;
        const overflows = inner.scrollWidth > inner.clientWidth + 2;
        document.body.classList.toggle("site-nav--compact", overflows);
      });
    }

    let prevNavCompact = null;

    function scheduleSiteNavCompactUpdate() {
      window.clearTimeout(navCompactTimer);
      navCompactTimer = window.setTimeout(() => {
        navCompactTimer = null;
        updateSiteNavCompact();
        const compact = isNavCompactMode();
        if (prevNavCompact !== compact) {
          prevNavCompact = compact;
          if (compact) {
            setMenuOpen(false);
          } else {
            mainMenu.setAttribute("aria-hidden", "false");
            mainMenu.classList.remove("main-menu--open");
            menuToggle.setAttribute("aria-expanded", "false");
          }
        }
      }, NAV_COMPACT_DEBOUNCE_MS);
    }

    function runSiteNavCompactNow() {
      window.clearTimeout(navCompactTimer);
      navCompactTimer = null;
      updateSiteNavCompact();
      const compact = isNavCompactMode();
      if (prevNavCompact !== compact) {
        prevNavCompact = compact;
        if (compact) {
          setMenuOpen(false);
        } else {
          mainMenu.setAttribute("aria-hidden", "false");
          mainMenu.classList.remove("main-menu--open");
          menuToggle.setAttribute("aria-expanded", "false");
        }
      }
    }

    // Defer initial compact layout until after first paint to reduce navigation flash.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        runSiteNavCompactNow();
      });
    });
    window.addEventListener("resize", scheduleSiteNavCompactUpdate);

    const menuInner = mainMenu.querySelector(".main-menu__inner");
    if (menuInner && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => scheduleSiteNavCompactUpdate());
      ro.observe(menuInner);
    }

    menuToggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isNavCompactMode()) return;
      const isOpen = mainMenu.classList.contains("main-menu--open");
      setMenuOpen(!isOpen);
    });

    document.addEventListener("click", (e) => {
      if (!isNavCompactMode()) return;
      if (
        mainMenu.classList.contains("main-menu--open") &&
        !menuToggle.contains(e.target) &&
        !mainMenu.contains(e.target) &&
        !e.target.closest(".hotline-block")
      ) {
        setMenuOpen(false);
      }
    });

    mainMenu.querySelectorAll(".main-menu__link").forEach((link) => {
      link.addEventListener("click", () => {
        if (!isNavCompactMode()) return;
        setMenuOpen(false);
      });
    });
  }

  // Highlight current page in top navigation
  const navLinks = document.querySelectorAll(".main-menu__link");
  if (navLinks.length > 0) {
    const currentFile = window.location.pathname.split("/").pop() || "home.html";
    navLinks.forEach((link) => {
      const href = link.getAttribute("href") || "";
      const targetFile = href.split("/").pop();
      if (targetFile === currentFile) {
        link.classList.add("main-menu__link--active");
      }
    });
  }

});

// Mobile privacy statement more/less toggle
window.addEventListener("DOMContentLoaded", () => {
  initializeCurrentPrivacyStatement();
});

const firestore = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app);

/** Surface Firebase callable errors (message, code, server `details`) in UI + console. */
function formatFunctionsClientError(err) {
  if (err == null) return "Unknown error";
  const parts = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push(`(${err.code})`);
  const d = err.details;
  if (d !== undefined && d !== null) {
    try {
      parts.push(typeof d === "string" ? d : JSON.stringify(d));
    } catch {
      parts.push(String(d));
    }
  }
  return parts.length > 0 ? parts.join(" ") : String(err);
}

// Local dev: set VITE_USE_FUNCTIONS_EMULATOR=1 and run `firebase emulators:start --only functions`
// (Admin SDK in the emulator still uses production Auth unless you configure auth emulator for functions.)
if (
  typeof import.meta !== "undefined" &&
  import.meta.env?.DEV &&
  import.meta.env?.VITE_USE_FUNCTIONS_EMULATOR === "1"
) {
  const emuHost = import.meta.env.VITE_FUNCTIONS_EMULATOR_HOST || "127.0.0.1";
  const emuPort = Number(import.meta.env.VITE_FUNCTIONS_EMULATOR_PORT || 5001);
  connectFunctionsEmulator(functions, emuHost, emuPort);
  console.info(
    `[VOCAL] Functions emulator: http://${emuHost}:${emuPort} (project ${app.options.projectId})`
  );
}

const pageNames = {
  "home.html": "Home",
};
const currentPage = window.location.pathname.split("/").pop() || "";
if (pageNames[currentPage]) {
  logPageView(pageNames[currentPage]);
}

// Track current collection name
let currentCollectionName = null;
// Track headers for the current collection (used by Add Resource)
let currentHeaders = [];
// Event lookup used by admin edit/remove actions on the calendar page.
let adminEventLookup = new Map();
let adminEventFormInitialized = false;
let calendarViewYear = null;
let calendarViewMonthIndex = null;

function getTodayMMDDYYYY() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const year = now.getFullYear();
  return `${month}/${day}/${year}`;
}

async function repairWhitespaceInAllResourceCategoryTags() {
  const confirmed = window.confirm(
    "Fix category spacing on all resources? This trims and removes extra spaces in Category Tags (and merges exact duplicates after trimming)."
  );
  if (!confirmed) return;

  let updatedDocs = 0;
  let batch = writeBatch(firestore);
  let batchCount = 0;
  const MAX_BATCH = 450;

  async function commitBatch() {
    if (batchCount === 0) return;
    await batch.commit();
    batch = writeBatch(firestore);
    batchCount = 0;
  }

  try {
    for (const colName of availableCollections) {
      const snapshot = await getDocs(collection(firestore, colName));
      for (const d of snapshot.docs) {
        const raw = d.data()?.["Category Tags"];
        if (raw == null || raw === undefined) continue;
        const next = normalizeCategoryTagList(raw);

        const currentNorm = normalizeCategoryTagList(raw);
        if (JSON.stringify(currentNorm || null) === JSON.stringify(next || null)) continue;

        batch.update(doc(firestore, colName, d.id), { "Category Tags": next });
        batchCount += 1;
        updatedDocs += 1;
        if (batchCount >= MAX_BATCH) await commitBatch();
      }
    }
    await commitBatch();

    alert(updatedDocs === 0 ? "No documents needed updates." : `Updated Category Tags on ${updatedDocs} document(s).`);
    await fetchResourceTags();
    if (currentCollectionName) await loadCollection(currentCollectionName);
  } catch (err) {
    console.error("repairWhitespaceInAllResourceCategoryTags:", err);
    alert("Could not repair category tags: " + (err?.message || String(err)));
  }
}

function normalizeDuplicateValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().toLowerCase();
  return String(value).trim().toLowerCase();
}

const DUPLICATE_CHECK_FIELDS = ["Organization", "First Name", "Last Name", "Name"];

async function isDuplicateDocument(collectionName, candidateDoc) {
  const keysToCompare = DUPLICATE_CHECK_FIELDS.filter(
    (key) => candidateDoc[key] !== undefined && candidateDoc[key] !== null && candidateDoc[key] !== ""
  );
  if (keysToCompare.length === 0) return false;

  const collectionRef = collection(firestore, collectionName);
  const snapshot = await getDocs(collectionRef);

  for (const existingDoc of snapshot.docs) {
    const existingData = existingDoc.data();
    const isMatch = keysToCompare.every((key) => {
      const candidateVal = normalizeDuplicateValue(candidateDoc[key]);
      const existingVal = normalizeDuplicateValue(existingData[key]);
      return candidateVal === existingVal;
    });

    if (isMatch) return true;
  }

  return false;
}

// Generic function to load any collection
async function loadCollection(collectionName) {
  if (!collectionName) {
    console.error("No collection name provided");
    return;
  }

  try {
    const collectionRef = collection(firestore, collectionName);
    const querySnapshot = await getDocs(collectionRef);

    const rows = [];
    querySnapshot.forEach((doc) => {
      const data = { id: doc.id, ...doc.data() };
      rows.push(data);
    });

    // Apply sorting if Judicial Circuit field exists
    if (rows.length > 0 && rows[0]["Judicial Circuit"] !== undefined) {
      // Convert string to int and sort
      rows.forEach((row) => {
        if (typeof row["Judicial Circuit"] === 'string') {
          const parsed = parseInt(row["Judicial Circuit"], 10);
          if (!isNaN(parsed)) {
            row["Judicial Circuit"] = parsed;
          }
        }
      });
      rows.sort((a, b) => {
        const circuitA = a["Judicial Circuit"] || 0;
        const circuitB = b["Judicial Circuit"] || 0;
        return circuitA - circuitB; // Integer sort
      });
    }

    renderTable(rows, collectionName);
  } catch (err) {
    console.error(`Error loading collection '${collectionName}':`, err);
    alert(`Error loading collection: ${err.message}`);
  }
}

async function loadAllCollectionsForAdmin() {
  try {
    const allResources = await fetchAllResources();
    renderTable(allResources);
  } catch (err) {
    console.error("Error loading all collections:", err);
    alert(`Error loading all resources: ${err.message}`);
  }
}

// Create and initialize collection dropdown
function initializeCollectionDropdown() {
  // Hook up top-bar navigation buttons for admin pages.
  const manageEventsBtn = document.getElementById("manageEventsButton");
  if (manageEventsBtn) {
    manageEventsBtn.addEventListener("click", () => {
      window.location.href = "./admin-calendar.html";
    });
  }

  const backToAdminBtn = document.getElementById("backToAdminButton");
  if (backToAdminBtn) {
    backToAdminBtn.addEventListener("click", () => {
      window.location.href = "./admin.html";
    });
  }

  const manageAccountsBtn = document.getElementById("manageAccountsButton");
  if (manageAccountsBtn) {
    manageAccountsBtn.addEventListener("click", () => {
      window.location.href = "./admin-accounts.html";
    });
  }

  const table = document.getElementById("dataTable");
  if (!table) {
    console.warn('Table not found, cannot create dropdown');
    return;
  }

  // Check if dropdown already exists
  let dropdown = document.getElementById("collectionSelector");
  if (!dropdown) {
    const container = document.createElement("div");
    container.className = "admin-collection-controls";

    const label = document.createElement("label");
    label.textContent = "Select Collection: ";
    label.setAttribute("for", "collectionSelector");
    label.className = "admin-collection-controls__label";

    dropdown = document.createElement("select");
    dropdown.id = "collectionSelector";
    dropdown.className = "admin-collection-controls__select";

    const controlsRow = document.createElement("div");
    controlsRow.className = "admin-collection-controls__row";

    const showAllButton = document.createElement("button");
    showAllButton.type = "button";
    showAllButton.id = "showAllButton";
    showAllButton.textContent = "Show All";
    showAllButton.className = "admin-show-all-btn";

    container.appendChild(label);
    controlsRow.appendChild(dropdown);
    controlsRow.appendChild(showAllButton);
    container.appendChild(controlsRow);

    table.parentNode.insertBefore(container, table);
  }

  // Clear existing options
  dropdown.innerHTML = "";

  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = "Select a collection...";
  placeholderOption.selected = true;
  dropdown.appendChild(placeholderOption);

  // Populate dropdown with available collections
  availableCollections.forEach((colName) => {
    const option = document.createElement("option");
    option.value = colName;
    option.textContent = colName;
    dropdown.appendChild(option);
  });

  const showAllButton = document.getElementById("showAllButton");
  function setShowAllActive(isActive) {
    if (!showAllButton) return;
    showAllButton.classList.toggle("admin-show-all-btn--active", isActive);
    showAllButton.setAttribute("aria-pressed", isActive ? "true" : "false");
  }

  if (availableCollections.length > 0) {
    dropdown.value = availableCollections[0];
    setShowAllActive(false);
    loadCollection(availableCollections[0]);
  } else {
    setShowAllActive(true);
    currentCollectionName = null;
    loadAllCollectionsForAdmin();
  }

  // Handle collection change
  dropdown.addEventListener("change", (e) => {
    const selectedCollection = e.target.value;
    if (!selectedCollection) {
      currentCollectionName = null;
      setShowAllActive(true);
      loadAllCollectionsForAdmin();
      return;
    }
    setShowAllActive(false);
    loadCollection(selectedCollection);
  });

  if (showAllButton) {
    showAllButton.addEventListener("click", async () => {
      dropdown.value = "";
      currentCollectionName = null;
      setShowAllActive(true);
      await loadAllCollectionsForAdmin();
    });
  }

  // Hook up Add Resource button on admin page (if present)
  const addButton = document.getElementById("addResourceButton");
  if (addButton) {
    addButton.addEventListener("click", () => {
      if (!currentCollectionName) {
        alert("Please select a collection before adding a resource.");
        return;
      }
      void openCreateResourceForm();
    });
  }

  // Hook up Manage Tags button on admin page (if present)
  const manageTagsBtn = document.getElementById("manageTagsButton");
  if (manageTagsBtn) {
    manageTagsBtn.addEventListener("click", openManageTagsForm);
  }

}

// table id="dataTable".
function renderTable(rows, collectionName) {
  function normalizeCellValue(value) {
    if (value == null) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      const parts = value
        .map((item) => {
          if (item == null) return "";
          if (typeof item === "string") return item.trim();
          if (typeof item === "number" || typeof item === "boolean") return String(item);
          return "";
        })
        .filter(Boolean);
      return parts.join(", ");
    }
    return "";
  }

  function normalizeFieldKey(key) {
    return String(key || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/:+$/, "")
      .toLowerCase();
  }

  function findFirstValue(rowObj, sources) {
    if (!rowObj || !sources || sources.length === 0) return undefined;

    // Fast path for exact key matches.
    for (const src of sources) {
      const value = rowObj?.[src];
      if (normalizeCellValue(value) !== "") return value;
    }

    // Fallback for CSV/import variations (e.g., trailing spaces, colon suffixes, casing).
    const normalizedSourceSet = new Set(sources.map((s) => normalizeFieldKey(s)));
    const keys = Object.keys(rowObj);
    for (const key of keys) {
      if (!normalizedSourceSet.has(normalizeFieldKey(key))) continue;
      const value = rowObj[key];
      if (normalizeCellValue(value) !== "") return value;
    }

    return undefined;
  }

  function findHeuristicValue(rowObj, pattern) {
    if (!rowObj || !pattern) return undefined;
    for (const key of Object.keys(rowObj)) {
      if (!pattern.test(normalizeFieldKey(key))) continue;
      const value = rowObj[key];
      if (normalizeCellValue(value) !== "") return value;
    }
    return undefined;
  }

  // Store the current collection name
  if (collectionName) {
    currentCollectionName = collectionName;
  }
  const table = document.getElementById("dataTable");
  if (!table) {
    console.warn('renderTable: no table with id "dataTable" found.');
    return;
  }
  let thead = table.querySelector("thead");
  let tbody = table.querySelector("tbody");
  if (!thead) {
    thead = document.createElement("thead");
    table.appendChild(thead);
  }
  if (!tbody) {
    tbody = document.createElement("tbody");
    table.appendChild(tbody);
  }
  thead.innerHTML = "";
  tbody.innerHTML = "";

  const rowsSafe = Array.isArray(rows) && rows.length > 0 ? rows : [];

  // Build a complete key set across all rows so mixed-collection views
  // (like Show All) include columns that may not exist on the first row.
  const allKeys = Array.from(
    rowsSafe.reduce((keys, row) => {
      Object.keys(row || {}).forEach((key) => keys.add(key));
      return keys;
    }, new Set())
  );

  // Default admin columns (most collections); includes County for alignment with public filters.
  const DEFAULT_ADMIN_COLUMN_SPECS = [
    { key: "Name", label: "Name", sources: ["Name", "name", "First Name", "Last Name", "Contact Name", "Organization"] },
    { key: "Organization", label: "Organization", sources: ["Organization", "Organization:", "organization", "Agency", "Office", "Department", "Program"] },
    { key: "County", label: "County", sources: ["County", "county", "County:", "County Served"] },
    { key: "Description", label: "Description", sources: ["Description", "Description:", "description", "Services", "Services:", "Service", "Notes", "notes", "Summary", "Details", "About"] },
    { key: "Hours", label: "Hours", sources: ["Hours", "Hours:", "hours", "Business Hours", "Availability", "Open Hours"] },
    { key: "Phone", label: "Phone", sources: ["Phone", "phone", "Phone Number", "Phone Number:", "Phone:", "phoneNumber", "Telephone", "Tel", "Contact Number", "Main Phone", "Hotline"] },
    { key: "Website", label: "Website", sources: ["Website", "website", "Website:", "Web", "URL", "Url", "Link", "Web Site"] },
  ];

  /** Sheriffs: hide Description and Hours; include Address (same composed line as the public map). */
  const SHERIFFS_ADMIN_COLUMN_SPECS = (() => {
    const base = DEFAULT_ADMIN_COLUMN_SPECS.filter(
      (s) => s.key !== "Description" && s.key !== "Hours"
    );
    const phoneIdx = base.findIndex((s) => s.key === "Phone");
    const insertAt = phoneIdx >= 0 ? phoneIdx : base.length;
    const addressSpec = {
      key: "Address",
      label: "Address",
      kind: "addressLine",
      sources: [],
    };
    return [...base.slice(0, insertAt), addressSpec, ...base.slice(insertAt)];
  })();

  /** District Attorney: match how DAs are shown on the public site (name, circuit, address). */
  const DISTRICT_ATTORNEY_ADMIN_COLUMN_SPECS = [
    {
      key: "DAName",
      label: "Name",
      kind: "daTitle",
      sources: [],
    },
    {
      key: "County",
      label: "County",
      kind: "countyLine",
      sources: ["County", "county", "County:", "County Served", "Counties"],
    },
    {
      key: "JudicialCircuit",
      label: "Judicial circuit",
      kind: "judicial",
      sources: ["Judicial Circuit", "Judical Circuit", "Judicial Circuit:"],
    },
    {
      key: "Address",
      label: "Address",
      kind: "addressLine",
      sources: [],
    },
    {
      key: "Website",
      label: "Website",
      sources: ["Website", "website", "Website:", "Web", "URL", "Url", "Link", "Web Site"],
    },
    {
      key: "Phone",
      label: "Phone",
      kind: "daPhoneFirst",
      sources: ["Phone", "phone", "Phone Number", "Phone Number:", "Phone:", "phoneNumber", "Telephone", "Tel", "Contact Number", "Main Phone", "Hotline"],
    },
  ];

  const COLUMN_SPECS =
    collectionName === "District Attorney"
      ? DISTRICT_ATTORNEY_ADMIN_COLUMN_SPECS
      : collectionName === "Sheriffs"
        ? SHERIFFS_ADMIN_COLUMN_SPECS
        : DEFAULT_ADMIN_COLUMN_SPECS;

  const showCollection = !collectionName && allKeys.includes("_collection");
  const headers = [];
  if (showCollection) headers.push("_collection");
  COLUMN_SPECS.forEach((s) => headers.push(s.key));

  // Add Resource fallback: canonical columns, or collection defaults when empty Tribal/etc.
  if (collectionName) {
    if (!rowsSafe.length && COLLECTION_DEFAULT_HEADERS?.[collectionName]) {
      currentHeaders = COLLECTION_DEFAULT_HEADERS[collectionName].slice();
    } else {
      currentHeaders = DEFAULT_ADMIN_COLUMN_SPECS.map((s) => s.key);
    }
  }

  // Header row
  const headerRow = document.createElement("tr");
  headers.forEach((key) => {
    const th = document.createElement("th");
    const colSpec = COLUMN_SPECS.find((s) => s.key === key);
    if (key === "_collection") {
      th.textContent = "Collection";
    } else if (key === "Category Tags") {
      th.textContent = "Categories";
    } else if (colSpec?.label) {
      th.textContent = colSpec.label;
    } else {
      th.textContent = key;
    }
    headerRow.appendChild(th);
  });
  // Add Edit column header
  const editHeader = document.createElement("th");
  editHeader.textContent = "Edit";
  headerRow.appendChild(editHeader);
  thead.appendChild(headerRow);

  if (!rowsSafe.length) {
    const emptyRow = document.createElement("tr");
    const emptyCell = document.createElement("td");
    emptyCell.textContent = "No data.";
    emptyCell.colSpan = headers.length + 1;
    emptyRow.appendChild(emptyCell);
    tbody.appendChild(emptyRow);
    return;
  }

  // Data rows
  rowsSafe.forEach((rowObj) => {
    const row = document.createElement("tr");
    headers.forEach((key) => {
      const cell = document.createElement("td");
      if (key === "Website") cell.classList.add("admin-cell--website");
      if (key === "_collection") {
        cell.textContent = rowObj?._collection ? String(rowObj._collection) : "";
        row.appendChild(cell);
        return;
      }

      const spec = COLUMN_SPECS.find((s) => s.key === key);
      if (spec) {
        if (spec.kind === "daTitle") {
          cell.textContent = getResourceDisplayTitle(rowObj);
          row.appendChild(cell);
          return;
        }
        if (spec.kind === "addressLine") {
          cell.textContent = getResourceAddressLine(rowObj);
          row.appendChild(cell);
          return;
        }
        if (spec.kind === "countyLine") {
          cell.textContent = formatCountyForDisplay(rowObj);
          row.appendChild(cell);
          return;
        }
        if (spec.kind === "judicial") {
          let value = findFirstValue(rowObj, spec.sources);
          if (normalizeCellValue(value) === "") {
            value = findHeuristicValue(rowObj, /(judicial|circuit)/);
          }
          cell.textContent = normalizeCellValue(value);
          row.appendChild(cell);
          return;
        }
        if (spec.kind === "daPhoneFirst") {
          cell.textContent = getFirstDistrictAttorneyPhoneForAdminTable(rowObj);
          row.appendChild(cell);
          return;
        }
        if (key === "Name") {
          const first =
            findFirstValue(rowObj, ["First Name", "firstName"]) ?? "";
          const last = findFirstValue(rowObj, ["Last Name", "lastName"]) ?? "";
          const composed = `${String(first).trim()} ${String(last).trim()}`.trim();
          const fallback =
            findFirstValue(rowObj, [
              "Name",
              "name",
              "Title",
              "Organization",
              "Organization:",
            ]) ?? "";
          cell.textContent = composed || (fallback ? String(fallback) : "");
        } else if (key === "Website") {
          const value = findFirstValue(rowObj, spec.sources);
          const raw = value == null ? "" : String(value).trim();
          if (!raw) {
            cell.textContent = "";
          } else {
            const href = formatWebsiteHref(raw);
            if (href) {
              const a = document.createElement("a");
              a.href = href;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
              a.className = "hotline-block__link";
              a.textContent = raw;
              cell.appendChild(a);
            } else {
              cell.textContent = raw;
            }
          }
        } else {
          let value = findFirstValue(rowObj, spec.sources);
          if (normalizeCellValue(value) === "") {
            if (key === "Organization") value = findHeuristicValue(rowObj, /(organization|agency|office|department|program|provider)/);
            if (key === "Description") value = findHeuristicValue(rowObj, /(description|services?|about|notes?|details?|summary|mission)/);
            if (key === "Hours") value = findHeuristicValue(rowObj, /(hours?|availability|open)/);
            if (key === "Phone") value = findHeuristicValue(rowObj, /(phone|telephone|tel|mobile|cell|hotline|contact number|main phone)/);
            if (key === "Website") value = findHeuristicValue(rowObj, /(website|url|web site|web|link)/);
          }
          cell.textContent = normalizeCellValue(value);
        }
        row.appendChild(cell);
        return;
      }

      cell.textContent = normalizeCellValue(rowObj?.[key]);
      row.appendChild(cell);
    });
    // Add Edit button cell
    const editCell = document.createElement("td");
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "admin-table-edit-btn";
    editButton.title = "Edit resource";
    editButton.setAttribute("aria-label", "Edit resource");
    editButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zm2.92 2.33h-.84v-.84l8.92-8.92.84.84-8.92 8.92zM20.71 5.63a1 1 0 0 0 0-1.41l-.93-.93a1 1 0 0 0-1.41 0l-1.38 1.38 2.34 2.34 1.38-1.38z"/>
      </svg>
    `;
    editButton.addEventListener("click", () => {
      void editDocument(rowObj);
    });
    editCell.appendChild(editButton);
    row.appendChild(editCell);
    tbody.appendChild(row);
  });
}
function renderResourceForm({ mode, collectionName, docData = null, fieldKeyTemplate = null }) {
  const isEdit = mode === "edit";
  const isDistrictAttorney = isDistrictAttorneyCollectionName(collectionName);
  const form = document.createElement("div");
  form._daCountySyncReady = false;
  form.style.cssText = "position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #fff; border: 1px solid rgba(15, 23, 42, 0.16); box-shadow: 0 18px 45px rgba(2, 8, 23, 0.18), 0 2px 8px rgba(2, 8, 23, 0.08); z-index: 1000; max-width: 760px; width: min(92vw, 760px); max-height: min(88vh, 920px); display: flex; flex-direction: column; overflow: hidden; border-radius: 18px; overscroll-behavior: contain;";

  function applyResourceModalPosition() {
    const topBar = document.querySelector(".admin-top-bar");
    const topBarVisible =
      topBar && window.getComputedStyle(topBar).display !== "none";
    if (topBarVisible) {
      const topOffset = Math.max(16, Math.ceil(topBar.getBoundingClientRect().bottom) + 12);
      form.style.top = `${topOffset}px`;
      form.style.transform = "translateX(-50%)";
      form.style.maxHeight = `calc(100vh - ${topOffset + 16}px)`;
    } else {
      form.style.top = "50%";
      form.style.transform = "translate(-50%, -50%)";
      form.style.maxHeight = "min(88vh, 920px)";
    }
  }
  applyResourceModalPosition();
  window.addEventListener("resize", applyResourceModalPosition);

  const formInner = document.createElement("div");
  formInner.style.cssText = "flex: 1; overflow-y: auto; padding: 24px; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;";

  const title = document.createElement("h2");
  title.textContent = isEdit ? "Edit Document" : "Add Resource";
  title.style.cssText = "margin:0 0 10px 0;font-size:1.45rem;line-height:1.25;font-weight:700;color:#0f172a;";
  formInner.appendChild(title);

  const HIDDEN_KEYS = new Set(["id", "_collection", "Last Updated", "Category Tags", "Logo URL", "offices"]);

  function isHiddenAdminField(key) {
    if (!key) return true;
    if (HIDDEN_KEYS.has(key)) return true;
    const normalized = String(key)
      .trim()
      .replace(/\s+/g, " ")
      .replace(/:+$/, "")
      .toLowerCase();
    // Keep logo management in the upload/dropzone section only.
    return normalized === "logo url" || normalized === "logo";
  }

  function isLegacyOfficeFieldKey(key) {
    const k = String(key || "").trim().replace(/:+$/, "").toLowerCase();
    return /^(address|city|state|zip|phone|phone number|telephone|tel)(\s*\d+)?$/.test(k);
  }

  let keysToRender = sortResourceFormFieldKeys(
    (() => {
      let list;
      if (isEdit) {
        list = Object.keys(docData || {}).filter((k) => !isHiddenAdminField(k));
      } else {
        const fromFirestore =
          Array.isArray(fieldKeyTemplate) && fieldKeyTemplate.length > 0
            ? fieldKeyTemplate.filter((k) => k && k !== "_collection")
            : null;
        if (fromFirestore) {
          list = fromFirestore.slice();
        } else {
          list = (currentHeaders || []).filter((k) => k && k !== "_collection");
        }
      }
      // Do not show or store Latitude/Longitude via admin — maps use geocoding from address.
      list = list.filter((k) => !MAP_COORD_FIELD_NAMES.includes(k));
      if (isDistrictAttorney) {
        list = list.filter((k) => !isLegacyOfficeFieldKey(k));
      }
      if (isEdit && !list.some((k) => COUNTY_FIELD_KEYS.has(k))) {
        const orgIdx = list.indexOf("Organization");
        if (orgIdx >= 0) list.splice(orgIdx + 1, 0, "County");
        else list.push("County");
      }
      return list;
    })()
  );
  // Always merge DA defaults for add and edit so fields like Website appear even when missing from Firestore.
  if (isDistrictAttorney) {
    const merged = new Set(keysToRender);
    DISTRICT_ATTORNEY_DEFAULT_FORM_KEYS.forEach((k) => merged.add(k));
    keysToRender = sortResourceFormFieldKeys([...merged]);
  }
  if (isDistrictAttorney && !keysToRender.some((k) => COUNTY_FIELD_KEYS.has(k))) {
    keysToRender = sortResourceFormFieldKeys([...keysToRender, "County"]);
  }
  const fields = {};
  const fieldsContainer = document.createElement("div");
  let collectDaOfficesForSave = null;

  function addFieldRow(key, value) {
    const row = document.createElement("div");
    row.dataset.adminFieldKey = key;
    row.className = "admin-resource-form__field-row";
    row.style.cssText = "margin-top:12px;width:100%;box-sizing:border-box;";

    const fieldWrap = document.createElement("div");
    fieldWrap.className = "admin-resource-form__field-wrap";
    fieldWrap.style.cssText =
      "display:flex;flex-direction:column;gap:6px;width:100%;min-width:0;box-sizing:border-box;";

    const label = document.createElement("label");
    label.textContent =
      isDistrictAttorney && key === "Website"
        ? "Website (general): "
        : `${key}: `;
    label.style.cssText = "display:block;font-size:0.86rem;font-weight:600;color:#334155;letter-spacing:0.01em;";

    const controlStyle =
      "flex:1 1 auto;min-width:0;max-width:100%;padding:11px 12px;box-sizing:border-box;border:1px solid #d5dbe3;border-radius:12px;background:#f8fafc;color:#0f172a;outline:none;transition:border-color .16s ease, box-shadow .16s ease, background-color .16s ease;";

    if (COUNTY_FIELD_KEYS.has(key)) {
      row.style.cssText =
        "display:flex;flex-wrap:nowrap;align-items:flex-start;gap:10px;margin-top:12px;width:100%;box-sizing:border-box;";
      fieldWrap.style.cssText =
        "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0;width:100%;box-sizing:border-box;";

      const hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.value = "";

      const idSuffix = `${key.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const panel = document.createElement("div");
      panel.className = "admin-county-checkboxes";
      panel.setAttribute("role", "group");
      panel.setAttribute("aria-label", `${key} — Alabama counties`);
      panel.style.cssText =
        "max-width:340px;max-height:240px;overflow-y:auto;overscroll-behavior:contain;border:1px solid #d5dbe3;border-radius:12px;padding:12px;box-sizing:border-box;background:#f8fafc;";

      const allCb = document.createElement("input");
      allCb.type = "checkbox";
      allCb.id = `admin-county-all-${idSuffix}`;
      allCb.style.cssText = "width:1.1rem;height:1.1rem;cursor:pointer;flex-shrink:0;";
      const allLabel = document.createElement("label");
      allLabel.htmlFor = allCb.id;
      allLabel.textContent = COUNTY_STATEWIDE_VALUE;
      allLabel.style.cssText = "font-weight:600;margin-left:8px;cursor:pointer;user-select:none;";
      const allRow = document.createElement("div");
      allRow.style.cssText =
        "display:flex;align-items:center;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border,#e4e6e9);";
      allRow.appendChild(allCb);
      allRow.appendChild(allLabel);
      panel.appendChild(allRow);

      const countyCbs = [];
      ALABAMA_COUNTY_NAMES.forEach((name) => {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = name;
        cb.id = `admin-county-${idSuffix}-${name.replace(/\s+/g, "-")}`;
        cb.style.cssText = "width:1.05rem;height:1.05rem;cursor:pointer;flex-shrink:0;";
        const lab = document.createElement("label");
        lab.htmlFor = cb.id;
        lab.textContent = name;
        lab.style.cssText = "margin-left:8px;cursor:pointer;user-select:none;flex:1;font-size:0.9rem;line-height:1.3;";
        const div = document.createElement("div");
        div.style.cssText = "display:flex;align-items:center;margin:4px 0;";
        div.appendChild(cb);
        div.appendChild(lab);
        panel.appendChild(div);
        countyCbs.push(cb);
      });

      const noteSlot = document.createElement("div");
      noteSlot.style.cssText = "margin-top:6px;";

      function syncHidden() {
        if (allCb.checked) {
          hidden.value = COUNTY_STATEWIDE_VALUE;
        } else {
          const selected = countyCbs.filter((c) => c.checked).map((c) => c.value);
          hidden.value = selected.join(", ");
        }
        if (
          isDistrictAttorney &&
          form._daCountySyncReady &&
          typeof form._daSyncCountyToOffices === "function"
        ) {
          form._daSyncCountyToOffices(hidden.value);
        }
      }

      function applyInitial(val) {
        noteSlot.innerHTML = "";
        allCb.checked = false;
        countyCbs.forEach((c) => {
          c.checked = false;
        });
        const v = normalizeField(val);
        if (!v) {
          syncHidden();
          return;
        }
        if (isStatewideCountyRaw(v) || v === COUNTY_STATEWIDE_VALUE) {
          allCb.checked = true;
          countyCbs.forEach((c) => {
            c.checked = true;
          });
          syncHidden();
          return;
        }
        const parts = v.split(/\s+and\s+|[,&]+/).map((s) => s.trim()).filter(Boolean);
        const unknown = [];
        parts.forEach((p) => {
          if (ALABAMA_COUNTY_NAMES.includes(p)) {
            const cb = countyCbs.find((c) => c.value === p);
            if (cb) cb.checked = true;
          } else {
            unknown.push(p);
          }
        });
        if (unknown.length > 0) {
          const note = document.createElement("p");
          note.style.cssText = "margin:0;font-size:0.8rem;color:#b45309;";
          note.textContent = `Other text in this field (not in the list): ${unknown.join(", ")} — stored value is still saved unless you change the selection above.`;
          noteSlot.appendChild(note);
        }
        syncHidden();
      }

      applyInitial(value);

      allCb.addEventListener("change", () => {
        if (allCb.checked) {
          countyCbs.forEach((c) => {
            c.checked = true;
          });
        } else {
          countyCbs.forEach((c) => {
            c.checked = false;
          });
        }
        syncHidden();
      });
      countyCbs.forEach((cb) => {
        cb.addEventListener("change", () => {
          if (!cb.checked && allCb.checked) {
            allCb.checked = false;
          } else if (cb.checked && countyCbs.every((c) => c.checked)) {
            allCb.checked = true;
          }
          syncHidden();
        });
      });

      fieldWrap.appendChild(label);
      fieldWrap.appendChild(panel);
      fieldWrap.appendChild(noteSlot);
      fieldWrap.appendChild(hidden);
      row.appendChild(fieldWrap);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "✕";
      removeBtn.title = "Remove field";
      removeBtn.style.cssText =
        "padding:5px 10px;cursor:pointer;background:#e74c3c;color:#fff;border:none;border-radius:4px;font-size:1rem;flex-shrink:0;align-self:flex-start;margin-top:22px;";
      removeBtn.addEventListener("click", () => {
        const confirmed = confirm(`Remove the field "${key}"?`);
        if (!confirmed) return;
        delete fields[key];
        row.remove();
      });
      row.appendChild(removeBtn);

      fields[key] = hidden;
      fieldsContainer.appendChild(row);
      return;
    }

    const input = document.createElement("input");
    const keyNorm = String(key || "")
      .trim()
      .replace(/:+$/, "")
      .toLowerCase();
    const isCoord = keyNorm === "latitude" || keyNorm === "longitude";
    input.type = isCoord ? "number" : "text";
    if (isCoord) {
      input.step = "any";
      input.inputMode = "decimal";
      label.textContent = key + " (decimal, WGS84): ";
    }
    input.value = value;
    input.style.cssText = controlStyle;
    input.addEventListener("focus", () => {
      input.style.borderColor = "rgba(13, 148, 136, 0.55)";
      input.style.boxShadow = "0 0 0 3px rgba(13, 148, 136, 0.14)";
      input.style.background = "#ffffff";
    });
    input.addEventListener("blur", () => {
      input.style.borderColor = "#d5dbe3";
      input.style.boxShadow = "none";
      input.style.background = "#f8fafc";
    });

    const inputRow = document.createElement("div");
    inputRow.className = "admin-resource-form__input-row";
    inputRow.style.cssText =
      "display:flex;flex-wrap:nowrap;align-items:center;gap:10px;width:100%;min-width:0;box-sizing:border-box;";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove field";
    removeBtn.className = "admin-resource-form__remove-field";
    removeBtn.style.cssText =
      "padding:5px 10px;cursor:pointer;background:#e74c3c;color:#fff;border:none;border-radius:4px;font-size:1rem;flex-shrink:0;";
    removeBtn.addEventListener("click", () => {
      const confirmed = confirm(`Remove the field "${key}"?`);
      if (!confirmed) return;
      delete fields[key];
      row.remove();
    });

    fieldWrap.appendChild(label);
    inputRow.appendChild(input);
    inputRow.appendChild(removeBtn);
    fieldWrap.appendChild(inputRow);
    row.appendChild(fieldWrap);

    fields[key] = input;
    fieldsContainer.appendChild(row);
  }

  keysToRender.forEach((key) => {
    if (isHiddenAdminField(key)) return;
    const val = isEdit && docData && docData[key] != null ? String(docData[key]) : "";
    addFieldRow(key, val);
  });

  formInner.appendChild(fieldsContainer);

  if (isDistrictAttorney) {
    const daOfficesWrap = document.createElement("div");
    daOfficesWrap.className = "da-offices-wrap";

    const daOfficesTitle = document.createElement("h3");
    daOfficesTitle.textContent = "Office Locations";
    daOfficesTitle.className = "da-offices-title";
    daOfficesWrap.appendChild(daOfficesTitle);

    const daOfficeList = document.createElement("div");
    daOfficeList.className = "da-office-list";
    daOfficesWrap.appendChild(daOfficeList);

    const addOfficeBtn = document.createElement("button");
    addOfficeBtn.type = "button";
    addOfficeBtn.textContent = "Add office";
    addOfficeBtn.className = "da-office-add-btn";
    daOfficesWrap.appendChild(addOfficeBtn);

    const daOfficeEditors = [];

    /** Counties currently selected in the County/Counties checkbox field (all 67 if statewide). */
    function parseAdminSelectedCountyNames(raw) {
      const v = normalizeField(raw);
      if (!v) return [];
      if (isStatewideCountyRaw(v) || v === COUNTY_STATEWIDE_VALUE) {
        return [...ALABAMA_COUNTY_NAMES];
      }
      return v
        .split(/\s+and\s+|[,&]+/)
        .map((t) => t.trim())
        .filter((p) => ALABAMA_COUNTY_NAMES.includes(p));
    }

    function populateCountySelectOptions(countySelect, initialCounty) {
      const ch = fields["County"] || fields["Counties"];
      const allowed = parseAdminSelectedCountyNames(ch ? ch.value : "");
      const allowedSet = new Set(allowed);
      const want = normalizeField(initialCounty || "");
      countySelect.innerHTML = "";
      const opt0 = document.createElement("option");
      opt0.value = "";
      opt0.textContent = "Select county…";
      countySelect.appendChild(opt0);
      ALABAMA_COUNTY_NAMES.forEach((name) => {
        if (!allowedSet.has(name)) return;
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        countySelect.appendChild(opt);
      });
      if (want && allowedSet.has(want)) countySelect.value = want;
      else countySelect.value = "";
    }

    function refreshAllOfficeCountySelects() {
      daOfficeEditors.forEach((entry) => {
        if (!entry.countySelect) return;
        const cur = entry.countySelect.value;
        populateCountySelectOptions(entry.countySelect, cur);
        entry.syncHeading();
        entry.updateDetailVisibility();
      });
    }

    function refreshOfficeNumbers() {
      daOfficeEditors.forEach((e, i) => {
        e.officeIndex = i + 1;
        e.syncHeading();
      });
    }

    function addOfficeEditor(initial = {}) {
      const officeCard = document.createElement("div");
      officeCard.className = "da-office-card";

      const officeTitleEl = document.createElement("p");
      officeTitleEl.className = "da-office-card__title";

      const countyWrap = document.createElement("label");
      countyWrap.className = "admin-event-form__field";
      const countySpan = document.createElement("span");
      countySpan.textContent = "County";
      const countySelect = document.createElement("select");
      countySelect.className = "da-office-card__select";
      populateCountySelectOptions(countySelect, initial.county || "");
      countyWrap.appendChild(countySpan);
      countyWrap.appendChild(countySelect);

      const countyHint = document.createElement("p");
      countyHint.className = "da-office-card__hint";
      countyHint.textContent =
        "Only counties checked in the County field above appear here. Each office has its own county; checking a new county above adds one office with that county; existing offices are not changed.";

      const detailPanel = document.createElement("div");
      detailPanel.className = "da-office-card__detail";

      function addInputToDetail(labelText, value, opts = {}) {
        const wrap = document.createElement("label");
        wrap.className = "admin-event-form__field";
        const span = document.createElement("span");
        span.textContent = labelText;
        const input = document.createElement("input");
        input.type = "text";
        input.value = normalizeField(value);
        input.placeholder = opts.placeholder || "";
        input.className = "da-office-card__input";
        wrap.appendChild(span);
        wrap.appendChild(input);
        detailPanel.appendChild(wrap);
        return input;
      }

      const labelInput = addInputToDetail("Label (optional)", initial.label || "");
      const addressInput = addInputToDetail("Address", initial.address || "");
      const cityInput = addInputToDetail("City", initial.city || "");
      const stateInput = addInputToDetail("State", initial.state || "AL");
      const zipInput = addInputToDetail("Zip", initial.zip || "");
      const phoneInput = addInputToDetail("Phone", initial.phone || "");

      const websiteFieldWrap = document.createElement("label");
      websiteFieldWrap.className = "da-office-website-wrap admin-event-form__field";
      const websiteSpan = document.createElement("span");
      websiteSpan.textContent = "Office website";
      const websiteInput = document.createElement("input");
      websiteInput.type = "text";
      websiteInput.value = normalizeField(initial.website || "");
      websiteInput.placeholder = "https://";
      websiteInput.className = "da-office-card__input";
      websiteFieldWrap.appendChild(websiteSpan);
      websiteFieldWrap.appendChild(websiteInput);

      const controls = document.createElement("div");
      controls.className = "da-office-card__controls";
      const primaryLabel = document.createElement("label");
      primaryLabel.className = "da-office-card__primary";
      const primaryCb = document.createElement("input");
      primaryCb.type = "checkbox";
      primaryCb.checked = Boolean(initial.isPrimary);
      primaryLabel.appendChild(primaryCb);
      primaryLabel.appendChild(document.createTextNode("Primary office"));
      controls.appendChild(primaryLabel);

      const removeOfficeBtn = document.createElement("button");
      removeOfficeBtn.type = "button";
      removeOfficeBtn.textContent = "Remove office";
      removeOfficeBtn.className = "da-office-card__remove";
      controls.appendChild(removeOfficeBtn);

      const entry = {
        card: officeCard,
        officeIndex: 1,
        syncHeading() {
          const c = countySelect.value.trim();
          officeTitleEl.textContent = c
            ? `Office ${this.officeIndex}: ${c}`
            : `Office ${this.officeIndex}: (select county)`;
        },
        read: () => ({
          label: labelInput.value.trim(),
          address: addressInput.value.trim(),
          city: cityInput.value.trim(),
          state: (stateInput.value.trim() || "AL"),
          zip: zipInput.value.trim(),
          phone: phoneInput.value.trim(),
          website: websiteInput.value.trim(),
          county: countySelect.value.trim(),
          isPrimary: primaryCb.checked,
        }),
        websiteFieldWrap,
        countySelect,
        updateDetailVisibility,
      };

      function updateDetailVisibility() {
        const hasCounty = countySelect.value.trim() !== "";
        const hasAnyDetail =
          labelInput.value.trim() ||
          addressInput.value.trim() ||
          cityInput.value.trim() ||
          zipInput.value.trim() ||
          phoneInput.value.trim() ||
          websiteInput.value.trim();
        detailPanel.classList.toggle("is-visible", Boolean(hasCounty || hasAnyDetail));
      }

      countySelect.addEventListener("change", () => {
        entry.syncHeading();
        updateDetailVisibility();
      });

      removeOfficeBtn.addEventListener("click", () => {
        if (daOfficeEditors.length <= 1) {
          alert("At least one office row is required.");
          return;
        }
        const idx = daOfficeEditors.findIndex((e) => e.card === officeCard);
        if (idx >= 0) daOfficeEditors.splice(idx, 1);
        officeCard.remove();
        refreshOfficeNumbers();
        syncDaWebsiteFieldVisibility();
      });

      officeCard.appendChild(officeTitleEl);
      officeCard.appendChild(countyWrap);
      officeCard.appendChild(countyHint);
      officeCard.appendChild(websiteFieldWrap);
      officeCard.appendChild(detailPanel);
      officeCard.appendChild(controls);

      daOfficeEditors.push(entry);
      refreshOfficeNumbers();
      updateDetailVisibility();
      entry.syncHeading();

      daOfficeList.appendChild(officeCard);
    }

    function syncDaWebsiteFieldVisibility() {
      const mainRow = fieldsContainer.querySelector('[data-admin-field-key="Website"]');
      if (mainRow) mainRow.style.display = "";
    }

    function syncOfficeRowsToCountyField(raw) {
      const v = normalizeField(raw);
      const prev = normalizeField(form._daPrevCountyHidden || "");
      form._daPrevCountyHidden = v;
      try {
        if (!v || isStatewideCountyRaw(v) || v === COUNTY_STATEWIDE_VALUE) {
          refreshOfficeNumbers();
          syncDaWebsiteFieldVisibility();
          return;
        }
        const parts = v.split(/\s+and\s+|[,&]+/).map((t) => t.trim()).filter(Boolean);
        if (parts.length === 0) {
          refreshOfficeNumbers();
          syncDaWebsiteFieldVisibility();
          return;
        }
        const prevParts = prev
          ? prev.split(/\s+and\s+|[,&]+/).map((t) => t.trim()).filter(Boolean)
          : [];
        const prevSet = new Set(prevParts);
        const added = parts.filter((p) => !prevSet.has(p));
        for (const newCounty of added) {
          if (!ALABAMA_COUNTY_NAMES.includes(newCounty)) continue;
          addOfficeEditor({ state: "AL", county: newCounty });
        }
        refreshOfficeNumbers();
        syncDaWebsiteFieldVisibility();
      } finally {
        refreshAllOfficeCountySelects();
      }
    }

    form._daSyncCountyToOffices = syncOfficeRowsToCountyField;

    const countyPartsOrdered = getResourceCountyPartsOrdered(docData || {});
    const rawOffices = isEdit ? getResourceOfficeBlocks(docData || {}) : [];
    const officeRowCount = Math.max(1, countyPartsOrdered.length, rawOffices.length);
    for (let i = 0; i < officeRowCount; i++) {
      const o = rawOffices[i] || {};
      addOfficeEditor({
        ...o,
        county: normalizeField(o.county || ""),
        state: o.state || "AL",
        isPrimary: o.isPrimary !== undefined ? o.isPrimary : i === 0,
        website: normalizeField(o.website || ""),
      });
    }

    addOfficeBtn.addEventListener("click", () => {
      addOfficeEditor({ state: "AL" });
      syncDaWebsiteFieldVisibility();
    });

    collectDaOfficesForSave = () =>
      daOfficeEditors
        .map((entry, i) => ({ ...entry.read(), index: i + 1 }))
        .filter(
          (o) =>
            o.address ||
            o.city ||
            o.zip ||
            o.phone ||
            o.label ||
            o.county ||
            o.website
        );

    syncDaWebsiteFieldVisibility();

    const countyHiddenForInit = fields["County"] || fields["Counties"];
    if (countyHiddenForInit) {
      form._daPrevCountyHidden = normalizeField(countyHiddenForInit.value || "");
    }

    form._daCountySyncReady = true;

    formInner.appendChild(daOfficesWrap);
  }

  // ---- Logo upload zone ----
  let pendingLogoFile = null;
  let removeLogo = false;
  const existingLogoURL = isEdit ? (docData?.["Logo URL"] || "") : "";

  const logoFieldset = document.createElement("fieldset");
  logoFieldset.className = "admin-logo-upload";

  const logoLegend = document.createElement("legend");
  logoLegend.className = "admin-logo-upload__legend";
  logoLegend.textContent = "Logo";
  logoFieldset.appendChild(logoLegend);

  const dropZone = document.createElement("div");
  dropZone.className = "admin-logo-upload__dropzone";

  const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
  const ALLOWED_EXT = /\.(jpe?g|png|webp)$/i;
  const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB

  function validateLogoFile(file) {
    if (!file) return "No file selected.";
    if (!ALLOWED_MIME.has(file.type) || !ALLOWED_EXT.test(file.name)) {
      return "Only JPEG, PNG, and WebP images are allowed.\nSVG, GIF, and other file types are not permitted.";
    }
    if (file.size > MAX_LOGO_BYTES) {
      return `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is 5 MB.`;
    }
    return null;
  }

  const dropLabel = document.createElement("span");
  dropLabel.className = "admin-logo-upload__label";
  dropLabel.textContent = "Drag & drop an image or click to browse";

  const dropHint = document.createElement("span");
  dropHint.className = "admin-logo-upload__hint";
  dropHint.textContent = "JPEG, PNG, or WebP — max 5 MB";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".jpg,.jpeg,.png,.webp";
  fileInput.className = "admin-logo-upload__input";

  dropZone.appendChild(dropLabel);
  dropZone.appendChild(dropHint);
  dropZone.appendChild(fileInput);
  logoFieldset.appendChild(dropZone);

  const previewContainer = document.createElement("div");
  previewContainer.className = "admin-logo-preview";
  previewContainer.style.display = "none";

  const previewImg = document.createElement("img");
  previewImg.className = "admin-logo-preview__img";
  previewImg.alt = "Logo preview";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "admin-logo-preview__remove";
  removeBtn.textContent = "Remove";

  previewContainer.appendChild(previewImg);
  previewContainer.appendChild(removeBtn);
  logoFieldset.appendChild(previewContainer);

  function showPreview(src) {
    previewImg.src = src;
    previewContainer.style.display = "";
    dropZone.style.display = "none";
  }

  function clearPreview() {
    previewImg.src = "";
    previewContainer.style.display = "none";
    dropZone.style.display = "";
    fileInput.value = "";
    pendingLogoFile = null;
  }

  if (existingLogoURL) {
    showPreview(existingLogoURL);
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const err = validateLogoFile(file);
    if (err) {
      alert(err);
      fileInput.value = "";
      return;
    }
    pendingLogoFile = file;
    removeLogo = false;
    showPreview(URL.createObjectURL(file));
  });

  dropZone.addEventListener("click", () => fileInput.click());

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("admin-logo-upload__dropzone--active");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("admin-logo-upload__dropzone--active");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("admin-logo-upload__dropzone--active");
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const err = validateLogoFile(file);
    if (err) {
      alert(err);
      return;
    }
    pendingLogoFile = file;
    removeLogo = false;
    fileInput.files = e.dataTransfer.files;
    showPreview(URL.createObjectURL(file));
  });

  removeBtn.addEventListener("click", () => {
    clearPreview();
    removeLogo = true;
  });

  formInner.appendChild(logoFieldset);

  const defaultCategory = !isEdit && collectionName && COLLECTION_TO_CATEGORY[collectionName] ? [COLLECTION_TO_CATEGORY[collectionName]] : [];
  const selectedTagSet = new Set(
    (isEdit ? getCategoryTags(docData || {}) : defaultCategory)
      .map((tag) => String(tag).toLowerCase())
  );
  const categoryTagCheckboxes = [];
  const checklist = document.createElement("fieldset");
  checklist.className = "admin-category-checklist";

  const checklistLegend = document.createElement("legend");
  checklistLegend.className = "admin-category-checklist__legend";
  checklistLegend.textContent = "Categories";
  checklist.appendChild(checklistLegend);

  resourceCategories.forEach((category) => {
    const option = document.createElement("label");
    option.className = "admin-category-checklist__option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = category;
    checkbox.checked = selectedTagSet.has(category.toLowerCase());
    categoryTagCheckboxes.push(checkbox);

    option.appendChild(checkbox);
    option.appendChild(document.createTextNode(category));
    checklist.appendChild(option);
  });

  formInner.appendChild(checklist);

  const buttonContainer = document.createElement("div");
  buttonContainer.style.cssText = "margin-top:22px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:nowrap;";
  const leftActions = document.createElement("div");
  leftActions.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;";
  const rightActions = document.createElement("div");
  rightActions.style.cssText = "display:flex;gap:10px;align-items:center;justify-content:flex-end;min-width:max-content;";

  const saveButton = document.createElement("button");
  saveButton.textContent = "Save";
  saveButton.style.cssText = "padding:12px 20px;font-size:1rem;font-family:inherit;font-weight:600;cursor:pointer;border:none;border-radius:12px;background:var(--teal,#0e7c8c);color:#fff;transition:background-color .2s ease, transform .1s ease, opacity .2s ease;";
  saveButton.addEventListener("mouseenter", () => {
    if (!saveButton.disabled) saveButton.style.background = "var(--teal-hover,#0a6573)";
  });
  saveButton.addEventListener("mouseleave", () => {
    saveButton.style.background = "var(--teal,#0e7c8c)";
  });
  saveButton.addEventListener("mousedown", () => {
    if (!saveButton.disabled) saveButton.style.transform = "scale(0.98)";
  });
  saveButton.addEventListener("mouseup", () => {
    saveButton.style.transform = "scale(1)";
  });

  const cancelButton = document.createElement("button");
  cancelButton.textContent = "Cancel";
  cancelButton.style.cssText = "padding:12px 20px;font-size:1rem;font-family:inherit;font-weight:600;cursor:pointer;border:2px solid var(--border,#dfe3e8);border-radius:12px;background:var(--bg-card,#fff);color:var(--text,#1f2937);transition:background-color .2s ease, border-color .2s ease, color .2s ease;";
  cancelButton.addEventListener("mouseenter", () => {
    cancelButton.style.borderColor = "var(--teal,#0e7c8c)";
    cancelButton.style.background = "rgba(14, 124, 140, 0.06)";
  });
  cancelButton.addEventListener("mouseleave", () => {
    cancelButton.style.borderColor = "var(--border,#dfe3e8)";
    cancelButton.style.background = "var(--bg-card,#fff)";
  });

  const overlay = document.createElement("div");
  overlay.style.cssText = "position: fixed; inset: 0; background: rgba(15, 23, 42, 0.42); backdrop-filter: blur(2px); z-index: 999;";
  overlay.addEventListener(
    "wheel",
    (e) => {
      if (e.target === overlay) e.preventDefault();
    },
    { passive: false }
  );
  overlay.addEventListener(
    "touchmove",
    (e) => {
      if (e.target === overlay) e.preventDefault();
    },
    { passive: false }
  );

  const previousBodyOverflow = document.body.style.overflow;
  const previousBodyOverscroll = document.body.style.overscrollBehavior;
  document.body.style.overflow = "hidden";
  document.body.style.overscrollBehavior = "none";

  function closeForm() {
    window.removeEventListener("resize", applyResourceModalPosition);
    document.body.style.overflow = previousBodyOverflow;
    document.body.style.overscrollBehavior = previousBodyOverscroll;
    if (form.parentNode) form.parentNode.removeChild(form);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  saveButton.addEventListener("click", async () => {
    try {
      saveButton.disabled = true;
      saveButton.textContent = "Saving…";

      const originalEditableKeys =
        isEdit && docData
          ? Object.keys(docData).filter(
              (k) => !isHiddenAdminField(k) && k !== "Category Tags"
            )
          : [];

      const payload = {};
      Object.keys(fields).forEach((key) => {
        const value = fields[key].value.trim();
        if (key === "Judicial Circuit" && value !== "") {
          const num = parseInt(value, 10);
          payload[key] = isNaN(num) ? value : num;
        } else {
          payload[key] = value || null;
        }
      });

      if (isEdit) {
        for (const k of originalEditableKeys) {
          if (!Object.prototype.hasOwnProperty.call(fields, k)) {
            payload[k] = deleteField();
          }
        }
      }

      if (isDistrictAttorney && collectDaOfficesForSave) {
        let offices = collectDaOfficesForSave();
        const fromOffices = offices.map((o) => normalizeField(o.county || "")).filter(Boolean);
        const topCountyField = (fields["County"]?.value || fields["Counties"]?.value || "").trim();
        if (topCountyField) {
          payload.County = topCountyField;
        } else if (fromOffices.length > 0) {
          payload.County = fromOffices.join(", ");
        }
        // General DA website stays in `Website` from the form; per-office URLs live on each `offices[]` entry (including a single office).
        payload.offices = offices.length > 0 ? offices : null;
      }

      const selectedTags = categoryTagCheckboxes
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => normalizeCategoryTag(checkbox.value))
        .filter(Boolean);
      payload["Category Tags"] = selectedTags.length > 0 ? selectedTags : null;
      payload["Last Updated"] = getTodayMMDDYYYY();

      let docId;

      if (isEdit) {
        docId = docData.id;

        if (pendingLogoFile) {
          const logoRef = storageRef(storage, `logos/${collectionName}/${docId}`);
          await uploadBytes(logoRef, pendingLogoFile);
          payload["Logo URL"] = await getDownloadURL(logoRef);
        } else if (removeLogo && existingLogoURL) {
          try {
            const logoRef = storageRef(storage, `logos/${collectionName}/${docId}`);
            await deleteObject(logoRef);
          } catch (_) { /* file may not exist */ }
          payload["Logo URL"] = null;
        }

        const docRef = doc(firestore, collectionName, docId);
        await updateDoc(docRef, {
          ...payload,
          Latitude: deleteField(),
          Longitude: deleteField(),
        });
        alert("Document updated successfully!");
      } else {
        const hasDuplicate = await isDuplicateDocument(collectionName, payload);
        if (hasDuplicate) {
          const override = confirm(
            "A resource with the same name/organization already exists.\n\nClick OK to add it anyway, or Cancel to go back and edit."
          );
          if (!override) {
            saveButton.disabled = false;
            saveButton.textContent = "Save";
            return;
          }
        }
        const collectionRef = collection(firestore, collectionName);
        const newDocRef = await addDoc(collectionRef, payload);
        docId = newDocRef.id;

        if (pendingLogoFile) {
          const logoRef = storageRef(storage, `logos/${collectionName}/${docId}`);
          await uploadBytes(logoRef, pendingLogoFile);
          const logoURL = await getDownloadURL(logoRef);
          await updateDoc(doc(firestore, collectionName, docId), { "Logo URL": logoURL });
        }

        alert("Resource added successfully!");
      }

      closeForm();
      loadCollection(currentCollectionName || collectionName);
    } catch (error) {
      const action = isEdit ? "updating" : "adding";
      console.error(`Error ${action} document:`, error);
      alert(`Error ${action} document: ` + error.message);
      saveButton.disabled = false;
      saveButton.textContent = "Save";
    }
  });

  cancelButton.addEventListener("click", closeForm);
  overlay.addEventListener("click", closeForm);

  leftActions.appendChild(cancelButton);

  if (isEdit) {
    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Delete";
    deleteButton.style.cssText = "padding:12px 20px;font-size:1rem;font-family:inherit;font-weight:600;cursor:pointer;border:none;border-radius:12px;background:#e74c3c;color:#fff;transition:background-color .2s ease, transform .1s ease;";
    deleteButton.addEventListener("mouseenter", () => {
      deleteButton.style.background = "#cf3c2d";
    });
    deleteButton.addEventListener("mouseleave", () => {
      deleteButton.style.background = "#e74c3c";
    });
    deleteButton.addEventListener("mousedown", () => {
      deleteButton.style.transform = "scale(0.98)";
    });
    deleteButton.addEventListener("mouseup", () => {
      deleteButton.style.transform = "scale(1)";
    });

    deleteButton.addEventListener("click", async () => {
      const confirmed = window.confirm("Are you sure you want to delete this resource?");
      if (!confirmed) return;

      try {
        const docRef = doc(firestore, collectionName, docData.id);
        await deleteDoc(docRef);
        alert("Resource deleted successfully!");
        closeForm();
        loadCollection(currentCollectionName || collectionName);
      } catch (error) {
        console.error("Error deleting document:", error);
        alert("Error deleting document: " + error.message);
      }
    });

    leftActions.appendChild(deleteButton);
  }

  rightActions.appendChild(saveButton);
  buttonContainer.appendChild(leftActions);
  buttonContainer.appendChild(rightActions);

  formInner.appendChild(buttonContainer);
  form.appendChild(formInner);
  document.body.appendChild(overlay);
  document.body.appendChild(form);
}

// Function to edit a document in Firestore
async function editDocument(docData) {
  if (!docData.id) {
    console.error("No document ID found");
    return;
  }

  const targetCollectionName = docData._collection || currentCollectionName;
  if (!targetCollectionName) {
    console.error("No collection name found");
    alert("Error: Collection name not found. Please refresh the page.");
    return;
  }

  try {
    const docRef = doc(firestore, targetCollectionName, docData.id);
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      alert("This resource could not be found. It may have been deleted.");
      return;
    }
    const freshDocData = {
      id: snap.id,
      _collection: targetCollectionName,
      ...snap.data(),
    };
    renderResourceForm({
      mode: "edit",
      collectionName: targetCollectionName,
      docData: freshDocData,
    });
  } catch (err) {
    console.error("Failed to load resource for edit:", err);
    alert("Could not load this resource from the database. Please try again.");
  }
}

// Function to create a new document in Firestore
async function openCreateResourceForm() {
  if (!currentCollectionName) {
    console.error("No collection selected");
    alert("Error: No collection selected. Please select a collection first.");
    return;
  }

  const fieldKeyTemplate = await fetchSampleFieldKeysForCollection(currentCollectionName);

  renderResourceForm({
    mode: "create",
    collectionName: currentCollectionName,
    fieldKeyTemplate,
  });
}

// ========== Manage Tags Form ==========
function closeManageTagsForm() {
  document.querySelectorAll(".admin-manage-tags-overlay").forEach((el) => el.remove());
  document.querySelectorAll(".admin-manage-tags-dialog").forEach((el) => el.remove());
  renderCategoryButtons();
}

function openManageTagsForm() {
  if (document.querySelector(".admin-manage-tags-overlay")) {
    closeManageTagsForm();
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "admin-manage-tags-overlay";

  const dialog = document.createElement("div");
  dialog.className = "admin-manage-tags-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "admin-manage-tags-title");

  const title = document.createElement("h2");
  title.id = "admin-manage-tags-title";
  title.className = "admin-manage-tags-dialog__title";
  title.textContent = "Manage Category Tags";
  dialog.appendChild(title);

  const tagListContainer = document.createElement("div");
  tagListContainer.className = "admin-manage-tags-dialog__list";

  function renderTagList() {
    tagListContainer.innerHTML = "";
    if (resourceTagDocMetas.length === 0) {
      const empty = document.createElement("p");
      empty.className = "admin-manage-tags-dialog__empty";
      empty.textContent = "No tags found.";
      tagListContainer.appendChild(empty);
      return;
    }
    resourceTagDocMetas.forEach(({ rawId, display }) => {
      const row = document.createElement("div");
      row.className = "admin-manage-tags-dialog__tag-row";

      const label = document.createElement("span");
      label.className = "admin-manage-tags-dialog__tag-label";
      label.textContent = display;
      if (rawId !== display) {
        label.title = `Stored tag id (has extra spaces): ${rawId}`;
      }
      row.appendChild(label);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "Remove";
      removeBtn.className = "admin-top-bar__btn admin-top-bar__btn--logout admin-manage-tags-dialog__btn-compact";
      removeBtn.addEventListener("click", async () => {
        const confirmed = confirm(`Remove the tag "${display}"? This will not remove it from existing resources.`);
        if (!confirmed) return;
        try {
          const tagDocRef = doc(firestore, "Resource Tags", rawId);
          await deleteDoc(tagDocRef);
          await fetchResourceTags();
          renderTagList();
        } catch (err) {
          console.error("Error removing tag:", err);
          alert("Error removing tag: " + err.message);
        }
      });
      row.appendChild(removeBtn);
      tagListContainer.appendChild(row);
    });
  }

  renderTagList();
  dialog.appendChild(tagListContainer);

  const addRow = document.createElement("div");
  addRow.className = "admin-manage-tags-dialog__add-row";

  const newTagInput = document.createElement("input");
  newTagInput.type = "text";
  newTagInput.className = "admin-manage-tags-dialog__input";
  newTagInput.placeholder = "New tag name...";
  newTagInput.setAttribute("autocomplete", "off");

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "Add";
  addBtn.className = "admin-top-bar__btn admin-top-bar__btn--primary";
  addBtn.addEventListener("click", async () => {
    const tagName = normalizeCategoryTag(newTagInput.value);
    if (!tagName) {
      alert("Please enter a tag name.");
      return;
    }
    if (resourceCategories.includes(tagName)) {
      alert("This tag already exists.");
      return;
    }
    try {
      const tagDocRef = doc(firestore, "Resource Tags", tagName);
      await setDoc(tagDocRef, { createdAt: getTodayMMDDYYYY() });
      await fetchResourceTags();
      renderTagList();
      newTagInput.value = "";
    } catch (err) {
      console.error("Error adding tag:", err);
      alert("Error adding tag: " + err.message);
    }
  });

  addRow.appendChild(newTagInput);
  addRow.appendChild(addBtn);
  dialog.appendChild(addRow);

  const footer = document.createElement("div");
  footer.className = "admin-manage-tags-dialog__footer";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.className = "admin-top-bar__btn";
  footer.appendChild(closeBtn);
  dialog.appendChild(footer);

  closeBtn.addEventListener("click", closeManageTagsForm);
  overlay.addEventListener("click", closeManageTagsForm);

  document.body.appendChild(overlay);
  document.body.appendChild(dialog);
}

// ========== Manage Accounts (admin-accounts.html) ==========

function initManageAccounts() {
  const tableBody = document.getElementById("accounts-table-body");
  const statusEl = document.getElementById("accounts-status");
  const addForm = document.getElementById("add-account-form");
  if (!tableBody) return;

  const listAdminUsers = httpsCallable(functions, "listAdminUsers");
  const createAdminUser = httpsCallable(functions, "createAdminUser");
  const deleteAdminUser = httpsCallable(functions, "deleteAdminUser");
  const updateAdminPermissions = httpsCallable(functions, "updateAdminPermissions");

  function makePermCheckbox(name, checked, disabled) {
    const label = document.createElement("label");
    label.className = "perm-checkbox";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.disabled = disabled;
    cb.dataset.perm = name;
    label.appendChild(cb);
    label.append(" " + name.replace("can", ""));
    return label;
  }

  async function loadAccounts() {
    statusEl.textContent = "Loading accounts...";
    tableBody.innerHTML = "";
    try {
      const result = await listAdminUsers();
      const users = result.data;

      const currentUser = getAuth().currentUser;
      if (currentUser) {
        await currentUser.getIdToken(true);
      }

      statusEl.textContent = "";

      if (!users || users.length === 0) {
        statusEl.textContent = "No accounts found.";
        return;
      }

      users.forEach((user) => {
        const isMaster = user.permissions?.masterAdmin === true;
        const perms = user.permissions || {};
        const tr = document.createElement("tr");

        const tdEmail = document.createElement("td");
        tdEmail.textContent = user.email;
        tr.appendChild(tdEmail);

        const tdPerms = document.createElement("td");
        if (isMaster) {
          tdPerms.textContent = "All (Master)";
        } else {
          const permsWrap = document.createElement("div");
          permsWrap.className = "perms-cell";
          permsWrap.appendChild(makePermCheckbox("canCreate", perms.canCreate, false));
          permsWrap.appendChild(makePermCheckbox("canEdit", perms.canEdit, false));
          permsWrap.appendChild(makePermCheckbox("canDelete", perms.canDelete, false));

          const saveBtn = document.createElement("button");
          saveBtn.type = "button";
          saveBtn.textContent = "Save";
          saveBtn.className = "perm-save-btn";
          saveBtn.addEventListener("click", async () => {
            const boxes = permsWrap.querySelectorAll("input[type=checkbox]");
            const claims = {};
            boxes.forEach((b) => { claims[b.dataset.perm] = b.checked; });

            saveBtn.disabled = true;
            saveBtn.textContent = "Saving...";
            try {
              await updateAdminPermissions({ uid: user.uid, ...claims });
              saveBtn.textContent = "Saved!";
              setTimeout(() => { saveBtn.textContent = "Save"; saveBtn.disabled = false; }, 1500);
            } catch (err) {
              console.error("updateAdminPermissions:", err);
              alert("Error updating permissions: " + formatFunctionsClientError(err));
              saveBtn.textContent = "Save";
              saveBtn.disabled = false;
            }
          });
          permsWrap.appendChild(saveBtn);
          tdPerms.appendChild(permsWrap);
        }
        tr.appendChild(tdPerms);

        const tdCreated = document.createElement("td");
        tdCreated.textContent = user.creationTime
          ? new Date(user.creationTime).toLocaleDateString()
          : "";
        tr.appendChild(tdCreated);

        const tdActions = document.createElement("td");
        if (!isMaster) {
          const deleteBtn = document.createElement("button");
          deleteBtn.type = "button";
          deleteBtn.textContent = "Delete";
          deleteBtn.className = "admin-top-bar__btn admin-top-bar__btn--logout";
          deleteBtn.style.padding = "6px 14px";
          deleteBtn.style.fontSize = "0.85rem";
          deleteBtn.addEventListener("click", async () => {
            if (!confirm(`Delete account "${user.email}"? This cannot be undone.`)) return;
            deleteBtn.disabled = true;
            deleteBtn.textContent = "Deleting...";
            try {
              await deleteAdminUser({ uid: user.uid });
              await loadAccounts();
            } catch (err) {
              console.error("deleteAdminUser:", err);
              alert("Error deleting account: " + formatFunctionsClientError(err));
              deleteBtn.disabled = false;
              deleteBtn.textContent = "Delete";
            }
          });
          tdActions.appendChild(deleteBtn);
        } else {
          tdActions.textContent = "Master";
        }
        tr.appendChild(tdActions);
        tableBody.appendChild(tr);
      });
    } catch (err) {
      console.error("Error loading accounts:", err);
      statusEl.textContent = "Error loading accounts: " + formatFunctionsClientError(err);
    }
  }

  if (addForm) {
    const addStatus = document.getElementById("add-account-status");
    addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("new-account-email").value.trim();
      const password = document.getElementById("new-account-password").value;
      const canCreate = addForm.querySelector('input[name="canCreate"]').checked;
      const canEdit = addForm.querySelector('input[name="canEdit"]').checked;
      const canDelete = addForm.querySelector('input[name="canDelete"]').checked;
      const submitBtn = document.getElementById("create-account-button");

      if (addStatus) addStatus.textContent = "";
      if (submitBtn) submitBtn.disabled = true;

      try {
        await createAdminUser({ email, password, canCreate, canEdit, canDelete });
        addForm.reset();
        if (addStatus) {
          addStatus.textContent = "Account created successfully.";
          addStatus.style.color = "#0a7a28";
        }
        await loadAccounts();
      } catch (err) {
        console.error("createAdminUser:", err);
        const msg = formatFunctionsClientError(err) || "Failed to create account.";
        if (addStatus) {
          addStatus.textContent = msg;
          addStatus.style.color = "#b00020";
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  const auth = getAuth();
  const unsubAccountsInit = onAuthStateChanged(auth, (user) => {
    unsubAccountsInit();
    if (!user) {
      if (statusEl) statusEl.textContent = "";
      return;
    }
    void loadAccounts();
  });
}

// Initialize collection dropdown on page load (after fetching tags)
async function initAdmin() {
  await fetchResourceTags();
  initializeCollectionDropdown();
  initManageAccounts();
  initializeAdminEventForm();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdmin);
} else {
  initAdmin();
}

// ========== Search & Filter (home.html) ==========
function initializeSearch() {
  const searchForm = document.getElementById("search-form");
  const searchResults = document.getElementById("search-results");
  if (!searchForm || !searchResults) return;

  const categoryBtns = document.querySelectorAll(".category-btn");
  const countyTrigger = document.getElementById("county-multiselect-trigger");
  const countyPanel = document.getElementById("county-multiselect-panel");
  const countyCheckboxes = document.querySelectorAll('input[name="county"]');
  const countyLabel = document.querySelector(".county-multiselect__label");
  const countyFilterInput = document.getElementById("county-multiselect-filter");
  const countyFilterEmpty = document.getElementById("county-multiselect-filter-empty");
  const applyFilterBtn = document.getElementById("apply-filter-button");

  // County multi-select: toggle panel
  if (countyTrigger && countyPanel) {
    function applyCountyNameFilter() {
      const q = (countyFilterInput?.value || "").trim().toLowerCase();
      const options = countyPanel.querySelectorAll(".county-multiselect__option");
      let visible = 0;
      options.forEach((label) => {
        const cb = label.querySelector('input[name="county"]');
        const name = (cb?.value || label.textContent || "").trim().toLowerCase();
        const match = !q || name.includes(q);
        label.classList.toggle("county-multiselect__option--hidden", !match);
        if (match) visible += 1;
      });
      if (countyFilterEmpty) {
        countyFilterEmpty.hidden = !(q && visible === 0);
      }
    }

    function resetCountyNameFilter() {
      if (countyFilterInput) countyFilterInput.value = "";
      countyPanel.querySelectorAll(".county-multiselect__option--hidden").forEach((el) => {
        el.classList.remove("county-multiselect__option--hidden");
      });
      if (countyFilterEmpty) countyFilterEmpty.hidden = true;
    }

    function closeCountyPanel() {
      countyTrigger.setAttribute("aria-expanded", "false");
      countyPanel.setAttribute("aria-hidden", "true");
      resetCountyNameFilter();
    }

    countyTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = countyPanel.getAttribute("aria-hidden") !== "false";
      if (isOpen) {
        countyPanel.setAttribute("aria-hidden", "false");
        countyTrigger.setAttribute("aria-expanded", "true");
      } else {
        countyTrigger.focus();
        closeCountyPanel();
      }
    });

    // Close panel when clicking outside
    document.addEventListener("click", () => {
      if (countyPanel.getAttribute("aria-hidden") === "false") {
        countyTrigger.focus();
        closeCountyPanel();
      }
    });
    countyPanel.addEventListener("click", (e) => e.stopPropagation());

    if (countyFilterInput) {
      countyFilterInput.addEventListener("input", () => applyCountyNameFilter());
      countyFilterInput.addEventListener("keydown", (e) => e.stopPropagation());
    }

    // Done button - close panel (especially useful on mobile)
    const doneBtn = document.getElementById("county-multiselect-done");
    if (doneBtn) {
      doneBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        countyTrigger.focus();
        closeCountyPanel();
      });
    }

    // Select All / Clear buttons (Select All applies to counties visible in the current filter)
    countyPanel.querySelectorAll(".county-multiselect__action-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (btn.dataset.action === "select-all") {
          countyPanel
            .querySelectorAll(
              '.county-multiselect__option:not(.county-multiselect__option--hidden) input[name="county"]'
            )
            .forEach((cb) => {
              cb.checked = true;
            });
        } else if (btn.dataset.action === "clear") {
          countyCheckboxes.forEach((cb) => (cb.checked = false));
        }
        updateCountyLabel();
      });
    });

    // Update label when checkboxes change
    countyCheckboxes.forEach((cb) => {
      cb.addEventListener("change", () => {
        updateCountyLabel();
      });
    });
  }

  function updateApplyFilterButton() {
    if (!applyFilterBtn) return;
    // "Search" is now the single action button and should always be available.
    applyFilterBtn.disabled = false;
  }

  function updateCountyLabel() {
    if (!countyLabel) return;
    const selected = Array.from(countyCheckboxes).filter((cb) => cb.checked).map((cb) => cb.value);
    if (selected.length === 0) {
      countyLabel.textContent = "All Counties";
    } else if (selected.length === 1) {
      countyLabel.textContent = selected[0];
    } else {
      countyLabel.textContent = `${selected.length} counties selected`;
    }
  }

  // Category button toggle (multi-select)
  categoryBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("filter-btn--active");
    });
  });

  // Get selected filters
  function getSelectedCategories() {
    return Array.from(document.querySelectorAll(".category-btn.filter-btn--active"))
      .map((b) => b.dataset.category);
  }

  function getSelectedCounties() {
    return Array.from(document.querySelectorAll('input[name="county"]:checked')).map((cb) => cb.value.trim());
  }

  function setCountyCheckboxes(counties) {
    const checkboxes = document.querySelectorAll('input[name="county"]');
    checkboxes.forEach((cb) => {
      cb.checked = counties.includes(cb.value);
    });
    if (countyLabel) updateCountyLabel();
  }

  function scrollHomeSearchResultsIntoView() {
    const section = document.getElementById("search-results-section");
    if (!section) return;
    const prefersReduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => {
      section.scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth", block: "start" });
    });
  }

  // Shared filter/search logic (used by both Search form and Apply Filter button)
  async function runFilterSearch(includeSurrounding = false, primaryCounty = null) {
    const searchInput = document.getElementById("search-input");
    const query = (searchInput?.value || "").trim().toLowerCase();
    const categories = getSelectedCategories();
    let counties = getSelectedCounties();
    const selectedCounty = primaryCounty || (counties.length === 1 ? counties[0] : null);

    // Expand to include surrounding counties when "Show more" is clicked; update multi-select to show them
    if (includeSurrounding && selectedCounty) {
      const surrounding = SURROUNDING_COUNTIES[selectedCounty];
      if (surrounding && surrounding.length > 0) {
        counties = [selectedCounty, ...surrounding];
        setCountyCheckboxes(counties);
      }
    }

    if (query) {
      trackEvent("search", { search_term: query });
    }
    counties.forEach((county) => {
      trackEvent("county_filter", {
        county_name: county,
        item_id: county,
      });
    });
    categories.forEach((category) => {
      trackEvent("select_content", { content_type: "category", item_id: category });
    });

    try {
      const allResources = await fetchAllResources();
      let filtered = allResources;

      // Apply category filter
      if (categories.length > 0) {
        const selectedCategories = categories
          .map((c) => getCategoryEquivalenceId(c))
          .filter(Boolean);
        filtered = filtered.filter((r) => {
          const docCategoryTags = getCategoryTags(r)
            .map((tag) => getCategoryEquivalenceId(tag))
            .filter(Boolean);
          if (docCategoryTags.length === 0) return false;
          return selectedCategories.some((selected) => docCategoryTags.includes(selected));
        });
      }

      // Apply county filter (multiple counties)
      if (counties.length > 0) {
        const countiesLower = counties.map((c) => c.toLowerCase());
        filtered = filtered.filter((r) => {
          const docCountyRaw = getResourceCountyRawFromDoc(r);
          if (!docCountyRaw) return false;
          if (isStatewideCountyRaw(docCountyRaw)) return true;
          // Handle comma/and-separated counties (e.g. "Dallas, Perry, Wilcox" or "JEFFERSON, SHELBY, BIBB")
          const docCounties = docCountyRaw.split(/\s+and\s+|[,&]+/).map((c) => c.trim().toLowerCase()).filter(Boolean);
          return docCounties.some((dc) => countiesLower.includes(dc));
        });
      }

      // Apply text search if query provided
      if (query) {
        filtered = filtered.filter((r) => matchesSearch(r, query));
      }

      // Sort when county filter is on: county-specific matches first, then statewide (All Counties); then primary county among multi-select
      const primaryCounty = selectedCounty || (counties.length > 0 ? counties[0] : null);
      if (counties.length > 0) {
        filtered.sort((a, b) => {
          const aState = isStatewideCountyRaw(getResourceCountyRawFromDoc(a));
          const bState = isStatewideCountyRaw(getResourceCountyRawFromDoc(b));
          if (!aState && bState) return -1;
          if (aState && !bState) return 1;
          if (primaryCounty && counties.length > 1) {
            const primaryLower = primaryCounty.toLowerCase();
            const aInPrimary = docCoversPrimaryCounty(a, primaryLower);
            const bInPrimary = docCoversPrimaryCounty(b, primaryLower);
            if (aInPrimary && !bInPrimary) return -1;
            if (!aInPrimary && bInPrimary) return 1;
          }
          return 0;
        });
      }

      renderSearchResults(filtered, searchResults);

      // Show "Show more resources from surrounding counties" button when exactly one county is selected and we're not already showing surrounding
      const showMoreWrapper = document.getElementById("show-more-wrapper");
      if (showMoreWrapper) {
        showMoreWrapper.innerHTML = "";
        const selectedCounties = getSelectedCounties();
        const selectedCounty = selectedCounties[0];
        const hasSurrounding = selectedCounty && SURROUNDING_COUNTIES[selectedCounty] && SURROUNDING_COUNTIES[selectedCounty].length > 0;
        const isAlreadyExpanded = selectedCounties.length > 1 && hasSurrounding &&
          SURROUNDING_COUNTIES[selectedCounty].every((c) => selectedCounties.includes(c));
        if (selectedCounties.length === 1 && hasSurrounding && !isAlreadyExpanded) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "show-more-btn";
          btn.textContent = "Show more resources from surrounding counties";
          btn.addEventListener("click", () => {
            const primary = getSelectedCounties()[0];
            runFilterSearch(true, primary);
          });
          showMoreWrapper.appendChild(btn);
        } else if (includeSurrounding && selectedCounty && hasSurrounding) {
          const msg = document.createElement("p");
          msg.className = "show-more-message";
          msg.textContent = `Showing resources from ${selectedCounty} and surrounding counties (see Filter by County above).`;
          showMoreWrapper.appendChild(msg);
        }
      }

      updateApplyFilterButton();
      scrollHomeSearchResultsIntoView();
    } catch (err) {
      console.error("Search error:", err);
      searchResults.innerHTML = `<div class="search-results-empty">Unable to load resources. Please try again.</div>`;
      const showMoreWrapper = document.getElementById("show-more-wrapper");
      if (showMoreWrapper) showMoreWrapper.innerHTML = "";
      scrollHomeSearchResultsIntoView();
    }
  }

  // Expose to global for questionnaire modal
  window.runFilterSearch = runFilterSearch;

  // Search form submit
  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await runFilterSearch();
  });

  // Apply Filter button: runs same filter logic, no search required
  if (applyFilterBtn) {
    applyFilterBtn.addEventListener("click", async () => {
      await runFilterSearch();
    });
  }

  searchResults.addEventListener("click", (e) => {
    const enlargeableImg = e.target.closest('img[data-enlargeable="true"]');
    if (enlargeableImg) {
      openImageLightbox(enlargeableImg.currentSrc || enlargeableImg.src, enlargeableImg.alt || "");
      return;
    }

    const closeBtn = e.target.closest(".search-results-card__inline-map-close");
    if (closeBtn) {
      const card = closeBtn.closest(".search-results-card");
      destroyInlineHomeMap(card);
      return;
    }

    const mapBtn = e.target.closest(".search-results-card__map-btn");
    if (!mapBtn) return;

    const card = mapBtn.closest(".search-results-card");
    if (!card) return;

    const inlinePanel = card.querySelector(".search-results-card__inline-map");
    if (inlinePanel && !inlinePanel.hidden) {
      destroyInlineHomeMap(card);
      return;
    }

    document.querySelectorAll(".search-results-card").forEach((c) => {
      const p = c.querySelector(".search-results-card__inline-map");
      if (p && !p.hidden && c !== card) destroyInlineHomeMap(c);
    });

    const col = mapBtn.dataset.mapCollection;
    const id = mapBtn.dataset.mapId;

    void (async () => {
      let resource = lastHomeSearchResources.find((r) => r._collection === col && r.id === id);
      if (!resource && col && id) {
        try {
          const snap = await getDoc(doc(firestore, col, id));
          if (snap.exists()) {
            resource = { _collection: col, id: snap.id, ...snap.data() };
          }
        } catch (err) {
          console.warn("getDoc for inline map:", err);
        }
      }
      if (!resource || !resourceHasAddress(resource)) {
        const statusEl = card.querySelector(".search-results-card__inline-map-status");
        const panelEl = card.querySelector(".search-results-card__inline-map");
        const canvasEl = card.querySelector(".search-results-card__inline-map-canvas");
        if (panelEl) panelEl.hidden = false;
        setInlineMapCanvasPlaceholderVisible(canvasEl, false);
        if (statusEl) {
          statusEl.hidden = false;
          statusEl.textContent = "Could not load this resource.";
        }
        return;
      }
      await openInlineHomeResourceMap(card, resource);
    })();
  });
}

// ========== Admin Search (admin.html) ==========
function initializeAdminSearch() {
  const table = document.getElementById("dataTable");
  const searchForm = document.getElementById("search-form");
  const searchResults = document.getElementById("search-results");
  if (!table || !searchForm || searchResults) return;

  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const searchInput = document.getElementById("search-input");
    const query = (searchInput?.value || "").trim().toLowerCase();

    try {
      const allResources = await fetchAllResources();
      const filtered = query
        ? allResources.filter((r) => matchesSearch(r, query))
        : allResources;

      // Render mixed collection results into the admin table
      renderTable(filtered);
    } catch (err) {
      console.error("Admin search error:", err);
      alert("Unable to search resources. Please try again.");
    }
  });
}

function normalizeField(val) {
  if (val == null || val === undefined) return "";
  return String(val).trim();
}

/** Stored in Firestore for resources that serve all Alabama counties (admin dropdown + filter). */
const COUNTY_STATEWIDE_VALUE = "All Counties";

/** Alabama county names — must match home.html county filter values (spelling). */
const ALABAMA_COUNTY_NAMES = [
  "Autauga",
  "Baldwin",
  "Barbour",
  "Bibb",
  "Blount",
  "Bullock",
  "Butler",
  "Calhoun",
  "Chambers",
  "Cherokee",
  "Chilton",
  "Choctaw",
  "Clarke",
  "Clay",
  "Cleburne",
  "Coffee",
  "Colbert",
  "Conecuh",
  "Coosa",
  "Covington",
  "Crenshaw",
  "Cullman",
  "Dale",
  "Dallas",
  "DeKalb",
  "Elmore",
  "Escambia",
  "Etowah",
  "Fayette",
  "Franklin",
  "Geneva",
  "Greene",
  "Hale",
  "Henry",
  "Houston",
  "Jackson",
  "Jefferson",
  "Lamar",
  "Lauderdale",
  "Lawrence",
  "Lee",
  "Limestone",
  "Lowndes",
  "Macon",
  "Madison",
  "Marengo",
  "Marion",
  "Marshall",
  "Mobile",
  "Monroe",
  "Montgomery",
  "Morgan",
  "Perry",
  "Pickens",
  "Pike",
  "Randolph",
  "Russell",
  "Shelby",
  "St. Clair",
  "Sumter",
  "Talladega",
  "Tallapoosa",
  "Tuscaloosa",
  "Walker",
  "Washington",
  "Wilcox",
  "Winston",
];

const COUNTY_FIELD_KEYS = new Set([
  "County",
  "county",
  "County:",
  "County Served",
  "Counties",
  "counties",
]);

function getResourceCountyRawFromDoc(r) {
  return normalizeField(
    r?.County ??
      r?.county ??
      r?.["County:"] ??
      r?.["County Served"] ??
      r?.Counties ??
      r?.counties
  );
}

/** True if the county field indicates statewide coverage (matches any selected county filter). */
function isStatewideCountyRaw(raw) {
  const s = normalizeField(raw).toLowerCase();
  if (!s) return false;
  if (s === "all counties" || s === "statewide" || s === "all alabama") return true;
  const tokens = s.split(/\s+and\s+|[,&]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  return tokens.some((t) => t === "all counties" || t === "statewide" || t === "all alabama");
}

/** Single-line County label for search result cards. */
function formatCountyForDisplay(r) {
  const raw = getResourceCountyRawFromDoc(r);
  if (!raw) return "";
  if (isStatewideCountyRaw(raw)) return COUNTY_STATEWIDE_VALUE;
  return raw;
}

/** Ordered county names from the County field (same tokenization as filters). Empty if statewide or blank. */
function getResourceCountyPartsOrdered(r) {
  const raw = getResourceCountyRawFromDoc(r);
  if (!raw || isStatewideCountyRaw(raw)) return [];
  return raw
    .split(/\s+and\s+|[,&]+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function getCountyHeadingForOfficeIndex(countyParts, officeIndex1Based) {
  if (!countyParts || countyParts.length === 0 || officeIndex1Based < 1) return "";
  const i = officeIndex1Based - 1;
  if (i >= countyParts.length) return "";
  return countyParts[i];
}

/** Heading for an office block: aligned county name, else office label, else "Office N". */
function getOfficeSectionHeading(r, officeBlock, officeBlocks) {
  const oc = normalizeField(officeBlock?.county || "");
  if (oc) return oc;
  const parts = getResourceCountyPartsOrdered(r);
  const idx = officeBlock?.index != null ? Number(officeBlock.index) : 1;
  const county = getCountyHeadingForOfficeIndex(parts, idx);
  if (county) return county;
  const lab = normalizeField(officeBlock?.label || "");
  if (lab) return lab;
  if (officeBlocks.length > 1) return `Office ${idx}`;
  return "";
}

function docCoversPrimaryCounty(r, primaryLower) {
  if (!primaryLower) return false;
  const docCountyRaw = getResourceCountyRawFromDoc(r);
  if (isStatewideCountyRaw(docCountyRaw)) return true;
  const docCounties = docCountyRaw
    .split(/\s+and\s+|[,&]+/)
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  return docCounties.includes(primaryLower);
}

// Surrounding counties for each Alabama county (for "Show more resources from surrounding counties")
const SURROUNDING_COUNTIES = {
  Autauga: ["Chilton", "Elmore", "Montgomery", "Lowndes", "Dallas"],
  Baldwin: ["Mobile", "Washington", "Clarke", "Monroe", "Conecuh", "Escambia"],
  Barbour: ["Russell", "Bullock", "Pike", "Dale", "Henry"],
  Bibb: ["Jefferson", "Shelby", "Chilton", "Perry", "Hale", "Tuscaloosa"],
  Blount: ["Cullman", "Marshall", "Etowah", "St. Clair", "Jefferson", "Walker"],
  Bullock: ["Montgomery", "Macon", "Russell", "Barbour", "Pike"],
  Butler: ["Lowndes", "Crenshaw", "Conecuh", "Monroe", "Wilcox"],
  Calhoun: ["Etowah", "Cherokee", "Cleburne", "Talladega", "St. Clair"],
  Chambers: ["Randolph", "Tallapoosa", "Lee"],
  Cherokee: ["DeKalb", "Etowah", "Calhoun"],
  Chilton: ["Shelby", "Coosa", "Elmore", "Autauga", "Dallas", "Perry", "Bibb"],
  Choctaw: ["Sumter", "Marengo", "Clarke", "Washington"],
  Clarke: ["Marengo", "Wilcox", "Monroe", "Baldwin", "Washington", "Choctaw"],
  Clay: ["Talladega", "Cleburne", "Randolph", "Tallapoosa", "Coosa"],
  Cleburne: ["Calhoun", "Cherokee", "Randolph", "Clay", "Talladega"],
  Coffee: ["Pike", "Dale", "Geneva", "Covington", "Crenshaw"],
  Colbert: ["Lauderdale", "Lawrence", "Franklin"],
  Conecuh: ["Monroe", "Butler", "Covington", "Escambia", "Baldwin"],
  Coosa: ["Talladega", "Clay", "Tallapoosa", "Elmore", "Chilton"],
  Covington: ["Crenshaw", "Coffee", "Geneva", "Escambia", "Conecuh"],
  Crenshaw: ["Lowndes", "Montgomery", "Pike", "Coffee", "Covington", "Butler"],
  Cullman: ["Morgan", "Marshall", "Blount", "Walker", "Winston", "Lawrence"],
  Dale: ["Barbour", "Henry", "Houston", "Geneva", "Coffee", "Pike"],
  Dallas: ["Perry", "Chilton", "Autauga", "Lowndes", "Wilcox", "Marengo"],
  DeKalb: ["Jackson", "Cherokee", "Etowah", "Marshall"],
  Elmore: ["Coosa", "Tallapoosa", "Montgomery", "Autauga", "Chilton"],
  Escambia: ["Baldwin", "Conecuh", "Covington"],
  Etowah: ["Marshall", "DeKalb", "Cherokee", "Calhoun", "St. Clair", "Blount"],
  Fayette: ["Marion", "Walker", "Tuscaloosa", "Pickens", "Lamar"],
  Franklin: ["Colbert", "Lawrence", "Winston", "Marion"],
  Geneva: ["Coffee", "Dale", "Houston", "Covington"],
  Greene: ["Pickens", "Tuscaloosa", "Hale", "Sumter", "Marengo"],
  Hale: ["Tuscaloosa", "Bibb", "Perry", "Marengo", "Greene"],
  Henry: ["Barbour", "Houston", "Dale"],
  Houston: ["Henry", "Dale", "Geneva"],
  Jackson: ["Madison", "Marshall", "DeKalb"],
  Jefferson: ["Walker", "Blount", "St. Clair", "Shelby", "Bibb", "Tuscaloosa"],
  Lamar: ["Marion", "Fayette", "Pickens"],
  Lauderdale: ["Limestone", "Lawrence", "Colbert"],
  Lawrence: ["Lauderdale", "Limestone", "Morgan", "Cullman", "Winston", "Colbert"],
  Lee: ["Chambers", "Russell", "Macon", "Tallapoosa"],
  Limestone: ["Madison", "Morgan", "Lawrence", "Lauderdale"],
  Lowndes: ["Autauga", "Montgomery", "Crenshaw", "Butler", "Wilcox", "Dallas"],
  Macon: ["Tallapoosa", "Lee", "Russell", "Bullock", "Montgomery", "Elmore"],
  Madison: ["Jackson", "Marshall", "Morgan", "Limestone"],
  Marengo: ["Sumter", "Greene", "Hale", "Perry", "Dallas", "Wilcox", "Clarke", "Choctaw"],
  Marion: ["Franklin", "Winston", "Walker", "Fayette", "Lamar"],
  Marshall: ["Madison", "Jackson", "DeKalb", "Etowah", "Blount", "Cullman", "Morgan"],
  Mobile: ["Washington", "Baldwin"],
  Monroe: ["Wilcox", "Clarke", "Baldwin", "Conecuh", "Butler"],
  Montgomery: ["Autauga", "Elmore", "Macon", "Bullock", "Pike", "Crenshaw", "Lowndes"],
  Morgan: ["Madison", "Marshall", "Cullman", "Lawrence", "Limestone"],
  Perry: ["Hale", "Bibb", "Chilton", "Dallas", "Marengo"],
  Pickens: ["Lamar", "Fayette", "Tuscaloosa", "Greene", "Sumter"],
  Pike: ["Montgomery", "Bullock", "Barbour", "Dale", "Coffee", "Crenshaw"],
  Randolph: ["Cleburne", "Chambers", "Tallapoosa", "Clay"],
  Russell: ["Lee", "Barbour", "Bullock", "Macon"],
  Shelby: ["Jefferson", "St. Clair", "Talladega", "Coosa", "Chilton", "Bibb"],
  "St. Clair": ["Blount", "Etowah", "Calhoun", "Talladega", "Shelby", "Jefferson"],
  Sumter: ["Pickens", "Greene", "Marengo", "Choctaw"],
  Talladega: ["St. Clair", "Calhoun", "Cleburne", "Clay", "Coosa", "Shelby"],
  Tallapoosa: ["Clay", "Randolph", "Chambers", "Lee", "Macon", "Elmore", "Coosa"],
  Tuscaloosa: ["Fayette", "Walker", "Jefferson", "Bibb", "Hale", "Greene", "Pickens"],
  Walker: ["Winston", "Cullman", "Blount", "Jefferson", "Tuscaloosa", "Fayette", "Marion"],
  Washington: ["Choctaw", "Clarke", "Baldwin", "Mobile"],
  Wilcox: ["Marengo", "Dallas", "Lowndes", "Butler", "Monroe", "Clarke"],
  Winston: ["Franklin", "Lawrence", "Cullman", "Walker", "Marion"],
};

// Map Firestore collection names to display category names (for CSV-imported docs that use Category: instead of Category Tags)
const COLLECTION_TO_CATEGORY = {
  DomesticViolence: "Domestic Violence",
  "Domestic Violence": "Domestic Violence",
  ChildAdvocacy: "Child Advocacy",
  "Child Advocacy": "Child Advocacy",
  Compensation: "Compensation",
  DistrictAttorney: "District Attorneys",
  "District Attorney": "District Attorneys",
  HumanTrafficking: "Human Trafficking",
  "Human Trafficking": "Human Trafficking",
  SexualAssault: "Sexual Assault",
  "Sexual Assault": "Sexual Assault",
  Sheriffs: "Law Enforcement",
  VictimResources: "Victim Resources",
  "Victim Resources": "Victim Resources",
  "Pardon & Parole": "Pardon & Parole",
  Hotlines: "Hotlines",
  Tribal: "Tribal",
};

/** Default Add/Edit fields for District Attorney when the collection is empty or as merge fallback. */
const DISTRICT_ATTORNEY_DEFAULT_FORM_KEYS = [
  "First Name",
  "Last Name",
  "Judicial Circuit",
  "County",
  "Website",
];

// Default headers for Add Resource when collection is empty
const COLLECTION_DEFAULT_HEADERS = {
  Tribal: [
    "Organization",
    "County",
    "Address",
    "City",
    "State",
    "Zip",
    "Phone Number",
    "Website",
    "Services",
    "Hours",
  ],
  "District Attorney": DISTRICT_ATTORNEY_DEFAULT_FORM_KEYS.slice(),
};

/** Omitted from admin forms; coordinates are not stored — home map geocodes from address. */
const MAP_COORD_FIELD_NAMES = ["Latitude", "Longitude"];

/** Normalized field name for consistent ordering across collections (import/CSV variants). */
function normalizeFormFieldKeyForOrder(key) {
  return String(key || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/:+$/, "")
    .toLowerCase();
}

/**
 * Canonical order for Add/Edit popup fields. Keys not listed sort after, alphabetically by label.
 * Longer/more specific names (e.g. "phone number") should appear before shorter prefixes ("phone").
 */
const RESOURCE_FORM_FIELD_PRIORITY = [
  "first name",
  "last name",
  "name",
  "title",
  "organization",
  "contact name",
  "description",
  "services",
  "notes",
  "summary",
  "about",
  "details",
  "county",
  "judicial circuit",
  "address",
  "city",
  "state",
  "zip",
  "phone number",
  "phone",
  "telephone",
  "tel",
  "mobile",
  "email",
  "website",
  "url",
  "link",
  "hours",
  "availability",
];

function resourceFormFieldSortIndex(key) {
  const n = normalizeFormFieldKeyForOrder(key);
  for (let i = 0; i < RESOURCE_FORM_FIELD_PRIORITY.length; i++) {
    const pref = RESOURCE_FORM_FIELD_PRIORITY[i];
    if (n === pref) return i;
  }
  for (let i = 0; i < RESOURCE_FORM_FIELD_PRIORITY.length; i++) {
    const pref = RESOURCE_FORM_FIELD_PRIORITY[i];
    if (n.startsWith(pref + " ") || n.startsWith(pref + ":")) return i + 0.05;
  }
  return 500;
}

function sortResourceFormFieldKeys(keys) {
  const copy = [...keys];
  copy.sort((a, b) => {
    const ia = resourceFormFieldSortIndex(a);
    const ib = resourceFormFieldSortIndex(b);
    if (ia !== ib) return ia - ib;
    return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
  });
  return copy;
}

async function fetchSampleFieldKeysForCollection(collectionName) {
  if (!collectionName) return null;
  try {
    const q = query(collection(firestore, collectionName), limit(1));
    const snapshot = await getDocs(q);
    if (!snapshot.empty) {
      const data = snapshot.docs[0].data() || {};
      const keys = Object.keys(data).filter((k) => k !== "Last Updated");
      return sortResourceFormFieldKeys(keys);
    }
    if (COLLECTION_DEFAULT_HEADERS[collectionName]) {
      return sortResourceFormFieldKeys(COLLECTION_DEFAULT_HEADERS[collectionName].slice());
    }
    if (collectionName === "District Attorney" || collectionName === "DistrictAttorney") {
      return sortResourceFormFieldKeys(DISTRICT_ATTORNEY_DEFAULT_FORM_KEYS.slice());
    }
    return null;
  } catch (err) {
    console.warn("Could not load sample document keys for form template:", err);
    return null;
  }
}

/** Firestore field names are case-sensitive; imports may use "category tags" vs "Category Tags". */
function getCategoryTagsFieldRaw(doc) {
  if (!doc || typeof doc !== "object") return undefined;
  if (doc["Category Tags"] != null) return doc["Category Tags"];
  const hit = Object.keys(doc).find(
    (k) => k.replace(/\s+/g, " ").trim().toLowerCase() === "category tags"
  );
  if (hit != null) return doc[hit];
  return undefined;
}

function getCategoryTags(doc) {
  const rawTags = getCategoryTagsFieldRaw(doc);
  if (Array.isArray(rawTags)) {
    const tags = rawTags.map((tag) => normalizeCategoryTag(tag)).filter(Boolean);
    if (tags.length > 0) return tags;
  }
  if (typeof rawTags === "string") {
    const tags = rawTags.split(",").map((tag) => normalizeCategoryTag(tag)).filter(Boolean);
    if (tags.length > 0) return tags;
  }
  // Fallback: CSV-imported docs use Category: or Category (single value)
  const singleCategory = doc?.["Category:"] || doc?.["Category"];
  if (singleCategory && normalizeCategoryTag(singleCategory)) {
    return [normalizeCategoryTag(singleCategory)];
  }
  // Infer from collection name when category is missing
  const col = doc?._collection;
  if (col && COLLECTION_TO_CATEGORY[col]) {
    return [COLLECTION_TO_CATEGORY[col]];
  }
  return [];
}

function matchesSearch(doc, query) {
  const str = JSON.stringify(doc).toLowerCase();
  return str.includes(query);
}

async function fetchAllResources() {
  const chunks = await Promise.all(
    availableCollections.map(async (colName) => {
      const out = [];
      try {
        const collectionRef = collection(firestore, colName);
        const snapshot = await getDocs(collectionRef);
        snapshot.forEach((d) => {
          out.push({ _collection: colName, id: d.id, ...d.data() });
        });
      } catch (err) {
        console.error(`Error fetching ${colName}:`, err);
      }
      return out;
    })
  );
  return chunks.flat();
}

function getFieldValueCaseInsensitive(r, keyCandidates = []) {
  if (!r || typeof r !== "object") return "";
  for (const key of keyCandidates) {
    if (r[key] != null && String(r[key]).trim() !== "") return String(r[key]).trim();
  }
  const wanted = new Set(keyCandidates.map((k) => String(k).trim().toLowerCase()));
  for (const [k, v] of Object.entries(r)) {
    if (!wanted.has(String(k).trim().toLowerCase())) continue;
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

/**
 * Field names with no index suffix are treated as office slot 1 (same as Address 1, Phone Number 1).
 * Matches document keys only when the key has no trailing number (excludes Address 2, Phone 3).
 */
function getValueForImplicitOfficeSlotOne(r, regex) {
  if (!r || typeof r !== "object") return "";
  for (const [k, v] of Object.entries(r)) {
    const key = String(k).trim();
    if (!regex.test(key)) continue;
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

function isDistrictAttorneyCollectionName(name) {
  const n = String(name || "").trim().toLowerCase();
  return n === "district attorney" || n === "districtattorney";
}

/** Keys like `Address 1`, `City 2` — same variants as index>1, used as fallback for slot 1 when unnumbered fields are absent. */
function getNumberedFieldKeysForPart(part, index) {
  const p = String(part || "").trim();
  if (!p || index < 1) return [];
  return [
    `${p} ${index}`,
    `${p}${index}`,
    `${p}: ${index}`,
    `${p}:${index}`,
    `${p} ${index}:`,
  ];
}

function getPhoneSuffixesForIndex(index) {
  if (index < 1) return [];
  return [
    `Phone ${index}`,
    `Phone${index}`,
    `Phone: ${index}`,
    `Phone:${index}`,
    `Phone ${index}:`,
    `Phone Number ${index}`,
    `Phone Number: ${index}`,
    `Phone Number:${index}`,
    `Phone Number ${index}:`,
    `Telephone ${index}`,
    `Telephone${index}`,
    `Tel ${index}`,
    `Tel${index}`,
  ];
}

function getAddressPartForIndex(r, part, index = 1) {
  const p = String(part || "").trim();
  if (!p) return "";
  if (index <= 1) {
    let primary = "";
    if (p === "Address") {
      primary = getFieldValueCaseInsensitive(r, ["Address:", "Address"]);
    } else if (p === "City") {
      primary = getFieldValueCaseInsensitive(r, ["City", "City:"]);
    } else if (p === "State") {
      primary = getFieldValueCaseInsensitive(r, ["State", "State:"]);
    } else if (p === "Zip") {
      primary = getFieldValueCaseInsensitive(r, ["Zip", "Zip:", "ZIP"]);
    }
    if (primary) return primary;
    const numbered1 = getFieldValueCaseInsensitive(r, getNumberedFieldKeysForPart(p, 1));
    if (numbered1) return numbered1;
    const implicitRe =
      p === "Address"
        ? /^address\s*:?\s*$/i
        : p === "City"
          ? /^city\s*:?\s*$/i
          : p === "State"
            ? /^state\s*:?\s*$/i
            : p === "Zip"
              ? /^zip\s*:?\s*$/i
              : null;
    if (implicitRe) {
      const implicit = getValueForImplicitOfficeSlotOne(r, implicitRe);
      if (implicit) return implicit;
    }
    return "";
  }
  return getFieldValueCaseInsensitive(r, getNumberedFieldKeysForPart(p, index));
}

function getPhonePartForIndex(r, index = 1) {
  const unnumbered = [
    "Phone",
    "phone",
    "Phone Number",
    "Phone Number:",
    "Phone:",
    "phoneNumber",
    "Telephone",
    "Tel",
    "Contact Number",
    "Main Phone",
    "Hotline",
  ];
  if (index <= 1) {
    const primary = getFieldValueCaseInsensitive(r, unnumbered);
    if (primary) return primary;
    const numbered1 = getFieldValueCaseInsensitive(r, getPhoneSuffixesForIndex(1));
    if (numbered1) return numbered1;
    return (
      getValueForImplicitOfficeSlotOne(r, /^phone\s+number\s*:?\s*$/i) ||
      getValueForImplicitOfficeSlotOne(r, /^phone\s*:?\s*$/i) ||
      getValueForImplicitOfficeSlotOne(r, /^telephone\s*:?\s*$/i) ||
      getValueForImplicitOfficeSlotOne(r, /^tel\s*:?\s*$/i) ||
      getValueForImplicitOfficeSlotOne(r, /^contact\s+number\s*:?\s*$/i) ||
      getValueForImplicitOfficeSlotOne(r, /^main\s+phone\s*:?\s*$/i) ||
      getValueForImplicitOfficeSlotOne(r, /^hotline\s*:?\s*$/i) ||
      ""
    );
  }
  return getFieldValueCaseInsensitive(r, getPhoneSuffixesForIndex(index));
}

function composeAddressLine({ address = "", city = "", state = "", zip = "" }) {
  const a = normalizeField(address);
  const c = normalizeField(city);
  const s = normalizeField(state);
  const z = normalizeField(zip);
  if (a && (a.includes(",") || /\bal\b/i.test(a))) return a;
  // Do not show state-only (e.g. default "AL") when there is no street, city, or zip.
  if (!a && !c && !z) return "";
  const line = [a, c, s, z].filter(Boolean).join(", ");
  return line.trim();
}

function toFullGeocodeQuery(line) {
  const s = String(line || "").trim();
  if (!s) return null;
  const l = s.toLowerCase();
  if (l.includes("alabama") || /,?\s*al\s*,|\b al \d{5}|\b, al\b/.test(l)) {
    if (/\b(united states|usa)\s*$/i.test(s)) return s;
    return `${s}, USA`;
  }
  return `${s}, Alabama, USA`;
}

function toCityStateZipGeocodeQuery({ city = "", state = "", zip = "" }) {
  const c = normalizeField(city);
  if (!c) return null;
  const s = normalizeField(state) || "AL";
  const z = normalizeField(zip);
  const zipPart = z ? ` ${z}` : "";
  return `${c}, ${s}${zipPart}, USA`;
}

function normalizeOfficeBlock(block, fallbackIndex) {
  if (!block || typeof block !== "object") return null;
  const idxRaw = block.index ?? block.officeIndex ?? block.id ?? fallbackIndex;
  const index = Number.isFinite(Number(idxRaw)) ? Number(idxRaw) : fallbackIndex;
  const label = normalizeField(block.label || block.name || "");
  const address = normalizeField(block.address || block.street || block.addressLine || "");
  const city = normalizeField(block.city || "");
  const state = normalizeField(block.state || "AL") || "AL";
  const zip = normalizeField(block.zip || block.zipCode || block.postalCode || "");
  const phone = normalizeField(block.phone || block.phoneNumber || block.telephone || "");
  const county = normalizeField(block.county || "");
  const website = normalizeField(block.website || block.url || block.URL || "");
  const displayLine = composeAddressLine({ address, city, state, zip });
  const geocodeQuery = toFullGeocodeQuery(displayLine);
  const cityStateZipQuery = toCityStateZipGeocodeQuery({ city, state, zip });
  if (!displayLine && !geocodeQuery && !cityStateZipQuery && !phone && !county && !website)
    return null;
  return {
    index,
    label,
    address,
    city,
    state,
    zip,
    phone,
    county,
    website,
    isPrimary: Boolean(block.isPrimary),
    displayLine,
    geocodeQuery,
    cityStateZipQuery,
  };
}

function getOfficesFromStructuredField(r) {
  const raw = r?.offices;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out = raw
    .map((item, i) => normalizeOfficeBlock(item, i + 1))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      return a.index - b.index;
    });
  return out;
}

function getOfficesFromLegacyFields(r) {
  if (!r || typeof r !== "object") return [];
  const indexes = new Set([1]);
  for (const rawKey of Object.keys(r)) {
    const key = String(rawKey || "");
    const m =
      key.match(/^(address|city|state|zip|phone|phone number|telephone|tel)\s*:?\s*(\d+)\s*:?\s*$/i) ||
      key.match(/^(address|city|state|zip|phone|telephone|tel)(\d+)\s*:?\s*$/i);
    if (!m) continue;
    const idx = parseInt(m[2], 10);
    if (!Number.isNaN(idx) && idx >= 2) indexes.add(idx);
  }
  const out = [];
  Array.from(indexes).sort((a, b) => a - b).forEach((idx) => {
    const normalized = normalizeOfficeBlock({
      index: idx,
      address: getAddressPartForIndex(r, "Address", idx),
      city: getAddressPartForIndex(r, "City", idx),
      state: getAddressPartForIndex(r, "State", idx),
      zip: getAddressPartForIndex(r, "Zip", idx),
      phone: getPhonePartForIndex(r, idx),
    }, idx);
    if (normalized) out.push(normalized);
  });
  return out;
}

function getResourceOfficeBlocks(r) {
  const structured = getOfficesFromStructuredField(r);
  if (structured.length > 0) return structured;
  return getOfficesFromLegacyFields(r);
}

const DA_ADMIN_PHONE_FALLBACK_KEYS = [
  "Phone",
  "phone",
  "Phone Number",
  "Phone Number:",
  "Phone:",
  "phoneNumber",
  "Telephone",
  "Tel",
  "Contact Number",
  "Main Phone",
  "Hotline",
];

/** District Attorney admin table: first office phone, else first token of flat Phone (comma/and-separated). */
function getFirstDistrictAttorneyPhoneForAdminTable(r) {
  if (!r) return "";
  const blocks = getResourceOfficeBlocks(r);
  for (const b of blocks) {
    const p = normalizeField(b.phone || "");
    if (p) return p;
  }
  let raw = "";
  for (const k of DA_ADMIN_PHONE_FALLBACK_KEYS) {
    const v = r[k];
    if (v != null && String(v).trim() !== "") {
      raw = String(v).trim();
      break;
    }
  }
  if (!raw) return "";
  const parts = raw.split(/\s+and\s+|[,&]+/).map((t) => t.trim()).filter(Boolean);
  return parts[0] || raw;
}

/**
 * One-time migration helper for console/admin usage:
 * Copies legacy DA address/phone fields into `offices[]` if the document doesn't already have offices.
 */
async function backfillDistrictAttorneyOfficesFromLegacy() {
  const daCollectionNames = ["District Attorney", "DistrictAttorney"];
  let updatedCount = 0;
  for (const colName of daCollectionNames) {
    try {
      const snap = await getDocs(collection(firestore, colName));
      for (const docSnap of snap.docs) {
        const data = docSnap.data() || {};
        if (Array.isArray(data.offices) && data.offices.length > 0) continue;
        const legacyOffices = getOfficesFromLegacyFields(data).map((o) => ({
          label: o.label || "",
          address: o.address || "",
          city: o.city || "",
          state: o.state || "AL",
          zip: o.zip || "",
          phone: o.phone || "",
          isPrimary: Boolean(o.isPrimary),
        }));
        if (legacyOffices.length === 0) continue;
        await updateDoc(doc(firestore, colName, docSnap.id), { offices: legacyOffices });
        updatedCount += 1;
      }
    } catch (err) {
      console.warn(`Backfill skipped for ${colName}:`, err);
    }
  }
  return updatedCount;
}

function getResourceAddressBlocks(r) {
  return getResourceOfficeBlocks(r).map((o) => ({
    index: o.index,
    displayLine: o.displayLine,
    geocodeQuery: o.geocodeQuery,
    cityStateZipQuery: o.cityStateZipQuery,
  }));
}

function getResourceAddressLines(r) {
  return getResourceAddressBlocks(r).map((b) => b.displayLine).filter(Boolean);
}

/** Single-line primary address for compatibility with existing callers. */
function getResourceAddressLine(r) {
  return getResourceAddressLines(r)[0] || "";
}

function resourceHasAddress(r) {
  return getResourceAddressBlocks(r).some((b) => Boolean(b.geocodeQuery || b.cityStateZipQuery));
}

/** Display title for a resource (same logic as search result cards). */
function getResourceDisplayTitle(r) {
  const firstName = getFieldValueCaseInsensitive(r, [
    "First Name",
    "firstName",
    "FirstName",
  ]);
  const lastName = getFieldValueCaseInsensitive(r, [
    "Last Name",
    "lastName",
    "LastName",
  ]);
  const fullName = `${firstName} ${lastName}`.trim();
  const namePart =
    fullName ||
    getFieldValueCaseInsensitive(r, [
      "Name",
      "name",
      "Name:",
      "Organization",
      "Organization:",
      "organization",
      "Agency",
      "Office",
      "Department",
      "Program",
      "Contact Name",
      "DAName",
    ]);
  const titleValue =
    getFieldValueCaseInsensitive(r, ["Title", "title"]) ||
    (r._collection === "Sheriffs" && namePart ? "Sheriff" : null) ||
    ((r._collection === "DistrictAttorney" || r._collection === "District Attorney") && namePart
      ? "District Attorney"
      : null);
  if (titleValue && namePart) return `${titleValue} ${namePart}`;
  return namePart || titleValue || "Resource";
}

/** Last resources rendered on Home search — used to resolve inline map without an extra Firestore read. */
let lastHomeSearchResources = [];
let imageLightboxEl = null;
let imageLightboxImgEl = null;

function ensureImageLightbox() {
  if (imageLightboxEl && imageLightboxImgEl) return;

  imageLightboxEl = document.createElement("div");
  imageLightboxEl.className = "image-lightbox";
  imageLightboxEl.hidden = true;
  imageLightboxEl.setAttribute("aria-hidden", "true");
  imageLightboxEl.innerHTML = `
    <div class="image-lightbox__content">
      <button type="button" class="image-lightbox__close" aria-label="Close enlarged image"><span aria-hidden="true">×</span></button>
      <img class="image-lightbox__img" alt="">
    </div>
  `;

  imageLightboxImgEl = imageLightboxEl.querySelector(".image-lightbox__img");
  const closeBtn = imageLightboxEl.querySelector(".image-lightbox__close");

  closeBtn?.addEventListener("click", closeImageLightbox);
  imageLightboxEl.addEventListener("click", (event) => {
    if (event.target === imageLightboxEl) closeImageLightbox();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && imageLightboxEl && !imageLightboxEl.hidden) {
      closeImageLightbox();
    }
  });

  document.body.appendChild(imageLightboxEl);
}

function openImageLightbox(src, altText = "") {
  if (!src) return;
  ensureImageLightbox();
  if (!imageLightboxEl || !imageLightboxImgEl) return;
  imageLightboxImgEl.src = src;
  imageLightboxImgEl.alt = altText || "Enlarged image";
  imageLightboxEl.hidden = false;
  imageLightboxEl.setAttribute("aria-hidden", "false");
}

function closeImageLightbox() {
  if (!imageLightboxEl || !imageLightboxImgEl) return;
  imageLightboxEl.hidden = true;
  imageLightboxEl.setAttribute("aria-hidden", "true");
  imageLightboxImgEl.src = "";
}

function renderSearchResults(resources, container) {
  if (!container) return;
  container.innerHTML = "";

  if (!resources || resources.length === 0) {
    lastHomeSearchResources = [];
    container.innerHTML = `<div class="search-results-empty">No resources found matching your search.</div>`;
    return;
  }

  lastHomeSearchResources = resources;

  // No alphabetical sorting; display in original order

  resources.forEach((r) => {
    const card = document.createElement("div");
    card.className = "search-results-card";
    const title = getResourceDisplayTitle(r);
    const isDistrictAttorney = isDistrictAttorneyCollectionName(r?._collection);
    const categoryTags = getCategoryTags(r);
    const judicialCircuit = r["Judicial Circuit"] || r["Judical Circuit"] || "";
    const county = formatCountyForDisplay(r);
    const countyParts = getResourceCountyPartsOrdered(r);
    const officeBlocks = getResourceOfficeBlocks(r);
    const addressLines = isDistrictAttorney
      ? officeBlocks.map((o) => o.displayLine).filter(Boolean)
      : [getResourceAddressLine(r)].filter(Boolean);
    const phone = r.Phone || r.phone || r["Phone Number"] || r["Phone Number:"] || "";
    /**
     * Top-level org website. For District Attorney, only use canonical document fields — not lowercase `website`,
     * so office-only URLs stored under other keys are not shown as the top-level org website.
     * If the top-level URL matches an office `website` (legacy duplicate save), show it only under the office — not as General.
     */
    const website = isDistrictAttorney
      ? r.Website || r["Website:"] || ""
      : r.Website || r.website || r["Website:"] || "";
    // Legacy data may use Description instead of Services; render both as "Services" on home cards.
    const servicesOrDescription = getFieldValueCaseInsensitive(r, [
      "Services",
      "Services:",
      "services",
      "services:",
      "Service",
      "Service:",
      "Description",
      "Description:",
      "description",
      "description:",
      "Notes",
      "notes",
      "Summary",
      "summary",
      "Details",
      "details",
      "About",
      "about",
    ]);
    const hours = r.Hours || r["Hours:"] || "";
    const organization = r.Organization || r["Organization:"] || "";
    const shouldShowOrganization =
      Boolean(organization) &&
      normalizeField(organization).toLowerCase() !== normalizeField(title).toLowerCase();

    const useGroupedOffices =
      isDistrictAttorney &&
      officeBlocks.length > 0 && (officeBlocks.length > 1 || countyParts.length > 1);
    const websiteNorm = normalizeField(website);
    let showHeaderWebsite = Boolean(websiteNorm);
    if (isDistrictAttorney && showHeaderWebsite && officeBlocks.length > 0) {
      const g = websiteNorm.toLowerCase();
      const matchesOnlyOfficeUrl = officeBlocks.some(
        (o) => g && normalizeField(o.website || "").toLowerCase() === g
      );
      if (matchesOnlyOfficeUrl) {
        showHeaderWebsite = false;
      }
    }
    const singleOfficeWebsiteLine =
      !useGroupedOffices && officeBlocks.length === 1
        ? normalizeField(officeBlocks[0].website || "")
        : "";

    let officeGroupsHtml = "";
    if (useGroupedOffices) {
      officeGroupsHtml = officeBlocks
        .map((o) => {
          const heading = getOfficeSectionHeading(r, o, officeBlocks);
          const addrLine = o.displayLine || "";
          const phoneLine =
            normalizeField(o.phone) ||
            (officeBlocks.length === 1 ? phone : "");
          const webLine = normalizeField(o.website || "");
          const headingHtml = heading
            ? `<p class="search-results-card__office-heading"><strong>${escapeHtml(heading)}</strong></p>`
            : "";
          const addrHtml = addrLine
            ? `<p class="search-results-card__detail"><strong>Address:</strong> <span class="search-results-card__detail-value">${formatFieldValueAsHtml("Address", addrLine)}</span></p>`
            : "";
          const phoneHtml = phoneLine
            ? `<p class="search-results-card__detail"><strong>Phone:</strong> <span class="search-results-card__detail-value">${formatFieldValueAsHtml("Phone", phoneLine)}</span></p>`
            : "";
          const webHtml = webLine
            ? `<p class="search-results-card__detail"><strong>Website:</strong> <span class="search-results-card__detail-value">${formatFieldValueAsHtml("Website", webLine)}</span></p>`
            : "";
          if (!headingHtml && !addrHtml && !phoneHtml && !webHtml) return "";
          return `<div class="search-results-card__office-group">${headingHtml}${addrHtml}${phoneHtml}${webHtml}</div>`;
        })
        .filter(Boolean)
        .join("");
    }

    const addressItems = addressLines.map((line, idx) => ({
      label: addressLines.length > 1 ? `Address ${idx + 1}` : "Address",
      value: line,
    }));
    const officePhoneItems = officeBlocks
      .filter((o) => o.phone)
      .map((o, idx) => ({
        label: officeBlocks.length > 1 ? `Phone ${idx + 1}` : "Phone",
        value: o.phone,
      }));
    const items = [
      categoryTags.length > 0 && { label: "Categories", value: categoryTags.join(", ") },
      shouldShowOrganization && { label: "Organization", value: organization },
      judicialCircuit && { label: "Judicial Circuit", value: judicialCircuit },
      county && { label: "County", value: county },
      ...(useGroupedOffices
        ? []
        : [
            ...addressItems,
            ...(officePhoneItems.length > 0 ? officePhoneItems : [phone && { label: "Phone", value: phone }]),
          ]),
      showHeaderWebsite && { label: "Website", value: website },
      singleOfficeWebsiteLine && { label: "Website", value: singleOfficeWebsiteLine },
      hours && { label: "Hours", value: hours },
      servicesOrDescription && { label: "Services", value: servicesOrDescription },
    ].filter(Boolean);

    const logoURL = r["Logo URL"] || "";
    const orgInitial = (title.charAt(0) || "?").toUpperCase();
    const logoHtml = logoURL
      ? `<img class="search-results-card__logo" src="${escapeHtml(logoURL)}" alt="${escapeHtml(title)} logo" loading="lazy" data-enlargeable="true">`
      : `<div class="search-results-card__logo-placeholder" aria-hidden="true">${escapeHtml(orgInitial)}</div>`;

    const mapBtnHtml =
      resourceHasAddress(r) && r._collection && r.id
        ? `<p class="search-results-card__map-wrap"><button type="button" class="search-results-card__map-btn" data-map-collection="${escapeHtml(r._collection)}" data-map-id="${escapeHtml(r.id)}">View on map</button></p>`
        : "";
    const inlineMapHtml =
      resourceHasAddress(r) && r._collection && r.id
        ? `<div class="search-results-card__inline-map" hidden>
        <div class="search-results-card__inline-map-header">
          <button type="button" class="search-results-card__inline-map-close">Close map</button>
        </div>
        <p class="search-results-card__inline-map-status" role="status" hidden></p>
        <div class="search-results-card__inline-map-canvas" aria-hidden="true"></div>
      </div>`
        : "";

    card.innerHTML = `
      <div class="search-results-card__main">
        ${logoHtml}
        <div class="search-results-card__body">
          <h3 class="search-results-card__title">${escapeHtml(title)}</h3>
          ${items.map(({ label, value }) => buildResultDetailHtml(label, value)).join("")}
          ${useGroupedOffices ? officeGroupsHtml : ""}
          ${mapBtnHtml}
        </div>
      </div>
      ${inlineMapHtml}
    `;
    container.appendChild(card);
  });
  setupServicesDescriptionToggles();
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/** Returns safe tel: href from a phone string (digits, spaces, dashes, parens, dots, plus). */
function formatPhoneHref(phone) {
  if (!phone || typeof phone !== "string") return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return "";
  return "tel:" + (digits.length === 10 ? "+1" + digits : "+" + digits);
}

/** Returns safe website href - only allows http/https. */
function formatWebsiteHref(url) {
  if (!url || typeof url !== "string") return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return "https://" + trimmed;
}

/** True on iOS / iPadOS / macOS. Capacitor WKWebView often omits "iPhone" from the user agent, so check `Capacitor.getPlatform()` too. */
function isAppleMapsClient() {
  if (typeof window !== "undefined") {
    try {
      const platform = window.Capacitor?.getPlatform?.();
      if (platform === "ios") return true;
    } catch {
      /* ignore */
    }
  }
  if (typeof navigator !== "undefined" && /iPhone|iPad|iPod|Macintosh/i.test(navigator.userAgent)) {
    return true;
  }
  return false;
}

/** Opens in Apple Maps on Apple platforms; Google Maps elsewhere. */
function mapsSearchUrlForAddress(address) {
  const q = encodeURIComponent(String(address).trim());
  if (isAppleMapsClient()) {
    return `https://maps.apple.com/?q=${q}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

/** Renders a value as a clickable link for phone/website fields, or escaped text otherwise. */
function formatFieldValueAsHtml(fieldKey, value) {
  if (value === undefined || value === null || value === "") return "";
  const str = String(value).trim();
  if (!str) return "";

  const key = String(fieldKey).toLowerCase();
  if (key === "phone number" || key === "phone" || key.startsWith("phone ")) {
    const href = formatPhoneHref(str);
    if (!href) return escapeHtml(str);
    return `<a href="${escapeHtml(href)}" class="resource-link resource-link--phone">${escapeHtml(str)}</a>`;
  }
  if (
    key === "website" ||
    key.startsWith("website (") ||
    key === "office website" ||
    key === "general website"
  ) {
    const href = formatWebsiteHref(str);
    if (!href) return escapeHtml(str);
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="resource-link resource-link--website">${escapeHtml(str)}</a>`;
  }
  if (key === "address" || key.startsWith("address ")) {
    const mapsUrl = mapsSearchUrlForAddress(str);
    return `<a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="resource-link resource-link--address">${escapeHtml(str)}</a>`;
  }
  return escapeHtml(str);
}

function buildResourceMapPopupHtml(r, addressLine = "", phoneOverride = "", countySubtitle = "") {
  const dispTitle = getResourceDisplayTitle(r);
  const addr = addressLine || getResourceAddressLine(r);
  const phone = phoneOverride || r.Phone || r.phone || r["Phone Number"] || r["Phone Number:"] || "";
  const phoneHref = formatPhoneHref(phone);
  const popupParts = [
    `<strong>${escapeHtml(dispTitle)}</strong>`,
    countySubtitle
      ? `<div class="resource-map-popup__subtitle">${escapeHtml(countySubtitle)}</div>`
      : "",
    `<div class="resource-map-popup__addr">${escapeHtml(addr)}</div>`,
  ].filter(Boolean);
  if (phone) {
    popupParts.push(
      phoneHref
        ? `<div><a href="${escapeHtml(phoneHref)}">${escapeHtml(phone)}</a></div>`
        : `<div>${escapeHtml(phone)}</div>`
    );
  }
  return popupParts.join("");
}

// ----- Geocoding + Leaflet helpers (inline home maps) -----
const GEOCODE_CACHE_KEY = "avap-geocode-v1";
const NOMINATIM_DELAY_MS = 1100;
/** If set (Vite: .env → VITE_GOOGLE_MAPS_GEOCODING_KEY), geocoding runs in parallel batches (much faster). Restrict the key by HTTP referrer in Google Cloud. */
const GOOGLE_GEOCODING_KEY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GOOGLE_MAPS_GEOCODING_KEY
    ? String(import.meta.env.VITE_GOOGLE_MAPS_GEOCODING_KEY).trim()
    : "";
const GOOGLE_GEOCODE_PARALLEL = 12;
const ALABAMA_MAP_VIEW = { center: [32.8, -86.8], zoom: 7 };
/** SW then NE corners — keeps panning on Alabama only (slight padding). */
const ALABAMA_LAT_LNG_BOUNDS = [
  [30.05, -88.55],
  [35.08, -84.82],
];
/** Nominatim viewbox: west, north, east, south (lon/lat) to bias results toward Alabama. */
const ALABAMA_VIEWBOX = "-88.49,35.01,-84.89,30.14";

function normalizeGeocodeCacheKey(q) {
  return q.trim().toLowerCase();
}

function readGeocodeCache() {
  try {
    const raw = localStorage.getItem(GEOCODE_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeGeocodeCacheEntry(normKey, lat, lng) {
  try {
    const c = readGeocodeCache();
    c[normKey] = { lat, lng };
    localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(c));
  } catch (e) {
    console.warn("Geocode cache write failed.", e);
  }
}

function coordsFromGeoLikeObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const latRaw = obj.latitude ?? obj.lat;
  const lngRaw = obj.longitude ?? obj.lng ?? obj.long ?? obj.lon;
  if (latRaw == null || lngRaw == null) return null;
  const lat = typeof latRaw === "number" ? latRaw : parseFloat(String(latRaw));
  const lng = typeof lngRaw === "number" ? lngRaw : parseFloat(String(lngRaw));
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
}

function getStoredResourceCoords(r) {
  if (!r) return null;
  for (const key of ["location", "Location", "geo", "Geo", "coordinates", "Coordinates"]) {
    const fromObj = coordsFromGeoLikeObject(r[key]);
    if (fromObj) return fromObj;
  }
  const latRaw = r.Latitude ?? r.latitude ?? r.lat;
  const lngRaw = r.Longitude ?? r.longitude ?? r.lng ?? r.lon ?? r.long;
  if (latRaw == null || lngRaw == null) return null;
  const lat = typeof latRaw === "number" ? latRaw : parseFloat(String(latRaw));
  const lng = typeof lngRaw === "number" ? lngRaw : parseFloat(String(lngRaw));
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
}

function buildGeocodeQuery(r) {
  const firstBlock = getResourceAddressBlocks(r)[0];
  if (!firstBlock) return null;
  return firstBlock.geocodeQuery || firstBlock.cityStateZipQuery || null;
}

/** Shorter query when street line fails (suite/PO Box / typos confuse geocoders). */
function buildCityStateZipGeocodeQuery(r) {
  const firstBlock = getResourceAddressBlocks(r)[0];
  if (!firstBlock) return null;
  return firstBlock.cityStateZipQuery || null;
}

let nominatimRequestCount = 0;

/**
 * @param {{ omitViewbox?: boolean }} [opts] If true, omit viewbox (retry when Alabama-biased search returns no hit).
 */
async function geocodeWithNominatim(query, opts = {}) {
  const { omitViewbox = false } = opts;
  const norm = normalizeGeocodeCacheKey(query);
  const cache = readGeocodeCache();
  if (cache[norm]) return cache[norm];

  if (nominatimRequestCount > 0) {
    await new Promise((resolve) => setTimeout(resolve, NOMINATIM_DELAY_MS));
  }
  nominatimRequestCount += 1;

  const params = new URLSearchParams({
    q: query,
    format: "json",
    limit: "1",
    countrycodes: "us",
    bounded: "0",
  });
  if (!omitViewbox) {
    params.set("viewbox", ALABAMA_VIEWBOX);
  }

  const url = "https://nominatim.openstreetmap.org/search?" + params;

  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    data = await res.json();
  } catch (e) {
    console.warn("Nominatim request failed", e);
    return null;
  }
  if (!data || !data[0]) return null;
  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  writeGeocodeCacheEntry(norm, lat, lng);
  return { lat, lng };
}

/**
 * Google Geocoding API — same cache as Nominatim; safe to call many times in parallel (subject to your Google quota).
 * https://developers.google.com/maps/documentation/geocoding/overview
 */
async function geocodeWithGoogle(query) {
  const norm = normalizeGeocodeCacheKey(query);
  const cache = readGeocodeCache();
  if (cache[norm]) return cache[norm];
  if (!GOOGLE_GEOCODING_KEY) return null;

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?" +
    new URLSearchParams({
      address: query,
      key: GOOGLE_GEOCODING_KEY,
      region: "us",
      components: "country:US",
      bounds: "30.05,-88.55|35.08,-84.82",
    });

  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch (e) {
    console.warn("Google Geocoding request failed (CORS or network). Use server-side geocoding or the OpenStreetMap path.", e);
    return null;
  }
  if (data.status === "ZERO_RESULTS") return null;
  if (data.status !== "OK" || !data.results?.[0]) {
    console.warn("Google Geocoding:", data.status, data.error_message || "");
    return null;
  }
  const loc = data.results[0].geometry.location;
  const lat = loc.lat;
  const lng = loc.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  writeGeocodeCacheEntry(norm, lat, lng);
  return { lat, lng };
}

/**
 * @param {{ onNominatimNormResolved?: (norm: string) => void }} [progress] OpenStreetMap path only: called after each norm is looked up (if cached coords exist).
 */
async function runGeocodeForNorms(normsToFetch, queryByNorm, statusEl, progress = {}) {
  const { onNominatimNormResolved } = progress;
  let cacheSnapshot = readGeocodeCache();
  if (normsToFetch.length === 0) return cacheSnapshot;

  const useGoogle = Boolean(GOOGLE_GEOCODING_KEY);

  if (useGoogle) {
    for (let i = 0; i < normsToFetch.length; i += GOOGLE_GEOCODE_PARALLEL) {
      const batch = normsToFetch.slice(i, i + GOOGLE_GEOCODE_PARALLEL);
      await Promise.all(
        batch.map(async (norm) => {
          const query = queryByNorm.get(norm);
          try {
            await geocodeWithGoogle(query);
          } catch (err) {
            console.warn("Google geocode failed for query", query, err);
          }
        })
      );
      cacheSnapshot = readGeocodeCache();
      if (statusEl) {
        const done = Math.min(i + batch.length, normsToFetch.length);
        statusEl.textContent = `Looking up addresses… ${done} of ${normsToFetch.length}`;
      }
    }
    return cacheSnapshot;
  }

  let fetchIndex = 0;
  for (const norm of normsToFetch) {
    const query = queryByNorm.get(norm);
    try {
      await geocodeWithNominatim(query);
      cacheSnapshot = readGeocodeCache();
      if (onNominatimNormResolved && cacheSnapshot[norm]) {
        onNominatimNormResolved(norm);
      }
    } catch (err) {
      console.warn("Geocode failed for query", query, err);
    }
    fetchIndex += 1;
    if (statusEl && normsToFetch.length > 0) {
      statusEl.textContent = `Looking up addresses… ${fetchIndex} of ${normsToFetch.length} (OpenStreetMap limit: ~1/sec)`;
    }
  }
  return cacheSnapshot;
}

const inlineHomeLeafletMapByCard = new WeakMap();

/**
 * Resolve lat/lng for the home inline map: Firestore coords, then geocoding with fallbacks.
 * OpenStreetMap: retries without Alabama viewbox if the first search returns nothing.
 */
async function resolveCoordsForInlineResourceMap(resource, statusEl) {
  const coordsStored = getStoredResourceCoords(resource);
  if (coordsStored) {
    const blocks = getResourceOfficeBlocks(resource);
    const firstBlock = blocks[0] || { index: 1 };
    return [
      {
        coords: coordsStored,
        addressLine: getResourceAddressLine(resource),
        phone: normalizeField(firstBlock.phone) || "",
        countyHeading: getOfficeSectionHeading(resource, firstBlock, blocks.length > 0 ? blocks : [firstBlock]),
      },
    ];
  }

  const blocks = getResourceOfficeBlocks(resource);
  if (blocks.length === 0) return [];

  const markers = [];
  const seenNorms = new Set();
  const seenCoords = new Set();

  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    const block = blocks[blockIdx];
    const queries = [];
    if (block.geocodeQuery) queries.push(block.geocodeQuery);
    if (
      block.cityStateZipQuery &&
      (!block.geocodeQuery ||
        normalizeGeocodeCacheKey(block.cityStateZipQuery) !== normalizeGeocodeCacheKey(block.geocodeQuery))
    ) {
      queries.push(block.cityStateZipQuery);
    }
    let matchedCoords = null;
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      const norm = normalizeGeocodeCacheKey(q);
      if (!norm || seenNorms.has(norm)) continue;
      seenNorms.add(norm);

      let cacheSnap = readGeocodeCache();
      matchedCoords = cacheSnap[norm] || null;
      if (!matchedCoords) {
        if (statusEl) {
          if (i > 0) {
            statusEl.textContent = "Trying city and ZIP…";
          } else {
            statusEl.textContent = GOOGLE_GEOCODING_KEY
              ? "Looking up address (Google Geocoding)…"
              : "Looking up address (OpenStreetMap)…";
          }
        }

        const normsToFetch = [norm];
        const queryByNorm = new Map([[norm, q]]);
        cacheSnap = await runGeocodeForNorms(normsToFetch, queryByNorm, statusEl);
        matchedCoords = cacheSnap[norm] || readGeocodeCache()[norm] || null;
        if (!matchedCoords && !GOOGLE_GEOCODING_KEY) {
          if (statusEl) statusEl.textContent = "Trying broader map search…";
          await geocodeWithNominatim(q, { omitViewbox: true });
          matchedCoords = readGeocodeCache()[norm] || null;
        }
      }
      if (matchedCoords) break;
    }
    if (matchedCoords) {
      const key = `${matchedCoords.lat.toFixed(6)},${matchedCoords.lng.toFixed(6)}`;
      if (!seenCoords.has(key)) {
        seenCoords.add(key);
        markers.push({
          coords: matchedCoords,
          addressLine: block.displayLine || "",
          phone: block.phone || "",
          countyHeading: getOfficeSectionHeading(resource, block, blocks),
        });
      }
    }
  }

  return markers;
}

/** Hide canvas so error-only states do not keep the empty gray map box (min-height) visible. */
function setInlineMapCanvasPlaceholderVisible(canvas, visible) {
  if (!canvas) return;
  canvas.hidden = !visible;
  if (!visible) {
    canvas.innerHTML = "";
    canvas.setAttribute("aria-hidden", "true");
  }
}

function destroyInlineHomeMap(card) {
  if (!card) return;
  const leafletMap = inlineHomeLeafletMapByCard.get(card);
  if (leafletMap) {
    try {
      leafletMap.remove();
    } catch {
      /* ignore */
    }
    inlineHomeLeafletMapByCard.delete(card);
  }
  const canvas = card.querySelector(".search-results-card__inline-map-canvas");
  if (canvas) {
    canvas.innerHTML = "";
    canvas.setAttribute("aria-hidden", "true");
    canvas.hidden = false;
  }
  const panel = card.querySelector(".search-results-card__inline-map");
  const statusEl = card.querySelector(".search-results-card__inline-map-status");
  if (panel) panel.hidden = true;
  if (statusEl) {
    statusEl.textContent = "";
    statusEl.hidden = true;
  }
}

async function openInlineHomeResourceMap(card, resource) {
  const panel = card.querySelector(".search-results-card__inline-map");
  const statusEl = card.querySelector(".search-results-card__inline-map-status");
  const canvas = card.querySelector(".search-results-card__inline-map-canvas");
  if (!panel || !canvas) return;

  destroyInlineHomeMap(card);
  panel.hidden = false;
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.textContent = "Loading map…";
  }
  canvas.innerHTML = "";
  canvas.removeAttribute("aria-hidden");
  setInlineMapCanvasPlaceholderVisible(canvas, true);

  nominatimRequestCount = 0;

  try {
    await import("leaflet/dist/leaflet.css");
    const L = (await import("leaflet")).default;

    const alBounds = L.latLngBounds(ALABAMA_LAT_LNG_BOUNDS);
    const map = L.map(canvas, {
      scrollWheelZoom: true,
      maxBounds: alBounds,
      maxBoundsViscosity: 1,
      minZoom: 6,
    }).setView(ALABAMA_MAP_VIEW.center, ALABAMA_MAP_VIEW.zoom);

    map.setMaxBounds(alBounds);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    inlineHomeLeafletMapByCard.set(card, map);

    if (!resourceHasAddress(resource)) {
      if (statusEl) {
        statusEl.textContent = "No geocodable address for this resource.";
        statusEl.hidden = false;
      }
      map.remove();
      inlineHomeLeafletMapByCard.delete(card);
      setInlineMapCanvasPlaceholderVisible(canvas, false);
      return;
    }

    const markerData = await resolveCoordsForInlineResourceMap(resource, statusEl);

    if (!markerData || markerData.length === 0) {
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent =
          "The map couldn’t load for this location. For directions or more information, use the website or phone number listed for this resource above.";
      }
      map.remove();
      inlineHomeLeafletMapByCard.delete(card);
      setInlineMapCanvasPlaceholderVisible(canvas, false);
      return;
    }

    const pad = L.point(24, 24);
    const markers = markerData.map(({ coords, addressLine, phone: officePhone, countyHeading }) => {
      const marker = L.circleMarker([coords.lat, coords.lng], {
        radius: 7,
        color: "#1d4ed8",
        fillColor: "#3b82f6",
        fillOpacity: 0.88,
        weight: 2,
      });
      marker.bindPopup(buildResourceMapPopupHtml(resource, addressLine, officePhone, countyHeading || ""), {
        maxWidth: 300,
        autoPan: true,
        autoPanPaddingTopLeft: L.point(16, 72),
        autoPanPaddingBottomRight: pad,
        keepInView: true,
      });
      marker.addTo(map);
      return marker;
    });

    if (markerData.length > 1) {
      const bounds = L.latLngBounds(markerData.map(({ coords }) => [coords.lat, coords.lng]));
      map.fitBounds(bounds, { padding: [26, 26], maxZoom: 14 });
    } else {
      const only = markerData[0].coords;
      map.flyTo([only.lat, only.lng], Math.max(map.getZoom(), 14), { duration: 0.55 });
    }
    window.setTimeout(() => {
      if (markers[0]) markers[0].openPopup();
      map.invalidateSize();
    }, 600);

    if (statusEl) {
      statusEl.textContent = "";
      statusEl.hidden = true;
    }
    setInlineMapCanvasPlaceholderVisible(canvas, true);
    setTimeout(() => map.invalidateSize(), 150);
  } catch (err) {
    console.error("Inline resource map failed:", err);
    const leafletMap = inlineHomeLeafletMapByCard.get(card);
    if (leafletMap) {
      try {
        leafletMap.remove();
      } catch {
        /* ignore */
      }
      inlineHomeLeafletMapByCard.delete(card);
    }
    setInlineMapCanvasPlaceholderVisible(canvas, false);
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = "The map could not load. Check your network and try again.";
    }
    panel.hidden = false;
  }
}

// ===== Simple monthly calendar for calendar.html (with Firestore Events) =====

async function fetchEventsForMonth(year, monthIndex) {
  // monthIndex: 0-11
  const eventsByDay = {};

  // Support both "Events" and "events" collection names
  const collectionNames = ["Events", "events"];

  for (const colName of collectionNames) {
    try {
      const eventsRef = collection(firestore, colName);
      const snapshot = await getDocs(eventsRef);

      snapshot.forEach((docSnap) => {
        const data = docSnap.data() || {};
        let jsDate = null;

        const rawDate = data.date;
        if (rawDate instanceof Date) {
          jsDate = rawDate;
        } else if (rawDate && typeof rawDate.toDate === "function") {
          // Firestore Timestamp
          jsDate = rawDate.toDate();
        } else if (typeof rawDate === "string") {
          const parsed = new Date(rawDate);
          if (!Number.isNaN(parsed.getTime())) {
            jsDate = parsed;
          }
        }

        if (!jsDate) return;
        if (jsDate.getFullYear() !== year || jsDate.getMonth() !== monthIndex) return;

        const day = jsDate.getDate();
        if (!eventsByDay[day]) eventsByDay[day] = [];
        eventsByDay[day].push({
          id: docSnap.id,
          collectionName: colName,
          // Be tolerant of slightly different field keys and trim values
          title: (data.title ?? data.Title ?? "Event")?.toString().trim(),
          description:
            (data.description ??
              data.Description ??
              data["description "] ??
              "")?.toString().trim(),
          county:
            (data.county ??
              data.County ??
              data["county "] ??
              "")?.toString().trim(),
          location:
            (data.location ??
              data.Location ??
              data["location "] ??
              "")?.toString().trim(),
          website:
            (data.website ??
              data.Website ??
              data["Website:"] ??
              data.URL ??
              data.Url ??
              data.Link ??
              "")?.toString().trim(),
          date: jsDate,
        });
      });
    } catch (e) {
      // If one collection name doesn't exist, just skip it
      continue;
    }
  }

  return eventsByDay;
}

function toDateInputValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toTimeInputValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function initializeAdminEventForm() {
  const form = document.getElementById("add-event-form");
  if (!form || adminEventFormInitialized) return;
  adminEventFormInitialized = true;

  const eventTitle = document.getElementById("event-title");
  const eventDate = document.getElementById("event-date");
  const eventTime = document.getElementById("event-time");
  const eventCounty = document.getElementById("event-county");
  const eventLocation = document.getElementById("event-location");
  const eventWebsite = document.getElementById("event-website");
  const eventDescription = document.getElementById("event-description");
  const editingEventId = document.getElementById("editing-event-id");
  const editingEventCollection = document.getElementById("editing-event-collection");
  const saveEventButton = document.getElementById("save-event-button");
  const cancelEditEventButton = document.getElementById("cancel-edit-event-button");
  const eventFormStatus = document.getElementById("event-form-status");

  function setStatus(message, isError = false) {
    if (!eventFormStatus) return;
    eventFormStatus.textContent = message || "";
    eventFormStatus.classList.toggle("admin-event-form__status--error", isError);
  }

  function clearEditState() {
    if (editingEventId) editingEventId.value = "";
    if (editingEventCollection) editingEventCollection.value = "";
    if (saveEventButton) saveEventButton.textContent = "Add Event";
    if (cancelEditEventButton) cancelEditEventButton.hidden = true;
  }

  if (cancelEditEventButton) {
    cancelEditEventButton.addEventListener("click", () => {
      form.reset();
      clearEditState();
      setStatus("Edit cancelled.");
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = (eventTitle?.value || "").trim();
    const dateValue = (eventDate?.value || "").trim();
    const timeValue = (eventTime?.value || "").trim();
    const county = (eventCounty?.value || "").trim();
    const location = (eventLocation?.value || "").trim();
    const websiteRaw = (eventWebsite?.value || "").trim();
    const website = websiteRaw ? formatWebsiteHref(websiteRaw) : "";
    const description = (eventDescription?.value || "").trim();

    if (!title || !dateValue) {
      setStatus("Title and date are required.", true);
      return;
    }

    const parsedDate = new Date(`${dateValue}T${timeValue || "12:00"}:00`);
    if (Number.isNaN(parsedDate.getTime())) {
      setStatus("Please enter a valid date.", true);
      return;
    }

    const payload = {
      title,
      county,
      location,
      website,
      description,
      date: parsedDate,
    };

    try {
      const editId = editingEventId?.value || "";
      const editCollection = editingEventCollection?.value || "Events";

      if (editId) {
        const eventRef = doc(firestore, editCollection, editId);
        await updateDoc(eventRef, payload);
        setStatus("Event updated.");
      } else {
        // Prefer canonical collection name first so admin checks match expectations.
        // Keep fallback for environments/rules that still use lowercase.
        const createCandidates = ["Events", "events"];
        let created = false;
        let createError = null;
        for (const colName of createCandidates) {
          try {
            const eventsRef = collection(firestore, colName);
            await addDoc(eventsRef, payload);
            if (editingEventCollection) editingEventCollection.value = colName;
            created = true;
            break;
          } catch (err) {
            createError = err;
          }
        }
        if (!created) {
          throw createError || new Error("Could not create event document.");
        }
        setStatus("Event added.");
      }

      form.reset();
      clearEditState();
      await renderMonthlyCalendar();
    } catch (error) {
      console.error("Error saving event:", error);
      setStatus(`Could not save event. ${error?.message || "Please try again."}`, true);
    }
  });
}

let activeCalendarYear = null;
let activeCalendarMonthIndex = null; // 0-11
let activeCalendarSelectedDay = null; // 1-31 within current month

async function renderMonthlyCalendar(year, monthIndex) {
  const container = document.getElementById("events-calendar");
  if (!container) return;

  const now = new Date();
  if (year == null) year = now.getFullYear();
  if (monthIndex == null) monthIndex = now.getMonth();

  // Start at first day of month
  const firstOfMonth = new Date(year, monthIndex, 1);
  const startWeekday = firstOfMonth.getDay(); // 0=Sunday
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  const monthName = firstOfMonth.toLocaleString(undefined, { month: "long" });
  const isAdminCalendar = document.body.classList.contains("admin-page");

  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const eventsByDay = await fetchEventsForMonth(year, monthIndex);
  // Build a lookup for admin edit/remove actions (id + collectionName).
  // This avoids trying to scrape values out of the rendered DOM.
  adminEventLookup = new Map();
  Object.values(eventsByDay).forEach((events) => {
    (events || []).forEach((ev) => {
      if (!ev) return;
      const col = ev.collectionName || "Events";
      const id = ev.id || "";
      if (!id) return;
      adminEventLookup.set(`${col}:${id}`, ev);
    });
  });

  const monthLabelText = `${monthName} ${year}`;
  const monthLabelEl = document.getElementById("calendar-month-label");
  if (monthLabelEl) {
    monthLabelEl.textContent = monthLabelText;
  }

  const headerHtml = monthLabelEl
    ? ""
    : `
    <div class="events-calendar__header">
      <span class="events-calendar__month">${escapeHtml(monthLabelText)}</span>
    </div>
  `;

  let gridHtml = '<div class="events-calendar__grid">';

  // Weekday headings
  weekdayLabels.forEach((label) => {
    gridHtml += `<div class="events-calendar__weekday">${escapeHtml(label)}</div>`;
  });

  // Empty cells before first day
  for (let i = 0; i < startWeekday; i++) {
    gridHtml += '<div class="events-calendar__day events-calendar__day--empty" aria-hidden="true"></div>';
  }

  const isCurrentMonth =
    year === now.getFullYear() && monthIndex === now.getMonth();
  const todayDate = isCurrentMonth ? now.getDate() : null;

  // Actual days
  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = day === todayDate;
    const hasEvents = !!eventsByDay[day];
    const dayClasses = ["events-calendar__day"];
    if (isToday) dayClasses.push("events-calendar__day--today");
    if (hasEvents) dayClasses.push("events-calendar__day--has-events");
    if (activeCalendarSelectedDay === day) dayClasses.push("events-calendar__day--selected");

    gridHtml += `
      <button
        type="button"
        class="${dayClasses.join(" ")}"
        data-day="${day}"
        aria-pressed="${activeCalendarSelectedDay === day ? "true" : "false"}"
        aria-label="${escapeHtml(monthName)} ${day}, ${year}${isToday ? " (today)" : ""}"
      >
        <span class="events-calendar__day-number">${day}</span>
      </button>
    `;
  }

  gridHtml += "</div>";

  container.innerHTML = headerHtml + gridHtml;

  // When a day is clicked, show that day's events below the calendar
  const eventsListEl = document.getElementById("events-calendar-list");
  if (eventsListEl) {
    // Helper to render details for a specific day
    const renderEventsForDay = (day) => {
      const events = eventsByDay[day] || [];
      const dayLabel = `${escapeHtml(monthName)} ${day}, ${year}`;

      if (!events.length) {
        eventsListEl.innerHTML = `<p class="events-calendar__no-events">No events are listed for ${dayLabel}.</p>`;
        return;
      }

      let listHtml = `<div class="events-calendar__day-group"><h4>${dayLabel}</h4><ul>`;
      events.forEach((ev) => {
        const title = escapeHtml(ev.title || ev.Title || "Event");
        const desc = ev.description ? escapeHtml(ev.description) : "";
        const loc = ev.location ? escapeHtml(ev.location) : "";
        const websiteText = ev.website ? escapeHtml(ev.website) : "";
        const websiteHref = ev.website ? formatWebsiteHref(ev.website) : "";
        const county = ev.county ? escapeHtml(ev.county) : "";
        const dateStr =
          ev.date instanceof Date
            ? ev.date.toLocaleString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })
            : dayLabel;

        const eventCollection = escapeHtml(ev.collectionName || "Events");
        const eventId = escapeHtml(ev.id || "");
        const editBtn = isAdminCalendar
          ? `<button type="button" class="admin-event-edit-btn" data-event-id="${eventId}" data-event-collection="${eventCollection}" aria-label="Edit ${title}">Edit</button>`
          : "";
        const removeBtn = isAdminCalendar
          ? `<button type="button" class="admin-event-remove-btn" data-event-id="${eventId}" data-event-collection="${eventCollection}" aria-label="Remove ${title}">Remove</button>`
          : "";
        const actionButtons = isAdminCalendar
          ? `<div class="admin-event-actions">${editBtn}${removeBtn}</div>`
          : "";

        listHtml += `<li>
          <strong>${title}</strong>
          <div class="events-calendar__event-meta"><strong>Date:</strong> ${escapeHtml(dateStr)}</div>
          ${county ? `<div class="events-calendar__event-meta"><strong>County:</strong> ${county}</div>` : ""}
          ${loc ? `<div class="events-calendar__event-meta"><strong>Location:</strong> ${loc}</div>` : ""}
          ${websiteText ? `<div class="events-calendar__event-meta"><strong>Website:</strong> ${websiteHref ? `<a href="${escapeHtml(websiteHref)}" target="_blank" rel="noopener noreferrer">${websiteText}</a>` : websiteText}</div>` : ""}
          ${desc ? `<div class="events-calendar__event-meta"><strong>Description:</strong> ${desc}</div>` : ""}
          ${actionButtons}
        </li>`;
      });
      listHtml += `</ul></div>`;
      eventsListEl.innerHTML = listHtml;

      if (isAdminCalendar && !eventsListEl.dataset.actionsBound) {
        eventsListEl.dataset.actionsBound = "true";
        eventsListEl.addEventListener("click", async (event) => {
          const editBtn = event.target.closest(".admin-event-edit-btn");
          const removeBtn = event.target.closest(".admin-event-remove-btn");

          if (editBtn) {
            const eventId = editBtn.getAttribute("data-event-id") || "";
            const eventCollection = editBtn.getAttribute("data-event-collection") || "Events";
            const eventKey = `${eventCollection}:${eventId}`;
            let selectedEvent = adminEventLookup.get(eventKey);
            if (!selectedEvent) {
              // Fallback: scan current month events (should be rare)
              selectedEvent = Object.values(eventsByDay)
                .flat()
                .find((ev) => ev && (ev.collectionName || "Events") === eventCollection && ev.id === eventId);
            }
            if (!selectedEvent) return;

            const form = document.getElementById("add-event-form");
            const eventTitle = document.getElementById("event-title");
            const eventDate = document.getElementById("event-date");
            const eventTime = document.getElementById("event-time");
            const eventCounty = document.getElementById("event-county");
            const eventLocation = document.getElementById("event-location");
            const eventWebsite = document.getElementById("event-website");
            const eventDescription = document.getElementById("event-description");
            const editingEventId = document.getElementById("editing-event-id");
            const editingEventCollection = document.getElementById("editing-event-collection");
            const saveEventButton = document.getElementById("save-event-button");
            const cancelEditEventButton = document.getElementById("cancel-edit-event-button");
            const eventFormStatus = document.getElementById("event-form-status");

            if (eventTitle) eventTitle.value = selectedEvent.title || "";
            if (eventDate) eventDate.value = toDateInputValue(selectedEvent.date);
            if (eventTime) eventTime.value = toTimeInputValue(selectedEvent.date);
            if (eventCounty) eventCounty.value = selectedEvent.county || "";
            if (eventLocation) eventLocation.value = selectedEvent.location || "";
            if (eventWebsite) eventWebsite.value = selectedEvent.website || "";
            if (eventDescription) eventDescription.value = selectedEvent.description || "";
            if (editingEventId) editingEventId.value = eventId;
            if (editingEventCollection) editingEventCollection.value = eventCollection;
            if (saveEventButton) saveEventButton.textContent = "Save Changes";
            if (cancelEditEventButton) cancelEditEventButton.hidden = false;
            if (eventFormStatus) eventFormStatus.textContent = "Editing event. Update fields and click Save Changes.";
            if (form) form.scrollIntoView({ behavior: "smooth", block: "start" });
            return;
          }

          if (removeBtn) {
            const eventId = removeBtn.getAttribute("data-event-id") || "";
            const eventCollection = removeBtn.getAttribute("data-event-collection") || "Events";
            if (!eventId) return;
            const eventKey = `${eventCollection}:${eventId}`;
            const selectedEvent = adminEventLookup.get(eventKey);
            const eventTitle = selectedEvent?.title || "this event";
            const shouldDelete = window.confirm(`Delete "${eventTitle}"? This cannot be undone.`);
            if (!shouldDelete) return;

            try {
              await deleteDoc(doc(firestore, eventCollection, eventId));
              await renderMonthlyCalendar();
              const eventFormStatus = document.getElementById("event-form-status");
              if (eventFormStatus) {
                eventFormStatus.textContent = "Event removed.";
                eventFormStatus.classList.remove("admin-event-form__status--error");
              }
            } catch (error) {
              console.error("Error deleting event:", error);
              const eventFormStatus = document.getElementById("event-form-status");
              if (eventFormStatus) {
                eventFormStatus.textContent = "Could not remove event. Please try again.";
                eventFormStatus.classList.add("admin-event-form__status--error");
              }
            }
          }
        });
      }
    };

    // Attach click handlers to each day
    container.querySelectorAll(".events-calendar__day[data-day]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const dayStr = btn.getAttribute("data-day");
        const day = dayStr ? parseInt(dayStr, 10) : NaN;
        if (!Number.isNaN(day)) {
          activeCalendarSelectedDay = day;
          container
            .querySelectorAll(".events-calendar__day--selected")
            .forEach((el) => el.classList.remove("events-calendar__day--selected"));
          container
            .querySelectorAll(".events-calendar__day[data-day]")
            .forEach((el) => el.setAttribute("aria-pressed", "false"));
          btn.classList.add("events-calendar__day--selected");
          btn.setAttribute("aria-pressed", "true");
          renderEventsForDay(day);
        }
      });
    });

    // Clear initial content until a day is chosen
    eventsListEl.innerHTML = `<p class="events-calendar__no-events">Tap a date on the calendar to see events for that day.</p>`;
  }
}

function initCalendarNavigation() {
  const calendarEl = document.getElementById("events-calendar");
  const prevBtn = document.getElementById("calendar-prev");
  const nextBtn = document.getElementById("calendar-next");
  if (!calendarEl || (!prevBtn && !nextBtn)) return;

  const now = new Date();
  activeCalendarYear = now.getFullYear();
  activeCalendarMonthIndex = now.getMonth(); // 0-11

  const onPrev = () => {
    activeCalendarMonthIndex -= 1;
    if (activeCalendarMonthIndex < 0) {
      activeCalendarMonthIndex = 11;
      activeCalendarYear -= 1;
    }
    activeCalendarSelectedDay = null;
    renderMonthlyCalendar(activeCalendarYear, activeCalendarMonthIndex);
  };

  const onNext = () => {
    activeCalendarMonthIndex += 1;
    if (activeCalendarMonthIndex > 11) {
      activeCalendarMonthIndex = 0;
      activeCalendarYear += 1;
    }
    activeCalendarSelectedDay = null;
    renderMonthlyCalendar(activeCalendarYear, activeCalendarMonthIndex);
  };

  prevBtn?.addEventListener("click", onPrev);
  nextBtn?.addEventListener("click", onNext);

  renderMonthlyCalendar(activeCalendarYear, activeCalendarMonthIndex);
}

function splitDescriptionWords(raw) {
  const s = raw == null ? "" : String(raw).trim();
  if (!s) return [];
  return s.split(/\s+/).filter(Boolean);
}

// Build HTML for each detail row, with expandable handling for Services text.
function buildResultDetailHtml(label, value) {
  if (label === "Services") {
    const raw = value == null ? "" : String(value);
    const words = splitDescriptionWords(raw);
    const fullHtml = escapeHtml(raw);
    const strong = `<strong>${escapeHtml(label)}:</strong>`;
    if (words.length <= SERVICES_CARD_PREVIEW_WORD_COUNT) {
      return `
      <p class="search-results-card__detail search-results-card__detail--services">
        ${strong}
        <span class="search-results-card__detail-text">${fullHtml}</span>
      </p>`;
    }
    const truncatedRaw = words.slice(0, SERVICES_CARD_PREVIEW_WORD_COUNT).join(" ") + "\u2026";
    const truncatedHtml = escapeHtml(truncatedRaw);
    return `
      <p class="search-results-card__detail search-results-card__detail--services">
        ${strong}
        <span class="search-results-card__detail-text search-results-card__detail-text--expandable">
          <span class="search-results-card__detail-text-part search-results-card__detail-text-part--truncated">${truncatedHtml}</span>
          <span class="search-results-card__detail-text-part search-results-card__detail-text-part--full" hidden>${fullHtml}</span>
        </span>
        <button type="button" class="search-results-card__more-toggle" aria-expanded="false">
          Show more
        </button>
      </p>`;
  }

  // Default rendering for all other fields (and short Services text)
  return `<p class="search-results-card__detail"><strong>${escapeHtml(label)}:</strong> <span class="search-results-card__detail-value">${formatFieldValueAsHtml(label, value)}</span></p>`;
}

// Attach click handlers to "Show more/less" buttons on resource cards (>15 words only).
function setupServicesDescriptionToggles() {
  document.querySelectorAll(".search-results-card__more-toggle").forEach((btn) => {
    const wrapper = btn.closest(".search-results-card__detail--services");
    if (!wrapper) return;

    const truncated = wrapper.querySelector(".search-results-card__detail-text-part--truncated");
    const full = wrapper.querySelector(".search-results-card__detail-text-part--full");
    if (!truncated || !full) return;

    const fullId = `svc-desc-${Math.random().toString(36).slice(2, 11)}`;
    full.id = fullId;
    btn.setAttribute("aria-controls", fullId);

    btn.addEventListener("click", () => {
      const expanded = btn.getAttribute("aria-expanded") === "true";
      if (expanded) {
        btn.setAttribute("aria-expanded", "false");
        btn.textContent = "Show more";
        truncated.hidden = false;
        full.hidden = true;
      } else {
        btn.setAttribute("aria-expanded", "true");
        btn.textContent = "Show less";
        truncated.hidden = true;
        full.hidden = false;
      }
    });
  });
}

// Populate category filter buttons dynamically from fetched tags
function renderCategoryButtons() {
  const container = document.getElementById("category-buttons");
  if (!container) return;
  container.innerHTML = "";
  resourceCategories.forEach((category) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-btn category-btn";
    btn.dataset.category = category;
    btn.textContent = category;
    container.appendChild(btn);
  });
}

// Initialize search when search form exists (after fetching tags)
async function initSearch() {
  const needsResourceSearch =
    !!document.getElementById("search-form") ||
    !!document.getElementById("dataTable") ||
    !!document.getElementById("category-buttons");
  const calendarEl = document.getElementById("events-calendar");

  if (!needsResourceSearch && !calendarEl) return;

  if (needsResourceSearch) {
    await fetchResourceTags();
    renderCategoryButtons();
    initializeSearch();
    initializeAdminSearch();
  }

  if (!calendarEl) return;

  const hasMonthNavControls =
    !!document.getElementById("calendar-prev") || !!document.getElementById("calendar-next");

  if (hasMonthNavControls) {
    initCalendarNavigation();
  } else {
    renderMonthlyCalendar();
  }
}

function bootstrapApp() {
  // Bind admin calendar event form submit handler whenever that form exists.
  initializeAdminEventForm();
  return initSearch();
}

const publicRouteNames = new Set(["home.html", "about.html", "calendar.html", "hotline.html"]);
const publicRouteCache = new Map();
let publicRouteIsNavigating = false;

function isPublicAppRoute(url) {
  const fileName = url.pathname.split("/").pop() || "home.html";
  return url.origin === window.location.origin && url.pathname.includes("/app/") && publicRouteNames.has(fileName);
}

function shouldHandlePublicRouteClick(event, link) {
  if (event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (link.target && link.target !== "_self") return false;
  if (link.hasAttribute("download")) return false;

  const href = link.getAttribute("href") || "";
  if (!href || href.startsWith("#")) return false;
  if (/^(mailto:|tel:|sms:|javascript:)/i.test(href)) return false;

  const targetUrl = new URL(href, window.location.href);
  if (!isPublicAppRoute(targetUrl)) return false;
  if (targetUrl.pathname === window.location.pathname && targetUrl.search === window.location.search) return false;

  return isPublicAppRoute(new URL(window.location.href));
}

function updatePublicNavState(pathname) {
  const currentFile = pathname.split("/").pop() || "home.html";
  document.querySelectorAll(".main-menu__link").forEach((link) => {
    const href = link.getAttribute("href") || "";
    const targetFile = href.split("/").pop();
    const isCurrent = targetFile === currentFile;
    link.classList.toggle("main-menu__link--active", isCurrent);
    if (isCurrent) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });
}

function savePublicRoute(pathname, search = "", hash = "") {
  try {
    localStorage.setItem("avap:lastPath", pathname + search + hash);
  } catch {
    // Ignore storage errors; navigation should still work.
  }
}

async function fetchPublicRouteDocument(url) {
  const cacheKey = url.href;
  if (!publicRouteCache.has(cacheKey)) {
    publicRouteCache.set(
      cacheKey,
      fetch(url.href, { credentials: "same-origin" })
        .then((response) => {
          if (!response.ok) throw new Error(`Route fetch failed: ${response.status}`);
          return response.text();
        })
        .then((html) => new DOMParser().parseFromString(html, "text/html"))
    );
  }

  return publicRouteCache.get(cacheKey);
}

function syncWelcomeModal(nextDocument) {
  const existingModal = document.getElementById("welcomeModal");
  if (existingModal) existingModal.remove();

  const nextModal = nextDocument.getElementById("welcomeModal");
  if (!nextModal) return;

  const topBar = document.querySelector(".top-bar");
  document.body.insertBefore(nextModal.cloneNode(true), topBar || document.body.firstChild);
  initializeWelcomeModal();
}

function applyPublicBodyClass(nextBody) {
  const preservedClasses = ["site-nav--compact"].filter((className) => document.body.classList.contains(className));
  document.body.className = nextBody?.className || "";
  preservedClasses.forEach((className) => document.body.classList.add(className));
}

function initializeWelcomeModal() {
  const welcomeModal = document.getElementById("welcomeModal");
  if (!welcomeModal || welcomeModal.dataset.bound === "true") return;
  welcomeModal.dataset.bound = "true";

  try {
    if (!sessionStorage.getItem("welcomeModalShown")) {
      welcomeModal.style.display = "flex";
      sessionStorage.setItem("welcomeModalShown", "true");
    } else {
      welcomeModal.style.display = "none";
    }

    document.getElementById("closeWelcomeModal")?.addEventListener("click", () => {
      welcomeModal.style.display = "none";
    });
    document.getElementById("emergencyYes")?.addEventListener("click", () => {
      navigatePublicRoute(new URL("hotline.html", window.location.href));
    });
    document.getElementById("emergencyNo")?.addEventListener("click", () => {
      welcomeModal.style.display = "none";
    });
  } catch (error) {
    console.warn("Welcome modal error:", error);
  }
}

function initializeCurrentPrivacyStatement() {
  document.querySelectorAll(".privacy-statement-mobile").forEach((wrapper) => {
    const toggleBtn = wrapper.querySelector(".privacy-statement-mobile__toggle");
    if (!toggleBtn || toggleBtn.dataset.bound === "true") return;
    toggleBtn.dataset.bound = "true";
    toggleBtn.addEventListener("click", () => {
      const expanded = wrapper.classList.toggle("privacy-statement-mobile--expanded");
      toggleBtn.textContent = expanded ? "less" : "more";
      toggleBtn.setAttribute("aria-expanded", String(expanded));
    });
  });
}

function finishPublicRouteEnter() {
  document.body.classList.remove("public-route-is-leaving");

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document.body.classList.remove("public-route-is-entering");
    });
  });
}

async function navigatePublicRoute(targetUrl, options = {}) {
  if (publicRouteIsNavigating || !isPublicAppRoute(targetUrl)) return;
  publicRouteIsNavigating = true;
  document.body.classList.add("public-route-is-leaving");

  try {
    const [nextDocument] = await Promise.all([
      fetchPublicRouteDocument(targetUrl),
      new Promise((resolve) => window.setTimeout(resolve, 120)),
    ]);
    const nextContainer = nextDocument.querySelector(".container");
    const currentContainer = document.querySelector(".container");
    if (!nextContainer || !currentContainer) throw new Error("Route container missing.");

    syncWelcomeModal(nextDocument);
    currentContainer.replaceWith(nextContainer.cloneNode(true));
    applyPublicBodyClass(nextDocument.body);
    document.body.classList.add("public-route-is-entering");
    document.title = nextDocument.title || document.title;
    updatePublicNavState(targetUrl.pathname);
    savePublicRoute(targetUrl.pathname, targetUrl.search, targetUrl.hash);

    if (!options.fromPopState) {
      window.history.pushState({ avapPublicRoute: true }, "", targetUrl.href);
    }

    window.scrollTo(0, 0);
    initializeCurrentPrivacyStatement();
    bootstrapApp().catch((error) => console.warn("Page initialization after route change failed:", error));
    finishPublicRouteEnter();
  } catch (error) {
    console.warn("Public route navigation fell back to normal load:", error);
    window.location.href = targetUrl.href;
  } finally {
    publicRouteIsNavigating = false;
  }
}

function initializePublicRouter() {
  if (!isPublicAppRoute(new URL(window.location.href)) || document.documentElement.dataset.publicRouterBound === "true") return;
  document.documentElement.dataset.publicRouterBound = "true";

  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link || !shouldHandlePublicRouteClick(event, link)) return;
    event.preventDefault();
    navigatePublicRoute(new URL(link.href));
  });

  document.addEventListener("pointerover", (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link) return;
    const targetUrl = new URL(link.href);
    if (isPublicAppRoute(targetUrl)) {
      fetchPublicRouteDocument(targetUrl).catch(() => {});
    }
  });

  window.addEventListener("popstate", () => {
    const targetUrl = new URL(window.location.href);
    if (isPublicAppRoute(targetUrl)) {
      navigatePublicRoute(targetUrl, { fromPopState: true });
    }
  });

  updatePublicNavState(window.location.pathname);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    bootstrapApp();
    initializePublicRouter();
  });
} else {
  bootstrapApp();
  initializePublicRouter();
}
