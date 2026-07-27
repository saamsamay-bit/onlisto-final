/**
 * ============================================================================
 * ONLISTO — MASTER index.js (single source of truth)
 * ============================================================================
 * Rebuilt 23 Jul 2026 from: GitHub backup (40KB) + live Firebase function list
 * (21 functions) + dashboard HTML contract (onlisto.io).
 *
 * FIXES IN THIS FILE (mapped to the bug list):
 *  #1 node-fetch removed — Node 24 has fetch built in (was MODULE_NOT_FOUND)
 *  #2 pullOnBuyOrders no longer calls undefined fetchOnBuyOrders; reads API
 *     keys from Firebase Secrets, not from a non-existent org doc field
 *  #3 ONE dedupe scheme everywhere: doc ID = onbuy_<orderId> for scheduler
 *     AND manual pull (was random .add() vs doc() fighting each other)
 *  #4 OnBuy auth tries BOTH endpoint styles and logs which one works;
 *     response parsing accepts results|data|orders|listings and logs shape
 *  #5 API sync NEVER overwrites the dashboard status field. OnBuy truth goes
 *     to onbuyStatus only. VA-owned status ('Dispatched') is untouchable.
 *  #6 pullOnBuyListings now PAGINATES (was first ~100 listings only) and
 *     skips writes when nothing changed (saves Firestore money)
 *  #7 checkSourcePrices / manualSourceCheck / updateListingSource now need
 *     ?key=ADMIN_KEY (was open to the whole internet burning Bee credits)
 *  #8 migrateData removed (open collection copier). Legacy one-time jobs
 *     intentionally NOT in this file — they get deleted on deploy.
 *  #9 /orders IGNORES page=N (24 Jul 2026) — import + dispatch-sync passes
 *     now paginate with limit+offset like /listings.
 * #10 UNFILTERED /orders only returns AWAITING orders (24 Jul 2026, proven
 *     live: syncScanned == exact awaiting count). Dispatch-sync must query
 *     filter[status]=dispatched explicitly — this was the true root of the
 *     ghost-orders bug (dispatched on OnBuy, stuck 'active' on dashboard).
 *     Cancelled orders now flag needsAttention for human review.
 * #11 SYNC EXTENSION (26 Jul 2026, probe-proven): sync also pulls
 *     filter[status]=refunded (paginated) and mirrors OnBuy's raw refunds /
 *     cancellation / dispatches objects onto order docs (onbuyRefunds,
 *     onbuyCancellation, onbuyDispatches). Refunded orders flip status to
 *     'Refunded' one-way (statusSource: onbuy_sync). Feeds the dashboard's
 *     cancelled/refunded view + refund-rate KPI. NOTE: /disputes, /cases,
 *     /returns, /refunds endpoints do NOT exist for sellers (HTTP 403,
 *     probe-proven) — disputes stay on the email parser.
 * #12 getLiveData heartbeat now includes the Refunded count + hasBuyerPhone.
 * #13 BUYER PHONE (28 Jul 2026): the 23 Jul rebuild guessed
 *     delivery_address.phone — wrong/empty, WhatsApp+call buttons vanished
 *     from the orders table (they only render when buyerPhone exists).
 *     extractBuyerPhone() tries every candidate field in buyer AND
 *     delivery_address; import + both sync passes backfill buyerPhone when
 *     empty. probeOnBuyData singleOrder now dumps buyer/delivery_address
 *     inner KEY NAMES + phone-ish field paths (names only, never values).
 *
 * STILL TO VERIFY WITH ONE REAL CALL (testOnBuyAuth does this):
 *  - Which OnBuy auth style the live API actually accepts
 *  - Exact orders/listings response field names on the live account
 *  - Dispatch + reprice PUT payloads (marked CONFIRM WITH ONBUY below)
 * ============================================================================
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const axios = require('axios');
const cheerio = require('cheerio');

admin.initializeApp();
const db = admin.firestore();

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const ORG_ID = 'LfCP6mxaSP0WHclScUQC';
const ONBUY_BASE = 'https://api.onbuy.com/v2';

const ACCOUNTS = [
  {
    name: 'Panacea',
    team: 'panacea',
    consumerKey: defineSecret('ONBUY_PANACEA_CONSUMER_KEY'),
    secretKey: defineSecret('ONBUY_PANACEA_SECRET_KEY'),
  },
  {
    name: 'Samayy',
    team: 'samayy',
    consumerKey: defineSecret('ONBUY_SAMAYY_CONSUMER_KEY'),
    secretKey: defineSecret('ONBUY_SAMAYY_SECRET_KEY'),
  },
];

const ALL_SECRETS = ACCOUNTS.flatMap(a => [a.consumerKey, a.secretKey]);

// ---------------------------------------------------------------------------
// SHARED HELPERS
// ---------------------------------------------------------------------------

// Bug #4 fix: try the documented auth style first, fall back to the legacy
// one, and LOG which succeeded so the truth is in the logs, not in guesses.
async function getOnBuyToken(consumerKey, secretKey) {
  // Style A: POST /auth/request-token with JSON body (OnBuy docs style)
  try {
    const res = await fetch(`${ONBUY_BASE}/auth/request-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumer_key: consumerKey, secret_key: secretKey }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.access_token) {
      logger.info('OnBuy auth OK: request-token (json)');
      return json.access_token;
    }
    logger.warn(`OnBuy auth style A failed: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  } catch (e) {
    logger.warn(`OnBuy auth style A error: ${e.message}`);
  }

  // Style B: POST /auth/request_token with form-encoded body (legacy style)
  const res2 = await fetch(`${ONBUY_BASE}/auth/request_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ consumer_key: consumerKey, secret_key: secretKey }),
  });
  const json2 = await res2.json().catch(() => ({}));
  if (!res2.ok || !json2.access_token) {
    throw new Error(`OnBuy auth failed BOTH styles. Style B: ${res2.status} ${JSON.stringify(json2).slice(0, 200)}`);
  }
  logger.info('OnBuy auth OK: request_token (form)');
  return json2.access_token;
}

// OnBuy quirk (PROVEN 23 Jul 2026 via testOnBuyAuth 4-way matrix):
// API calls need the RAW token — a "Bearer " prefix gets HTTP 401.
// Path is /orders?site_id=2000 — /sites/2000/orders gets HTTP 404.
// Order lists come back in json.results (NOT json.data / json.orders).
async function onbuyGet(token, path) {
  const res = await fetch(`${ONBUY_BASE}${path}`, {
    headers: { Authorization: token },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OnBuy GET ${path} failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

// Bug #4 fix: accept every known list-shape and log when none matches.
function extractList(json, context) {
  const arr = json.results || json.data || json.orders || json.listings;
  if (Array.isArray(arr)) return arr;
  logger.warn(`${context}: UNKNOWN response shape. Top-level keys: ${Object.keys(json).join(', ')}`);
  return [];
}

// Bug #7 fix: shared admin-key guard for every public HTTP endpoint.
function checkAdminKey(req, res) {
  const expected = process.env.ADMIN_KEY || '';
  if (!expected) {
    res.status(503).json({ error: 'ADMIN_KEY is not set in functions/.env — add it and redeploy.' });
    return false;
  }
  const got = req.query.key || req.get('x-admin-key') || (req.body && req.body.key) || '';
  if (got !== expected) {
    res.status(401).json({ error: 'Invalid or missing key. Add ?key=YOUR_ADMIN_KEY' });
    return false;
  }
  return true;
}

function getScrapingBeeKey() {
  return process.env.SCRAPINGBEE_API_KEY || '';
}

// Bug #3 fix: ONE deterministic doc ID for every order, everywhere.
function orderDocId(onbuyOrderId) {
  return `onbuy_${String(onbuyOrderId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

// Buyer phone (#13, 28 Jul 2026): the 23 Jul rebuild guessed
// delivery_address.phone — real field name unconfirmed, so check EVERY
// candidate in BOTH buyer and delivery_address. WhatsApp/call buttons on
// the dashboard only render when buyerPhone exists — empty field = buttons
// vanish (user-reported).
function extractBuyerPhone(o) {
  const addr = o.delivery_address || {};
  const buyer = o.buyer || {};
  const cand = [addr.phone, addr.phone_number, addr.telephone, addr.mobile, addr.contact_number,
                buyer.phone, buyer.phone_number, buyer.telephone, buyer.mobile, buyer.contact_number];
  for (const c of cand) {
    if (c && String(c).replace(/\D/g, '').length >= 7) return String(c).trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// ORDERS — one shared import/sync path (scheduler + manual use the same code)
// ---------------------------------------------------------------------------
async function importOrSyncOrder(account, o) {
  const onbuyOrderId = String(o.order_id || o.id || o.order_number || '');
  if (!onbuyOrderId) {
    logger.warn(`${account.name}: skipping order with no order_id.`);
    return 'skipped';
  }

  const item = (o.products && o.products[0]) || {};
  const addr = o.delivery_address || {};
  const onbuyStatus = o.status || '';
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = db.collection('orderTracker_orders').doc(orderDocId(onbuyOrderId));
  const snap = await ref.get();

  if (snap.exists) {
    // Bug #5 fix: mirror OnBuy truth into onbuyStatus ONLY.
    // Never touch `status` — that field belongs to the VA/dashboard workflow.
    const ex = snap.data();
    const updates = { lastSyncedAt: now };
    if ((ex.onbuyStatus || '') !== onbuyStatus) updates.onbuyStatus = onbuyStatus;
    if (!ex.account) { updates.account = account.name; updates.team = account.team; }
    if (!ex.orgId) updates.orgId = ORG_ID;
    const ph = extractBuyerPhone(o);
    if (ph && !ex.buyerPhone) updates.buyerPhone = ph; // #13 backfill
    // Flag cancellations/refunds for a human instead of silently changing data
    const s = onbuyStatus.toLowerCase();
    if ((s.includes('cancel') || s.includes('refund')) && ex.status !== 'Cancelled') {
      updates.needsAttention = true;
      updates.attentionReason = `OnBuy shows: ${onbuyStatus}`;
    }
    if (Object.keys(updates).length > 1) {
      await ref.update(updates);
      return 'synced';
    }
    return 'unchanged';
  }

  // Legacy guard: older imports used random doc IDs. One cheap query catches
  // them so we never duplicate an order that arrived before this scheme.
  const legacy = await db.collection('orderTracker_orders')
    .where('onbuyOrderId', '==', onbuyOrderId).limit(1).get();
  if (!legacy.empty) {
    await legacy.docs[0].ref.update({ onbuyStatus, lastSyncedAt: now });
    return 'synced-legacy';
  }

  await ref.set({
    orgId: ORG_ID,
    team: account.team,
    account: account.name,
    platform: '',
    orderNo: onbuyOrderId,
    onbuyOrderId,
    sku: item.sku || o.sku || '',
    opc: item.opc || o.opc || '',
    item: item.title || item.name || o.product_title || 'Imported from OnBuy',
    qty: Number(item.quantity || o.quantity || 1),
    sellingPrice: Number(o.price_total ?? o.total ?? item.price ?? 0),      // real OnBuy field: price_total
    onbuyFee: Number(o.sales_fee_inc_VAT ?? o.sales_fee_ex_VAT ?? o.sales_fee ?? 0), // real OnBuy field
    amount: 0,                    // sourcing cost — VA fills this in
    sourceOrderNo: '',
    sourceLink: '',
    notes: '',
    buyerName: addr.name || (o.buyer && o.buyer.name) || '',
    buyerPhone: extractBuyerPhone(o),
    buyerEmail: (o.buyer && o.buyer.email) || '',
    buyerAddress: [addr.line_1, addr.town].filter(Boolean).join(', '),
    buyerPostcode: addr.postcode || '',
    onbuyOrderDate: (o.date || o.created || '').slice(0, 10), // real OnBuy field: date
    status: 'active',             // VA workflow starts here — dashboard-owned
    onbuyStatus,
    trackingNumber: '',
    trackingCarrier: '',
    dispatchedToOnbuy: false,
    dispatchedAt: null,
    unlockedTeam: null,
    unlockRequested: false,
    unlockRequestReason: null,
    refundAmount: null,
    refundReason: null,
    refundAt: null,
    lastEditedAt: null,
    importedFromApi: true,
    needsSourcingInfo: true,
    createdAt: now,
    lastSyncedAt: now,
  });
  return 'imported';
}

// ONE-WAY dispatch sync: when OnBuy says an order is dispatched, the
// dashboard follows (active -> Dispatched). NEVER backwards, never touches
// any other VA-owned field. Primary signal: OnBuy's real `dispatched` bool.
// Trap avoided: "Awaiting Dispatch" CONTAINS "dispatch" — exclude 'awaiting'.
async function syncStatusFromOnBuy(account, o) {
  const onbuyOrderId = String(o.order_id || '');
  if (!onbuyOrderId) return 'skipped';
  const onbuyStatus = o.status || '';
  const now = admin.firestore.FieldValue.serverTimestamp();

  let ref = db.collection('orderTracker_orders').doc(orderDocId(onbuyOrderId));
  let snap = await ref.get();
  if (!snap.exists) {
    const legacy = await db.collection('orderTracker_orders')
      .where('onbuyOrderId', '==', onbuyOrderId).limit(1).get();
    if (legacy.empty) return 'not-found';
    ref = legacy.docs[0].ref;
    snap = await ref.get();
  }

  const ex = snap.data();
  const s = onbuyStatus.toLowerCase();
  const onbuySaysDispatched = o.dispatched === true
    || ((s.includes('dispatch') || s.includes('shipped') || s.includes('complete')) && !s.includes('awaiting'));

  const updates = { lastSyncedAt: now };
  if ((ex.onbuyStatus || '') !== onbuyStatus) updates.onbuyStatus = onbuyStatus;
  const ph = extractBuyerPhone(o);
  if (ph && !ex.buyerPhone) updates.buyerPhone = ph; // #13 backfill

  // Sync extension (26 Jul 2026, pipeline #9/#11 data feed — probe-proven
  // fields): mirror OnBuy's raw money/workflow objects so the dashboard's
  // cancelled/refunded view + refund-rate KPI can read them from Firestore.
  const rawMirror = [['refunds', 'onbuyRefunds'], ['cancellation', 'onbuyCancellation'], ['dispatches', 'onbuyDispatches']];
  for (const [srcField, dstField] of rawMirror) {
    if (o[srcField] !== undefined) {
      const incoming = JSON.stringify(o[srcField] || null);
      if (incoming !== JSON.stringify(ex[dstField] || null)) updates[dstField] = o[srcField] || null;
    }
  }

  const currentStatus = String(ex.status || '');
  // Cancelled on OnBuy → flag for a human, never auto-change status.
  if (s.includes('cancel') && currentStatus !== 'Cancelled' && !ex.needsAttention) {
    updates.needsAttention = true;
    updates.attentionReason = `OnBuy shows: ${onbuyStatus}`;
  }

  // Refunded on OnBuy → dashboard follows (one-way, same rule as dispatch).
  if (s.includes('refund') && currentStatus !== 'Refunded' && currentStatus !== 'Cancelled') {
    updates.status = 'Refunded';
    updates.statusSource = 'onbuy_sync';
    if (!ex.refundAt) updates.refundAt = now;
  }

  const alreadyHandled = currentStatus.toLowerCase() === 'dispatched' || currentStatus === 'Cancelled';
  if (onbuySaysDispatched && !alreadyHandled) {
    updates.status = 'Dispatched';
    updates.statusSource = 'onbuy_sync'; // so we know WHO dispatched (OnBuy direct, not dashboard)
    if (!ex.dispatchedAt) updates.dispatchedAt = now;
  }

  if (Object.keys(updates).length > 1) {
    await ref.update(updates);
    if (updates.status === 'Dispatched') return 'dispatched';
    if (updates.status === 'Refunded') return 'refunded';
    if (updates.needsAttention) return 'attention';
    return 'synced';
  }
  return 'unchanged';
}

async function pullOrdersForAccount(account, fullRescan) {
  const token = await getOnBuyToken(account.consumerKey.value(), account.secretKey.value());

  // previously_exported=0 stops OnBuy re-sending orders we already pulled.
  // fullRescan mode drops that filter to rescue anything missed by a crash.
  const exportedFilter = fullRescan ? '' : '&filter[previously_exported]=0';
  const counts = { imported: 0, synced: 0, unchanged: 0, skipped: 0, dispatchedSynced: 0 };

  // OnBuy quirk #3 (PROVEN 24 Jul 2026): /orders IGNORES page=N — only
  // limit+offset paginate (same as /listings). Import loop keeps offset=0
  // because OnBuy marks orders exported on read, so each call returns the
  // next batch; full-rescan mode must paginate with real offsets instead.
  for (let batch = 0; batch < 10; batch++) {
    const offset = fullRescan ? batch * 100 : 0;
    const json = await onbuyGet(token,
      `/orders?site_id=2000&filter[status]=awaiting_dispatch${exportedFilter}&sort[created]=asc&limit=100&offset=${offset}`);
    const orders = extractList(json, `orders batch ${batch} (${account.name})`);
    if (!orders.length) break;

    for (const o of orders) {
      const result = await importOrSyncOrder(account, o);
      if (result === 'imported') counts.imported++;
      else if (result.startsWith('synced')) counts.synced++;
      else if (result === 'unchanged') counts.unchanged++;
      else counts.skipped++;
    }
    if (orders.length < 100) break; // last page
  }

  // Dispatch sync pass. OnBuy quirk #2 (proven 23 Jul 2026): "updated" is an
  // INVALID sort field (HTTP 400) — "created" is the valid one. Wrapped so a
  // failure here can never swallow the import results above.
  try {
    // BUG FIX 24 Jul 2026 (two parts):
    //  a) page=1&limit=100 — OnBuy ignores page=, only offset paginates.
    //  b) UNFILTERED /orders only returns AWAITING orders (proven live:
    //     syncScanned equalled the exact awaiting count). Dispatched orders
    //     NEVER appear there — must ask with filter[status]=dispatched.
    //     This was the true root of the 22-vs-12 ghost orders bug.
    let scanned = 0;
    for (let offset = 0; offset < 300; offset += 100) {
      const recent = await onbuyGet(token,
        `/orders?site_id=2000&filter[status]=dispatched&sort[created]=desc&limit=100&offset=${offset}`);
      const list = extractList(recent, `dispatched orders offset ${offset} (${account.name})`);
      if (!list.length) break;
      scanned += list.length;
      for (const o of list) {
        const r = await syncStatusFromOnBuy(account, o);
        if (r === 'dispatched') counts.dispatchedSynced++;
      }
      if (list.length < 100) break; // last page
    }
    counts.syncScanned = scanned;

    // Cancelled orders: flag for a human (needsAttention), never auto-change.
    const cancelled = await onbuyGet(token,
      `/orders?site_id=2000&filter[status]=cancelled&sort[created]=desc&limit=100&offset=0`);
    for (const o of extractList(cancelled, `cancelled orders (${account.name})`)) {
      const r = await syncStatusFromOnBuy(account, o);
      if (r === 'attention') counts.cancelFlagged = (counts.cancelFlagged || 0) + 1;
    }

    // Refunded orders (26 Jul 2026 — probe-proven filter): dashboard follows
    // one-way, refunds object mirrored by syncStatusFromOnBuy. Paginated.
    for (let offset = 0; offset < 300; offset += 100) {
      const refunded = await onbuyGet(token,
        `/orders?site_id=2000&filter[status]=refunded&sort[created]=desc&limit=100&offset=${offset}`);
      const list = extractList(refunded, `refunded orders offset ${offset} (${account.name})`);
      if (!list.length) break;
      for (const o of list) {
        const r = await syncStatusFromOnBuy(account, o);
        if (r === 'refunded') counts.refundedSynced = (counts.refundedSynced || 0) + 1;
      }
      if (list.length < 100) break;
    }
  } catch (e) {
    logger.error(`recent-orders sync failed (${account.name}): ${e.message}`);
    counts.dispatchSyncError = e.message;
  }
  return counts;
}

// SCHEDULED — every 15 minutes, both accounts
exports.scheduledPullOnBuyOrders = onSchedule(
  { schedule: 'every 15 minutes', secrets: ALL_SECRETS, timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    for (const account of ACCOUNTS) {
      try {
        const c = await pullOrdersForAccount(account, false);
        logger.info(`${account.name}: ${c.imported} imported, ${c.synced} synced, ${c.unchanged} unchanged, ${c.skipped} skipped`);
      } catch (e) {
        logger.error(`scheduledPullOnBuyOrders ${account.name}: ${e.message}`);
      }
    }
  }
);

// MANUAL — same code path, run from browser. ?key=...&account=panacea&full=1
exports.pullOnBuyOrders = onRequest(
  { secrets: ALL_SECRETS, timeoutSeconds: 540, memory: '1GiB' },
  async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    const fullRescan = req.query.full === '1';
    const wanted = (req.query.account || 'all').toLowerCase();
    const results = {};

    for (const account of ACCOUNTS) {
      if (wanted !== 'all' && account.team !== wanted && account.name.toLowerCase() !== wanted) continue;
      try {
        results[account.name] = await pullOrdersForAccount(account, fullRescan);
      } catch (e) {
        results[account.name] = { error: e.message };
        logger.error(`pullOnBuyOrders ${account.name}: ${e.message}`);
      }
    }
    res.json({ success: true, fullRescan, results });
  }
);

// ---------------------------------------------------------------------------
// LISTINGS — Bug #6 fix: full pagination + change detection (saves money)
// Runs hourly. Replaces both old pullOnBuyListings and pullOnBuyListingsHourly.
// ---------------------------------------------------------------------------
exports.pullOnBuyListings = onSchedule(
  { schedule: 'every 60 minutes', secrets: ALL_SECRETS, timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    for (const account of ACCOUNTS) {
      try {
        await pullListingsForAccount(account);
      } catch (e) {
        logger.error(`pullOnBuyListings ${account.name}: ${e.message}`);
      }
    }
  }
);

async function pullListingsForAccount(account) {
  const token = await getOnBuyToken(account.consumerKey.value(), account.secretKey.value());
  const now = admin.firestore.FieldValue.serverTimestamp();

  let batch = db.batch();
  let batchOps = 0;
  let scanned = 0, written = 0, unchangedCount = 0;
  const touchedIds = [];

  // OnBuy quirk #3 (proven 24 Jul 2026 via listingsProbe): pagination is
  // offset/limit (metadata returns limit+offset+total_rows), NOT page=N.
  // Real fields: name (not product_title), stock, opc, condition, sale_price.
  // winning_status / lead_listing_price DO NOT EXIST here — Buy Box data
  // lives in OnBuy's CSV export or another endpoint (next-session probe).
  for (let offset = 0; offset < 30000; offset += 100) {
    const json = await onbuyGet(token, `/listings?site_id=2000&country_code=GB&limit=100&offset=${offset}`);
    const listings = extractList(json, `listings offset ${offset} (${account.name})`);
    if (!listings.length) break;
    scanned += listings.length;

    // Change detection: read existing docs in chunks so unchanged listings
    // cost 1 read instead of 1 write (reads are 3x cheaper, and most
    // listings don't change hour to hour).
    const refs = listings.map(l => db.collection('orderTracker_listings').doc(`${account.name}_${l.sku || l.opc}`));
    const existing = await db.getAll(...refs);

    for (let i = 0; i < listings.length; i++) {
      const l = listings[i];
      const stock = parseInt(l.stock ?? 0, 10);
      const suspended = !!(l.suspended_reason && String(l.suspended_reason).trim());
      const price = parseFloat(l.price || 0);
      const competingPrice = parseFloat(l.lead_listing_price || l.winning_price || 0);
      const winningBuyBox = String(l.winning_status) === '1';
      const status = suspended ? 'suspended' : (stock > 0 ? 'active' : 'out_of_stock');
      const canWinByRepricing = !winningBuyBox && stock > 0 && competingPrice > 0 && competingPrice < price;
      const suggestedPrice = canWinByRepricing ? Math.max(0.01, competingPrice - 0.01) : null;

      // Fingerprint: if nothing meaningful changed, skip the write entirely.
      const fp = `${price}|${stock}|${status}|${winningBuyBox}|${competingPrice}`;
      const docSnap = existing[i];
      if (docSnap.exists && docSnap.data()._fp === fp) { unchangedCount++; continue; }

      batch.set(refs[i], {
        orgId: ORG_ID,
        account: account.name,
        team: account.team,
        sku: l.sku || '',
        opc: l.opc || '',
        title: l.name || l.product_title || l.title || '', // real OnBuy field: name
        price,
        quantity: stock,
        status,
        suspendedReason: l.suspended_reason || '',
        winningBuyBox,
        competingPrice,
        suggestedRepriceTo: suggestedPrice,
        category: l.category || '',
        brandName: l['brand name'] || l.brand_name || '',
        gtin: l.gtin || '',
        lastCheckedAt: now,
        _fp: fp,
      }, { merge: true });
      batchOps++;
      written++;
      touchedIds.push(refs[i].id);

      if (batchOps >= 400) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }
    if (listings.length < 100) break; // last page
  }
  if (batchOps > 0) await batch.commit();

  logger.info(`${account.name}: scanned ${scanned}, wrote ${written}, unchanged ${unchangedCount}`);
}

// ---------------------------------------------------------------------------
// REPRICER — user decision 23 Jul 2026: KEEP LIVE (pushes real OnBuy prices).
// Floor = (last logged cost × (1 + margin%)) ÷ (1 − real fee rate).
// Never goes below floor; never touches SKUs with no logged cost.
// ---------------------------------------------------------------------------
const DEFAULT_MARGIN_PERCENT = 15;

async function getMarginPercent() {
  const orgDoc = await db.collection('orderTracker_orgs').doc(ORG_ID).get();
  const val = orgDoc.exists ? orgDoc.data().repriceMarginPercent : null;
  return (typeof val === 'number' && val >= 0) ? val : DEFAULT_MARGIN_PERCENT;
}

async function getMostRecentCostAndFeeRate(sku) {
  const snap = await db.collection('orderTracker_orders')
    .where('orgId', '==', ORG_ID)
    .where('sku', '==', sku)
    .where('amount', '>', 0)
    .orderBy('amount')
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  const o = snap.docs[0].data();
  if (!o.sellingPrice || o.sellingPrice <= 0) return null;
  return { cost: o.amount, feeRate: (o.onbuyFee || 0) / o.sellingPrice };
}

function calcFloor(cost, feeRate, marginPercent) {
  const denom = 1 - feeRate;
  if (denom <= 0) return null;
  return (cost * (1 + marginPercent / 100)) / denom;
}

exports.repriceToWinBuyBox = onSchedule(
  { schedule: 'every 15 minutes', secrets: ALL_SECRETS, timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const marginPercent = await getMarginPercent();

    let candidates;
    try {
      candidates = await db.collection('orderTracker_listings')
        .where('orgId', '==', ORG_ID)
        .where('suggestedRepriceTo', '>', 0)
        .get();
    } catch (e) {
      // If this error mentions an INDEX, click the link in the log once.
      logger.error(`repriceToWinBuyBox candidates query failed: ${e.message}`);
      return;
    }
    if (candidates.empty) {
      logger.info('No reprice candidates this run.');
      return;
    }

    const toPushByAccount = {};
    for (const doc of candidates.docs) {
      const l = doc.data();
      let costInfo = null;
      try {
        costInfo = await getMostRecentCostAndFeeRate(l.sku);
      } catch (e) {
        logger.error(`cost lookup failed for ${l.sku}: ${e.message}`);
        continue;
      }
      if (!costInfo) {
        await doc.ref.update({ repriceStatus: 'no_cost_data_logged' });
        continue;
      }
      const floor = calcFloor(costInfo.cost, costInfo.feeRate, marginPercent);
      if (floor === null) {
        await doc.ref.update({ repriceStatus: 'fee_rate_too_high_to_calculate' });
        continue;
      }
      if (l.suggestedRepriceTo < floor) {
        await doc.ref.update({
          repriceStatus: 'below_floor_skipped',
          calculatedFloor: Math.round(floor * 100) / 100,
        });
        continue;
      }
      const newPrice = Math.round(l.suggestedRepriceTo * 100) / 100;
      if (!toPushByAccount[l.account]) toPushByAccount[l.account] = [];
      toPushByAccount[l.account].push({ sku: l.sku, price: newPrice, docRef: doc.ref, floor });
    }

    for (const accountName of Object.keys(toPushByAccount)) {
      const account = ACCOUNTS.find(a => a.name === accountName);
      if (!account) continue;
      const items = toPushByAccount[accountName].slice(0, 1000); // OnBuy batch cap
      try {
        const token = await getOnBuyToken(account.consumerKey.value(), account.secretKey.value());
        // CONFIRM WITH ONBUY: exact PUT body shape for /v2/listings/by-sku
        const res = await fetch(`${ONBUY_BASE}/listings/by-sku`, {
          method: 'PUT',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify(items.map(i => ({ sku: i.sku, price: i.price }))),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 300)}`);

        const batch = db.batch();
        for (const i of items) {
          batch.update(i.docRef, {
            price: i.price,
            repriceStatus: 'repriced',
            calculatedFloor: Math.round(i.floor * 100) / 100,
            lastRepricedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        await batch.commit();
        logger.info(`${accountName}: repriced ${items.length} listing(s).`);
      } catch (e) {
        logger.error(`${accountName}: reprice push failed — ${e.message}`);
      }
    }
  }
);

// ---------------------------------------------------------------------------
// DISPATCH PUSH — VA adds tracking on dashboard → send it to OnBuy instantly
// ---------------------------------------------------------------------------
exports.pushTrackingToOnBuy = onDocumentUpdated(
  { document: 'orderTracker_orders/{orderId}', secrets: ALL_SECRETS },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    const trackingJustAdded = after.trackingNumber && after.trackingNumber !== before.trackingNumber;
    if (!trackingJustAdded || !after.onbuyOrderId || !after.account) return;
    if (after.dispatchedToOnbuy) return;

    const account = ACCOUNTS.find(a => a.name === after.account);
    if (!account) {
      logger.error(`No OnBuy account config for "${after.account}".`);
      return;
    }

    try {
      const token = await getOnBuyToken(account.consumerKey.value(), account.secretKey.value());
      // CONFIRM WITH ONBUY: exact dispatch payload + courier name list
      const res = await fetch(`${ONBUY_BASE}/orders/dispatch`, {
        method: 'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site_id: 2000,
          orders: [{
            order_id: after.onbuyOrderId,
            tracking: {
              supplier_name: after.trackingCarrier || '',
              number: after.trackingNumber,
            },
          }],
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 300)}`);

      await event.data.after.ref.update({
        dispatchedToOnbuy: true,
        dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      logger.info(`Dispatched tracking for order ${after.onbuyOrderId} (${account.name}).`);
    } catch (e) {
      logger.error(`Dispatch push failed for ${after.onbuyOrderId}: ${e.message}`);
    }
  }
);

// ---------------------------------------------------------------------------
// FIX STALE ORDERS (rewritten — old source was lost)
// Dry-run by default. Add &execute=true to actually write.
// Usage: /fixStaleOrders?key=...&days=14            → shows what WOULD change
//        /fixStaleOrders?key=...&days=14&execute=true → marks them Dispatched
// ---------------------------------------------------------------------------
exports.fixStaleOrders = onRequest(
  { timeoutSeconds: 540, memory: '512MiB' },
  async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    const days = Number(req.query.days || 14);
    const execute = req.query.execute === 'true';
    const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - days * 864e5));

    const snap = await db.collection('orderTracker_orders')
      .where('createdAt', '<', cutoff)
      .get();

    const stale = snap.docs.filter(d => {
      const o = d.data();
      const s = String(o.status || '').toLowerCase();
      const alreadyDone = s === 'dispatched' || s.includes('cancel') || s.includes('refund') || o.dispatchedToOnbuy === true;
      return !alreadyDone;
    });

    if (!execute) {
      return res.json({
        success: true,
        dryRun: true,
        olderThanDays: days,
        totalOldOrders: snap.size,
        staleCount: stale.length,
        sample: stale.slice(0, 20).map(d => ({ id: d.id, status: d.data().status, account: d.data().account })),
        message: 'DRY RUN — add &execute=true to the URL to actually mark these as Dispatched.',
      });
    }

    let batch = db.batch();
    let ops = 0, fixed = 0;
    for (const d of stale) {
      batch.update(d.ref, {
        status: 'Dispatched',
        staleFixedAt: admin.firestore.FieldValue.serverTimestamp(),
        staleFixNote: `Auto-marked Dispatched (older than ${days} days)`,
      });
      ops++; fixed++;
      if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
    if (ops > 0) await batch.commit();

    res.json({ success: true, dryRun: false, fixed, message: `${fixed} stale orders marked Dispatched.` });
  }
);

// ---------------------------------------------------------------------------
// GET LIVE DATA (read-only) — the closed-loop debugging API.
// Lets an AI assistant read LIVE Firestore to compare what the CODE says
// vs what the DATA actually shows. Own READONLY_KEY: can read, never write.
// Buyer contact details (email/phone/address/postcode) are always stripped.
//
//   /getLiveData?key=...                          → system heartbeat (counts)
//   /getLiveData?key=...&mode=collection&name=orderTracker_orders&limit=20
// ---------------------------------------------------------------------------
const READABLE = /^orderTracker_[a-zA-Z]+$/;

function serializeDoc(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v.toDate === 'function') out[k] = v.toDate().toISOString();
    else if (Array.isArray(v)) out[k] = v.slice(0, 5); // cap history arrays
    else out[k] = v;
  }
  delete out.buyerEmail;
  delete out.buyerPhone;
  delete out.buyerAddress;
  delete out.buyerPostcode;
  return out;
}

exports.getLiveData = onRequest({ cors: true, timeoutSeconds: 120 }, async (req, res) => {
  const expected = process.env.READONLY_KEY || '';
  if (!expected) {
    res.status(503).json({ error: 'READONLY_KEY is not set in functions/.env — add it and redeploy.' });
    return;
  }
  if ((req.query.key || '') !== expected) {
    res.status(401).json({ error: 'Invalid or missing key. Add ?key=YOUR_READONLY_KEY' });
    return;
  }

  try {
    const mode = req.query.mode || 'overview';

    if (mode === 'collection') {
      const name = String(req.query.name || '');
      if (!READABLE.test(name)) {
        res.status(400).json({
          error: 'name must be an orderTracker_* collection',
          example: '/getLiveData?key=...&mode=collection&name=orderTracker_orders&limit=20',
        });
        return;
      }
      const limit = Math.min(Number(req.query.limit || 20), 100);
      const snap = await db.collection(name).limit(limit).get();
      const docs = snap.docs.map(d => ({ id: d.id, ...serializeDoc(d.data()) }));
      res.json({ success: true, collection: name, returned: docs.length, docs });
      return;
    }

    // default: overview heartbeat — cheap aggregation counts
    const countOf = async (name, field, value) => {
      let q = db.collection(name);
      if (field !== undefined) q = q.where(field, '==', value);
      const agg = await q.count().get();
      return agg.data().count;
    };

    const recentOrdersSnap = await db.collection('orderTracker_orders')
      .orderBy('createdAt', 'desc').limit(5).get();
    const recentOrders = recentOrdersSnap.docs.map(d => {
      const o = d.data();
      return {
        id: d.id, orderNo: o.orderNo, account: o.account, status: o.status,
        onbuyStatus: o.onbuyStatus || null, sellingPrice: o.sellingPrice,
        onbuyFee: o.onbuyFee, amount: o.amount, dispatchedToOnbuy: !!o.dispatchedToOnbuy,
        hasBuyerPhone: !!o.buyerPhone,
        createdAt: o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toISOString() : null,
      };
    });

    res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      orders: {
        total: await countOf('orderTracker_orders'),
        active: await countOf('orderTracker_orders', 'status', 'active'),
        dispatched: await countOf('orderTracker_orders', 'status', 'Dispatched'),
        refunded: await countOf('orderTracker_orders', 'status', 'Refunded'),
        pushedToOnBuy: await countOf('orderTracker_orders', 'dispatchedToOnbuy', true),
        needsAttention: await countOf('orderTracker_orders', 'needsAttention', true),
      },
      listings: {
        total: await countOf('orderTracker_listings'),
        active: await countOf('orderTracker_listings', 'status', 'active'),
        outOfStock: await countOf('orderTracker_listings', 'status', 'out_of_stock'),
        suspended: await countOf('orderTracker_listings', 'status', 'suspended'),
        winningBuyBox: await countOf('orderTracker_listings', 'winningBuyBox', true),
        tierA: await countOf('orderTracker_listings', 'checkTier', 'A'),
        tierB: await countOf('orderTracker_listings', 'checkTier', 'B'),
        tierC: await countOf('orderTracker_listings', 'checkTier', 'C'),
        tierD: await countOf('orderTracker_listings', 'checkTier', 'D'),
      },
      disputes: {
        total: await countOf('orderTracker_disputes'),
        open: await countOf('orderTracker_disputes', 'status', 'Open'),
      },
      other: {
        expenses: await countOf('orderTracker_expenses'),
        clients: await countOf('orderTracker_clients'),
        bannedBrands: await countOf('orderTracker_bannedBrands'),
        vaPerformance: await countOf('orderTracker_vaPerformance'),
        messages: await countOf('orderTracker_messages'),
      },
      recentOrders,
    });
  } catch (e) {
    logger.error(`getLiveData error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// TEST ONBUY AUTH — one browser visit settles Bug #4 with evidence.
// Usage: /testOnBuyAuth?key=...&account=panacea   (or samayy)
// Returns which auth style worked + the real response shape of /orders.
// No secrets are ever returned — only success/failure and field names.
// ---------------------------------------------------------------------------
exports.testOnBuyAuth = onRequest(
  { secrets: ALL_SECRETS, timeoutSeconds: 120 },
  async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    const wanted = (req.query.account || 'panacea').toLowerCase();
    const account = ACCOUNTS.find(a => a.team === wanted || a.name.toLowerCase() === wanted);
    if (!account) return res.status(400).json({ error: 'account must be panacea or samayy' });

    const report = { account: account.name, authStyleA: null, authStyleB: null, ordersCall: null };
    let token = null;

    // Style A
    try {
      const r = await fetch(`${ONBUY_BASE}/auth/request-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          consumer_key: account.consumerKey.value(),
          secret_key: account.secretKey.value(),
        }),
      });
      const j = await r.json().catch(() => ({}));
      report.authStyleA = { httpStatus: r.status, gotToken: !!j.access_token };
      if (j.access_token && !token) token = j.access_token;
    } catch (e) {
      report.authStyleA = { error: e.message };
    }

    // Style B (only if A failed)
    if (!token) {
      try {
        const r = await fetch(`${ONBUY_BASE}/auth/request_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            consumer_key: account.consumerKey.value(),
            secret_key: account.secretKey.value(),
          }),
        });
        const j = await r.json().catch(() => ({}));
        report.authStyleB = { httpStatus: r.status, gotToken: !!j.access_token };
        if (j.access_token) token = j.access_token;
      } catch (e) {
        report.authStyleB = { error: e.message };
      }
    }

    // If we have a token, probe ALL combos the two old files disagreed on:
    // path: /orders?site_id= vs /sites/2000/orders  x  header: Bearer vs raw
    if (token) {
      const probes = [
        { name: 'orders_bearer', path: '/orders?site_id=2000&page=1&limit=1', header: `Bearer ${token}` },
        { name: 'orders_rawToken', path: '/orders?site_id=2000&page=1&limit=1', header: token },
        { name: 'sitesOrders_bearer', path: '/sites/2000/orders?page=1&limit=1', header: `Bearer ${token}` },
        { name: 'sitesOrders_rawToken', path: '/sites/2000/orders?page=1&limit=1', header: token },
      ];
      report.ordersMatrix = {};
      for (const p of probes) {
        try {
          const r = await fetch(`${ONBUY_BASE}${p.path}`, { headers: { Authorization: p.header } });
          const j = await r.json().catch(() => ({}));
          const list = j.results || j.data || j.orders || [];
          report.ordersMatrix[p.name] = {
            httpStatus: r.status,
            topLevelKeys: Object.keys(j).slice(0, 10),
            listFieldFound: j.results ? 'results' : j.data ? 'data' : j.orders ? 'orders' : 'NONE',
            sampleOrderKeys: list[0] ? Object.keys(list[0]).slice(0, 20) : [],
          };
          if (r.ok && Array.isArray(list) && list.length && !report.winningCombo) {
            report.winningCombo = {
              path: p.path.split('?')[0],
              headerStyle: p.name.endsWith('bearer') ? 'Bearer' : 'raw token',
            };
          }
        } catch (e) {
          report.ordersMatrix[p.name] = { error: e.message };
        }
      }
    }

    // Listings probe: raw Buy Box field truth (same evidence pattern that
    // settled every orders question — no guessing, dump what OnBuy sends)
    if (token) {
      try {
        const r = await fetch(`${ONBUY_BASE}/listings?site_id=2000&country_code=GB&page=1&limit=2`, {
          headers: { Authorization: token },
        });
        const j = await r.json().catch(() => ({}));
        const list = j.results || j.data || j.listings || [];
        report.listingsProbe = {
          httpStatus: r.status,
          topLevelKeys: Object.keys(j).slice(0, 10),
          metadata: j.metadata || null,
          listFieldFound: j.results ? 'results' : j.data ? 'data' : j.listings ? 'listings' : 'NONE',
          firstListingAllKeys: list[0] ? Object.keys(list[0]) : [],
          winningFieldsRaw: list.slice(0, 2).map(l => ({
            sku: l.sku,
            price: l.price,
            stock: l.stock,
            winning_status: l.winning_status,
            winning_status_type: typeof l.winning_status,
            lead_listing_price: l.lead_listing_price,
            winning_price: l.winning_price,
          })),
        };
      } catch (e) {
        report.listingsProbe = { error: e.message };
      }
    }

    res.json({ success: true, report });
  }
);

// ---------------------------------------------------------------------------
// SCRAPINGBEE — price checking (key-protected now, Bug #7)
// ---------------------------------------------------------------------------
const buildScrapingBeeUrl = (targetUrl) => {
  const apiKey = getScrapingBeeKey();
  return `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&render_js=true&premium_proxy=true&country_code=gb`;
};

const extractPrices = (html, platform) => {
  const $ = cheerio.load(html);
  const results = [];
  const selector = platform === 'amazon' ? '.a-price .a-offscreen'
    : platform === 'ebay' ? '.s-item__price' : '[class*="price"]';

  $(selector).each((i, el) => {
    if (i >= 3) return;
    const text = $(el).text().trim();
    const match = text.match(/£?\s*([\d,]+\.?\d{0,2})/);
    if (match) {
      const price = parseFloat(match[1].replace(/,/g, ''));
      if (price > 0 && price < 10000) {
        results.push({
          platform: platform === 'amazon' ? 'Amazon UK' : platform === 'ebay' ? 'eBay UK' : 'AliExpress',
          price,
          currency: 'GBP',
          title: platform + ' result ' + (i + 1),
          link: platform === 'amazon' ? 'https://www.amazon.co.uk' : platform === 'ebay' ? 'https://www.ebay.co.uk' : 'https://www.aliexpress.com',
        });
      }
    }
  });
  return results.slice(0, 2);
};

function extractSinglePrice(html, url) {
  let price = null;
  let title = null;
  let inStock = true;

  const pricePatterns = [
    /class="a-price-whole"[^>]*>([\d,]+)/,
    /class="a-offscreen"[^>]*>£?([\d,.]+)/,
    /"priceAmount":\s*([\d.]+)/,
    /"price":"£?([\d,.]+)"/,
    /data-price="([\d,.]+)"/,
    /£([\d,.]+)/,
  ];
  for (const pattern of pricePatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      price = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(price) && price > 0) break;
    }
  }

  const titleMatch = html.match(/<title>([^<]+)/)
    || html.match(/id="productTitle"[^>]*>([^<]+)/)
    || html.match(/"name":"([^"]+)"/);
  if (titleMatch) title = titleMatch[1].trim();

  if (html.includes('Out of stock') || html.includes('Currently unavailable') || html.includes('Temporarily out of stock')) {
    inStock = false;
  }
  return { price, title, inStock };
}

// On-demand check. Mode 1: ?sourceUrl= (1 Bee call). Mode 2: ?query= (3 calls).
exports.checkSourcePrices = onRequest({ cors: true, timeoutSeconds: 120 }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (!checkAdminKey(req, res)) return;

  const sourceUrl = req.query.sourceUrl || (req.body && req.body.sourceUrl);
  const query = req.query.query || req.query.sku || (req.body && req.body.query);
  const listingId = req.query.listingId || (req.body && req.body.listingId);
  const saveToFirestore = req.query.saveToFirestore === 'true' || (req.body && req.body.saveToFirestore === true);

  const apiKey = getScrapingBeeKey();
  if (!apiKey) { res.status(500).json({ error: 'SCRAPINGBEE_API_KEY not set in functions/.env' }); return; }

  try {
    if (sourceUrl) {
      const r = await axios.get(buildScrapingBeeUrl(sourceUrl), { timeout: 45000 });
      const extracted = extractSinglePrice(r.data, sourceUrl);
      const response = {
        success: true, mode: 'direct_url', sourceUrl,
        price: extracted.price, title: extracted.title, inStock: extracted.inStock,
        scrapedAt: new Date().toISOString(),
      };
      if (saveToFirestore && listingId) {
        await db.collection('orderTracker_listings').doc(listingId).set({
          sourcePrice: extracted.price,
          sourceTitle: extracted.title,
          sourceInStock: extracted.inStock,
          sourceCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        response.saved = true;
      }
      return res.json(response);
    }

    if (!query) {
      return res.status(400).json({
        error: 'Send either sourceUrl (1 Bee call) or query (3 Bee calls)',
        examples: {
          direct: '/checkSourcePrices?key=...&sourceUrl=https://amazon.co.uk/dp/...&listingId=ABC',
          search: '/checkSourcePrices?key=...&query=iphone+15+case&listingId=ABC&saveToFirestore=true',
        },
      });
    }

    const urls = {
      amazon: `https://www.amazon.co.uk/s?k=${encodeURIComponent(query)}`,
      ebay: `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(query)}`,
      aliexpress: `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(query)}`,
    };
    const results = await Promise.allSettled([
      axios.get(buildScrapingBeeUrl(urls.amazon), { timeout: 45000 }).then(r => extractPrices(r.data, 'amazon')),
      axios.get(buildScrapingBeeUrl(urls.ebay), { timeout: 45000 }).then(r => extractPrices(r.data, 'ebay')),
      axios.get(buildScrapingBeeUrl(urls.aliexpress), { timeout: 45000 }).then(r => extractPrices(r.data, 'aliexpress')),
    ]);

    let all = [];
    results.forEach(r => { if (r.status === 'fulfilled') all.push(...r.value); });
    all.sort((a, b) => a.price - b.price);
    const cheapest = all[0] || null;

    const response = {
      success: true, mode: 'search', searchTerm: query,
      sources: all, cheapest, apiCallsUsed: 3, scrapedAt: new Date().toISOString(),
    };
    if (saveToFirestore && listingId && cheapest) {
      await db.collection('orderTracker_listings').doc(listingId).set({
        sourcePrice: cheapest.price,
        sourcePlatform: cheapest.platform,
        sourceLink: cheapest.link,
        sourceTitle: cheapest.title,
        sourceCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      response.saved = true;
    }
    res.json(response);
  } catch (err) {
    logger.error(`checkSourcePrices error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// VA manual entry — zero Bee cost.
exports.manualSourceCheck = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (!checkAdminKey(req, res)) return;

  const { listingId, sourceUrl, sourcePrice, sourceTitle, inStock, checkedBy } = req.body || {};
  if (!listingId || sourcePrice === undefined) {
    return res.status(400).json({
      error: 'Missing listingId and sourcePrice',
      example: { listingId: 'Panacea_B07XYZ', sourceUrl: 'https://amazon.co.uk/dp/...', sourcePrice: 12.99, inStock: true, checkedBy: 'va_name' },
    });
  }

  try {
    await db.collection('orderTracker_listings').doc(listingId).set({
      sourceUrl: sourceUrl || '',
      sourcePrice: Number(sourcePrice),
      sourceTitle: sourceTitle || '',
      sourceInStock: inStock !== false,
      sourceCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
      sourceCheckedBy: checkedBy || 'va',
      sourceCheckMethod: 'manual',
      checkTier: 'B',
      checkCount: admin.firestore.FieldValue.increment(1),
      lastPriceChange: null,
      consecutiveNoChange: 0,
    }, { merge: true });

    res.json({ success: true, listingId, sourcePrice: Number(sourcePrice), method: 'manual' });
  } catch (err) {
    logger.error(`manualSourceCheck error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// VA adds/updates a listing's source URL — scheduled checker picks it up.
exports.updateListingSource = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (!checkAdminKey(req, res)) return;

  const { listingId, sourceUrl, sourcePlatform } = req.body || {};
  if (!listingId || !sourceUrl) {
    return res.status(400).json({
      error: 'Missing listingId and sourceUrl',
      example: { listingId: 'Panacea_B07XYZ', sourceUrl: 'https://amazon.co.uk/dp/B07XYZ', sourcePlatform: 'amazon' },
    });
  }

  try {
    await db.collection('orderTracker_listings').doc(listingId).set({
      sourceUrl,
      sourcePlatform: sourcePlatform || 'unknown',
      sourceUrlAddedAt: admin.firestore.FieldValue.serverTimestamp(),
      sourceUrlAddedBy: req.body.addedBy || 'va',
      checkTier: 'B',
      consecutiveNoChange: 0,
      lastPriceChange: null,
    }, { merge: true });

    res.json({ success: true, listingId, sourceUrl, message: 'Saved. Scheduled checker will monitor it (Tier B: every 24h).' });
  } catch (err) {
    logger.error(`updateListingSource error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// TIER SYSTEM — hot listings checked often, dead ones rarely (saves Bee money)
// A: 6h · B: 24h · C: 72h · D: 168h (1 week)
// Price change → move UP a tier. No change → drift DOWN after threshold.
// ---------------------------------------------------------------------------
const TIER_HOURS = { A: 6, B: 24, C: 72, D: 168 };
const TIER_THRESHOLDS = { B_to_C: 5, C_to_D: 10 };

function shouldCheckNow(listing) {
  const tier = listing.checkTier || 'B';
  const lastChecked = listing.sourceCheckedAt ? listing.sourceCheckedAt.toDate() : null;
  if (!lastChecked) return true;
  const hoursSince = (Date.now() - lastChecked.getTime()) / 36e5;
  return hoursSince >= TIER_HOURS[tier];
}

function updateTier(listing, newPrice) {
  const oldPrice = listing.sourcePrice;
  const currentTier = listing.checkTier || 'B';
  let newTier = currentTier;
  let consecutiveNoChange = listing.consecutiveNoChange || 0;
  let lastPriceChange = listing.lastPriceChange || null;
  let priceChanged = false;

  if (oldPrice !== undefined && newPrice !== undefined && newPrice !== null
      && Math.abs(oldPrice - newPrice) > 0.01) {
    priceChanged = true;
    if (currentTier === 'D') newTier = 'C';
    else if (currentTier === 'C') newTier = 'B';
    else if (currentTier === 'B') newTier = 'A';
    consecutiveNoChange = 0;
    lastPriceChange = admin.firestore.FieldValue.serverTimestamp();
  } else {
    consecutiveNoChange++;
    if (currentTier === 'B' && consecutiveNoChange >= TIER_THRESHOLDS.B_to_C) {
      newTier = 'C'; consecutiveNoChange = 0;
    } else if (currentTier === 'C' && consecutiveNoChange >= TIER_THRESHOLDS.C_to_D) {
      newTier = 'D'; consecutiveNoChange = 0;
    }
  }
  return { newTier, consecutiveNoChange, lastPriceChange, priceChanged };
}

// SCHEDULED — hourly. 1 Bee call per due listing. History only on price change
// (keeps docs small — old version logged every check forever).
exports.scheduledCheckSourcePrices = onSchedule(
  { schedule: 'every 60 minutes', timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    const apiKey = getScrapingBeeKey();
    if (!apiKey) { logger.error('SCRAPINGBEE_API_KEY not set in functions/.env'); return; }

    try {
      const listingsSnap = await db.collection('orderTracker_listings')
        .where('sourceUrl', '>', '')
        .get();
      if (listingsSnap.empty) { logger.info('No listings with sourceUrl.'); return; }

      const due = [];
      listingsSnap.forEach(doc => {
        const data = doc.data();
        data._docId = doc.id;
        if (shouldCheckNow(data)) due.push(data);
      });
      logger.info(`${due.length} listings due for source check (of ${listingsSnap.size} with sourceUrl).`);

      const BATCH_SIZE = 10;
      let checked = 0;
      for (let i = 0; i < due.length; i += BATCH_SIZE) {
        const batch = due.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(batch.map(async (listing) => {
          try {
            const r = await axios.get(buildScrapingBeeUrl(listing.sourceUrl), { timeout: 45000 });
            const extracted = extractSinglePrice(r.data, listing.sourceUrl);
            const t = updateTier(listing, extracted.price);

            const update = {
              sourcePrice: extracted.price,
              sourceTitle: extracted.title,
              sourceInStock: extracted.inStock,
              sourceCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
              sourceCheckMethod: 'auto_scrapingbee',
              checkTier: t.newTier,
              consecutiveNoChange: t.consecutiveNoChange,
              lastPriceChange: t.lastPriceChange,
            };
            // History entries ONLY when the price moved — bounded doc growth.
            if (t.priceChanged) {
              update.priceHistory = admin.firestore.FieldValue.arrayUnion({
                price: extracted.price,
                inStock: extracted.inStock,
                checkedAt: new Date().toISOString(),
                tier: t.newTier,
              });
            }
            await db.collection('orderTracker_listings').doc(listing._docId).update(update);
            checked++;
            logger.info(`${listing._docId}: £${extracted.price} (Tier ${t.newTier})`);
          } catch (err) {
            logger.error(`Check failed ${listing._docId}: ${err.message}`);
          }
        }));
      }
      logger.info(`Source check complete: ${checked} checked.`);
    } catch (err) {
      logger.error(`scheduledCheckSourcePrices error: ${err.message}`);
    }
  }
);

// ---------------------------------------------------------------------------
// PROBE ONBUY DATA (pipeline #10, 25 Jul 2026) — evidence dump, no guessing.
// Answers: does the API expose disputes? refunds? what does a FULL single
// order contain (all fields)? what do cancelled/dispatched orders carry?
//   /probeOnBuyData?key=...&account=samayy&orderId=T6MD55X
// Read-only. Returns field names + tiny samples — never secrets, never PII.
// RESULT (26 Jul 2026): /disputes /cases /returns /refunds = HTTP 403 (do NOT
// exist for sellers — disputes stay on the email parser). filter[status]=
// refunded + cancelled both WORK; orders carry refunds/cancellation/
// dispatches objects (now mirrored by the sync extension, fix #11).
// #13 (28 Jul 2026): singleOrder also dumps buyer/delivery_address inner KEY
// NAMES + phone-ish field paths — names only, never values.
// ---------------------------------------------------------------------------
exports.probeOnBuyData = onRequest(
  { secrets: ALL_SECRETS, timeoutSeconds: 120 },
  async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    const wanted = (req.query.account || 'samayy').toLowerCase();
    const account = ACCOUNTS.find(a => a.team === wanted || a.name.toLowerCase() === wanted);
    if (!account) return res.status(400).json({ error: 'account must be panacea or samayy' });
    const orderId = String(req.query.orderId || '');

    const report = { account: account.name, probes: {} };

    const probe = async (name, path) => {
      try {
        const token = await getOnBuyToken(account.consumerKey.value(), account.secretKey.value());
        const r = await fetch(`${ONBUY_BASE}${path}`, { headers: { Authorization: token } });
        const j = await r.json().catch(() => ({}));
        const list = j.results || j.data || null;
        report.probes[name] = {
          httpStatus: r.status,
          topLevelKeys: Object.keys(j).slice(0, 12),
          rowCount: Array.isArray(list) ? list.length : null,
          firstRowAllKeys: Array.isArray(list) && list[0] ? Object.keys(list[0]) : (j.order ? Object.keys(j.order) : []),
          metadata: j.metadata || null,
        };
        // For single-order probe: dump the whole order minus buyer PII
        if (name === 'singleOrder' && r.ok) {
          const o = j.order || (Array.isArray(list) && list[0]) || j;
          // #13: key NAMES only — which field really holds the phone?
          report.probes[name].buyerKeys = o.buyer ? Object.keys(o.buyer) : [];
          report.probes[name].deliveryAddressKeys = o.delivery_address ? Object.keys(o.delivery_address) : [];
          const phonePaths = [];
          const walk = (obj, path) => {
            if (!obj || typeof obj !== 'object') return;
            for (const [k, v] of Object.entries(obj)) {
              if (/phone|tel|mobile|contact/i.test(k)) phonePaths.push(`${path}${k}=${v ? '[has value]' : '[EMPTY]'}`);
              if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path + k + '.');
            }
          };
          walk(o, '');
          report.probes[name].phoneFieldsFound = phonePaths;
          const clean = {};
          for (const [k, v] of Object.entries(o)) {
            if (/name|address|phone|email|postcode|delivery/i.test(k)) { clean[k] = '[PII stripped]'; continue; }
            clean[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v).slice(0, 400) : v;
          }
          report.probes[name].fullOrder = clean;
        }
      } catch (e) {
        report.probes[name] = { error: e.message };
      }
    };

    // Candidate endpoints — OnBuy docs are a Postman collection; status codes tell the truth.
    await probe('refundedOrders', '/orders?site_id=2000&filter[status]=refunded&limit=2&offset=0');
    await probe('cancelledOrders', '/orders?site_id=2000&filter[status]=cancelled&sort[created]=desc&limit=2&offset=0');
    await probe('dispatchedOrders', '/orders?site_id=2000&filter[status]=dispatched&sort[created]=desc&limit=1&offset=0');
    await probe('disputesEndpoint', '/disputes?site_id=2000&limit=2&offset=0');
    await probe('casesEndpoint', '/cases?site_id=2000&limit=2&offset=0');
    await probe('returnsEndpoint', '/returns?site_id=2000&limit=2&offset=0');
    await probe('refundsEndpoint', '/refunds?site_id=2000&limit=2&offset=0');
    if (orderId) {
      await probe('singleOrder', `/orders/${encodeURIComponent(orderId)}?site_id=2000`);
    }

    res.json({ success: true, report });
  }
);

// ============================================================================
// INTENTIONALLY REMOVED (legacy — Firebase will offer to delete these, type Y):
//   migrateAll, migrateOrders, migrateListings (v1, one-time, already ran)
//   migrateData (open collection copier — security risk)
//   cleanupDuplicates (one-time, already ran 21 Jul)
//   testScrapingBee (debug tool, no longer needed)
//   getLiveDataV2 (reborn as the read-only getLiveData API above)
//   sendSignupCode, verifySignupCode (signup flow not in use)
//   pullOnBuyListingsHourly (replaced by paginated pullOnBuyListings above)
// ============================================================================
