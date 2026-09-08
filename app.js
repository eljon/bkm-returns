// BKM Returns — mobile-first returns logger backed by Cloud Firestore.
// A return is one transaction (shared txnNo) that can contain several items;
// each item is stored as its own document. Customer / Item / Supplier names are
// autocompleted from in-memory lists that are topped up from Firestore so new
// entries become suggestions everywhere.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  runTransaction,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { CUSTOMERS } from "./customers.js";

const RETURNS = "returns";
const EDIT_HISTORY = "editHistory";

// ---- Accounts & roles -------------------------------------------------------
// NOTE: this is a lightweight, client-side gate for an internal tool. The
// credentials live in this file (visible in the page source) and the role
// checks run in the browser — they are not cryptographic security. Real
// enforcement would require Firebase Authentication + rules based on auth.
const ACCOUNTS = {
  eljon: { pw: "mokong", role: "admin" },
  blezzy: { pw: "blezzy815", role: "admin" },
  lolen: { pw: "lolen123", role: "user" },
  raysalyn: { pw: "r1234", role: "sr" },
};
let currentUser = null; // { username, role }
try {
  currentUser = JSON.parse(localStorage.getItem("bkmUser") || "null");
} catch (e) {
  currentUser = null;
}
const isAdmin = () => currentUser?.role === "admin";
const canEdit = () => currentUser?.role === "admin" || currentUser?.role === "user";
const canInput = () => canEdit();
const canAddSr = () => canEdit() || currentUser?.role === "sr"; // SR-only role too

// ---- DOM refs ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const form = $("form");
const btn = $("submitBtn");
const toast = $("toast");
const configBanner = $("configBanner");
const recentList = $("recentList");
const itemsWrap = $("items");
const addItemBtn = $("addItem");
const itemTemplate = $("itemTemplate");
const customerInput = $("customer");
const searchInput = $("search");
const srList = $("srList");
const gearBtn = $("gearBtn");
const accountBox = $("accountBox");
const deletedBox = $("deletedBox");
const deletedList = $("deletedList");

// ---- Default the date to today (local) --------------------------------------
(function setToday() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  $("date").value = local.toISOString().slice(0, 10);
})();

// ---- Toast helper -----------------------------------------------------------
let toastTimer;
function showToast(msg, kind = "ok") {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = "toast show " + kind;
  toastTimer = setTimeout(() => (toast.className = "toast " + kind), 3400);
}

// ---- Small helpers ----------------------------------------------------------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
const norm = (s) => s.trim().replace(/\s+/g, " ");
const nkey = (s) => norm(s).toLowerCase();

function fmtDate(value) {
  const parts = String(value || "").split("-");
  if (parts.length !== 3) return value || "";
  const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ---- Suggestion sources (in-memory) -----------------------------------------
// Each source: { coll, names[], set }. `names` drives suggestions; `set` holds
// lowercased keys for dedup. Customers start from the bundled base list.
const customers = { coll: "customers", names: CUSTOMERS.slice(), set: new Set(CUSTOMERS.map(nkey)) };
const items = { coll: "items", names: [], set: new Set() };
const suppliers = { coll: "suppliers", names: [], set: new Set() };

const SUGGEST_MAX = 10;

function searchNames(list, q) {
  const needle = q.toLowerCase();
  const starts = [];
  const contains = [];
  for (const name of list) {
    const i = name.toLowerCase().indexOf(needle);
    if (i === 0) {
      if (starts.length < SUGGEST_MAX) starts.push(name);
    } else if (i > 0 && contains.length < SUGGEST_MAX) {
      contains.push(name);
    }
    if (starts.length >= SUGGEST_MAX) break;
  }
  return starts.concat(contains).slice(0, SUGGEST_MAX);
}

function highlight(name, q) {
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return escapeHtml(name);
  return (
    escapeHtml(name.slice(0, i)) +
    "<mark>" +
    escapeHtml(name.slice(i, i + q.length)) +
    "</mark>" +
    escapeHtml(name.slice(i + q.length))
  );
}

// Wire an input + its suggestion <ul> to a source. getList returns the array.
function attachAutocomplete(input, box, getList) {
  let active = -1;

  const close = () => {
    box.hidden = true;
    box.innerHTML = "";
    active = -1;
    input.setAttribute("aria-expanded", "false");
  };

  const open = () => {
    const q = input.value.trim();
    if (!q) return close();
    const matches = searchNames(getList(), q);
    // No matches → hide the dropdown entirely so it doesn't cover the field below.
    if (!matches.length) return close();
    box.innerHTML = matches
      .map((name) => `<li role="option" data-name="${escapeHtml(name)}">${highlight(name, q)}</li>`)
      .join("");
    box.hidden = false;
    active = -1;
    input.setAttribute("aria-expanded", "true");
  };

  const choose = (name) => {
    input.value = name;
    close();
  };

  input.addEventListener("input", open);
  input.addEventListener("focus", () => {
    if (input.value.trim()) open();
  });
  // Select on click (not pointer/touch) so iOS taps register and list scrolling works.
  box.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-name]");
    if (li) choose(li.dataset.name);
  });
  input.addEventListener("keydown", (e) => {
    if (box.hidden) return;
    const opts = [...box.querySelectorAll("li[data-name]")];
    if (!opts.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active += e.key === "ArrowDown" ? 1 : -1;
      if (active < 0) active = opts.length - 1;
      if (active >= opts.length) active = 0;
      opts.forEach((o, i) => o.classList.toggle("active", i === active));
      opts[active].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      choose(opts[active].dataset.name);
    } else if (e.key === "Escape") {
      close();
    }
  });
}

