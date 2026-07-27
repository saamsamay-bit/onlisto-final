# fix-dashboard.ps1 — applies features #7 #8 #9 #11 to index.html
# Built & verified by Kimi 26 Jul 2026. Run: powershell -File fix-dashboard.ps1
$path = 'C:\onlisto-va\index.html'
$s = [IO.File]::ReadAllText($path) -replace "`r`n","`n"
$applied = 0
$old = @'
        <div id="pnlSection">
            <div class="pnl-grid">
'@ -replace "`r`n","`n"
$new = @'
        <div id="pnlSection">
            <!-- Date range filter (#7) — applies to every KPI card below -->
            <div id="dateRangeBar" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
                <span class="small" style="font-weight:800;color:var(--muted)">📅 Range:</span>
                <input type="date" id="dateFrom" class="inp" style="width:auto;padding:6px 10px">
                <span class="small muted">to</span>
                <input type="date" id="dateTo" class="inp" style="width:auto;padding:6px 10px">
                <button class="btn btn-primary btn-sm" onclick="applyDateRange()">Apply</button>
                <button class="btn btn-ghost btn-sm" onclick="presetRange('today')">Today</button>
                <button class="btn btn-ghost btn-sm" onclick="presetRange('7d')">7 days</button>
                <button class="btn btn-ghost btn-sm" onclick="presetRange('30d')">30 days</button>
                <button class="btn btn-ghost btn-sm" onclick="presetRange('all')">All time</button>
            </div>
            <div class="pnl-grid">
'@ -replace "`r`n","`n"
if (-not $s.Contains($old)) { Write-Host 'PATCH 1 ANCHOR NOT FOUND - STOPPING, file unchanged' -ForegroundColor Red; exit 1 }
$s = $s.Replace($old, $new); $applied++
$old = @'
                    <div><p>Total OnBuy Selling Fees</p><h3 id="totalOnBuyFees">£0.00</h3></div>
                </div>
            </div>
'@ -replace "`r`n","`n"
$new = @'
                    <div><p>Total OnBuy Selling Fees</p><h3 id="totalOnBuyFees">£0.00</h3></div>
                </div>
                <div class="kpi anim-fadeUp d5">
                    <div class="kpi-ic" style="--c1:#d97706;--c2:#fbbf24">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>
                    </div>
                    <div><p>Refund &amp; Cancel Rate</p><h3 id="refundRate">0%</h3></div>
                </div>
            </div>
'@ -replace "`r`n","`n"
if (-not $s.Contains($old)) { Write-Host 'PATCH 2 ANCHOR NOT FOUND - STOPPING, file unchanged' -ForegroundColor Red; exit 1 }
$s = $s.Replace($old, $new); $applied++
$old = @'
                    <span class="chip-pending" id="pendingChip">0 pending dispatch</span>
                </div>
                <div class="table-wrap">
'@ -replace "`r`n","`n"
$new = @'
                    <span class="chip-pending" id="pendingChip">0 pending dispatch</span>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
                    <button class="btn btn-ghost btn-sm ord-view" id="ov_all" onclick="setOrderView('all')">All</button>
                    <button class="btn btn-ghost btn-sm ord-view" id="ov_pending" onclick="setOrderView('pending')">Pending</button>
                    <button class="btn btn-ghost btn-sm ord-view" id="ov_dispatched" onclick="setOrderView('dispatched')">Dispatched</button>
                    <button class="btn btn-ghost btn-sm ord-view" id="ov_cancelled" onclick="setOrderView('cancelled')">Cancelled</button>
                    <button class="btn btn-ghost btn-sm ord-view" id="ov_refunded" onclick="setOrderView('refunded')">Refunded</button>
                    <span id="orderPager" style="margin-left:auto" class="small muted"></span>
                </div>
                <div class="table-wrap">
'@ -replace "`r`n","`n"
if (-not $s.Contains($old)) { Write-Host 'PATCH 3 ANCHOR NOT FOUND - STOPPING, file unchanged' -ForegroundColor Red; exit 1 }
$s = $s.Replace($old, $new); $applied++
$old = @'
        window.renderOrders = function() {
            const tbody = $('ordersTableBody');
            const filtered = getVisibleOrders();

            let pending = 0;
            const rows = filtered.map(o => {
                const isPan = o.team === 'panacea';
                const badge = isPan ? 'badge-panacea' : 'badge-samayy';
                const dispatched = o.status === 'Dispatched' || o.dispatchedToOnbuy === true;
                if (!dispatched) pending++;
'@ -replace "`r`n","`n"
$new = @'
        /* ================= DATE RANGE FILTER (#7) ================= */
        window._dateFrom = null; window._dateTo = null;
        window.applyDateRange = function() {
            const f = $('dateFrom').value, t = $('dateTo').value;
            window._dateFrom = f ? Timestamp.fromDate(new Date(f + 'T00:00:00')) : null;
            window._dateTo = t ? Timestamp.fromDate(new Date(t + 'T23:59:59')) : null;
            renderOrders(); calculatePNL();
            toast('Date range applied to KPI cards.', 'success');
        };
        window.presetRange = function(p) {
            const today = new Date(); const iso = d => d.toISOString().slice(0, 10);
            if (p === 'all') { $('dateFrom').value = ''; $('dateTo').value = ''; }
            else if (p === 'today') { $('dateFrom').value = iso(today); $('dateTo').value = iso(today); }
            else if (p === '7d') { const d = new Date(); d.setDate(d.getDate() - 7); $('dateFrom').value = iso(d); $('dateTo').value = iso(today); }
            else if (p === '30d') { const d = new Date(); d.setDate(d.getDate() - 30); $('dateFrom').value = iso(d); $('dateTo').value = iso(today); }
            applyDateRange();
        };
        const inDateRange = o => {
            if (!window._dateFrom && !window._dateTo) return true;
            const d = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate() : null;
            if (!d) return true;
            if (window._dateFrom && d < window._dateFrom.toDate()) return false;
            if (window._dateTo && d > window._dateTo.toDate()) return false;
            return true;
        };

        /* ================= ORDER STATES + VIEW FILTER + PAGINATION (#8/#9) ================= */
        const orderState = o => {
            const s = String(o.status || '');
            const ob = (o.onbuyStatus || '').toLowerCase();
            if (s === 'Cancelled' || !!o.onbuyCancellation || ob.includes('cancel')) return 'cancelled';
            if (s === 'Refunded' || !!o.onbuyRefunds || ob.includes('refund')) return 'refunded';
            if (s === 'Dispatched' || o.dispatchedToOnbuy === true) return 'dispatched';
            return 'pending';
        };
        window._orderView = window._orderView || 'all';
        window._orderPage = window._orderPage || 1;
        window.setOrderView = function(v) { window._orderView = v; window._orderPage = 1; renderOrders(); };

        window.renderOrders = function() {
            const tbody = $('ordersTableBody');
            const stateFiltered = getVisibleOrders().filter(o => inDateRange(o) &&
                (window._orderView === 'all' ? true : orderState(o) === window._orderView));
            const PAGE = 50;
            const pages = Math.max(1, Math.ceil(stateFiltered.length / PAGE));
            if (window._orderPage > pages) window._orderPage = pages;
            const filtered = stateFiltered.slice((window._orderPage - 1) * PAGE, window._orderPage * PAGE);
            document.querySelectorAll('.ord-view').forEach(b => b.classList.remove('btn-primary'));
            const activeViewBtn = $('ov_' + window._orderView);
            if (activeViewBtn) activeViewBtn.classList.add('btn-primary');

            let pending = 0;
            const rows = filtered.map(o => {
                const isPan = o.team === 'panacea';
                const badge = isPan ? 'badge-panacea' : 'badge-samayy';
                const oState = orderState(o);
                const dispatched = oState === 'dispatched';
                if (oState === 'pending') pending++;
'@ -replace "`r`n","`n"
if (-not $s.Contains($old)) { Write-Host 'PATCH 4 ANCHOR NOT FOUND - STOPPING, file unchanged' -ForegroundColor Red; exit 1 }
$s = $s.Replace($old, $new); $applied++
$old = @'
                let statusHtml;
                if (dispatched) {
'@ -replace "`r`n","`n"
$new = @'
                let statusHtml;
                if (oState === 'cancelled') {
                    const cx = o.onbuyCancellation || {};
                    statusHtml = `<span class="badge badge-danger">Cancelled</span><br>
                       <span class="small muted">${esc(cx.reason || cx.type || o.attentionReason || 'Cancelled on OnBuy')}</span><br>
                       <span class="small muted">${o.refundAt || o.cancelledAt ? fmtTs(o.cancelledAt || o.refundAt) : ''}</span>`;
                } else if (oState === 'refunded') {
                    const rfArr = Array.isArray(o.onbuyRefunds) ? o.onbuyRefunds : [];
                    const rfTotal = rfArr.reduce((t, r) => t + (Number(r.amount ?? r.total ?? r.price) || 0), 0) || Number(o.refundAmount) || 0;
                    statusHtml = `<span class="badge" style="background:#fff7ed;color:#c2410c;border:1px solid #fdba74">Refunded</span><br>
                       ${rfTotal ? `<span class="small" style="color:#c2410c;font-weight:800">−${fmt(rfTotal)}</span><br>` : ''}
                       <span class="small muted">${o.refundAt ? fmtTs(o.refundAt) : ''}</span>`;
                } else if (dispatched) {
'@ -replace "`r`n","`n"
if (-not $s.Contains($old)) { Write-Host 'PATCH 5 ANCHOR NOT FOUND - STOPPING, file unchanged' -ForegroundColor Red; exit 1 }
$s = $s.Replace($old, $new); $applied++
$old = @'
            $('pendingChip').textContent = `${pending} pending dispatch`;
        };
'@ -replace "`r`n","`n"
$new = @'
            $('pendingChip').textContent = `${pending} pending dispatch`;
            const pager = $('orderPager');
            if (pager) {
                pager.innerHTML = pages > 1
                    ? `<button class="btn btn-ghost btn-sm" ${window._orderPage <= 1 ? 'disabled' : ''} onclick="window._orderPage--;renderOrders()">‹ Prev</button>
                       <b> Page ${window._orderPage} of ${pages} </b>
                       <button class="btn btn-ghost btn-sm" ${window._orderPage >= pages ? 'disabled' : ''} onclick="window._orderPage++;renderOrders()">Next ›</button>
                       <span class="muted">(${stateFiltered.length} orders · 50/page)</span>`
                    : `<span class="muted">${stateFiltered.length} orders</span>`;
            }
        };
'@ -replace "`r`n","`n"
if (-not $s.Contains($old)) { Write-Host 'PATCH 6 ANCHOR NOT FOUND - STOPPING, file unchanged' -ForegroundColor Red; exit 1 }
$s = $s.Replace($old, $new); $applied++
$old = @'
            const f = $('accountFilterDropdown').value;
            const wh = f !== 'All Accounts' ? [where('team', '==', f.toLowerCase())] : [];
            let notes = [];
'@ -replace "`r`n","`n"
$new = @'
            const f = $('accountFilterDropdown').value;
            const wh = f !== 'All Accounts' ? [where('team', '==', f.toLowerCase())] : [];
            const dwh = [];
            if (window._dateFrom) dwh.push(where('createdAt', '>=', window._dateFrom));
            if (window._dateTo) dwh.push(where('createdAt', '<=', window._dateTo));
            wh.push(...dwh);
            let notes = [];
            if (window._dateFrom || window._dateTo) {
                const fd = window._dateFrom ? window._dateFrom.toDate().toLocaleDateString('en-GB') : '…';
                const td = window._dateTo ? window._dateTo.toDate().toLocaleDateString('en-GB') : '…';
                notes.push(`📅 Filtered: ${fd} → ${td}.`);
            }
'@ -replace "`r`n","`n"
if (-not $s.Contains($old)) { Write-Host 'PATCH 7 ANCHOR NOT FOUND - STOPPING, file unchanged' -ForegroundColor Red; exit 1 }
$s = $s.Replace($old, $new); $applied++
$old = @'
                getVisibleOrders().forEach(o => { const sale = Number(o.sellingPrice) || 0; const cost = Number(o.amount) || 0; const fee = Number(o.onbuyFee) || 0; s += sale; c += cost; f += fee; p += sale - fee - cost; });
'@ -replace "`r`n","`n"
$new = @'
                getVisibleOrders().filter(inDateRange).forEach(o => { const sale = Number(o.sellingPrice) || 0; const cost = Number(o.amount) || 0; const fee = Number(o.onbuyFee) || 0; s += sale; c += cost; f += fee; p += sale - fee - cost; });
'@ -replace "`r`n","`n"
if (-not $s.Contains($old)) { Write-Host 'PATCH 8 ANCHOR NOT FOUND - STOPPING, file unchanged' -ForegroundColor Red; exit 1 }
$s = $s.Replace($old, $new); $applied++
$old = @'
                    const [pd, sd] = await Promise.all([trySum([where('account', '==', 'Panacea')]), trySum([where('account', '==', 'Samayy')])]);
'@ -replace "`r`n","`n"
$new = @'
                    const [pd, sd] = await Promise.all([trySum([where('account', '==', 'Panacea'), ...dwh]), trySum([where('account', '==', 'Samayy'), ...dwh])]);
'@ -replace "`r`n","`n"
if (-not $s.Contains($old)) { Write-Host 'PATCH 9 ANCHOR NOT FOUND - STOPPING, file unchanged' -ForegroundColor Red; exit 1 }
$s = $s.Replace($old, $new); $applied++
$old = @'
                    allOrders.forEach(o => {
                        const p = (Number(o.sellingPrice) || 0) - (Number(o.onbuyFee) || 0) - (Number(o.amount) || 0);
                        if (o.team === 'panacea') pan += p;
                        if (o.team === 'samayy') sam += p;
                    });
'@ -replace "`r`n","`n"
$new = @'
                    allOrders.filter(inDateRange).forEach(o => {
                        const p = (Number(o.sellingPrice) || 0) - (Number(o.onbuyFee) || 0) - (Number(o.amount) || 0);
                        if (o.team === 'panacea') pan += p;
                        if (o.team === 'samayy') sam += p;
                    });
'@ -replace "`r`n","`n"
if (-not $s.Contains($old)) { Write-Host 'PATCH 10 ANCHOR NOT FOUND - STOPPING, file unchanged' -ForegroundColor Red; exit 1 }
$s = $s.Replace($old, $new); $applied++
$old = @'
            $('pnlNote').innerHTML = notes.join(' ');
        }
        window.calculatePNL = calculatePNL;
'@ -replace "`r`n","`n"
$new = @'
            // --- refund & cancel rate (#11) — same scope (account + date) as totals ---
            try {
                const totAgg = await getAggregateFromServer(query(collection(db, "orderTracker_orders"), ...wh), { n: count() });
                const refAgg = await getAggregateFromServer(query(collection(db, "orderTracker_orders"), ...wh, where('status', '==', 'Refunded')), { n: count() });
                const canAgg = await getAggregateFromServer(query(collection(db, "orderTracker_orders"), ...wh, where('status', '==', 'Cancelled')), { n: count() });
                const tot = totAgg.data().n || 0;
                const rate = tot ? ((refAgg.data().n + canAgg.data().n) / tot * 100) : 0;
                $('refundRate').textContent = rate.toFixed(1) + '%';
            } catch (e) {
                const vis = getVisibleOrders().filter(inDateRange);
                const rc = vis.filter(o => orderState(o) === 'refunded' || orderState(o) === 'cancelled').length;
                $('refundRate').textContent = (vis.length ? rc / vis.length * 100 : 0).toFixed(1) + '%';
            }
            $('pnlNote').innerHTML = notes.join(' ');
        }
        window.calculatePNL = calculatePNL;
'@ -replace "`r`n","`n"
if (-not $s.Contains($old)) { Write-Host 'PATCH 11 ANCHOR NOT FOUND - STOPPING, file unchanged' -ForegroundColor Red; exit 1 }
$s = $s.Replace($old, $new); $applied++
[IO.File]::WriteAllText($path, $s, [Text.UTF8Encoding]::new($false))
Write-Host "SUCCESS: $applied/11 patches applied to index.html" -ForegroundColor Green
