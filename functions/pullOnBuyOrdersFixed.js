// ============================================
// FIXED pullOnBuyOrders — bulletproof deduplication
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
            historyEntry.glitchWarning = "OnBuy shows undispatched after dispatch — MANUAL REVIEW NEEDED";
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
            logger.info(account.name + ": order " + onbuyOrderId + " — no changes");
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