// Close every open suggestion list when tapping outside a combo.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".combo")) {
    document.querySelectorAll(".suggest").forEach((b) => {
      b.hidden = true;
      b.innerHTML = "";
    });
  }
});

// ---- Item rows --------------------------------------------------------------
function addItemRow() {
  // Carry the supplier from the last item so a new item pre-fills it.
  const cards = itemsWrap.querySelectorAll(".item-card");
  const prevSupplier = cards.length
    ? cards[cards.length - 1].querySelector(".i-supplier").value.trim()
    : "";

  const node = itemTemplate.content.firstElementChild.cloneNode(true);
  itemsWrap.appendChild(node);

  const itemInput = node.querySelector(".i-item");
  const supInput = node.querySelector(".i-supplier");
  attachAutocomplete(itemInput, itemInput.closest(".combo").querySelector(".suggest"), () => items.names);
  attachAutocomplete(supInput, supInput.closest(".combo").querySelector(".suggest"), () => suppliers.names);
  if (prevSupplier) supInput.value = prevSupplier;

  refreshRows();
  return node;
}

function refreshRows() {
  const cards = [...itemsWrap.querySelectorAll(".item-card")];
  cards.forEach((c, i) => {
    c.querySelector(".item-num").textContent = "Item " + (i + 1);
  });
  itemsWrap.classList.toggle("single", cards.length <= 1);
}

addItemBtn.addEventListener("click", () => {
  const row = addItemRow();
  row.querySelector(".i-item").focus();
});

// Delegated handlers for the buttons inside item cards.
itemsWrap.addEventListener("click", (e) => {
  const t = e.target;
  const card = t.closest(".item-card");
  if (!card) return;

  if (t.classList.contains("qty-minus")) {
    const q = card.querySelector(".i-qty");
    q.value = Math.max(1, (parseInt(q.value, 10) || 1) - 1);
  } else if (t.classList.contains("qty-plus")) {
    const q = card.querySelector(".i-qty");
    q.value = (parseInt(q.value, 10) || 0) + 1;
  } else if (t.classList.contains("seg-btn")) {
    card.querySelectorAll(".seg-btn").forEach((x) => {
      const on = x === t;
      x.classList.toggle("active", on);
      x.setAttribute("aria-pressed", on ? "true" : "false");
    });
  } else if (t.classList.contains("remove-item")) {
    if (itemsWrap.querySelectorAll(".item-card").length > 1) {
      card.remove();
      refreshRows();
    }
  }
});

// Select QTY and the (pre-filled) Supplier on focus so a tap lets you overtype
// the whole value instead of erasing it letter by letter.
itemsWrap.addEventListener("focusin", (e) => {
  if (e.target.classList.contains("i-qty") || e.target.classList.contains("i-supplier")) {
    e.target.select();
  }
});

addItemRow(); // start with one item

// Attach autocomplete to the customer field.
attachAutocomplete(customerInput, $("customerSuggest"), () => customers.names);

// ---- Tabs -------------------------------------------------------------------
const TAB_NAMES = ["input", "sr", "history", "settings"];
const tabButtons = [...document.querySelectorAll(".tab")];
const panels = {
  input: $("tab-input"),
  sr: $("tab-sr"),
  history: $("tab-history"),
  settings: $("tab-settings"),
};

function showTab(name) {
  if (!TAB_NAMES.includes(name)) name = "input";
  tabButtons.forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  Object.entries(panels).forEach(([k, el]) => el.classList.toggle("hidden", k !== name));
  if (name === "history" || name === "sr") loadTransactions();
  if (name === "settings") { renderAccount(); if (isAdmin()) loadTransactions(); }
}

