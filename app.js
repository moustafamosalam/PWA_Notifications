/* app.js — Arabic RTL test app for Cloudflare Web Push */
const $ = (id) => document.getElementById(id);
const LS_KEY = 'push_worker_url';

function log(msg) {
  const line = new Date().toLocaleTimeString('ar-EG') + '  ' + msg;
  $('log').textContent = line + '\n' + $('log').textContent;
}

function workerUrl() {
  return (localStorage.getItem(LS_KEY) || '').trim().replace(/\/+$/, '');
}

function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function postJson(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {})
  });
  let body;
  try { body = await res.json(); } catch (e) { body = { ok: false, error: 'HTTP ' + res.status }; }
  return body;
}

function baseState() {
  const permAr = { granted: 'مسموح', denied: 'مرفوض', 'default': 'لسه مسألناش' };
  return [
    isStandalone() ? 'مثبت على الشاشة ✔' : 'مش مثبت ✖ (ثبّته من Safari الأول)',
    'الإذن: ' + (window.Notification ? (permAr[Notification.permission] || Notification.permission) : 'مش مدعوم'),
    workerUrl() ? 'الرابط: محفوظ' : 'الرابط: مش متسجل'
  ];
}

function paint(extra) {
  $('state').textContent = baseState().concat(extra ? [extra] : []).join(' • ');
}

async function refreshState() {
  paint('الاشتراك: بيفحص…');
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    paint(sub ? 'الاشتراك: موجود (' + new URL(sub.endpoint).host + ')' : 'الاشتراك: مش موجود');
  } catch (e) {
    paint('الاشتراك: خطأ');
  }
}

async function enablePush() {
  const url = workerUrl();
  if (!url) return log('الأول حط رابط السيرفر فوق واضغط حفظ');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return log('المتصفح ده مش بيدعم Web Push. على الآيفون لازم iOS 16.4 أو أحدث.');
  }
  if (!isStandalone()) {
    log('تحذير: إنت فاتح التطبيق من Safari. على الآيفون لازم تفتحه من الشاشة الرئيسية.');
  }
  if (Notification.permission === 'denied') {
    return log('الإشعارات مرفوضة للجهاز ده. الإعدادات > الإشعارات > إشعارات > فعّلها، وبعدين اقفل التطبيق وافتحه.');
  }
  try {
    const perm = await Notification.requestPermission();
    log('الإذن: ' + perm);
    if (perm !== 'granted') return;

    const keyRes = await fetch(url + '/vapid-public-key');
    const keyData = await keyRes.json();
    if (!keyData.publicKey) throw new Error('السيرفر مردّش مفتاح: ' + JSON.stringify(keyData).slice(0, 120));

    const reg = await navigator.serviceWorker.ready;
    const wanted = urlB64ToUint8Array(keyData.publicKey);
    let sub = await reg.pushManager.getSubscription();

    // if an old subscription was made with a different server key, start over
    if (sub) {
      const cur = new Uint8Array(sub.options.applicationServerKey || new ArrayBuffer(0));
      const same = cur.length === wanted.length && cur.every((b, i) => b === wanted[i]);
      if (!same) {
        log('الاشتراك القديم كان بمفتاح سيرفر تاني، هلغيه وأعمل واحد جديد');
        await sub.unsubscribe();
        sub = null;
      }
    }

    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
      } catch (err) {
        if (err && err.name === 'InvalidStateError') {
          const old = await reg.pushManager.getSubscription();
          if (old) await old.unsubscribe();
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
        } else {
          throw err;
        }
      }
      log('اتعمل اشتراك جديد مع ' + new URL(sub.endpoint).host);
    } else {
      log('فيه اشتراك قديم بنفس المفتاح، هبعته للسيرفر تاني');
    }

    const out = await postJson(url + '/subscribe', { subscription: sub.toJSON(), ua: navigator.userAgent });
    if (out.ok) log('تم حفظ الاشتراك على السيرفر ✅ (عدد الأجهزة: ' + out.subscriptions + ')');
    else log('السيرفر رفض الاشتراك: ' + (out.error || JSON.stringify(out).slice(0, 150)));
  } catch (e) {
    log('فشل: ' + (e && e.message ? e.message : e));
  }
  refreshState();
}

async function sendTestNow() {
  const url = workerUrl();
  if (!url) return log('الأول حط رابط السيرفر');
  try {
    const out = await postJson(url + '/test', {});
    if (out.ok) log('السيرفر بعت ' + out.sent + ' إشعار ✅ اقفل التطبيق وشوف الشاشة');
    else log('مفيش إشعار اتبعت: ' + JSON.stringify(out).slice(0, 220));
  } catch (e) {
    log('فشل الاتصال بالسيرفر: ' + (e && e.message ? e.message : e));
  }
}

async function scheduleTest() {
  const url = workerUrl();
  if (!url) return log('الأول حط رابط السيرفر');
  const minutes = Math.max(0.2, parseFloat($('min').value) || 2);
  try {
    const out = await postJson(url + '/schedule', { minutes });
    if (out.ok) {
      const at = new Date(out.fireAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      log('مجدول على السيرفر الساعة ' + at + ' (تقريبًا). سيب التطبيق مقفول.');
    } else {
      log('فشل الجدولة: ' + JSON.stringify(out).slice(0, 200));
    }
  } catch (e) {
    log('فشل الاتصال بالسيرفر: ' + (e && e.message ? e.message : e));
  }
}

async function localTest() {
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('اختبار محلي', { body: 'ده من غير سيرفر — بس للتأكد إن الإشعارات شغالة', icon: 'icon-180.png', dir: 'rtl', lang: 'ar' });
    log('اتبعت اختبار محلي');
  } catch (e) {
    log('فشل الاختبار المحلي: ' + (e && e.message ? e.message : e));
  }
}

/* wiring */
$('save').onclick = () => {
  const v = $('url').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) return log('الرابط لازم يبدأ بـ https://');
  localStorage.setItem(LS_KEY, v);
  log('اتحفظ الرابط: ' + v);
  refreshState();
};
$('enable').onclick = enablePush;
$('now').onclick = sendTestNow;
$('go').onclick = scheduleTest;
$('local').onclick = localTest;
$('refresh').onclick = refreshState;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => log('السيرفر المحلي (service worker) اتسجل')).catch((e) => log('فشل تسجيل service worker: ' + e.message));
}
$('url').value = workerUrl();
refreshState();
