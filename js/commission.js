/* 销售提成。全局 window.PSCommission */
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
  function thisMonth() { return today().slice(0, 7); }

  function defaultRules() {
    return {
      phone: 0.02, accessory: 0.05, repair: 0.10, tradeIn: 0.01,
      tiers: [
        { threshold: 100000, bonus: 0.005 },
        { threshold: 200000, bonus: 0.01 }
      ]
    };
  }

  function settlements() {
    var s = Store.get('settlements');
    if (!s) { s = []; Store.set('settlements', s); }
    return s;
  }
  function findSettlement(staffId, month) {
    return settlements().filter(function (s) {
      return s.staffId === staffId && s.month === month;
    })[0] || null;
  }

  /* ---------- 规则 ---------- */

  // rules() 返回当前规则；rules(patch) 校验并更新（百分比须在 0-30% 之间）
  function rules(patch) {
    var settings = Store.get('settings');
    if (!settings) { settings = {}; Store.set('settings', settings); }
    if (!settings.commission) {
      settings.commission = defaultRules();
      Store.save();
    }
    if (!patch) return JSON.parse(JSON.stringify(settings.commission));

    var next = JSON.parse(JSON.stringify(settings.commission));
    var pctKeys = ['phone', 'accessory', 'repair', 'tradeIn'];
    for (var i = 0; i < pctKeys.length; i++) {
      var k = pctKeys[i];
      if (patch[k] === undefined) continue;
      var v = Number(patch[k]);
      if (!(v > 0) || v > 0.3) return fail('提成比例须在 0 ~ 30% 之间：' + k);
      next[k] = v;
    }
    if (patch.tiers !== undefined) {
      if (!Array.isArray(patch.tiers) || !patch.tiers.length) return fail('阶梯加成至少一档');
      var tiers = [];
      for (var t = 0; t < patch.tiers.length; t++) {
        var tier = patch.tiers[t] || {};
        var threshold = Number(tier.threshold);
        var bonus = Number(tier.bonus);
        if (!(threshold > 0)) return fail('阶梯门槛须为大于 0 的金额');
        if (!(bonus > 0) || bonus > 0.3) return fail('阶梯加成比例须在 0 ~ 30% 之间');
        tiers.push({ threshold: threshold, bonus: bonus });
      }
      tiers.sort(function (a, b) { return a.threshold - b.threshold; });
      next.tiers = tiers;
    }
    settings.commission = next;
    Store.save();
    return { ok: true, rules: JSON.parse(JSON.stringify(next)) };
  }

  // 阶梯加成：按超出各档门槛的部分累加（边际式）
  function tierBonus(sales, r) {
    var tiers = (r.tiers || []).slice().sort(function (a, b) { return a.threshold - b.threshold; });
    var bonus = 0;
    for (var i = 0; i < tiers.length; i++) {
      var lower = tiers[i].threshold;
      var upper = i + 1 < tiers.length ? tiers[i + 1].threshold : Infinity;
      var portion = Math.min(sales, upper) - lower;
      if (portion > 0) bonus += portion * tiers[i].bonus;
    }
    return bonus;
  }

  /* ---------- 计算 / 结算 ---------- */

  function ordersOfMonth(staffId, month) {
    return (Store.get('orders') || []).filter(function (o) {
      return o.staffId === staffId && String(o.date).slice(0, 7) === month;
    });
  }

  function calc(staffId, month) {
    var staff = byId('staff', staffId);
    if (!staff) return fail('店员不存在');
    var m = String(month || thisMonth()).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return fail('月份格式须为 YYYY-MM');
    var r = rules();

    var settled = findSettlement(staffId, m);
    if (settled) {
      // 结算后锁定：不再重算，返回结算时的快照
      return {
        ok: true, locked: true, staffId: staffId, month: m,
        sales: settled.sales, orderCount: settled.orderCount,
        base: settled.base, bonus: settled.bonus, total: settled.total,
        details: settled.details, settlement: settled
      };
    }

    var details = [];
    var sales = 0, base = 0;
    ordersOfMonth(staffId, m).forEach(function (o) {
      if (o.type === '维修') { // 维修收入订单：按维修费 × 维修提成率
        var rFee = o.total * r.repair;
        sales += o.total;
        base += rFee;
        details.unshift({ orderId: o.id, date: o.date, kind: '维修', sales: o.total, commission: round2(rFee) });
        return;
      }
      var orderSales = 0, orderBase = 0;
      (o.items || []).forEach(function (it) {
        var p = byId('products', it.productId);
        var rate = !p ? 0 : p.category === PHONE ? r.phone : r.accessory;
        var fee = it.price * it.qty * rate;
        orderSales += it.price * it.qty;
        orderBase += fee;
      });
      if (o.tradeIn > 0) {
        var tFee = o.tradeIn * r.tradeIn;
        orderBase += tFee;
        details.push({
          orderId: o.id, date: o.date, kind: '以旧换新回收',
          sales: 0, commission: round2(tFee)
        });
      }
      sales += orderSales;
      base += orderBase;
      details.unshift({
        orderId: o.id, date: o.date, kind: '销售单',
        sales: round2(orderSales), commission: round2(orderBase - (o.tradeIn > 0 ? o.tradeIn * r.tradeIn : 0))
      });
    });

    // 维修提成（维修模块 chunk 4 接入，这里按已有数据汇总）
    (Store.get('repairs') || []).forEach(function (rp) {
      if (rp.invoiced) return; // 已完工入账的维修按其订单计提，避免重复
      if (rp.staffId !== staffId) return;
      if (String(rp.date || '').slice(0, 7) !== m) return;
      if (!(rp.fee > 0)) return;
      sales += rp.fee;
      base += rp.fee * r.repair;
      details.push({ orderId: rp.id, date: rp.date, kind: '维修', sales: rp.fee, commission: round2(rp.fee * r.repair) });
    });

    var bonus = tierBonus(sales, r);
    return {
      ok: true, locked: false, staffId: staffId, month: m,
      staffName: staff.name, role: staff.role,
      sales: round2(sales), orderCount: ordersOfMonth(staffId, m).length,
      base: round2(base), bonus: round2(bonus), total: round2(base + bonus),
      details: details
    };
  }

  function settle(staffId, month) {
    var staff = byId('staff', staffId);
    if (!staff) return fail('店员不存在');
    var m = String(month || thisMonth()).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return fail('月份格式须为 YYYY-MM');
    if (findSettlement(staffId, m)) return fail(staff.name + ' ' + m + ' 已结算，不能重复结算');
    var c = calc(staffId, m);
    if (!c.ok) return c;
    var settlement = {
      id: 'JS' + m.replace('-', '') + '-' + staffId,
      staffId: staffId, staffName: staff.name, month: m,
      sales: c.sales, orderCount: c.orderCount,
      base: c.base, bonus: c.bonus, total: c.total,
      details: c.details, status: '已结算',
      at: new Date().toISOString(), date: today()
    };
    settlements().push(settlement);
    Store.save();
    return { ok: true, settlement: settlement };
  }

  function monthlyReport(month) {
    var m = String(month || thisMonth()).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return fail('月份格式须为 YYYY-MM');
    var rows = (Store.get('staff') || []).map(function (s) {
      var c = calc(s.id, m);
      return {
        staffId: s.id, name: s.name, role: s.role,
        sales: c.sales, orderCount: c.orderCount,
        base: c.base, bonus: c.bonus, total: c.total,
        locked: !!c.locked
      };
    });
    rows.sort(function (a, b) { return b.total - a.total; });
    rows.forEach(function (r, i) { r.rank = i + 1; });
    return { ok: true, month: m, rows: rows };
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
  function pct(n) { return (Number(n) * 100).toFixed(1).replace(/\.0$/, '') + '%'; }
  function toast(msg, type) {
    if (typeof root.PSToast === 'function') root.PSToast(msg, type);
  }

  function rulesCardHtml(ui) {
    var r = rules();
    return '<form class="detail" data-form="rules"><h3>提成规则</h3>' +
      '<p class="muted small">手机 ' + pct(r.phone) + ' · 配件 ' + pct(r.accessory) + ' · 维修 ' + pct(r.repair) +
      ' · 以旧换新回收 ' + pct(r.tradeIn) + '；阶梯加成（按超出部分）：满 ' + money(r.tiers[0].threshold) + ' 加 ' +
      pct(r.tiers[0].bonus) + '，满 ' + money(r.tiers[1].threshold) + ' 加 ' + pct(r.tiers[1].bonus) + '。</p>' +
      '<div class="form-grid">' +
      '<div class="field"><label for="cm-phone">手机提成（%）</label><input id="cm-phone" name="phone" type="number" inputmode="decimal" min="0" max="30" step="0.1" value="' + esc(r.phone * 100) + '"></div>' +
      '<div class="field"><label for="cm-acc">配件提成（%）</label><input id="cm-acc" name="accessory" type="number" inputmode="decimal" min="0" max="30" step="0.1" value="' + esc(r.accessory * 100) + '"></div>' +
      '<div class="field"><label for="cm-rep">维修提成（%）</label><input id="cm-rep" name="repair" type="number" inputmode="decimal" min="0" max="30" step="0.1" value="' + esc(r.repair * 100) + '"></div>' +
      '<div class="field"><label for="cm-ti">换新回收提成（%）</label><input id="cm-ti" name="tradeIn" type="number" inputmode="decimal" min="0" max="30" step="0.1" value="' + esc(r.tradeIn * 100) + '"></div>' +
      '<div class="field"><label for="cm-t1">一档门槛（元）</label><input id="cm-t1" name="threshold1" type="number" inputmode="decimal" min="1" step="1" value="' + esc(r.tiers[0].threshold) + '"></div>' +
      '<div class="field"><label for="cm-b1">一档加成（%）</label><input id="cm-b1" name="bonus1" type="number" inputmode="decimal" min="0" max="30" step="0.1" value="' + esc(r.tiers[0].bonus * 100) + '"></div>' +
      '<div class="field"><label for="cm-t2">二档门槛（元）</label><input id="cm-t2" name="threshold2" type="number" inputmode="decimal" min="1" step="1" value="' + esc(r.tiers[1].threshold) + '"></div>' +
      '<div class="field"><label for="cm-b2">二档加成（%）</label><input id="cm-b2" name="bonus2" type="number" inputmode="decimal" min="0" max="30" step="0.1" value="' + esc(r.tiers[1].bonus * 100) + '"></div>' +
      '</div><div class="actions"><button type="submit" class="btn btn-secondary">保存规则</button>' +
      '<span class="muted small">比例须在 0 ~ 30% 之间。</span></div></form>';
  }

  function detailHtml(row, month) {
    var c = calc(row.staffId, month);
    var html = '<div class="detail"><h3>' + esc(row.name) + ' · ' + esc(month) + ' 提成明细</h3>';
    if (c.locked) {
      html += '<p><span class="badge badge-ok">已结算</span> 明细已锁定，以下为结算时快照。</p>';
    }
    html += '<div class="table-wrap"><table class="table"><thead><tr><th>单号</th><th>日期</th><th>类型</th>' +
      '<th class="num">销售额</th><th class="num">提成</th></tr></thead><tbody>' +
      (c.details.length ? c.details.map(function (d) {
        return '<tr><td><code>' + esc(d.orderId) + '</code></td><td>' + esc(d.date) + '</td><td>' + esc(d.kind) + '</td>' +
          '<td class="num">' + (d.sales ? money(d.sales) : '—') + '</td><td class="num">' + money(d.commission) + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="empty">本月暂无提成明细。</td></tr>') +
      '</tbody></table></div>' +
      '<dl class="pos-totals"><dt>月销售额</dt><dd>' + money(c.sales) + '</dd>' +
      '<dt>基础提成</dt><dd>' + money(c.base) + '</dd>' +
      '<dt>阶梯加成</dt><dd>' + money(c.bonus) + '</dd>' +
      '<dt class="pos-pay-label">提成合计</dt><dd class="pos-pay">' + money(c.total) + '</dd></dl>';
    if (!c.locked && (c.base > 0 || c.bonus > 0)) {
      html += '<form data-form="settle" data-id="' + esc(row.staffId) + '">' +
        '<div class="actions"><button type="submit" class="btn btn-primary">结算本月提成</button>' +
        '<span class="muted small">结算后当月明细锁定，不再重算。</span></div></form>';
    }
    return html + '</div>';
  }

  function reportHtml(ui) {
    var rep = monthlyReport(ui.month);
    if (!rep.ok) return '<p class="empty">' + esc(rep.reason) + '</p>';
    var body = rep.rows.map(function (r) {
      var open = ui.open === r.staffId;
      var tr = '<tr data-id="' + esc(r.staffId) + '"><td><span class="badge ' +
        (r.rank === 1 ? 'badge-warn' : 'badge-muted') + '">第 ' + r.rank + ' 名</span></td>' +
        '<td><button type="button" class="link-btn" aria-expanded="' + open + '">' + esc(r.name) + '</button>' +
        '<div class="muted small">' + esc(r.role) + '</div></td>' +
        '<td class="num">' + money(r.sales) + '</td>' +
        '<td class="num">' + money(r.base) + '</td>' +
        '<td class="num">' + money(r.bonus) + '</td>' +
        '<td class="num">' + money(r.total) + '</td>' +
        '<td>' + (r.locked ? '<span class="badge badge-ok">已结算</span>' : '<span class="badge badge-warn">未结算</span>') + '</td></tr>';
      if (open) tr += '<tr class="row-detail"><td colspan="7">' + detailHtml(r, ui.month) + '</td></tr>';
      return tr;
    }).join('');
    return '<div class="table-wrap"><table class="table"><thead><tr><th>排名</th><th>店员</th>' +
      '<th class="num">月销售额</th><th class="num">基础提成</th><th class="num">阶梯加成</th>' +
      '<th class="num">提成合计</th><th>状态</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="muted small">点店员姓名看每单提成明细并结算。</p>';
  }

  function renderCommission(el) {
    if (!el || typeof document === 'undefined') return;
    var ui = { month: thisMonth(), open: null };
    var wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.innerHTML =
      '<div class="page-head"><h1>销售提成</h1>' +
      '<div class="field" style="margin-bottom:0"><label for="cm-month">月份</label>' +
      '<input id="cm-month" type="month" value="' + esc(ui.month) + '"></div></div>' +
      '<div class="card"><h2>全店提成榜</h2><div data-slot="report"></div></div>' +
      '<div class="card" data-slot="rules"></div>';
    el.innerHTML = '';
    el.appendChild(wrap);

    var slotReport = wrap.querySelector('[data-slot="report"]');
    var slotRules = wrap.querySelector('[data-slot="rules"]');
    function drawReport() { slotReport.innerHTML = reportHtml(ui); }
    function drawRules() { slotRules.innerHTML = rulesCardHtml(ui); }
    drawReport(); drawRules();

    wrap.addEventListener('change', function (e) {
      if (e.target.id === 'cm-month') {
        ui.month = e.target.value || thisMonth();
        ui.open = null;
        drawReport();
      }
    });
    wrap.addEventListener('click', function (e) {
      if (e.target.closest('.row-detail')) return;
      var tr = e.target.closest('tr[data-id]');
      if (tr && e.target.closest('.link-btn')) {
        ui.open = ui.open === tr.getAttribute('data-id') ? null : tr.getAttribute('data-id');
        drawReport();
      }
    });
    wrap.addEventListener('submit', function (e) {
      e.preventDefault();
      var form = e.target;
      var kind = form.getAttribute('data-form');
      if (kind === 'settle') {
        var res = settle(form.getAttribute('data-id'), ui.month);
        if (!res.ok) return toast(res.reason, 'error');
        drawReport();
        toast('已结算：' + res.settlement.staffName + ' ' + money(res.settlement.total), 'success');
      } else if (kind === 'rules') {
        var r = rules({
          phone: Number(form.elements.phone.value) / 100,
          accessory: Number(form.elements.accessory.value) / 100,
          repair: Number(form.elements.repair.value) / 100,
          tradeIn: Number(form.elements.tradeIn.value) / 100,
          tiers: [
            { threshold: form.elements.threshold1.value, bonus: Number(form.elements.bonus1.value) / 100 },
            { threshold: form.elements.threshold2.value, bonus: Number(form.elements.bonus2.value) / 100 }
          ]
        });
        if (!r.ok) return toast(r.reason, 'error');
        drawRules(); drawReport();
        toast('提成规则已保存', 'success');
      }
    });
  }

  root.PSCommission = {
    rules: rules, calc: calc, settle: settle,
    monthlyReport: monthlyReport, renderCommission: renderCommission
  };
  root.renderCommission = renderCommission;
})(typeof window !== 'undefined' ? window : globalThis);
