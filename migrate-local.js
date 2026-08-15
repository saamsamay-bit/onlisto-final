const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

function getOrgId(data) {
  if (data.team === 'samayy' || data.team === 'panacea') return data.team;
  if (data.account === 'panacea' || data.seller === 'panacea') return 'panacea';
  if (data.account === 'Samayy' || data.account === 'samayy' || data.seller === 'samayy') return 'samayy';
  return 'samayy';
}

async function migrateOrders() {
  console.log('Migrating orders...');
  const snapshot = await db.collection('orderTracker_orders').get();
  let updated = 0, skipped = 0, samayy = 0, panacea = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const orgId = getOrgId(data);

    if (data.orgId === orgId && data.team === orgId) {
      skipped++;
      continue;
    }

    await doc.ref.update({
      orgId: orgId,
      team: orgId,
      migratedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    updated++;
    if (orgId === 'samayy') samayy++; else panacea++;

    if (updated % 100 === 0) {
      console.log('  Progress: ' + updated + ' updated');
    }
  }

  console.log('Orders done: ' + updated + ' updated, ' + skipped + ' skipped');
  return { total: snapshot.size, updated, skipped, samayy, panacea };
}

async function migrateListings() {
  console.log('Migrating listings...');
  const snapshot = await db.collection('orderTracker_listings').get();
  let updated = 0, skipped = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const orgId = getOrgId(data);

    if (data.orgId === orgId && data.team === orgId) {
      skipped++;
      continue;
    }

    await doc.ref.update({
      orgId: orgId,
      team: orgId,
      migratedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    updated++;

    if (updated % 500 === 0) {
      console.log('  Progress: ' + updated + ' updated');
    }
  }

  console.log('Listings done: ' + updated + ' updated, ' + skipped + ' skipped');
  return { total: snapshot.size, updated, skipped };
}

async function run() {
  console.log('=== ONLISTO MIGRATION ===');
  const ordersResult = await migrateOrders();
  const listingsResult = await migrateListings();

  console.log('\n=== RESULTS ===');
  console.log('Orders:', ordersResult);
  console.log('Listings:', listingsResult);
  console.log('\nMigration complete!');
  process.exit(0);
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
