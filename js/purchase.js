/* 采购模块：逻辑 + 渲染。全局 window.PSPurchase */
(function (root) {
  'use strict';

  var Store = root.PhoneStore;
  var PHONE = '手机';

  function fail(reason) { return { ok: false, reason: reason }; }
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

  function list() {
    // 新单在前
    return Store.get('purchases').slice().reverse();
  }

  function nextId(day) {
    var prefix = 'CG' + day.replace(/-/g, '');
    var max = 0;
    Store.get('purchases').forEach(function (p) {
      if (String(p.id).indexOf(prefix) === 0) {
        var n = parseInt(String(p.id).slice(prefix.length), 10);
        if (n > max) max = n;
      }
    });
    return prefix + pad(max + 1, 3);
  }

  function create(input) {
    input = input || {};
    if (!byId('suppliers', input.supplierId)) return fail('请选择供应商');
    if (!Array.isArray(input.items) || !input.items.length) return fail('请至少添加一行商品');

    var items = [];
    var total = 0;
    for (var i = 0; i < input.items.length; i++) {
      var it = input.items[i] || {};
      var line = '第 ' + (i + 1) + ' 行：';
      var product = byId('products', it.productId);
      var qty = Number(it.qty);
      var cost = Number(it.costPrice);
      if (!product) return fail(line + '请选择商品');
      if (!(qty > 0) || Math.floor(qty) !== qty) return fail(line + '数量须为正整数');
      if (!(cost > 0) || !isFinite(cost)) return fail(line + '进价须为大于 0 的数字');
      items.push({ productId: product.id, qty: qty, costPrice: cost });
      total += qty * cost;
    }

    var day = today();
    var purchase = {
      id: nextId(day), supplierId: input.supplierId, items: items,
      total: Math.round(total * 100) / 100, status: '待收货', createdAt: day, receivedAt: null
    };
    Store.get('purchases').push(purchase);
    Store.save();
    return { ok: true, purchase: purchase };
  }

  // 采购单里每款手机需要录入的串号数量：[{productId, name, qty}]
  function phoneNeeds(purchase) {
    var needs = [];
    purchase.items.forEach(function (it) {
      var p = byId('products', it.productId);
      if (!p || p.category !== PHONE) return;
      var hit = needs.filter(function (n) { return n.productId === p.id; })[0];
      if (hit) hit.qty += it.qty;
      else needs.push({ productId: p.id, name: p.name, qty: it.qty });
    });
    return needs;
  }

  /*
   * 收货入库。imeiList 两种写法都行：
   *   - 数组：['86...', ...]，按采购单里手机行的顺序依次分配
   *   - 对象：{ 商品ID: ['86...', ...] }，一张单多款手机时用
   */
  function receive(purchaseId, imeiList) {
    var purchase = byId('purchases', purchaseId);
    if (!purchase) return fail('采购单不存在');
    if (purchase.status !== '待收货') return fail('该采购单已收货，不能重复收货');
    for (var i = 0; i < purchase.items.length; i++) {
      if (!byId('products', purchase.items[i].productId)) return fail('采购单里有商品已不存在');
    }

    var needs = phoneNeeds(purchase);
    var clean = function (arr) {
      return (arr || []).map(function (s) { return String(s).trim(); })
        .filter(function (s) { return s !== ''; });
    };
    var groups = {};
    if (Array.isArray(imeiList) || imeiList == null) {
      var flat = clean(imeiList);
      var totalNeed = needs.reduce(function (s, n) { return s + n.qty; }, 0);
      if (flat.length !== totalNeed) {
        return fail('串号数量不对：需要 ' + totalNeed + ' 个，实际录入 ' + flat.length + ' 个');
      }
      var pos = 0;
      needs.forEach(function (n) { groups[n.productId] = flat.slice(pos, pos + n.qty); pos += n.qty; });
    } else {
      for (var k = 0; k < needs.length; k++) {
        var got = clean(imeiList[needs[k].productId]);
        if (got.length !== needs[k].qty) {
          return fail(needs[k].name + ' 串号数量不对：需要 ' + needs[k].qty + ' 个，实际录入 ' + got.length + ' 个');
        }
        groups[needs[k].productId] = got;
      }
    }

    var existing = {};
    Store.get('imeis').forEach(function (r) { existing[r.imei] = true; });
    var seen = {};
    var pids = Object.keys(groups);
    for (var g = 0; g < pids.length; g++) {
      var arr = groups[pids[g]];
      for (var j = 0; j < arr.length; j++) {
        if (!/^\d{15}$/.test(arr[j])) return fail('串号格式不对（须为 15 位数字）：' + arr[j]);
        if (seen[arr[j]]) return fail('串号重复录入：' + arr[j]);
        if (existing[arr[j]]) return fail('串号已存在于系统中：' + arr[j]);
        seen[arr[j]] = true;
      }
    }

    // 全部校验通过后再落库
    purchase.items.forEach(function (it) { byId('products', it.productId).stock += it.qty; });
    var imeis = Store.get('imeis');
    pids.forEach(function (pid) {
      groups[pid].forEach(function (imei) {
        imeis.push({ imei: imei, productId: pid, status: '在库', purchaseId: purchase.id });
      });
    });
    purchase.status = '已收货';
    purchase.receivedAt = today();
    Store.save();
    return { ok: true, purchase: purchase };
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
  function supplierName(id) {
    var s = byId('suppliers', id);
    return s ? s.name : '（已删除）';
  }
  function productName(id) {
    var p = byId('products', id);
    return p ? p.name : '（已删除）';
  }

  function receiveHtml(purchase) {
    var needs = phoneNeeds(purchase);
    var pid = esc(purchase.id);
    var html = '<form class="detail" data-form="receive" data-id="' + pid + '"><h3>收货入库 · ' + pid + '</h3>' +
      '<ul class="plain-list">' + purchase.items.map(function (it) {
        return '<li>' + esc(productName(it.productId)) + ' × ' + it.qty + '，进价 ' + money(it.costPrice) + '</li>';
      }).join('') + '</ul>';
    if (!needs.length) html += '<p class="muted">本单没有手机，无需录入串号。</p>';
    needs.forEach(function (n) {
      var id = 'pur-imei-' + pid + '-' + esc(n.productId);
      html += '<div class="field"><label for="' + id + '">' + esc(n.name) + ' 串号（需 ' + n.qty +
        ' 个，每行一个，15 位数字）</label><textarea id="' + id + '" data-product="' + esc(n.productId) +
        '" rows="' + Math.min(Math.max(n.qty, 2), 8) + '" inputmode="numeric" autocomplete="off"></textarea></div>';
    });
    return html + '<div class="actions"><button type="submit" class="btn btn-primary">确认收货</button>' +
      '<button type="button" class="btn btn-secondary" data-action="receive" data-id="' + pid + '">取消</button></div></form>';
  }

  function listHtml(ui) {
    var rows = list();
    if (!rows.length) return '<p class="empty">还没有采购单。</p>';
    var body = rows.map(function (p) {
      var pending = p.status === '待收货';
      var tr = '<tr><td><code>' + esc(p.id) + '</code></td><td>' + esc(supplierName(p.supplierId)) + '</td>' +
        '<td class="num">' + money(p.total) + '</td>' +
        '<td><span class="badge ' + (pending ? 'badge-warn' : 'badge-ok') + '">' + esc(p.status) + '</span></td>' +
        '<td>' + esc(p.createdAt) + '</td><td>' +
        (pending ? '<button type="button" class="btn btn-secondary btn-sm" data-action="receive" data-id="' +
          esc(p.id) + '">收货</button>' : '') + '</td></tr>';
      if (pending && ui.receiving === p.id) {
        tr += '<tr class="row-detail"><td colspan="6">' + receiveHtml(p) + '</td></tr>';
      }
      return tr;
    }).join('');
    return '<div class="table-wrap"><table class="table"><thead><tr><th>单号</th><th>供应商</th>' +
      '<th class="num">金额</th><th>状态</th><th>日期</th><th>操作</th></tr></thead><tbody>' +
      body + '</tbody></table></div>';
  }

  function itemRowHtml(n) {
    var opts = '<option value="">请选择商品</option>' + Store.get('products').map(function (p) {
      return '<option value="' + esc(p.id) + '" data-cost="' + esc(p.costPrice) + '">' +
        esc(p.name) + '（' + esc(p.category) + '）</option>';
    }).join('');
    return '<div class="item-row" data-row>' +
      '<div class="field"><label for="pur-product-' + n + '">商品</label><select id="pur-product-' + n + '" data-f="productId">' + opts + '</select></div>' +
      '<div class="field"><label for="pur-qty-' + n + '">数量</label><input id="pur-qty-' + n + '" data-f="qty" type="number" inputmode="numeric" min="1" step="1" value="1"></div>' +
      '<div class="field"><label for="pur-cost-' + n + '">进价（元）</label><input id="pur-cost-' + n + '" data-f="costPrice" type="number" inputmode="decimal" min="0" step="0.01"></div>' +
      '<button type="button" class="btn btn-danger btn-sm" data-action="remove-row">删除此行</button></div>';
  }

  function createFormHtml() {
    var opts = '<option value="">请选择供应商</option>' + Store.get('suppliers').map(function (s) {
      return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>';
    }).join('');
    return '<form class="card form-card" data-form="create" novalidate><h2>新建采购单</h2>' +
      '<div class="field"><label for="pur-supplier">供应商</label><select id="pur-supplier" name="supplierId">' + opts + '</select></div>' +
      '<div data-slot="rows"></div>' +
      '<div class="actions"><button type="button" class="btn btn-secondary" data-action="add-row">添加一行商品</button>' +
      '<span class="total">合计：<strong data-slot="total">¥0.00</strong></span></div>' +
      '<div class="actions"><button type="submit" class="btn btn-primary">提交采购单</button>' +
      '<button type="button" class="btn btn-secondary" data-action="toggle-create">取消</button></div></form>';
  }

  function renderPurchase(el) {
    if (!el || typeof document === 'undefined') return;
    var ui = { creating: false, receiving: null, rowSeq: 0 };
    var wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.innerHTML =
      '<div class="page-head"><h1>采购管理</h1>' +
      '<button type="button" class="btn btn-primary" data-action="toggle-create">新建采购单</button></div>' +
      '<div data-slot="create"></div><div class="card"><h2>采购单列表</h2><div data-slot="list"></div></div>';
    el.innerHTML = '';
    el.appendChild(wrap);

    var slotList = wrap.querySelector('[data-slot="list"]');
    var slotCreate = wrap.querySelector('[data-slot="create"]');

    function drawList() { slotList.innerHTML = listHtml(ui); }
    function addRow() {
      ui.rowSeq += 1;
      wrap.querySelector('[data-slot="rows"]').insertAdjacentHTML('beforeend', itemRowHtml(ui.rowSeq));
    }
    function readItems() {
      return Array.prototype.map.call(wrap.querySelectorAll('[data-row]'), function (row) {
        return {
          productId: row.querySelector('[data-f="productId"]').value,
          qty: row.querySelector('[data-f="qty"]').value,
          costPrice: row.querySelector('[data-f="costPrice"]').value
        };
      });
    }
    function drawTotal() {
      var slot = wrap.querySelector('[data-slot="total"]');
      if (!slot) return;
      var sum = readItems().reduce(function (s, it) {
        var v = Number(it.qty) * Number(it.costPrice);
        return s + (isFinite(v) && v > 0 ? v : 0);
      }, 0);
      slot.textContent = money(sum);
    }
    function drawCreate() {
      slotCreate.innerHTML = ui.creating ? createFormHtml() : '';
      if (ui.creating) { addRow(); drawTotal(); }
    }
    drawList();

    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      if (action === 'toggle-create') {
        ui.creating = !ui.creating;
        drawCreate();
        if (ui.creating) wrap.querySelector('#pur-supplier').focus();
      } else if (action === 'add-row') {
        addRow();
      } else if (action === 'remove-row') {
        if (wrap.querySelectorAll('[data-row]').length <= 1) return toast('至少保留一行商品', 'error');
        btn.closest('[data-row]').remove();
        drawTotal();
      } else if (action === 'receive') {
        var id = btn.getAttribute('data-id');
        ui.receiving = ui.receiving === id ? null : id;
        drawList();
      }
    });
    wrap.addEventListener('change', function (e) {
      // 选了商品自动带出进价
      if (e.target.getAttribute('data-f') === 'productId') {
        var opt = e.target.options[e.target.selectedIndex];
        var cost = opt ? opt.getAttribute('data-cost') : '';
        if (cost) e.target.closest('[data-row]').querySelector('[data-f="costPrice"]').value = cost;
      }
      drawTotal();
    });
    wrap.addEventListener('input', drawTotal);
    wrap.addEventListener('submit', function (e) {
      e.preventDefault();
      var form = e.target;
      var kind = form.getAttribute('data-form');
      var res;
      if (kind === 'create') {
        res = create({ supplierId: form.elements.supplierId.value, items: readItems() });
        if (!res.ok) return toast(res.reason, 'error');
        ui.creating = false;
        drawCreate();
        drawList();
        toast('已创建采购单 ' + res.purchase.id + '，合计 ' + money(res.purchase.total), 'success');
      } else if (kind === 'receive') {
        var groups = {};
        Array.prototype.forEach.call(form.querySelectorAll('textarea[data-product]'), function (ta) {
          groups[ta.getAttribute('data-product')] = ta.value.split(/\r?\n/);
        });
        res = receive(form.getAttribute('data-id'), groups);
        if (!res.ok) return toast(res.reason, 'error');
        ui.receiving = null;
        drawList();
        toast('采购单 ' + res.purchase.id + ' 已收货入库', 'success');
      }
    });
  }

  root.PSPurchase = { list: list, create: create, receive: receive, renderPurchase: renderPurchase };
  root.renderPurchase = renderPurchase;
})(typeof window !== 'undefined' ? window : globalThis);
