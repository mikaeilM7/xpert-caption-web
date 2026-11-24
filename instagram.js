const PUBLIC_POST = /^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]{3,40})\/?$/;

export function normalizeInstagramUrl(input) {
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('لینک کامل پست یا ریل را وارد کن.'); }
  const match = PUBLIC_POST.exec(url.pathname);
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(url.hostname) ||
      url.port || url.username || url.password || !match) throw new Error('لینک مستقیم پست، ریل یا ویدیوی عمومی اینستاگرام را وارد کن.');
  return 'https://www.instagram.com/' + (match[1] === 'reels' ? 'reel' : match[1]) + '/' + match[2] + '/';
}

async function request(path, body, signal) {
  let response;
  try {
    response = await fetch('/api/instagram/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xpert-Local-Request': 'instagram' },
      body: JSON.stringify(body), signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('اجراکنندهٔ ویندوز در دسترس نیست. پنجرهٔ اجرا را باز نگه دار.');
  }
  if (!response.ok) {
    if ([404, 405].includes(response.status)) throw new Error('این ابزار از طریق اجراکنندهٔ نسخهٔ ویندوز در دسترس است.');
    const data = await response.json().catch(() => ({}));
    const messages = {
      network: 'اتصال به اینستاگرام کامل نشد. می‌توانی پست را باز کنی و با «صدای تب» از آن متن بگیری.',
      restricted: 'اینستاگرام برای این لینک فایل ویدیوی عمومی قابل دریافت برنگرداند. اگر پست در مرورگرت پخش می‌شود، از «صدای تب» استفاده کن.',
      no_video: 'در این لینک ویدیوی قابل دریافت با صدا پیدا نشد.',
      expired: 'اطلاعات لینک منقضی شده. دوباره «بررسی لینک» را بزن.',
      busy: 'دریافت یک ویدیوی دیگر در حال انجام است. چند لحظه بعد دوباره تلاش کن.',
      missing: 'موتور دریافت ویدیو در پوشهٔ برنامه پیدا نشد. همهٔ فایل‌های ZIP را استخراج کن.',
      engine: 'موتور دانلود از GitHub دریافت نشد. اتصال را بررسی کن و دوباره «بررسی لینک» را بزن.',
      too_large: 'اندازهٔ فایل از ظرفیت این نسخه بیشتر است. اگر کیفیت پایین‌تر موجود است آن را انتخاب کن.',
      invalid: 'لینک یا کیفیت انتخاب‌شده معتبر نیست.',
    };
    throw new Error(messages[data.error] || 'گرفتن ویدیو کامل نشد. دوباره بررسی کن یا صدای تب را ضبط کن.');
  }
  return response;
}

export async function inspectInstagram(url) {
  const response = await request('inspect', { url: normalizeInstagramUrl(url) });
  return response.json();
}

export async function loadInstagramVideo(result, format, signal) {
  const response = await request('download', { id: result.id, format }, signal);
  const body = await response.blob();
  if (!body.size || body.type !== 'video/mp4') throw new Error('فایل ویدیو دریافت نشد.');
  return new File([body], 'instagram-' + result.post + '.mp4', { type: 'video/mp4' });
}
