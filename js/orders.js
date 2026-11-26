/* 订单 + 退货 + 以旧换新。全局 window.PSOrders */
(function (root) {
  'use strict';

  var Store = root.PhoneStore;
  var PHONE = '手机';

  function fail(reason) { return { ok: false, reason: reason }; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function byId(key, id) {
    return (Store.get(key) || []).filter(function (x) { return x.id === id; })[0] || null;
  }
  function pad(n, len) {
    var s = String(n);
    while (s.length < len) s = '0' + s;
    return s;
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  }

  /* ---------- 逻辑 ---------- */

  function list(filter) {
    filter = filter || {};
    var rows = (Store.get('orders') || []).slice().reverse(); // 新单在前
    if (filter.date) rows = rows.filter(function (o) { return o.date === filter.date; });
    if (filter.staffId) rows = rows.filter(function (o) { return o.staffId === filter.staffId; });
    if (filter.payMethod) rows = rows.filter(function (o) { return o.payMethod === filter.payMethod; });
    if (filter.keyword) {
      var kw = String(filter.keyword).trim().toLowerCase();
      if (kw) rows = rows.filter(function (o) {
        if (String(o.id).toLowerCase().indexOf(kw) !== -1) return true;
        var c = o.customerId ? byId('customers', o.customerId) : null;
        return !!(c && String(c.name).toLowerCase().indexOf(kw) !== -1);
      });
    }
    return rows;
  }

  function get(orderId) {
    return byId('orders', orderId);
  }

  function refunds() {
    var r = Store.get('refunds');
    if (!r) { r = []; Store.set('refunds', r); }
    return r;
  }

  // 订单里还没退掉的部分：手机按串号逐台，配件按数量
  function refundable(order) {
    var phones = [], accs = {};
    order.items.forEach(function (it) {
      if (it.imei) {
        if (!(order.refunded || []).some(function (r) { return r.imei === it.imei; })) {
          phones.push({ productId: it.productId, name: it.name, imei: it.imei, price: it.price });
        }
      } else {
        accs[it.productId] = accs[it.productId] ||
          { productId: it.productId, name: it.name, price: it.price, sold: 0, refundedQty: 0 };
        accs[it.productId].sold += it.qty;
      }
    });
    (order.refunded || []).forEach(function (r) {
      if (!r.imei && accs[r.productId]) accs[r.productId].refundedQty += r.qty;
    });
    var accList = Object.keys(accs).map(function (k) {
      var a = accs[k];
      a.remaining = a.sold - a.refundedQty;
      return a;
    }).filter(function (a) { return a.remaining > 0; });
    return { phones: phones, accessories: accList };
  }

  function nextRefundId() {
    var day = today().replace(/-/g, '');
    var max = 0;
    refunds().forEach(function (r) {
      if (String(r.id).indexOf('TH' + day) === 0) {
        var n = parseInt(String(r.id).slice(('TH' + day).length), 10);
        if (n > max) max = n;
      }
    });
    return 'TH' + day + pad(max + 1, 3);
  }

  /*
   * 退货。items 为空 / null 时整单退；否则部分退：
   *   - 手机：[{productId, imei}]，串号回库（在库）
   *   - 配件：[{productId, qty}]
   * 退款金额按原价退；订单状态改 已退货 / 部分退货，写 state.refunds。
   */
  function refund(orderId, items, reason) {
    var order = get(orderId);
    if (!order) return fail('订单不存在');
    if (order.status === '已退货') return fail('订单已整单退货');
    if (!String(reason || '').trim()) return fail('请填写退货原因');

    var avail = refundable(order);
    var plan = []; // [{productId, name, imei?, qty, price}]
    if (items === null || items === undefined || !items.length) {
      avail.phones.forEach(function (p) { plan.push({ productId: p.productId, name: p.name, imei: p.imei, qty: 1, price: p.price }); });
      avail.accessories.forEach(function (a) { plan.push({ productId: a.productId, name: a.name, qty: a.remaining, price: a.price }); });
      if (!plan.length) return fail('订单里没有可退的商品');
    } else {
      var accDemand = {};
      for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        if (it.imei) {
          var phone = avail.phones.filter(function (p) { return p.imei === String(it.imei).trim(); })[0];
          if (!phone) return fail('串号不在本单或已退货：' + it.imei);
          plan.push({ productId: phone.productId, name: phone.name, imei: phone.imei, qty: 1, price: phone.price });
        } else {
          var acc = avail.accessories.filter(function (a) { return a.productId === it.productId; })[0];
          if (!acc) return fail('该配件不在本单或已退完：' + it.productId);
          var qty = Number(it.qty === undefined ? 1 : it.qty);
          if (!(qty > 0) || Math.floor(qty) !== qty) return fail(acc.name + ' 退货数量须为正整数');
          accDemand[it.productId] = (accDemand[it.productId] || 0) + qty;
          if (accDemand[it.productId] > acc.remaining) {
            return fail(acc.name + ' 可退数量只剩 ' + acc.remaining);
          }
          plan.push({ productId: acc.productId, name: acc.name, qty: qty, price: acc.price });
        }
      }
    }

    var amount = round2(plan.reduce(function (s, p) { return s + p.price * p.qty; }, 0));

    // 校验完毕，落库
    var Inv = root.PSInventory;
    plan.forEach(function (p) {
      if (p.imei) {
        var r = Inv.returnImei(p.imei); // 已售 → 在库，库存 +1
        if (!r.ok) throw new Error(r.reason);
      } else {
        var product = byId('products', p.productId);
        if (product) product.stock += p.qty;
      }
      (order.refunded = order.refunded || []).push({
        productId: p.productId, qty: p.qty, imei: p.imei || '', amount: round2(p.price * p.qty)
      });
    });

    var allRefunded = refundable(order).phones.length === 0 &&
      refundable(order).accessories.length === 0;
    order.status = allRefunded ? '已退货' : '部分退货';

    var record = {
      id: nextRefundId(), orderId: order.id, items: plan,
      amount: amount, reason: String(reason).trim(),
      at: new Date().toISOString(), date: today(), staffId: order.staffId
    };
    refunds().push(record);
    Store.save();
    return { ok: true, refund: record, order: order };
  }

  /* ---------- 以旧换新估价（只算钱，不入库） ---------- */

  var CONDITION_K = { '全新': 1.0, '良好': 0.8, '一般': 0.6, '差': 0.35 };
  var BRAND_BASE = { 'Apple': 6000, '华为': 5500, '三星': 5500, '小米': 4000, 'OPPO': 3800, 'vivo': 3800, '荣耀': 3700, '其他': 2500 };
  var YEAR_DECAY = 0.8; // 每年折旧 20%

  function tradeInQuote(input) {
    input = input || {};
    var brand = String(input.brand || '').trim();
    var condition = String(input.condition || '').trim();
    var year = Number(input.purchaseYear);
    if (!brand) return fail('请选择旧机品牌');
    if (!(condition in CONDITION_K)) return fail('成色须为：全新 / 良好 / 一般 / 差');
    var nowYear = new Date().getFullYear();
    if (!(year > 1999 && year <= nowYear)) return fail('购买年份不对（须在 2000 年到今年之间）');

    var base = BRAND_BASE[brand] || BRAND_BASE['其他'];
    var age = nowYear - year;
    var value = base * Math.pow(YEAR_DECAY, age) * CONDITION_K[condition];
    value = round2(value);
    var low = Math.max(Math.round(value * 0.85), 0);
    var high = Math.round(value * 1.1);
    var suggest = Math.round(value * 0.95);
    return {
      ok: true, brand: brand, model: String(input.model || '').trim(),
      condition: condition, purchaseYear: year,
      low: low, high: high, suggest: suggest, value: value
    };
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
  function toast(msg, type) {
    if (typeof root.PSToast === 'function') root.PSToast(msg, type);
  }
  function staffName(id) {
    var s = byId('staff', id);
    return s ? s.name : id;
  }
  function statusBadge(status) {
    var cls = status === '已完成' ? 'badge-ok'
      : status === '部分退货' ? 'badge-warn'
      : status === '已退货' ? 'badge-danger' : 'badge-muted';
    return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
  }

  function detailHtml(order) {
    var avail = refundable(order);
    var html = '<div class="detail"><h3>订单明细 · ' + esc(order.id) + '</h3>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>退</th><th>商品</th>' +
      '<th class="num">数量</th><th class="num">单价</th><th class="num">小计</th></tr></thead><tbody>' +
      order.items.map(function (it, i) {
        var check = '';
        if (it.imei) {
          check = avail.phones.some(function (p) { return p.imei === it.imei; })
            ? '<input type="checkbox" name="refund-item" value="p:' + esc(it.imei) + '" aria-label="退货 ' + esc(it.name) + ' 串号 ' + esc(it.imei) + '">'
            : '<span class="muted small">已退</span>';
        } else {
          var acc = avail.accessories.filter(function (a) { return a.productId === it.productId; })[0];
          check = acc
            ? '<input type="checkbox" name="refund-item" value="a:' + esc(it.productId) + '" aria-label="退货 ' + esc(it.name) + '"> 可退 ' + acc.remaining
            : '<span class="muted small">已退</span>';
        }
        return '<tr><td>' + check + '</td><td>' + esc(it.name) +
          (it.imei ? '<div class="muted small">IMEI ' + esc(it.imei) + '</div>' : '') + '</td>' +
          '<td class="num">' + it.qty + '</td><td class="num">' + money(it.price) + '</td>' +
          '<td class="num">' + money(it.price * it.qty) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<dl class="pos-totals">' +
      '<dt>应付</dt><dd>' + money(order.total) + '</dd>' +
      '<dt>支付方式</dt><dd>' + esc(order.payMethod) + '</dd>' +
      (order.change ? '<dt>找零</dt><dd>' + money(order.change) + '</dd>' : '') +
      (order.discount ? '<dt>整单优惠</dt><dd>−' + money(order.discount) + '</dd>' : '') +
      (order.tradeIn ? '<dt>以旧换新抵扣</dt><dd>−' + money(order.tradeIn) + '</dd>' : '') +
      '</dl>';

    if ((order.refunded || []).length) {
      html += '<h3>已退货记录</h3><ul class="plain-list">' + order.refunded.map(function (r) {
        var p = byId('products', r.productId);
        return '<li>' + esc(p ? p.name : r.productId) + ' × ' + r.qty +
          (r.imei ? '（IMEI ' + esc(r.imei) + '）' : '') + '，退 ' + money(r.amount) + '</li>';
      }).join('') + '</ul>';
    }

    var canRefund = avail.phones.length || avail.accessories.length;
    if (canRefund) {
      html += '<form class="inline-form" data-form="refund" data-id="' + esc(order.id) + '" style="max-width:520px">' +
        '<div class="field" style="flex:2"><label for="ord-reason-' + esc(order.id) + '">退货原因（必填）</label>' +
        '<input id="ord-reason-' + esc(order.id) + '" name="reason" type="text" autocomplete="off"></div>' +
        '<button type="submit" class="btn btn-danger">退勾选商品</button></form>' +
        '<p class="muted small">不勾选直接提交 = 整单退货；手机退回后串号自动回库。</p>';
    }
    return html + '</div>';
  }

  function listHtml(ui) {
    var rows = list({
      date: ui.date, staffId: ui.staffId,
      payMethod: ui.payMethod, keyword: ui.keyword
    });
    if (!rows.length) return '<p class="empty">没有符合条件的订单。</p>';
    var body = rows.map(function (o) {
      var tr = '<tr data-id="' + esc(o.id) + '"><td><button type="button" class="link-btn" aria-expanded="' + (ui.open === o.id) + '">' +
        esc(o.id) + '</button></td><td>' + esc(o.date) + '</td><td>' + esc(staffName(o.staffId)) + '</td>' +
        '<td class="num">' + money(o.total) + '</td><td>' + esc(o.payMethod) + '</td>' +
        '<td>' + statusBadge(o.status) + '</td></tr>';
      if (ui.open === o.id) tr += '<tr class="row-detail"><td colspan="6">' + detailHtml(o) + '</td></tr>';
      return tr;
    }).join('');
    return '<div class="table-wrap"><table class="table"><thead><tr><th>单号</th><th>日期</th>' +
      '<th>店员</th><th class="num">金额</th><th>支付方式</th><th>状态</th></tr></thead><tbody>' +
      body + '</tbody></table></div><p class="muted small">共 ' + rows.length + ' 单。点单号展开明细与退货。</p>';
  }

  function quoteWidgetHtml(ui) {
    var brands = [];
    (Store.get('products') || []).forEach(function (p) {
      if (p.category === PHONE && brands.indexOf(p.brand) === -1) brands.push(p.brand);
    });
    ['Apple', '华为', '三星', '小米', 'OPPO', 'vivo', '荣耀'].forEach(function (b) {
      if (brands.indexOf(b) === -1) brands.push(b);
    });
    var y = new Date().getFullYear(), years = [];
    for (var i = 0; i <= 12; i++) years.push(y - i);
    return '<form class="detail" data-form="quote"><div class="form-grid">' +
      '<div class="field"><label for="ti-brand">旧机品牌</label><select id="ti-brand" name="brand">' +
      brands.concat('其他').map(function (b) { return '<option value="' + esc(b) + '">' + esc(b) + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label for="ti-model">型号</label><input id="ti-model" name="model" type="text" autocomplete="off" placeholder="例如 iPhone 13"></div>' +
      '<div class="field"><label for="ti-condition">成色</label><select id="ti-condition" name="condition">' +
      ['全新', '良好', '一般', '差'].map(function (c) {
        return '<option value="' + c + '"' + (c === '良好' ? ' selected' : '') + '>' + c + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label for="ti-year">购买年份</label><select id="ti-year" name="purchaseYear">' +
      years.map(function (yy) { return '<option value="' + yy + '"' + (yy === y - 2 ? ' selected' : '') + '>' + yy + ' 年</option>'; }).join('') +
      '</select></div></div>' +
      '<div class="actions"><button type="submit" class="btn btn-primary">估价</button>' +
      '<span data-slot="quote">' + (ui.quote ? '估价 <strong>' + money(ui.quote.low) + ' ~ ' + money(ui.quote.high) +
        '</strong>，建议回收价 <strong>' + money(ui.quote.suggest) + '</strong>' : '') + '</span></div>' +
      '<p class="muted small">估价只做参考，不入库；收银抵扣请到“收银”页用以旧换新。</p></form>';
  }

  function renderOrders(el) {
    if (!el || typeof document === 'undefined') return;
    var ui = { date: '', staffId: '', payMethod: '', keyword: '', open: null, quote: null };
    var wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.innerHTML =
      '<div class="page-head"><h1>订单与退货</h1></div>' +
      '<div class="card"><div class="toolbar" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.5fr)">' +
      '<div class="field"><label for="ord-date">按日期</label><input id="ord-date" type="date"></div>' +
      '<div class="field"><label for="ord-staff">按店员</label><select id="ord-staff"><option value="">全部店员</option>' +
      (Store.get('staff') || []).map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label for="ord-pay">按支付方式</label><select id="ord-pay"><option value="">全部</option>' +
      ['现金', '微信', '支付宝', '刷卡', '储值'].map(function (m) { return '<option value="' + m + '">' + m + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label for="ord-kw">搜订单号 / 会员名</label><input id="ord-kw" type="search" autocomplete="off"></div>' +
      '</div><div data-slot="list"></div></div>' +
      '<div class="card"><h2>以旧换新估价</h2><div data-slot="quote"></div></div>';
    el.innerHTML = '';
    el.appendChild(wrap);

    var slotList = wrap.querySelector('[data-slot="list"]');
    var slotQuote = wrap.querySelector('[data-slot="quote"]');

    function drawList() { slotList.innerHTML = listHtml(ui); }
    function drawQuote() { slotQuote.innerHTML = quoteWidgetHtml(ui); }
    drawList(); drawQuote();

    wrap.addEventListener('input', function (e) {
      if (e.target.id === 'ord-kw') { ui.keyword = e.target.value; drawList(); }
    });
    wrap.addEventListener('change', function (e) {
      if (e.target.id === 'ord-date') ui.date = e.target.value;
      else if (e.target.id === 'ord-staff') ui.staffId = e.target.value;
      else if (e.target.id === 'ord-pay') ui.payMethod = e.target.value;
      else return;
      drawList();
    });
    wrap.addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-id]');
      var btn = e.target.closest('.link-btn');
      if (btn && tr) {
        var id = tr.getAttribute('data-id');
        ui.open = ui.open === id ? null : id;
        drawList();
      }
    });
    wrap.addEventListener('submit', function (e) {
      e.preventDefault();
      var form = e.target;
      var kind = form.getAttribute('data-form');
      if (kind === 'quote') {
        var q = tradeInQuote({
          brand: form.elements.brand.value, model: form.elements.model.value,
          condition: form.elements.condition.value, purchaseYear: form.elements.purchaseYear.value
        });
        if (!q.ok) return toast(q.reason, 'error');
        ui.quote = q;
        drawQuote();
      } else if (kind === 'refund') {
        var scope = form.closest('tr');
        var checks = Array.prototype.filter.call(
          scope.querySelectorAll('input[name="refund-item"]:checked'),
          function (c) { return c.value; }
        );
        var items = checks.map(function (c) {
          var v = c.value.slice(2);
          return c.value.charAt(0) === 'p' ? { imei: v } : { productId: v, qty: 1 };
        });
        var res = refund(form.getAttribute('data-id'), items, form.elements.reason.value);
        if (!res.ok) return toast(res.reason, 'error');
        drawList();
        toast('已退货 ' + money(res.refund.amount) + '（' + res.refund.id + '）', 'success');
      }
    });
  }

  root.PSOrders = {
    list: list, get: get, refund: refund, tradeInQuote: tradeInQuote,
    renderOrders: renderOrders
  };
  root.renderOrders = renderOrders;
})(typeof window !== 'undefined' ? window : globalThis);
