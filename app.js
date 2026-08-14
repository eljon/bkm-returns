// BKM Returns — mobile-first returns logger backed by Cloud Firestore.
// A return is one transaction (shared txnNo) that can contain several items;
// each item is stored as its own document so the data stays easy to query.
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
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { CUSTOMERS } from "./customers.js";

const RETURNS = "returns";
const COUNTER = ["counters", "returns"]; // doc holding the running sequence

// ---- DOM refs ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const form = $("form");
const btn = $("submitBtn");
const toast = $("toast");
const configBanner = $("configBanner");
const recentList = $("recentList");
const customerInput = $("customer");
const suggestBox = $("custSuggest");
const itemsWrap = $("items");
const addItemBtn = $("addItem");
const itemTemplate = $("itemTemplate");

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

// ---- Item rows --------------------------------------------------------------
function addItemRow() {
  const node = itemTemplate.content.firstElementChild.cloneNode(true);
  itemsWrap.appendChild(node);
  refreshRows();
  return node;
}

function refreshRows() {
  const cards = [...itemsWrap.querySelectorAll(".item-card")];
  cards.forEach((c, i) => {
    c.querySelector(".item-num").textContent = "Item " + (i + 1);
  });
  // Hide the Remove button when only one item remains.
  itemsWrap.classList.toggle("single", cards.length <= 1);
}

addItemBtn.addEventListener("click", () => {
  const row = addItemRow();
  row.querySelector(".i-item").focus();
});

// Delegated handlers for everything inside an item card.
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

// Select the QTY value on focus so typing replaces the default 1.
itemsWrap.addEventListener("focusin", (e) => {
  if (e.target.classList.contains("i-qty")) e.target.select();
});

// Start with a single item row.
addItemRow();

// ---- Customer autocomplete (in-memory, no network) --------------------------
const SUGGEST_MAX = 10;
let activeIdx = -1; // highlighted suggestion for keyboard nav

// Working list = bundled base names + any new ones added over time (merged
// from Firestore below). Suggestions always read from this in-memory array,
// so typing stays instant regardless of the network.
const norm = (s) => s.trim().replace(/\s+/g, " ");
const custKey = (s) => norm(s).toLowerCase();
const customerNames = CUSTOMERS.slice();
const customerSet = new Set(customerNames.map(custKey));

// Return up to SUGGEST_MAX names: prefix matches first, then contains-matches.
function searchCustomers(q) {
  const needle = q.toLowerCase();
  const starts = [];
  const contains = [];
  for (const name of customerNames) {
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

function closeSuggest() {
  suggestBox.hidden = true;
  suggestBox.innerHTML = "";
  activeIdx = -1;
  customerInput.setAttribute("aria-expanded", "false");
}

function openSuggest() {
  const q = customerInput.value.trim();
  if (!q) return closeSuggest();

  const matches = searchCustomers(q);
  if (!matches.length) {
    suggestBox.innerHTML = '<li class="none">No matching customer</li>';
  } else {
    suggestBox.innerHTML = matches
      .map(
        (name, i) =>
          `<li role="option" data-name="${escapeHtml(name)}" data-i="${i}">${highlight(name, q)}</li>`
      )
      .join("");
  }
  suggestBox.hidden = false;
  activeIdx = -1;
  customerInput.setAttribute("aria-expanded", "true");
}

function chooseCustomer(name) {
  customerInput.value = name;
  closeSuggest();
}

customerInput.addEventListener("input", openSuggest);
customerInput.addEventListener("focus", () => {
  if (customerInput.value.trim()) openSuggest();
});

// Select on click. (We intentionally do NOT preventDefault on mousedown/
// touchstart: on iOS that cancels the synthesized click, which broke tapping
// a suggestion on mobile. Nothing closes the list on blur, so click is safe,
// and using click — not pointer/touch events — keeps list scrolling working.)
suggestBox.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-name]");
  if (li) chooseCustomer(li.dataset.name);
});

customerInput.addEventListener("keydown", (e) => {
  if (suggestBox.hidden) return;
  const opts = [...suggestBox.querySelectorAll("li[data-name]")];
  if (!opts.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    activeIdx += e.key === "ArrowDown" ? 1 : -1;
    if (activeIdx < 0) activeIdx = opts.length - 1;
    if (activeIdx >= opts.length) activeIdx = 0;
    opts.forEach((o, i) => o.classList.toggle("active", i === activeIdx));
    opts[activeIdx].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && activeIdx >= 0) {
    e.preventDefault();
    chooseCustomer(opts[activeIdx].dataset.name);
  } else if (e.key === "Escape") {
    closeSuggest();
  }
});

// Close when tapping/clicking outside the field.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".combo")) closeSuggest();
});

// ---- Guard against an unconfigured project ----------------------------------
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

