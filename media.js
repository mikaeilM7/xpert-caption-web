import { MAX_BYTES, MAX_SECONDS } from './core.js';

export function videoFile(file) {
  return file.type.startsWith('video/') || /\.(mp4|mov|mkv|m4v|avi)$/i.test(file.name);
}

export async function decodeMedia(file, normalize = true) {
  if (file.size > MAX_BYTES) throw new Error('حجم فایل بیشتر از ۳۰۰ مگابایت است.');
  const decoder = new OfflineAudioContext(1, 16000, 16000);
  let decoded;
  try {
    decoded = await decoder.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error('مرورگر نتوانست صدای این فایل را بخواند. نسخهٔ MP4 با صدای AAC، یا فایل MP3 و WAV را امتحان کن.');
  }
  if (decoded.duration > MAX_SECONDS + .05) throw new Error('نسخهٔ اول تا ۱۵ دقیقه را در هر نوبت پردازش می‌کند.');
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
  const pcm = new Float32Array(decoded.length);
  const energy = new Float64Array(channels.length);
  let mixedEnergy = 0;
  for (let i = 0; i < pcm.length; i++) {
    let sum = 0;
    for (let channel = 0; channel < channels.length; channel++) {
      const value = channels[channel][i];
      energy[channel] += value * value;
      sum += value;
    }
    pcm[i] = sum / channels.length;
    mixedEnergy += pcm[i] * pcm[i];
  }
  const strongest = energy.indexOf(Math.max(...energy));
  if (mixedEnergy < energy[strongest] * .18) pcm.set(channels[strongest]);
  if (!normalize) return pcm;
  let peak = 0;
  for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
  if (peak < .0005) throw new Error('صدای قابل تشخیص در فایل پیدا نشد.');
  const gain = Math.min(6, .86 / peak);
  if (gain > 1.08) for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;
  return pcm;
}

export async function waveformFor(file) {
  if (file.size > 40_000_000) return [];
  const pcm = await decodeMedia(file, false);
  const stride = Math.max(1, Math.ceil(pcm.length / 100));
  const peaks = [];
  for (let start = 0; start < pcm.length; start += stride) {
    let peak = 0;
    for (let i = start; i < Math.min(pcm.length, start + stride); i++) peak = Math.max(peak, Math.abs(pcm[i]));
    peaks.push(peak);
  }
  const max = Math.max(.08, ...peaks);
  return peaks.map(value => Math.sqrt(value / max));
}

async function asWav(recording) {
  const pcm = await decodeMedia(recording, false);
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const d = new DataView(buffer);
  const label = (offset, text) => [...text].forEach((letter, index) => d.setUint8(offset + index, letter.charCodeAt(0)));
  label(0, 'RIFF');
  d.setUint32(4, buffer.byteLength - 8, true);
  label(8, 'WAVEfmt ');
  d.setUint32(16, 16, true);
  d.setUint16(20, 1, true);
  d.setUint16(22, 1, true);
  d.setUint32(24, 16000, true);
  d.setUint32(28, 32000, true);
  d.setUint16(32, 2, true);
  d.setUint16(34, 16, true);
  label(36, 'data');
  d.setUint32(40, pcm.length * 2, true);
  pcm.forEach((value, index) => d.setInt16(44 + index * 2, Math.max(-32768, Math.min(32767, value * 32768)), true));
  return new File([buffer], recording.name.replace(/\.[^.]+$/, '.wav'), { type: 'audio/wav' });
}

export async function startCapture(kind, finished) {
  if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('این مرورگر ضبط صدا را در این صفحه در اختیار نمی‌گذارد.');
  const stream = kind === 'tab'
    ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, preferCurrentTab: false, selfBrowserSurface: 'exclude' })
    : await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
    });
  const tracks = stream.getAudioTracks();
  if (!tracks.length) {
    stream.getTracks().forEach(track => track.stop());
    throw new Error('صدای تب انتخاب نشده. یک تب را انتخاب کن و گزینهٔ اشتراک صدای تب را فعال کن.');
  }
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(value => MediaRecorder.isTypeSupported(value));
  let recorder;
  try {
    recorder = new MediaRecorder(new MediaStream(tracks), { ...(type && { mimeType: type }), audioBitsPerSecond: 128000 });
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    throw error;
  }
  const chunks = [];
  const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
  const timer = setTimeout(stop, MAX_SECONDS * 1000);
  const close = () => {
    clearTimeout(timer);
    stream.getTracks().forEach(track => track.stop());
  };
  recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
  let finishedOnce = false;
  const finish = (error, file) => {
    if (!finishedOnce) { finishedOnce = true; finished(error, file); }
  };
  recorder.addEventListener('stop', async () => {
    close();
    const format = recorder.mimeType || type || 'audio/webm';
    const ext = format.includes('mp4') ? 'm4a' : format.includes('ogg') ? 'ogg' : 'webm';
    const file = new File(chunks, (kind === 'tab' ? 'tab-audio' : 'microphone') + '.' + ext, { type: format });
    if (!file.size) { finish(new Error('صدایی ضبط نشده است.')); return; }
    try { finish(null, await asWav(file)); }
    catch { finish(null, file); }
  }, { once: true });
  recorder.addEventListener('error', () => {
    close();
    finish(new Error('ضبط صدا متوقف شد.'));
  }, { once: true });
  stream.getTracks().forEach(track => track.addEventListener('ended', stop, { once: true }));
  try { recorder.start(500); } catch (error) { close(); throw error; }
  return stop;
}
