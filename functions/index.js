/**
 * ============================================================================
 * ONLISTO â€” MASTER index.js (single source of truth)
 * ============================================================================
 * Rebuilt 23 Jul 2026 from: GitHub backup (40KB) + live Firebase function list
 * (21 functions) + dashboard HTML contract (onlisto.io).
 *
 * FIXES IN THIS FILE (mapped to the bug list):
 *  #1 node-fetch removed â€” Node 24 has fetch built in (was MODULE_NOT_FOUND)
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
 *     intentionally NOT in this file â€” they get deleted on deploy.
 *  #9 /orders IGNORES page=N (24 Jul 2026) â€” import + dispatch-sync passes
 *     now paginate with limit+offset like /listings.
 * #10 UNFILTERED /orders only returns AWAITING orders (24 Jul 2026, proven
 *     live: syncScanned == exact awaiting count). Dispatch-sync must query
 *     filter[status]=dispatched explicitly â€” this was the true root of the
 *     ghost-orders bug (dispatched on OnBuy, stuck 'active' on dashboard).
 *     Cancelled orders now flag needsAttention for human review.
 * #11 SYNC EXTENSION (26 Jul 2026, probe-proven): sync also pulls
 *     filter[status]=refunded (paginated) and mirrors OnBuy's raw refunds /
 *     cancellation / dispatches objects onto order docs (onbuyRefunds,
 *     onbuyCancellation, onbuyDispatches). Refunded orders flip status to
 *     'Refunded' one-way (statusSource: onbuy_sync). Feeds the dashboard's
 *     cancelled/refunded view + refund-rate KPI. NOTE: /disputes, /cases,
 *     /returns, /refunds endpoints do NOT exist for sellers (HTTP 403,
 *     probe-proven) â€” disputes stay on the email parser.
 * #12 getLiveData heartbeat now includes the Refunded count + hasBuyerPhone.
 * #12e RESOLUTION EMAILS (7 Aug 2026): duplicate emails now UPDATE the
 *     dispute — resolution emails close it (status Closed), every email is
 *     appended to emailHistory[], needsAttention set. Was: skip on duplicate,
 *     so all 8 disputes stayed Open forever. Applies to scheduledImapReader
 *     AND receiveDisputeEmail (messageId, ref+orderId, and orderId-only dedup).
 * #12f CHARGEBACK PARSER (7 Aug 2026): refs must contain a digit and not be
 *     a template word — was saving disputeRef "URGENT" and orderId "number".
 * #12g FALSE-CLOSE REPAIR (7 Aug 2026): v1 close-rule fired on "Resolution
 *     Assistance" (= OnBuy asking the SELLER for help) and threat boilerplate
 *     ("decision WILL BE final / MAY RESULT in a refund") — 5 false closes.
 *     Now: veto list first, strong past-tense only; threat text never saved
 *     as outcome; updateDisputeStatus can reopen (clears close stamp), edit
 *     type/outcome, and hardDelete junk docs.
 * #13 BUYER PHONE (28 Jul 2026): the 23 Jul rebuild guessed
 *     delivery_address.phone â€” wrong/empty, WhatsApp+call buttons vanished
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
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');


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
// API calls need the RAW token â€” a "Bearer " prefix gets HTTP 401.
// Path is /orders?site_id=2000 â€” /sites/2000/orders gets HTTP 404.
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
    res.status(503).json({ error: 'ADMIN_KEY is not set in functions/.env â€” add it and redeploy.' });
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
// delivery_address.phone â€” real field name unconfirmed, so check EVERY
// candidate in BOTH buyer and delivery_address. WhatsApp/call buttons on
// the dashboard only render when buyerPhone exists â€” empty field = buttons
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
// ORDERS â€” one shared import/sync path (scheduler + manual use the same code)
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
    // Never touch `status` â€” that field belongs to the VA/dashboard workflow.
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
    amount: 0,                    // sourcing cost â€” VA fills this in
    sourceOrderNo: '',
    sourceLink: '',
    notes: '',
    buyerName: addr.name || (o.buyer && o.buyer.name) || '',
    buyerPhone: extractBuyerPhone(o),
    buyerEmail: (o.buyer && o.buyer.email) || '',
    buyerAddress: [addr.line_1, addr.town].filter(Boolean).join(', '),
    buyerPostcode: addr.postcode || '',
    onbuyOrderDate: (o.date || o.created || '').slice(0, 10), // real OnBuy field: date
    status: 'active',             // VA workflow starts here â€” dashboard-owned
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
// Trap avoided: "Awaiting Dispatch" CONTAINS "dispatch" â€” exclude 'awaiting'.
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

  // Sync extension (26 Jul 2026, pipeline #9/#11 data feed â€” probe-proven
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
  // Cancelled on OnBuy â†’ flag for a human, never auto-change status.
  if (s.includes('cancel') && currentStatus !== 'Cancelled' && !ex.needsAttention) {
    updates.needsAttention = true;
    updates.attentionReason = `OnBuy shows: ${onbuyStatus}`;
  }

  // Refunded on OnBuy â†’ dashboard follows (one-way, same rule as dispatch).
  if (s.includes('refund') && currentStatus !== 'Refunded' && currentStatus !== 'Cancelled') {
    updates.status = 'Refunded';
    updates.statusSource = 'onbuy_sync';
    if (!ex.refundAt) updates.refundAt = now;
  }

  const alreadyHandled = currentStatus.toLowerCase() === 'dispatched' || currentStatus === 'Cancelled' || currentStatus === 'Refunded' || !!ex.onbuyRefunds || !!ex.onbuyCancellation;
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
// ---------------------------------------------------------------------------
// STALE-ACTIVE SWEEP (18 Aug 2026). The dispatched pass in pullOrdersForAccount
// only scans the newest 300 created orders, so an old order dispatched LATE on
// OnBuy falls outside that window and stays 'active' in the dashboard forever
// (live evidence: 25 active in Firestore vs 3 undispatched on OnBuy). Flip the
// direction: ask OUR db which orders are stuck 'active', then fetch each one
// directly from OnBuy by order number — ~25 calls instead of thousands.
// execute=false -> report only (refreshOrderStatuses dry-run stays read-only);
// execute=true  -> syncStatusFromOnBuy writes (dispatched/refunded/mirrors).
// Cancelled orders stay for human confirmation in the dashboard (reason
// capture), matching the never-auto-cancel rule.
// ---------------------------------------------------------------------------
async function sweepStaleActive(account, token, execute) {
  const r = { checked: 0, wouldDispatch: 0, wouldRefund: 0, awaitingHumanCancel: 0, stillAwaiting: 0, notFoundOnOnBuy: 0, errors: 0, sample: [] };
  const snap = await db.collection('orderTracker_orders').where('status', '==', 'active').limit(200).get();
  for (const d of snap.docs) {
    const ex = d.data();
    if (ex.account && ex.account !== account.name) continue;
    const oid = String(ex.onbuyOrderId || ex.orderNo || '');
    if (!oid) continue;
    r.checked++;
    try {
      const json = await onbuyGet(token, `/orders/${encodeURIComponent(oid)}?site_id=2000`);
      const o = json.order
        || (Array.isArray(json.results) ? json.results[0] : (json.results && typeof json.results === 'object' ? json.results : null))
        || (Array.isArray(json.data) && json.data[0])
        || null;
      if (!o) { r.notFoundOnOnBuy++; continue; }
      const s = String(o.status || '').toLowerCase();
      if (s.includes('awaiting')) { r.stillAwaiting++; continue; }
      if (s.includes('cancel')) { r.awaitingHumanCancel++; continue; }
      const saysDispatched = o.dispatched === true
        || ((s.includes('dispatch') || s.includes('shipped') || s.includes('complete')) && !s.includes('awaiting'));
      if (s.includes('refund')) r.wouldRefund++;
      else if (saysDispatched) r.wouldDispatch++;
      else continue;
      if (r.sample.length < 30) r.sample.push(`${oid} (active -> OnBuy: ${o.status || '?'})`);
      if (execute) {
        const res2 = await syncStatusFromOnBuy(account, o);
        if (res2 === 'dispatched' && (!(ex.amount > 0) || !ex.sourceLink)) {
          await d.ref.update({ needsSourcingInfo: true }); // flipped, but data still needed
        }
      }
    } catch (e) {
      r.errors++;
      logger.error(`stale-active sweep ${oid}: ${e.message}`);
    }
  }
  return r;
}


async function pullOrdersForAccount(account, fullRescan) {
  const token = await getOnBuyToken(account.consumerKey.value(), account.secretKey.value());

  // previously_exported=0 stops OnBuy re-sending orders we already pulled.
  // fullRescan mode drops that filter to rescue anything missed by a crash.
  const exportedFilter = fullRescan ? '' : '&filter[previously_exported]=0';
  const counts = { imported: 0, synced: 0, unchanged: 0, skipped: 0, dispatchedSynced: 0 };

  // OnBuy quirk #3 (PROVEN 24 Jul 2026): /orders IGNORES page=N â€” only
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
  // INVALID sort field (HTTP 400) â€” "created" is the valid one. Wrapped so a
  // failure here can never swallow the import results above.
  try {
    // BUG FIX 24 Jul 2026 (two parts):
    //  a) page=1&limit=100 â€” OnBuy ignores page=, only offset paginates.
    //  b) UNFILTERED /orders only returns AWAITING orders (proven live:
    //     syncScanned equalled the exact awaiting count). Dispatched orders
    //     NEVER appear there â€” must ask with filter[status]=dispatched.
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

    // Refunded orders (26 Jul 2026 â€” probe-proven filter): dashboard follows
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
  // Stale-active sweep: late-dispatched orders invisible to the 300-window above.
  try {
    counts.staleActive = await sweepStaleActive(account, token, true);
  } catch (e) {
    logger.error(`stale-active sweep failed (${account.name}): ${e.message}`);
    counts.staleActiveError = e.message;
  }
  return counts;
}

// SCHEDULED â€” every 15 minutes, both accounts
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

// MANUAL â€” same code path, run from browser. ?key=...&account=panacea&full=1
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
// LISTINGS â€” Bug #6 fix: full pagination + change detection (saves money)
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
  // winning_status / lead_listing_price DO NOT EXIST here â€” Buy Box data
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
        onbuyUrl: l.product_url || '',  // probe-proven 8 Aug 2026: direct public OnBuy page URL
        onbuyProductId: l.product_encoded_id || '',  // fallback ID for public page links
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
// REPRICER â€” user decision 23 Jul 2026: KEEP LIVE (pushes real OnBuy prices).
// Floor = (last logged cost Ã— (1 + margin%)) Ã· (1 âˆ’ real fee rate).
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
        logger.error(`${accountName}: reprice push failed â€” ${e.message}`);
      }
    }
  }
);

// ---------------------------------------------------------------------------
// DISPATCH PUSH â€” VA adds tracking on dashboard â†’ send it to OnBuy instantly
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
// FIX STALE ORDERS (rewritten â€” old source was lost)
// Dry-run by default. Add &execute=true to actually write.
// Usage: /fixStaleOrders?key=...&days=14            â†’ shows what WOULD change
//        /fixStaleOrders?key=...&days=14&execute=true â†’ marks them Dispatched
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
        message: 'DRY RUN â€” add &execute=true to the URL to actually mark these as Dispatched.',
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
// GET LIVE DATA (read-only) â€” the closed-loop debugging API.
// Lets an AI assistant read LIVE Firestore to compare what the CODE says
// vs what the DATA actually shows. Own READONLY_KEY: can read, never write.
// Buyer contact details (email/phone/address/postcode) are always stripped.
//
//   /getLiveData?key=...                          â†’ system heartbeat (counts)
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
    res.status(503).json({ error: 'READONLY_KEY is not set in functions/.env â€” add it and redeploy.' });
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

    // default: overview heartbeat â€” cheap aggregation counts
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
// TEST ONBUY AUTH â€” one browser visit settles Bug #4 with evidence.
// Usage: /testOnBuyAuth?key=...&account=panacea   (or samayy)
// Returns which auth style worked + the real response shape of /orders.
// No secrets are ever returned â€” only success/failure and field names.
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
    // settled every orders question â€” no guessing, dump what OnBuy sends)
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
// SCRAPINGBEE â€” price checking (key-protected now, Bug #7)
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
    const match = text.match(/Â£?\s*([\d,]+\.?\d{0,2})/);
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
    /class="a-offscreen"[^>]*>Â£?([\d,.]+)/,
    /"priceAmount":\s*([\d.]+)/,
    /"price":"Â£?([\d,.]+)"/,
    /data-price="([\d,.]+)"/,
    /Â£([\d,.]+)/,
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

// VA manual entry â€” zero Bee cost.
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

// BULK IMPORT — sourcing cost + buying link + supplier order no from the P&L sheet.
// Up to 50 rows per call. Order match: onbuyOrderId. Listing match: opc (single-field query).
// Never clobbers a VA-entered cost/link or a manually-checked listing price.
exports.importOrderCosts = onRequest({ cors: true, timeoutSeconds: 300 }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (!checkAdminKey(req, res)) return;

  const rows = (req.body && req.body.rows) || [];
  const dryRun = !!(req.body && req.body.dryRun);
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'Send rows: [{ orderNo, unitCost, totalCost, link, supplierOrderNo }] (max 50)' });
  }
  if (rows.length > 50) return res.status(400).json({ error: 'Max 50 rows per call — batch them.' });

  const detectPlatform = (url) => {
    const u = String(url || '').toLowerCase();
    if (u.includes('amazon.')) return 'Amazon';
    if (u.includes('ebay.')) return 'eBay';
    if (u.includes('aliexpress.')) return 'AliExpress';
    return u ? 'Other' : '';
  };

  const results = [];
  let ordersUpdated = 0, listingsUpdated = 0, ordersMissing = 0, skipped = 0;

  for (const row of rows) {
    const orderNo = String(row.orderNo || '').trim().toUpperCase();
    const unitCost = Number(row.unitCost) || 0;
    const totalCost = Number(row.totalCost) || unitCost;
    const link = String(row.link || '').trim();
    const supplierOrderNo = String(row.supplierOrderNo || '').trim();
    if (!orderNo || (totalCost <= 0 && !link)) { skipped++; results.push({ orderNo, result: 'skipped-empty' }); continue; }

    try {
      const snap = await db.collection('orderTracker_orders').where('onbuyOrderId', '==', orderNo).limit(1).get();
      if (snap.empty) { ordersMissing++; results.push({ orderNo, result: 'order-not-in-system' }); continue; }
      const orderDoc = snap.docs[0];
      const o = orderDoc.data();

      if (!dryRun) {
        const orderUpdate = {};
        if (totalCost > 0 && !(Number(o.amount) > 0)) orderUpdate.amount = totalCost;  // keep any VA-entered cost
        if (link && !o.sourceLink) { orderUpdate.sourceLink = link; orderUpdate.sourcePlatform = detectPlatform(link); }
        if (supplierOrderNo && !o.sourceOrderNo) orderUpdate.sourceOrderNo = supplierOrderNo;
        if (o.needsSourcingInfo) orderUpdate.needsSourcingInfo = false;
        if (Object.keys(orderUpdate).length) {
          orderUpdate.costImportedAt = admin.firestore.FieldValue.serverTimestamp();
          await orderDoc.ref.set(orderUpdate, { merge: true });
        }
      }
      ordersUpdated++;

      // Chain to the listing via the order's OPC (single-field query — no composite index)
      let listingResult = 'no-opc-on-order';
      if (o.opc) {
        const lsnap = await db.collection('orderTracker_listings').where('opc', '==', o.opc).limit(3).get();
        const ldoc = lsnap.docs.find(d => (d.data().team || '') === o.team) || lsnap.docs[0];
        if (ldoc) {
          const l = ldoc.data();
          const mayOverwrite = !l.sourcePrice || l.sourceCheckMethod === 'import';
          if (mayOverwrite && unitCost > 0 && !dryRun) {
            await ldoc.ref.set({
              sourcePrice: unitCost,
              ...(link ? { sourceUrl: link } : {}),
              sourceCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
              sourceCheckedBy: 'import',
              sourceCheckMethod: 'import',
              checkTier: 'B',
              consecutiveNoChange: 0,
            }, { merge: true });
            listingsUpdated++;
            listingResult = 'listing-updated';
          } else {
            listingResult = mayOverwrite ? 'listing-dryrun' : 'listing-kept-fresher-data';
          }
        } else listingResult = 'listing-not-found';
      }
      results.push({ orderNo, result: 'ok', listing: listingResult });
    } catch (e) {
      results.push({ orderNo, result: 'error: ' + e.message });
    }
  }

  logger.info(`importOrderCosts: ${ordersUpdated} orders, ${listingsUpdated} listings, ${ordersMissing} missing, ${skipped} skipped`);
  res.json({ success: true, dryRun, ordersUpdated, listingsUpdated, ordersMissing, skipped, results });
});

// VA adds/updates a listing's source URL â€” scheduled checker picks it up.
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
// TIER SYSTEM â€” hot listings checked often, dead ones rarely (saves Bee money)
// A: 6h Â· B: 24h Â· C: 72h Â· D: 168h (1 week)
// Price change â†’ move UP a tier. No change â†’ drift DOWN after threshold.
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

// SCHEDULED â€” hourly. 1 Bee call per due listing. History only on price change
// (keeps docs small â€” old version logged every check forever).
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
            // History entries ONLY when the price moved â€” bounded doc growth.
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
            logger.info(`${listing._docId}: Â£${extracted.price} (Tier ${t.newTier})`);
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
// PROBE ONBUY DATA (pipeline #10, 25 Jul 2026) â€” evidence dump, no guessing.
// Answers: does the API expose disputes? refunds? what does a FULL single
// order contain (all fields)? what do cancelled/dispatched orders carry?
//   /probeOnBuyData?key=...&account=samayy&orderId=T6MD55X
// Read-only. Returns field names + tiny samples â€” never secrets, never PII.
// RESULT (26 Jul 2026): /disputes /cases /returns /refunds = HTTP 403 (do NOT
// exist for sellers â€” disputes stay on the email parser). filter[status]=
// refunded + cancelled both WORK; orders carry refunds/cancellation/
// dispatches objects (now mirrored by the sync extension, fix #11).
// #13 (28 Jul 2026): singleOrder also dumps buyer/delivery_address inner KEY
// NAMES + phone-ish field paths â€” names only, never values.
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
          // #13: key NAMES only â€” which field really holds the phone?
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

    // Candidate endpoints â€” OnBuy docs are a Postman collection; status codes tell the truth.
    await probe('listingRaw', '/listings?site_id=2000&country_code=GB&limit=1&offset=0');
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
// INTENTIONALLY REMOVED (legacy â€” Firebase will offer to delete these, type Y):
//   migrateAll, migrateOrders, migrateListings (v1, one-time, already ran)
//   migrateData (open collection copier â€” security risk)
//   cleanupDuplicates (one-time, already ran 21 Jul)
//   testScrapingBee (debug tool, no longer needed)
//   getLiveDataV2 (reborn as the read-only getLiveData API above)
//   sendSignupCode, verifySignupCode (signup flow not in use)
//   pullOnBuyListingsHourly (replaced by paginated pullOnBuyListings above)

// ============================================================================
// DISPUTE EMAIL PARSER â€” receives forwarded OnBuy dispute emails
// ============================================================================

// Helper: parse OnBuy dispute email body into structured data
function parseDisputeEmail(subject, text, html, messageId) {
  const body = text || html || '';
  const result = {
    disputeRef: '',
    orderId: '',
    type: '',
    reason: '',
    outcome: '',
    deadline: '',
    status: 'Open',
    receivedAt: new Date().toISOString(),
    rawSubject: subject || '',
    rawBody: body.slice(0, 8000),
    messageId: messageId || '',
  };

  // Extract dispute reference — #12f: labelled patterns in the body first,
  // then any ref-shaped token in the subject. Every candidate validated.
  result.disputeRef = findValidRef(body, [
    /Reference[:\s#]+([A-Za-z0-9]{6,10})/i,
    /dispute\s*ref[:\s#]+([A-Za-z0-9]{6,10})/i,
    /\bref[:\s#]+([A-Za-z0-9]{6,10})/i,
  ]) || findValidRef(subject, [/([A-Za-z0-9]{6,8})/]);

  // Extract order ID — try multiple patterns
  // #12f: most-specific patterns FIRST (the old generic /Order\s*#?\s*/
  // grabbed the word "number" out of "Order number: T6MQ6NM"). findValidRef
  // rejects template words and keeps scanning the rest of the match list.
  const orderPatterns = [
    /order\s+number[:\s#]+([A-Za-z0-9]{6,10})/i,
    /order[_\s]id[:\s#]+([A-Za-z0-9]{6,10})/i,
    /order\s+ref[:\s#]+([A-Za-z0-9]{6,10})/i,
    /your OnBuy order\s+([A-Za-z0-9]{6,10})/i,
    /OnBuy order\s+([A-Za-z0-9]{6,10})/i,
    /Order\s*#\s*([A-Za-z0-9]{6,10})/,
    /Order[:\s]+([A-Za-z0-9]{6,10})/,
  ];
  result.orderId = findValidRef(body, orderPatterns)
                || findValidRef(subject, [/Order[:\s]+([A-Za-z0-9]{6,10})/])
                || findValidRef(subject, [/([A-Za-z0-9]{6,8})/]);

  // Extract TYPE from subject first
  const subjectTypePatterns = [
    /Customer\s+Escalation/i,
    /Chargeback/i,
    /Refund/i,
    /Return/i,
    /Dispute/i,
    /Not\s+Received/i,
    /Not\s+As\s+Described/i,
    /Damaged/i,
    /Wrong\s+Item/i,
  ];
  let typeFound = false;
  for (const p of subjectTypePatterns) {
    const m = subject.match(p);
    if (m) {
      let t = m[0].replace(/Customer\s+/i, '').trim();
      result.type = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
      typeFound = true;
      break;
    }
  }

  if (!typeFound) {
    const bodyTypePatterns = [
      /type\s*[:\s]+(escalation|chargeback|refund|return|dispute|not received|not as described|damaged|wrong item)/i,
      /issue\s*type\s*[:\s]+(escalation|chargeback|refund|return|dispute|not received|not as described|damaged|wrong item)/i,
    ];
    for (const p of bodyTypePatterns) {
      const m = body.match(p);
      if (m) {
        result.type = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
        typeFound = true;
        break;
      }
    }
  }

  if (!typeFound) {
    if (/escalation/i.test(body)) result.type = 'Escalation';
    else if (/chargeback/i.test(body)) result.type = 'Chargeback';
    else if (/refund\s*(was\s*provided|issued|being\s*issued|to\s*the\s*customer)/i.test(body)) result.type = 'Refund';
    else if (/return/i.test(body)) result.type = 'Return';
    else if (/not\s*received/i.test(body)) result.type = 'Not Received';
    else if (/not\s*as\s*described|faulty|damaged/i.test(body)) result.type = 'Not As Described';
    else if (/wrong\s*item/i.test(body)) result.type = 'Wrong Item';
    else result.type = 'Other';
  }

  // Extract REASON — look for explicit reason field, then buyer complaint
  const reasonPatterns = [
    /(?:Reason|Issue|Complaint|Problem)[:\s]+(.+?)(?=\n|\.(?:\s|$)|Our team|Thank you|Kind regards|If you|Please)/i,
    /The buyer has advised that\s+(.+?)(?=\n|\.(?:\s|$)|Our team|Thank you|Kind regards|If you|Please)/i,
    /customer claims?[:\s]+(.+?)(?=\n|\.(?:\s|$)|Our team|Thank you|Kind regards|If you|Please)/i,
    /buyer states that\s+(.+?)(?=\n|\.(?:\s|$)|Our team|Thank you|Kind regards|If you|Please)/i,
    /buyer has reported that\s+(.+?)(?=\n|\.(?:\s|$)|Our team|Thank you|Kind regards|If you|Please)/i,
    /regarding your order.*?[:\s]+(.+?)(?=\n|\.(?:\s|$)|Our team|Thank you|Kind regards|If you|Please)/i,
  ];
  for (const p of reasonPatterns) {
    const m = body.match(p);
    if (m) {
      const candidate = m[1].trim().replace(/\s+/g, ' ').slice(0, 300);
      // Reject pure boilerplate
      const boilerplate = /^\s*(?:refund to the customer|decision made by|we will issue|full refund|contact us|reply to this)\s*$/i;
      if (!boilerplate.test(candidate)) { result.reason = candidate; break; }
    }
  }

  // If still no reason, use the first meaningful sentence after the order ID
  if (!result.reason) {
    const meaningful = body.match(/(?:order|dispute|issue|concern)[:\s]+[A-Z0-9]{6,10}[.\s]+(.+?)(?=\n|Thank you|Kind regards|Our team|If you|Please)/i);
    if (meaningful) {
      const candidate = meaningful[1].trim().replace(/\s+/g, ' ').slice(0, 300);
      const boilerplate = /^\s*(?:refund to the customer|decision made by|we will issue|full refund|contact us|reply to this)\s*$/i;
      if (!boilerplate.test(candidate)) result.reason = candidate;
    }
  }

  // If still no reason, look for any sentence containing "buyer" + complaint verb
  if (!result.reason) {
    const buyerComplaint = body.match(/buyer\s+(?:has\s+)?(?:advised|reported|claimed|said|states|complained)\s+(?:that\s+)?(.+?)(?=\n|\.(?:\s|$)|Our team|Thank you|Kind regards)/i);
    if (buyerComplaint) {
      result.reason = buyerComplaint[1].trim().replace(/\s+/g, ' ').slice(0, 300);
    }
  }

  // Extract OUTCOME — #12g: future-tense threat patterns removed (they
  // describe what OnBuy MIGHT do, not what it DID). Labelled extraction now
  // requires a colon, and veto-listed candidates are discarded below.
  const outcomePatterns = [
    /(?:outcome|decision|resolution)\s*:\s*(.+?)(?=\n|\.(?:\s|$)|Thank you|Kind regards)/i,
    /dispute is now closed as\s+(.+?)(?=\n|\.(?:\s|$)|Thank you|Kind regards)/i,
    /Refund was provided to the customer on\s+(.+?)(?=\n|\.(?:\s|$)|Thank you|Kind regards)/i,
    /refund has been issued to the buyer/i,
  ];
  for (const p of outcomePatterns) {
    const m = body.match(p);
    if (m) {
      const cand = m[1] ? m[1].trim().replace(/\s+/g, ' ').slice(0, 300) : m[0].trim().replace(/\s+/g, ' ').slice(0, 300);
      if (RESOLUTION_VETO.test(cand)) continue; // threat boilerplate, not an outcome
      result.outcome = cand;
      break;
    }
  }

  // Extract deadline
  const deadlinePatterns = [
    /respond by[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /deadline[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /by[:\s]+(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i,
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}).{0,30}deadline/i,
    /(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i,
  ];
  for (const p of deadlinePatterns) {
    const m = body.match(p);
    if (m) { result.deadline = m[1]; break; }
  }

  return result;
}

// #12f (7 Aug 2026): chargeback emails produced disputeRef "URGENT" and
// orderId "number" — the extraction regexes grabbed TEMPLATE WORDS because
// /i made [A-Z0-9] match lowercase dictionary words. Every candidate must
// now look like a real OnBuy reference: alnum, CONTAINS A DIGIT, and not a
// known template word.
const REF_STOPWORDS = new Set(['URGENT', 'NUMBER', 'DISPUTE', 'CHARGEBACK', 'ORDER', 'ACTION',
  'REQUIRED', 'RESPONSE', 'REFUND', 'RETURN', 'CLOSED', 'OPENED', 'UPDATE', 'ESCALATION',
  'CASEID', 'TICKET', 'SUPPORT', 'CUSTOM', 'REVIEW', 'NOTICE', 'SELLER']);
function looksLikeOnBuyRef(s) {
  const v = String(s || '').toUpperCase();
  if (v.length < 6 || v.length > 10) return false;
  if (!/^[A-Z0-9]+$/.test(v)) return false;
  if (!/\d/.test(v)) return false; // real OnBuy refs always contain a digit
  if (REF_STOPWORDS.has(v)) return false;
  return true;
}
function findValidRef(text, patterns) {
  const t = String(text || '');
  for (const p of patterns) {
    const flags = p.flags.includes('g') ? p.flags : p.flags + 'g';
    const re = new RegExp(p.source, flags);
    let m;
    while ((m = re.exec(t)) !== null) {
      if (looksLikeOnBuyRef(m[1])) return m[1].toUpperCase();
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// #12e (7 Aug 2026): resolution emails must UPDATE the existing dispute,
// not be skipped as duplicates. OnBuy sends "refund provided / dispute
// closed" follow-ups; before this fix they vanished and every dispute
// stayed Open forever (8/8 Open on the dashboard).
// ---------------------------------------------------------------------------
// #12g (7 Aug 2026): false-close fix. V1 closed disputes on the word
// "Resolution" ("Resolution Assistance" = OnBuy asking the SELLER for help)
// and on threat boilerplate ("a decision WILL BE final and MAY RESULT in a
// refund") which appears in every OPENING escalation email. Now: veto list
// first, then strong past-tense signals only.
const RESOLUTION_VETO = /will be final|may result in|will issue|will be made|being issued|assistance|need your help|action required|respond by/i;
const RESOLUTION_STRONG = /dispute\s+([A-Z0-9]{5,12}\s+)?(is\s+)?(now\s+)?closed|case\s+([A-Z0-9]{5,12}\s+)?(is\s+)?(now\s+)?closed|dispute\s+([A-Z0-9]{5,12}\s+)?(has\s+been\s+)?resolved|has\s+been\s+resolved|refund\s+was\s+provided|refund\s+has\s+been\s+issued|refund\s+issued|refund\s+completed|decision\s+has\s+been\s+made|closed\s+in\s+(your|the)\s+favo[u]?r/i;
function isResolutionEmail(d, subject) {
  const s = String(subject || '');
  if (RESOLUTION_VETO.test(s)) return false;
  if (RESOLUTION_STRONG.test(s)) return true;
  const o = String(d.outcome || '');
  if (o && !RESOLUTION_VETO.test(o) && RESOLUTION_STRONG.test(o)) return true;
  return false;
}

// Returns 'closed' | 'updated' | 'already-recorded'.
async function applyEmailToExistingDispute(docSnap, d, subject) {
  const ex = docSnap.data();
  const mid = d.messageId || '';
  const hist = Array.isArray(ex.emailHistory) ? ex.emailHistory : [];
  if (mid && hist.some(h => h && h.messageId === mid)) return 'already-recorded';

  const entry = {
    receivedAt: new Date().toISOString(),
    subject: subject || '',
    messageId: mid,
    type: d.type || '',
    outcome: d.outcome || '',
  };
  const updates = {
    emailHistory: admin.firestore.FieldValue.arrayUnion(entry),
    lastEmailAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    needsAttention: true,
  };
  // Fill gaps on older docs, never overwrite good data with blanks.
  if (!ex.type && d.type) updates.type = d.type;
  if (!ex.outcome && d.outcome) updates.outcome = d.outcome;
  if (!ex.rawBody && d.rawBody) { updates.rawBody = d.rawBody; updates.rawSubject = subject || ''; }
  // A resolution email closes an Open dispute (one-way — a human can reopen).
  if (isResolutionEmail(d, subject) && String(ex.status || 'Open') === 'Open') {
    updates.status = 'Closed';
    updates.closedAt = admin.firestore.FieldValue.serverTimestamp();
    updates.closedBy = 'email_pipeline';
    if (d.outcome) updates.outcome = d.outcome;
  }
  await docSnap.ref.update(updates);
  return updates.status === 'Closed' ? 'closed' : 'updated';
}

// HTTP endpoint: receive dispute email (SendGrid Inbound Parse or direct POST)
exports.receiveDisputeEmail = onRequest(
  { cors: true, timeoutSeconds: 60, memory: '256MiB' },
  async (req, res) => {
    try {
      const { subject, text, html, from, to, messageId } = req.body || {};
      const parsed = parseDisputeEmail(subject, text, html, messageId);

      // Dedup by messageId — #12e: UPDATE instead of skipping (resolution
      // emails close the dispute + append to emailHistory).
      if (parsed.messageId) {
        const existing = await db.collection('orderTracker_disputes')
          .where('messageId', '==', parsed.messageId).limit(1).get();
        if (!existing.empty) {
          const r = await applyEmailToExistingDispute(existing.docs[0], parsed, subject);
          logger.info(`Dispute known message ${parsed.messageId} -> ${existing.docs[0].id} ${r}`);
          return res.json({ success: true, duplicate: true, action: r, disputeId: existing.docs[0].id });
        }
      }

      // Secondary dedup: same dispute, NEW email (the resolution-email case)
      if (parsed.disputeRef && parsed.orderId) {
        const existing2 = await db.collection('orderTracker_disputes')
          .where('disputeRef', '==', parsed.disputeRef)
          .where('orderId', '==', parsed.orderId)
          .limit(1).get();
        if (!existing2.empty) {
          const r = await applyEmailToExistingDispute(existing2.docs[0], parsed, subject);
          logger.info(`Dispute known ref ${parsed.disputeRef} / ${parsed.orderId} -> ${r}`);
          return res.json({ success: true, duplicate: true, action: r, disputeId: existing2.docs[0].id });
        }
      }

      // Tertiary dedup: orderId only (ref-less chargeback follow-ups)
      if (!parsed.disputeRef && parsed.orderId) {
        const existing3 = await db.collection('orderTracker_disputes')
          .where('orderId', '==', parsed.orderId)
          .limit(1).get();
        if (!existing3.empty) {
          const r = await applyEmailToExistingDispute(existing3.docs[0], parsed, subject);
          logger.info(`Dispute known order ${parsed.orderId} (no ref) -> ${r}`);
          return res.json({ success: true, duplicate: true, action: r, disputeId: existing3.docs[0].id });
        }
      }
      // #12f: refuse junk docs with no usable reference at all
      if (!parsed.disputeRef && !parsed.orderId) {
        logger.warn(`receiveDisputeEmail: unparsable email (no ref/orderId). Subject: ${subject || ''}`);
        return res.json({ success: false, error: 'Could not extract dispute reference or order ID — not saved.', rawSubject: subject || '' });
      }

      // Determine which client/account this belongs to
      let team = '';
      let account = '';
      let clientEmail = '';
      const fromStr = String(from || '').toLowerCase();
      const toStr = String(to || '').toLowerCase();

      if (toStr.includes('panacea') || toStr.includes('slidaro')) {
        team = 'panacea'; account = 'Panacea'; clientEmail = 'slidaro@onlisto.io';
      } else if (toStr.includes('samay') || toStr.includes('samayy')) {
        team = 'samayy'; account = 'Samayy'; clientEmail = 'samay@onlisto.io';
      } else {
        // fallback: look up client by replyFromEmail in orderTracker_clients
        team = 'unknown'; account = 'Unknown';
      }

      // Look up order to link dispute
      let orderDoc = null;
      if (parsed.orderId) {
        const orderSnap = await db.collection('orderTracker_orders')
          .where('onbuyOrderId', '==', parsed.orderId)
          .limit(1).get();
        if (!orderSnap.empty) orderDoc = orderSnap.docs[0];
      }

      const disputeId = parsed.disputeRef || `dispute_${Date.now()}`;
      const docRef = db.collection('orderTracker_disputes').doc(disputeId);

      await docRef.set({
        orgId: ORG_ID,
        team,
        account,
        clientEmail,
        disputeRef: parsed.disputeRef,
        orderId: parsed.orderId,
        orderDocId: orderDoc ? orderDoc.id : '',
        type: parsed.type || '',
        reason: parsed.reason,
        outcome: parsed.outcome || '',
        deadline: parsed.deadline,
        status: 'Open',
        priority: 'medium',
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        rawSubject: parsed.rawSubject,
        rawBody: parsed.rawBody,
        messageId: parsed.messageId || '',
        emailHistory: [{
          receivedAt: new Date().toISOString(),
          subject: subject || '',
          messageId: parsed.messageId || '',
          type: parsed.type || '',
          outcome: parsed.outcome || '',
        }],
        replyDraft: '',
        replySent: false,
        replySentAt: null,
        notes: '',
        assignedTo: '',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      logger.info(`Dispute saved: ${disputeId} for ${account} (order: ${parsed.orderId || 'unknown'})`);
      res.json({ success: true, disputeId, parsed });
    } catch (e) {
      logger.error(`receiveDisputeEmail error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  }
);

// Test endpoint: parse a dispute email without saving
exports.testDisputeParse = onRequest(
  { cors: true, timeoutSeconds: 30 },
  async (req, res) => {
    try {
      const { subject, text, html } = req.body || {};
      if (!subject && !text && !html) {
        return res.status(400).json({
          error: 'Missing subject/text/html',
          example: { subject: 'Dispute T6K27YN', text: 'Order #T6K27YN... Reason: Item not received' }
        });
      }
      const parsed = parseDisputeEmail(subject, text, html);
      res.json({ success: true, parsed });
    } catch (e) {
      logger.error(`testDisputeParse error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  }
);

// Get disputes for dashboard (Admin sees all, VA sees their team only)
exports.getDisputes = onRequest(
  { cors: true, timeoutSeconds: 60 },
  async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    try {
      const team = req.query.team || '';
      const status = req.query.status || '';
      const limit = Math.min(Number(req.query.limit || 50), 100);

      let q = db.collection('orderTracker_disputes').orderBy('receivedAt', 'desc');
      if (team) q = q.where('team', '==', team);
      if (status) q = q.where('status', '==', status);

      const snap = await q.limit(limit).get();
      const docs = snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          disputeRef: data.disputeRef || d.id,
          orderId: data.orderId || '',
          team: data.team || '',
          account: data.account || '',
          type: data.type || '',
          reason: data.reason || '',
          outcome: data.outcome || '',
          status: data.status || 'Open',
          priority: data.priority || 'medium',
          deadline: data.deadline || '',
          receivedAt: data.receivedAt && data.receivedAt.toDate ? data.receivedAt.toDate().toISOString() : null,
          replySent: !!data.replySent,
          assignedTo: data.assignedTo || '',
          notes: data.notes || '',
          rawBody: data.rawBody || '',
          rawSubject: data.rawSubject || '',
          messageId: data.messageId || '',
          needsAttention: !!data.needsAttention,
          emailHistory: (Array.isArray(data.emailHistory) ? data.emailHistory : []).slice(-10),
        };
      });
      res.json({ success: true, count: docs.length, disputes: docs });
    } catch (e) {
      logger.error(`getDisputes error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  }
);

// Update dispute status / notes / assignment (dashboard action)
exports.updateDisputeStatus = onRequest(
  { cors: true, timeoutSeconds: 30 },
  async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    try {
      const { disputeId, status, notes, assignedTo, priority, replyDraft, type, outcome, hardDelete } = req.body || {};
      if (!disputeId) return res.status(400).json({ error: 'Missing disputeId' });

      // #12g: hard delete for junk docs left by the old parser bug
      if (hardDelete === true) {
        await db.collection('orderTracker_disputes').doc(disputeId).delete();
        logger.info(`Dispute hard-deleted: ${disputeId}`);
        return res.json({ success: true, deleted: disputeId });
      }

      const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (status !== undefined) {
        updates.status = status;
        // #12g: reopening clears the auto-close stamp, or the dashboard
        // keeps showing stale closedAt/closedBy forever.
        if (status !== 'Closed') {
          updates.closedAt = admin.firestore.FieldValue.delete();
          updates.closedBy = admin.firestore.FieldValue.delete();
        }
      }
      if (notes !== undefined) updates.notes = notes;
      if (assignedTo !== undefined) updates.assignedTo = assignedTo;
      if (priority !== undefined) updates.priority = priority;
      if (replyDraft !== undefined) updates.replyDraft = replyDraft;
      if (type !== undefined) updates.type = type;
      if (outcome !== undefined) updates.outcome = outcome;

      await db.collection('orderTracker_disputes').doc(disputeId).update(updates);
      res.json({ success: true, disputeId, updates: Object.keys(updates) });
    } catch (e) {
      logger.error(`updateDisputeStatus error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  }
);

// ============================================================================
// IMAP DISPUTE READER â€” polls dispute@onlisto.io every 15 min
// ============================================================================

function openImapBox(imap, boxName) {
  return new Promise((resolve, reject) => {
    imap.openBox(boxName, false, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

function searchImap(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => {
      if (err) reject(err);
      else resolve(results || []);
    });
  });
}

function fetchImapMessages(imap, results, fetchOptions) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    if (!results.length) { resolve([]); return; }
    const f = imap.fetch(results, fetchOptions);
    f.on('message', (msg, seqno) => {
      let buf = Buffer.alloc(0);
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); });
      });
      msg.once('end', () => { msgs.push(buf); });
    });
    f.once('error', (err) => reject(err));
    f.once('end', () => resolve(msgs));
  });
}

async function readDisputeEmailsViaImap() {
  const host = process.env.IMAP_HOST || 'mail.onlisto.io';
  const port = Number(process.env.IMAP_PORT || 993);
  const user = 'dispute@onlisto.io';
  const password = process.env.DISPUTE_EMAIL_PASSWORD || '';

  if (!password) {
    logger.error('DISPUTE_EMAIL_PASSWORD not set in .env');
    return { error: 'DISPUTE_EMAIL_PASSWORD not set' };
  }

  const imap = new Imap({ host, port, user, password, tls: true, tlsOptions: { rejectUnauthorized: false } });

  await new Promise((resolve, reject) => {
    imap.once('ready', resolve);
    imap.once('error', reject);
    imap.connect();
  });

  try {
    await openImapBox(imap, 'INBOX');
    // Search emails from OnBuy support received in last 7 days (catches SEEN too)
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 7);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const sinceStr = `${String(sinceDate.getDate()).padStart(2,'0')}-${months[sinceDate.getMonth()]}-${sinceDate.getFullYear()}`;
    const results = await searchImap(imap, [['SINCE', sinceStr], ['FROM', 'customersupport-gb@onbuy.com']]);
    logger.info(`IMAP: ${results.length} unseen OnBuy dispute emails found`);

    if (!results.length) {
      imap.end();
      return { processed: 0, found: 0 };
    }

    const msgs = await fetchImapMessages(imap, results, { bodies: '', markSeen: true });
    let processed = 0;
    let updatedCount = 0;
    let skippedUnparsable = 0;

    for (const buf of msgs) {
      try {
        const parsed = await simpleParser(buf);
        const disputeData = parseDisputeEmail(parsed.subject, parsed.text, parsed.html, parsed.messageId);

        // Dedup by messageId — #12e: UPDATE the existing dispute (resolution
        // emails close it + append emailHistory) instead of skipping.
        if (disputeData.messageId) {
          const existing = await db.collection('orderTracker_disputes')
            .where('messageId', '==', disputeData.messageId).limit(1).get();
          if (!existing.empty) {
            const r = await applyEmailToExistingDispute(existing.docs[0], disputeData, parsed.subject);
            if (r !== 'already-recorded') updatedCount++;
            logger.info(`IMAP: known message ${disputeData.messageId} -> ${existing.docs[0].id} ${r}`);
            continue;
          }
        }
        // Secondary dedup: same dispute, NEW email (the resolution-email case)
        if (disputeData.disputeRef && disputeData.orderId) {
          const existing2 = await db.collection('orderTracker_disputes')
            .where('disputeRef', '==', disputeData.disputeRef)
            .where('orderId', '==', disputeData.orderId)
            .limit(1).get();
          if (!existing2.empty) {
            const r = await applyEmailToExistingDispute(existing2.docs[0], disputeData, parsed.subject);
            if (r !== 'already-recorded') updatedCount++;
            logger.info(`IMAP: known dispute ${disputeData.disputeRef} / ${disputeData.orderId} -> ${r}`);
            continue;
          }
        }
        // Tertiary dedup: orderId only (chargeback emails often carry no
        // dispute ref — without this, every follow-up created a NEW doc).
        if (!disputeData.disputeRef && disputeData.orderId) {
          const existing3 = await db.collection('orderTracker_disputes')
            .where('orderId', '==', disputeData.orderId)
            .limit(1).get();
          if (!existing3.empty) {
            const r = await applyEmailToExistingDispute(existing3.docs[0], disputeData, parsed.subject);
            if (r !== 'already-recorded') updatedCount++;
            logger.info(`IMAP: known order ${disputeData.orderId} (no ref) -> ${r}`);
            continue;
          }
        }
        // #12f: refuse junk docs — no usable reference means unparsable email
        // (log it instead of creating another "URGENT"/"number" dispute).
        if (!disputeData.disputeRef && !disputeData.orderId) {
          skippedUnparsable++;
          logger.warn(`IMAP: skipping unparsable email (no ref/orderId). Subject: ${parsed.subject || ''}`);
          continue;
        }

        // Determine team/client from To header or fallback
        let team = '';
        let account = '';
        let clientEmail = '';
        const toHeader = String(parsed.to && parsed.to.text || '').toLowerCase();
        if (toHeader.includes('panacea') || toHeader.includes('slidaro')) {
          team = 'panacea'; account = 'Panacea'; clientEmail = 'slidaro@onlisto.io';
        } else if (toHeader.includes('samay') || toHeader.includes('samayy')) {
          team = 'samayy'; account = 'Samayy'; clientEmail = 'samay@onlisto.io';
        } else {
          team = 'unknown'; account = 'Unknown';
        }

        // Link to order if possible
        let orderDoc = null;
        if (disputeData.orderId) {
          const orderSnap = await db.collection('orderTracker_orders')
            .where('onbuyOrderId', '==', disputeData.orderId)
            .limit(1).get();
          if (!orderSnap.empty) orderDoc = orderSnap.docs[0];
        }

        const disputeId = disputeData.disputeRef || `dispute_${Date.now()}_${processed}`;
        await db.collection('orderTracker_disputes').doc(disputeId).set({
          orgId: ORG_ID,
          team,
          account,
          clientEmail,
          disputeRef: disputeData.disputeRef,
          orderId: disputeData.orderId,
          orderDocId: orderDoc ? orderDoc.id : '',
          type: disputeData.type || '',
          reason: disputeData.reason,
          outcome: disputeData.outcome || '',
          deadline: disputeData.deadline,
          status: 'Open',
          priority: 'medium',
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          rawSubject: parsed.subject || '',
          rawBody: disputeData.rawBody,
          messageId: disputeData.messageId || '',
          emailHistory: [{
            receivedAt: new Date().toISOString(),
            subject: parsed.subject || '',
            messageId: disputeData.messageId || '',
            type: disputeData.type || '',
            outcome: disputeData.outcome || '',
          }],
          replyDraft: '',
          replySent: false,
          replySentAt: null,
          notes: '',
          assignedTo: '',
          imapUid: results[processed],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        processed++;
        logger.info(`IMAP dispute saved: ${disputeId} (${account})`);
      } catch (parseErr) {
        logger.error(`IMAP parse error: ${parseErr.message}`);
      }
    }

    imap.end();
    return { processed, updated: updatedCount, skippedUnparsable, found: results.length };
  } catch (e) {
    imap.end();
    throw e;
  }
}

// Scheduled: every 15 minutes
exports.scheduledImapReader = onSchedule(
  { schedule: 'every 15 minutes', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    try {
      const result = await readDisputeEmailsViaImap();
      logger.info(`scheduledImapReader done: ${JSON.stringify(result)}`);
    } catch (e) {
      logger.error(`scheduledImapReader error: ${e.message}`);
    }
  }
);

// Manual test: /testImapConnection?key=...
exports.testImapConnection = onRequest(
  { timeoutSeconds: 60, memory: '256MiB' },
  async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    try {
      const result = await readDisputeEmailsViaImap();
      res.json({ success: true, result });
    } catch (e) {
      logger.error(`testImapConnection error: ${e.message}`);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

// ============================================================================
// ONE-CLICK DISPUTE REPLY â€” sends email from client's configured address
// ============================================================================

async function getClientSmtpConfig(team) {
  // Look up client in orderTracker_clients by team
  const snap = await db.collection('orderTracker_clients')
    .where('team', '==', team)
    .limit(1).get();
  if (snap.empty) return null;
  const c = snap.docs[0].data();
  const envVarName = c.smtpPasswordEnvVar || '';
  const password = envVarName ? (process.env[envVarName] || '') : '';
  return {
    host: c.smtpHost || 'smtp.gmail.com',
    port: Number(c.smtpPort || 587),
    user: c.smtpUser || c.replyFromEmail || '',
    pass: password,
    fromEmail: c.replyFromEmail || c.smtpUser || '',
    fromName: c.replyFromName || c.name || 'Onlisto Support',
  };
}

exports.sendDisputeReply = onRequest(
  { cors: true, timeoutSeconds: 60, memory: '256MiB' },
  async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    try {
      const { disputeId, replyBody, sendTestOnly } = req.body || {};
      if (!disputeId || !replyBody) {
        return res.status(400).json({ error: 'Missing disputeId or replyBody' });
      }

      const disputeSnap = await db.collection('orderTracker_disputes').doc(disputeId).get();
      if (!disputeSnap.exists) return res.status(404).json({ error: 'Dispute not found' });
      const dispute = disputeSnap.data();

      const smtp = await getClientSmtpConfig(dispute.team);
      if (!smtp || !smtp.pass) {
        return res.status(500).json({
          error: 'SMTP not configured for this client. Add replyFromEmail + smtpPasswordEnvVar in client settings.',
          team: dispute.team,
        });
      }

      if (sendTestOnly) {
        return res.json({
          success: true,
          testMode: true,
          wouldSendFrom: smtp.fromEmail,
          wouldSendTo: 'customersupport-gb@onbuy.com',
          subject: `Re: ${dispute.rawSubject || 'Dispute ' + dispute.disputeRef}`,
          bodyPreview: replyBody.slice(0, 200),
        });
      }

      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.port === 465,
        auth: { user: smtp.user, pass: smtp.pass },
      });

      const info = await transporter.sendMail({
        from: `"${smtp.fromName}" <${smtp.fromEmail}>`,
        to: 'customersupport-gb@onbuy.com',
        subject: `Re: ${dispute.rawSubject || 'Dispute ' + dispute.disputeRef}`,
        text: replyBody,
        replyTo: smtp.fromEmail,
      });

      await disputeSnap.ref.update({
        replySent: true,
        replySentAt: admin.firestore.FieldValue.serverTimestamp(),
        replyBody: replyBody,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`Dispute reply sent: ${disputeId} from ${smtp.fromEmail} â†’ OnBuy. MessageId: ${info.messageId}`);
      res.json({ success: true, messageId: info.messageId, sentFrom: smtp.fromEmail });
    } catch (e) {
      logger.error(`sendDisputeReply error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  }
);

// ============================================================================

// ============================================================================
// ONE-TIME ORDER HISTORY BACKFILL (8 Aug 2026)
// Why: system went live 23 Jul 2026 — every order before that was never
// synced, so month filters (June etc.) show nothing and the costing import
// reports most rows notInSystem. This pulls the FULL OnBuy order history
// (dispatched + refunded + cancelled, paginated) and creates missing order
// docs with createdAt = the REAL OnBuy order date (o.date), so dashboard
// month filters land correctly. Existing orders are NEVER touched (VA edits
// are sacred). Dry-run by default; add &execute=true to write.
//   URL: .../importOrderHistory?key=ADMIN_KEY            (dry run, counts only)
//        .../importOrderHistory?key=ADMIN_KEY&execute=true  (writes)
//        optional &account=Samayy  (or Panacea) to do one account only
// ============================================================================
exports.importOrderHistory = onRequest(
  { secrets: ALL_SECRETS, timeoutSeconds: 1800, memory: '1GiB' },
  async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    const execute = req.query.execute === 'true';
    const wanted = String(req.query.account || 'all').toLowerCase();
    const report = {};

    const toTs = (s) => {
      const d = new Date(String(s || '').replace(' ', 'T'));
      return isNaN(d.getTime()) ? null : admin.firestore.Timestamp.fromDate(d);
    };
    const mapStatus = (st) => {
      const s = String(st || '').toLowerCase();
      if (s.includes('cancel')) return 'Cancelled';
      if (s.includes('refund')) return 'Refunded';
      if (s.includes('dispatch') || s.includes('shipped') || s.includes('complete')) return 'Dispatched';
      return 'active';
    };

    for (const account of ACCOUNTS) {
      if (wanted !== 'all' && account.name.toLowerCase() !== wanted) continue;
      const accRep = { found: 0, alreadyInSystem: 0, toImport: 0, imported: 0, batches: 0, errors: [] };
      report[account.name] = accRep;
      try {
        const token = await getOnBuyToken(account.consumerKey.value(), account.secretKey.value());

        // Load ALL existing doc IDs for this account ONCE (single-field query,
        // no composite index needed) — zero per-order reads afterwards.
        const existingIds = new Set();
        const snap = await db.collection('orderTracker_orders').where('account', '==', account.name).get();
        snap.forEach((d) => existingIds.add(d.id));
        logger.info(`${account.name}: ${existingIds.size} existing orders in Firestore.`);

        let batch = db.batch();
        let batchOps = 0;

        for (const st of ['dispatched', 'refunded', 'cancelled']) {
          for (let offset = 0; offset < 20000; offset += 100) {
            const json = await onbuyGet(token,
              `/orders?site_id=2000&filter[status]=${st}&sort[created]=asc&limit=100&offset=${offset}`);
            const list = extractList(json, `history ${st} offset ${offset} (${account.name})`);
            if (list.length === 0) break;

            for (const o of list) {
              const onbuyOrderId = String(o.order_id || o.id || o.order_number || '');
              if (!onbuyOrderId) continue;
              accRep.found += 1;
              const docId = orderDocId(onbuyOrderId);
              if (existingIds.has(docId)) { accRep.alreadyInSystem += 1; continue; }
              accRep.toImport += 1;
              existingIds.add(docId); // guard against dupes across status lists

              if (execute) {
                const item = (o.products && o.products[0]) || {};
                const addr = o.delivery_address || {};
                const mapped = mapStatus(o.status || st);
                const orderDate = toTs(o.date || o.created);
                const now = admin.firestore.FieldValue.serverTimestamp();
                batch.set(db.collection('orderTracker_orders').doc(docId), {
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
                  sellingPrice: Number(o.price_total ?? o.total ?? item.price ?? 0),
                  onbuyFee: Number(o.sales_fee_inc_VAT ?? o.sales_fee_ex_VAT ?? o.sales_fee ?? 0),
                  amount: 0,                    // costing import fills this next
                  sourceOrderNo: '',
                  sourceLink: '',
                  notes: '',
                  buyerName: addr.name || (o.buyer && o.buyer.name) || '',
                  buyerPhone: extractBuyerPhone(o),
                  buyerEmail: (o.buyer && o.buyer.email) || '',
                  buyerAddress: [addr.line_1, addr.town].filter(Boolean).join(', '),
                  buyerPostcode: addr.postcode || '',
                  onbuyOrderDate: (o.date || o.created || '').slice(0, 10),
                  status: mapped,               // history import owns status here (no VA ever saw these)
                  statusSource: 'history_import',
                  onbuyStatus: o.status || st,
                  trackingNumber: '',
                  trackingCarrier: '',
                  dispatchedToOnbuy: mapped === 'Dispatched',
                  dispatchedAt: mapped === 'Dispatched' ? (toTs(o.shipped_at) || null) : null,
                  unlockedTeam: null,
                  unlockRequested: false,
                  unlockRequestReason: null,
                  refundAmount: null,
                  refundReason: null,
                  refundAt: mapped === 'Refunded' ? now : null,
                  lastEditedAt: null,
                  importedFromApi: true,
                  needsSourcingInfo: true,
                  onbuyRefunds: o.refunds || null,
                  onbuyCancellation: o.cancellation || null,
                  onbuyDispatches: o.dispatches || null,
                  createdAt: orderDate || now,  // REAL order date — month filters land correctly
                  lastSyncedAt: now,
                });
                batchOps += 1;
                accRep.imported += 1;
                if (batchOps >= 400) {
                  await batch.commit();
                  accRep.batches += 1;
                  batch = db.batch();
                  batchOps = 0;
                }
              }
            }
            if (list.length < 100) break; // last page
          }
        }
        if (execute && batchOps > 0) {
          await batch.commit();
          accRep.batches += 1;
        }
      } catch (e) {
        logger.error(`importOrderHistory ${account.name}: ${e.message}`);
        accRep.errors.push(e.message);
      }
    }

    res.json({
      success: true,
      dryRun: !execute,
      report,
      message: execute
        ? 'History import complete. Re-run the costing import now — notInSystem rows should match.'
        : 'DRY RUN — nothing written. Add &execute=true to import for real.',
    });
  }
);
// ---------------------------------------------------------------------------
// STATUS REFRESH (9 Aug 2026) — fix orders stuck "Dispatched"/"active" in
// Firestore after OnBuy later refunded/cancelled them.
// Root cause: the 15-min sync only re-checks the NEWEST 300 dispatched /
// 300 refunded / 100 cancelled orders (offset caps in pullOrdersForAccount).
// Anything older is never re-seen, so the dashboard keeps counting refunded
// sales as profit (user-reported: 26 June orders, ~£609 fake profit).
// Same rules as syncStatusFromOnBuy: refunded -> status follows OnBuy
// one-way; cancelled -> flag needsAttention for a human (never auto-status).
// The raw mirrors (onbuyRefunds/onbuyCancellation/onbuyStatus) are what fix
// the P&L math — the dashboard's orderState reads those fields directly.
// DRY-RUN BY DEFAULT. &execute=true writes. &account=panacea|samayy optional.
// ---------------------------------------------------------------------------
exports.refreshOrderStatuses = onRequest(
  { secrets: ALL_SECRETS, timeoutSeconds: 1800, memory: '1GiB' },
  async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    const execute = req.query.execute === 'true';
    const wanted = String(req.query.account || 'all').toLowerCase();
    const now = admin.firestore.FieldValue.serverTimestamp();
    const report = {};

    for (const account of ACCOUNTS) {
      if (wanted !== 'all' && account.team !== wanted && account.name.toLowerCase() !== wanted) continue;
      const rep = {
        mode: execute ? 'EXECUTE' : 'DRY-RUN',
        scanned: { refunded: 0, cancelled: 0 },
        wouldSetRefunded: 0, wouldFlagCancelled: 0,
        mirrorsOnly: 0, alreadyCorrect: 0, notInSystem: 0, errors: 0,
        sampleSetRefunded: [], sampleFlagCancelled: [], sampleNotInSystem: [],
      };
      report[account.name] = rep;
      try {
        const token = await getOnBuyToken(account.consumerKey.value(), account.secretKey.value());
        let batch = db.batch();
        let inBatch = 0;
        const flush = async () => {
          if (execute && inBatch > 0) { await batch.commit(); }
          batch = db.batch();
          inBatch = 0;
        };

        for (const kind of ['refunded', 'cancelled']) {
          for (let offset = 0; offset < 20000; offset += 100) {
            const json = await onbuyGet(token,
              `/orders?site_id=2000&filter[status]=${kind}&sort[created]=desc&limit=100&offset=${offset}`);
            const list = extractList(json, `status-refresh ${kind} offset ${offset} (${account.name})`);
            if (!list.length) break;
            rep.scanned[kind] += list.length;

            for (const o of list) {
              const onbuyOrderId = String(o.order_id || '');
              if (!onbuyOrderId) continue;
              const onbuyStatus = o.status || kind;
              try {
                const ref = db.collection('orderTracker_orders').doc(orderDocId(onbuyOrderId));
                const snap = await ref.get();
                if (!snap.exists) {
                  rep.notInSystem++;
                  if (rep.sampleNotInSystem.length < 20) rep.sampleNotInSystem.push(onbuyOrderId);
                  continue;
                }
                const ex = snap.data();
                const cur = String(ex.status || '');
                const updates = { lastSyncedAt: now };

                // Mirrors — the fields the dashboard's orderState reads.
                if ((ex.onbuyStatus || '') !== onbuyStatus) updates.onbuyStatus = onbuyStatus;
                const rawMirror = [['refunds', 'onbuyRefunds'], ['cancellation', 'onbuyCancellation'], ['dispatches', 'onbuyDispatches']];
                for (const [srcField, dstField] of rawMirror) {
                  if (o[srcField] !== undefined) {
                    const incoming = JSON.stringify(o[srcField] || null);
                    if (incoming !== JSON.stringify(ex[dstField] || null)) updates[dstField] = o[srcField] || null;
                  }
                }

                let action = '';
                if (kind === 'refunded' && cur !== 'Refunded' && cur !== 'Cancelled') {
                  updates.status = 'Refunded';
                  updates.statusSource = 'status_refresh';
                  if (!ex.refundAt) updates.refundAt = now;
                  action = 'refunded';
                } else if (kind === 'cancelled' && cur !== 'Cancelled' && !ex.needsAttention) {
                  updates.needsAttention = true;
                  updates.attentionReason = `OnBuy shows: ${onbuyStatus}`;
                  action = 'cancelled';
                }

                if (action === 'refunded') {
                  rep.wouldSetRefunded++;
                  if (rep.sampleSetRefunded.length < 30) rep.sampleSetRefunded.push(`${onbuyOrderId} (was: ${cur || '?'})`);
                } else if (action === 'cancelled') {
                  rep.wouldFlagCancelled++;
                  if (rep.sampleFlagCancelled.length < 30) rep.sampleFlagCancelled.push(`${onbuyOrderId} (was: ${cur || '?'})`);
                } else if (Object.keys(updates).length > 1) {
                  rep.mirrorsOnly++;
                } else {
                  rep.alreadyCorrect++;
                  continue;
                }

                if (execute) {
                  batch.update(ref, updates);
                  inBatch++;
                  if (inBatch >= 400) await flush();
                }
              } catch (e) {
                rep.errors++;
                logger.error(`status-refresh ${onbuyOrderId}: ${e.message}`);
              }
            }
            if (list.length < 100) break; // last page
          }
        }
        await flush();
        // Stale-active sweep (dry-run aware): late-dispatched orders the
        // 15-min import window can no longer see.
        rep.staleActive = await sweepStaleActive(account, token, execute);
      } catch (e) {
        rep.fatalError = e.message;
        logger.error(`refreshOrderStatuses ${account.name}: ${e.message}`);
      }
    }

    res.json({
      success: true,
      mode: execute ? 'EXECUTE' : 'DRY-RUN (nothing written — add &execute=true to write)',
      report,
      message: execute
        ? 'Status refresh complete. Reload the dashboard and re-check the month that looked wrong.'
        : 'DRY RUN — nothing written. Check the counts, then add &execute=true to fix for real.',
    });
  }
);
