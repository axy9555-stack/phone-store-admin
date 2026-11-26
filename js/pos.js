/* 收银台（POS）：逻辑 + 渲染。全局 window.PSPOS */
(function (root) {
  'use strict';

  var Store = root.PhoneStore;
  var PHONE = '手机';
  var PAY_METHODS = ['现金', '微信', '支付宝', '刷卡', '储值'];

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

  function newCart(staffId) {
    var staff = byId('staff', staffId) || (Store.get('staff') || [])[0] || null;
    return { staffId: staff ? staff.id : '', items: [], discount: null, tradeIn: null, subsidy: null };
  }

  function findLine(cart, productId, imei) {
    var idx = -1;
    cart.items.forEach(function (it, i) {
      if (it.productId !== productId) return;
      if (imei ? it.imei === imei : !it.imei) idx = i;
    });
    return idx;
  }

  function addItem(cart, productId, qty, imei) {
    if (!cart || !Array.isArray(cart.items)) return fail('购物车无效');
    var product = byId('products', productId);
    if (!product) return fail('商品不存在');
    qty = Number(qty === undefined ? 1 : qty);
    if (!(qty > 0) || Math.floor(qty) !== qty) return fail('数量须为正整数');

    if (product.category === PHONE) {
      if (qty !== 1) return fail('手机须逐台选购，一次加一台');
      var res = Store.get ? root.PSInventory.lockImei(imei) : fail('库存模块不可用');
      if (!res.ok) return res; // 串号不存在/不是在库/已被锁定，都不允许占单
      cart.items.push({ productId: product.id, qty: 1, imei: res.imei.imei });
      return { ok: true, item: cart.items[cart.items.length - 1] };
    }

    var idx = findLine(cart, product.id, null);
    var cur = idx >= 0 ? cart.items[idx].qty : 0;
    if (cur + qty > product.stock) return fail(product.name + ' 库存不足（当前在库 ' + product.stock + '）');
    if (idx >= 0) cart.items[idx].qty += qty;
    else cart.items.push({ productId: product.id, qty: qty });
    return { ok: true, item: idx >= 0 ? cart.items[idx] : cart.items[cart.items.length - 1] };
  }

  function setQty(cart, index, qty) {
    if (!cart || !Array.isArray(cart.items)) return fail('购物车无效');
    var it = cart.items[index];
    if (!it) return fail('购物车里没有这一行');
    var product = byId('products', it.productId);
    if (!product) return fail('商品不存在');
    if (product.category === PHONE) {
      if (Number(qty) !== 1) return fail('手机每行固定 1 台，换台请先删再加');
      return { ok: true, item: it };
    }
    qty = Number(qty);
    if (!(qty > 0) || Math.floor(qty) !== qty) return fail('数量须为正整数');
    if (qty > product.stock) return fail(product.name + ' 库存不足（当前在库 ' + product.stock + '）');
    it.qty = qty;
    return { ok: true, item: it };
  }

  function removeItem(cart, index) {
    if (!cart || !Array.isArray(cart.items)) return fail('购物车无效');
    var it = cart.items[index];
    if (!it) return fail('购物车里没有这一行');
    if (it.imei) root.PSInventory.releaseImei(it.imei); // 释放占单
    cart.items.splice(index, 1);
    return { ok: true };
  }

  // 释放整车的占单串号（清空购物车 / 放弃结账时用）
  function releaseCart(cart) {
    if (!cart || !Array.isArray(cart.items)) return { ok: true };
    cart.items.slice().forEach(function (it, i) { removeItem(cart, i); });
    cart.discount = null;
    cart.tradeIn = null;
    cart.subsidy = null;
    return { ok: true };
  }

  function linePrice(it) {
    var p = byId('products', it.productId);
    return p ? p.price : 0;
  }
  function lineCost(it) {
    var p = byId('products', it.productId);
    return p ? p.costPrice : 0;
  }

  function cartTotal(cart) {
    var subtotal = 0, cost = 0;
    (cart.items || []).forEach(function (it) {
      subtotal += linePrice(it) * it.qty;
      cost += lineCost(it) * it.qty;
    });
    subtotal = round2(subtotal);
    cost = round2(cost);
    var discount = 0;
    if (cart.discount && cart.discount.type === 'amount') discount = Number(cart.discount.value) || 0;
    if (cart.discount && cart.discount.type === 'percent') discount = subtotal * (1 - Number(cart.discount.value) / 100);
    discount = Math.min(round2(discount), subtotal);
    var afterDisc = round2(subtotal - discount);
    var tradeIn = cart.tradeIn ? Math.min(Number(cart.tradeIn.deduct) || 0, afterDisc) : 0;
    tradeIn = round2(tradeIn);
    var subsidy = cart.subsidy ? Math.min(Number(cart.subsidy.amount) || 0, afterDisc - tradeIn) : 0;
    subsidy = round2(Math.max(subsidy, 0));
    return {
      subtotal: subtotal, cost: cost,
      discount: discount, tradeIn: tradeIn, subsidy: subsidy,
      total: round2(Math.max(afterDisc - tradeIn - subsidy, 0))
    };
  }

  function applyDiscount(cart, d) {
    if (!cart) return fail('购物车无效');
    if (!d || (d.type !== 'amount' && d.type !== 'percent')) return fail('折扣类型须为 amount 或 percent');
    var value = Number(d.value);
    if (!(value > 0) || !isFinite(value)) return fail('优惠金额 / 折扣须为大于 0 的数字');
    if (d.type === 'percent' && value >= 100) return fail('折扣须小于 100%');
    var prev = cart.discount;
    cart.discount = { type: d.type, value: value };
    var t = cartTotal(cart);
    if (t.total < t.cost) {
      cart.discount = prev;
      return fail('折后价（' + t.total + ' 元）不能低于成本总价（' + t.cost + ' 元）');
    }
    return { ok: true, totals: t };
  }

  /*
   * 以旧换新抵扣。tradeIn 可以是：
   *   - 数字：直接当抵扣金额
   *   - tradeInQuote() 的结果：{brand, model, condition, purchaseYear, suggest, ...}，按建议回收价抵扣
   *   - {brand, ..., deduct: 金额}
   * 传 null / false 清除抵扣。
   */
  function applyTradeIn(cart, tradeIn) {
    if (!cart) return fail('购物车无效');
    if (tradeIn === null || tradeIn === false || tradeIn === undefined) {
      cart.tradeIn = null;
      return { ok: true, totals: cartTotal(cart) };
    }
    var info = {};
    var deduct;
    if (typeof tradeIn === 'number') deduct = tradeIn;
    else if (typeof tradeIn === 'object') {
      ['brand', 'model', 'condition', 'purchaseYear'].forEach(function (k) {
        if (tradeIn[k] !== undefined) info[k] = tradeIn[k];
      });
      if (tradeIn.deduct !== undefined) deduct = Number(tradeIn.deduct);
      else if (tradeIn.suggest !== undefined) deduct = Number(tradeIn.suggest);
      else return fail('请先估价或直接给抵扣金额');
    } else return fail('抵扣参数不对');
    if (!(deduct > 0) || !isFinite(deduct)) return fail('抵扣金额须为大于 0 的数字');
    var prev = cart.tradeIn;
    cart.tradeIn = info;
    cart.tradeIn.deduct = deduct;
    return { ok: true, totals: cartTotal(cart) };
  }

  function nextOrderId(day) {
    var prefix = 'XS' + day.replace(/-/g, '');
    var max = 0;
    Store.get('orders').forEach(function (o) {
      if (String(o.id).indexOf(prefix) === 0) {
        var n = parseInt(String(o.id).slice(prefix.length), 10);
        if (n > max) max = n;
      }
    });
    return prefix + pad(max + 1, 3);
  }

  function checkout(cart, pay) {
    pay = pay || {};
    if (!cart || !Array.isArray(cart.items) || !cart.items.length) return fail('购物车是空的');
    if (!byId('staff', cart.staffId)) return fail('请选择收银店员');
    if (PAY_METHODS.indexOf(pay.payMethod) === -1) return fail('支付方式须为：' + PAY_METHODS.join(' / '));

    var t = cartTotal(cart);
    if (!cart.items.length) return fail('购物车是空的');
    if (t.total <= 0) return fail('应付金额须大于 0');

    var customer = null;
    if (pay.customerId) {
      customer = byId('customers', pay.customerId);
      if (!customer) return fail('会员不存在');
      if (pay.payMethod === '储值' && !(Number(customer.balance) >= t.total)) {
        return fail('会员余额不足（余额 ' + (customer.balance || 0) + ' 元，应付 ' + t.total + ' 元）');
      }
    }

    // 国补预检：结账时再校验一次资格（垫付前把关）
    if (cart.subsidy) {
      var subPre = root.PSSubsidy && root.PSSubsidy.checkEligibility
        ? root.PSSubsidy.checkEligibility({ productId: cart.subsidy.productId, idNumber: cart.subsidy.idNumber, customerName: cart.subsidy.customerName })
        : { ok: true };
      if (!subPre.ok) return fail('国补校验未通过：' + subPre.reason);
    }

    var paid = pay.paidAmount === undefined || pay.paidAmount === null || pay.paidAmount === ''
      ? t.total : Number(pay.paidAmount);
    if (!isFinite(paid) || paid < t.total) return fail('实收金额不能低于应付金额');
    var change = pay.payMethod === '现金' ? round2(paid - t.total) : 0;

    // 预检：所有手机串号当前都处于已锁定、且确实属于本单
    for (var i = 0; i < cart.items.length; i++) {
      var it = cart.items[i];
      var product = byId('products', it.productId);
      if (!product) return fail('购物车里有商品已不存在');
      if (product.category === PHONE) {
        var rec = (Store.get('imeis') || []).filter(function (r) { return r.imei === it.imei; })[0];
        if (!rec || rec.productId !== it.productId) return fail('串号记录异常：' + it.imei);
        if (rec.status !== '已锁定') return fail('串号不在锁定状态：' + it.imei);
      } else if (product.stock < it.qty) {
        return fail(product.name + ' 库存不足（当前在库 ' + product.stock + '）');
      }
    }

    // 校验全部通过，开始落库
    var Inv = root.PSInventory;
    var items = cart.items.map(function (it) {
      var product = byId('products', it.productId);
      if (product.category === PHONE) {
        var c = Inv.confirmSellImei(it.imei); // 已锁定 → 已售，库存 -1
        if (!c.ok) throw new Error(c.reason);
        return { productId: product.id, name: product.name, qty: 1, price: product.price, costPrice: product.costPrice, imei: it.imei };
      }
      product.stock -= it.qty;
      return { productId: product.id, name: product.name, qty: it.qty, price: product.price, costPrice: product.costPrice };
    });

    var day = today();
    var order = {
      id: nextOrderId(day), items: items,
      subtotal: t.subtotal, discount: t.discount, tradeIn: t.tradeIn,
      subsidyAmount: t.subsidy,
      total: t.total, cost: t.cost,
      payMethod: pay.payMethod, paidAmount: round2(paid), change: change,
      customerId: customer ? customer.id : '', staffId: cart.staffId,
      status: '已完成', date: day, at: new Date().toISOString(), refunded: []
    };
    if (customer) {
      // 积分 1 元 = 1 分；有会员模块时一并累计消费并自动升级等级
      if (root.PSCustomers && root.PSCustomers.recordSpend) {
        root.PSCustomers.recordSpend(customer.id, t.total);
      } else {
        customer.points = (Number(customer.points) || 0) + Math.round(t.total); // 1 元 = 1 分
      }
    }
    if (pay.payMethod === '储值' && customer) {
      customer.balance = round2(Number(customer.balance) - t.total);
    }
    Store.get('orders').push(order);
    if (cart.subsidy && t.subsidy > 0) {
      // 国补由商家垫付：写入国补记录，事后向政府申报结算
      var subRec = {
        id: nextSubsidyId(day),
        orderId: order.id,
        customerName: cart.subsidy.customerName,
        idNumber: cart.subsidy.idNumber,
        productId: cart.subsidy.productId,
        imei: cart.subsidy.imei,
        amount: t.subsidy,
        status: '待申报',
        createdAt: day, submittedAt: null, settledAt: null, rejectReason: ''
      };
      Store.get('subsidies').push(subRec);
      order.subsidyId = subRec.id;
    }
    Store.save();
    cart.items = []; cart.discount = null; cart.tradeIn = null; cart.subsidy = null; // 已结清
    return { ok: true, order: order, change: change };
  }

  function nextSubsidyId(day) {
    var prefix = 'GB' + day.replace(/-/g, '');
    var max = 0;
    (Store.get('subsidies') || []).forEach(function (r) {
      if (String(r.id).indexOf(prefix) === 0) {
        var n = parseInt(String(r.id).slice(prefix.length), 10);
        if (n > max) max = n;
      }
    });
    return prefix + pad(max + 1, 3);
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

  function inStockImeis(productId) {
    return (Store.get('imeis') || []).filter(function (r) {
      return r.productId === productId && r.status === '在库';
    });
  }

  // 购物车里的手机行（国补只针对手机）
  function phoneLines(cart) {
    return (cart.items || []).filter(function (it) {
      var p = byId('products', it.productId);
      return p && p.category === PHONE;
    });
  }

  function readSubPick(form, cart) {
    var sel = form.elements.phoneIdx;
    if (sel && sel.value) {
      var v = sel.value.split('|');
      return { productId: v[0], imei: v[1] };
    }
    var it = phoneLines(cart)[0];
    return it ? { productId: it.productId, imei: it.imei } : {};
  }

  function productHtml(p, i) {
    var disabled = '';
    var note = money(p.price);
    if (p.category === PHONE) {
      var n = inStockImeis(p.id).length;
      note = money(p.price) + ' · 在库 ' + n + ' 台';
      if (!n) disabled = ' disabled';
    } else if (p.stock <= 0) {
      disabled = ' disabled';
      note = money(p.price) + ' · 缺货';
    } else {
      note = money(p.price) + ' · 库存 ' + p.stock;
    }
    return '<li><button type="button" class="pos-product" data-add="' + esc(p.id) + '"' + disabled + '>' +
      '<span class="pos-name">' + esc(p.name) + '<span class="muted small"> ' + esc(p.brand) +
      (p.model ? ' ' + esc(p.model) : '') + '</span></span>' +
      '<span class="pos-price">' + note + '</span></button></li>';
  }

  function leftHtml(ui) {
    var rows = root.PSInventory.search(ui.keyword);
    var html =
      '<div class="field"><label for="pos-search">搜索商品（名称 / 品牌 / 型号）</label>' +
      '<input id="pos-search" type="search" placeholder="例如 iPhone / 钢化膜" autocomplete="off" value="' + esc(ui.keyword) + '"></div>' +
      '<ul class="pos-products">' + rows.map(productHtml).join('') + '</ul>';
    if (ui.picking) {
      var p = byId('products', ui.picking);
      var avail = p ? inStockImeis(p.id) : [];
      html += '<form class="detail pos-pick" data-form="pick"><h3>选择串号 · ' + esc(p ? p.name : '') + '</h3>' +
        '<div class="field"><label for="pos-pick-imei">在库串号（15 位）</label><select id="pos-pick-imei" required>' +
        avail.map(function (r) { return '<option value="' + esc(r.imei) + '">' + esc(r.imei) + '</option>'; }).join('') +
        '</select></div><div class="actions"><button type="submit" class="btn btn-primary">加入购物车</button>' +
        '<button type="button" class="btn btn-secondary" data-action="cancel-pick">取消</button></div></form>';
    }
    return html;
  }

  function cartLineHtml(it, i, product) {
    var right;
    if (product.category === PHONE) {
      right = '<span class="muted small">串号 <code>' + esc(it.imei) + '</code></span>' +
        '<button type="button" class="btn btn-danger btn-sm" data-action="remove" data-idx="' + i + '">删除</button>';
    } else {
      right = '<span class="qty-ctrl">' +
        '<button type="button" class="btn btn-secondary btn-sm" data-action="dec" data-idx="' + i + '" aria-label="减少数量">−</button>' +
        '<span class="qty">' + it.qty + '</span>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-action="inc" data-idx="' + i + '" aria-label="增加数量">＋</button></span>' +
        '<button type="button" class="btn btn-danger btn-sm" data-action="remove" data-idx="' + i + '">删除</button>';
    }
    return '<li class="pos-line"><span class="pos-line-name">' + esc(product.name) +
      '<span class="muted small"> × ' + it.qty + ' 单价 ' + money(product.price) + '</span></span>' +
      '<span class="pos-line-sum">' + money(product.price * it.qty) + '</span><span class="pos-line-ops">' + right + '</span></li>';
  }

  function rightHtml(ui) {
    var cart = ui.cart;
    var t = cartTotal(cart);
    var html = '<h2>购物车</h2>';
    if (!cart.items.length) html += '<p class="empty">还没有加商品，点左侧商品加入。</p>';
    else html += '<ul class="pos-lines">' + cart.items.map(function (it, i) {
      return cartLineHtml(it, i, byId('products', it.productId));
    }).join('') + '</ul>';

    html += '<dl class="pos-totals">' +
      '<dt>小计</dt><dd>' + money(t.subtotal) + '</dd>' +
      '<dt>整单优惠</dt><dd>' + (t.discount ? '−' + money(t.discount) : '—') +
      (cart.discount ? ' <button type="button" class="link-btn small" data-action="clear-discount">移除</button>' : '') + '</dd>' +
      '<dt>以旧换新抵扣</dt><dd>' + (t.tradeIn ? '−' + money(t.tradeIn) : '—') +
      (cart.tradeIn ? ' <button type="button" class="link-btn small" data-action="clear-tradein">移除</button>' : '') + '</dd>' +
      '<dt>国补立减</dt><dd>' + (t.subsidy ? '−' + money(t.subsidy) : '—') +
      (cart.subsidy ? ' <button type="button" class="link-btn small" data-action="clear-subsidy">移除</button>' : '') + '</dd>' +
      '<dt class="pos-pay-label">应付</dt><dd class="pos-pay">' + money(t.total) + '</dd></dl>';

    html += '<div class="pos-tools"><form class="inline-form" data-form="discount">' +
      '<div class="field"><label for="pos-disc-type">优惠方式</label><select id="pos-disc-type" name="type">' +
      '<option value="amount"' + (cart.discount && cart.discount.type === 'amount' ? ' selected' : '') + '>整单立减（元）</option>' +
      '<option value="percent"' + (cart.discount && cart.discount.type === 'percent' ? ' selected' : '') + '>整单打折（%）</option></select></div>' +
      '<div class="field"><label for="pos-disc-value">数值</label><input id="pos-disc-value" name="value" type="number" inputmode="decimal" min="0" step="0.01"></div>' +
      '<button type="submit" class="btn btn-secondary">应用优惠</button></form>' +
      '<button type="button" class="btn btn-secondary" data-action="tradein-form">以旧换新</button>' +
      '<button type="button" class="btn btn-secondary" data-action="subsidy-form"' +
      (phoneLines(cart).length ? '' : ' disabled') + '>申请国补</button></div>';

    if (ui.subsidyForm) {
      var sr = root.PSSubsidy ? root.PSSubsidy.rules() : { rate: 0.15, cap: 500, maxPrice: 6000, perPersonLimit: 1 };
      var pickOpts = phoneLines(cart).map(function (it) {
        var p = byId('products', it.productId);
        var v = esc(p.id) + '|' + esc(it.imei || '');
        return '<option value="' + v + '">' + esc(p.name) + (it.imei ? '（串号 ' + esc(it.imei) + '）' : '') + '</option>';
      }).join('');
      html += '<form class="detail" data-form="subsidy"><h3>国家以旧换新补贴（商家垫付）</h3>' +
        '<p class="muted small">单件售价 ≤ ' + sr.maxPrice + ' 元可补，补贴 = 售价 × ' + Math.round(sr.rate * 100) +
        '%（单件最高 ' + sr.cap + ' 元），每人每类限 ' + (sr.perPersonLimit || 1) + ' 件。</p>' +
        (phoneLines(cart).length > 1
          ? '<div class="field"><label for="pos-sub-phone">享受国补的手机</label><select id="pos-sub-phone" name="phoneIdx">' + pickOpts + '</select></div>'
          : '') +
        '<div class="form-grid">' +
        '<div class="field"><label for="pos-sub-name">客户姓名</label><input id="pos-sub-name" name="customerName" type="text" autocomplete="off"></div>' +
        '<div class="field"><label for="pos-sub-id">身份证号（18 位，末位可为 X）</label><input id="pos-sub-id" name="idNumber" type="text" inputmode="numeric" maxlength="18" autocomplete="off"></div>' +
        '</div><p data-slot="sub-quote" class="muted"></p>' +
        '<div class="actions"><button type="button" class="btn btn-secondary" data-action="subsidy-check">先校验</button>' +
        '<button type="submit" class="btn btn-primary">应用国补</button>' +
        '<button type="button" class="btn btn-secondary" data-action="subsidy-cancel">取消</button></div></form>';
    }

    if (ui.tradeForm) {
      html += '<form class="detail" data-form="tradein"><h3>以旧换新估价</h3><div class="form-grid">' +
        '<div class="field"><label for="pos-ti-brand">旧机品牌</label><select id="pos-ti-brand" name="brand">' +
        ['Apple', '华为', '三星', '小米', 'OPPO', 'vivo', '荣耀', '其他'].map(function (b) {
          return '<option value="' + b + '">' + b + '</option>';
        }).join('') + '</select></div>' +
        '<div class="field"><label for="pos-ti-model">型号</label><input id="pos-ti-model" name="model" type="text" autocomplete="off"></div>' +
        '<div class="field"><label for="pos-ti-condition">成色</label><select id="pos-ti-condition" name="condition">' +
        ['全新', '良好', '一般', '差'].map(function (c) {
          return '<option value="' + c + '"' + (c === '良好' ? ' selected' : '') + '>' + c + '</option>';
        }).join('') + '</select></div>' +
        '<div class="field"><label for="pos-ti-year">购买年份</label><select id="pos-ti-year" name="purchaseYear">' +
        (function () {
          var y = new Date().getFullYear(), out = [];
          for (var i = 0; i <= 12; i++) out.push('<option value="' + (y - i) + '">' + (y - i) + ' 年</option>');
          return out.join('');
        })() + '</select></div></div>' +
        '<p data-slot="ti-quote" class="muted"></p>' +
        '<div class="actions"><button type="button" class="btn btn-secondary" data-action="tradein-quote">先估价</button>' +
        '<button type="submit" class="btn btn-primary">按建议回收价抵扣</button>' +
        '<button type="button" class="btn btn-secondary" data-action="tradein-cancel">取消</button></div></form>';
    }

    var members = '<option value="">不使用会员</option>' + (Store.get('customers') || []).map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (ui.customerId === c.id ? ' selected' : '') + '>' +
        esc(c.name) + '（积分 ' + (c.points || 0) + (c.balance !== undefined ? '，余额 ' + c.balance : '') + '）</option>';
    }).join('');
    var staffOpts = (Store.get('staff') || []).map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (cart.staffId === s.id ? ' selected' : '') + '>' +
        esc(s.name) + '（' + esc(s.role) + '）</option>';
    }).join('');

    html += '<form data-form="checkout"><div class="form-grid">' +
      '<div class="field"><label for="pos-staff">收银店员</label><select id="pos-staff" name="staffId">' + staffOpts + '</select></div>' +
      '<div class="field"><label for="pos-member">会员（可积分 / 储值支付）</label><select id="pos-member" name="customerId">' + members + '</select></div></div>' +
      '<fieldset class="pay-methods"><legend>支付方式</legend>' + PAY_METHODS.map(function (m, i) {
        return '<label class="pay-label"><input type="radio" name="payMethod" value="' + m + '"' +
          (ui.payMethod === m ? ' checked' : '') + '> ' + m + '</label>';
      }).join('') + '</fieldset>' +
      '<div class="form-grid">' +
      '<div class="field"><label for="pos-paid">实收金额（元）' + (ui.payMethod === '现金' ? '，需 ≥ 应付' : '') + '</label>' +
      '<input id="pos-paid" name="paidAmount" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(ui.paid) + '"></div>' +
      '<div class="field"><label>找零</label><div class="pay-change" data-slot="change">' +
      money(ui.payMethod === '现金' && Number(ui.paid) >= t.total ? Number(ui.paid) - t.total : 0) + '</div></div></div>' +
      '<div class="actions"><button type="submit" class="btn btn-primary btn-lg"' + (cart.items.length ? '' : ' disabled') + '>结账</button>' +
      '<button type="button" class="btn btn-danger" data-action="clear-cart">清空购物车</button></div></form>';
    return html;
  }

  function receiptHtml(res) {
    var o = res.order;
    var names = { E: '' };
    var staff = byId('staff', o.staffId);
    var customer = o.customerId ? byId('customers', o.customerId) : null;
    return '<div class="receipt-wrap"><div class="receipt" id="pos-receipt">' +
      '<h2 class="receipt-title">收银小票</h2>' +
      '<p class="muted">单号 <strong>' + esc(o.id) + '</strong> · ' + esc(o.date) + '</p>' +
      '<table class="table receipt-table"><thead><tr><th>商品</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th></tr></thead><tbody>' +
      o.items.map(function (it) {
        return '<tr><td>' + esc(it.name) + (it.imei ? '<div class="muted small">IMEI ' + esc(it.imei) + '</div>' : '') + '</td>' +
          '<td class="num">' + it.qty + '</td><td class="num">' + money(it.price) + '</td><td class="num">' + money(it.price * it.qty) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<dl class="pos-totals">' +
      (o.subtotal !== o.total ? '<dt>小计</dt><dd>' + money(o.subtotal) + '</dd>' : '') +
      (o.discount ? '<dt>整单优惠</dt><dd>−' + money(o.discount) + '</dd>' : '') +
      (o.tradeIn ? '<dt>以旧换新抵扣</dt><dd>−' + money(o.tradeIn) + '</dd>' : '') +
      (o.subsidyAmount ? '<dt>国补立减</dt><dd>−' + money(o.subsidyAmount) + '</dd>' : '') +
      '<dt>应付</dt><dd>' + money(o.total) + '</dd>' +
      '<dt>实收（' + esc(o.payMethod) + '）</dt><dd>' + money(o.paidAmount) + '</dd>' +
      (o.change ? '<dt>找零</dt><dd>' + money(o.change) + '</dd>' : '') +
      '</dl>' +
      '<p class="muted small">收银：' + esc(staff ? staff.name : o.staffId) +
      (customer ? ' · 会员：' + esc(customer.name) + '（积分 +' + Math.round(o.total) + '）' : ' · 散客') + '</p>' +
      '</div><div class="actions no-print">' +
      '<button type="button" class="btn btn-primary" data-action="print">打印小票</button>' +
      '<button type="button" class="btn btn-secondary" data-action="again">再来一单</button></div></div>';
  }

  function renderPOS(el) {
    if (!el || typeof document === 'undefined') return;
    var staff0 = (Store.get('staff') || [])[0];
    var ui = {
      cart: newCart(staff0 ? staff0.id : ''), keyword: '', picking: null,
      payMethod: '现金', paid: '', customerId: '', tradeForm: false, tiQuote: null,
      subsidyForm: false, subsidyQuote: null, done: null
    };
    var wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.innerHTML = '<div data-slot="main" class="pos-grid"></div>';
    el.innerHTML = '';
    el.appendChild(wrap);
    var slot = wrap.querySelector('[data-slot="main"]');

    function drawPos() {
      ui.done = null;
      slot.innerHTML = '<div class="card"><h2>商品</h2><div data-slot="left"></div></div>' +
        '<div class="card"><div data-slot="right"></div></div>';
      drawLeft(); drawRight();
    }
    function drawReceipt() {
      slot.innerHTML = receiptHtml(ui.done);
    }
    function draw() { if (ui.done) drawReceipt(); else drawPos(); }
    function drawLeft() { slot.querySelector('[data-slot="left"]').innerHTML = leftHtml(ui); }
    function drawRight() { slot.querySelector('[data-slot="right"]').innerHTML = rightHtml(ui); }

    function readTradeForm(form) {
      return {
        brand: form.elements.brand.value, model: form.elements.model.value,
        condition: form.elements.condition.value, purchaseYear: form.elements.purchaseYear.value
      };
    }

    wrap.addEventListener('input', function (e) {
      if (e.target.id === 'pos-search') { ui.keyword = e.target.value; ui.picking = null; drawLeft(); }
      else if (e.target.name === 'paidAmount') {
        ui.paid = e.target.value;
        var t = cartTotal(ui.cart);
        var paid = Number(ui.paid);
        slot.querySelector('[data-slot="change"]').textContent =
          money(ui.payMethod === '现金' && paid >= t.total ? paid - t.total : 0);
      }
    });
    wrap.addEventListener('change', function (e) {
      if (e.target.name === 'payMethod') { ui.payMethod = e.target.value; drawRight(); }
      else if (e.target.name === 'staffId') ui.cart.staffId = e.target.value;
      else if (e.target.name === 'customerId') ui.customerId = e.target.value;
    });
    wrap.addEventListener('click', function (e) {
      var add = e.target.closest('[data-add]');
      if (add) {
        var pid = add.getAttribute('data-add');
        var p = byId('products', pid);
        if (p.category === PHONE) { ui.picking = pid; drawLeft(); return; }
        var res = addItem(ui.cart, pid, 1);
        if (!res.ok) return toast(res.reason, 'error');
        drawRight();
        return;
      }
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      if (action === 'cancel-pick') { ui.picking = null; drawLeft(); }
      else if (action === 'inc' || action === 'dec') {
        var i = Number(btn.getAttribute('data-idx'));
        var it = ui.cart.items[i];
        if (action === 'dec' && it.qty <= 1) {
          removeItem(ui.cart, i);
        } else {
          var res2 = setQty(ui.cart, i, it.qty + (action === 'inc' ? 1 : -1));
          if (!res2.ok) return toast(res2.reason, 'error');
          if (!it.qty) removeItem(ui.cart, i);
        }
        drawRight();
      } else if (action === 'remove') {
        var r = removeItem(ui.cart, Number(btn.getAttribute('data-idx')));
        if (!r.ok) return toast(r.reason, 'error');
        drawRight();
      } else if (action === 'clear-discount') { ui.cart.discount = null; drawRight(); }
      else if (action === 'clear-tradein') { ui.cart.tradeIn = null; drawRight(); }
      else if (action === 'clear-subsidy') { ui.cart.subsidy = null; ui.subsidyQuote = null; drawRight(); }
      else if (action === 'subsidy-form') {
        ui.subsidyForm = !ui.subsidyForm; ui.subsidyQuote = null; drawRight();
        if (ui.subsidyForm) wrap.querySelector('#pos-sub-name').focus();
      } else if (action === 'subsidy-cancel') { ui.subsidyForm = false; ui.subsidyQuote = null; drawRight(); }
      else if (action === 'subsidy-check') {
        if (!root.PSSubsidy) return toast('国补模块未加载', 'error');
        var sf = btn.closest('form');
        var pick = readSubPick(sf, ui.cart);
        var chk = root.PSSubsidy.checkEligibility({
          productId: pick.productId, imei: pick.imei,
          customerName: sf.elements.customerName.value, idNumber: sf.elements.idNumber.value
        });
        ui.subsidyQuote = chk;
        var subSpan = slot.querySelector('[data-slot="sub-quote"]');
        if (subSpan) subSpan.textContent = chk.ok ? '校验通过：可享国补 −' + money(chk.amount) : chk.reason;
      } else if (action === 'tradein-form') { ui.tradeForm = !ui.tradeForm; drawRight(); }
      else if (action === 'tradein-cancel') { ui.tradeForm = false; ui.tiQuote = null; drawRight(); }
      else if (action === 'tradein-quote') {
        var q = root.PSOrders.tradeInQuote(readTradeForm(btn.closest('form')));
        if (!q.ok) return toast(q.reason, 'error');
        ui.tiQuote = q;
        var span = slot.querySelector('[data-slot="ti-quote"]');
        if (span) span.textContent = '估价 ' + money(q.low) + ' ~ ' + money(q.high) +
          '，建议回收价 ' + money(q.suggest);
      } else if (action === 'clear-cart') {
        var c = releaseCart(ui.cart);
        if (!c.ok) return toast(c.reason, 'error');
        drawRight();
      } else if (action === 'print') {
        window.print();
      } else if (action === 'again') {
        ui.tradeForm = false; ui.tiQuote = null; ui.paid = ''; ui.customerId = '';
        ui.subsidyForm = false; ui.subsidyQuote = null;
        drawPos();
        slot.querySelector('#pos-search').focus();
      }
    });
    wrap.addEventListener('submit', function (e) {
      e.preventDefault();
      var form = e.target;
      var kind = form.getAttribute('data-form');
      var res;
      if (kind === 'pick') {
        res = addItem(ui.cart, ui.picking, 1, form.elements['pos-pick-imei'].value);
        if (!res.ok) return toast(res.reason, 'error');
        ui.picking = null;
        drawLeft(); drawRight();
      } else if (kind === 'discount') {
        res = applyDiscount(ui.cart, { type: form.elements.type.value, value: form.elements.value.value });
        if (!res.ok) return toast(res.reason, 'error');
        drawRight();
      } else if (kind === 'tradein') {
        if (!ui.tiQuote) return toast('请先点“先估价”', 'error');
        res = applyTradeIn(ui.cart, ui.tiQuote);
        if (!res.ok) return toast(res.reason, 'error');
        ui.tradeForm = false; ui.tiQuote = null;
        drawRight();
      } else if (kind === 'subsidy') {
        if (!root.PSSubsidy) return toast('国补模块未加载', 'error');
        var subPick = readSubPick(form, ui.cart);
        res = root.PSSubsidy.applyToCart(ui.cart, {
          productId: subPick.productId, imei: subPick.imei,
          customerName: form.elements.customerName.value,
          idNumber: form.elements.idNumber.value
        });
        if (!res.ok) return toast(res.reason, 'error');
        ui.subsidyForm = false; ui.subsidyQuote = null;
        drawRight();
        toast('已应用国补 −' + money(res.subsidy.amount), 'success');
      } else if (kind === 'checkout') {
        res = checkout(ui.cart, {
          payMethod: ui.payMethod,
          paidAmount: form.elements.paidAmount.value,
          customerId: ui.customerId
        });
        if (!res.ok) return toast(res.reason, 'error');
        ui.done = res;
        ui.paid = '';
        drawReceipt();
        toast('结账成功，订单 ' + res.order.id, 'success');
      }
    });

    // 首次打开必须先画一次，否则页面一直空白（之前漏了这行）。
    draw();
  }

  root.PSPOS = {
    newCart: newCart, addItem: addItem, removeItem: removeItem, setQty: setQty,
    applyDiscount: applyDiscount, applyTradeIn: applyTradeIn,
    checkout: checkout, cartTotal: cartTotal, releaseCart: releaseCart,
    renderPOS: renderPOS
  };
  root.renderPOS = renderPOS;
})(typeof window !== 'undefined' ? window : globalThis);