// Hash-based routing: #sr / #history / #settings select views; links shareable.
function routeFromHash() {
  const name = (location.hash || "").replace(/^#/, "");
  if (name === "cleanup") return maintenanceCleanup();
  showTab(name);
}
tabButtons.forEach((b) =>
  b.addEventListener("click", () => {
    location.hash = b.dataset.tab; // triggers hashchange → showTab
  })
);
gearBtn.addEventListener("click", () => (location.hash = "settings"));
window.addEventListener("hashchange", routeFromHash);

// ---- Auth UI ----------------------------------------------------------------
function applyAuth() {
  document.body.classList.toggle("view-only", !canInput());
  btn.disabled = !canInput();
  const lock = $("inputLock");
  if (lock) {
    lock.textContent = currentUser
      ? "Your account can only add SR numbers (SR tab). Adding returns is disabled."
      : "You’re in view-only mode. Tap ⚙ to log in before adding returns.";
  }
}

function renderAccount() {
  if (currentUser) {
    accountBox.innerHTML = `
      <h2>Account</h2>
      <div>Signed in as <span class="who">${escapeHtml(currentUser.username)}</span>
        <span class="role-pill">${escapeHtml(currentUser.role === "sr" ? "sr-only" : currentUser.role)}</span></div>
      <button type="button" class="btn-secondary" id="logoutBtn" style="margin-top:14px">Log out</button>`;
    $("logoutBtn").addEventListener("click", logout);
  } else {
    accountBox.innerHTML = `
      <h2>Log in</h2>
      <form class="login-form" id="loginForm" autocomplete="off">
        <input type="text" id="loginUser" placeholder="Username" autocapitalize="none" autocorrect="off" spellcheck="false">
        <input type="password" id="loginPass" placeholder="Password">
        <button type="submit" class="submit" style="margin-top:2px">Log in</button>
      </form>
      <p class="sub" style="margin:12px 2px 0">Not logged in — you can view records only.</p>`;
    $("loginForm").addEventListener("submit", login);
  }
  // Deleted entries section is admin-only.
  deletedBox.classList.toggle("hidden", !isAdmin());
  if (isAdmin()) renderDeleted();
}

function login(e) {
  e.preventDefault();
  const u = $("loginUser").value.trim().toLowerCase();
  const p = $("loginPass").value;
  const acc = ACCOUNTS[u];
  if (!acc || acc.pw !== p) {
    showToast("Wrong username or password", "err");
    return;
  }
  currentUser = { username: u, role: acc.role };
  try { localStorage.setItem("bkmUser", JSON.stringify(currentUser)); } catch (err) {}
  applyAuth();
  renderAccount();
  renderHistory();
  showToast(`Logged in as ${u}`, "ok");
  location.hash = "input";
}

function logout() {
  currentUser = null;
  try { localStorage.removeItem("bkmUser"); } catch (err) {}
  applyAuth();
  renderAccount();
  renderHistory();
  showToast("Logged out", "ok");
}

// ---- Firebase init ----------------------------------------------------------
const isConfigured =
  firebaseConfig &&
  firebaseConfig.apiKey &&
  !firebaseConfig.apiKey.startsWith("YOUR_") &&
  firebaseConfig.projectId &&
  !firebaseConfig.projectId.startsWith("YOUR_");

let db = null;
if (isConfigured) {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
} else {
  configBanner.classList.remove("hidden");
  btn.disabled = true;
  $("recentEmpty").textContent = "Configure Firebase to see saved returns.";
}

// ---- Shared name lists (load + remember) ------------------------------------
// Merge names saved on any device into the in-memory source (background task).
async function loadNames(src) {
  if (!db) return;
  try {
    const snap = await getDocs(collection(db, src.coll));
    let added = false;
    snap.forEach((d) => {
      const name = d.data().name;
      if (name && !src.set.has(nkey(name))) {
        src.set.add(nkey(name));
        src.names.push(name);
        added = true;
      }
    });
    if (added) src.names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch (err) {
    console.error(err);
  }
}

// Add a newly-seen name to memory (instant) and share it via Firestore.
async function rememberName(src, name) {
  const n = norm(name);
  if (!n || src.set.has(nkey(n))) return; // already known
  src.set.add(nkey(n));
  src.names.push(n);
  src.names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  if (!db) return;
  try {
    await addDoc(collection(db, src.coll), { name: n, createdAt: serverTimestamp() });
  } catch (err) {
    console.error(err);
  }
}

loadNames(customers);
loadNames(items);
loadNames(suppliers);

// ---- Transactions (shared by SR + History tabs) -----------------------------
const HISTORY_MAX = 1000; // documents pulled into memory
const HISTORY_SHOW = 50; // transactions rendered at once in History
let allTxns = []; // grouped transactions, newest first (in memory)
let srPending = []; // transactions currently shown in the SR tab
let deletedItems = []; // soft-deleted items, shown in Settings (admin)

function findItem(id) {
  for (const g of allTxns) {
    const it = g.items.find((x) => x.id === id);
    if (it) return it;
  }
  return null;
}

function condBadge(c) {
  if (!c) return "";
  return `<span class="badge ${c === "Defective" ? "bad" : "good"}">${escapeHtml(c)}</span>`;
}

// Split items into [condition, items] groups: Good first, then Defective.
function condGroups(items) {
  const out = [];
  for (const c of ["Good", "Defective"]) {
    const arr = items.filter((it) => it.condition === c);
    if (arr.length) out.push([c, arr]);
  }
  const others = items.filter((it) => it.condition !== "Good" && it.condition !== "Defective");
  if (others.length) out.push(["Other", others]);
  return out;
}

function renderLines(items) {
  return items
    .map((it) => {
      const meta = [it.supplier || "", it.editedAt ? "edited" : ""]
        .filter(Boolean)
        .join(" · ");
      const actions = [];
      if (canEdit()) actions.push(`<button type="button" class="mini-btn edit edit-item" data-id="${escapeHtml(it.id)}">Edit</button>`);
      if (isAdmin()) actions.push(`<button type="button" class="mini-btn del del-item" data-id="${escapeHtml(it.id)}">Delete</button>`);
      return `<li class="r-line">
           <div class="r-line-main">
             <span class="r-line-item">${escapeHtml(it.item)}</span>
             <span class="r-line-sup">${escapeHtml(meta)}</span>
           </div>
           <div class="r-line-right">
             ${it.sr ? `<span class="sr-tag">SR ${escapeHtml(it.sr)}</span>` : ""}
             <span class="r-qty">×${escapeHtml(it.qty)}</span>
             ${actions.length ? `<span class="r-actions">${actions.join("")}</span>` : ""}
           </div>
         </li>`;
    })
    .join("");
}

function renderTxnCard(g) {
  const dr = g.drNumber ? ` · DR ${escapeHtml(g.drNumber)}` : "";
  const n = g.items.length;
  const body = condGroups(g.items)
    .map(
      ([cond, arr]) =>
        `<div class="cond-group cond-${cond.toLowerCase()}">
           <div class="cond-head">${escapeHtml(cond)}</div>
           <ul class="r-lines">${renderLines(arr)}</ul>
         </div>`
    )
    .join("");
  const txnActions = [];
  if (canAddSr() && g.txnNo)
    txnActions.push(`<button type="button" class="mini-btn edit edit-txn" data-txn="${escapeHtml(g.txnNo)}">${canEdit() ? "Edit" : "Edit SR"}</button>`);
  if (isAdmin() && g.txnNo)
    txnActions.push(`<button type="button" class="mini-btn del del-txn" data-txn="${escapeHtml(g.txnNo)}">Delete</button>`);
  return `<li class="txn">
     <div class="r-txn-row">
       <span class="r-txn">${escapeHtml(g.txnNo || "—")}</span>
       ${txnActions.length ? `<span class="r-actions">${txnActions.join("")}</span>` : ""}
     </div>
     <div class="r-top">
       <span class="r-cust">${escapeHtml(g.customer)}</span>
       <span class="r-count">${n} item${n > 1 ? "s" : ""}</span>
     </div>
     ${body}
     <div class="r-meta">${escapeHtml(fmtDate(g.date))}${dr}</div>
   </li>`;
}

function findGroup(txnNo) {
  return allTxns.find((g) => g.txnNo === txnNo) || null;
}

function uniformSr(g) {
  const srs = [...new Set(g.items.map((it) => it.sr || ""))];
  return srs.length === 1 ? srs[0] : "";
}

// ---- History (searchable) ---------------------------------------------------
// Every whitespace-separated term must match somewhere in the transaction (AND).
function txnMatches(g, terms) {
  const parts = [g.customer, g.drNumber, g.txnNo];
  for (const it of g.items) {
    parts.push(it.item, it.supplier, it.sr);
    if (it.sr) parts.push("sr " + it.sr); // so "sr100"/"sr-100"/"sr 100" all match
  }
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  const hayCompact = hay.replace(/[^a-z0-9]/g, ""); // ignore spaces/punctuation
  return terms.every(
    (t) => hay.includes(t) || hayCompact.includes(t.replace(/[^a-z0-9]/g, ""))
  );
}

const activeFilters = new Set(); // "sr" and/or "dr"

function passesFilters(g) {
  if (activeFilters.has("sr") && !g.items.some((it) => it.sr)) return false;
  if (activeFilters.has("dr") && !g.drNumber) return false;
  return true;
}

function renderHistory() {
  const terms = (searchInput.value || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = allTxns.filter(
    (g) => passesFilters(g) && (!terms.length || txnMatches(g, terms))
  );

  if (!list.length) {
    const filtering = terms.length || activeFilters.size;
    recentList.innerHTML = `<li class="empty">${filtering ? "No matching returns." : "No returns logged yet."}</li>`;
    return;
  }
  const shown = list.slice(0, HISTORY_SHOW);
  let html = shown.map(renderTxnCard).join("");
  if (list.length > shown.length) {
    html += `<li class="empty">Showing first ${shown.length} of ${list.length} — refine your search.</li>`;
  }
  recentList.innerHTML = html;
}

searchInput.addEventListener("input", renderHistory);

// History filter chips (With SR / With DR).
[...document.querySelectorAll(".chip")].forEach((chip) =>
  chip.addEventListener("click", () => {
    const f = chip.dataset.filter;
    if (activeFilters.has(f)) activeFilters.delete(f);
    else activeFilters.add(f);
    chip.classList.toggle("active", activeFilters.has(f));
    renderHistory();
  })
);

// Edit / delete actions on History rows.
recentList.addEventListener("click", (e) => {
  const etx = e.target.closest(".edit-txn");
  if (etx) return openTxnEdit(etx.dataset.txn);
  const dtx = e.target.closest(".del-txn");
  if (dtx) return softDeleteTxn(dtx.dataset.txn);
  const ed = e.target.closest(".edit-item");
  if (ed) return openEdit(ed.dataset.id);
  const del = e.target.closest(".del-item");
  if (del) return softDelete(del.dataset.id);
});

// ---- Soft delete + restore --------------------------------------------------
async function softDelete(id) {
  if (!isAdmin() || !db) return;
  const it = findItem(id);
  if (!it) return;
  if (!window.confirm(`Delete this item?\n\n${it.item} (${it.txnNo})\n\nIt moves to Settings → Deleted entries and can be restored.`)) return;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, RETURNS, id);
      tx.update(ref, {
        deleted: true,
        deletedBy: currentUser.username,
        deletedAt: serverTimestamp(),
      });
    });
    showToast("Item deleted", "ok");
    await loadTransactions();
  } catch (err) {
    console.error(err);
    showToast(err?.code === "permission-denied" ? "Blocked — re-publish the Firestore rules" : "Delete failed", "err");
  }
}

