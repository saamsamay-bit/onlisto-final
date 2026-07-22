const axios = require('axios');
const cheerio = require('cheerio');
/**
 * TokAxis OnBuy integration Ã¢â‚¬â€ Cloud Functions
 * ============================================
 * Two jobs:
 *  1. pullOnBuyOrders   Ã¢â‚¬â€ runs every 15 min, pulls new orders from both OnBuy
 *                         accounts (Panacea, Samayy), writes them into the
 *                         same Firestore collection the dashboard reads from.
 *  2. pushTrackingToOnBuy Ã¢â‚¬â€ fires instantly whenever a VA/admin adds tracking
 *                         info to an order, sends it back to OnBuy via the
 *                         correct account's API keys.
 *
 * IMPORTANT Ã¢â‚¬â€ before deploying, read the "CONFIRM WITH ONBUY" notes below.
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
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

// ---------------------------------------------------------------------------
// CONFIG Ã¢â‚¬â€ the one org this runs for right now (Panceaa). If you ever add a
// second client org to the dashboard, this becomes a loop over orgs instead.
// ---------------------------------------------------------------------------
const ORG_ID = 'LfCP6mxaSP0WHclScUQC'; // Panceaa Ã¢â‚¬â€ note the zero, not the letter O

// Each OnBuy account gets its own secret pair, stored in Secret Manager
// (never hardcoded, never committed to git). "team" is the VA name this
// account maps to in the dashboard Ã¢â‚¬â€ change if your VA/account pairing
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
// AUTH Ã¢â‚¬â€ get a fresh 15-minute access token for one account.
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
// JOB 1 Ã¢â‚¬â€ pull new orders in, every 15 minutes.
// ---------------------------------------------------------------------------
exports.scheduledPullOnBuyOrders = onSchedule(
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

  // filter[status]=awaiting_dispatch Ã¢â‚¬â€ only pull orders that still need
  // sourcing/dispatching, not ones already completed long ago.
  // filter[previously_exported]=0 Ã¢â‚¬â€ OnBuy tracks per-integration whether an
  // order has already been fetched, so this alone should stop duplicates
  // arriving from OnBuy's side Ã¢â‚¬â€ we ALSO double-check against our own
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
  // Ã¢â‚¬â€ marketplace order payloads sometimes nest items under a "products"
  // array rather than flat fields.
  const onbuyOrderId = o.order_id || o.id;
  if (!onbuyOrderId) {
    logger.warn(`${account.name}: skipping an order with no order_id.`);
    return;
  }

  // Dedupe check Ã¢â‚¬â€ never import the same OnBuy order number twice, same
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
    platform: '',            // VA still needs to fill this in Ã¢â‚¬â€ where they sourced it
    orderNo: onbuyOrderId,
    onbuyOrderId,
    sku: item.sku || '',
    sourceOrderNo: '',       // VA fills this in once they've bought it
    sourceLink: '',          // VA fills this in once they've bought it
    item: item.title || item.name || 'Imported from OnBuy',
    amount: 0,               // sourcing cost Ã¢â‚¬â€ VA fills this in
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
// JOB 3 Ã¢â‚¬â€ monitor live listings (price, stock, active/inactive), every 15 min.
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
  // (16,252 real rows checked on 6 Jul 2026) Ã¢â‚¬â€ sku, price, stock, opc,
  // product_title, suspended_reason, winning_status, lead_listing_price all
  // matched real data. The live JSON API response *should* use the same
  // names since CSV exports and API responses are normally generated from
  // the same underlying fields, but if the first live run comes back empty
  // or odd, check the Logs tab Ã¢â‚¬â€ that's the one thing still worth a 2-minute
  // sanity check on a real API call before trusting this fully.
  const url = `${ONBUY_BASE}/listings?site_id=2000&country_code=GB`;
  const res = await fetch(url, { headers: { Authorization: token } });
  const json = await res.json();
  if (!res.ok) throw new Error(`OnBuy listings fetch failed: ${res.status} ${JSON.stringify(json)}`);

  const listings = json.data || json.listings || [];
  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  for (const l of listings) {
    // Confirmed against a real OnBuy listings export on 6 Jul 2026 Ã¢â‚¬â€ these
    // are the real field names, not guesses.
    const docId = `${account.name}_${l.sku || l.opc}`;
    const ref = db.collection('orderTracker_listings').doc(docId);
    const stock = parseInt(l.stock ?? 0, 10);
    const suspended = !!(l.suspended_reason && l.suspended_reason.trim());
    const price = parseFloat(l.price || 0);
    const competingPrice = parseFloat(l.lead_listing_price || l.winning_price || 0);
    const winningBuyBox = l.winning_status === '1';

    // Suggest-only for now Ã¢â‚¬â€ does NOT touch the live OnBuy price. See the
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
// JOB 4 Ã¢â‚¬â€ auto-reprice to win the buy box, but never below a safe floor.
//
// Floor = (most recent sourcing cost logged for that SKU Ãƒâ€” (1 + your margin%))
//         ÃƒÂ· (1 Ã¢Ë†â€™ OnBuy's actual observed fee rate on that SKU's last sale)
//
// Using your OWN last logged order's real fee (rather than guessing OnBuy's
// tiered fee table) means the floor reflects what OnBuy actually took last
// time, not a theoretical rate.
//
// If a SKU has never been logged with a cost, or the competing price is
// below what your floor allows, nothing gets pushed Ã¢â‚¬â€ it's left flagged in
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
  if (denom <= 0) return null; // fee rate of 100%+ makes this unsolvable Ã¢â‚¬â€ flag, don't guess
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
        // Winning the buy box here would mean selling at a loss Ã¢â‚¬â€ skip.
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
        // CONFIRM WITH ONBUY: exact body shape for PUT /v2/listings/by-sku Ã¢â‚¬â€
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
        logger.error(`${accountName}: reprice push failed Ã¢â‚¬â€ ${e.message}`);
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
// ============================================
// FIXED pullOnBuyOrders â€” bulletproof deduplication
// ============================================
exports.pullOnBuyOrders = onRequest({timeoutSeconds: 300, memory: "1GiB"}, async (req, res) => {
  const { logger } = require("firebase-functions");
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();
  
  try {
    const orgSnap = await db.collection("orderTracker_orgs").get();
    if (orgSnap.empty) { return res.json({ imported: 0, message: "No orgs configured" }); }
    
    let totalImported = 0, totalUpdated = 0, totalSkipped = 0;
    
    for (const orgDoc of orgSnap.docs) {
      const ORG_ID = orgDoc.id;
      const account = orgDoc.data();
      
      if (!account.onbuyApiKey) { logger.info(account.name + ": no API key"); continue; }
      
      const orders = await fetchOnBuyOrders(account.onbuyApiKey, account);
      logger.info(account.name + ": fetched " + orders.length + " orders from OnBuy");
      
      for (const o of orders) {
        const onbuyOrderId = o.order_number || o.id || o.order_id;
        if (!onbuyOrderId) { logger.warn("Skipping order with no ID"); continue; }
        
        const docId = "onbuy_" + String(onbuyOrderId).replace(/[^a-zA-Z0-9_-]/g, "_");
        const docRef = db.collection("orderTracker_orders").doc(docId);
        const docSnap = await docRef.get();
        
        const orderData = {
          onbuyOrderId: String(onbuyOrderId),
          orgId: ORG_ID,
          account: account.name || "Unknown",
          team: account.teamLabel || (String(account.name).toLowerCase().includes("panacea") ? "panacea" : "samayy"),
          item: o.product_title || o.item_name || o.title || "Unknown",
          sku: o.sku || o.product_sku || "",
          opc: o.opc || o.product_id || "",
          sellingPrice: Number(o.total || o.price || o.amount || 0),
          onbuyFee: Number(o.fee || o.commission || 0),
          amount: Number(o.cost || o.source_price || 0),
          quantity: Number(o.quantity || o.qty || 1),
          buyerName: o.buyer_name || o.customer_name || o.name || "",
          buyerEmail: o.buyer_email || o.email || "",
          buyerPhone: o.buyer_phone || o.phone || o.telephone || "",
          buyerAddress: o.buyer_address || o.address || o.shipping_address || "",
          buyerPostcode: o.buyer_postcode || o.postcode || o.zip || "",
          status: o.status || "Placed",
          trackingNumber: o.tracking_number || o.trackingNumber || "",
          trackingCarrier: o.tracking_carrier || o.trackingCarrier || "",
          dispatchedToOnbuy: (o.status || "").toLowerCase().includes("dispatch") || (o.status || "").toLowerCase().includes("shipped"),
          createdAt: o.created_at ? admin.firestore.Timestamp.fromDate(new Date(o.created_at)) : now,
          updatedAt: now,
          lastSyncFromOnBuy: now
        };
        
        if (docSnap.exists) {
          const existing = docSnap.data();
          const changes = {};
          const historyEntry = { timestamp: now, action: "sync_update", fields: [] };
          
          const fieldsToCheck = ["status", "trackingNumber", "trackingCarrier", "dispatchedToOnbuy", "buyerPhone", "buyerAddress"];
          for (const field of fieldsToCheck) {
            const oldVal = existing[field];
            const newVal = orderData[field];
            if (oldVal !== newVal && !(oldVal == null && newVal == null)) {
              changes[field] = newVal;
              historyEntry.fields.push({ field: field, from: oldVal, to: newVal });
            }
          }
          
          const wasDispatched = existing.dispatchedToOnbuy === true;
          const nowShowsUndispatched = !orderData.dispatchedToOnbuy && (existing.status || "").toLowerCase().includes("dispatch");
          if (wasDispatched && nowShowsUndispatched) {
            historyEntry.glitchWarning = "OnBuy shows undispatched after dispatch â€” MANUAL REVIEW NEEDED";
            historyEntry.fields.push({ field: "status", from: existing.status, to: orderData.status, note: "GLITCH" });
            delete changes.dispatchedToOnbuy;
            delete changes.status;
          }
          
          if (historyEntry.fields.length > 0) {
            changes.syncHistory = admin.firestore.FieldValue.arrayUnion(historyEntry);
            changes.updatedAt = now;
            changes.lastSyncFromOnBuy = now;
            await docRef.update(changes);
            totalUpdated++;
            logger.info(account.name + ": order " + onbuyOrderId + " updated");
          } else {
            totalSkipped++;
            logger.info(account.name + ": order " + onbuyOrderId + " â€” no changes");
          }
        } else {
          orderData.syncHistory = [{ timestamp: now, action: "created", source: "pullOnBuyOrders" }];
          await docRef.set(orderData);
          totalImported++;
          logger.info(account.name + ": order " + onbuyOrderId + " CREATED");
        }
      }
    }
    
    res.json({ 
      success: true, 
      imported: totalImported, 
      updated: totalUpdated, 
      skipped: totalSkipped,
      message: "Sync complete: " + totalImported + " new, " + totalUpdated + " updated, " + totalSkipped + " unchanged"
    });
  } catch (e) {
    logger.error("pullOnBuyOrders error:", e);
    res.status(500).json({ error: e.message });
  }
});


// ============================================
// SCRAPINGBEE PRICE CHECKER
// ============================================
const getScrapingBeeKey = () => {
  try { return functions.config().scrapingbee.key; }
  catch (e) { return process.env.SCRAPINGBEE_API_KEY || ''; }
};

const buildScrapingBeeUrl = (targetUrl) => {
  const apiKey = getScrapingBeeKey();
  return `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&render_js=true&premium_proxy=true&country_code=gb`;
};

const extractPrices = (html, platform) => {
  const $ = cheerio.load(html);
  const results = [];
  const selector = platform === 'amazon' ? '.a-price .a-offscreen' :
                   platform === 'ebay' ? '.s-item__price' : '[class*="price"]';

  $(selector).each((i, el) => {
    if (i >= 3) return;
    const text = $(el).text().trim();
    const match = text.match(/Â£?\s*([\d,]+\.?\d{0,2})/);
    if (match) {
      const price = parseFloat(match[1].replace(/,/g, ''));
      if (price > 0 && price < 10000) {
        results.push({
          platform: platform === 'amazon' ? 'Amazon UK' : platform === 'ebay' ? 'eBay UK' : 'AliExpress',
          price: price,
          currency: 'GBP',
          title: platform + ' result ' + (i + 1),
          link: platform === 'amazon' ? 'https://www.amazon.co.uk' : platform === 'ebay' ? 'https://www.ebay.co.uk' : 'https://www.aliexpress.com'
        });
      }
    }
  });
  return results.slice(0, 2);
};

// Check source price — supports TWO modes:
// Mode 1: sourceUrl provided → scrape ONE link (1 API call)
// Mode 2: query provided → search Amazon/eBay/AliExpress (3 API calls)
exports.checkSourcePrices = onRequest({cors: true}, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const sourceUrl = req.query.sourceUrl || req.body?.sourceUrl;
  const query = req.query.query || req.query.sku || req.body?.query;
  const listingId = req.query.listingId || req.body?.listingId;
  const saveToFirestore = (req.query.saveToFirestore === 'true') || (req.body?.saveToFirestore === true);

  const apiKey = getScrapingBeeKey();
  if (!apiKey) { res.status(500).json({ error: 'ScrapingBee API key not configured' }); return; }

  try {
    let response = {};

    // === MODE 1: Direct URL scrape (1 API call) ===
    if (sourceUrl) {
      const sbUrl = `https://app.scrapingbee.com/api/v1?api_key=${apiKey}&url=${encodeURIComponent(sourceUrl)}&render_js=true&premium_proxy=true&country_code=gb`;
      const r = await axios.get(sbUrl, { timeout: 45000 });
      const extracted = extractSinglePrice(r.data, sourceUrl);

      response = {
        success: true,
        mode: 'direct_url',
        sourceUrl: sourceUrl,
        price: extracted.price,
        title: extracted.title,
        inStock: extracted.inStock,
        scrapedAt: new Date().toISOString()
      };

      // Save to Firestore if requested
      if (saveToFirestore && listingId) {
        await db.collection('orderTracker_listings').doc(listingId).update({
          sourcePrice: extracted.price,
          sourceTitle: extracted.title,
          sourceInStock: extracted.inStock,
          sourceCheckedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        response.saved = true;
      }

      return res.json(response);
    }

    // === MODE 2: Search across platforms (3 API calls) ===
    if (!query) {
      return res.status(400).json({
        error: 'Missing parameters. Send either sourceUrl (1 API call) or query (3 API calls)',
        examples: {
          direct: '/checkSourcePrices?sourceUrl=https://amazon.co.uk/dp/...&listingId=ABC',
          search: '/checkSourcePrices?query=iphone+15+case&listingId=ABC&saveToFirestore=true'
        }
      });
    }

    const urls = {
      amazon: `https://www.amazon.co.uk/s?k=${encodeURIComponent(query)}`,
      ebay: `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(query)}`,
      aliexpress: `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(query)}`
    };

    const results = await Promise.allSettled([
      axios.get(buildScrapingBeeUrl(urls.amazon), { timeout: 45000 }).then(r => extractPrices(r.data, 'amazon')),
      axios.get(buildScrapingBeeUrl(urls.ebay), { timeout: 45000 }).then(r => extractPrices(r.data, 'ebay')),
      axios.get(buildScrapingBeeUrl(urls.aliexpress), { timeout: 45000 }).then(r => extractPrices(r.data, 'aliexpress'))
    ]);

    let all = [];
    results.forEach(r => { if (r.status === 'fulfilled') all.push(...r.value); });
    all.sort((a, b) => a.price - b.price);
    const cheapest = all[0] || null;

    response = {
      success: true,
      mode: 'search',
      searchTerm: query,
      sources: all,
      cheapest: cheapest,
      apiCallsUsed: 3,
      scrapedAt: new Date().toISOString()
    };

    if (saveToFirestore && listingId && cheapest) {
      await db.collection('orderTracker_listings').doc(listingId).update({
        sourcePrice: cheapest.price,
        sourcePlatform: cheapest.platform,
        sourceLink: cheapest.link,
        sourceTitle: cheapest.title,
        sourceCheckedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      response.saved = true;
    }

    res.json(response);

  } catch (err) {
    console.error('checkSourcePrices error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: Extract price from a single product page
function extractSinglePrice(html, url) {
  let price = null;
  let title = null;
  let inStock = true;

  // Price patterns
  const pricePatterns = [
    /class="a-price-whole"[^>]*>([\d,]+)/,
    /class="a-offscreen"[^>]*>£?([\d,\.]+)/,
    /"priceAmount":\s*([\d\.]+)/,
    /"price":"£?([\d,\.]+)"/,
    /data-price="([\d,\.]+)"/,
    /£([\d,\.]+)/
  ];

  for (const pattern of pricePatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      price = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(price) && price > 0) break;
    }
  }

  // Title
  const titleMatch = html.match(/<title>([^<]+)/) ||
                     html.match(/id="productTitle"[^>]*>([^<]+)/) ||
                     html.match(/"name":"([^"]+)"/);
  if (titleMatch) title = titleMatch[1].trim();

  // Stock check
  if (html.includes('Out of stock') || html.includes('Currently unavailable') || html.includes('Temporarily out of stock')) {
    inStock = false;
  }

  return { price, title, inStock };
}






