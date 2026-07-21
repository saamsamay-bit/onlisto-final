const {onRequest} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
admin.initializeApp();

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