async function softDeleteTxn(txnNo) {
  if (!isAdmin() || !db) return;
  const g = findGroup(txnNo);
  if (!g) return;
  const n = g.items.length;
  if (!window.confirm(`Delete the entire transaction ${g.txnNo} (${n} item${n > 1 ? "s" : ""})?\n\nAll its items move to Settings → Deleted entries and can be restored.`)) return;
  try {
    const batch = writeBatch(db);
    g.items.forEach((it) =>
      batch.update(doc(db, RETURNS, it.id), {
        deleted: true,
        deletedBy: currentUser.username,
        deletedAt: serverTimestamp(),
      })
    );
    await batch.commit();
    showToast(`Transaction ${g.txnNo} deleted`, "ok");
    await loadTransactions();
  } catch (err) {
    console.error(err);
    showToast(err?.code === "permission-denied" ? "Blocked — re-publish the Firestore rules" : "Delete failed", "err");
  }
}

async function restoreItem(id) {
  if (!isAdmin() || !db) return;
  try {
    await runTransaction(db, async (tx) => {
      tx.update(doc(db, RETURNS, id), { deleted: false });
    });
    showToast("Item restored", "ok");
    await loadTransactions();
  } catch (err) {
    console.error(err);
    showToast(err?.code === "permission-denied" ? "Blocked — re-publish the Firestore rules" : "Restore failed", "err");
  }
}

