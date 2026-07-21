// ============================================
// cleanupDuplicates — merge duplicate orders
// ============================================
exports.cleanupDuplicates = onRequest({cors: true}, async (req, res) => {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();
  
  try {
    const snapshot = await db.collection('orderTracker_orders').get();
    const byOrderId = {};
    
    snapshot.forEach(doc => {
      const data = doc.data();
      const oid = data.onbuyOrderId || data.orderNo || doc.id;
      if (!byOrderId[oid]) byOrderId[oid] = [];
      byOrderId[oid].push({ id: doc.id, data: data, ref: doc.ref });
    });
    
    let merged = 0, deleted = 0, alreadyClean = 0;
    const report = [];
    
    for (const oid in byOrderId) {
      const docs = byOrderId[oid];
      if (docs.length > 1) {
        docs.sort((a, b) => {
          const aTime = a.data.createdAt ? a.data.createdAt.toMillis() : 0;
          const bTime = b.data.createdAt ? b.data.createdAt.toMillis() : 0;
          return bTime - aTime;
        });
        
        const master = docs[0];
        const duplicates = docs.slice(1);
        
        const mergeEntry = {
          timestamp: now,
          action: 'duplicate_merge',
          mergedFrom: duplicates.map(d => d.id),
          mergedCount: docs.length
        };
        
        await master.ref.update({
          syncHistory: admin.firestore.FieldValue.arrayUnion(mergeEntry),
          _duplicateCount: docs.length,
          _cleanedAt: now
        });
        
        for (const d of duplicates) {
          await d.ref.delete();
          deleted++;
        }
        
        merged++;
        report.push({ orderId: oid, kept: master.id, deleted: duplicates.length });
      } else {
        alreadyClean++;
      }
    }
    
    res.json({
      success: true,
      totalScanned: snapshot.size,
      uniqueOrderIds: Object.keys(byOrderId).length,
      duplicatesFound: merged,
      duplicatesDeleted: deleted,
      alreadyClean: alreadyClean,
      report: report
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
