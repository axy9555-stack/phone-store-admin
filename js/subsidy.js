/* 国补模块（国家以旧换新 / 消费品补贴）。全局 window.PSSubsidy */
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

  /* ---------- 规则 ---------- */

  function defaultRules() {
    return { rate: 0.15, cap: 500, maxPrice: 6000, perPersonLimit: 1 };
  }

  // rules() 返回当前规则；rules(patch) 校验并更新
  function rules(patch) {
    var settings = Store.get('settings');
    if (!settings) { settings = {}; Store.set('settings', settings); }
    if (!settings.subsidy) {
      settings.subsidy = defaultRules();
      Store.save();
    }
    if (!patch) return JSON.parse(JSON.stringify(settings.subsidy));

    var next = JSON.parse(JSON.stringify(settings.subsidy));
    if (patch.rate !== undefined) {
      var rate = Number(patch.rate);
      if (!(rate > 0) || rate > 0.5) return fail('补贴比例须在 0 ~ 50% 之间');
      next.rate = rate;
    }
    if (patch.cap !== undefined) {
      var cap = Number(patch.cap);
      if (!(cap > 0) || cap > 2000) return fail('单件补贴上限须在 0 ~ 2000 元之间');
      next.cap = cap;
    }
    if (patch.maxPrice !== undefined) {
      var mp = Number(patch.maxPrice);
      if (!(mp > 0) || mp > 20000) return fail('可补售价上限须在 0 ~ 20000 元之间');
      next.maxPrice = mp;
    }
    if (patch.perPersonLimit !== undefined) {
      var ppl = Number(patch.perPersonLimit);
      if (!(ppl >= 1) || Math.floor(ppl) !== ppl || ppl > 10) return fail('每人限补件数须为 1 ~ 10 的整数');
      next.perPersonLimit = ppl;
    }
    settings.subsidy = next;
    Store.save();
    return { ok: true, rules: JSON.parse(JSON.stringify(next)) };
  }

  /* ---------- 资格校验 ---------- */

  // 同一身份证号：存在非“已驳回”的记录即视为已享受过
  function usedCount(idNumber) {
    return (Store.get('subsidies') || []).filter(function (r) {
      return r.idNumber === idNumber && r.status !== '已驳回';
    }).length;
  }

  function checkEligibility(input) {
    input = input || {};
    var r = rules();
    var product = byId('products', input.productId);
    if (!product) return fail('商品不存在');
    if (product.category !== PHONE) return fail('只有手机类商品可享国补');
    if (product.price > r.maxPrice) return fail('售价超 ' + r.maxPrice + ' 不可补');
    var idNumber = String(input.idNumber || '').trim().toUpperCase();
    if (!/^\d{17}[\dX]$/.test(idNumber)) return fail('身份证号须为 18 位（末位可为 X）');
    if (usedCount(idNumber) >= (r.perPersonLimit || 1)) {
      return fail('该身份证已享受过国补');
    }
    var amount = round2(Math.min(product.price * r.rate, r.cap));
    return {
      ok: true, amount: amount, productId: product.id,
      productName: product.name, price: product.price, idNumber: idNumber
    };
  }

  /* ---------- 购物车 ---------- */

  // 把国补挂到购物车（只允许一台手机享国补），与整单优惠 / 以旧换新可叠加
  function applyToCart(cart, input) {
    input = input || {};
    if (!cart || !Array.isArray(cart.items)) return fail('购物车无效');
    if (cart.subsidy) return fail('购物车已有国补，先移除再申请');
    var name = String(input.customerName || '').trim();
    if (!name) return fail('请填写客户姓名');
    var el = checkEligibility({ productId: input.productId, idNumber: input.idNumber, customerName: name });
    if (!el.ok) return el;

    var line = cart.items.filter(function (it) {
      return it.productId === input.productId && (!input.imei || it.imei === String(input.imei).trim());
    })[0];
    if (!line) return fail('购物车里没有这台手机，无法享受国补');

    cart.subsidy = {
      productId: input.productId, imei: line.imei || '',
      customerName: name, idNumber: el.idNumber, amount: el.amount
    };
    var t = root.PSPOS ? root.PSPOS.cartTotal(cart) : null;
    return { ok: true, subsidy: cart.subsidy, totals: t };
  }

  // 从购物车移除国补（收银页“移除”按钮用）
  function removeFromCart(cart) {
    if (!cart) return fail('购物车无效');
    cart.subsidy = null;
    return { ok: true, totals: root.PSPOS ? root.PSPOS.cartTotal(cart) : null };
  }

  /* ---------- 记录与结算 ---------- */

  function records() {
    var s = Store.get('subsidies');
    if (!s) { s = []; Store.set('subsidies', s); }
    return s;
  }

  function list(filter) {
    filter = filter || {};
    var rows = records().slice().reverse(); // 新记录在前
    if (filter.status) rows = rows.filter(function (r) { return r.status === filter.status; });
    if (filter.date) rows = rows.filter(function (r) { return r.createdAt === filter.date; });
    if (filter.keyword) {
      var kw = String(filter.keyword).trim().toLowerCase();
      if (kw) rows = rows.filter(function (r) {
        return [r.customerName, r.idNumber, r.imei, r.orderId].some(function (v) {
          return String(v || '').toLowerCase().indexOf(kw) !== -1;
        });
      });
    }
    return rows;
  }

  function bySubId(id) {
    return records().filter(function (r) { return r.id === id; })[0] || null;
  }

  function submit(subsidyId) {
    var r = bySubId(subsidyId);
    if (!r) return fail('国补记录不存在');
    if (r.status !== '待申报') return fail('只有“待申报”的记录能申报（当前：' + r.status + '）');
    r.status = '已申报';
    r.submittedAt = today();
    Store.save();
    return { ok: true, record: r };
  }

  function settle(subsidyId) {
    var r = bySubId(subsidyId);
    if (!r) return fail('国补记录不存在');
    if (r.status !== '已申报') return fail('只有“已申报”的记录能到账（当前：' + r.status + '）');
    r.status = '已到账';
    r.settledAt = today();
    Store.save();
    return { ok: true, record: r };
  }

  // 驳回：写原因，该身份证可重新申请（资格校验只看非“已驳回”记录）
  function reject(subsidyId, reason) {
    var r = bySubId(subsidyId);
    if (!r) return fail('国补记录不存在');
    if (r.status !== '待申报' && r.status !== '已申报') {
      return fail('只有“待申报 / 已申报”的记录能驳回（当前：' + r.status + '）');
    }
    if (!String(reason || '').trim()) return fail('请填写驳回原因');
    r.status = '已驳回';
    r.rejectReason = String(reason).trim();
    Store.save();
    return { ok: true, record: r };
  }

  // 待结算总额：待申报 + 已申报
  function pendingAmount() {
    return round2(records().reduce(function (sum, r) {
      return sum + (r.status === '待申报' || r.status === '已申报' ? r.amount : 0);
    }, 0));
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
  // 证件号脱敏：只露后 4 位
  function maskId(id) {
    var s = String(id || '');
    if (s.length <= 4) return s;
    return s.slice(0, 3) + '*'.repeat(s.length - 7) + s.slice(-4);
  }
  function statusBadge(status) {
    var cls = status === '已到账' ? 'badge-ok'
      : status === '已驳回' ? 'badge-danger'
      : status === '已申报' ? 'badge-warn' : 'badge-warn';
    return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
  }
  function productName(id) {
    var p = byId('products', id);
    return p ? p.name : '—';
  }

  function rulesCardHtml(ui) {
    var r = rules();
    return '<form class="detail" data-form="rules"><h3>国补规则</h3>' +
      '<dl class="pos-totals">' +
      '<dt>补贴比例</dt><dd>' + Math.round(r.rate * 100) + '%</dd>' +
      '<dt>单件上限</dt><dd>' + money(r.cap) + '</dd>' +
      '<dt>可补售价上限</dt><dd>' + money(r.maxPrice) + '</dd>' +
      '<dt>每人限补</dt><dd>每类 ' + (r.perPersonLimit || 1) + ' 件（按身份证号）</dd></dl>' +
      '<div class="form-grid">' +
      '<div class="field"><label for="sb-rate">补贴比例（%）</label><input id="sb-rate" name="rate" type="number" inputmode="decimal" min="0" max="50" step="0.1" value="' + esc(r.rate * 100) + '"></div>' +
      '<div class="field"><label for="sb-cap">单件上限（元）</label><input id="sb-cap" name="cap" type="number" inputmode="decimal" min="0" max="2000" step="1" value="' + esc(r.cap) + '"></div>' +
      '<div class="field"><label for="sb-max">可补售价上限（元）</label><input id="sb-max" name="maxPrice" type="number" inputmode="decimal" min="0" max="20000" step="1" value="' + esc(r.maxPrice) + '"></div>' +
      '<div class="field"><label for="sb-ppl">每人限补（件）</label><input id="sb-ppl" name="perPersonLimit" type="number" inputmode="numeric" min="1" max="10" step="1" value="' + esc(r.perPersonLimit || 1) + '"></div>' +
      '</div><div class="actions"><button type="submit" class="btn btn-secondary">保存规则</button>' +
      '<span class="muted small">比例 0–50%，上限 0–2000 元，限价 0–20000 元。</span></div></form>';
  }

  function detailHtml(r) {
    var canReject = r.status === '待申报' || r.status === '已申报';
    return '<div class="detail"><h3>国补记录 ' + esc(r.id) + '</h3>' +
      '<dl class="pos-totals">' +
      '<dt>客户</dt><dd>' + esc(r.customerName) + '（' + esc(maskId(r.idNumber)) + '）</dd>' +
      '<dt>手机</dt><dd>' + esc(productName(r.productId)) + (r.imei ? ' · <code>' + esc(r.imei) + '</code>' : '') + '</dd>' +
      '<dt>关联订单</dt><dd>' + (r.orderId ? '<code>' + esc(r.orderId) + '</code>' : '—') + '</dd>' +
      '<dt>补贴金额</dt><dd>' + money(r.amount) + '</dd>' +
      '<dt>创建日期</dt><dd>' + esc(r.createdAt) + '</dd>' +
      (r.submittedAt ? '<dt>申报日期</dt><dd>' + esc(r.submittedAt) + '</dd>' : '') +
      (r.settledAt ? '<dt>到账日期</dt><dd>' + esc(r.settledAt) + '</dd>' : '') +
      (r.rejectReason ? '<dt>驳回原因</dt><dd>' + esc(r.rejectReason) + '</dd>' : '') + '</dl>' +
      (canReject
        ? '<form class="inline-form" data-form="reject" data-id="' + esc(r.id) + '" style="max-width:520px">' +
          '<div class="field" style="flex:2"><label for="sb-rej-' + esc(r.id) + '">驳回原因（必填）</label>' +
          '<input id="sb-rej-' + esc(r.id) + '" name="reason" type="text" autocomplete="off"></div>' +
          '<button type="submit" class="btn btn-danger">驳回</button></form>' +
          '<p class="muted small">驳回后该身份证可重新申请国补。</p>'
        : '');
  }

  function listHtml(ui) {
    var rows = list({ status: ui.status, keyword: ui.keyword });
    var pending = pendingAmount();
    var html = '<div class="stat-grid" style="margin-bottom:16px">' +
      '<div class="stat-card"><div class="stat-label">待结算总额（待申报 + 已申报）</div>' +
      '<div class="stat-value">' + money(pending) + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">记录数</div><div class="stat-value">' + rows.length + '</div></div></div>';
    if (!rows.length) return html + '<p class="empty">没有符合条件的国补记录。</p>';
    var body = rows.map(function (r) {
      var open = ui.open === r.id;
      var ops = [];
      if (r.status === '待申报') ops.push('<button type="button" class="btn btn-secondary btn-sm" data-action="submit" data-id="' + esc(r.id) + '">申报</button>');
      if (r.status === '已申报') ops.push('<button type="button" class="btn btn-secondary btn-sm" data-action="settle" data-id="' + esc(r.id) + '">到账</button>');
      if (r.status === '待申报' || r.status === '已申报') ops.push('<button type="button" class="btn btn-danger btn-sm" data-action="reject" data-id="' + esc(r.id) + '">驳回</button>');
      var tr = '<tr data-id="' + esc(r.id) + '"><td><button type="button" class="link-btn" aria-expanded="' + open + '">' +
        esc(r.id) + '</button></td><td>' + esc(r.customerName) + '</td>' +
        '<td><code>' + esc(maskId(r.idNumber)) + '</code></td>' +
        '<td>' + esc(productName(r.productId)) + '</td>' +
        '<td class="num">' + money(r.amount) + '</td>' +
        '<td>' + statusBadge(r.status) + '</td>' +
        '<td>' + esc(r.createdAt) + '</td>' +
        '<td>' + (ops.length ? '<span class="row-ops">' + ops.join('') + '</span>' : '') + '</td></tr>';
      if (open) tr += '<tr class="row-detail"><td colspan="8">' + detailHtml(r) + '</td></tr>';
      return tr;
    }).join('');
    return html +
      '<div class="table-wrap"><table class="table"><thead><tr><th>单号</th><th>客户</th><th>证件号</th>' +
      '<th>手机</th><th class="num">补贴</th><th>状态</th><th>日期</th><th>操作</th></tr></thead><tbody>' +
      body + '</tbody></table></div>' +
      '<p class="muted small">补贴由商家垫付：结账后自动生成“待申报”，向政府申报 → 到账核销。点单号看详情与驳回。</p>';
  }

  function renderSubsidy(el) {
    if (!el || typeof document === 'undefined') return;
    var ui = { status: '', keyword: '', open: null };
    var wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.innerHTML =
      '<div class="page-head"><h1>国补管理</h1>' +
      '<div class="toolbar" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">' +
      '<div class="field"><label for="sb-kw">搜客户 / 证件号 / 串号</label><input id="sb-kw" type="search" autocomplete="off"></div>' +
      '<div class="field"><label for="sb-status">状态筛选</label><select id="sb-status"><option value="">全部</option>' +
      ['待申报', '已申报', '已到账', '已驳回'].map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join('') +
      '</select></div></div></div>' +
      '<div class="card"><h2>国补记录</h2><div data-slot="list"></div></div>' +
      '<div class="card" data-slot="rules"></div>';
    el.innerHTML = '';
    el.appendChild(wrap);

    var slotList = wrap.querySelector('[data-slot="list"]');
    var slotRules = wrap.querySelector('[data-slot="rules"]');
    function drawList() { slotList.innerHTML = listHtml(ui); }
    function drawRules() { slotRules.innerHTML = rulesCardHtml(ui); }
    drawList(); drawRules();

    wrap.addEventListener('input', function (e) {
      if (e.target.id === 'sb-kw') { ui.keyword = e.target.value; drawList(); }
    });
    wrap.addEventListener('change', function (e) {
      if (e.target.id === 'sb-status') { ui.status = e.target.value; ui.open = null; drawList(); }
    });
    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (btn) {
        var action = btn.getAttribute('data-action');
        var id = btn.getAttribute('data-id');
        var res;
        if (action === 'submit') {
          res = submit(id);
          if (!res.ok) return toast(res.reason, 'error');
          drawList();
          toast('已申报：' + res.record.id, 'success');
          return;
        } else if (action === 'settle') {
          res = settle(id);
          if (!res.ok) return toast(res.reason, 'error');
          drawList();
          toast('已到账：' + res.record.id + '（' + money(res.record.amount) + '）', 'success');
          return;
        } else if (action === 'reject') {
          ui.open = ui.open === id ? null : id; // 展开驳回原因表单
          drawList();
          return;
        }
      }
      if (e.target.closest('.row-detail') || e.target.closest('button') || e.target.closest('input')) return;
      var tr = e.target.closest('tr[data-id]');
      if (tr) {
        ui.open = ui.open === tr.getAttribute('data-id') ? null : tr.getAttribute('data-id');
        drawList();
      }
    });
    wrap.addEventListener('submit', function (e) {
      e.preventDefault();
      var form = e.target;
      var kind = form.getAttribute('data-form');
      if (kind === 'reject') {
        var res = reject(form.getAttribute('data-id'), form.elements.reason.value);
        if (!res.ok) return toast(res.reason, 'error');
        ui.open = null;
        drawList();
        toast('已驳回，该身份证可重新申请', 'success');
      } else if (kind === 'rules') {
        var r = rules({
          rate: Number(form.elements.rate.value) / 100,
          cap: form.elements.cap.value,
          maxPrice: form.elements.maxPrice.value,
          perPersonLimit: form.elements.perPersonLimit.value
        });
        if (!r.ok) return toast(r.reason, 'error');
        drawRules(); drawList();
        toast('国补规则已保存', 'success');
      }
    });
  }

  root.PSSubsidy = {
    rules: rules, checkEligibility: checkEligibility, applyToCart: applyToCart,
    removeFromCart: removeFromCart, list: list, submit: submit,
    settle: settle, reject: reject, pendingAmount: pendingAmount,
    renderSubsidy: renderSubsidy
  };
  root.renderSubsidy = renderSubsidy;
})(typeof window !== 'undefined' ? window : globalThis);