function renderDeleted() {
  if (!deletedList) return;
  if (!deletedItems.length) {
    deletedList.innerHTML = '<li class="empty">None.</li>';
    return;
  }
  deletedList.innerHTML = deletedItems
    .map(
      (it) =>
        `<li class="r-line">
           <div class="r-line-main">
             <span class="r-line-item">${escapeHtml(it.item)} ${condBadge(it.condition)}</span>
             <span class="r-line-sup">${escapeHtml(it.customer || "")} · ${escapeHtml(it.txnNo || "")} · ×${escapeHtml(it.qty)}${it.deletedBy ? " · by " + escapeHtml(it.deletedBy) : ""}</span>
           </div>
           <div class="r-line-right">
             <button type="button" class="mini-btn restore restore-item" data-id="${escapeHtml(it.id)}">Restore</button>
           </div>
         </li>`
    )
    .join("");
}

deletedList.addEventListener("click", (e) => {
  const b = e.target.closest(".restore-item");
  if (b) restoreItem(b.dataset.id);
});

// ---- Edit modal -------------------------------------------------------------
const editModal = $("editModal");
let editingId = null;
let editCondition = null;

attachAutocomplete($("editItem"), $("editItemSuggest"), () => items.names);
attachAutocomplete($("editSupplier"), $("editSupplierSuggest"), () => suppliers.names);

$("editCondition").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn");
  if (!b) return;
  editCondition = b.dataset.value;
  $("editCondition").querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
});
$("editQtyMinus").addEventListener("click", () => {
  const q = $("editQty");
  q.value = Math.max(1, (parseInt(q.value, 10) || 1) - 1);
});
$("editQtyPlus").addEventListener("click", () => {
  const q = $("editQty");
  q.value = (parseInt(q.value, 10) || 0) + 1;
});
$("editQty").addEventListener("focus", () => $("editQty").select());
$("editCancel").addEventListener("click", closeEdit);
editModal.addEventListener("click", (e) => {
  if (e.target === editModal) closeEdit();
});
$("editSave").addEventListener("click", saveEdit);

function closeEdit() {
  editModal.hidden = true;
  editingId = null;
}

async function openEdit(id) {
  if (!canEdit()) return;
  const it = findItem(id);
  if (!it) return;
  editingId = id;
  editCondition = it.condition;
  $("editSub").textContent = `${it.txnNo} · ${it.customer}`;
  $("editItem").value = it.item;
  $("editSupplier").value = it.supplier || "";
  $("editQty").value = it.qty;
  $("editCondition").querySelectorAll(".seg-btn").forEach((x) =>
    x.classList.toggle("active", x.dataset.value === it.condition)
  );
  $("editHistWrap").hidden = true;
  $("editHistList").innerHTML = "";
  editModal.hidden = false;
  loadEditHistory(id);
}

async function loadEditHistory(id) {
  if (!db) return;
  try {
    const snap = await getDocs(
      query(collection(db, EDIT_HISTORY), where("returnId", "==", id))
    );
    const rows = snap.docs
      .map((d) => d.data())
      .sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0));
    if (!rows.length) return;
    $("editHistList").innerHTML = rows
      .map((h) => {
        const when = h.at?.toDate ? h.at.toDate().toLocaleString() : "";
        const changes = Object.keys(h.before || {})
          .map((k) => `${escapeHtml(k)}: <b>${escapeHtml(h.before[k])}</b> → <b>${escapeHtml((h.after || {})[k])}</b>`)
          .join("<br>");
        return `<li class="hist-item">${changes}<br>by ${escapeHtml(h.by || "")} · ${escapeHtml(when)}</li>`;
      })
      .join("");
    $("editHistWrap").hidden = false;
  } catch (err) {
    console.error(err);
  }
}

