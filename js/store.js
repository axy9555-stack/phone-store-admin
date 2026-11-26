/* 数据层：只做存取，不碰业务。全局 window.PhoneStore */
(function (root) {
  'use strict';

  var KEY = 'phone-store-v1';
  var memory = null; // localStorage 不可用时的内存降级
  var state = null;

  function emptyState() {
    return {
      products: [], imeis: [], suppliers: [], purchases: [], orders: [],
      staff: [], commissions: [], customers: [], repairs: [], priceLogs: [],
      refunds: [], attendances: [], settlements: [], customerLogs: [],
      settings: {}
    };
  }

  function readRaw() {
    try {
      if (root.localStorage) return root.localStorage.getItem(KEY);
    } catch (e) { /* 隐私模式等：走内存 */ }
    return memory;
  }

  function writeRaw(text) {
    memory = text;
    try {
      if (root.localStorage) { root.localStorage.setItem(KEY, text); return true; }
    } catch (e) { /* 配额满或被禁用：数据仍在内存里 */ }
    return false;
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

  function demoState() {
    var s = emptyState();
    var day = today();

    // [名称, 品牌, 型号, 分类, 进价, 售价, 库存]
    var rows = [
      ['iPhone 17', 'Apple', '256GB', '手机', 5200, 5999, 3],
      ['iPhone 17 Pro', 'Apple', '256GB', '手机', 7800, 8999, 2],
      ['华为 Mate 80', '华为', '12+256GB', '手机', 4900, 5699, 3],
      ['小米 17', '小米', '12+256GB', '手机', 3800, 4499, 3],
      ['OPPO Find X9', 'OPPO', '12+256GB', '手机', 3700, 4399, 2],
      ['vivo X300', 'vivo', '12+256GB', '手机', 3750, 4399, 2],
      ['荣耀 Magic 8', '荣耀', '12+256GB', '手机', 3600, 4299, 3],
      ['三星 S26', '三星', '12+256GB', '手机', 5000, 5999, 2],
      ['钢化膜', '通用', '高清防爆', '配件', 5, 29, 80],
      ['手机壳', '通用', '液态硅胶', '配件', 12, 49, 60],
      ['充电器', '通用', '65W 快充', '配件', 35, 99, 4],
      ['耳机', '通用', '蓝牙降噪', '配件', 120, 299, 0]
    ];
    rows.forEach(function (r, i) {
      var id = 'P' + pad(i + 1, 3);
      s.products.push({
        id: id, name: r[0], brand: r[1], model: r[2], category: r[3],
        costPrice: r[4], price: r[5], stock: r[6]
      });
      // 手机：库存几台就有几条在库串号（2-3 条），保证库存数与串号一致
      if (r[3] === '手机') {
        for (var k = 1; k <= r[6]; k++) {
          s.imeis.push({
            imei: '86' + String(1000000000000 + (i + 1) * 1000 + k),
            productId: id, status: '在库', purchaseId: null
          });
        }
      }
    });

    s.suppliers = [
      { id: 'S001', name: '华强北数码批发', contact: '陈经理', phone: '13800000001' },
      { id: 'S002', name: '省级运营商渠道', contact: '刘主管', phone: '13800000002' },
      { id: 'S003', name: '优品配件商行', contact: '周老板', phone: '13800000003' }
    ];

    s.staff = [
      { id: 'E001', name: '王店长', role: '店长', phone: '13900000001', baseSalary: 8000, hireDate: '2021-03-15', active: true },
      { id: 'E002', name: '李晓梅', role: '店员', phone: '13900000002', baseSalary: 4500, hireDate: '2022-06-01', active: true },
      { id: 'E003', name: '张伟', role: '店员', phone: '13900000003', baseSalary: 4500, hireDate: '2023-02-20', active: true },
      { id: 'E004', name: '赵婷', role: '收银', phone: '13900000004', baseSalary: 4200, hireDate: '2023-09-10', active: true }
    ];

    s.customers = [
      { id: 'C001', name: '孙先生', phone: '13700000001', points: 1200 },
      { id: 'C002', name: '吴女士', phone: '13700000002', points: 560 },
      { id: 'C003', name: '郑先生', phone: '13700000003', points: 0 }
    ];

    // 一张待收货采购单，方便演示收货入库
    s.purchases = [{
      id: 'CG' + day.replace(/-/g, '') + '001',
      supplierId: 'S001',
      items: [
        { productId: 'P001', qty: 2, costPrice: 5200 },
        { productId: 'P009', qty: 20, costPrice: 5 }
      ],
      total: 10500, status: '待收货', createdAt: day, receivedAt: null
    }];

    s.settings = { storeName: '手机店', lowStockThreshold: 5 };

    // 一张待检修维修单，方便演示维修流程
    s.repairs = [{
      id: 'WX' + day.replace(/-/g, '') + '001',
      customerName: '孙先生', customerPhone: '13700000001',
      brand: '小米', model: '17', imei: '', fault: '充电慢，偶发重启',
      estimate: 120, status: '待检修', staffId: 'E004',
      fee: 0, createdAt: day, finishedAt: null
    }];
    return s;
  }

  function save(next) {
    if (next) state = next;
    if (!state) state = emptyState();
    writeRaw(JSON.stringify(state));
    return state;
  }

  function seed() {
    return save(demoState());
  }

  function load() {
    var raw = readRaw();
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          // 补齐后续版本新增的顶层 key
          var base = emptyState();
          Object.keys(base).forEach(function (k) {
            if (parsed[k] === undefined || parsed[k] === null) parsed[k] = base[k];
          });
          state = parsed;
          return state;
        }
      } catch (e) { /* 数据损坏：回落到演示数据 */ }
    }
    return seed();
  }

  function get(key) {
    if (!state) load();
    return state[key];
  }

  function set(key, value) {
    if (!state) load();
    state[key] = value;
    save();
    return value;
  }

  root.PhoneStore = { load: load, save: save, reset: seed, seed: seed, get: get, set: set };
})(typeof window !== 'undefined' ? window : globalThis);
