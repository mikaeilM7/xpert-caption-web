let libraries;
let mp3Ready = false;

function vendor() {
  libraries ??= import('./assets/media-vendor.js');
  return libraries;
}

const audioPresets = {
  wav: [
    { id: 'speech', label: '۱۶ kHz · تک‌کانال · گفتار', rate: 16000, mono: true },
    { id: 'music', label: '۴۴٫۱ kHz · ۱۶ بیت', rate: 44100 },
    { id: 'studio', label: '۴۸ kHz · ۱۶ بیت', rate: 48000 },
  ],
  mp3: [
    { id: 'compact', label: '۶۴ kbps · تک‌کانال', rate: 32000, bitrate: 64000, mono: true },
    { id: 'balanced', label: '۱۲۸ kbps', rate: 44100, bitrate: 128000 },
    { id: 'high', label: '۱۹۲ kbps', rate: 44100, bitrate: 192000 },
    { id: 'max', label: '۳۲۰ kbps', rate: 44100, bitrate: 320000 },
  ],
};

export function audioQualities(format) { return audioPresets[format] || []; }

async function prepareAudio(file, preset) {
  const decoder = new OfflineAudioContext(1, preset.rate, preset.rate);
  const decoded = await decoder.decodeAudioData(await file.arrayBuffer());
  if (decoded.duration > 900.06) throw new Error('برای استخراج صدا فایل حداکثر ۱۵ دقیقه باشد.');
  const channels = preset.mono ? 1 : Math.min(decoded.numberOfChannels, 2);
  if (decoded.numberOfChannels === channels) return decoded;
  const mixer = new OfflineAudioContext(channels, decoded.length, preset.rate);
  const source = mixer.createBufferSource();
  source.buffer = decoded;
  source.connect(mixer.destination);
  source.start();
  return mixer.startRendering();
}

function outputFile(file, buffer, suffix, ext, type) {
  if (!buffer || !buffer.byteLength || buffer.byteLength > 300_000_000)
    throw new Error('فایل خروجی آماده نشد یا بیشتر از ۳۰۰ مگابایت است.');
  const original = file.name.replace(/\.[^.]+$/, '').slice(0, 100);
  return new File([buffer], original + '-' + suffix + '.' + ext, { type });
}

export async function extractAudio(file, format, quality) {
  const preset = audioQualities(format).find(item => item.id === quality);
  if (!preset) throw new Error('فرمت یا کیفیت صدا معتبر نیست.');
  const media = await vendor();
  if (format === 'mp3' && !mp3Ready) {
    media.registerMp3Encoder();
    mp3Ready = true;
  }
  const pcm = await prepareAudio(file, preset);
  const target = new media.BufferTarget();
  const output = new media.Output({
    format: format === 'mp3' ? new media.Mp3OutputFormat() : new media.WavOutputFormat(),
    target,
  });
  const track = new media.AudioBufferSource(format === 'mp3'
    ? { codec: 'mp3', bitrate: preset.bitrate }
    : { codec: 'pcm-s16' });
  output.addAudioTrack(track);
  await output.start();
  await track.add(pcm);
  await output.finalize();
  return outputFile(file, target.buffer, 'audio-' + quality, format, format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
}

export function videoQualities(width, height) {
  const shortEdge = Math.min(width, height);
  return [1080, 720, 480, 360, 240].filter(value => shortEdge > value);
}

export async function resizeVideo(file, quality, onProgress) {
  const media = await vendor();
  const input = new media.Input({ source: new media.BlobSource(file), formats: media.ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video) throw new Error('این فایل تصویر ویدیویی ندارد.');
    const width = await video.getDisplayWidth();
    const height = await video.getDisplayHeight();
    if (!videoQualities(width, height).includes(quality)) throw new Error('کیفیت انتخاب‌شده باید از اندازهٔ اصلی کوچک‌تر باشد.');
    if (await input.computeDuration() > 900.06) throw new Error('برای ساخت کیفیت جدید، ویدیو حداکثر ۱۵ دقیقه باشد.');
    const scale = quality / Math.min(width, height);
    const size = { width: Math.max(2, Math.floor(width * scale / 2) * 2),
      height: Math.max(2, Math.floor(height * scale / 2) * 2) };
    const canAvc = await media.canEncodeVideo('avc', size);
    const tries = canAvc ? ['mp4', 'webm'] : ['webm'];
    let failure;
    for (const ext of tries) {
      const target = new media.BufferTarget();
      const output = new media.Output({ format: ext === 'mp4' ? new media.Mp4OutputFormat() : new media.WebMOutputFormat(), target });
      let conversion;
      try {
        conversion = await media.Conversion.init({ input, output,
          video: { ...size, fit: 'contain', codec: ext === 'mp4' ? 'avc' : 'vp8',
            bitrate: quality >= 1080 ? 5_000_000 : quality >= 720 ? 2_500_000 : 1_150_000 },
          audio: { discard: !audio },
          showWarnings: false,
        });
        if (!conversion.isValid || conversion.discardedTracks.some(entry => entry.track === video || entry.track === audio))
          throw new Error('این مرورگر نمی‌تواند تصویر و صدای این فایل را با هم تبدیل کند.');
        conversion.onProgress = onProgress;
        await conversion.execute();
        return outputFile(file, target.buffer, String(quality) + 'p', ext, 'video/' + ext);
      } catch (error) {
        failure = error;
        if (conversion && conversion.state !== 'done') await conversion.cancel().catch(() => {});
      }
    }
    throw failure || new Error('ساخت این کیفیت در مرورگر در دسترس نیست.');
  } finally { input.dispose(); }
}