async function saveEdit() {
  if (!canEdit() || !db || !editingId) return;
  const it = findItem(editingId);
  if (!it) return closeEdit();

  const next = {
    item: norm($("editItem").value),
    supplier: norm($("editSupplier").value),
    condition: editCondition,
    qty: parseInt($("editQty").value, 10) || 0,
  };
  if (!next.item) return showToast("Item is required", "err");
  if (!next.supplier) return showToast("Supplier is required", "err");
  if (!next.condition) return showToast("Choose Good or Defective", "err");
  if (next.qty < 1) return showToast("QTY must be at least 1", "err");

  // Only the fields that actually changed.
  const before = {};
  const after = {};
  for (const k of ["item", "supplier", "condition", "qty"]) {
    if (String(it[k]) !== String(next[k])) {
      before[k] = it[k];
      after[k] = next[k];
    }
  }
  if (!Object.keys(after).length) {
    closeEdit();
    return showToast("No changes", "ok");
  }

  const saveBtn = $("editSave");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, RETURNS, editingId), {
      ...after,
      editedBy: currentUser.username,
      editedAt: serverTimestamp(),
      editCount: (it.editCount || 0) + 1,
    });
    const histRef = doc(collection(db, EDIT_HISTORY));
    batch.set(histRef, {
      returnId: editingId,
      txnNo: it.txnNo || "",
      before,
      after,
      by: currentUser.username,
      at: serverTimestamp(),
    });
    await batch.commit();
    // remember any new item/supplier names
    rememberName(items, next.item);
    rememberName(suppliers, next.supplier);
    showToast("Changes saved ✓", "ok");
    closeEdit();
    await loadTransactions();
  } catch (err) {
    console.error(err);
    showToast(err?.code === "permission-denied" ? "Blocked — re-publish the Firestore rules" : "Save failed", "err");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save changes";
  }
}

// ---- Transaction edit modal (shared fields + one SR for all items) ----------
const txnModal = $("txnModal");
let editingTxn = null; // txnNo being edited

attachAutocomplete($("txnCustomer"), $("txnCustomerSuggest"), () => customers.names);
$("txnCustomer").addEventListener("focus", () => $("txnCustomer").select());
$("txnSr").addEventListener("focus", () => $("txnSr").select());
$("txnCancel").addEventListener("click", closeTxnEdit);
txnModal.addEventListener("click", (e) => {
  if (e.target === txnModal) closeTxnEdit();
});
$("txnSave").addEventListener("click", saveTxnEdit);

function closeTxnEdit() {
  txnModal.hidden = true;
  editingTxn = null;
}

function openTxnEdit(txnNo) {
  if (!canAddSr()) return;
  const g = findGroup(txnNo);
  if (!g) return;
  editingTxn = txnNo;
  const full = canEdit(); // sr-only users get the SR field alone
  $("txnTitle").textContent = full ? "Edit transaction" : "Edit SR number";
  $("txnSub").textContent = `${g.txnNo} · ${g.items.length} item${g.items.length > 1 ? "s" : ""}`;
  document.querySelectorAll("#txnModal .txn-full").forEach((el) => el.classList.toggle("hidden", !full));
  $("txnDate").value = g.date || "";
  $("txnCustomer").value = g.customer || "";
  $("txnDr").value = g.drNumber || "";
  $("txnSr").value = uniformSr(g);
  txnModal.hidden = false;
}

async function saveTxnEdit() {
  if (!canAddSr() || !db || !editingTxn) return;
  const g = findGroup(editingTxn);
  if (!g) return closeTxnEdit();

  const full = canEdit(); // sr-only users can change the SR number only
  const srVal = $("txnSr").value.trim();

  // Transaction-level fields (only editable by admin/user).
  const setFields = {};
  if (full) {
    const customer = norm($("txnCustomer").value);
    const date = $("txnDate").value;
    const drNumber = norm($("txnDr").value);
    if (!date) return showToast("Date is required", "err");
    if (!customer) return showToast("Customer is required", "err");
    if (customer !== g.customer) setFields.customer = customer;
    if (date !== g.date) setFields.date = date;
    if (drNumber !== g.drNumber) setFields.drNumber = drNumber;
  }
  const srChanged = srVal !== uniformSr(g);

  if (!Object.keys(setFields).length && !srChanged) {
    closeTxnEdit();
    return showToast("No changes", "ok");
  }

  const saveBtn = $("txnSave");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";
  try {
    const batch = writeBatch(db);
    for (const it of g.items) {
      const after = { ...setFields };
      if (srChanged) after.sr = srVal;
      const before = {};
      for (const k of Object.keys(after)) before[k] = it[k];
      batch.update(doc(db, RETURNS, it.id), {
        ...after,
        editedBy: currentUser.username,
        editedAt: serverTimestamp(),
        editCount: (it.editCount || 0) + 1,
      });
      const histRef = doc(collection(db, EDIT_HISTORY));
      batch.set(histRef, {
        returnId: it.id,
        txnNo: g.txnNo || "",
        before,
        after,
        by: currentUser.username,
        at: serverTimestamp(),
      });
    }
    await batch.commit();
    if (setFields.customer) rememberName(customers, setFields.customer);
    showToast(full ? "Transaction updated ✓" : "SR updated ✓", "ok");
    closeTxnEdit();
    await loadTransactions();
  } catch (err) {
    console.error(err);
    showToast(err?.code === "permission-denied" ? "Blocked — re-publish the Firestore rules" : "Save failed", "err");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save changes";
  }
}

