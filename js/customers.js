/* 会员 / 客户。全局 window.PSCustomers */
(function (root) {
  'use strict';

  var Store = root.PhoneStore;

  function fail(reason) { return { ok: false, reason: reason }; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function byId(id) {
    return (Store.get('customers') || []).filter(function (c) { return c.id === id; })[0] || null;
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

  var LEVELS = ['普通', '银卡', '金卡'];
  var SILVER_AT = 5000;   // 累计消费满 5000 升银卡
  var GOLD_AT = 20000;    // 满 20000 升金卡

  function logs() {
    var l = Store.get('customerLogs');
    if (!l) { l = []; Store.set('customerLogs', l); }
    return l;
  }

  /* ---------- 逻辑 ---------- */

  function levelOf(totalSpent) {
    if (totalSpent >= GOLD_AT) return '金卡';
    if (totalSpent >= SILVER_AT) return '银卡';
    return '普通';
  }

  // list()：返回带等级 / 余额 / 累计消费的会员副本
  function list() {
    return (Store.get('customers') || []).map(function (c) {
      var spent = Number(c.totalSpent) || 0;
      return {
        id: c.id, name: c.name, phone: c.phone,
        points: Number(c.points) || 0,
        balance: round2(Number(c.balance) || 0),
        totalSpent: round2(spent),
        level: c.level && LEVELS.indexOf(c.level) !== -1 ? c.level : levelOf(spent)
      };
    });
  }

  function validPhone(phone, exceptId) {
    var p = String(phone || '').trim();
    if (!/^1\d{10}$/.test(p)) return '手机号须为 11 位数字（1 开头）';
    var dup = (Store.get('customers') || []).some(function (c) {
      return c.phone === p && c.id !== exceptId;
    });
    if (dup) return '手机号已存在：' + p;
    return null;
  }

  function add(input) {
    input = input || {};
    var name = String(input.name || '').trim();
    if (!name) return fail('请填写会员姓名');
    var phoneErr = validPhone(input.phone);
    if (phoneErr) return fail(phoneErr);
    var max = 0;
    (Store.get('customers') || []).forEach(function (c) {
      var n = parseInt(String(c.id).replace(/\D/g, ''), 10);
      if (n > max) max = n;
    });
    var customer = {
      id: 'C' + pad(max + 1, 3), name: name, phone: String(input.phone).trim(),
      points: 0, balance: 0, totalSpent: 0, level: '普通'
    };
    Store.get('customers').push(customer);
    Store.save();
    return { ok: true, customer: customer };
  }

  function pushLog(customer, type, amount, note) {
    logs().push({
      id: 'L' + today().replace(/-/g, '') + pad(logs().length + 1, 4),
      customerId: customer.id, type: type, amount: round2(amount),
      balanceAfter: round2(Number(customer.balance) || 0),
      points: Number(customer.points) || 0, note: note || '',
      date: today(), at: new Date().toISOString()
    });
  }

  // 储值充值：只加不减，写流水
  function charge(customerId, amount) {
    var c = byId(customerId);
    if (!c) return fail('会员不存在');
    var v = Number(amount);
    if (!(v > 0) || !isFinite(v)) return fail('充值金额须为大于 0 的数字');
    c.balance = round2((Number(c.balance) || 0) + v);
    pushLog(c, '充值', v);
    Store.save();
    return { ok: true, customer: c, log: logs()[logs().length - 1] };
  }

  // 储值消费：余额不足返回原因；消费计入累计消费与积分
  function spend(customerId, amount) {
    var c = byId(customerId);
    if (!c) return fail('会员不存在');
    var v = Number(amount);
    if (!(v > 0) || !isFinite(v)) return fail('消费金额须为大于 0 的数字');
    if (!(Number(c.balance) >= v)) {
      return fail('会员余额不足（余额 ' + (Number(c.balance) || 0) + ' 元，消费 ' + v + ' 元）');
    }
    c.balance = round2(Number(c.balance) - v);
    recordSpend(c.id, v);
    pushLog(c, '储值消费', -v);
    Store.save();
    return { ok: true, customer: c, log: logs()[logs().length - 1] };
  }

  function points(customerId) {
    var c = byId(customerId);
    if (!c) return fail('会员不存在');
    return { ok: true, points: Number(c.points) || 0 };
  }

  // 手工调分（正加负减），写流水
  function adjustPoints(customerId, delta, note) {
    var c = byId(customerId);
    if (!c) return fail('会员不存在');
    var v = Number(delta);
    if (!isFinite(v) || Math.floor(v) !== v || v === 0) return fail('积分调整须为非零整数');
    c.points = (Number(c.points) || 0) + v;
    if (c.points < 0) c.points = 0;
    pushLog(c, '积分调整', v, note || '手工调整');
    Store.save();
    return { ok: true, customer: c };
  }

  /*
   * 消费入账：累计消费 + 积分（1 元 = 1 分）+ 等级自动升级（只升不降）。
   * 收银结账（pos.checkout）会调用这里；储值消费（spend）也走这里。
   */
  function recordSpend(customerId, amount) {
    var c = byId(customerId);
    if (!c) return fail('会员不存在');
    var v = Number(amount);
    if (!(v > 0) || !isFinite(v)) return fail('消费金额须为大于 0 的数字');
    var prevLevel = c.level || levelOf(Number(c.totalSpent) || 0);
    c.totalSpent = round2((Number(c.totalSpent) || 0) + v);
    c.points = (Number(c.points) || 0) + Math.round(v);
    var newLevel = levelOf(c.totalSpent);
    var upgraded = null;
    if (LEVELS.indexOf(newLevel) > LEVELS.indexOf(prevLevel)) {
      c.level = newLevel;
      upgraded = newLevel;
    } else {
      c.level = prevLevel;
    }
    Store.save();
    return { ok: true, customer: c, level: c.level, upgraded: upgraded };
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
  function levelBadge(level) {
    var cls = level === '金卡' ? 'badge-warn' : level === '银卡' ? 'badge-ok' : 'badge-muted';
    return '<span class="badge ' + cls + '">' + esc(level) + '</span>';
  }

  function addFormHtml() {
    return '<form class="card form-card" data-form="add" novalidate><h2>新增会员</h2><div class="form-grid">' +
      '<div class="field"><label for="cu-name">姓名（必填）</label><input id="cu-name" name="name" type="text" autocomplete="off"></div>' +
      '<div class="field"><label for="cu-phone">手机号（11 位，必填）</label><input id="cu-phone" name="phone" type="tel" inputmode="numeric" maxlength="11" autocomplete="off"></div>' +
      '</div><div class="actions"><button type="submit" class="btn btn-primary">保存</button>' +
      '<button type="button" class="btn btn-secondary" data-action="toggle-add">取消</button></div></form>';
  }

  function detailHtml(c) {
    var spent = Number(c.totalSpent) || 0;
    var nextAt = spent >= GOLD_AT ? null : spent >= SILVER_AT ? GOLD_AT : SILVER_AT;
    var orders = (Store.get('orders') || []).filter(function (o) { return o.customerId === c.id; })
      .slice().reverse();
    var myLogs = logs().filter(function (l) { return l.customerId === c.id; }).slice().reverse();
    var html = '<div class="detail"><h3>' + esc(c.name) + ' · ' + levelBadge(c.level) + '</h3>' +
      '<dl class="pos-totals"><dt>积分</dt><dd>' + (Number(c.points) || 0) + '</dd>' +
      '<dt>储值余额</dt><dd>' + money(Number(c.balance) || 0) + '</dd>' +
      '<dt>累计消费</dt><dd>' + money(spent) + '</dd>' +
      '<dt>下一等级</dt><dd>' + (nextAt ? esc(nextAt === GOLD_AT && spent >= SILVER_AT ? '金卡（还差 ' + money(GOLD_AT - spent) + '）' : '银卡（还差 ' + money(nextAt - spent) + '）') : '已是最高等级') + '</dd></dl>' +
      '<form class="inline-form" data-form="charge" data-id="' + esc(c.id) + '">' +
      '<div class="field"><label for="cu-chg-' + esc(c.id) + '">储值充值（元，只加不减）</label>' +
      '<input id="cu-chg-' + esc(c.id) + '" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01"></div>' +
      '<button type="submit" class="btn btn-primary">充值</button></form>' +
      '<form class="inline-form" data-form="spend" data-id="' + esc(c.id) + '">' +
      '<div class="field"><label for="cu-spd-' + esc(c.id) + '">储值消费（元）</label>' +
      '<input id="cu-spd-' + esc(c.id) + '" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01"></div>' +
      '<button type="submit" class="btn btn-secondary">消费</button></form>' +
      '<form class="inline-form" data-form="adjust" data-id="' + esc(c.id) + '">' +
      '<div class="field"><label for="cu-adj-' + esc(c.id) + '">手工调分（±整数）</label>' +
      '<input id="cu-adj-' + esc(c.id) + '" name="delta" type="number" inputmode="numeric" step="1"></div>' +
      '<button type="submit" class="btn btn-secondary">调分</button></form>';
    html += '<h3>消费记录（订单）</h3>' +
      (orders.length ? '<ul class="plain-list">' + orders.slice(0, 10).map(function (o) {
        return '<li>' + esc(o.date) + ' <code>' + esc(o.id) + '</code> 消费 ' + money(o.total) +
          '（' + esc(o.payMethod) + '，积分 +' + Math.round(o.total) + '）</li>';
      }).join('') + '</ul>' : '<p class="muted small">暂无消费记录。</p>');
    html += '<h3>储值 / 积分流水</h3>' +
      (myLogs.length ? '<ul class="plain-list">' + myLogs.slice(0, 10).map(function (l) {
        return '<li>' + esc(l.date) + ' ' + esc(l.type) + ' ' + (l.amount > 0 ? '+' : '') + money(l.amount) +
          '，余额 ' + money(l.balanceAfter) + '</li>';
      }).join('') + '</ul>' : '<p class="muted small">暂无流水。</p>');
    return html + '</div>';
  }

  function listHtml(ui) {
    var rows = list();
    if (!rows.length) return '<p class="empty">还没有会员。</p>';
    var body = rows.map(function (c) {
      var open = ui.open === c.id;
      var tr = '<tr data-id="' + esc(c.id) + '"><td><button type="button" class="link-btn" aria-expanded="' + open + '">' +
        esc(c.name) + '</button></td><td>' + esc(c.phone) + '</td><td>' + levelBadge(c.level) + '</td>' +
        '<td class="num">' + (Number(c.points) || 0) + '</td>' +
        '<td class="num">' + money(Number(c.balance) || 0) + '</td>' +
        '<td class="num">' + money(Number(c.totalSpent) || 0) + '</td></tr>';
      if (open) tr += '<tr class="row-detail"><td colspan="6">' + detailHtml(c) + '</td></tr>';
      return tr;
    }).join('');
    return '<div class="table-wrap"><table class="table"><thead><tr><th>姓名</th><th>电话</th><th>等级</th>' +
      '<th class="num">积分</th><th class="num">余额</th><th class="num">累计消费</th></tr></thead><tbody>' +
      body + '</tbody></table></div>' +
      '<p class="muted small">等级自动升级：累计消费满 ' + money(SILVER_AT) + ' 升银卡，满 ' + money(GOLD_AT) + ' 升金卡。点姓名看详情。</p>';
  }

  function renderCustomers(el) {
    if (!el || typeof document === 'undefined') return;
    var ui = { open: null, adding: false };
    var wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.innerHTML =
      '<div class="page-head"><h1>会员客户</h1>' +
      '<button type="button" class="btn btn-primary" data-action="toggle-add">新增会员</button></div>' +
      '<div data-slot="add"></div><div class="card"><h2>会员列表</h2><div data-slot="list"></div></div>';
    el.innerHTML = '';
    el.appendChild(wrap);

    var slotList = wrap.querySelector('[data-slot="list"]');
    var slotAdd = wrap.querySelector('[data-slot="add"]');
    function drawList() { slotList.innerHTML = listHtml(ui); }
    function drawAdd() { slotAdd.innerHTML = ui.adding ? addFormHtml() : ''; }
    drawList();

    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action="toggle-add"]');
      if (btn) {
        ui.adding = !ui.adding;
        drawAdd();
        if (ui.adding) wrap.querySelector('#cu-name').focus();
        return;
      }
      if (e.target.closest('.row-detail')) return;
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
      var id = form.getAttribute('data-id');
      var res;
      if (kind === 'add') {
        res = add({ name: form.elements.name.value, phone: form.elements.phone.value });
        if (!res.ok) return toast(res.reason, 'error');
        ui.adding = false;
        drawAdd(); drawList();
        toast('已新增会员：' + res.customer.name, 'success');
      } else if (kind === 'charge') {
        res = charge(id, form.elements.amount.value);
        if (!res.ok) return toast(res.reason, 'error');
        drawList();
        toast('已充值 ' + money(res.log.amount) + '，余额 ' + money(res.customer.balance), 'success');
      } else if (kind === 'spend') {
        res = spend(id, form.elements.amount.value);
        if (!res.ok) return toast(res.reason, 'error');
        drawList();
        toast('已消费 ' + money(-res.log.amount), 'success');
      } else if (kind === 'adjust') {
        res = adjustPoints(id, form.elements.delta.value, '手工调整');
        if (!res.ok) return toast(res.reason, 'error');
        drawList();
        toast('积分已调整，当前 ' + res.customer.points + ' 分', 'success');
      }
    });
  }

  root.PSCustomers = {
    list: list, add: add, charge: charge, spend: spend, points: points,
    adjustPoints: adjustPoints, recordSpend: recordSpend, renderCustomers: renderCustomers
  };
  root.renderCustomers = renderCustomers;
})(typeof window !== 'undefined' ? window : globalThis);
