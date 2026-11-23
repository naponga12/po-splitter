/*
 * parser.js — ดึงเลข PO และชื่อสินค้ารายการแรก จากผล OCR ของ Tesseract
 * ใช้ได้ทั้งในเบราว์เซอร์ (window.POParser) และ Node (module.exports) เพื่อทดสอบ
 */
(function (root) {
  'use strict';

  const THAI = /[฀-๿]/;

  // Tesseract ภาษาไทยมักใส่ช่องว่างระหว่างตัวอักษรไทย — รวมกลับ
  function cleanThaiSpacing(s) {
    let prev;
    do {
      prev = s;
      s = s.replace(/([฀-๿])\s+([฀-๿])/g, '$1$2');
    } while (s !== prev);
    return s.replace(/\s{2,}/g, ' ').trim();
  }

  // ---------- เลข PO ----------
  // แบบ Lamina:  POL6911-0043   (OCR อาจอ่าน POL เป็น 01 / P0L / PO1)
  // แบบอื่น:     PO0001/70 , PO0001/6911011
  function findPONumber(text) {
    const t = text.replace(/\|/g, ' ');
    let m;
    // 1) POL####-####  (ไม่เอา PRNT####-#### ที่เป็นเลขอ้างอิง)
    m = t.match(/(?:^|[^A-Za-z])P\s*[O0o]\s*[Ll1I]\s*(\d{4})\s*[-–—~]\s*(\d{4})(?!\d)/);
    if (m) return `POL${m[1]}-${m[2]}`;
    // 2) PO####/##  (P/O No.)
    m = t.match(/P\s*[O0o]\s*(\d{4})\s*[\/lI1|]\s*(\d{2,7})(?!\d)/);
    if (m) return `PO${m[1]}/${m[2]}`;
    // 3) หลัง "เลขที่ :" / "Number :" ที่ OCR อ่านตัวหน้าเพี้ยน เช่น "016911-0043"
    m = t.match(/(?:เลขที่|เลขที|Number|No\.?)\s*[:：]\s*[PpOo0Ll1I]{1,3}\s*(\d{4})\s*[-–—]\s*(\d{4})(?!\d)/);
    if (m) return `POL${m[1]}-${m[2]}`;
    return '';
  }

  // ---------- ชื่อสินค้ารายการแรก ----------
  function getLines(data) {
    let lines = data.lines;
    if (!Array.isArray(lines) || !lines.length) {
      lines = [];
      (data.blocks || []).forEach(b => (b.paragraphs || []).forEach(p =>
        (p.lines || []).forEach(l => lines.push(l))));
    }
    if (!lines.length && data.text) {
      return data.text.split('\n').map((t, i) => ({ text: t, y: i }));
    }
    return lines.map(l => ({ text: l.text || '', y: l.bbox ? l.bbox.y0 : 0 }))
      .sort((a, b) => a.y - b.y);
  }

  const HEADER = /(description|descrip|product\s*code|item\s*code|รายละเอียด)/i;
  const ITEM1 = /^[\s"“'‘|.,:;_\-]*[1lI]\s*[|\]\[\s:.]+(.*)$/;
  const HAS_LETTER = /[A-Za-zก-ฮ]/;

  // ตำแหน่ง (y ล่างสุด) ของหัวตาราง — ใช้ OCR ซ้ำเฉพาะแถบรายการถ้ารอบแรกหาไม่เจอ
  function findHeaderBottom(data) {
    let y = -1;
    (data.lines || []).forEach(l => { if (HEADER.test(l.text) && l.bbox) y = Math.max(y, l.bbox.y1); });
    return y;
  }

  function findFirstItem(data) {
    const lines = getLines(data);
    let hdr = -1;
    lines.forEach((l, i) => { if (HEADER.test(l.text)) hdr = i; });
    const start = hdr >= 0 ? hdr + 1 : 0;
    for (let i = start; i < Math.min(lines.length, start + 6); i++) {
      const raw = cleanThaiSpacing(lines[i].text.replace(/\|/g, ' '));
      const m = raw.match(ITEM1);
      if (!m) continue;
      const item = extractDescription(m[1]);
      if (item) return item;
    }
    return '';
  }

  // ตัดรหัสสินค้าข้างหน้า และ จำนวน/ราคา ข้างหลัง
  function extractDescription(s) {
    // "ป" / "|" เดี่ยวๆ มักเป็นเส้นตารางที่ OCR อ่านผิด
    let toks = s.split(/\s+/).filter(t => t && !/^[ปบ|Il!]$/.test(t));
    // ตัดรหัสสินค้า: token ต้นๆ ที่ไม่มีภาษาไทย และ (มีตัวเลข / สั้น / เป็นเครื่องหมาย)
    // รหัสแบบแยกด้วยขีด เช่น "[exp - 001"
    if (toks.length > 3 && !THAI.test(toks[0]) && /^[-–]$/.test(toks[1]) && /\d/.test(toks[2])) toks = toks.slice(3);
    while (toks.length > 1 && !THAI.test(toks[0]) &&
      (/\d/.test(toks[0]) || toks[0].length <= 2 || !HAS_LETTER.test(toks[0]) || /^[\[(]?[a-z]{2,5}[-_]/i.test(toks[0]) && /\d/.test(toks[1] || ''))) {
      toks.shift();
      // รหัสแบบ "exp - 001"
      if (toks[0] === '-' || toks[0] === '–') { toks.shift(); if (toks[0] && /^\d+$/.test(toks[0])) toks.shift(); }
    }
    let d = toks.join(' ');
    // ตัดตั้งแต่ "จำนวน หน่วย ราคา" เช่น " 35 งาน 1,000.00" / " 190.00หน่วย 195.0" / " 150 ชิ้น"
    const cuts = [
      d.search(/\s[\d,]+(\.\d+)?\s*\S{0,8}\s+[\d,]+\.\d{2}(?!\d)/),
      d.search(/\s[\d,]+(\.\d+)?\s*(งาน|ชิ้น|จิ้น|ขิ้น|ซอง|เครื่อง|กล่อง|แผ่น|ชุด|อัน|ม้วน|ตัว|ขวด|ถุง|รีม|หน่วย|เล่ม|ใบ|ขึ้น|ชิ่น|ธิ้น|pcs|set|ea)(?![\u0E00-\u0E7F])/i),
    ].filter(x => x > 0);
    if (cuts.length) d = d.slice(0, Math.min(...cuts));
    // ล้างเศษท้าย: token ที่ไม่มีพยัญชนะ/อักษร
    toks = d.split(/\s+/).filter(Boolean);
    const junk = t => !/^[\d,.]+$/.test(t) && !/[A-Za-zก-ฮ]/.test(t);
    while (toks.length && junk(toks[toks.length - 1])) toks.pop();
    while (toks.length && /^[^ก-ฮA-Za-z0-9]+$/.test(toks[0])) toks.shift();
    d = toks.join(' ')
      .replace(/^[\s\-–—_.,:;'"“]+/, '')
      .replace(/[\]\[]{2,}/g, ']')
      .replace(/[\s\-–—_,:;'"“]+$/, '')
      .trim();
    // วงเล็บเปิด/ปิดที่ไม่ครบ
    if ((d.match(/\[/g) || []).length < (d.match(/\]/g) || []).length && !d.startsWith('[')) d = '[' + d;
    return HAS_LETTER.test(d) ? d : '';
  }

  // รอบสอง: ข้อความจากการ OCR เฉพาะแถบแถวรายการที่ 1 (ลบเส้นตารางแล้ว)
  function findItemInStrip(text) {
    const lines = text.split('\n').map(l => cleanThaiSpacing(l.replace(/\|/g, ' ')));
    for (const l of lines) {
      const m = l.match(/(?:^|\s)[1lI]\s+(?=\S)(.*)$/);
      if (!m) continue;
      const d = extractDescription(m[1]);
      if (d && THAI.test(d)) return d;
    }
    return '';
  }

  // ---------- ชื่อไฟล์ ----------
  function sanitize(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.\-]+|[\s.]+$/g, '')
      .trim();
  }

  function buildFileName(po, item, maxItemLen) {
    maxItemLen = maxItemLen || 80;
    const p = sanitize(po);
    let it = sanitize(item);
    if (it.length > maxItemLen) it = it.slice(0, maxItemLen).trim();
    // macOS/Linux จำกัดชื่อไฟล์ 255 byte (ภาษาไทย 1 ตัว = 3 byte) — จำกัดไว้ 180 byte เผื่อ " (2).pdf"
    const enc = s => new TextEncoder().encode(s).length;
    while (it && enc(p + ' - ' + it) > 180) it = it.slice(0, -1);
    it = it.trim();
    const base = [p, it].filter(Boolean).join(' - ') || 'document';
    return base + '.pdf';
  }

  function parse(data) {
    return { po: findPONumber(data.text || ''), item: findFirstItem(data) };
  }

  const api = { parse, findItemInStrip, findHeaderBottom, findPONumber, findFirstItem, extractDescription, buildFileName, sanitize, cleanThaiSpacing };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.POParser = api;
})(typeof self !== 'undefined' ? self : this);
