/* 库存模块：逻辑 + 渲染。全局 window.PSInventory */
(function (root) {
  'use strict';

  var Store = root.PhoneStore;
  var PHONE = '手机';

  function products() { return Store.get('products'); }
  function imeis() { return Store.get('imeis'); }
  function fail(reason) { return { ok: false, reason: reason }; }
  function findProduct(id) {
    return products().filter(function (p) { return p.id === id; })[0] || null;
  }
  function findImei(imei) {
    var key = String(imei == null ? '' : imei).trim();
    return imeis().filter(function (r) { return r.imei === key; })[0] || null;
  }
  function isMoney(n) { return typeof n === 'number' && isFinite(n) && n > 0; }

  /* ---------- 逻辑 ---------- */

  function search(q) {
    var kw = String(q == null ? '' : q).trim().toLowerCase();
    if (!kw) return products().slice();
    return products().filter(function (p) {
      return [p.name, p.brand, p.model].some(function (v) {
        return String(v || '').toLowerCase().indexOf(kw) !== -1;
      });
    });
  }

  function list(filter) {
    filter = filter || {};
    var rows = search(filter.keyword);
    if (filter.category) {
      rows = rows.filter(function (p) { return p.category === filter.category; });
    }
    return rows;
  }

  function addProduct(p) {
    p = p || {};
    var name = String(p.name || '').trim();
    var brand = String(p.brand || '').trim();
    var category = String(p.category || '').trim();
    var cost = Number(p.costPrice);
    var price = Number(p.price);
    if (!name) return fail('请填写商品名称');
    if (!brand) return fail('请填写品牌');
    if (!category) return fail('请选择分类');
    if (!isMoney(cost)) return fail('进价须为大于 0 的数字');
    if (!isMoney(price)) return fail('售价须为大于 0 的数字');
    if (price <= cost) return fail('售价须高于进价');

    // 手机必须通过采购收货逐台录串号入库，新增时库存固定为 0
    var stock = 0;
    if (category !== PHONE && p.stock !== undefined && p.stock !== '') {
      stock = Number(p.stock);
      if (!(stock >= 0) || Math.floor(stock) !== stock) return fail('初始库存须为非负整数');
    }

    var max = 0;
    products().forEach(function (x) {
      var n = parseInt(String(x.id).replace(/\D/g, ''), 10);
      if (n > max) max = n;
    });
    var num = String(max + 1);
    while (num.length < 3) num = '0' + num;

    var product = {
      id: 'P' + num, name: name, brand: brand, model: String(p.model || '').trim(),
      category: category, costPrice: cost, price: price, stock: stock
    };
    products().push(product);
    Store.save();
    return { ok: true, product: product };
  }

  function updatePrice(productId, newPrice) {
    var p = findProduct(productId);
    var price = Number(newPrice);
    if (!p) return fail('商品不存在');
    if (!isMoney(price)) return fail('售价须为大于 0 的数字');
    if (price <= p.costPrice) return fail('售价须高于进价');
    if (price === p.price) return fail('新售价与原售价相同');
    var log = { productId: p.id, oldPrice: p.price, newPrice: price, at: new Date().toISOString() };
    var logs = Store.get('priceLogs');
    if (!logs) { logs = []; Store.set('priceLogs', logs); }
    logs.push(log);
    p.price = price;
    Store.save();
    return { ok: true, log: log };
  }

  function stockValue() {
    return products().reduce(function (sum, p) { return sum + p.costPrice * p.stock; }, 0);
  }

  function lowStock(threshold) {
    var t = threshold === undefined ? 5 : Number(threshold);
    return products().filter(function (p) { return p.stock < t; });
  }

  // 返回 '在库' / '已售' / '维修中'，查不到返回 null
  function imeiStatus(imei) {
    var r = findImei(imei);
    return r ? r.status : null;
  }

  function moveImei(imei, from, to, delta) {
    var r = findImei(imei);
    if (!r) return fail('串号不存在');
    if (r.status !== from) return fail('串号当前状态为“' + r.status + '”，不能操作');
    var p = findProduct(r.productId);
    if (!p) return fail('串号对应的商品不存在');
    if (p.stock + delta < 0) return fail('库存不足');
    r.status = to;
    p.stock += delta;
    Store.save();
    return { ok: true, imei: r, product: p };
  }

  function sellImei(imei) { return moveImei(imei, '在库', '已售', -1); }
  function returnImei(imei) { return moveImei(imei, '已售', '在库', 1); }

  // 收银占单：在库 → 已锁定（不扣库存，防重卖）；结账失败释放，成功确认出库
  function lockImei(imei) { return moveImei(imei, '在库', '已锁定', 0); }
  function releaseImei(imei) { return moveImei(imei, '已锁定', '在库', 0); }
  function confirmSellImei(imei) { return moveImei(imei, '已锁定', '已售', -1); }

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
  function threshold() {
    var s = Store.get('settings') || {};
    return s.lowStockThreshold > 0 ? s.lowStockThreshold : 5;
  }

  function statusBadge(p, t) {
    if (p.stock <= 0) return '<span class="badge badge-danger">缺货</span>';
    if (p.stock < t) return '<span class="badge badge-warn">低库存</span>';
    return '<span class="badge badge-ok">正常</span>';
  }

  function imeiBadge(status) {
    var cls = status === '在库' ? 'badge-ok' : status === '已售' ? 'badge-muted' : 'badge-warn';
    return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
  }

  function detailHtml(p) {
    var html = '<div class="detail">';
    if (p.category === PHONE) {
      var rows = imeis().filter(function (r) { return r.productId === p.id; });
      html += '<h3>串号（IMEI）列表 · 共 ' + rows.length + ' 条</h3>';
      html += rows.length
        ? '<ul class="imei-list">' + rows.map(function (r) {
          return '<li><code>' + esc(r.imei) + '</code>' + imeiBadge(r.status) + '</li>';
        }).join('') + '</ul>'
        : '<p class="muted">暂无串号，采购收货后自动登记。</p>';
    } else {
      html += '<p class="muted">配件不登记串号。</p>';
    }
    html += '<form class="inline-form" data-form="price" data-id="' + esc(p.id) + '">' +
      '<div class="field"><label for="inv-price-' + esc(p.id) + '">新售价（元）</label>' +
      '<input id="inv-price-' + esc(p.id) + '" name="price" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(p.price) + '" required></div>' +
      '<button type="submit" class="btn btn-secondary">调价</button></form></div>';
    return html;
  }

  function tableHtml(ui) {
    var rows = list({ keyword: ui.keyword, category: ui.category });
    var t = threshold();
    if (!rows.length) return '<p class="empty">没有符合条件的商品。</p>';
    var body = rows.map(function (p) {
      var open = ui.expanded === p.id;
      var cls = p.stock < t ? ' class="row-low"' : '';
      var tr = '<tr data-id="' + esc(p.id) + '"' + cls + '>' +
        '<td><button type="button" class="link-btn" aria-expanded="' + open + '">' +
        (open ? '▾ ' : '▸ ') + esc(p.name) + '</button>' +
        (p.model ? '<div class="muted small">' + esc(p.model) + '</div>' : '') + '</td>' +
        '<td>' + esc(p.brand) + '</td>' +
        '<td class="num">' + money(p.costPrice) + '</td>' +
        '<td class="num">' + money(p.price) + '</td>' +
        '<td class="num">' + p.stock + '</td>' +
        '<td>' + statusBadge(p, t) + '</td></tr>';
      if (open) tr += '<tr class="row-detail"><td colspan="6">' + detailHtml(p) + '</td></tr>';
      return tr;
    }).join('');
    return '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>名称</th><th>品牌</th><th class="num">进价</th><th class="num">售价</th>' +
      '<th class="num">库存</th><th>状态</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="muted small">共 ' + rows.length + ' 个商品；库存低于 ' + t + ' 的行标为橙色。点商品名称可展开串号与调价。</p>';
  }

  function categoryOptions(selected) {
    var cats = [];
    products().forEach(function (p) { if (cats.indexOf(p.category) === -1) cats.push(p.category); });
    return '<option value="">全部分类</option>' + cats.map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === selected ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
  }

  function addFormHtml() {
    return '<form class="card form-card" data-form="add" novalidate>' +
      '<h2>新增商品</h2><div class="form-grid">' +
      '<div class="field"><label for="inv-add-name">名称（必填）</label><input id="inv-add-name" name="name" type="text" autocomplete="off"></div>' +
      '<div class="field"><label for="inv-add-brand">品牌（必填）</label><input id="inv-add-brand" name="brand" type="text" autocomplete="off"></div>' +
      '<div class="field"><label for="inv-add-model">型号 / 规格</label><input id="inv-add-model" name="model" type="text" autocomplete="off"></div>' +
      '<div class="field"><label for="inv-add-category">分类（必填）</label><select id="inv-add-category" name="category"><option value="手机">手机</option><option value="配件">配件</option></select></div>' +
      '<div class="field"><label for="inv-add-cost">进价（元，必填）</label><input id="inv-add-cost" name="costPrice" type="number" inputmode="decimal" min="0" step="0.01"></div>' +
      '<div class="field"><label for="inv-add-price">售价（元，必填）</label><input id="inv-add-price" name="price" type="number" inputmode="decimal" min="0" step="0.01"></div>' +
      '<div class="field"><label for="inv-add-stock">初始库存（仅配件）</label><input id="inv-add-stock" name="stock" type="number" inputmode="numeric" min="0" step="1" value="0"></div>' +
      '</div><p class="muted small">手机须通过“采购”收货逐台录入串号入库，新增时库存为 0。</p>' +
      '<div class="actions"><button type="submit" class="btn btn-primary">保存商品</button>' +
      '<button type="button" class="btn btn-secondary" data-action="toggle-add">取消</button></div></form>';
  }

  function renderInventory(el) {
    if (!el || typeof document === 'undefined') return;
    var ui = { keyword: '', category: '', expanded: null, adding: false };
    var wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.innerHTML =
      '<div class="page-head"><h1>库存管理</h1>' +
      '<button type="button" class="btn btn-primary" data-action="toggle-add">新增商品</button></div>' +
      '<div data-slot="add"></div>' +
      '<div class="card"><div class="toolbar">' +
      '<div class="field"><label for="inv-search">搜索商品</label>' +
      '<input id="inv-search" type="search" placeholder="名称 / 品牌 / 型号" autocomplete="off"></div>' +
      '<div class="field"><label for="inv-category">分类筛选</label>' +
      '<select id="inv-category">' + categoryOptions('') + '</select></div>' +
      '</div><div data-slot="table"></div></div>';
    el.innerHTML = '';
    el.appendChild(wrap);

    var slotTable = wrap.querySelector('[data-slot="table"]');
    var slotAdd = wrap.querySelector('[data-slot="add"]');
    var selCategory = wrap.querySelector('#inv-category');

    function drawTable() { slotTable.innerHTML = tableHtml(ui); }
    function drawAdd() { slotAdd.innerHTML = ui.adding ? addFormHtml() : ''; }
    drawTable();

    wrap.addEventListener('input', function (e) {
      if (e.target.id === 'inv-search') { ui.keyword = e.target.value; drawTable(); }
    });
    wrap.addEventListener('change', function (e) {
      if (e.target.id === 'inv-category') { ui.category = e.target.value; drawTable(); }
    });
    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action="toggle-add"]');
      if (btn) {
        ui.adding = !ui.adding;
        drawAdd();
        if (ui.adding) wrap.querySelector('#inv-add-name').focus();
        return;
      }
      if (e.target.closest('.row-detail')) return;
      var tr = e.target.closest('tr[data-id]');
      if (tr) {
        ui.expanded = ui.expanded === tr.getAttribute('data-id') ? null : tr.getAttribute('data-id');
        drawTable();
      }
    });
    wrap.addEventListener('submit', function (e) {
      e.preventDefault();
      var form = e.target;
      var kind = form.getAttribute('data-form');
      var res;
      if (kind === 'add') {
        res = addProduct({
          name: form.elements.name.value, brand: form.elements.brand.value,
          model: form.elements.model.value, category: form.elements.category.value,
          costPrice: form.elements.costPrice.value, price: form.elements.price.value,
          stock: form.elements.stock.value
        });
        if (!res.ok) return toast(res.reason, 'error');
        ui.adding = false;
        drawAdd();
        selCategory.innerHTML = categoryOptions(ui.category);
        drawTable();
        toast('已新增商品：' + res.product.name, 'success');
      } else if (kind === 'price') {
        res = updatePrice(form.getAttribute('data-id'), form.elements.price.value);
        if (!res.ok) return toast(res.reason, 'error');
        drawTable();
        toast('已调价：' + money(res.log.oldPrice) + ' → ' + money(res.log.newPrice), 'success');
      }
    });
  }

  root.PSInventory = {
    list: list, search: search, addProduct: addProduct, updatePrice: updatePrice,
    stockValue: stockValue, lowStock: lowStock, imeiStatus: imeiStatus,
    sellImei: sellImei, returnImei: returnImei, lockImei: lockImei,
    releaseImei: releaseImei, confirmSellImei: confirmSellImei,
    renderInventory: renderInventory
  };
  root.renderInventory = renderInventory;
})(typeof window !== 'undefined' ? window : globalThis);
