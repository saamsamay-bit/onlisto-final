/**
 * TokAxis OnBuy integration â€” Cloud Functions
 * ============================================
 * Two jobs:
 *  1. pullOnBuyOrders   â€” runs every 15 min, pulls new orders from both OnBuy
 *                         accounts (Panacea, Samayy), writes them into the
 *                         same Firestore collection the dashboard reads from.
 *  2. pushTrackingToOnBuy â€” fires instantly whenever a VA/admin adds tracking
 *                         info to an order, sends it back to OnBuy via the
 *                         correct account's API keys.
 *
 * IMPORTANT â€” before deploying, read the "CONFIRM WITH ONBUY" notes below.
 * OnBuy's docs are an interactive Postman collection; a couple of exact
 * field names (the dispatch payload, courier name list) should be checked
 * against your own account's Postman collection / API page before going
 * live with real orders. Everything else here is taken directly from
 * https://docs.api.onbuy.com/.
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

// ---------------------------------------------------------------------------
// CONFIG â€” the one org this runs for right now (Panceaa). If you ever add a
// second client org to the dashboard, this becomes a loop over orgs instead.
// ---------------------------------------------------------------------------
const ORG_ID = 'LfCP6mxaSP0WHclScUQC'; // Panceaa â€” note the zero, not the letter O

// Each OnBuy account gets its own secret pair, stored in Secret Manager
// (never hardcoded, never committed to git). "team" is the VA name this
// account maps to in the dashboard â€” change if your VA/account pairing
// isn't a simple 1-to-1 match.
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

const ONBUY_BASE = 'https://api.onbuy.com/v2';

// ---------------------------------------------------------------------------
// AUTH â€” get a fresh 15-minute access token for one account.
// ---------------------------------------------------------------------------
async function getOnBuyToken(consumerKey, secretKey) {
  const res = await fetch(`${ONBUY_BASE}/auth/request_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ consumer_key: consumerKey, secret_key: secretKey }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`OnBuy auth failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

// ---------------------------------------------------------------------------
// JOB 1 â€” pull new orders in, every 15 minutes.
// ---------------------------------------------------------------------------
exports.pullOnBuyOrders = onSchedule(
  {
    schedule: 'every 15 minutes',
    secrets: ACCOUNTS.flatMap(a => [a.consumerKey, a.secretKey]),
    timeoutSeconds: 120,
  },
  async () => {
    for (const account of ACCOUNTS) {
      try {
        await pullOrdersForAccount(account);
      } catch (e) {
        // One account failing shouldn't stop the other from being checked.
        logger.error(`Failed pulling orders for ${account.name}: ${e.message}`);
      }
    }
  }
);

async function pullOrdersForAccount(account) {
  const consumerKey = account.consumerKey.value();
  const secretKey = account.secretKey.value();
  const token = await getOnBuyToken(consumerKey, secretKey);

  // filter[status]=awaiting_dispatch â€” only pull orders that still need
  // sourcing/dispatching, not ones already completed long ago.
  // filter[previously_exported]=0 â€” OnBuy tracks per-integration whether an
  // order has already been fetched, so this alone should stop duplicates
  // arriving from OnBuy's side â€” we ALSO double-check against our own
  // database below, belt-and-braces.
const url = `${ONBUY_BASE}/orders?site_id=2000&filter[status]=awaiting_dispatch&filter[previously_exported]=0&sort[created]=asc`;  const res = await fetch(url, { headers: { Authorization: token } });
  const json = await res.json();
  if (!res.ok) throw new Error(`OnBuy orders fetch failed: ${res.status} ${JSON.stringify(json)}`);

  const orders = json.data || json.orders || [];
  if (!orders.length) {
    logger.info(`${account.name}: no new orders.`);
    return;
  }

  for (const o of orders) {
    await importOneOrder(account, o);
  }
}

async function importOneOrder(account, o) {
  // CONFIRM WITH ONBUY: field names below (order_id, sku, price, etc.) are
  // based on OnBuy's published examples. Double-check the exact shape of
  // one real order response in Postman before relying on this in production
  // â€” marketplace order payloads sometimes nest items under a "products"
  // array rather than flat fields.
  const onbuyOrderId = o.order_id || o.id;
  if (!onbuyOrderId) {
    logger.warn(`${account.name}: skipping an order with no order_id.`);
    return;
  }

  // Dedupe check â€” never import the same OnBuy order number twice, same
  // safeguard as the manual entry form already has.
  const existing = await db.collection('orderTracker_orders')
    .where('orgId', '==', ORG_ID)
    .where('onbuyOrderId', '==', onbuyOrderId)
    .limit(1)
    .get();
  if (!existing.empty) {
    logger.info(`${account.name}: order ${onbuyOrderId} already imported, skipping.`);
    return;
  }

  const item = (o.products && o.products[0]) || {};

  await db.collection('orderTracker_orders').add({
    orgId: ORG_ID,
    team: account.team,
    account: account.name,
    platform: '',            // VA still needs to fill this in â€” where they sourced it
    orderNo: onbuyOrderId,
    onbuyOrderId,
    sku: item.sku || '',
    sourceOrderNo: '',       // VA fills this in once they've bought it
    sourceLink: '',          // VA fills this in once they've bought it
    item: item.title || item.name || 'Imported from OnBuy',
    amount: 0,               // sourcing cost â€” VA fills this in
    notes: '',
    qty: item.quantity || 1,
    sellingPrice: parseFloat(o.total || item.price || 0),
    onbuyFee: parseFloat(o.sales_fee || o.fee || 0),
    buyerName: (o.delivery_address && o.delivery_address.name) || '',
    buyerPhone: (o.delivery_address && o.delivery_address.phone) || '',
    buyerAddress: (o.delivery_address && [o.delivery_address.line_1, o.delivery_address.town].filter(Boolean).join(', ')) || '',
    buyerPostcode: (o.delivery_address && o.delivery_address.postcode) || '',
    onbuyOrderDate: (o.created || '').slice(0, 10),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    status: 'active',
    unlockedTeam: null, unlockRequested: false, unlockRequestReason: null,
    refundAmount: null, refundReason: null, refundAt: null, lastEditedAt: null,
    importedFromApi: true,
    needsSourcingInfo: true,   // dashboard can flag these until a VA completes them
    trackingNumber: '', trackingCarrier: '', dispatchedToOnbuy: false, dispatchedAt: null,
  });

  logger.info(`${account.name}: imported order ${onbuyOrderId}.`);
}

// ---------------------------------------------------------------------------
// JOB 3 â€” monitor live listings (price, stock, active/inactive), every 15 min.
// Writes into a separate collection so it doesn't interfere with orders.
// ---------------------------------------------------------------------------
exports.pullOnBuyListings = onSchedule(
  {
    schedule: 'every 15 minutes',
    secrets: ACCOUNTS.flatMap(a => [a.consumerKey, a.secretKey]),
    timeoutSeconds: 120,
  },
  async () => {
    for (const account of ACCOUNTS) {
      try {
        await pullListingsForAccount(account);
      } catch (e) {
        logger.error(`Failed pulling listings for ${account.name}: ${e.message}`);
      }
    }
  }
);

async function pullListingsForAccount(account) {
  const token = await getOnBuyToken(account.consumerKey.value(), account.secretKey.value());

  // Field names below are confirmed against a real OnBuy listings CSV export
  // (16,252 real rows checked on 6 Jul 2026) â€” sku, price, stock, opc,
  // product_title, suspended_reason, winning_status, lead_listing_price all
  // matched real data. The live JSON API response *should* use the same
  // names since CSV exports and API responses are normally generated from
  // the same underlying fields, but if the first live run comes back empty
  // or odd, check the Logs tab â€” that's the one thing still worth a 2-minute
  // sanity check on a real API call before trusting this fully.
  const url = `${ONBUY_BASE}/listings?site_id=2000&country_code=GB`;
  const res = await fetch(url, { headers: { Authorization: token } });
  const json = await res.json();
  if (!res.ok) throw new Error(`OnBuy listings fetch failed: ${res.status} ${JSON.stringify(json)}`);

  const listings = json.data || json.listings || [];
  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  for (const l of listings) {
    // Confirmed against a real OnBuy listings export on 6 Jul 2026 â€” these
    // are the real field names, not guesses.
    const docId = `${account.name}_${l.sku || l.opc}`;
    const ref = db.collection('orderTracker_listings').doc(docId);
    const stock = parseInt(l.stock ?? 0, 10);
    const suspended = !!(l.suspended_reason && l.suspended_reason.trim());
    const price = parseFloat(l.price || 0);
    const competingPrice = parseFloat(l.lead_listing_price || l.winning_price || 0);
    const winningBuyBox = l.winning_status === '1';

    // Suggest-only for now â€” does NOT touch the live OnBuy price. See the
    // pending floor-price decision before this becomes an actual auto-push.
    const canWinByRepricing = !winningBuyBox && stock > 0 && competingPrice > 0 && competingPrice < price;
    const suggestedPrice = canWinByRepricing ? Math.max(0.01, competingPrice - 0.01) : null;

    batch.set(ref, {
      orgId: ORG_ID,
      account: account.name,
      team: account.team,
      sku: l.sku || '',
      opc: l.opc || '',
      title: l.product_title || '',
      price,
      quantity: stock,
      status: suspended ? 'suspended' : (stock > 0 ? 'active' : 'out_of_stock'),
      suspendedReason: l.suspended_reason || '',
      winningBuyBox,
      competingPrice,
      suggestedRepriceTo: suggestedPrice,   // null until floor-price rule is agreed & built
      category: l.category || '',
      brandName: l['brand name'] || l.brand_name || '',
      gtin: l.gtin || '',
      lastCheckedAt: now,
    }, { merge: true });
  }
  await batch.commit();
  logger.info(`${account.name}: checked ${listings.length} listings.`);
}


// ---------------------------------------------------------------------------
// JOB 4 â€” auto-reprice to win the buy box, but never below a safe floor.
//
// Floor = (most recent sourcing cost logged for that SKU Ã— (1 + your margin%))
//         Ã· (1 âˆ’ OnBuy's actual observed fee rate on that SKU's last sale)
//
// Using your OWN last logged order's real fee (rather than guessing OnBuy's
// tiered fee table) means the floor reflects what OnBuy actually took last
// time, not a theoretical rate.
//
// If a SKU has never been logged with a cost, or the competing price is
// below what your floor allows, nothing gets pushed â€” it's left flagged in
// Firestore for you to look at, never silently undercut.
// ---------------------------------------------------------------------------
const DEFAULT_MARGIN_PERCENT = 15; // used only if the org doc has no override

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
    .orderBy('amount') // Firestore requires the inequality field ordered first
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  const o = snap.docs[0].data();
  if (!o.sellingPrice || o.sellingPrice <= 0) return null;
  const feeRate = (o.onbuyFee || 0) / o.sellingPrice;
  return { cost: o.amount, feeRate };
}

function calcFloor(cost, feeRate, marginPercent) {
  const denom = 1 - feeRate;
  if (denom <= 0) return null; // fee rate of 100%+ makes this unsolvable â€” flag, don't guess
  return (cost * (1 + marginPercent / 100)) / denom;
}

exports.repriceToWinBuyBox = onSchedule(
  {
    schedule: 'every 15 minutes',
    secrets: ACCOUNTS.flatMap(a => [a.consumerKey, a.secretKey]),
    timeoutSeconds: 180,
  },
  async () => {
    const marginPercent = await getMarginPercent();
    const candidates = await db.collection('orderTracker_listings')
      .where('orgId', '==', ORG_ID)
      .where('suggestedRepriceTo', '>', 0)
      .get();

    if (candidates.empty) {
      logger.info('No reprice candidates this run.');
      return;
    }

    // Group approved price changes by account, so we can batch-push to
    // OnBuy's PUT /v2/listings/by-sku endpoint (up to 1,000 SKUs per call).
    const toPushByAccount = {};

    for (const doc of candidates.docs) {
      const l = doc.data();
      const costInfo = await getMostRecentCostAndFeeRate(l.sku);

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
        // Winning the buy box here would mean selling at a loss â€” skip.
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
      const items = toPushByAccount[accountName];

      try {
        const token = await getOnBuyToken(account.consumerKey.value(), account.secretKey.value());
        // CONFIRM WITH ONBUY: exact body shape for PUT /v2/listings/by-sku â€”
        // taken from the docs' description, not a tested real response.
        const res = await fetch(`${ONBUY_BASE}/listings/by-sku`, {
          method: 'PUT',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify(items.map(i => ({ sku: i.sku, price: i.price }))),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(`OnBuy reprice push failed: ${res.status} ${JSON.stringify(json)}`);

        for (const i of items) {
          await i.docRef.update({
            price: i.price,
            repriceStatus: 'repriced',
            calculatedFloor: Math.round(i.floor * 100) / 100,
            lastRepricedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        logger.info(`${accountName}: repriced ${items.length} listing(s).`);
      } catch (e) {
        logger.error(`${accountName}: reprice push failed â€” ${e.message}`);
      }
    }
  }
);

exports.pushTrackingToOnBuy = onDocumentUpdated(
  {
    document: 'orderTracker_orders/{orderId}',
    secrets: ACCOUNTS.flatMap(a => [a.consumerKey, a.secretKey]),
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    // Only fire when tracking has just been added/changed, and only for
    // orders that came in through the API (so we know their onbuyOrderId
    // and which account they belong to).
    const trackingJustAdded = after.trackingNumber && after.trackingNumber !== before.trackingNumber;
    if (!trackingJustAdded || !after.onbuyOrderId || !after.account) return;
    if (after.dispatchedToOnbuy) return; // already sent, don't resend

    const account = ACCOUNTS.find(a => a.name === after.account);
    if (!account) {
      logger.error(`No matching OnBuy account config for "${after.account}".`);
      return;
    }

    try {
      const token = await getOnBuyToken(account.consumerKey.value(), account.secretKey.value());

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
      const json = await res.json();
      if (!res.ok) throw new Error(`OnBuy dispatch failed: ${res.status} ${JSON.stringify(json)}`);

      await event.data.after.ref.update({
        dispatchedToOnbuy: true,
        dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      logger.info(`Dispatched tracking for order ${after.onbuyOrderId} on ${account.name}.`);
    } catch (e) {
      logger.error(`Failed to push tracking for order ${after.onbuyOrderId}: ${e.message}`);
      // Leaving dispatchedToOnbuy as false means we'll know from Firestore
      // this one needs manual attention / a retry.
    }
  }
);
const {onRequest} = require('firebase-functions/v2/https');

exports.migrateData = onRequest({cors: true}, async (req, res) => {
  const source = req.query.source;
  const dest = req.query.dest;
  const limitCount = req.query.limit || 500;
  
  if (!source || !dest) {
    return res.status(400).json({error: "Missing source or dest query params"});
  }
  
  const db = admin.firestore();
  const sourceRef = db.collection(source);
  const destRef = db.collection(dest);
  
  try {
    const snapshot = await sourceRef.limit(Number(limitCount)).get();
    if (snapshot.empty) {
      return res.json({migrated: 0, message: "Source collection is empty"});
    }
    
    const batch = db.batch();
    let count = 0;
    snapshot.forEach(doc => {
      batch.set(destRef.doc(doc.id), doc.data());
      count++;
    });
    
    await batch.commit();
    
    res.json({
      success: true,
      migrated: count,
      source: source,
      destination: dest,
      message: "Migrated " + count + " documents from " + source + " to " + dest
    });
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});
