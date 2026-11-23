/*
 * logger.js — บันทึกการใช้งานส่งไป Google Sheets (ผ่าน Apps Script)
 * ระบุผู้ใช้ด้วย "รหัสเครื่อง" ที่สุ่มเก็บไว้ในเบราว์เซอร์ (ไม่เก็บชื่อ/อีเมล)
 * ไม่ส่งเนื้อหาไฟล์ PDF ออกนอกเครื่อง — ส่งเฉพาะชื่อไฟล์และสถิติ
 */
(function () {
  'use strict';
  const cfg = window.APP_CONFIG || {};

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function getDeviceId() {
    try {
      let id = localStorage.getItem('po_splitter_device_id');
      if (!id) {
        id = 'DEV-' + uuid().slice(0, 8).toUpperCase();
        localStorage.setItem('po_splitter_device_id', id);
      }
      return id;
    } catch (e) {
      return 'DEV-NOSTORAGE';
    }
  }

  const deviceId = getDeviceId();
  const sessionId = 'S-' + uuid().slice(0, 8).toUpperCase();
  const startedAt = Date.now();
  const stats = { files: 0, pages: 0, docsExported: 0, exports: 0 };

  function send(event, payload) {
    payload = payload || {};
    const body = {
      event,
      deviceId,
      sessionId,
      clientTime: new Date().toISOString(),
      fileName: payload.fileName || '',
      pages: payload.pages != null ? payload.pages : '',
      docs: payload.docs != null ? payload.docs : '',
      details: payload.details || {},
      userAgent: navigator.userAgent,
      page: location.href.split('?')[0],
    };
    if (!cfg.LOG_ENDPOINT) {
      console.debug('[log]', body);
      return;
    }
    const data = JSON.stringify(body);
    try {
      // text/plain = ไม่มี CORS preflight, sendBeacon ทำงานแม้ปิดแท็บ
      const blob = new Blob([data], { type: 'text/plain;charset=utf-8' });
      if (navigator.sendBeacon && navigator.sendBeacon(cfg.LOG_ENDPOINT, blob)) return;
    } catch (e) { /* ใช้ fetch แทน */ }
    fetch(cfg.LOG_ENDPOINT, {
      method: 'POST', mode: 'no-cors', keepalive: true,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: data,
    }).catch(() => {});
  }

  let ended = false;
  function endSession() {
    if (ended) return;
    ended = true;
    send('session_end', {
      details: { durationSec: Math.round((Date.now() - startedAt) / 1000), ...stats },
    });
  }
  window.addEventListener('pagehide', endSession);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') endSession();
    else ended = false; // กลับมาใช้ต่อ
  });

  window.UsageLog = { send, deviceId, sessionId, stats };

  send('visit', {
    details: {
      referrer: document.referrer || '',
      language: navigator.language,
      screen: `${screen.width}x${screen.height}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
})();
