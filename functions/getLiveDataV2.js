// ============================================
// UNIFIED API v2 — CACHED + FILTERED
// ============================================
exports.getLiveDataV2 = onRequest({cors: true}, async (req, res) => {
  const db = admin.firestore();
  const now = new Date();
  const cacheRef = db.collection('orderTracker_cache').doc('global');
  const cacheAge = Number(req.query.fresh) || 15;
  
  const cacheSnap = await cacheRef.get();
  const cache = cacheSnap.exists ? cacheSnap.data() : null;
  const cacheMs = cacheAge * 60000;
  const isFresh = cache && cache.updatedAt && (now.getTime() - cache.updatedAt.toDate().getTime()) < cacheMs;
  
  if (isFresh && !req.query.rebuild) {
    return res.json({
      ...cache,
      cached: true,
      cacheAge: Math.round((now.getTime() - cache.updatedAt.toDate().getTime()) / 1000) + 's'
    });
  }
  
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  
  const accountFilter = (req.query.account || '').toLowerCase();
  const itemFilter = (req.query.item || '').toLowerCase();
  
  try {
    const allOrdersSnap = await db.collection('orderTracker_orders').get();
    let totalOrders = 0, totalSales = 0, totalProfit = 0;
    let todayOrders = 0, todaySales = 0, todayProfit = 0;
    let weekOrders = 0, weekSales = 0, weekProfit = 0;
    let monthOrders = 0, monthSales = 0, monthProfit = 0;
    let yearOrders = 0, yearSales = 0, yearProfit = 0;
    let pendingRecent = 0, pendingStale = 0;
    let panaceaPending = 0, samayyPending = 0;
    const itemMap = {};
    const buyerMap = {};
    const recentOrders = [];
    
    allOrdersSnap.forEach(doc => {
      const o = doc.data();
      const acc = (o.account || '').toLowerCase();
      const team = (o.team || '').toLowerCase();
      
      if (accountFilter && !acc.includes(accountFilter) && !team.includes(accountFilter)) return;
      
      const sale = Number(o.sellingPrice) || 0;
      const fee = Number(o.onbuyFee) || 0;
      const cost = Number(o.amount) || 0;
      const profit = sale - fee - cost;
      const created = o.createdAt ? o.createdAt.toDate() : null;
      const itemName = String(o.item || 'Unknown').trim();
      const itemLower = itemName.toLowerCase();
      const isDispatched = o.dispatchedToOnbuy === true || o.status === 'Dispatched';
      const buyerName = String(o.buyerName || '').trim();
      const buyerPhone = String(o.buyerPhone || '').trim();
      
      if (itemFilter && !itemLower.includes(itemFilter)) return;
      
      totalOrders++; totalSales += sale; totalProfit += profit;
      
      if (!isDispatched) {
        if (created && created >= weekStart) {
          pendingRecent++;
          if (acc.includes('panacea') || team === 'panacea') panaceaPending++;
          else if (acc.includes('samay') || team === 'samayy') samayyPending++;
        } else {
          pendingStale++;
        }
      }
      
      if (created) {
        if (created >= todayStart) { todayOrders++; todaySales += sale; todayProfit += profit; }
        if (created >= weekStart) { weekOrders++; weekSales += sale; weekProfit += profit; }
        if (created >= monthStart) { monthOrders++; monthSales += sale; monthProfit += profit; }
        if (created >= yearStart) { yearOrders++; yearSales += sale; yearProfit += profit; }
      }
      
      if (itemName) {
        if (!itemMap[itemName]) itemMap[itemName] = { qty: 0, revenue: 0, profit: 0, orders: 0 };
        itemMap[itemName].qty += Number(o.quantity) || 1;
        itemMap[itemName].revenue += sale;
        itemMap[itemName].profit += profit;
        itemMap[itemName].orders++;
      }
      
      if (buyerName && buyerPhone) {
        if (!buyerMap[buyerPhone]) {
          buyerMap[buyerPhone] = { name: buyerName, phone: buyerPhone, orders: 0, totalSpent: 0, items: [] };
        }
        buyerMap[buyerPhone].orders++;
        buyerMap[buyerPhone].totalSpent += sale;
        if (!buyerMap[buyerPhone].items.includes(itemName)) buyerMap[buyerPhone].items.push(itemName);
      }
      
      if (created && recentOrders.length < 20) {
        recentOrders.push({
          orderId: o.onbuyOrderId || doc.id,
          item: itemName,
          buyer: buyerName,
          phone: buyerPhone,
          sale: sale,
          profit: profit,
          status: isDispatched ? 'Dispatched' : 'Pending',
          date: created ? created.toISOString() : null
        });
      }
    });
    
    const topItems = Object.entries(itemMap)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 10)
      .map(x => ({ name: x.name, qty: x.qty, orders: x.orders, revenue: Math.round(x.revenue * 100) / 100, profit: Math.round(x.profit * 100) / 100 }));
    
    const allBuyers = Object.values(buyerMap)
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .slice(0, 50);
    
    const disSnap = await db.collection('orderTracker_disputes').get();
    let disUrgent = 0, disOpen = 0, disWaiting = 0, disResolved = 0;
    const recentDisputes = [];
    
    disSnap.forEach(doc => {
      const d = doc.data();
      const status = d.status || 'Open';
      const dl = d.deadline ? d.deadline.toDate() : null;
      const isUrgent = dl && status !== 'Resolved' && status !== 'Closed' && (dl - now) < 24 * 3600000;
      
      if (isUrgent) disUrgent++;
      if (status === 'Open') disOpen++;
      else if (status === 'Replied' || status === 'Escalated') disWaiting++;
      else disResolved++;
      
      if (recentDisputes.length < 10) {
        recentDisputes.push({ orderId: d.orderId, reason: d.reason, status, urgent: isUrgent });
      }
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
    
    const vaSnap = await db.collection('orderTracker_vaPerformance').orderBy('date', 'desc').limit(14).get();
    const vaStats = [];
    vaSnap.forEach(doc => {
      const d = doc.data();
      vaStats.push({ date: d.date, va: d.vaName || d.account, checked: d.listingsChecked || 0, sources: d.sourcesFound || 0, restocks: d.restocksFound || 0, hours: d.hoursWorked || 0 });
    });
    
    const result = {
      timestamp: now.toISOString(),
      meta: {
        accountFilter: accountFilter || 'all',
        itemFilter: itemFilter || 'all',
        totalOrders: allOrdersSnap.size,
        totalListings: listSnap.size,
        totalDisputes: disSnap.size
      },
      orders: {
        total: totalOrders,
        totalSales: Math.round(totalSales * 100) / 100,
        totalProfit: Math.round(totalProfit * 100) / 100,
        pending: { recent: pendingRecent, stale: pendingStale, panacea: panaceaPending, samayy: samayyPending },
        today: { count: todayOrders, sales: Math.round(todaySales * 100) / 100, profit: Math.round(todayProfit * 100) / 100 },
        thisWeek: { count: weekOrders, sales: Math.round(weekSales * 100) / 100, profit: Math.round(weekProfit * 100) / 100 },
        thisMonth: { count: monthOrders, sales: Math.round(monthSales * 100) / 100, profit: Math.round(monthProfit * 100) / 100 },
        thisYear: { count: yearOrders, sales: Math.round(yearSales * 100) / 100, profit: Math.round(yearProfit * 100) / 100 },
        topItems,
        recentOrders: recentOrders.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20)
      },
      buyers: {
        total: Object.keys(buyerMap).length,
        topBuyers: allBuyers.slice(0, 10),
        itemBuyers: itemFilter ? allBuyers.filter(b => b.items.some(i => i.toLowerCase().includes(itemFilter))) : []
      },
      disputes: { urgent: disUrgent, open: disOpen, waiting: disWaiting, resolved: disResolved, recent: recentDisputes },
      catalog: { total: listSnap.size, active: activeListings, dead: deadListings, flagged: flaggedListings, winningBuyBox: winningBB, losingBuyBox: losingBB },
      vaStats: vaStats.slice(0, 7),
      cached: false
    };
    
    await cacheRef.set({
      ...result,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});