// ---- SR tab (per-item) ------------------------------------------------------
// An item is pending if it has no SR and its transaction has no DR. Each pending
// item gets a checkbox (checked by default); one SR number is stamped onto the
// ticked items, so a transaction can end up with several SR numbers over time.
function srCard(card, i) {
  const g = card.g;
  const rows = card.pendingItems
    .map(
      (it) =>
        `<li>
           <label class="sr-item">
             <input type="checkbox" class="sr-check" data-id="${escapeHtml(it.id)}" checked>
             <span class="sr-box"></span>
             <span class="sr-item-text">${escapeHtml(it.item)}
               <span class="muted">${escapeHtml(it.supplier || "")} · ×${escapeHtml(it.qty)}</span>
             </span>
           </label>
         </li>`
    )
    .join("");
  return `<li class="txn">
     <div class="r-top">
       <span class="r-cust">${escapeHtml(g.customer)} ${condBadge(card.condition)}</span>
       <span class="r-count">${escapeHtml(g.txnNo || "")}</span>
     </div>
     <ul class="sr-items">${rows}</ul>
     <div class="r-meta">${escapeHtml(fmtDate(g.date))}</div>
     ${canAddSr()
        ? `<div class="sr-add">
       <input type="text" class="sr-input" placeholder="SR # *" autocomplete="off"
              autocapitalize="characters" spellcheck="false" enterkeyhint="done">
       <button type="button" class="sr-save" data-i="${i}">Save</button>
     </div>`
        : ""}
   </li>`;
}

function renderSr() {
  // A transaction with both Good and Defective pending items appears as two
  // separate cards, so each condition can get its own SR number.
  srPending = [];
  for (const g of allTxns) {
    if (g.drNumber) continue; // a DR covers the whole transaction
    const pending = g.items.filter((it) => !it.sr);
    if (!pending.length) continue;
    for (const [cond, arr] of condGroups(pending)) {
      srPending.push({ g, condition: cond, pendingItems: arr });
    }
  }
  if (!srPending.length) {
    srList.innerHTML = '<li class="empty">All caught up — every item has an SR or a DR.</li>';
    return;
  }
  srList.innerHTML = srPending.map((c, i) => srCard(c, i)).join("");
}

srList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".sr-save");
  if (!btn) return;
  if (!canAddSr()) return showToast("Log in to add SR numbers", "err");
  const card = srPending[+btn.dataset.i];
  if (!card || !db) return;

  const txnEl = btn.closest(".txn");
  const sr = txnEl.querySelector(".sr-input").value.trim();
  if (!sr) return showToast("Enter an SR number", "err");

  const chosen = [...txnEl.querySelectorAll(".sr-check")]
    .filter((c) => c.checked)
    .map((c) => c.dataset.id)
    .filter(Boolean);
  if (!chosen.length) return showToast("Tick at least one item", "err");

  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    // Stamp the SR onto each ticked item's document.
    const batch = writeBatch(db);
    chosen.forEach((id) => batch.update(doc(db, RETURNS, id), { sr }));
    await batch.commit();
    // pendingItems are references into allTxns, so update them in memory.
    card.pendingItems.forEach((it) => {
      if (chosen.includes(it.id)) it.sr = sr;
    });
    showToast(`SR added to ${chosen.length} item${chosen.length > 1 ? "s" : ""} ✓`, "ok");
    renderSr();
    renderHistory();
  } catch (err) {
    console.error(err);
    const msg =
      err?.code === "permission-denied"
        ? "Save blocked — re-publish the Firestore rules"
        : err?.message || "Save failed — try again";
    showToast(msg, "err");
    btn.disabled = false;
    btn.textContent = "Save";
  }
});

// ---- Load all transactions into memory (for SR + History) -------------------
async function loadTransactions() {
  if (!db) return;
  recentList.innerHTML = '<li class="empty">Loading…</li>';
  srList.innerHTML = '<li class="empty">Loading…</li>';
  try {
    const snap = await getDocs(
      query(collection(db, RETURNS), orderBy("createdAt", "desc"), limit(HISTORY_MAX))
    );
    const groups = new Map();
    deletedItems = [];
    snap.forEach((docSnap) => {
      const r = docSnap.data();
      const it = {
        id: docSnap.id,
        txnNo: r.txnNo || "",
        customer: r.customer,
        date: r.date,
        drNumber: r.drNumber || "",
        item: r.item,
        supplier: r.supplier || "",
        condition: r.condition,
        qty: r.qty,
        sr: r.sr || "",
        editCount: r.editCount || 0,
        editedAt: r.editedAt || null,
        editedBy: r.editedBy || "",
        deletedBy: r.deletedBy || "",
      };
      if (r.deleted) {
        deletedItems.push(it); // hidden from History/SR, shown in Settings
        return;
      }
      const key = r.txnNo || docSnap.id;
      if (!groups.has(key)) {
        groups.set(key, {
          txnNo: r.txnNo || "",
          seq: r.seq || 0,
          customer: r.customer,
          date: r.date,
          drNumber: r.drNumber || "",
          items: [],
        });
      }
      groups.get(key).items.push(it);
    });
    allTxns = [...groups.values()];
    renderHistory();
    renderSr();
    if (isAdmin()) renderDeleted();
  } catch (err) {
    console.error(err);
    recentList.innerHTML = '<li class="empty">Could not load returns.</li>';
    srList.innerHTML = '<li class="empty">Could not load returns.</li>';
  }
}

