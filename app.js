// BKM Returns — mobile-first returns logger backed by Cloud Firestore.
// A return is one transaction (shared txnNo) that can contain several items;
// each item is stored as its own document so the data stays easy to query.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  query,
  orderBy,
  limit,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const RETURNS = "returns";

// ---- DOM refs ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const form = $("form");
const btn = $("submitBtn");
const toast = $("toast");
const configBanner = $("configBanner");
const recentList = $("recentList");
const customerList = $("customerList");
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

// Transaction number, e.g. R-260814-143052-A3 (date-time + short suffix).
function makeTxnNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate()) +
    "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  const suffix = Math.random().toString(36).slice(2, 4).toUpperCase();
  return `R-${stamp}-${suffix}`;
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
    const customers = new Set();
    snap.forEach((docSnap) => {
      const r = docSnap.data();
      if (r.customer) customers.add(r.customer);
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

    // Refresh customer autocomplete from what we've seen.
    customerList.innerHTML = "";
    [...customers].sort().forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      customerList.appendChild(opt);
    });
  } catch (err) {
    console.error(err);
    recentList.innerHTML = '<li class="empty">Could not load recent returns.</li>';
  }
}
loadRecent();

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

  const txnNo = makeTxnNo();

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Saving…';

  try {
    // Write all line items atomically under the one transaction number.
    const batch = writeBatch(db);
    items.forEach((it) => {
      const ref = doc(collection(db, RETURNS));
      batch.set(ref, {
        txnNo,
        date,
        customer,
        drNumber,
        item: it.item,
        condition: it.condition,
        qty: it.qty,
        createdAt: serverTimestamp(),
      });
    });
    await batch.commit();

    showToast(`Saved ${items.length} item${items.length > 1 ? "s" : ""} ✓  ${txnNo}`, "ok");
    resetForm();
    loadRecent();
  } catch (err) {
    console.error(err);
    showToast(err?.message || "Save failed — try again", "err");
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
