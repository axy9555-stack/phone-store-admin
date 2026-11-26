/* 数据备份：导出 / 导入 / 恢复演示数据。全局 window.PSBackup */
(function (root) {
  'use strict';

  var Store = root.PhoneStore;

  var KEYS = ['products', 'imeis', 'suppliers', 'purchases', 'orders', 'staff',
    'commissions', 'customers', 'repairs', 'priceLogs', 'refunds',
    'attendances', 'settlements', 'customerLogs', 'settings'];

  /* ---------- 逻辑 ---------- */

  // 当前完整 state 的 JSON 字符串
  function exportJSON() {
    var obj = {};
    KEYS.forEach(function (k) { obj[k] = Store.get(k); });
    return JSON.stringify(obj, null, 2);
  }

  /*
   * 导入：解析并校验顶层 key 齐全（缺 key 返回原因），
   * 校验通过后整体替换 state 并保存。
   */
  function importJSON(text) {
    var data;
    try {
      data = JSON.parse(String(text));
    } catch (e) {
      return { ok: false, reason: '不是合法的 JSON 文件：' + e.message };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: '备份文件格式不对：顶层须是对象' };
    }
    var missing = KEYS.filter(function (k) { return !(k in data); });
    if (missing.length) {
      return { ok: false, reason: '备份缺少顶层 key：' + missing.join('、') };
    }
    var badType = KEYS.filter(function (k) {
      return k === 'settings'
        ? typeof data[k] !== 'object' || data[k] === null || Array.isArray(data[k])
        : !Array.isArray(data[k]);
    });
    if (badType.length) {
      return { ok: false, reason: '备份字段类型不对：' + badType.join('、') };
    }
    var merged = {};
    KEYS.forEach(function (k) { merged[k] = data[k]; });
    Store.save(merged); // 整体替换
    return { ok: true };
  }

  /* ---------- 渲染（设置页） ---------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, type) {
    if (typeof root.PSToast === 'function') root.PSToast(msg, type);
  }
  function pct(n) { return (Number(n) * 100).toFixed(1).replace(/\.0$/, '') + '%'; }

  function rulesReadonlyHtml() {
    var r = root.PSCommission.rules();
    return '<dl class="pos-totals">' +
      '<dt>手机提成</dt><dd>' + pct(r.phone) + '</dd>' +
      '<dt>配件提成</dt><dd>' + pct(r.accessory) + '</dd>' +
      '<dt>维修提成</dt><dd>' + pct(r.repair) + '</dd>' +
      '<dt>换新回收提成</dt><dd>' + pct(r.tradeIn) + '</dd>' +
      '<dt>阶梯一档</dt><dd>满 ¥' + r.tiers[0].threshold + ' 加 ' + pct(r.tiers[0].bonus) + '（按超出部分）</dd>' +
      '<dt>阶梯二档</dt><dd>满 ¥' + r.tiers[1].threshold + ' 加 ' + pct(r.tiers[1].bonus) + '（按超出部分）</dd>' +
      '</dl><p class="muted small">规则在“提成”页可修改，此处只读展示。</p>';
  }

  function renderBackup(el) {
    if (!el || typeof document === 'undefined') return;
    el.innerHTML =
      '<div class="page"><div class="page-head"><h1>设置</h1></div>' +
      '<div class="card"><h2>数据备份</h2>' +
      '<p class="muted small">数据全部保存在本机浏览器（localStorage），换设备或清缓存前请先导出备份。</p>' +
      '<div class="actions">' +
      '<button type="button" class="btn btn-primary" data-action="export">导出备份（.json）</button>' +
      '<label class="btn btn-secondary file-btn">导入备份（覆盖现有数据）' +
      '<input type="file" accept=".json,application/json" data-role="import" style="display:none"></label>' +
      '</div></div>' +
      '<div class="card"><h2>恢复演示数据</h2>' +
      '<p class="muted small">把全部数据重置成出厂演示数据，现有数据会丢失（建议先导出备份）。</p>' +
      '<div class="actions"><button type="button" class="btn btn-danger" data-action="reset">恢复演示数据</button></div></div>' +
      '<div class="card"><h2>提成规则（只读）</h2>' + rulesReadonlyHtml() + '</div>' +
      '</div>';

    el.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      if (action === 'export') {
        var text = exportJSON();
        var d = new Date();
        var name = 'phone-store-backup-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '.json';
        if (typeof Blob === 'function' && typeof URL !== 'undefined' && URL.createObjectURL) {
          var blob = new Blob([text], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = name;
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
        } else {
          console.log(text); // 无 Blob 环境退化为控制台输出
        }
        toast('已导出备份 ' + name, 'success');
      } else if (action === 'reset') {
        if (!window.confirm('确定恢复演示数据吗？现有全部数据将被覆盖！')) return;
        Store.reset();
        toast('已恢复演示数据', 'success');
      }
    });
    el.addEventListener('change', function (e) {
      if (e.target.getAttribute('data-role') !== 'import') return;
      var file = e.target.files && e.target.files[0];
      e.target.value = ''; // 允许重复选同一文件
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || '');
        // 先校验，通过后再弹确认覆盖
        var pre = importCheck(text);
        if (!pre.ok) return toast(pre.reason, 'error');
        if (!window.confirm('导入将覆盖现有全部数据，确定继续吗？（建议先导出备份）')) return;
        var res = importJSON(text);
        if (!res.ok) return toast(res.reason, 'error');
        toast('导入成功，数据已覆盖', 'success');
      };
      reader.readAsText(file, 'utf-8');
    });
  }

  // 只校验不落库（导入确认前用）
  function importCheck(text) {
    var data;
    try {
      data = JSON.parse(String(text));
    } catch (e) {
      return { ok: false, reason: '不是合法的 JSON 文件：' + e.message };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: '备份文件格式不对：顶层须是对象' };
    }
    var missing = KEYS.filter(function (k) { return !(k in data); });
    if (missing.length) return { ok: false, reason: '备份缺少顶层 key：' + missing.join('、') };
    var badType = KEYS.filter(function (k) {
      return k === 'settings'
        ? typeof data[k] !== 'object' || data[k] === null || Array.isArray(data[k])
        : !Array.isArray(data[k]);
    });
    if (badType.length) return { ok: false, reason: '备份字段类型不对：' + badType.join('、') };
    return { ok: true };
  }

  function pad2(n) { var s = String(n); while (s.length < 2) s = '0' + s; return s; }

  root.PSBackup = {
    exportJSON: exportJSON, importJSON: importJSON,
    importCheck: importCheck, renderBackup: renderBackup
  };
  root.renderBackup = renderBackup;
})(typeof window !== 'undefined' ? window : globalThis);
