const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function fixOrders() {
  console.log('Fixing team field on all orders...');
  const snapshot = await db.collection('orderTracker_orders').get();
  let updated = 0, skipped = 0;
  
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const account = (data.account || '').toLowerCase();
    let team = 'samayy';
    if (account.includes('panacea')) team = 'panacea';
    else if (account.includes('samay')) team = 'samayy';
    
    if (data.team === team) {
      skipped++;
      continue;
    }
    
    await doc.ref.update({ team: team, orgId: team });
    updated++;
    
    if (updated % 50 === 0) console.log('  Updated: ' + updated);
  }
  
  console.log('Done! ' + updated + ' updated, ' + skipped + ' already correct');
  process.exit(0);
}

fixOrders().catch(err => { console.error(err); process.exit(1); });
