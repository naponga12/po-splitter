/**
 * PO Splitter — ตัวเก็บบันทึกการใช้งาน (Google Apps Script)
 *
 * วิธีติดตั้ง (ดูรายละเอียดใน README.md):
 *  1. สร้าง Google Sheet ใหม่ → ส่วนขยาย → Apps Script → วางโค้ดนี้แทนของเดิม
 *  2. แก้ ADMIN_KEY ด้านล่างเป็นรหัสลับของคุณ
 *  3. เลือกฟังก์ชัน setup แล้วกด Run (อนุญาตสิทธิ์ครั้งแรก)
 *  4. Deploy → New deployment → Web app
 *       Execute as: Me   |   Who has access: Anyone
 *  5. คัดลอก URL ที่ลงท้ายด้วย /exec ไปใส่ใน js/config.js (LOG_ENDPOINT)
 */

const ADMIN_KEY = 'change-me-to-a-secret';   // รหัสสำหรับหน้า admin.html
const LOG_SHEET = 'Logs';
const SUMMARY_SHEET = 'สรุปรายวัน';
const TZ = 'Asia/Bangkok';

const HEADERS = [
  'เวลา (เซิร์ฟเวอร์)', 'วันที่', 'เหตุการณ์', 'รหัสเครื่อง', 'รหัสรอบใช้งาน',
  'ชื่อไฟล์', 'จำนวนหน้า', 'จำนวนเอกสาร', 'รายละเอียด (JSON)', 'เบราว์เซอร์', 'เวลา (เครื่องผู้ใช้)',
];

const EVENT_LABEL = {
  visit: 'เข้าใช้งาน',
  file_upload: 'อัปโหลดไฟล์',
  ocr_complete: 'อ่านข้อความเสร็จ',
  export: 'ส่งออกไฟล์',
  clear: 'ล้างไฟล์',
  error: 'ข้อผิดพลาด',
  session_end: 'ออก/ซ่อนหน้า',
};

/** รันครั้งเดียวตอนติดตั้ง: สร้างชีตและหัวตาราง */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(LOG_SHEET) || ss.insertSheet(LOG_SHEET);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#1f4e79').setFontColor('#ffffff');
    sh.setColumnWidth(9, 420);
  }

  let sm = ss.getSheetByName(SUMMARY_SHEET) || ss.insertSheet(SUMMARY_SHEET);
  sm.clear();
  sm.getRange('A1').setFormula(
    "=QUERY(" + LOG_SHEET + "!A2:H," +
    "\"select B, count(B) where B is not null " +
    "group by B pivot C order by B desc label B 'วันที่'\", 0)"
  );
  sm.getRange('A1').setNote('ตารางสรุปจำนวนเหตุการณ์ต่อวัน (สร้างอัตโนมัติจากชีต Logs)');
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('ชีต1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
}

/** รับ log จากเว็บ (POST text/plain JSON) */
function doPost(e) {
  try {
    const b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!b.event) return json({ ok: false, error: 'no event' });
    const now = new Date();
    const row = [
      now,
      Utilities.formatDate(now, TZ, 'yyyy-MM-dd'),
      EVENT_LABEL[b.event] || String(b.event).slice(0, 40),
      cut(b.deviceId, 40),
      cut(b.sessionId, 40),
      cut(b.fileName, 300),
      num(b.pages),
      num(b.docs),
      cut(JSON.stringify(b.details || {}), 40000),
      cut(b.userAgent, 300),
      cut(b.clientTime, 40),
    ];
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET).appendRow(row);
    } finally {
      lock.releaseLock();
    }
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/** สถิติสำหรับหน้า admin.html: GET ?action=stats&key=...&days=30 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action !== 'stats') return json({ ok: true, service: 'PO Splitter log' });
  if (p.key !== ADMIN_KEY) return json({ ok: false, error: 'unauthorized' });

  const days = Math.min(365, Math.max(1, Number(p.days) || 30));
  const since = new Date(Date.now() - days * 86400000);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
  const last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, HEADERS.length).getValues() : [];

  const byDay = {};
  const devices = {};
  const totals = { visits: 0, files: 0, pagesUploaded: 0, exports: 0, docsExported: 0, errors: 0, manualEdits: 0 };
  const recent = [];

  rows.forEach(r => {
    const t = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (t < since) return;
    const day = r[1] instanceof Date ? Utilities.formatDate(r[1], TZ, 'yyyy-MM-dd') : String(r[1]);
    const ev = r[2], dev = r[3];
    const d = byDay[day] = byDay[day] || { day, visits: 0, devices: {}, files: 0, pages: 0, exports: 0, docs: 0 };
    d.devices[dev] = 1;
    const dv = devices[dev] = devices[dev] || { deviceId: dev, visits: 0, files: 0, docs: 0, lastSeen: t };
    if (t > dv.lastSeen) dv.lastSeen = t;
    let det = {};
    try { det = JSON.parse(r[8] || '{}'); } catch (x) { /* ignore */ }

    if (ev === EVENT_LABEL.visit) { totals.visits++; d.visits++; dv.visits++; }
    if (ev === EVENT_LABEL.file_upload) { totals.files++; totals.pagesUploaded += Number(r[6]) || 0; d.files++; d.pages += Number(r[6]) || 0; dv.files++; }
    if (ev === EVENT_LABEL.export) {
      totals.exports++; d.exports++;
      totals.docsExported += Number(r[7]) || 0; d.docs += Number(r[7]) || 0; dv.docs += Number(r[7]) || 0;
      totals.manualEdits += (det.manualPoEdits || 0) + (det.manualItemEdits || 0);
    }
    if (ev === EVENT_LABEL.error) totals.errors++;
    if (ev !== EVENT_LABEL.session_end) {
      recent.push({
        time: Utilities.formatDate(t, TZ, 'yyyy-MM-dd HH:mm:ss'), event: ev, deviceId: dev,
        fileName: r[5], pages: r[6], docs: r[7], details: det,
      });
    }
  });

  const daily = Object.keys(byDay).sort().reverse().map(k => {
    const d = byDay[k];
    return { day: d.day, visits: d.visits, users: Object.keys(d.devices).length, files: d.files, pages: d.pages, exports: d.exports, docs: d.docs };
  });
  const deviceList = Object.keys(devices).map(k => {
    const v = devices[k];
    return { deviceId: v.deviceId, visits: v.visits, files: v.files, docs: v.docs, lastSeen: Utilities.formatDate(v.lastSeen, TZ, 'yyyy-MM-dd HH:mm') };
  }).sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));

  totals.devices = deviceList.length;
  return json({ ok: true, days, totals, daily, devices: deviceList, recent: recent.slice(-200).reverse() });
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function cut(s, n) { return String(s == null ? '' : s).slice(0, n); }
function num(v) { return v === '' || v == null ? '' : Number(v); }
