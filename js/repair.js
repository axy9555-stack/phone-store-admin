/* 维修接单 + 保修售后。全局 window.PSRepair */
(function (root) {
  'use strict';

  var Store = root.PhoneStore;

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

  // 状态只能按顺序向前走一步；已完成须经 finish 结算；任何未完成状态可取消
  var FLOW = ['待检修', '维修中', '待取机', '已完成'];

  /* ---------- 逻辑 ---------- */

  function list(filter) {
    filter = filter || {};
    var rows = (Store.get('repairs') || []).slice().reverse(); // 新单在前
    if (filter.status) rows = rows.filter(function (r) { return r.status === filter.status; });
    if (filter.staffId) rows = rows.filter(function (r) { return r.staffId === filter.staffId; });
    if (filter.imei) rows = rows.filter(function (r) { return r.imei === filter.imei; });
    return rows;
  }

  function nextId(day) {
    var prefix = 'WX' + day.replace(/-/g, '');
    var max = 0;
    (Store.get('repairs') || []).forEach(function (r) {
      if (String(r.id).indexOf(prefix) === 0) {
        var n = parseInt(String(r.id).slice(prefix.length), 10);
        if (n > max) max = n;
      }
    });
    return prefix + pad(max + 1, 3);
  }

  function create(input) {
    input = input || {};
    var phone = String(input.customerPhone || '').trim();
    var fault = String(input.fault || '').trim();
    if (!/^1\d{10}$/.test(phone)) return fail('客户电话必填，且须为 11 位手机号');
    if (!fault) return fail('故障描述必填');

    var imei = String(input.imei || '').trim();
    var prevStatus = '';
    if (imei) {
      var rec = (Store.get('imeis') || []).filter(function (r) { return r.imei === imei; })[0];
      if (!rec) return fail('串号不存在：' + imei);
      if (rec.status !== '在库' && rec.status !== '已售') {
        return fail('串号当前状态为“' + rec.status + '”，不能送修');
      }
      prevStatus = rec.status;
      rec.status = '维修中'; // 占机
    }

    var estimate = Number(input.estimate === undefined || input.estimate === '' ? 0 : input.estimate);
    if (!(estimate >= 0) || !isFinite(estimate)) return fail('预估费用须为不小于 0 的数字');

    var repair = {
      id: nextId(today()),
      customerName: String(input.customerName || '').trim(),
      customerPhone: phone,
      brand: String(input.brand || '').trim(),
      model: String(input.model || '').trim(),
      imei: imei, imeiPrevStatus: prevStatus,
      fault: fault, estimate: estimate,
      status: '待检修',
      staffId: byId('staff', input.staffId) ? input.staffId : '',
      fee: 0, createdAt: today(), finishedAt: null
    };
    Store.get('repairs').push(repair);
    Store.save();
    return { ok: true, repair: repair };
  }

  function updateStatus(id, next) {
    var r = byId('repairs', id);
    if (!r) return fail('维修单不存在');
    var cur = FLOW.indexOf(r.status);
    var step = FLOW.indexOf(next);
    if (next === '已完成') return fail('已完成须经“结算完工”入账，不能直接推进');
    if (next === '已取消') {
      if (r.status === '已完成' || r.status === '已取消') {
        return fail('“' + r.status + '”的单不能再取消');
      }
      r.status = '已取消';
      if (r.imei) restoreImei(r); // 取消送修，串号归位
      Store.save();
      return { ok: true, repair: r };
    }
    if (step === -1) return fail('状态须为：' + FLOW.join(' / ') + ' 或 已取消');
    if (step !== cur + 1) {
      return fail('状态须按顺序流转：' + r.status + ' 的下一步是“' +
        (cur + 1 < FLOW.length ? FLOW[cur + 1] : '无') + '”，不能跳到“' + next + '”');
    }
    r.status = next;
    Store.save();
    return { ok: true, repair: r };
  }

  // 送修占机的串号归位（在库机回在库；客户已购机回已售）
  function restoreImei(repair) {
    var rec = (Store.get('imeis') || []).filter(function (x) { return x.imei === repair.imei; })[0];
    if (!rec) return;
    rec.status = repair.imeiPrevStatus || '在库';
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

  // 结算完工：实际费用入账（写维修收入订单，参与提成），串号归位
  function finish(id, fee) {
    var r = byId('repairs', id);
    if (!r) return fail('维修单不存在');
    if (r.status !== '待取机') return fail('只有“待取机”的维修单能结算完工（当前：' + r.status + '）');
    var v = Number(fee === undefined || fee === '' ? r.estimate : fee);
    if (!(v >= 0) || !isFinite(v)) return fail('实际费用须为不小于 0 的数字');

    var day = today();
    var order = {
      id: nextOrderId(day),
      type: '维修', repairId: r.id,
      items: [{
        productId: '', name: '维修服务' + (r.brand ? '（' + r.brand + ' ' + r.model + '）' : ''),
        qty: 1, price: round2(v), costPrice: 0
      }],
      subtotal: round2(v), discount: 0, tradeIn: 0,
      total: round2(v), cost: 0,
      payMethod: '现金', paidAmount: round2(v), change: 0,
      customerId: '', staffId: r.staffId,
      status: '已完成', date: day, at: new Date().toISOString(), refunded: []
    };
    Store.get('orders').push(order);

    r.fee = round2(v);
    r.status = '已完成';
    r.orderId = order.id;
    r.finishedAt = new Date().toISOString();
    r.invoiced = true; // 提成按这笔订单计提，repairs 表不再重复计
    if (r.imei) restoreImei(r);
    Store.save();
    return { ok: true, repair: r, order: order };
  }

  /* ---------- 保修查询 ---------- */

  var WARRANTY_DAYS = 365; // 售出日起 1 年
  var EXTEND_DAYS = 90;    // 每维修一次延保 90 天

  function warranty(imei) {
    var key = String(imei || '').trim();
    var rec = (Store.get('imeis') || []).filter(function (r) { return r.imei === key; })[0];
    if (!rec) return fail('串号不存在：' + key);

    var soldOrder = null;
    (Store.get('orders') || []).forEach(function (o) {
      (o.items || []).forEach(function (it) {
        if (it.imei === key && o.type !== '维修') {
          if (!soldOrder || o.date > soldOrder.date) soldOrder = o; // 最近一次售出
        }
      });
    });
    if (!soldOrder) {
      return { ok: true, imei: key, status: rec.status, soldAt: null, warrantyEnd: null, remainDays: null, message: '未查到售出记录，不在保修期内' };
    }
    var repaired = (Store.get('repairs') || []).filter(function (r) {
      return r.imei === key && r.status === '已完成';
    }).length;
    var extDays = repaired * EXTEND_DAYS;
    var DAY = 86400000;
    var start = new Date(soldOrder.date + 'T00:00:00').getTime();
    var end = new Date(start + (WARRANTY_DAYS + extDays) * DAY);
    var now = new Date(today() + 'T00:00:00').getTime();
    var remain = Math.ceil((end.getTime() - now) / DAY);
    var pad = function (n) { return pad2(n); };
    function pad2(n) { var s = String(n); while (s.length < 2) s = '0' + s; return s; }
    var endStr = end.getFullYear() + '-' + pad(end.getMonth() + 1) + '-' + pad(end.getDate());
    return {
      ok: true, imei: key, status: rec.status,
      soldAt: soldOrder.date, warrantyEnd: endStr,
      remainDays: remain, extendedDays: extDays, repairs: repaired,
      message: remain >= 0 ? '保修中，剩 ' + remain + ' 天' : '已过保 ' + (-remain) + ' 天'
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
  function statusBadge(status) {
    var cls = status === '已完成' ? 'badge-ok'
      : status === '已取消' ? 'badge-muted'
      : status === '待取机' ? 'badge-warn' : 'badge-warn';
    return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
  }
  function nextStep(status) {
    var i = FLOW.indexOf(status);
    return i >= 0 && i + 1 < FLOW.length ? FLOW[i + 1] : null;
  }

  function createFormHtml() {
    var staffOpts = '<option value="">暂不指派</option>' + (Store.get('staff') || []).map(function (s) {
      return '<option value="' + esc(s.id) + '">' + esc(s.name) + '（' + esc(s.role) + '）</option>';
    }).join('');
    return '<form class="card form-card" data-form="create" novalidate><h2>新建维修单</h2><div class="form-grid">' +
      '<div class="field"><label for="rp-name">客户姓名</label><input id="rp-name" name="customerName" type="text" autocomplete="off"></div>' +
      '<div class="field"><label for="rp-phone">客户电话（11 位，必填）</label><input id="rp-phone" name="customerPhone" type="tel" inputmode="numeric" maxlength="11" autocomplete="off"></div>' +
      '<div class="field"><label for="rp-brand">品牌</label><input id="rp-brand" name="brand" type="text" autocomplete="off"></div>' +
      '<div class="field"><label for="rp-model">型号</label><input id="rp-model" name="model" type="text" autocomplete="off"></div>' +
      '<div class="field"><label for="rp-imei">串号 IMEI（在库机 / 已售机可选填）</label><input id="rp-imei" name="imei" type="text" inputmode="numeric" autocomplete="off"></div>' +
      '<div class="field"><label for="rp-estimate">预估费用（元）</label><input id="rp-estimate" name="estimate" type="number" inputmode="decimal" min="0" step="0.01" value="0"></div>' +
      '<div class="field"><label for="rp-staff">维修员</label><select id="rp-staff" name="staffId">' + staffOpts + '</select></div>' +
      '</div><div class="field"><label for="rp-fault">故障描述（必填）</label>' +
      '<textarea id="rp-fault" name="fault" rows="3" autocomplete="off"></textarea></div>' +
      '<div class="actions"><button type="submit" class="btn btn-primary">创建维修单</button>' +
      '<button type="button" class="btn btn-secondary" data-action="toggle-create">取消</button></div></form>';
  }

  function detailHtml(r) {
    var next = nextStep(r.status);
    var html = '<div class="detail"><h3>维修单 ' + esc(r.id) + '</h3>' +
      '<dl class="pos-totals">' +
      '<dt>客户</dt><dd>' + esc(r.customerName || '—') + ' ' + esc(r.customerPhone) + '</dd>' +
      '<dt>机型</dt><dd>' + esc(r.brand || '—') + ' ' + esc(r.model || '') + '</dd>' +
      '<dt>串号</dt><dd>' + (r.imei ? '<code>' + esc(r.imei) + '</code>' : '未登记') + '</dd>' +
      '<dt>故障</dt><dd>' + esc(r.fault) + '</dd>' +
      '<dt>预估费用</dt><dd>' + money(r.estimate) + '</dd>' +
      '<dt>维修员</dt><dd>' + esc(r.staffId || '未指派') + '</dd>' +
      '<dt>接单日期</dt><dd>' + esc(r.createdAt) + '</dd></dl>';
    if (r.status === '待取机') {
      html += '<form class="inline-form" data-form="finish" data-id="' + esc(r.id) + '">' +
        '<div class="field"><label for="rp-fee-' + esc(r.id) + '">实际费用（元，留空按预估）</label>' +
        '<input id="rp-fee-' + esc(r.id) + '" name="fee" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(r.estimate) + '"></div>' +
        '<button type="submit" class="btn btn-primary">结算完工</button></form>' +
        '<p class="muted small">完工后写一笔维修收入订单，串号归位，并计入维修员提成。</p>';
    } else if (r.status === '已完成') {
      html += '<p>实际费用 <strong>' + money(r.fee) + '</strong>' +
        (r.orderId ? '，入账订单 <code>' + esc(r.orderId) + '</code>' : '') +
        '，完工 ' + esc(r.createdAt) + '</p>';
    }
    var ops = [];
    if (next) ops.push('<button type="button" class="btn btn-secondary btn-sm" data-action="advance" data-id="' + esc(r.id) + '">推进到「' + next + '」</button>');
    if (r.status !== '已完成' && r.status !== '已取消') {
      ops.push('<button type="button" class="btn btn-danger btn-sm" data-action="cancel" data-id="' + esc(r.id) + '">取消维修单</button>');
    }
    if (ops.length) html += '<div class="actions">' + ops.join('') + '</div>';
    return html + '</div>';
  }

  function listHtml(ui) {
    var rows = list();
    if (!rows.length) return '<p class="empty">还没有维修单。</p>';
    var body = rows.map(function (r) {
      var open = ui.open === r.id;
      var fee = r.status === '已完成' ? money(r.fee) : '预估 ' + money(r.estimate);
      var tr = '<tr data-id="' + esc(r.id) + '"><td><button type="button" class="link-btn" aria-expanded="' + open + '">' +
        esc(r.id) + '</button></td><td>' + esc(r.customerName || '—') + '</td>' +
        '<td>' + esc((r.brand || '—') + ' ' + (r.model || '')) + '</td>' +
        '<td class="fault-cell">' + esc(r.fault) + '</td>' +
        '<td>' + statusBadge(r.status) + '</td><td class="num">' + fee + '</td></tr>';
      if (open) tr += '<tr class="row-detail"><td colspan="6">' + detailHtml(r) + '</td></tr>';
      return tr;
    }).join('');
    return '<div class="table-wrap"><table class="table"><thead><tr><th>单号</th><th>客户</th><th>机型</th>' +
      '<th>故障</th><th>状态</th><th class="num">费用</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="muted small">状态按 待检修 → 维修中 → 待取机 →（结算完工）已完成 流转，可取消。点单号看详情。</p>';
  }

  function warrantyCardHtml(ui) {
    var w = ui.warranty;
    return '<form class="detail" data-form="warranty"><div class="field"><label for="rp-w-imei">串号查询保修（15 位 IMEI）</label>' +
      '<input id="rp-w-imei" name="imei" type="text" inputmode="numeric" autocomplete="off" placeholder="例如 8610000001001"></div>' +
      '<div class="actions"><button type="submit" class="btn btn-primary">查保修</button>' +
      (w && w.ok ? '<span>售出 ' + esc(w.soldAt || '—') + '，保修至 ' + esc(w.warrantyEnd || '—') +
        (w.extendedDays ? '（已延保 ' + w.extendedDays + ' 天）' : '') + '，' + esc(w.message) + '</span>'
        : w ? '<span class="muted">' + esc(w.message || '') + '</span>' : '') + '</div></form>';
  }

  function renderRepair(el) {
    if (!el || typeof document === 'undefined') return;
    var ui = { open: null, creating: false, warranty: null };
    var wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.innerHTML =
      '<div class="page-head"><h1>维修售后</h1>' +
      '<button type="button" class="btn btn-primary" data-action="toggle-create">新建维修单</button></div>' +
      '<div data-slot="create"></div>' +
      '<div class="card"><h2>维修单列表</h2><div data-slot="list"></div></div>' +
      '<div class="card"><h2>保修查询</h2><div data-slot="warranty"></div></div>';
    el.innerHTML = '';
    el.appendChild(wrap);

    var slotList = wrap.querySelector('[data-slot="list"]');
    var slotCreate = wrap.querySelector('[data-slot="create"]');
    var slotWarranty = wrap.querySelector('[data-slot="warranty"]');
    function drawList() { slotList.innerHTML = listHtml(ui); }
    function drawCreate() { slotCreate.innerHTML = ui.creating ? createFormHtml() : ''; }
    function drawWarranty() { slotWarranty.innerHTML = warrantyCardHtml(ui); }
    drawList(); drawWarranty();

    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (btn) {
        var action = btn.getAttribute('data-action');
        var id = btn.getAttribute('data-id');
        var res;
        if (action === 'toggle-create') {
          ui.creating = !ui.creating;
          drawCreate();
          if (ui.creating) wrap.querySelector('#rp-name').focus();
          return;
        } else if (action === 'advance') {
          var r = byId('repairs', id);
          res = updateStatus(id, nextStep(r.status));
          if (!res.ok) return toast(res.reason, 'error');
          drawList();
          toast(res.repair.id + ' 已推进到「' + res.repair.status + '」', 'success');
          return;
        } else if (action === 'cancel') {
          res = updateStatus(id, '已取消');
          if (!res.ok) return toast(res.reason, 'error');
          drawList();
          toast('维修单已取消，串号已归位', 'success');
          return;
        }
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
      var res;
      if (kind === 'create') {
        res = create({
          customerName: form.elements.customerName.value, customerPhone: form.elements.customerPhone.value,
          brand: form.elements.brand.value, model: form.elements.model.value,
          imei: form.elements.imei.value, fault: form.elements.fault.value,
          estimate: form.elements.estimate.value, staffId: form.elements.staffId.value
        });
        if (!res.ok) return toast(res.reason, 'error');
        ui.creating = false;
        drawCreate(); drawList();
        toast('已创建维修单 ' + res.repair.id, 'success');
      } else if (kind === 'finish') {
        res = finish(form.getAttribute('data-id'), form.elements.fee.value);
        if (!res.ok) return toast(res.reason, 'error');
        drawList();
        toast('已完工入账 ' + money(res.repair.fee) + '（订单 ' + res.order.id + '）', 'success');
      } else if (kind === 'warranty') {
        res = warranty(form.elements.imei.value);
        ui.warranty = res.ok === false ? { ok: false, message: res.reason } : res;
        drawWarranty();
        if (res.ok === false) toast(res.reason, 'error');
      }
    });
  }

  root.PSRepair = {
    list: list, create: create, updateStatus: updateStatus,
    finish: finish, warranty: warranty, renderRepair: renderRepair
  };
  root.renderRepair = renderRepair;
})(typeof window !== 'undefined' ? window : globalThis);
