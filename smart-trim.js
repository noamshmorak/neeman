/* SmartTrim — automatic "best moments" edit, fully in the browser (no server, no API key).
   analyze(src)  -> scores the clip every ~0.5s on sharpness, light, contrast and motion
                    (drops blurry, dark and shaky parts) and picks the best ~18 seconds.
   render(src, segments) -> plays the chosen parts onto a canvas and records a new silent clip,
                    with a short dip-to-black between parts. Takes about as long as the result.  */
(function (g) {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  function once(el, ev) {
    return new Promise((res, rej) => {
      const ok = () => { off(); res(); };
      const bad = () => { off(); rej(el.error || new Error(ev + ' failed')); };
      const off = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
      el.addEventListener(ev, ok); el.addEventListener('error', bad);
    });
  }
  async function openVideo(src) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
    document.body.appendChild(v);
    v.src = src;
    await once(v, 'loadeddata');
    return v;
  }
  function closeVideo(v) { try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch (e) {} }
  async function seek(v, t) {
    if (Math.abs(v.currentTime - t) < 0.02) return;
    const p = once(v, 'seeked'); v.currentTime = t; await p;
  }

  async function analyze(src, opts = {}) {
    const target = opts.target || 18, onProgress = opts.onProgress || (() => {});
    const v = await openVideo(src);
    try {
      const dur = v.duration;
      if (!isFinite(dur) || dur <= 0) throw new Error('לא הצלחתי לקרוא את אורך הסרטון');
      const W = 96, H = Math.max(32, Math.round(96 * (v.videoHeight || 9) / (v.videoWidth || 16)));
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const span = Math.min(dur, 240);                 // analyse up to 4 minutes
      const step = Math.max(0.4, span / 200);
      const samples = []; let prev = null;
      for (let t = 0.15; t < span - 0.1; t += step) {
        await seek(v, t);
        ctx.drawImage(v, 0, 0, W, H);
        const d = ctx.getImageData(0, 0, W, H).data, n = W * H, gray = new Float32Array(n);
        let sum = 0;
        for (let i = 0, j = 0; j < n; i += 4, j++) { const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; gray[j] = y; sum += y; }
        const mean = sum / n;
        let ls = 0, ls2 = 0, k = 0;
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          const p = y * W + x, L = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - W] - gray[p + W];
          ls += L; ls2 += L * L; k++;
        }
        const sharp = ls2 / k - (ls / k) ** 2;
        let vv = 0; for (let j = 0; j < n; j++) vv += (gray[j] - mean) ** 2;
        let motion = 0; if (prev) { for (let j = 0; j < n; j++) motion += Math.abs(gray[j] - prev[j]); motion /= n; }
        prev = gray;
        samples.push({ t, mean, sharp, contrast: Math.sqrt(vv / n), motion });
        onProgress(Math.min(1, t / span));
      }
      if (!samples.length) throw new Error('הסרטון קצר מדי');

      const ls_ = samples.map(s => Math.log1p(s.sharp));
      const lo = Math.min(...ls_), hi = Math.max(...ls_);
      samples.forEach((s, i) => {
        const sharpN = (ls_[i] - lo) / ((hi - lo) || 1);
        const light = (s.mean < 35 || s.mean > 228) ? 0 : 1 - Math.abs(s.mean - 130) / 130 * 0.6;
        const m = s.motion;          // a little life is good; a lot means shaking or a whip pan
        const motionN = m < 1 ? 0.55 : m < 4 ? 0.7 + (m - 1) / 3 * 0.3 : m < 14 ? 1 : clamp(1 - (m - 14) / 16, 0, 1);
        s.score = sharpN * 0.45 + light * 0.2 + motionN * 0.2 + clamp(s.contrast / 50, 0, 1) * 0.15;
        s.bad = s.mean < 30 || sharpN < 0.12 || m > 28;
      });

      const WIN = 3, windows = [];
      for (let a = 0; a < span - 0.5; a += WIN) {
        const b = Math.min(span, a + WIN), ss = samples.filter(s => s.t >= a && s.t < b);
        if (!ss.length) continue;
        const avg = ss.reduce((x, s) => x + s.score, 0) / ss.length;
        const badShare = ss.filter(s => s.bad).length / ss.length;
        windows.push({ a, b, score: avg * (1 - badShare * 0.8) });
      }
      let segments;
      if (span <= target + 1) segments = [{ a: 0, b: span }];
      else {
        const pick = []; let total = 0;
        for (const w of [...windows].sort((x, y) => y.score - x.score)) { if (total >= target) break; pick.push(w); total += w.b - w.a; }
        pick.sort((x, y) => x.a - y.a);
        segments = [];
        for (const w of pick) { const last = segments[segments.length - 1]; if (last && w.a - last.b < 0.01) last.b = w.b; else segments.push({ a: w.a, b: w.b }); }
      }
      const kept = segments.reduce((x, s) => x + s.b - s.a, 0);
      return { duration: dur, analyzed: span, segments, kept, windows };
    } finally { closeVideo(v); }
  }

  function pickType() {
    if (!g.MediaRecorder) return null;
    return ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || null;
  }

  async function render(src, segments, opts = {}) {
    const onProgress = opts.onProgress || (() => {}), FADE = 0.3;
    const type = pickType();
    if (!type) throw new Error('הדפדפן הזה לא יודע ליצור סרטון. נסו בכרום במחשב.');
    const v = await openVideo(src);
    let raf = 0;
    try {
      const scale = Math.min(1, (opts.maxW || 1280) / (v.videoWidth || 1280));
      const W = Math.max(2, Math.round((v.videoWidth || 1280) * scale / 2) * 2), H = Math.max(2, Math.round((v.videoHeight || 720) * scale / 2) * 2);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      const rec = new MediaRecorder(c.captureStream(30), { mimeType: type, videoBitsPerSecond: 4000000 });
      const chunks = []; rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise(r => { rec.onstop = r; });
      const total = segments.reduce((x, s) => x + s.b - s.a, 0); let doneT = 0;
      let cur = segments[0];
      const draw = () => {
        ctx.drawImage(v, 0, 0, W, H);
        const into = v.currentTime - cur.a, left = cur.b - v.currentTime;
        const alpha = clamp(1 - Math.min(into, left) / FADE, 0, 1);
        if (alpha > 0) { ctx.fillStyle = 'rgba(0,0,0,' + alpha + ')'; ctx.fillRect(0, 0, W, H); }
        raf = requestAnimationFrame(draw);
      };
      for (let i = 0; i < segments.length; i++) {
        cur = segments[i];
        await seek(v, cur.a);
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        if (i === 0) rec.start(250); else if (rec.state === 'paused') rec.resume();
        draw();
        await v.play();
        await new Promise(res => {
          const tick = () => {
            onProgress(Math.min(1, (doneT + Math.max(0, v.currentTime - cur.a)) / total));
            if (v.currentTime >= cur.b - 0.03 || v.ended) res(); else setTimeout(tick, 25);
          };
          tick();
        });
        v.pause(); cancelAnimationFrame(raf);
        doneT += cur.b - cur.a;
        if (i < segments.length - 1 && rec.state === 'recording') rec.pause();
      }
      rec.stop(); await stopped;
      onProgress(1);
      return new Blob(chunks, { type: type.split(';')[0] });
    } finally { cancelAnimationFrame(raf); closeVideo(v); }
  }

  g.SmartTrim = { analyze, render, supported: () => !!pickType() };
})(window);
