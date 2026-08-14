// BKM Returns — mobile-first returns logger backed by Cloud Firestore.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const RETURNS = "returns";

// ---- DOM refs ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const form = $("form");
const btn = $("submitBtn");
const qtyInput = $("qty");
const toast = $("toast");
const configBanner = $("configBanner");
const recentList = $("recentList");
const customerList = $("customerList");

// ---- Default the date to today (local) --------------------------------------
(function setToday() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  $("date").value = local.toISOString().slice(0, 10);
})();

// ---- Quantity stepper -------------------------------------------------------
$("qtyMinus").addEventListener("click", () => {
  qtyInput.value = Math.max(1, (parseInt(qtyInput.value, 10) || 1) - 1);
});
$("qtyPlus").addEventListener("click", () => {
  qtyInput.value = (parseInt(qtyInput.value, 10) || 0) + 1;
});
// Select the current value on focus so typing replaces it (e.g. the default 1).
["focus", "click"].forEach((ev) =>
  qtyInput.addEventListener(ev, () => qtyInput.select())
);

// ---- Condition picker (Good / Defective) ------------------------------------
let condition = null;
const segButtons = document.querySelectorAll("#condition .seg-btn");
segButtons.forEach((b) =>
  b.addEventListener("click", () => {
    condition = b.dataset.value;
    segButtons.forEach((x) => {
      const on = x === b;
      x.classList.toggle("active", on);
      x.setAttribute("aria-pressed", on ? "true" : "false");
    });
  })
);

// ---- Toast helper -----------------------------------------------------------
let toastTimer;
function showToast(msg, kind = "ok") {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = "toast show " + kind;
  toastTimer = setTimeout(() => (toast.className = "toast " + kind), 3200);
}

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

// ---- Recent returns + customer autocomplete ---------------------------------
function fmtDate(value) {
  // value is a YYYY-MM-DD string; render as a friendly local date.
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

async function loadRecent() {
  if (!db) return;
  try {
    const snap = await getDocs(
      query(collection(db, RETURNS), orderBy("createdAt", "desc"), limit(15))
    );

    // Render recent list.
    if (snap.empty) {
      recentList.innerHTML = '<li class="empty">No returns logged yet.</li>';
    } else {
      const rows = [];
      const customers = new Set();
      snap.forEach((doc) => {
        const r = doc.data();
        if (r.customer) customers.add(r.customer);
        const dr = r.drNumber ? ` · DR ${escapeHtml(r.drNumber)}` : "";
        const badge = r.condition
          ? `<span class="badge ${r.condition === "Defective" ? "bad" : "good"}">${escapeHtml(r.condition)}</span>`
          : "";
        rows.push(
          `<li>
             <div class="r-top">
               <span class="r-cust">${escapeHtml(r.customer)}</span>
               <span class="r-qty">×${escapeHtml(r.qty)}</span>
             </div>
             <div class="r-item">${escapeHtml(r.item)}</div>
             <div class="r-meta">${badge}<span>${escapeHtml(fmtDate(r.date))}${dr}</span></div>
           </li>`
        );
      });
      recentList.innerHTML = rows.join("");

      // Refresh customer autocomplete from what we've seen.
      customerList.innerHTML = "";
      [...customers].sort().forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        customerList.appendChild(opt);
      });
    }
  } catch (err) {
    console.error(err);
    recentList.innerHTML =
      '<li class="empty">Could not load recent returns.</li>';
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

  const payload = {
    date: $("date").value,
    customer: $("customer").value.trim(),
    item: $("item").value.trim(),
    condition: condition,
    qty: parseInt(qtyInput.value, 10) || 0,
    drNumber: $("drNumber").value.trim(),
  };

  if (!payload.date) return showToast("Date is required", "err");
  if (!payload.customer) return showToast("Customer is required", "err");
  if (!payload.item) return showToast("Item is required", "err");
  if (!payload.condition)
    return showToast("Select a condition — Good or Defective", "err");
  if (!payload.qty || payload.qty < 1)
    return showToast("QTY must be at least 1", "err");

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Saving…';

  try {
    await addDoc(collection(db, RETURNS), {
      ...payload,
      createdAt: serverTimestamp(),
    });
    showToast("Return saved ✓", "ok");
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
  $("item").value = "";
  qtyInput.value = 1;
  $("drNumber").value = "";
  condition = null;
  segButtons.forEach((x) => {
    x.classList.remove("active");
    x.setAttribute("aria-pressed", "false");
  });
  $("customer").focus();
}
