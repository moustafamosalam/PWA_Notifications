const $=id=>document.getElementById(id);
const log=m=>{$('log').textContent=new Date().toLocaleTimeString()+'  '+m+'\n'+$('log').textContent};
const standalone=navigator.standalone||matchMedia('(display-mode: standalone)').matches;
function state(){
  $('state').textContent=(standalone?'مثبت على الشاشة ✔':'مش مثبت: ثبّته من Safari الأول')+' | الإشعارات: '+(window.Notification?Notification.permission:'مش مدعومة');
}
async function show(title,body){
  const reg=await navigator.serviceWorker.ready;
  await reg.showNotification(title,{body,icon:'icon-180.png',tag:'t'+Date.now()});
  log('اتبعت: '+title);
}
function schedule(ms,label){
  log('مجدول '+label+' (سيب التطبيق مفتوح أو في الخلفية)');
  setTimeout(()=>show('تجربة ناجحة 🎉','الإشعار ده كان مجدول: '+label),ms);
}
$('perm').onclick=async()=>{const r=await Notification.requestPermission();log('الإذن: '+r);state()};
$('now').onclick=()=>show('إشعار فوري','شغال');
$('go').onclick=()=>schedule(Math.max(5,+$('sec').value)*1000,'بعد '+$('sec').value+' ثانية');
$('goat').onclick=()=>{const v=$('at').value;if(!v)return;const [h,m]=v.split(':'),t=new Date();t.setHours(h,m,0,0);
  if(t<=new Date())return log('الوقت فات');schedule(t-new Date(),'الساعة '+v)};
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js');
state();
// auto test ~90s after first open as installed app
if(standalone&&!localStorage.auto&&Notification.permission==='granted'){localStorage.auto=1;schedule(90000,'تلقائي بعد 90 ثانية')}
