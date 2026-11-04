// רישום ה-Service Worker (offline + asset-cache — docs/plans/service-worker-offline.md §3ב).
// Non-blocking: נטען אחרי window 'load' כדי שלא יעכב את ה-boot spinner.
//
// Auto-update (hybrid): כשמתפרסמת גרסה חדשה, ה-BUILD_ID ב-sw.js משתנה → הדפדפן
// מזהה SW חדש → install(skipWaiting) → activate(מוחק cache ישן + clients.claim)
// → controllerchange. בלי טיפול, הדף הנוכחי היה נתקע על assets ישנים עד reload
// ידני. כאן מבחינים בין שני מצבים כדי *לא* לקטוע עבודה:
//   • עדכון סמוך-לטעינה (המשתמש בדיוק רענן/נכנס) → auto-reload חלק.
//   • עדכון באמצע-עבודה (גרסה הופיעה ברקע) → באנר עדין בלבד, בלי reload כפוי.
// רק על update (hadController), לא על ה-install הראשון. OPFS נשמר בין reloads.
if ('serviceWorker' in navigator) {
  var hadController = !!navigator.serviceWorker.controller;   // האם כבר יש SW ששולט ברגע הטעינה?
  var loadedAt = Date.now();
  var refreshing = false;
  var LOAD_WINDOW_MS = 10000;   // controllerchange בתוך חלון זה מטעינה = חלק מזרימת "רעננת→מתעדכן"

  function showUpdateBanner() {
    if (document.getElementById('ow-update-banner')) return;
    var b = document.createElement('div');
    b.id = 'ow-update-banner';
    b.textContent = 'New version available — tap to reload';
    b.style.cssText =
      'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#7c5cff;color:#fff;padding:10px 18px;border-radius:8px;cursor:pointer;' +
      'font:14px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);';
    b.onclick = function () { refreshing = true; window.location.reload(); };
    (document.body || document.documentElement).appendChild(b);
  }

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (refreshing || !hadController) return;   // רק על update אמיתי, לא על first-install
    if (Date.now() - loadedAt < LOAD_WINDOW_MS) {
      refreshing = true;
      window.location.reload();   // עדכון סמוך-לטעינה → auto-reload חלק
    } else {
      showUpdateBanner();         // עדכון באמצע-עבודה → באנר, בלי לקטוע
    }
  });

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js')
      .then(function (reg) { try { reg.update(); } catch (e) {} })   // בדיקת-עדכון יזומה בכל טעינה
      .catch(function (e) { console.warn('[ow] SW register failed', e); });
  });
}
