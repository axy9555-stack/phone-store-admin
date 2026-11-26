/* 数据看板 + 报表。全局 window.PSDashboard */
(function (root) {
  'use strict';

  var Store = root.PhoneStore;

  function round2(n) { return Math.round(n * 100) / 100; }
  function pad(n, len) {
    var s = String(n);
    while (s.length < len) s = '0' + s;
    return s;
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  }
  function thisMonth() { return today().slice(0, 7); }

  /* ---------- 逻辑 ---------- */

  // 今日销售额、订单数、毛利（销售额 - 成本 - 今日退货）、客单价
  function todayStats() {
    var day = today();
    var orders = (Store.get('orders') || []).filter(function (o) { return o.date === day; });
    var sales = round2(orders.reduce(function (s, o) { return s + o.total; }, 0));
    var profit = round2(orders.reduce(function (s, o) { return s + (o.total - (Number(o.cost) || 0)); }, 0) -
      (Store.get('refunds') || []).filter(function (r) { return r.date === day; })
        .reduce(function (s, r) { return s + r.amount; }, 0));
    return {
      ok: true, date: day,
      sales: sales, orderCount: orders.length, profit: profit,
      avg: orders.length ? round2(sales / orders.length) : 0
    };
  }

  // 畅销榜：某月按销量排前 n（不含维修收入单）
  function topSellers(month, n) {
    var m = String(month || thisMonth()).slice(0, 7);
    var top = Number(n) || 5;
    var agg = {};
    (Store.get('orders') || []).forEach(function (o) {
      if (o.type === '维修') return;
      if (String(o.date).slice(0, 7) !== m) return;
      (o.items || []).forEach(function (it) {
        var hit = agg[it.productId] = agg[it.productId] ||
          { productId: it.productId, name: it.name, qty: 0, sales: 0 };
        hit.qty += it.qty;
        hit.sales = round2(hit.sales + it.price * it.qty);
      });
    });
    var rows = Object.keys(agg).map(function (k) { return agg[k]; });
    rows.sort(function (a, b) { return b.qty - a.qty || b.sales - a.sales; });
    return { ok: true, month: m, rows: rows.slice(0, top) };
  }

  // 区间毛利：销售毛利 + 维修收入 - 退货
  function profit(startDate, endDate) {
    var s = String(startDate || '').slice(0, 10);
    var e = String(endDate || '').slice(0, 10);
    var re = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
    if (!re.test(s) || !re.test(e)) return { ok: false, reason: '日期格式须为 YYYY-MM-DD' };
    if (s > e) return { ok: false, reason: '开始日期不能晚于结束日期' };
    var orders = (Store.get('orders') || []).filter(function (o) {
      return o.date >= s && o.date <= e;
    });
    var salesOrders = orders.filter(function (o) { return o.type !== '维修'; });
    var repairOrders = orders.filter(function (o) { return o.type === '维修'; });
    var salesProfit = round2(salesOrders.reduce(function (sum, o) {
      return sum + (o.total - (Number(o.cost) || 0));
    }, 0));
    var repairIncome = round2(repairOrders.reduce(function (sum, o) { return sum + o.total; }, 0));
    var refund = round2((Store.get('refunds') || []).filter(function (r) {
      return r.date >= s && r.date <= e;
    }).reduce(function (sum, r) { return sum + r.amount; }, 0));
    return {
      ok: true, startDate: s, endDate: e,
      sales: round2(salesOrders.reduce(function (sum, o) { return sum + o.total; }, 0)),
      salesProfit: salesProfit, repairIncome: repairIncome, refund: refund,
      profit: round2(salesProfit + repairIncome - refund)
    };
  }

  // 近 n 个月（含本月）的月销售额，供柱状图
  function monthlySales(n) {
    var months = [];
    var d = new Date();
    for (var i = Number(n) || 6; i > 0; i--) {
      var x = new Date(d.getFullYear(), d.getMonth() - (i - 1), 1);
      months.push(x.getFullYear() + '-' + pad(x.getMonth() + 1, 2));
    }
    var map = {};
    months.forEach(function (m) { map[m] = 0; });
    (Store.get('orders') || []).forEach(function (o) {
      var m = String(o.date).slice(0, 7);
      if (m in map) map[m] = round2(map[m] + o.total);
    });
    return { ok: true, months: months, sales: months.map(function (m) { return map[m]; }) };
  }

  /* ---------- 渲染 ---------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    return '¥' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function chartHtml() {
    var data = monthlySales(6);
    var max = Math.max.apply(null, data.sales.concat([0]));
    return '<div class="chart">' + data.months.map(function (m, i) {
      var h = max > 0 ? Math.max(Math.round(data.sales[i] / max * 100), 1) : 1;
      return '<div class="bar"><span class="bar-val">' + (data.sales[i] ? money(data.sales[i]) : '') + '</span>' +
        '<i style="height:' + h + '%" role="img" aria-label="' + esc(m) + ' 销售额 ' + money(data.sales[i]) + '"></i>' +
        '<span>' + esc(m) + '</span></div>';
    }).join('') + '</div>';
  }

  function recentHtml() {
    var rows = (Store.get('orders') || []).slice().reverse().slice(0, 10);
    if (!rows.length) return '<p class="empty">还没有订单。</p>';
    return '<div class="table-wrap"><table class="table"><thead><tr><th>单号</th><th>日期</th>' +
      '<th>类型</th><th class="num">金额</th><th>状态</th></tr></thead><tbody>' +
      rows.map(function (o) {
        return '<tr><td><code>' + esc(o.id) + '</code></td><td>' + esc(o.date) + '</td>' +
          '<td>' + esc(o.type || '销售') + '</td><td class="num">' + money(o.total) + '</td>' +
          '<td><span class="badge ' + (o.status === '已完成' ? 'badge-ok' : 'badge-warn') + '">' + esc(o.status) + '</span></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function render(el) {
    if (!el || typeof document === 'undefined') return;
    var t = todayStats();
    var top = topSellers(thisMonth(), 5);
    var low = root.PSInventory.lowStock();

    var cards =
      '<div class="stat-card"><div class="stat-label">今日销售额</div><div class="stat-value">' + money(t.sales) + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">今日订单</div><div class="stat-value">' + t.orderCount + '</div>' +
      '<div class="muted small">客单价 ' + money(t.avg) + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">今日毛利</div><div class="stat-value">' + money(t.profit) + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">库存总值（按进价）</div><div class="stat-value">' + money(root.PSInventory.stockValue()) + '</div></div>';

    var topRows = top.rows.length ? '<ol class="plain-list">' + top.rows.map(function (r, i) {
      return '<li>' + (i + 1) + '. ' + esc(r.name) + ' × ' + r.qty + '（' + money(r.sales) + '）</li>';
    }).join('') + '</ol>' : '<p class="empty">本月暂无销售。</p>';

    var lowRows = low.length
      ? low.map(function (p) {
        return '<a class="link-btn" href="#inventory">' + esc(p.name) +
          '（库存 ' + p.stock + '）</a>';
      }).join('<br>')
      : '暂无低库存商品。';

    el.innerHTML =
      '<div class="page"><div class="page-head"><h1>看板</h1><span class="muted">' + esc(t.date) + '</span></div>' +
      '<div class="stat-grid">' + cards + '</div>' +
      '<div class="dash-grid">' +
      '<div class="card"><h2>畅销榜 Top5（' + esc(top.month) + '）</h2>' + topRows + '</div>' +
      '<div class="card"><h2>低库存预警（<a href="#inventory">去库存页</a>）</h2>' + lowRows + '</div>' +
      '</div>' +
      '<div class="card"><h2>月销售额（近 6 个月）</h2>' + chartHtml() + '</div>' +
      '<div class="card"><h2>最近 10 笔订单</h2>' + recentHtml() + '</div>' +
      '</div>';
  }

  root.PSDashboard = {
    today: todayStats, topSellers: topSellers, profit: profit,
    monthlySales: monthlySales, render: render
  };
  root.renderDashboard = render;
})(typeof window !== 'undefined' ? window : globalThis);