// ---- Submit -----------------------------------------------------------------
function fmtTxnNo(seq) {
  return "R-" + String(seq).padStart(4, "0");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!canInput()) {
    showToast("Log in to add returns", "err");
    return;
  }
  if (!db) {
    showToast("Firebase isn’t configured yet", "err");
    return;
  }

  const date = $("date").value;
  const customer = customerInput.value.trim();
  const drNumber = $("drNumber").value.trim();

  if (!date) return showToast("Date is required", "err");
  if (!customer) return showToast("Customer is required", "err");

  const cards = [...itemsWrap.querySelectorAll(".item-card")];
  const lineItems = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const item = c.querySelector(".i-item").value.trim();
    const supplier = c.querySelector(".i-supplier").value.trim();
    const activeBtn = c.querySelector(".seg-btn.active");
    const cond = activeBtn ? activeBtn.dataset.value : null;
    const qty = parseInt(c.querySelector(".i-qty").value, 10) || 0;

    if (!item) return showToast(`Item ${i + 1}: name is required`, "err");
    if (!supplier) return showToast(`Item ${i + 1}: supplier is required`, "err");
    if (!cond) return showToast(`Item ${i + 1}: choose Good or Defective`, "err");
    if (qty < 1) return showToast(`Item ${i + 1}: QTY must be at least 1`, "err");

    lineItems.push({ item, supplier, condition: cond, qty });
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Saving…';

  try {
    // Bump the sequential counter and write every line item atomically.
    const counterRef = doc(db, "counters", "returns");
    const txnNo = await runTransaction(db, async (tx) => {
      const snap = await tx.get(counterRef);
      const next = (snap.exists() ? snap.data().current || 0 : 0) + 1;
      tx.set(counterRef, { current: next });

      const no = fmtTxnNo(next);
      lineItems.forEach((it) => {
        const ref = doc(collection(db, RETURNS));
        tx.set(ref, {
          txnNo: no,
          seq: next,
          date,
          customer,
          supplier: it.supplier,
          drNumber,
          sr: "",
          deleted: false,
          item: it.item,
          condition: it.condition,
          qty: it.qty,
          createdAt: serverTimestamp(),
        });
      });
      return no;
    });

    showToast(`Saved ${lineItems.length} item${lineItems.length > 1 ? "s" : ""} ✓  ${txnNo}`, "ok");

    // Remember any new names for future suggestions (shared across devices).
    rememberName(customers, customer);
    lineItems.forEach((it) => {
      rememberName(items, it.item);
      rememberName(suppliers, it.supplier);
    });

    // Keep History current without another read: prepend the new transaction.
    // Item ids are empty here; opening the SR/History tab reloads real doc ids.
    allTxns.unshift({
      txnNo,
      customer,
      date,
      drNumber,
      items: lineItems.map((it) => ({
        id: "",
        item: it.item,
        supplier: it.supplier,
        condition: it.condition,
        qty: it.qty,
        sr: "",
      })),
    });
    renderHistory();

    resetForm();
  } catch (err) {
    console.error(err);
    const msg =
      err?.code === "permission-denied"
        ? "Save blocked — re-publish the Firestore rules"
        : err?.message || "Save failed — try again";
    showToast(msg, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save return";
  }
});

function resetForm() {
  customerInput.value = "";
  $("drNumber").value = "";
  itemsWrap.innerHTML = "";
  addItemRow();
  customerInput.focus();
}

// One-time maintenance (open .../#cleanup): delete R-0010 and earlier and
// clear every SR number. Guarded by a confirm; requires the delete rule.
async function maintenanceCleanup() {
  if (!db) return;
  await loadTransactions();

  const delIds = [];
  const clrIds = [];
  for (const g of allTxns) {
    const del = g.seq && g.seq <= 10;
    for (const it of g.items) {
      if (del) delIds.push(it.id);
      else if (it.sr) clrIds.push(it.id);
    }
  }

  const ok = window.confirm(
    `Delete ${delIds.length} record(s) for R-0010 and earlier, and clear ${clrIds.length} SR number(s)?\n\nThis cannot be undone.`
  );
  if (!ok) {
    location.hash = "history";
    return;
  }

  // Run the two operations as separate passes so one failing (e.g. deletes
  // blocked by rules) doesn't stop the other, and we can report which failed.
  async function runBatched(ids, apply) {
    let done = 0;
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const batch = writeBatch(db);
      chunk.forEach((id) => apply(batch, id));
      await batch.commit();
      done += chunk.length;
    }
    return done;
  }

  let clrDone = 0;
  let delDone = 0;
  const problems = [];
  try {
    clrDone = await runBatched(clrIds, (b, id) => b.update(doc(db, RETURNS, id), { sr: "" }));
  } catch (err) {
    console.error(err);
    problems.push("clear SRs (" + (err?.code || err?.message) + ")");
  }
  try {
    delDone = await runBatched(delIds, (b, id) => b.delete(doc(db, RETURNS, id)));
  } catch (err) {
    console.error(err);
    problems.push("delete records (" + (err?.code || err?.message) + ")");
  }

  let msg = `Cleared ${clrDone}/${clrIds.length} SR(s); deleted ${delDone}/${delIds.length} record(s).`;
  if (problems.length) {
    msg += `\n\nBlocked: ${problems.join("; ")}.\nMake sure the updated Firestore rules (with the delete line) are published, then reopen #cleanup.`;
  }
  window.alert(msg);
  location.hash = "history";
}

// Apply the saved login (if any) to the UI, then route to the initial view.
applyAuth();
renderAccount();
routeFromHash();
