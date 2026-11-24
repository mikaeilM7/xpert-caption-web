import { registerModelRevision } from './model-cache.js';

const RATE = 16000;
const FRAME = 512;
const CONTEXT = 64;

export async function speechRanges(audio, library) {
  const { AutoModel, Tensor } = library;
  const repo = 'onnx-community/silero-vad';
  const revision = 'e71cae966052b992a7eca6b17738916ce0eca4ec';
  registerModelRevision(repo, revision);
  const detector = await AutoModel.from_pretrained(repo, {
    revision,
    config: { model_type: 'custom' }, dtype: 'fp32', device: 'wasm',
  });
  let state = new Tensor('float32', new Float32Array(256), [2, 1, 128]);
  const sr = new Tensor('int64', [BigInt(RATE)], []);
  const window = new Float32Array(CONTEXT + FRAME);
  const ranges = [];
  let start = -1;
  let lastSpeech = -1;
  let hits = 0;
  try {
    for (let offset = 0; offset < audio.length; offset += FRAME) {
      window.fill(0, CONTEXT);
      window.set(audio.subarray(offset, offset + FRAME), CONTEXT);
      const result = await detector({ input: new Tensor('float32', window, [1, window.length]), state, sr });
      state = result.stateN;
      window.copyWithin(0, FRAME);
      const seconds = offset / RATE;
      const score = Number(result.output.data[0]);
      if (score >= .44 || (start >= 0 && score >= .28)) {
        if (start < 0) { start = seconds; hits = 0; }
        hits++;
        lastSpeech = seconds + FRAME / RATE;
      } else if (start >= 0 && seconds - lastSpeech > .43) {
        if (hits >= 4) ranges.push([start, lastSpeech]);
        start = -1;
      }
    }
    if (start >= 0 && hits >= 4) ranges.push([start, lastSpeech]);
  } finally {
    await detector.dispose();
  }

  const bounded = [];
  for (const [first, last] of ranges) {
    const from = Math.max(0, first - .34);
    const to = Math.min(audio.length / RATE, last + .35);
    const previous = bounded.at(-1);
    if (previous && from - previous[1] < 1.1) previous[1] = to;
    else bounded.push([from, to]);
  }
  return bounded;
}
