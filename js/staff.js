/* 店员管理。全局 window.PSStaff */
(function (root) {
  'use strict';

  var Store = root.PhoneStore;
  var ROLES = ['店长', '店员', '收银', '维修员'];
  var ATT_STATUS = ['出勤', '请假', '迟到'];

  function fail(reason) { return { ok: false, reason: reason }; }
  function byId(id) {
    return (Store.get('staff') || []).filter(function (s) { return s.id === id; })[0] || null;
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

  function attendances() {
    var a = Store.get('attendances');
    if (!a) { a = []; Store.set('attendances', a); }
    return a;
  }

  /* ---------- 逻辑 ---------- */

  function list(filter) {
    filter = filter || {};
    var rows = (Store.get('staff') || []).slice();
    if (filter.role) rows = rows.filter(function (s) { return s.role === filter.role; });
    if (filter.active !== undefined) rows = rows.filter(function (s) { return !!s.active === !!filter.active; });
    return rows;
  }

  function validPhone(phone, exceptId) {
    var p = String(phone || '').trim();
    if (!/^1\d{10}$/.test(p)) return '手机号须为 11 位数字（1 开头）';
    var dup = (Store.get('staff') || []).some(function (s) {
      return s.phone === p && s.id !== exceptId;
    });
    if (dup) return '手机号已存在：' + p;
    return null;
  }

  function nextId() {
    var max = 0;
    (Store.get('staff') || []).forEach(function (s) {
      var n = parseInt(String(s.id).replace(/\D/g, ''), 10);
      if (n > max) max = n;
    });
    return 'E' + pad(max + 1, 3);
  }

  function add(input) {
    input = input || {};
    var name = String(input.name || '').trim();
    if (!name) return fail('请填写姓名');
    var phoneErr = validPhone(input.phone);
    if (phoneErr) return fail(phoneErr);
    var role = String(input.role || '店员');
    if (ROLES.indexOf(role) === -1) return fail('角色须为：' + ROLES.join(' / '));
    var salary = Number(input.baseSalary === undefined || input.baseSalary === '' ? 0 : input.baseSalary);
    if (!(salary >= 0) || !isFinite(salary)) return fail('底薪须为不小于 0 的数字');

    var staff = {
      id: nextId(), name: name, phone: String(input.phone).trim(), role: role,
      hireDate: String(input.hireDate || today()).trim(),
      active: input.active === undefined ? true : !!input.active,
      baseSalary: salary
    };
    Store.get('staff').push(staff);
    Store.save();
    return { ok: true, staff: staff };
  }

  function update(staffId, patch) {
    var s = byId(staffId);
    if (!s) return fail('店员不存在');
    patch = patch || {};
    if (patch.name !== undefined) {
      var name = String(patch.name).trim();
      if (!name) return fail('请填写姓名');
      s.name = name;
    }
    if (patch.phone !== undefined) {
      var phoneErr = validPhone(patch.phone, s.id);
      if (phoneErr) return fail(phoneErr);
      s.phone = String(patch.phone).trim();
    }
    if (patch.hireDate !== undefined) s.hireDate = String(patch.hireDate).trim();
    if (patch.baseSalary !== undefined) {
      var salary = Number(patch.baseSalary);
      if (!(salary >= 0) || !isFinite(salary)) return fail('底薪须为不小于 0 的数字');
      s.baseSalary = salary;
    }
    if (patch.active !== undefined) s.active = !!patch.active;
    Store.save();
    return { ok: true, staff: s };
  }

  // setRole(staffId, role, operatorRole)：只有店长能把别人（或自己）设为店长
  function setRole(staffId, role, operatorRole) {
    var s = byId(staffId);
    if (!s) return fail('店员不存在');
    if (ROLES.indexOf(role) === -1) return fail('角色须为：' + ROLES.join(' / '));
    if (role === '店长' && operatorRole !== '店长') {
      return fail('只有店长才能把人设为店长');
    }
    s.role = role;
    Store.save();
    return { ok: true, staff: s };
  }

  // 考勤：同一人同一天重复打卡按最新一条覆盖
  function recordAttendance(staffId, date, status) {
    var s = byId(staffId);
    if (!s) return fail('店员不存在');
    var d = String(date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return fail('日期格式须为 YYYY-MM-DD');
    if (ATT_STATUS.indexOf(status) === -1) return fail('考勤状态须为：' + ATT_STATUS.join(' / '));
    var rows = attendances();
    var hit = rows.filter(function (r) { return r.staffId === staffId && r.date === d; })[0];
    if (hit) hit.status = status;
    else rows.push({ staffId: staffId, date: d, status: status, at: new Date().toISOString() });
    Store.save();
    return { ok: true, record: hit || { staffId: staffId, date: d, status: status } };
  }

  function attendanceOf(staffId) {
    return attendances().filter(function (r) { return r.staffId === staffId; })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  }

  // 某店员某月销售额与订单数（从 state.orders 汇总）
  function getSales(staffId, month) {
    var s = byId(staffId);
    if (!s) return fail('店员不存在');
    var m = String(month || thisMonth()).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return fail('月份格式须为 YYYY-MM');
    var orders = (Store.get('orders') || []).filter(function (o) {
      return o.staffId === staffId && String(o.date).slice(0, 7) === m;
    });
    return {
      ok: true, staffId: staffId, month: m,
      sales: orders.reduce(function (sum, o) { return sum + o.total; }, 0),
      count: orders.length, orders: orders.map(function (o) { return o.id; })
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

  function addFormHtml() {
    return '<form class="card form-card" data-form="add" novalidate><h2>新增店员</h2><div class="form-grid">' +
      '<div class="field"><label for="st-name">姓名（必填）</label><input id="st-name" name="name" type="text" autocomplete="off"></div>' +
      '<div class="field"><label for="st-phone">手机号（11 位，必填）</label><input id="st-phone" name="phone" type="tel" inputmode="numeric" maxlength="11" autocomplete="off"></div>' +
      '<div class="field"><label for="st-role">角色</label><select id="st-role" name="role">' +
      ROLES.map(function (r) { return '<option value="' + r + '"' + (r === '店员' ? ' selected' : '') + '>' + r + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label for="st-hire">入职日期</label><input id="st-hire" name="hireDate" type="date" value="' + today() + '"></div>' +
      '<div class="field"><label for="st-salary">底薪（元/月）</label><input id="st-salary" name="baseSalary" type="number" inputmode="decimal" min="0" step="0.01" value="0"></div>' +
      '</div><div class="actions"><button type="submit" class="btn btn-primary">保存</button>' +
      '<button type="button" class="btn btn-secondary" data-action="toggle-add">取消</button></div></form>';
  }

  function detailHtml(s) {
    var month = thisMonth();
    var sales = getSales(s.id, month);
    var att = attendanceOf(s.id).slice(0, 10);
    var status = sales.ok ? '销售额 ' + money(sales.sales) + ' · 订单 ' + sales.count + ' 单' : '';
    var html = '<div class="detail"><h3>' + esc(s.name) + ' · ' + month + '</h3>' +
      '<dl class="pos-totals"><dt>本月业绩</dt><dd>' + esc(status) + '</dd>' +
      '<dt>入职日期</dt><dd>' + esc(s.hireDate || '—') + '</dd>' +
      '<dt>底薪</dt><dd>' + money(s.baseSalary || 0) + '</dd>' +
      '<dt>在职状态</dt><dd>' + (s.active === false ? '离职' : '在职') + '</dd></dl>' +
      '<form class="inline-form" data-form="attendance" data-id="' + esc(s.id) + '">' +
      '<div class="field"><label for="st-att-date-' + esc(s.id) + '">打卡日期</label>' +
      '<input id="st-att-date-' + esc(s.id) + '" name="date" type="date" value="' + today() + '"></div>' +
      '<div class="field"><label for="st-att-status-' + esc(s.id) + '">考勤状态</label><select id="st-att-status-' + esc(s.id) + '" name="status">' +
      ATT_STATUS.map(function (x) { return '<option value="' + x + '">' + x + '</option>'; }).join('') +
      '</select></div><button type="submit" class="btn btn-secondary">打卡</button></form>';
    html += att.length
      ? '<ul class="plain-list">' + att.map(function (r) {
        return '<li>' + esc(r.date) + ' — ' + esc(r.status) + '</li>';
      }).join('') + '</ul>'
      : '<p class="muted small">暂无考勤记录。</p>';
    html += '<form class="detail" data-form="edit" data-id="' + esc(s.id) + '"><h3>编辑资料</h3><div class="form-grid">' +
      '<div class="field"><label for="st-e-name-' + esc(s.id) + '">姓名</label><input id="st-e-name-' + esc(s.id) + '" name="name" type="text" value="' + esc(s.name) + '"></div>' +
      '<div class="field"><label for="st-e-phone-' + esc(s.id) + '">手机号</label><input id="st-e-phone-' + esc(s.id) + '" name="phone" type="tel" inputmode="numeric" maxlength="11" value="' + esc(s.phone) + '"></div>' +
      '<div class="field"><label for="st-e-hire-' + esc(s.id) + '">入职日期</label><input id="st-e-hire-' + esc(s.id) + '" name="hireDate" type="date" value="' + esc(s.hireDate || '') + '"></div>' +
      '<div class="field"><label for="st-e-salary-' + esc(s.id) + '">底薪（元/月）</label><input id="st-e-salary-' + esc(s.id) + '" name="baseSalary" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(s.baseSalary || 0) + '"></div>' +
      '<div class="field"><label for="st-e-active-' + esc(s.id) + '">在职状态</label><select id="st-e-active-' + esc(s.id) + '" name="active">' +
      '<option value="1"' + (s.active === false ? '' : ' selected') + '>在职</option>' +
      '<option value="0"' + (s.active === false ? ' selected' : '') + '>离职</option></select></div>' +
      '</div><div class="actions"><button type="submit" class="btn btn-primary">保存修改</button></div></form>';
    html += '<form class="detail" data-form="role" data-id="' + esc(s.id) + '"><h3>调整角色</h3><div class="form-grid">' +
      '<div class="field"><label for="st-r-op-' + esc(s.id) + '">操作人</label><select id="st-r-op-' + esc(s.id) + '" name="operatorId">' +
      (Store.get('staff') || []).map(function (o) {
        return '<option value="' + esc(o.id) + '">' + esc(o.name) + '（' + esc(o.role) + '）</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label for="st-r-role-' + esc(s.id) + '">新角色</label><select id="st-r-role-' + esc(s.id) + '" name="role">' +
      ROLES.map(function (r) { return '<option value="' + r + '"' + (r === s.role ? ' selected' : '') + '>' + r + '</option>'; }).join('') +
      '</select></div></div>' +
      '<p class="muted small">只有店长能把人设为店长。</p>' +
      '<div class="actions"><button type="submit" class="btn btn-primary">确认调整</button></div></form>';
    return html + '</div>';
  }

  function listHtml(ui) {
    var rows = list();
    if (!rows.length) return '<p class="empty">还没有店员。</p>';
    var body = rows.map(function (s) {
      var open = ui.open === s.id;
      var tr = '<tr data-id="' + esc(s.id) + '"><td><button type="button" class="link-btn" aria-expanded="' + open + '">' +
        esc(s.name) + '</button></td><td>' + esc(s.role) + '</td><td>' + esc(s.phone) + '</td>' +
        '<td class="num">' + money(s.baseSalary || 0) + '</td>' +
        '<td>' + (s.active === false ? '<span class="badge badge-muted">离职</span>' : '<span class="badge badge-ok">在职</span>') + '</td></tr>';
      if (open) tr += '<tr class="row-detail"><td colspan="5">' + detailHtml(s) + '</td></tr>';
      return tr;
    }).join('');
    return '<div class="table-wrap"><table class="table"><thead><tr><th>姓名</th><th>角色</th><th>电话</th>' +
      '<th class="num">底薪</th><th>状态</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="muted small">共 ' + rows.length + ' 名店员。点姓名展开业绩、考勤与编辑。</p>';
  }

  function renderStaff(el) {
    if (!el || typeof document === 'undefined') return;
    var ui = { open: null, adding: false };
    var wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.innerHTML =
      '<div class="page-head"><h1>店员管理</h1>' +
      '<button type="button" class="btn btn-primary" data-action="toggle-add">新增店员</button></div>' +
      '<div data-slot="add"></div><div class="card"><h2>店员列表</h2><div data-slot="list"></div></div>';
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
        if (ui.adding) wrap.querySelector('#st-name').focus();
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
        res = add({
          name: form.elements.name.value, phone: form.elements.phone.value,
          role: form.elements.role.value, hireDate: form.elements.hireDate.value,
          baseSalary: form.elements.baseSalary.value
        });
        if (!res.ok) return toast(res.reason, 'error');
        ui.adding = false;
        drawAdd(); drawList();
        toast('已新增店员：' + res.staff.name, 'success');
      } else if (kind === 'attendance') {
        res = recordAttendance(id, form.elements.date.value, form.elements.status.value);
        if (!res.ok) return toast(res.reason, 'error');
        drawList();
        toast('已打卡：' + res.record.date + ' ' + res.record.status, 'success');
      } else if (kind === 'edit') {
        res = update(id, {
          name: form.elements.name.value, phone: form.elements.phone.value,
          hireDate: form.elements.hireDate.value,
          baseSalary: form.elements.baseSalary.value,
          active: form.elements.active.value === '1'
        });
        if (!res.ok) return toast(res.reason, 'error');
        drawList();
        toast('已保存 ' + res.staff.name + ' 的资料', 'success');
      } else if (kind === 'role') {
        var operator = byId(form.elements.operatorId.value);
        res = setRole(id, form.elements.role.value, operator ? operator.role : '');
        if (!res.ok) return toast(res.reason, 'error');
        drawList();
        toast(res.staff.name + ' 角色已调整为 ' + res.staff.role, 'success');
      }
    });
  }

  root.PSStaff = {
    list: list, add: add, update: update, setRole: setRole,
    recordAttendance: recordAttendance, getSales: getSales, renderStaff: renderStaff
  };
  root.renderStaff = renderStaff;
})(typeof window !== 'undefined' ? window : globalThis);
