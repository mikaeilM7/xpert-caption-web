import { timestamp } from './core.js';
import { waveformFor } from './media.js';

export function connectPlayer({ media, player, seek, waveform, play, back, forward, rate, volume,
  clock, fullscreen, label, onTime, onError }) {
  let file;
  let peaks;
  let restoredTime = 0;
  let loadId = 0;
  const ctx = waveform.getContext('2d');
  const validDuration = () => Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;

  function draw() {
    if (!file || !player.classList.contains('audio-only')) return;
    const box = waveform.getBoundingClientRect();
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(box.width * scale);
    const height = Math.round(box.height * scale);
    if (!width || !height) return;
    if (waveform.width !== width || waveform.height !== height) {
      waveform.width = width;
      waveform.height = height;
    }
    ctx.clearRect(0, 0, width, height);
    const ratio = validDuration() ? media.currentTime / validDuration() : 0;
    const played = width * ratio;
    ctx.fillStyle = '#544768';
    ctx.fillRect(0, height / 2, width, scale);
    if (!peaks?.length) return;
    const step = width / peaks.length;
    peaks.forEach((peak, i) => {
      const x = Math.floor(i * step);
      const h = Math.max(scale * 2, peak * (height - 4 * scale));
      ctx.fillStyle = x <= played ? '#d8ff83' : '#ad94e0';
      ctx.fillRect(x, (height - h) / 2, Math.max(1, step * .58), h);
    });
  }

  function update() {
    const duration = validDuration();
    seek.disabled = !duration;
    seek.max = duration || 1;
    seek.value = Math.min(media.currentTime, duration);
    seek.style.setProperty('--played', (duration ? media.currentTime / duration * 100 : 0) + '%');
    seek.setAttribute('aria-valuetext', timestamp(media.currentTime) + ' از ' + timestamp(duration));
    clock.textContent = timestamp(media.currentTime) + ' / ' + timestamp(duration);
    play.textContent = media.paused ? '▶' : 'Ⅱ';
    play.setAttribute('aria-label', media.paused ? 'پخش' : 'مکث');
    draw();
    onTime();
  }

  function move(time) {
    if (validDuration()) media.currentTime = Math.min(validDuration(), Math.max(0, time));
  }

  play.addEventListener('click', () => {
    if (media.paused) media.play().catch(() => { if (file) onError(new Error('پخش این فایل در مرورگر باز نشد.')); });
    else media.pause();
  });
  back.addEventListener('click', () => move(media.currentTime - 5));
  forward.addEventListener('click', () => move(media.currentTime + 5));
  seek.addEventListener('input', () => move(Number(seek.value)));
  waveform.addEventListener('click', event => {
    const rect = waveform.getBoundingClientRect();
    if (rect.width) move((event.clientX - rect.left) / rect.width * validDuration());
  });
  rate.addEventListener('change', () => { media.playbackRate = Number(rate.value); });
  volume.addEventListener('input', () => { media.volume = Number(volume.value); });
  fullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else player.requestFullscreen?.().catch(() => {});
  });
  media.addEventListener('loadedmetadata', () => {
    media.playbackRate = Number(rate.value);
    move(restoredTime);
    restoredTime = 0;
    update();
  });
  for (const event of ['play', 'pause', 'seeked', 'timeupdate', 'ended', 'durationchange']) media.addEventListener(event, update);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(draw).observe(waveform);

  return {
    load(nextFile, url, video, position = 0) {
      const current = ++loadId;
      media.pause();
      file = nextFile;
      peaks = null;
      restoredTime = position;
      player.hidden = !nextFile;
      player.classList.toggle('audio-only', !video);
      fullscreen.hidden = !video;
      waveform.hidden = !!video;
      label.textContent = nextFile ? (video ? 'پیش‌نمایش ویدیو' : 'پیش‌نمایش صدا') : '';
      if (url) media.src = url;
      else media.removeAttribute('src');
      media.load();
      update();
      if (nextFile && !video) {
        waveformFor(nextFile).then(values => {
          if (current === loadId) { peaks = values; draw(); }
        }).catch(() => {});
      }
    },
  };
}
