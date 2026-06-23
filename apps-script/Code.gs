/**
 * BKM Item Returns — Google Apps Script backend
 *
 * This script serves a mobile web app and reads/writes a Google Sheet.
 *
 * Expected spreadsheet layout (sheet/tab names are configurable below):
 *   - "Returns"   : log of submitted returns. A header row is created
 *                   automatically on first write.
 *   - "Customers" : customer names in column A (one per row). Used to power
 *                   the customer autocomplete. Row 1 may be a header.
 *
 * Setup: see README.md in this folder.
 */

// ---- Configuration ----------------------------------------------------------

var RETURNS_SHEET = 'Returns';
var CUSTOMERS_SHEET = 'Customers';

var RETURNS_HEADERS = [
  'Date',
  'Customer',
  'Item Name',
  'Quantity',
  'With Paper',
  'Remarks',
  'Submitted At'
];

// ---- Web app entry point ----------------------------------------------------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('BKM Returns')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---- Helpers ----------------------------------------------------------------

function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getOrCreateSheet_(name) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

/**
 * Returns the sorted, de-duplicated list of customer names from the
 * Customers sheet (column A). Skips a header row if present.
 */
function getCustomers() {
  var sheet = getSpreadsheet_().getSheetByName(CUSTOMERS_SHEET);
  if (!sheet) {
    return [];
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) {
    return [];
  }
  var values = sheet.getRange(1, 1, lastRow, 1).getValues();
  var seen = {};
  var names = [];
  for (var i = 0; i < values.length; i++) {
    var name = String(values[i][0] || '').trim();
    if (!name) continue;
    // Skip an obvious header in the first row.
    if (i === 0 && name.toLowerCase() === 'customer') continue;
    var key = name.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    names.push(name);
  }
  names.sort(function (a, b) {
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });
  return names;
}

/**
 * Appends a return record to the Returns sheet.
 *
 * @param {Object} data
 * @param {string} data.date       ISO date string (yyyy-mm-dd)
 * @param {string} data.customer   Customer name
 * @param {string} data.itemName   Item name
 * @param {number} data.quantity   Quantity returned
 * @param {boolean} data.withPaper Whether the return is "with paper"
 * @param {string} data.remarks    Free-text remarks
 * @return {Object} { ok: true } on success
 */
function saveReturn(data) {
  data = data || {};

  var customer = String(data.customer || '').trim();
  var itemName = String(data.itemName || '').trim();
  var quantity = Number(data.quantity);
  var date = String(data.date || '').trim();

  if (!date) {
    throw new Error('Date is required.');
  }
  if (!customer) {
    throw new Error('Customer is required.');
  }
  if (!itemName) {
    throw new Error('Item name is required.');
  }
  if (!quantity || quantity <= 0 || isNaN(quantity)) {
    throw new Error('Quantity must be a positive number.');
  }

  var sheet = getOrCreateSheet_(RETURNS_SHEET);

  // Ensure the header row exists.
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(RETURNS_HEADERS);
    sheet.getRange(1, 1, 1, RETURNS_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  sheet.appendRow([
    date,
    customer,
    itemName,
    quantity,
    data.withPaper ? 'Yes' : 'No',
    String(data.remarks || '').trim(),
    new Date()
  ]);

  // Add the customer to the Customers sheet if it's new, so the
  // autocomplete list grows over time.
  addCustomerIfNew_(customer);

  return { ok: true };
}

function addCustomerIfNew_(customer) {
  if (!customer) return;
  var existing = getCustomers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].toLowerCase() === customer.toLowerCase()) {
      return;
    }
  }
  var sheet = getOrCreateSheet_(CUSTOMERS_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Customer']);
    sheet.getRange(1, 1, 1, 1).setFontWeight('bold');
  }
  sheet.appendRow([customer]);
}
