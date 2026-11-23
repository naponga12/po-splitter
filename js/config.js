/*
 * ตั้งค่าระบบ — แก้ไฟล์นี้ไฟล์เดียวหลังติดตั้ง
 */
window.APP_CONFIG = {
  // URL ของ Google Apps Script Web App (ลงท้ายด้วย /exec) — ดูวิธีตั้งค่าใน README
  // เว้นว่างไว้ = ไม่ส่ง log (ระบบยังใช้งานได้ปกติ)
  LOG_ENDPOINT: 'https://script.google.com/macros/s/AKfycbxt1Sm3i8jzFgKAwOBi9vB8PaBfzw2QlapxphUzQxYDqH_iPuMI8V5vmoJpuh4W_ipw9Q/exec',

  // ความยาวสูงสุดของชื่อสินค้าในชื่อไฟล์ (ตัวอักษร)
  MAX_ITEM_LEN: 80,

  // ตัวคั่นระหว่างเลข PO กับชื่อสินค้า
  NAME_SEPARATOR: ' - ',

  // ภาษาที่ใช้ OCR
  OCR_LANG: 'tha+eng',
};
