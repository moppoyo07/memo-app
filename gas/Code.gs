/**
 * 貸し借り帳 API（Googleスプレッドシート保存）
 * PWA（GitHub Pages）から POST で呼ばれ、JSON を返す。
 * 自分用キーとスタッフ用キーで、見られる範囲とできることを分ける。
 */
const SHEET_TX = '取引';
const SHEET_CONF = '設定';
const HEADERS = ['ID', '日付', '種別', '金額', 'メモ', '相手確認日時', '取消'];

/** 最初に1回だけ実行：シートと秘密キーを作る */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(SHEET_TX)) {
    const sh = ss.insertSheet(SHEET_TX);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  if (!ss.getSheetByName(SHEET_CONF)) {
    const sh = ss.insertSheet(SHEET_CONF);
    sh.getRange(1, 1, 4, 2).setValues([
      ['自分の名前', '自分'],
      ['相手の名前', 'スタッフ'],
      ['与信枠', 100000],
      ['アプリのURL', 'https://あなたのID.github.io/リポジトリ名/'],
    ]);
  }
  const props = PropertiesService.getScriptProperties();
  ['OWNER_KEY', 'STAFF_KEY'].forEach(k => {
    if (!props.getProperty(k)) props.setProperty(k, newKey_());
  });
  Logger.log('準備完了。「設定」シートを書き換えてください。');
}

/** 自分用・相手用のアプリのリンクをログに出す */
function showLinks() {
  const app = String(conf_().appUrl);
  const p = PropertiesService.getScriptProperties();
  Logger.log('自分用: ' + app + '?k=' + p.getProperty('OWNER_KEY'));
  Logger.log('相手用: ' + app + '?k=' + p.getProperty('STAFF_KEY'));
}

/** 相手用リンクを無効にして作り直す（リンクが漏れたとき用） */
function resetStaffKey() {
  PropertiesService.getScriptProperties().setProperty('STAFF_KEY', newKey_());
  showLinks();
}

function doGet() {
  return ContentService.createTextOutput('OK');
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    out = { ok: true, data: handle_(req) };
  } catch (err) {
    out = { ok: false, error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  const role = roleOf_(req.k);
  switch (req.action) {
    case 'get':
      break;
    case 'add':
      if (role !== 'owner') throw new Error('登録はできません');
      addTx_(req.type, req.date, req.amount, req.memo);
      break;
    case 'confirm':
      if (role !== 'staff') throw new Error('確認は相手が行います');
      confirmTx_(req.id);
      break;
    case 'void':
      if (role !== 'owner') throw new Error('取消はできません');
      voidTx_(req.id);
      break;
    default:
      throw new Error('不明な操作です');
  }
  return view_(role);
}

// ---- 画面に返すデータ ----

function view_(role) {
  const c = conf_();
  const tz = Session.getScriptTimeZone();
  const sh = txSheet_();
  const n = sh.getLastRow() - 1;
  const rows = n > 0 ? sh.getRange(2, 1, n, HEADERS.length).getValues() : [];

  let balance = 0;
  const items = rows.map((r, i) => {
    const it = {
      id: String(r[0]),
      sort: (r[1] instanceof Date ? r[1].getTime() : 0) * 10000 + i,
      date: r[1] instanceof Date ? Utilities.formatDate(r[1], tz, 'yyyy/MM/dd') : '',
      type: String(r[2]),
      amount: Number(r[3]),
      memo: String(r[4]),
      confirmed: r[5] instanceof Date ? Utilities.formatDate(r[5], tz, 'yyyy/MM/dd HH:mm') : '',
      voided: r[6] === true || r[6] === 'TRUE',
    };
    if (!it.voided) balance += it.type === '貸付' ? it.amount : -it.amount;
    return it;
  }).sort((a, b) => b.sort - a.sort);

  if (role === 'owner') {
    return {
      role: role,
      ownerName: c.ownerName,
      staffName: c.staffName,
      limit: c.limit,
      balance: balance,
      items: items,
    };
  }
  // スタッフには日付・金額・返済状況と残高だけ（メモ・与信枠・取消分は見せない）
  return {
    role: role,
    ownerName: c.ownerName,
    staffName: c.staffName,
    balance: balance,
    items: items.filter(it => !it.voided).map(it => ({
      id: it.id,
      date: it.date,
      type: it.type,
      amount: it.amount,
      confirmed: it.confirmed,
    })),
  };
}

// ---- 書き込み ----

function addTx_(type, date, amount, memo) {
  if (type !== '貸付' && type !== '返済') throw new Error('種別が正しくありません');
  amount = Math.floor(Number(amount));
  if (!(amount > 0)) throw new Error('金額を正しく入力してください');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : new Date();
  memo = String(memo || '').slice(0, 200);
  if (/^[=+\-@]/.test(memo)) memo = "'" + memo; // 数式として解釈させない
  withLock_(() => {
    txSheet_().appendRow([newKey_(), d, type, amount, memo, '', false]);
  });
}

function confirmTx_(id) {
  withLock_(() => {
    const sh = txSheet_();
    const row = findRow_(id);
    if (sh.getRange(row, 3).getValue() !== '返済') throw new Error('確認できるのは返済だけです');
    if (!sh.getRange(row, 6).getValue()) sh.getRange(row, 6).setValue(new Date());
  });
}

function voidTx_(id) {
  withLock_(() => {
    txSheet_().getRange(findRow_(id), 7).setValue(true);
  });
}

// ---- 内部用 ----

function roleOf_(key) {
  const p = PropertiesService.getScriptProperties();
  if (key && key === p.getProperty('OWNER_KEY')) return 'owner';
  if (key && key === p.getProperty('STAFF_KEY')) return 'staff';
  throw new Error('リンクが正しくありません');
}

function conf_() {
  const rows = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(SHEET_CONF).getRange(1, 1, 4, 2).getValues();
  return {
    ownerName: String(rows[0][1]),
    staffName: String(rows[1][1]),
    limit: Number(rows[2][1]) || 0,
    appUrl: String(rows[3][1]),
  };
}

function txSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TX);
}

function findRow_(id) {
  const sh = txSheet_();
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    const ids = sh.getRange(2, 1, n, 1).getValues();
    for (let i = 0; i < n; i++) {
      if (String(ids[i][0]) === String(id)) return i + 2;
    }
  }
  throw new Error('記録が見つかりません');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function newKey_() {
  return Utilities.getUuid().replace(/-/g, '');
}
