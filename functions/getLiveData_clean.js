// ============================================
// LIVE DATA EXPORT — CLEAN VERSION
// ============================================
exports.getLiveData = onRequest({cors: true}, async (req, res) => {
  const db = admin.firestore();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  
  try {
    const allOrdersSnap = await db.collection('orderTracker_orders').get();
    let totalOrders = 0, totalSales = 0, totalProfit = 0;
    let todayOrders = 0, todaySales = 0, todayProfit = 0;
    let monthOrders = 0, monthSales = 0, monthProfit = 0;
    let pendingDispatch = 0, stalePending = 0;
    let panaceaPending = 0, samayyPending = 0;
    const itemMap = {};
    
    allOrdersSnap.forEach(doc => {
      const o = doc.data();
      const sale = Number(o.sellingPrice) || 0;
      const fee = Number(o.onbuyFee) || 0;
      const cost = Number(o.amount) || 0;
      const profit = sale - fee - cost;
      const created = o.createdAt ? o.createdAt.toDate() : null;
      const itemName = String(o.item || 'Unknown').trim();
      const isDispatched = o.dispatchedToOnbuy === true || o.status === 'Dispatched';
      const acc = (o.account || '').toLowerCase();
      
      totalOrders++; totalSales += sale; totalProfit += profit;
      
      if (!isDispatched) {
        if (created && created >= weekStart) {
          pendingDispatch++;
          if (acc.includes('panacea')) panaceaPending++;
          else if (acc.includes('samay')) samayyPending++;
        } else {
          stalePending++;
        }
      }
      
      if (created) {
        if (created >= todayStart) { todayOrders++; todaySales += sale; todayProfit += profit; }
        if (created >= monthStart) { monthOrders++; monthSales += sale; monthProfit += profit; }
      }
      
      if (itemName) {
        if (!itemMap[itemName]) itemMap[itemName] = { qty: 0, revenue: 0, profit: 0 };
        itemMap[itemName].qty += Number(o.quantity) || 1;
        itemMap[itemName].revenue += sale;
        itemMap[itemName].profit += profit;
      }
    });
    
    const topItems = Object.entries(itemMap)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 10)
      .map(x => ({ name: x.name, qty: x.qty, revenue: Math.round(x.revenue * 100) / 100, profit: Math.round(x.profit * 100) / 100 }));
    
    const disSnap = await db.collection('orderTracker_disputes').get();
    let disUrgent = 0, disOpen = 0, disWaiting = 0, disResolved = 0;
    
    disSnap.forEach(doc => {
      const d = doc.data();
      const status = d.status || 'Open';
      const dl = d.deadline ? d.deadline.toDate() : null;
      const isUrgent = dl && status !== 'Resolved' && status !== 'Closed' && (dl - now) < 24 * 3600000;
      
      if (isUrgent) disUrgent++;
      if (status === 'Open') disOpen++;
      else if (status === 'Replied' || status === 'Escalated') disWaiting++;
      else disResolved++;
    });
    
    const listSnap = await db.collection('orderTracker_listings').get();
    let activeListings = 0, deadListings = 0, flaggedListings = 0, winningBB = 0, losingBB = 0;
    
    listSnap.forEach(doc => {
      const l = doc.data();
      if (l.status === 'out_of_stock' || l.quantity === 0) deadListings++;
      else activeListings++;
      if (l.brandFlagged === true) flaggedListings++;
      if (l.winningBuyBox === true && l.status !== 'out_of_stock') winningBB++;
      if (l.winningBuyBox === false && l.status !== 'out_of_stock') losingBB++;
    });
    
    res.json({
      timestamp: now.toISOString(),
      orders: {
        total: totalOrders, totalSales: Math.round(totalSales * 100) / 100, totalProfit: Math.round(totalProfit * 100) / 100,
        pendingDispatch: { recent: pendingDispatch, stale: stalePending, panacea: panaceaPending, samayy: samayyPending },
        today: { count: todayOrders, sales: Math.round(todaySales * 100) / 100, profit: Math.round(todayProfit * 100) / 100 },
        thisMonth: { count: monthOrders, sales: Math.round(monthSales * 100) / 100, profit: Math.round(monthProfit * 100) / 100 },
        topItems
      },
      disputes: { urgent: disUrgent, open: disOpen, waiting: disWaiting, resolved: disResolved },
      catalog: { total: listSnap.size, active: activeListings, dead: deadListings, flagged: flaggedListings, winningBuyBox: winningBB, losingBuyBox: losingBB }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
