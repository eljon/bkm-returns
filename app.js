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
  orderBy,
  limit,
  serverTimestamp,
  runTransaction,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { CUSTOMERS } from "./customers.js";

const RETURNS = "returns";

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
    box.innerHTML = matches.length
      ? matches
          .map((name) => `<li role="option" data-name="${escapeHtml(name)}">${highlight(name, q)}</li>`)
          .join("")
      : '<li class="none">No match — it’ll be saved as new</li>';
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
const tabButtons = [...document.querySelectorAll(".tab")];
const panels = { input: $("tab-input"), sr: $("tab-sr"), history: $("tab-history") };
tabButtons.forEach((b) =>
  b.addEventListener("click", () => {
    const name = b.dataset.tab;
    tabButtons.forEach((x) => x.classList.toggle("active", x === b));
    Object.entries(panels).forEach(([k, el]) => el.classList.toggle("hidden", k !== name));
    if (name === "history" || name === "sr") loadTransactions();
  })
);

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

function condBadge(c) {
  if (!c) return "";
  return `<span class="badge ${c === "Defective" ? "bad" : "good"}">${escapeHtml(c)}</span>`;
}

function renderLines(g) {
  return g.items
    .map(
      (it) =>
        `<li class="r-line">
           <div class="r-line-main">
             <span class="r-line-item">${escapeHtml(it.item)}</span>
             <span class="r-line-sup">${escapeHtml(it.supplier || "")}</span>
           </div>
           <span class="r-line-right">${condBadge(it.condition)}<span class="r-qty">×${escapeHtml(it.qty)}</span></span>
         </li>`
    )
    .join("");
}

function renderTxnCard(g) {
  const dr = g.drNumber ? ` · DR ${escapeHtml(g.drNumber)}` : "";
  const sr = g.sr ? ` · SR ${escapeHtml(g.sr)}` : "";
  const txn = g.txnNo ? ` · ${escapeHtml(g.txnNo)}` : "";
  const n = g.items.length;
  return `<li class="txn">
     <div class="r-top">
       <span class="r-cust">${escapeHtml(g.customer)}</span>
       <span class="r-count">${n} item${n > 1 ? "s" : ""}</span>
     </div>
     <ul class="r-lines">${renderLines(g)}</ul>
     <div class="r-meta">${escapeHtml(fmtDate(g.date))}${dr}${sr}${txn}</div>
   </li>`;
}

// ---- History (searchable) ---------------------------------------------------
function txnMatches(g, q) {
  if (g.customer && g.customer.toLowerCase().includes(q)) return true;
  if (g.drNumber && g.drNumber.toLowerCase().includes(q)) return true;
  if (g.sr && g.sr.toLowerCase().includes(q)) return true;
  if (g.txnNo && g.txnNo.toLowerCase().includes(q)) return true;
  return g.items.some(
    (it) =>
      (it.item && it.item.toLowerCase().includes(q)) ||
      (it.supplier && it.supplier.toLowerCase().includes(q))
  );
}

function renderHistory() {
  const q = (searchInput.value || "").trim().toLowerCase();
  const list = q ? allTxns.filter((g) => txnMatches(g, q)) : allTxns;

  if (!list.length) {
    recentList.innerHTML = `<li class="empty">${q ? "No matching returns." : "No returns logged yet."}</li>`;
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

// ---- SR tab (transactions needing an SR number) -----------------------------
// A transaction needs an SR only if it has neither an SR nor a DR yet.
function needsSr(g) {
  return !g.sr && !g.drNumber;
}

function srCard(g, i) {
  const n = g.items.length;
  return `<li class="txn">
     <div class="r-top">
       <span class="r-cust">${escapeHtml(g.customer)}</span>
       <span class="r-count">${escapeHtml(g.txnNo || "")}</span>
     </div>
     <ul class="r-lines">${renderLines(g)}</ul>
     <div class="r-meta">${escapeHtml(fmtDate(g.date))} · ${n} item${n > 1 ? "s" : ""}</div>
     <div class="sr-add">
       <input type="text" class="sr-input" placeholder="SR # *" autocomplete="off"
              autocapitalize="characters" spellcheck="false" enterkeyhint="done">
       <button type="button" class="sr-save" data-i="${i}">Save</button>
     </div>
   </li>`;
}

function renderSr() {
  srPending = allTxns.filter(needsSr);
  if (!srPending.length) {
    srList.innerHTML = '<li class="empty">All caught up — every transaction has an SR or a DR.</li>';
    return;
  }
  srList.innerHTML = srPending.map((g, i) => srCard(g, i)).join("");
}

srList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".sr-save");
  if (!btn) return;
  const g = srPending[+btn.dataset.i];
  if (!g || !db) return;

  const input = btn.closest(".sr-add").querySelector(".sr-input");
  const sr = input.value.trim();
  if (!sr) return showToast("Enter an SR number", "err");
  if (!g.ids || !g.ids.length) return showToast("Reopen the SR tab and try again", "err");

  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    // Stamp the SR onto every line-item document of this transaction.
    const batch = writeBatch(db);
    g.ids.forEach((id) => batch.update(doc(db, RETURNS, id), { sr }));
    await batch.commit();
    g.sr = sr;
    showToast(`SR added${g.txnNo ? " to " + g.txnNo : ""} ✓`, "ok");
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
    snap.forEach((docSnap) => {
      const r = docSnap.data();
      const key = r.txnNo || docSnap.id;
      if (!groups.has(key)) {
        groups.set(key, {
          txnNo: r.txnNo || "",
          customer: r.customer,
          date: r.date,
          drNumber: r.drNumber || "",
          sr: r.sr || "",
          ids: [],
          items: [],
        });
      }
      const g = groups.get(key);
      g.ids.push(docSnap.id);
      g.items.push({ item: r.item, supplier: r.supplier || "", condition: r.condition, qty: r.qty });
    });
    allTxns = [...groups.values()];
    renderHistory();
    renderSr();
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

    // Keep History/SR current without another read: prepend the new transaction.
    // ids is left empty; opening the SR/History tab reloads with real doc ids.
    allTxns.unshift({
      txnNo,
      customer,
      date,
      drNumber,
      sr: "",
      ids: [],
      items: lineItems.map((it) => ({
        item: it.item,
        supplier: it.supplier,
        condition: it.condition,
        qty: it.qty,
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