// ---- Helpers ----------------------------------------------------------------
function fmtDate(value) {
  const parts = String(value || "").split("-");
  if (parts.length !== 3) return value || "";
  const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Format a sequence integer as a transaction number, e.g. 42 -> "R-0042".
function fmtTxnNo(seq) {
  return "R-" + String(seq).padStart(4, "0");
}

// ---- Recent returns (grouped by transaction) --------------------------------
function condBadge(c) {
  if (!c) return "";
  return `<span class="badge ${c === "Defective" ? "bad" : "good"}">${escapeHtml(c)}</span>`;
}

function renderTxnCard(g) {
  const dr = g.drNumber ? ` · DR ${escapeHtml(g.drNumber)}` : "";
  const txn = g.txnNo ? ` · ${escapeHtml(g.txnNo)}` : "";
  const lines = g.items
    .map(
      (it) =>
        `<li class="r-line">
           <span class="r-line-item">${escapeHtml(it.item)}</span>
           <span class="r-line-right">${condBadge(it.condition)}<span class="r-qty">×${escapeHtml(it.qty)}</span></span>
         </li>`
    )
    .join("");
  const n = g.items.length;
  return `<li class="txn">
     <div class="r-top">
       <span class="r-cust">${escapeHtml(g.customer)}</span>
       <span class="r-count">${n} item${n > 1 ? "s" : ""}</span>
     </div>
     <ul class="r-lines">${lines}</ul>
     <div class="r-meta">${escapeHtml(fmtDate(g.date))}${dr}${txn}</div>
   </li>`;
}

async function loadRecent() {
  if (!db) return;
  try {
    const snap = await getDocs(
      query(collection(db, RETURNS), orderBy("createdAt", "desc"), limit(50))
    );

    if (snap.empty) {
      recentList.innerHTML = '<li class="empty">No returns logged yet.</li>';
      return;
    }

    // Group documents by transaction number, keeping newest-first order.
    const groups = new Map();
    snap.forEach((docSnap) => {
      const r = docSnap.data();
      const key = r.txnNo || docSnap.id; // fall back for pre-transaction records
      if (!groups.has(key)) {
        groups.set(key, {
          txnNo: r.txnNo || "",
          customer: r.customer,
          date: r.date,
          drNumber: r.drNumber,
          items: [],
        });
      }
      groups.get(key).items.push({ item: r.item, condition: r.condition, qty: r.qty });
    });

    recentList.innerHTML = [...groups.values()].slice(0, 12).map(renderTxnCard).join("");
  } catch (err) {
    console.error(err);
    recentList.innerHTML = '<li class="empty">Could not load recent returns.</li>';
  }
}
loadRecent();

// ---- Shared customer additions ----------------------------------------------
// Merge any customers added on other devices into the in-memory list. Runs in
// the background — suggestions already work from the bundled base list.
async function loadExtraCustomers() {
  if (!db) return;
  try {
    const snap = await getDocs(collection(db, "customers"));
    let added = false;
    snap.forEach((d) => {
      const name = d.data().name;
      if (name && !customerSet.has(custKey(name))) {
        customerSet.add(custKey(name));
        customerNames.push(name);
        added = true;
      }
    });
    if (added) {
      customerNames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    }
  } catch (err) {
    console.error(err);
  }
}
loadExtraCustomers();

// Add a newly-seen customer to memory (instant) and share it via Firestore.
async function rememberCustomer(name) {
  const n = norm(name);
  if (!n || customerSet.has(custKey(n))) return; // already known
  customerSet.add(custKey(n));
  customerNames.push(n);
  customerNames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  if (!db) return;
  try {
    await addDoc(collection(db, "customers"), { name: n, createdAt: serverTimestamp() });
  } catch (err) {
    console.error(err);
  }
}

// ---- Submit -----------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!db) {
    showToast("Firebase isn’t configured yet", "err");
    return;
  }

  const date = $("date").value;
  const customer = $("customer").value.trim();
  const drNumber = $("drNumber").value.trim();

  if (!date) return showToast("Date is required", "err");
  if (!customer) return showToast("Customer is required", "err");

  // Collect + validate every item line.
  const cards = [...itemsWrap.querySelectorAll(".item-card")];
  const items = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const item = c.querySelector(".i-item").value.trim();
    const activeBtn = c.querySelector(".seg-btn.active");
    const cond = activeBtn ? activeBtn.dataset.value : null;
    const qty = parseInt(c.querySelector(".i-qty").value, 10) || 0;

    if (!item) return showToast(`Item ${i + 1}: name is required`, "err");
    if (!cond) return showToast(`Item ${i + 1}: choose Good or Defective`, "err");
    if (qty < 1) return showToast(`Item ${i + 1}: QTY must be at least 1`, "err");

    items.push({ item, condition: cond, qty });
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Saving…';

  try {
    // Atomically bump the running counter and write every line item under the
    // resulting sequential transaction number — all in one Firestore transaction.
    const counterRef = doc(db, ...COUNTER);
    const txnNo = await runTransaction(db, async (tx) => {
      const snap = await tx.get(counterRef);
      const next = (snap.exists() ? snap.data().current || 0 : 0) + 1;
      tx.set(counterRef, { current: next });

      const no = fmtTxnNo(next);
      items.forEach((it) => {
        const ref = doc(collection(db, RETURNS));
        tx.set(ref, {
          txnNo: no,
          seq: next,
          date,
          customer,
          drNumber,
          item: it.item,
          condition: it.condition,
          qty: it.qty,
          createdAt: serverTimestamp(),
        });
      });
      return no;
    });

    showToast(`Saved ${items.length} item${items.length > 1 ? "s" : ""} ✓  ${txnNo}`, "ok");
    rememberCustomer(customer); // add to suggestions if it's a new name
    resetForm();
    loadRecent();
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
  $("customer").value = "";
  $("drNumber").value = "";
  itemsWrap.innerHTML = "";
  addItemRow();
  $("customer").focus();
}
