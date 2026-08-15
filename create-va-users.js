const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const users = [
  { uid: 'MuaiSGNRSlOa3L908EtlbdsfRHK2', email: 'panacea.va@onlisto.io', password: 'PanaceaVA2026!', displayName: 'Panacea VA' },
  { uid: 'mge3ay8kJDN1twgluOf0G6y2TJq1', email: 'samayy.va@onlisto.io', password: 'SamayyVA2026!', displayName: 'Samayy VA' }
];

async function createUsers() {
  for (const user of users) {
    try {
      await admin.auth().createUser({ uid: user.uid, email: user.email, password: user.password, displayName: user.displayName, emailVerified: true });
      console.log('Created: ' + user.email);
    } catch (e) {
      console.log('Error: ' + e.message);
    }
  }
}
createUsers();
