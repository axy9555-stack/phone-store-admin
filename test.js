/* Node 自测：node test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILES = ['js/store.js', 'js/inventory.js', 'js/purchase.js', 'js/pos.js', 'js/orders.js',
  'js/staff.js', 'js/commission.js', 'js/customers.js', 'js/repair.js', 'js/dashboard.js', 'js/backup.js'];

// 带 document 桩的环境：渲染函数能真实执行（事件不触发）
function bootDoc() {
  const makeEl = () => ({
    className: '', innerHTML: '', textContent: '',
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, remove() {}, focus() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    closest() { return null; }
  });
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.document = { createElement: () => makeEl(), getElementById: () => makeEl(), body: makeEl() };
  vm.createContext(sandbox);
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

// 建一个没有 document 的“浏览器”环境；传 localStorage 时测持久化，不传时走内存降级
function boot(localStorage) {
  const sandbox = { console };
  if (localStorage) sandbox.localStorage = localStorage;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name + (actual === expected ? '' : '（期望 ' + expected + '，实际 ' + actual + '）'));
}
function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const w = boot();
const { PhoneStore: S, PSInventory: Inv, PSPurchase: Pur } = w;

console.log('数据层');
S.seed();
eq(S.get('products').length, 12, 'seed 后商品 12 个');
eq(S.get('staff').length, 4, 'seed 后店员 4 个');
eq(S.get('staff').filter(s => s.role === '店长').length, 1, '其中店长 1 名');
eq(S.get('suppliers').length, 3, '供应商 3 个');
eq(S.get('customers').length, 3, '会员 3 个');
const phones = S.get('products').filter(p => p.category === '手机');
eq(phones.length, 8, '手机 8 款');
ok(phones.every(p => {
  const n = S.get('imeis').filter(r => r.productId === p.id && r.status === '在库').length;
  return n >= 2 && n <= 3 && n === p.stock;
}), '每款手机 2-3 条在库串号，且与库存数一致');
ok(S.get('imeis').every(r => /^\d{15}$/.test(r.imei)), '演示串号都是 15 位数字');

console.log('库存');
const expectValue = S.get('products').reduce((s, p) => s + p.costPrice * p.stock, 0);
eq(Inv.stockValue(), expectValue, '库存总值 = Σ 进价×库存');
eq(Inv.stockValue(), 94260, '演示数据库存总值为 94260');
eq(Inv.list({ category: '配件' }).length, 4, '按分类过滤出 4 个配件');
eq(Inv.search('apple').length, 2, '按品牌搜索（不分大小写）');
eq(Inv.list({ category: '手机', keyword: 'Mate' }).length, 1, '分类 + 关键词组合过滤');

const bad = Inv.addProduct({ name: '测试机', brand: '测试', category: '手机', costPrice: 1000, price: 1000 });
ok(bad.ok === false && !!bad.reason, '售价 = 进价时新增失败并给出原因');
ok(Inv.addProduct({ name: '测试机', brand: '测试', category: '手机', costPrice: 1000, price: 900 }).ok === false, '售价 < 进价时新增失败');
ok(Inv.addProduct({ brand: '测试', category: '手机', costPrice: 1, price: 2 }).ok === false, '缺名称时新增失败');
eq(S.get('products').length, 12, '新增失败不写入数据');
const added = Inv.addProduct({ name: '数据线', brand: '通用', category: '配件', costPrice: 8, price: 39, stock: 30 });
ok(added.ok && S.get('products').length === 13 && added.product.id === 'P013', '合法商品新增成功，编号顺延');

const priced = Inv.updatePrice('P001', 6199);
const logs = S.get('priceLogs');
ok(priced.ok && S.get('products')[0].price === 6199, '改价生效');
ok(logs.length === 1 && logs[0].productId === 'P001' && logs[0].oldPrice === 5999 &&
  logs[0].newPrice === 6199 && !!logs[0].at, '改价写入调价记录');
ok(Inv.updatePrice('P999', 100).ok === false, '改不存在的商品失败');

const imei = S.get('imeis').filter(r => r.productId === 'P001')[0].imei;
const stock0 = S.get('products')[0].stock;
eq(Inv.imeiStatus(imei), '在库', '串号查询：在库');
eq(Inv.imeiStatus('000000000000000'), null, '查不到的串号返回 null');
ok(Inv.sellImei(imei).ok && Inv.imeiStatus(imei) === '已售' && S.get('products')[0].stock === stock0 - 1, '串号出库：状态已售、库存 -1');
ok(Inv.sellImei(imei).ok === false && S.get('products')[0].stock === stock0 - 1, '已售串号不能重复出库');
ok(Inv.returnImei(imei).ok && Inv.imeiStatus(imei) === '在库' && S.get('products')[0].stock === stock0, '退货入库：状态在库、库存 +1');
ok(Inv.returnImei(imei).ok === false, '在库串号不能退货');

const low = Inv.lowStock();
ok(low.length > 0 && low.every(p => p.stock < 5) && low.some(p => p.name === '充电器'), '低库存预警（默认阈值 5）筛出商品');
eq(Inv.lowStock(1).map(p => p.name).join(','), '耳机', '阈值 1 时只剩缺货的耳机');

console.log('采购');
const made = Pur.create({ supplierId: 'S001', items: [
  { productId: 'P002', qty: 2, costPrice: 7800 },
  { productId: 'P010', qty: 10, costPrice: 12 }
] });
ok(made.ok && made.purchase.total === 15720, '采购单金额合计 = 2×7800 + 10×12');
ok(/^CG\d{8}002$/.test(made.purchase.id) && made.purchase.status === '待收货', '单号 CG+日期+序号，状态待收货');
ok(Pur.create({ supplierId: 'S999', items: [{ productId: 'P002', qty: 1, costPrice: 1 }] }).ok === false, '供应商不存在时建单失败');
ok(Pur.create({ supplierId: 'S001', items: [{ productId: 'P002', qty: 0, costPrice: 1 }] }).ok === false, '数量为 0 时建单失败');

const pid = made.purchase.id;
const proStock = S.get('products')[1].stock;
const caseStock = S.get('products')[9].stock;
const existing = S.get('imeis')[0].imei;
ok(Pur.receive(pid, ['860000000000001']).ok === false, '收货：串号数量不对失败');
ok(Pur.receive(pid, ['860000000000001', '860000000000001']).ok === false, '收货：串号重复失败');
ok(Pur.receive(pid, ['860000000000001', existing]).ok === false, '收货：与系统已有串号重复失败');
ok(Pur.receive(pid, ['860000000000001', '86000000000002']).ok === false, '收货：串号不是 15 位失败');
ok(S.get('products')[1].stock === proStock && made.purchase.status === '待收货', '收货失败不改库存和状态');
const got = Pur.receive(pid, ['860000000000001', '860000000000002']);
ok(got.ok && made.purchase.status === '已收货', '收货成功，状态改已收货');
ok(S.get('products')[1].stock === proStock + 2 && S.get('products')[9].stock === caseStock + 10, '收货后手机和配件库存都增加');
ok(Inv.imeiStatus('860000000000001') === '在库' && Inv.imeiStatus('860000000000002') === '在库', '收货后串号状态为在库');
eq(S.get('imeis').filter(r => r.purchaseId === pid).length, 2, '新串号挂在采购单上');
ok(Pur.receive(pid, ['860000000000003', '860000000000004']).ok === false, '已收货的单不能重复收货');

const seeded = Pur.list().filter(p => p.status === '待收货')[0];
ok(Pur.receive(seeded.id, { P001: ['860000000000011', '860000000000012'] }).ok, '按 {商品ID: 串号[]} 形式收货');

const POS = w.PSPOS, Ord = w.PSOrders;
const ST = w.PSStaff, COM = w.PSCommission, CUS = w.PSCustomers;

console.log('收银');
S.reset();
ok(typeof POS.renderPOS === 'function' && typeof Ord.renderOrders === 'function', '收银 / 订单渲染函数存在');
ok(POS.renderPOS({}) === undefined && Ord.renderOrders({}) === undefined, '没有 document 时新渲染函数直接返回');

let cart = POS.newCart('E002');
ok(cart && cart.staffId === 'E002' && Array.isArray(cart.items) && cart.items.length === 0, 'newCart 建空单');
ok(POS.addItem(cart, 'P009', 2).ok, '配件按数量加购');
ok(POS.addItem(cart, 'P009', 200).ok === false, '配件加购超库存失败');

let t = POS.cartTotal(cart);
eq(t.subtotal, 58, '购物车小计 = 2×29');

ok(POS.addItem(cart, 'P001', 1).ok === false, '手机未指定串号加购失败');
ok(POS.addItem(cart, 'P001', 1, '000000000000000').ok === false, '串号不存在加购失败');
const soldOne = S.get('imeis').find(r => r.productId === 'P002' && r.status === '在库');
Inv.sellImei(soldOne.imei); // 先造一个已售串号
ok(POS.addItem(cart, 'P001', 1, soldOne.imei).ok === false, '已售串号不能占单');
const lockImei = S.get('imeis').find(r => r.productId === 'P001' && r.status === '在库').imei;
ok(POS.addItem(cart, 'P001', 1, lockImei).ok, '在库串号占单成功');
eq(Inv.imeiStatus(lockImei), '已锁定', '占单后串号冻结为已锁定');
eq(S.get('products')[0].stock, 3, '占单不扣库存（防重卖但不出库）');
ok(POS.addItem(cart, 'P001', 1, lockImei).ok === false, '同一串号不能重复占单');

// 释放 / 数量 / 删除
const accIdx = cart.items.findIndex(it => !it.imei);
ok(POS.setQty(cart, accIdx, 3).ok && cart.items[accIdx].qty === 3, 'setQty 改配件数量');
ok(POS.setQty(cart, accIdx, 0).ok === false, 'setQty 数量为 0 失败');
ok(POS.setQty(cart, cart.items.length - 1, 2).ok === false, '手机行数量固定 1 台');
ok(POS.removeItem(cart, cart.items.length - 1).ok, '删除手机行');
eq(Inv.imeiStatus(lockImei), '在库', '删除后串号释放回在库');
S.reset();
cart = POS.newCart('E001');
POS.addItem(cart, 'P001', 1, lockImei);
POS.addItem(cart, 'P009', 2);

t = POS.cartTotal(cart);
eq(t.subtotal, 6057, '小计 = 5999 + 2×29');
eq(t.cost, 5210, '成本合计 = 5200 + 2×5');
ok(POS.applyDiscount(cart, { type: 'amount', value: 6000 }).ok === false, '立减后低于成本总价失败并给原因');
ok(POS.applyDiscount(cart, { type: 'percent', value: 100 }).ok === false, '打折 100% 失败');
const disc = POS.applyDiscount(cart, { type: 'percent', value: 90 });
ok(disc.ok && Math.abs(disc.totals.total - 6057 * 0.9) < 0.01, '打折 90% （九折）后应付 = 小计 × 0.9');
const disc2 = POS.applyDiscount(cart, { type: 'amount', value: 500 });
ok(disc2.ok && Math.abs(disc2.totals.total - (6057 - 500)) < 0.01, '再次应用优惠会替换旧折扣');
ok(POS.applyTradeIn(cart, null).ok, '传 null 清除换新抵扣');

// 现金结账 + 积分 + 出库
const cash = POS.checkout(cart, { payMethod: '现金', paidAmount: 6500, customerId: 'C003' });
ok(cash.ok && cash.change === 6500 - cash.order.total, '现金结账成功，找零 = 实收 − 应付');
const order1 = cash.order;
ok(/^XS\d{8}001$/.test(order1.id) && order1.status === '已完成', '单号 XS+日期+序号，状态已完成');
ok(order1.items.length === 2 && order1.items[0].imei === lockImei, '订单含商品明细和串号');
eq(Inv.imeiStatus(lockImei), '已售', '结账后串号正式出库（已售）');
eq(S.get('products')[0].stock, 2, '结账后手机库存 -1');
eq(S.get('products')[8].stock, 78, '结账后配件库存扣减');
eq(S.get('customers').find(c => c.id === 'C003').points, Math.round(order1.total), '会员积分按实付 1 元 = 1 分累加');
ok(cart.items.length === 0 && cart.discount === null, '结账后购物车清空');
ok(POS.checkout(cart, { payMethod: '微信' }).ok === false, '空购物车不能结账');
ok(POS.checkout(cart, { payMethod: '抖音' }).ok === false, '不支持的支付方式失败');

// 储值支付
let cart2 = POS.newCart('E001');
POS.addItem(cart2, 'P010', 1);
ok(S.get('customers').find(c => c.id === 'C002').balance === undefined, '演示数据会员暂无储值余额');
ok(POS.checkout(cart2, { payMethod: '储值', customerId: 'C002' }).ok === false, '储值：会员无余额失败');
ok(POS.checkout(cart2, { payMethod: '储值', paidAmount: 49, customerId: 'C002' }).ok === false, '储值：余额不足失败且不生成订单');
S.get('customers').find(c => c.id === 'C002').balance = 2000;
S.save();
const stored = POS.checkout(cart2, { payMethod: '储值', customerId: 'C002' });
ok(stored.ok, '储值：余额足够时结账成功');
eq(S.get('customers').find(c => c.id === 'C002').balance, 1951, '储值支付扣减会员余额');
ok(stored.order.change === 0, '非现金支付无找零');

console.log('订单与退货');
ok(Ord.list().length === 2, '订单列表');
ok(Ord.list({ payMethod: '现金' }).length === 1 && Ord.list({ payMethod: '储值' }).length === 1, '按支付方式筛订单');
ok(Ord.list({ keyword: order1.id }).length === 1, '按单号搜订单');
ok(Ord.list({ staffId: 'E999' }).length === 0, '按店员筛订单');
ok(Ord.get(order1.id).id === order1.id && Ord.get('XS00000000001') === null, 'get 订单详情 / 查无返回 null');

ok(Ord.refund(order1.id, null, '').ok === false, '退货须填原因');
const ref1 = Ord.refund(order1.id, [{ productId: 'P009', qty: 1 }], '膜贴坏了');
ok(ref1.ok && ref1.refund.amount === 29, '配件部分退货按原价退');
eq(order1.status, '部分退货', '部分退货后订单状态');
eq(S.get('products')[8].stock, 79, '配件退货回库');
eq(S.get('refunds').length, 1, '退货记录写入 state.refunds');
ok(Ord.refund(order1.id, [{ productId: 'P009', qty: 5 }], '重复退').ok === false, '配件超量退货失败');
ok(Ord.refund(order1.id, [{ imei: '000000000000000' }], '串号不对').ok === false, '串号不在本单退货失败');

const ref2 = Ord.refund(order1.id, null, '顾客反悔整单退');
ok(ref2.ok && ref2.refund.amount === 6028, '整单退货退剩余全部（按原价：手机 5999 + 膣 29）');
eq(order1.status, '已退货', '整单退货后订单状态');
eq(Inv.imeiStatus(lockImei), '在库', '手机退货串号回库');
eq(S.get('products')[0].stock, 3, '手机退货库存 +1');
ok(Ord.refund(order1.id, null, '再退一次').ok === false, '已退货订单不能重复退');

console.log('以旧换新估价');
const q1 = Ord.tradeInQuote({ brand: 'Apple', model: 'iPhone 13', condition: '良好', purchaseYear: new Date().getFullYear() - 2 });
const q2 = Ord.tradeInQuote({ brand: 'Apple', model: 'iPhone 13', condition: '差', purchaseYear: new Date().getFullYear() - 2 });
const q3 = Ord.tradeInQuote({ brand: 'Apple', model: 'iPhone 13', condition: '良好', purchaseYear: new Date().getFullYear() - 5 });
ok(q1.ok && q1.low <= q1.suggest && q1.suggest <= q1.high, '估价区间包含建议回收价');
ok(q1.suggest > q2.suggest, '成色越好估价越高');
ok(q1.suggest > q3.suggest, '越新估价越高');
eq(Ord.tradeInQuote({ brand: 'Apple', condition: '良好', purchaseYear: 2023 }).model, '', '型号可留空');
ok(Ord.tradeInQuote({ brand: 'Apple', condition: '九成新', purchaseYear: 2023 }).ok === false, '成色不对估价失败');
ok(Ord.tradeInQuote({ brand: 'Apple', condition: '良好', purchaseYear: new Date().getFullYear() + 1 }).ok === false, '未来年份估价失败');

// 收银时按估价建议回收价抵扣
S.reset();
const quote = Ord.tradeInQuote({ brand: '华为', model: 'Mate 60', condition: '良好', purchaseYear: new Date().getFullYear() - 1 });
let cart3 = POS.newCart('E001');
POS.addItem(cart3, 'P001', 1, S.get('imeis').find(r => r.productId === 'P001' && r.status === '在库').imei);
const ti = POS.applyTradeIn(cart3, quote);
ok(ti.ok && cart3.tradeIn.deduct === quote.suggest, '收银可按建议回收价抵扣');
const tiTotal = POS.cartTotal(cart3).total;
ok(tiTotal === Math.round((5999 - quote.suggest) * 100) / 100, '换新抵扣后应付 = 售价 − 抵扣');
const tiCash = POS.checkout(cart3, { payMethod: '现金', paidAmount: 10000 });
ok(tiCash.ok && tiCash.order.tradeIn === quote.suggest, '换新抵扣记入订单');

console.log('店员 / 提成 / 会员（chunk 3）');
S.reset();

// 先用收银造三笔本月订单（供 getSales / 提成计算）
const month = today().slice(0, 7);
let c1 = POS.newCart('E001');
POS.addItem(c1, 'P001', 1, S.get('imeis').find(r => r.productId === 'P001' && r.status === '在库').imei);
POS.applyTradeIn(c1, 100);
ok(POS.checkout(c1, { payMethod: '现金', paidAmount: 6000 }).ok, '造单：E001 手机 + 换新抵扣 100');
S.get('products')[8].stock = 4000; S.save();
let c2 = POS.newCart('E002');
POS.addItem(c2, 'P009', 3500);
ok(POS.checkout(c2, { payMethod: '微信' }).ok, '造单：E002 钢化膜 ×3500 = 101500');
S.get('products')[8].stock = 8000; S.save();
let c3 = POS.newCart('E003');
POS.addItem(c3, 'P009', 7200);
ok(POS.checkout(c3, { payMethod: '微信' }).ok, '造单：E003 钢化膜 ×7200 = 208800');

console.log('店员');
eq(ST.list().length, 4, 'seed 后店员 4 名');
ok(ST.add({ name: '测试', phone: '12345' }).ok === false, '手机号不足 11 位新增失败');
ok(ST.add({ name: '测试', phone: '13900000002' }).ok === false, '手机号重复新增失败');
const st5 = ST.add({ name: '刘新', phone: '13811112222', role: '店员', baseSalary: 4000 });
ok(st5.ok && ST.list().length === 5 && st5.staff.id === 'E005', '合法新增店员，编号顺延');
ok(ST.update('E005', { phone: '13900000001' }).ok === false, '改成别人的手机号失败');
ok(ST.update('E005', { name: '刘新新', baseSalary: 4200 }).ok, '合法更新资料');
ok(ST.setRole('E005', '店长', '店员').ok === false, '非店长把人设为店长失败');
ok(ST.setRole('E005', '店长', '店长').ok && ST.list().find(s => s.id === 'E005').role === '店长', '店长可以把人设为店长');
ok(ST.setRole('E005', '维修员', '店员').ok, '非店长可调整普通角色');
ok(ST.setRole('E005', '老板', '店长').ok === false, '非法角色失败');
ok(ST.recordAttendance('E999', today(), '出勤').ok === false, '给不存在的店员打卡失败');
ok(ST.recordAttendance('E005', today(), '旷工').ok === false, '非法考勤状态失败');
ok(ST.recordAttendance('E005', today(), '出勤').ok, '考勤打卡成功');
ST.recordAttendance('E005', today(), '迟到');
const attToday = S.get('attendances').filter(r => r.staffId === 'E005' && r.date === today());
eq(attToday.length, 1, '同人同日重复打卡按最新覆盖');
eq(attToday[0].status, '迟到', '覆盖后的状态为迟到');
ok(ST.getSales('E999', month).ok === false, '查不存在的店员销售额失败');
const gs1 = ST.getSales('E001', month);
ok(gs1.ok && gs1.sales === 5899 && gs1.count === 1, 'E001 本月销售额 5899、1 单');
const gs2 = ST.getSales('E002', month);
ok(gs2.ok && gs2.sales === 101500 && gs2.count === 1, 'E002 本月销售额 101500、1 单');
const gs4 = ST.getSales('E004', month);
ok(gs4.ok && gs4.sales === 0 && gs4.count === 0, '无单店员销售额 0、0 单');

console.log('提成');
const R = COM.rules();
ok(R.phone === 0.02 && R.accessory === 0.05 && R.repair === 0.10 && R.tradeIn === 0.01, '默认提成规则（手机 2%/配件 5%/维修 10%/换新 1%）');
ok(R.tiers.length === 2 && R.tiers[0].threshold === 100000 && R.tiers[1].threshold === 200000, '默认阶梯：满 10 万加 0.5%、满 20 万加 1%');
ok(COM.rules({ phone: 0.31 }).ok === false, '提成比例超 30% 被拒');
ok(COM.rules({ phone: 0 }).ok === false, '提成比例 0 被拒');
ok(COM.rules({ accessory: 0.06 }).ok && COM.rules().accessory === 0.06, '合法比例可保存');
ok(COM.rules({ accessory: 0.05 }).ok, '改回默认 5%');

const cm1 = COM.calc('E001', month);
ok(cm1.ok && Math.abs(cm1.base - 120.98) < 0.005 && cm1.bonus === 0, 'E001 提成 = 手机 5999×2% + 换新回收 100×1% = 120.98');
eq(cm1.details.length, 2, 'E001 明细含销售单与换新回收两行');
const cm2 = COM.calc('E002', month);
ok(cm2.ok && Math.abs(cm2.base - 5075) < 0.005 && Math.abs(cm2.bonus - 7.5) < 0.005, 'E002 阶梯一档：101500×5% + 超出 1500×0.5% = 5082.5');
const cm3 = COM.calc('E003', month);
ok(cm3.ok && Math.abs(cm3.base - 10440) < 0.005 && Math.abs(cm3.bonus - 588) < 0.005, 'E003 阶梯两档：10440 + (10万部分 500 + 超出 8800×1% 88) = 11028');
ok(Math.abs(COM.calc('E001', month).total - 120.98) < 0.005, '提成合计 = 基础 + 阶梯加成');

const se2 = COM.settle('E002', month);
ok(se2.ok && se2.settlement.status === '已结算' && Math.abs(se2.settlement.total - 5082.5) < 0.005, '结算生成结算单（快照 5082.5）');
ok(COM.settle('E002', month).ok === false, '重复结算被拒');
const lockC = COM.calc('E002', month);
ok(lockC.locked === true && Math.abs(lockC.total - 5082.5) < 0.005, '已结算月份 calc 返回锁定快照');
COM.rules({ accessory: 0.3 });
const lockC2 = COM.calc('E002', month);
ok(lockC2.locked && Math.abs(lockC2.total - 5082.5) < 0.005, '改规则后已结算月份仍按快照（不重算）');
ok(COM.rules({ accessory: 0.05 }).ok, '改回默认规则');
const rep = COM.monthlyReport(month);
ok(rep.ok && rep.rows.length === 5 && rep.rows[0].staffId === 'E003', '全店提成榜按提成降序排名');
ok(rep.rows.every((r, i) => r.rank === i + 1), '排名序号 1..N');
ok(rep.rows.find(r => r.staffId === 'E002').locked === true, '榜中已结算店员标记锁定');
ok(COM.monthlyReport('2024-13').ok === false, '非法月份被拒');
ok(COM.settle('E999', month).ok === false, '给不存在的店员结算被拒');

console.log('会员');
eq(CUS.list().length, 3, 'seed 后会员 3 名');
ok(CUS.add({ name: '测试', phone: '12345' }).ok === false, '会员手机号不足 11 位新增失败');
ok(CUS.add({ name: '测试', phone: '13700000001' }).ok === false, '会员手机号重复新增失败');
const cu4 = CUS.add({ name: '钱进', phone: '13611112222' });
ok(cu4.ok && CUS.list().length === 4 && cu4.customer.id === 'C004' && cu4.customer.level === '普通', '合法新增会员，默认普通等级');
ok(CUS.charge('C004', -5).ok === false, '充值金额为负被拒');
ok(CUS.charge('C999', 10).ok === false, '给不存在的会员充值失败');
ok(CUS.charge('C004', 1000).ok && CUS.list().find(c => c.id === 'C004').balance === 1000, '充值 1000 后余额 1000');
ok(S.get('customerLogs').length === 1 && S.get('customerLogs')[0].type === '充值', '充值写入流水');
ok(CUS.spend('C003', 100).ok === false, '储值余额不足消费失败');
eq(CUS.list().find(c => c.id === 'C003').balance, 0, '消费失败不扣余额');
ok(S.get('customerLogs').length === 1, '消费失败不写流水');
const sp4 = CUS.spend('C004', 300);
ok(sp4.ok && CUS.list().find(c => c.id === 'C004').balance === 700, '储值消费 300 后余额 700');
ok(CUS.points('C004').points === 300, '储值消费按 1 元 = 1 分累加积分');
ok(CUS.points('C999').ok === false, '查不存在会员积分失败');
const up1 = CUS.recordSpend('C004', 4700);
ok(up1.ok && up1.level === '银卡' && up1.upgraded === '银卡', '累计消费满 5000 自动升银卡');
const up2 = CUS.recordSpend('C004', 15000);
ok(up2.ok && up2.level === '金卡' && up2.upgraded === '金卡' && CUS.points('C004').points === 20000, '累计消费满 20000 自动升金卡，积分同步累计');
let c5 = POS.newCart('E001');
POS.addItem(c5, 'P009', 1);
ok(POS.checkout(c5, { payMethod: '微信', customerId: 'C001' }).ok, '收银结账挂会员 C001');
ok(CUS.points('C001').points === 1229, '收银结账自动累积分（1200 + 29）');
ok(CUS.list().find(c => c.id === 'C001').totalSpent === 29, '收银结账累计消费入账');

const RP = w.PSRepair, DB = w.PSDashboard, BK = w.PSBackup;

console.log('维修售后');
S.reset();
eq(RP.list().length, 1, 'seed 后有一张待检修维修单');
eq(RP.list()[0].status, '待检修', '演示维修单状态待检修');
ok(RP.create({ customerPhone: '13800000000' }).ok === false, '缺故障描述创建失败');
ok(RP.create({ fault: '不开机' }).ok === false, '缺客户电话创建失败');
ok(RP.create({ customerPhone: '123', fault: '不开机' }).ok === false, '客户电话格式不对创建失败');
const wxA = RP.create({ customerName: '李雷', customerPhone: '13822223333', brand: '华为', model: 'Mate 70', fault: '屏幕碎裂', staffId: 'E004', estimate: 150 });
ok(wxA.ok && /^WX\d{11}$/.test(wxA.repair.id) && wxA.repair.status === '待检修', '合法创建维修单（单号 WX+日期+序号）');
ok(RP.updateStatus(wxA.repair.id, '已完成').ok === false, '状态不能直接跳到已完成（须结算完工）');
ok(RP.updateStatus(wxA.repair.id, '待取机').ok === false, '状态不能从待检修跳到待取机');
ok(RP.updateStatus(wxA.repair.id, '维修中').ok, '待检修 → 维修中');
ok(RP.updateStatus(wxA.repair.id, '维修中').ok === false, '不能重复推进同一步');
ok(RP.updateStatus(wxA.repair.id, '待取机').ok, '维修中 → 待取机');
ok(RP.updateStatus(wxA.repair.id, '已完成').ok === false, '待取机也不能用 updateStatus 直接推到已完成');
const finA = RP.finish(wxA.repair.id);
ok(finA.ok && finA.repair.status === '已完成' && finA.repair.fee === 150, '结算完工：实际费用默认按预估 150');
ok(finA.order.type === '维修' && finA.order.total === 150 && Ord.get(finA.order.id).type === '维修', '完工写维修收入订单到 state.orders');
ok(RP.finish(wxA.repair.id).ok === false, '已完成不能重复结算');
const cmRep = COM.calc('E004', month);
ok(cmRep.ok && Math.abs(cmRep.base - 15) < 0.005 && cmRep.sales === 150, '完工入账进提成：150 × 10% = 15');

const wxB = RP.create({ customerPhone: '13833334444', fault: '进水' });
ok(RP.updateStatus(wxB.repair.id, '已取消').ok, '未完成维修单可取消');
ok(RP.updateStatus(wxB.repair.id, '维修中').ok === false, '已取消的单不能再推进');
ok(RP.updateStatus('WX00000000001', '维修中').ok === false, '不存在的维修单推进失败');

// 在库机送修：占串号 → 完工回在库
const imeiStore = S.get('imeis').find(r => r.productId === 'P001' && r.status === '在库').imei;
const wxC = RP.create({ customerPhone: '13844445555', fault: '听筒没声', imei: imeiStore, staffId: 'E004', estimate: 80 });
ok(wxC.ok && Inv.imeiStatus(imeiStore) === '维修中', '送修占机：串号冻结为维修中');
RP.updateStatus(wxC.repair.id, '维修中');
RP.updateStatus(wxC.repair.id, '待取机');
const finC = RP.finish(wxC.repair.id, 80);
ok(finC.ok && Inv.imeiStatus(imeiStore) === '在库', '在库机完工后串号回在库');

// 客户已购机送修：完工回已售；保修延 90 天
const k1 = POS.newCart('E002');
const imeiSold = S.get('imeis').find(r => r.productId === 'P001' && r.status === '在库' && r.imei !== imeiStore).imei;
POS.addItem(k1, 'P001', 1, imeiSold);
ok(POS.checkout(k1, { payMethod: '现金', paidAmount: 6000 }).ok, '售出一台 P001（供保修测试）');
let wq = RP.warranty(imeiSold);
ok(wq.ok && wq.remainDays === 365 && wq.soldAt === today(), '新售出串号保修剩 365 天');
const wxD = RP.create({ customerName: '韩梅梅', customerPhone: '13855556666', fault: '摔后无法充电', imei: imeiSold, estimate: 60 });
ok(wxD.ok && Inv.imeiStatus(imeiSold) === '维修中', '已售机也可送修占机');
RP.updateStatus(wxD.repair.id, '维修中');
RP.updateStatus(wxD.repair.id, '待取机');
const finD = RP.finish(wxD.repair.id, 60);
ok(finD.ok && Inv.imeiStatus(imeiSold) === '已售', '客户已购机完工后串号回已售（不污染库存）');
wq = RP.warranty(imeiSold);
ok(wq.ok && wq.remainDays === 455 && wq.extendedDays === 90, '维修过延保 90 天：剩 365 + 90 = 455 天');
ok(RP.warranty('000000000000000').ok === false, '查不存在的串号失败');
const wq2 = RP.warranty(S.get('imeis').find(r => r.status === '在库' && r.imei !== imeiStore && r.productId !== 'P001').imei);
ok(wq2.ok && wq2.remainDays === null, '未售出的串号无保修记录');

console.log('看板报表');
const k2 = POS.newCart('E003');
POS.addItem(k2, 'P009', 2);
const accOut = POS.checkout(k2, { payMethod: '微信' });
ok(accOut.ok, '造单：钢化膜 ×2（看板统计用）');

const tdS = DB.today();
ok(tdS.ok && tdS.sales === 6347 && tdS.orderCount === 5, '今日销售额 6347（4 笔销售/维修单 + 1 笔换机单）、5 单');
ok(Math.abs(tdS.profit - 1137) < 0.01, '今日毛利 = 799 + 48 + 维修 290 = 1137');
ok(Math.abs(tdS.avg - 6347 / 5) < 0.01, '客单价 = 销售额 / 订单数');
const ts = DB.topSellers(month, 5);
ok(ts.ok && ts.rows[0].productId === 'P009' && ts.rows[0].qty === 2, '畅销榜按销量排：钢化膜第一');
ok(ts.rows[1].productId === 'P001' && ts.rows.length === 2, '畅销榜次席 P001');
eq(DB.topSellers(month, 1).rows.length, 1, 'top n 生效');
let pf = DB.profit(today(), today());
ok(pf.ok && Math.abs(pf.salesProfit - 847) < 0.01 && pf.repairIncome === 290, '区间毛利：销售毛利 847 + 维修收入 290');
ok(Math.abs(pf.profit - 1137) < 0.01, '区间毛利合计 1137');
ok(DB.profit('2024-13-01', today()).ok === false, '区间毛利：非法日期被拒');
ok(DB.profit(today(), '2020-01-01').ok === false, '区间毛利：起止倒置被拒');
const rf = Ord.refund(accOut.order.id, null, '七日无理由');
ok(rf.ok && rf.refund.amount === 58, '退货 58 元（看板扣减用）');
pf = DB.profit(today(), today());
ok(Math.abs(pf.profit - 1079) < 0.01 && pf.refund === 58, '退货计入毛利扣减：1137 − 58 = 1079');
ok(Math.abs(DB.today().profit - 1079) < 0.01, '今日毛利同步扣减退货');

console.log('备份导入导出');
const dump = BK.exportJSON();
const parsed = JSON.parse(dump);
ok(typeof dump === 'string' && Array.isArray(parsed.orders) && parsed.orders.length === 5 && parsed.settings.storeName === '手机店', '导出 JSON 含全部数据');
const noRefunds = JSON.parse(dump); delete noRefunds.refunds;
ok(BK.importJSON(JSON.stringify(noRefunds)).ok === false && BK.importJSON(JSON.stringify(noRefunds)).reason.indexOf('refunds') !== -1, '导入缺 key 失败并指出缺的 key');
eq(Ord.list().length, 5, '导入失败不覆盖现有数据');
ok(BK.importJSON('{bad json').ok === false, '导入非法 JSON 失败');
const goodDump = JSON.parse(dump);
goodDump.products[0].price = 7000;
ok(BK.importJSON(JSON.stringify(goodDump)).ok, '合法备份导入成功');
eq(S.get('products')[0].price, 7000, '导入后数据被替换');
ok(BK.importJSON(JSON.stringify({ orders: [] })).ok === false, '只给一个 key 也被拒（须 15 个顶层 key 齐全）');

console.log('渲染冒烟（Node 桩 document）');
S.reset();
const wd = bootDoc();
const renders = [
  ['看板', wd.PSDashboard.render], ['库存', wd.PSInventory.renderInventory],
  ['采购', wd.PSPurchase.renderPurchase], ['收银', wd.PSPOS.renderPOS],
  ['订单', wd.PSOrders.renderOrders], ['店员', wd.PSStaff.renderStaff],
  ['提成', wd.PSCommission.renderCommission], ['会员', wd.PSCustomers.renderCustomers],
  ['维修', wd.PSRepair.renderRepair], ['设置', wd.PSBackup.renderBackup]
];
renders.forEach(([name, fn]) => {
  let threw = null;
  try { fn(wd.document.createElement('div')); } catch (e) { threw = e; }
  ok(!threw, name + '页渲染不抛错' + (threw ? '（' + threw.message + '）' : ''));
});
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
ok(['dashboard', 'inventory', 'purchase', 'cashier', 'orders', 'staff', 'commission', 'customers', 'repairs', 'settings']
  .every(k => html.indexOf(k + ': ') !== -1), 'index.html 路由表 10 项齐全');
ok(/dashboard: PSDashboard\.render/.test(html), '看板用 PSDashboard.render 渲染（默认首页）');

console.log('持久化与降级');
ok(typeof Inv.renderInventory === 'function' && typeof Pur.renderPurchase === 'function', '渲染函数存在');
ok(Inv.renderInventory({}) === undefined && Pur.renderPurchase({}) === undefined, '没有 document 时渲染函数直接返回');
S.reset();
ok(S.get('products').length === 12 && S.get('priceLogs').length === 0, 'reset 恢复演示数据');

const disk = {};
const fakeLS = { getItem: k => (k in disk ? disk[k] : null), setItem: (k, v) => { disk[k] = String(v); } };
const a = boot(fakeLS);
a.PhoneStore.load();
a.PSInventory.updatePrice('P003', 5799);
ok('phone-store-v1' in disk, '数据写入 localStorage 的 phone-store-v1');
const b = boot(fakeLS);
ok(b.PhoneStore.load().products[2].price === 5799, '重新加载后读回上次保存的数据');
const broken = boot({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
ok(broken.PhoneStore.load().products.length === 12 && broken.PSInventory.addProduct(
  { name: '支架', brand: '通用', category: '配件', costPrice: 3, price: 19 }).ok, 'localStorage 抛错时退到内存仍可用');

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0 || passed < 16) process.exit(1);
