// needledrop — a Spicetify theme: 3D turntable, analog VU meters, a Blue Note–style full-screen
// sleeve poster, ink color from your wallpaper (matugen) or the cover art, page transitions.
//
// Performance rules:
// - Overlays (deck, VU, poster) live in <body>, never inside Spotify's React tree.
// - Overlay positions are recomputed only when an anchor resizes or is replaced (ResizeObserver),
//   not on every Spotify DOM mutation.
// - Continuous motion (record, VU needles) runs on the compositor via WAAPI; the main thread only
//   schedules keyframes, rarely. Creating animations is what's expensive, not running them.
// - Per-track data (cover, ink, audio analysis, duotone) is cached; the next track is prefetched.
(function needledrop() {
  const S = window.Spicetify;
  if (!S?.Player?.addEventListener || !S.Platform?.History || !document.body) {
    setTimeout(needledrop, 300);
    return;
  }

  const root = document.documentElement;

  // Spicetify.Player throws before Spotify is ready → wrap every read
  const safe = (fn, fallback) => {
    try {
      return fn() ?? fallback;
    } catch {
      return fallback;
    }
  };
  const isPlaying = () => safe(() => S.Player.isPlaying(), false);
  const progress = () => safe(() => S.Player.getProgress(), 0);
  const progressPct = () => safe(() => S.Player.getProgressPercent(), 0);
  const duration = () => safe(() => S.Player.getDuration(), 0);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const KEYS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]; // ASCII: the display face has no ♭/♯ glyphs
  const INK = [13, 13, 12];
  const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

  const imageUrl = (uri) => {
    if (!uri) return null;
    if (uri.startsWith("spotify:image:")) return "https://i.scdn.co/image/" + uri.split(":").pop();
    return uri.startsWith("http") ? uri : null;
  };

  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // Fake but stable per-track catalog number, in the style of the Blue Note 84xxx series
  const catalogNo = (uri = "") => {
    let h = 0;
    for (const ch of uri) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `BST-84${String(h % 1000).padStart(3, "0")}`;
  };

  // Write text only when it changes (avoids needless layout)
  const setText = (el, text) => {
    text = String(text);
    if (el.textContent !== text) el.textContent = text;
  };

  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => img.decode().then(() => resolve(img), () => resolve(img));
      img.onerror = reject;
      img.src = src;
    });

  // ---------- Color ----------

  const hexRgb = (hex) => {
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  const hslToRgb = (h, s, l) => {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  };

  // The single most vivid color in the cover art
  function extractInk(img) {
    const c = document.createElement("canvas");
    c.width = c.height = 20;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 20, 20);
    const d = ctx.getImageData(0, 0, 20, 20).data;
    let best = null;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, delta = max - min;
      if (l < 0.12 || l > 0.92) continue;
      const s = delta / (1 - Math.abs(2 * l - 1) || 1);
      let h = 0;
      if (delta) {
        if (max === r) h = ((g - b) / delta) % 6;
        else if (max === g) h = (b - r) / delta + 2;
        else h = (r - g) / delta + 4;
        h = (h * 60 + 360) % 360;
      }
      const score = s * (1 - Math.abs(l - 0.55));
      if (!best || score > best.score) best = { h, s, score };
    }
    // Monochrome cover → classic mustard ink
    const { h, s } = !best || best.s < 0.12 ? { h: 40, s: 0.78 } : best;
    return hslToRgb(h, Math.min(0.85, Math.max(0.6, s)), 0.57);
  }

  // Duotone: lights → ink, darks → black (the Blue Note sleeve photo treatment)
  function duotone(img, ink) {
    const W = 320;
    const c = document.createElement("canvas");
    c.width = c.height = W;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, W);
    const px = ctx.getImageData(0, 0, W, W);
    const d = px.data;
    for (let i = 0; i < d.length; i += 4) {
      let t = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      t = Math.min(1, Math.max(0, (t - 0.12) * 1.5));
      d[i] = INK[0] + (ink[0] - INK[0]) * t;
      d[i + 1] = INK[1] + (ink[1] - INK[1]) * t;
      d[i + 2] = INK[2] + (ink[2] - INK[2]) * t;
    }
    ctx.putImageData(px, 0, 0);
    return new Promise((resolve) => c.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null), "image/jpeg", 0.85));
  }

  // Run when the main thread is idle (or after `timeout` ms at the latest)
  const idle = (fn, timeout = 1200) =>
    "requestIdleCallback" in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 60);

  // ---------- Per-track cache + prefetch ----------
  // { src, img, ink, analysis } — prepared once; the next track is prepared before it plays.

  const trackCache = new Map();

  const itemImage = (item) => {
    const m = item?.metadata || {};
    return imageUrl(m.image_xlarge_url || m.image_large_url || m.image_url || item?.images?.[0]?.url);
  };

  function prepare(item) {
    const uri = item?.uri;
    if (!uri) return Promise.resolve(null);
    if (!trackCache.has(uri)) {
      const job = (async () => {
        const src = itemImage(item);
        const [img, analysis] = await Promise.allSettled([
          src ? loadImage(src) : Promise.reject(),
          uri.startsWith("spotify:track:") ? S.getAudioData(uri) : Promise.reject(),
        ]);
        const image = img.status === "fulfilled" ? img.value : null;
        return {
          src,
          img: image,
          ink: image ? safe(() => extractInk(image), null) : null,
          analysis: analysis.status === "fulfilled" ? analysis.value : null,
          duo: new Map(), // ink → Promise<blob URL> of the duotone
        };
      })();
      trackCache.set(uri, job);
      while (trackCache.size > 12) {
        const [oldUri, oldJob] = trackCache.entries().next().value;
        trackCache.delete(oldUri);
        // release duotone blob URLs of tracks evicted from the cache
        oldJob.then((d) => d?.duo.forEach((u) => u.then((url) => url && URL.revokeObjectURL(url))));
      }
    }
    return trackCache.get(uri);
  }

  const prefetchNext = () => {
    const next = safe(() => S.Player.data.nextItems?.[0], null);
    if (next) setTimeout(() => prepare(next), 1500);
  };

  // ---------- Wallpaper palette (matugen → assets/nd-wallpaper.json) ----------

  const INK_KEY = "nd:ink-source";
  let inkSource = safe(() => localStorage.getItem(INK_KEY), null) || "wallpaper";
  let wall = null;
  let wallText = "";
  let current = null; // cached data of the track on display

  const currentInk = () => (inkSource === "wallpaper" && wall ? hexRgb(wall.primary) : current?.ink);

  function applyWallpaperBase() {
    if (!wall) return;
    const set = (name, hex) => {
      root.style.setProperty(name, hex);
      root.style.setProperty(name + "-rgb", hexRgb(hex).join(", "));
    };
    set("--nd-ink", wall.surface_lowest);
    set("--nd-ink-2", wall.surface_low);
    set("--nd-ink-3", wall.surface);
    set("--nd-paper", wall.on_surface);
    set("--nd-mute", wall.on_surface_variant);
  }

  function applyAccent() {
    const ink = currentInk();
    if (!ink) return;
    const value = `rgb(${ink.join(",")})`;
    if (root.style.getPropertyValue("--nd-accent") !== value) root.style.setProperty("--nd-accent", value);
    root.style.setProperty("--nd-on-accent", inkSource === "wallpaper" && wall ? wall.on_primary : "#0d0d0c");
    idle(renderDuotone);
  }

  // The duotone (~100k pixels) is built at idle time after the track/ink changes — not when the
  // poster opens — and cached per ink, so entering full screen never waits on it.
  async function renderDuotone() {
    const data = current;
    const ink = currentInk();
    if (!data?.img || !ink) return;
    const key = ink.join(",");
    if (!data.duo.has(key)) data.duo.set(key, duotone(data.img, ink));
    const url = await data.duo.get(key);
    if (!url || data !== current || currentInk()?.join(",") !== key) return;
    const value = `url("${url}")`;
    const el = c$(".nd-cine-duo");
    if (el.style.backgroundImage !== value) el.style.backgroundImage = value;
  }

  async function pollWallpaper() {
    if (document.hidden) return;
    try {
      const res = await fetch(`assets/nd-wallpaper.json?${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const text = await res.text();
      if (text === wallText) return;
      wallText = text;
      wall = JSON.parse(text);
      applyWallpaperBase();
      applyAccent();
    } catch {
      // file missing (matugen hasn't run yet) → built-in palette + cover ink
    }
  }

  // ---------- Turntable (right sidebar) ----------

  const deck = document.createElement("section");
  deck.id = "nd-deck";
  deck.innerHTML = `
    <div class="nd-stage">
      <div class="nd-shadow"></div>
      <div class="nd-plinth">
        <div class="nd-platter">
          <div class="nd-record"><div class="nd-label"></div></div>
          <div class="nd-sheen"></div>
        </div>
        <div class="nd-arm-base"></div>
        <div class="nd-arm"></div>
        <div class="nd-led"></div>
        <div class="nd-plinth-text"><b>33⅓</b>  45  RPM</div>
      </div>
    </div>
    <div class="nd-meta">
      <div class="nd-kicker"><span class="nd-cat"></span><span class="nd-side"></span></div>
      <div class="nd-title"></div>
      <div class="nd-artist"></div>
      <div class="nd-specs">
        <div>tempo<b class="nd-bpm">—</b></div>
        <div>key<b class="nd-key">—</b></div>
        <div>time<b class="nd-meter">—</b></div>
        <div>length<b class="nd-len">—</b></div>
      </div>
    </div>`;

  const $ = (sel) => deck.querySelector(sel);
  const arm = $(".nd-arm");

  // ---------- Full-screen poster ----------

  const cine = document.createElement("section");
  cine.id = "nd-cine";
  let cineOpen = false;
  cine.innerHTML = `
    <div class="nd-cine-block">
      <div class="nd-cine-cat"><span class="c-cat"></span><span>STEREO</span></div>
      <div class="nd-cine-title"></div>
      <div class="nd-cine-artist"></div>
      <div class="nd-cine-specs"><span class="c-bpm"></span><span class="c-key"></span><span class="c-side"></span></div>
    </div>
    <div class="nd-cine-stage">
      <div class="nd-cine-duo"></div>
      <div class="nd-cine-sleeve">
        <div class="nd-cine-disc-wrap">
          <div class="nd-cine-disc"><div class="nd-label"></div></div>
          <div class="nd-cine-disc-sheen"></div>
        </div>
        <div class="nd-cine-cover"></div>
      </div>
      <div class="nd-cine-time"><div class="nd-cine-now">0:00</div><div class="nd-cine-total"></div></div>
      <div class="nd-cine-bar"><i></i></div>
      <div class="nd-cine-controls">
        <button class="nd-prev">← prev</button>
        <button class="nd-play">pause</button>
        <button class="nd-next">next →</button>
        <button class="nd-exit">exit full screen ×</button>
      </div>
    </div>`;

  const c$ = (sel) => cine.querySelector(sel);
  c$(".nd-prev").onclick = () => S.Player.back();
  c$(".nd-next").onclick = () => S.Player.next();
  c$(".nd-play").onclick = () => S.Player.togglePlay();
  c$(".nd-exit").onclick = () => document.querySelector('[aria-label="Exit full screen"]')?.click();

  // Title stacked one word per line, then scaled to fill the color block
  function setPosterTitle(text) {
    const box = c$(".nd-cine-title");
    if (box.dataset.text === text) return;
    box.dataset.text = text;
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    if (words.length <= 4) lines.push(...words);
    else {
      const per = Math.ceil(words.length / 4);
      for (let i = 0; i < words.length; i += per) lines.push(words.slice(i, i + per).join(" "));
    }
    box.replaceChildren(...lines.map((l) => Object.assign(document.createElement("span"), { textContent: l })));
    fitPosterTitle();
  }

  // Title size computed without touching layout: text width from canvas.measureText, available
  // space from the poster's CSS geometry (40vw block, 3.2vw padding, sleeve overlapping 9vh).
  const measure = document.createElement("canvas").getContext("2d");
  function fitPosterTitle() {
    const box = c$(".nd-cine-title");
    const lines = [...box.children].map((s) => s.textContent.toUpperCase());
    if (!lines.length) return;
    measure.font = `100px "League Gothic", "Noto Sans CJK JP", "Noto Sans JP", sans-serif`;
    const widest = Math.max(...lines.map((l) => measure.measureText(l).width), 1);
    const maxW = innerWidth * (0.4 - 0.032) - innerHeight * 0.09 - 24;
    const maxH = innerHeight * 0.56;
    const size = Math.max(24, Math.min((maxW / widest) * 100, maxH / (lines.length * 0.84), innerHeight * 0.4));
    box.style.fontSize = size.toFixed(1) + "px";
  }

  // ---------- Record spin (deck + poster) with inertia ----------

  const SPIN_FRAMES = (z) => [{ transform: `${z} rotate(0)` }, { transform: `${z} rotate(360deg)` }];
  const spins = [
    $(".nd-record").animate(SPIN_FRAMES("translateZ(2px)"), { duration: 1800, iterations: Infinity }), // 33⅓ RPM
    c$(".nd-cine-disc").animate(SPIN_FRAMES(""), { duration: 1800, iterations: Infinity }),
  ];
  spins.forEach((a) => (a.playbackRate = 0));
  spins[1].pause(); // poster starts hidden

  let spinTarget = 0;
  let spinRaf = 0;
  function rampSpin() {
    cancelAnimationFrame(spinRaf);
    const step = () => {
      const cur = spins[0].playbackRate;
      let next = cur + (spinTarget - cur) * (spinTarget > cur ? 0.06 : 0.035);
      if (Math.abs(next - spinTarget) < 0.005) next = spinTarget;
      spins.forEach((a) => (a.playbackRate = next));
      if (next !== spinTarget) spinRaf = requestAnimationFrame(step);
    };
    step();
  }

  // ---------- Tonearm ----------
  // One long linear animation from here to the end of the track (compositor). New animations are
  // only created on play/pause/seek/track change.

  const ARM_REST = 0, ARM_START = 25, ARM_END = 36;
  const LIFT_UP = 22, LIFT_DOWN = 12;
  let armParked = true;
  let armAngle = ARM_REST;
  let armLift = LIFT_UP;
  let armAnim = null;

  const armFrame = (angle, lift) => ({ transform: `translateZ(${lift}px) rotate(${angle.toFixed(2)}deg)` });
  const grooveAngle = (pct) => ARM_START + (ARM_END - ARM_START) * Math.max(0, Math.min(1, pct));

  // Current tonearm angle comes from the model, not the DOM (avoids forced style)
  function currentArmAngle() {
    if (!armAnim || armAnim.playState !== "running") return armAngle;
    const t = armAnim.currentTime / armAnim.effect.getTiming().duration;
    return armAnim.__from + (armAnim.__to - armAnim.__from) * Math.min(1, Math.max(0, t));
  }

  function moveArm(to, lift, ms, easing = EASE, then) {
    const from = currentArmAngle();
    armAnim?.cancel();
    armAnim = arm.animate([armFrame(from, armLift), armFrame(to, lift)], { duration: Math.max(1, ms), fill: "forwards", easing });
    armAnim.__from = from;
    armAnim.__to = to;
    armAngle = to;
    armLift = lift;
    if (then) armAnim.onfinish = then;
  }

  // Arm follows the groove to the end of the track
  function trackArm() {
    if (deck.hidden || armParked) return;
    const pct = progressPct();
    const lift = isPlaying() ? LIFT_DOWN : LIFT_UP;
    const here = grooveAngle(pct);
    const settle = () => {
      if (!isPlaying()) return;
      const remaining = Math.max(1000, duration() - progress());
      moveArm(grooveAngle(1), LIFT_DOWN, remaining, "linear");
    };
    if (Math.abs(currentArmAngle() - here) > 0.3 || armLift !== lift) moveArm(here, lift, reduced ? 1 : 700, EASE, settle);
    else settle();
  }

  let armTimer = 0;
  function cueArm() {
    clearTimeout(armTimer);
    armParked = true;
    if (!deck.hidden) moveArm(ARM_REST, LIFT_UP, reduced ? 1 : 900);
    armTimer = setTimeout(() => {
      armParked = false;
      trackArm();
    }, reduced ? 0 : 1100);
  }

  // ---------- VU meter ----------

  const vu = document.createElement("div");
  vu.id = "nd-vu";
  const scaleSvg = (() => {
    let ticks = "";
    for (let a = -48; a <= 48; a += 8) {
      const rad = (a * Math.PI) / 180;
      const x1 = 32 + Math.sin(rad) * 38, y1 = 52 - Math.cos(rad) * 38;
      const x2 = 32 + Math.sin(rad) * 33, y2 = 52 - Math.cos(rad) * 33;
      ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${a > 16 ? "#b3341f" : "#3b342a"}" stroke-width="${a % 16 === 0 ? 1 : 0.6}"/>`;
    }
    const arc = (from, to, color) => {
      const p = (deg) => [32 + Math.sin((deg * Math.PI) / 180) * 38, 52 - Math.cos((deg * Math.PI) / 180) * 38];
      const [x1, y1] = p(from), [x2, y2] = p(to);
      return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A38 38 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${color}" stroke-width="1.2"/>`;
    };
    return `<svg viewBox="0 0 64 38">${arc(-48, 16, "#3b342a")}${arc(16, 48, "#b3341f")}${ticks}<text x="51" y="35" font-size="6" font-family="Courier Prime" font-weight="700" fill="#b3341f">+</text></svg>`;
  })();
  vu.innerHTML = ["L", "R"]
    .map((ch) => `<div class="nd-vu-meter">${scaleSvg}<div class="nd-vu-needle"></div><div class="nd-vu-label">VU ${ch}</div></div>`)
    .join("");
  const needles = [...vu.querySelectorAll(".nd-vu-needle")];

  // Needles are driven by the compositor from Spotify's audio-analysis segments (attack → decay).
  let segments = [];
  const needleAngle = [-48, -48];
  let vuTimer = 0;

  const dbToAngle = (db) => -48 + Math.max(0, Math.min(1, (db + 32) / 30)) * 96;

  const findSeg = (t) => {
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // One animation per 3 s window: keyframes = peak & end of every segment in that window.
  const VU_WINDOW = 3;

  function moveNeedles(frameSets, ms) {
    needles.forEach((n, i) => {
      // (never use getAnimations(): it forces a whole-document style recalc)
      const prev = n.__vu;
      n.__vu = n.animate(frameSets[i], { duration: ms, fill: "forwards" });
      prev?.cancel();
    });
  }

  function restNeedles() {
    if (needleAngle.every((a) => a === -48)) return;
    moveNeedles(needleAngle.map((a) => [{ transform: `rotate(${a}deg)` }, { transform: "rotate(-48deg)", easing: "ease-out" }]), 700);
    needleAngle.fill(-48);
  }

  function scheduleVu() {
    clearTimeout(vuTimer);
    if (vu.hidden || document.hidden || !isPlaying() || !segments.length) {
      restNeedles();
      return;
    }
    const t0 = progress() / 1000;
    const t1 = t0 + VU_WINDOW;
    const sets = [[], []];
    const push = (time, angles) => {
      const offset = (time - t0) / VU_WINDOW;
      sets.forEach((set, ch) => {
        const last = set[set.length - 1];
        if (last && offset <= last.offset) return;
        set.push({ offset, transform: `rotate(${angles[ch].toFixed(1)}deg)`, easing: "ease-out" });
      });
    };
    push(t0, needleAngle);
    let end = needleAngle.slice();
    for (let i = findSeg(t0); i < segments.length && segments[i].start < t1; i++) {
      const seg = segments[i];
      const peak = dbToAngle(seg.loudness_max);
      const wobble = (seg.timbre?.[1] || 0) / 60; // right channel differs slightly
      const peakR = Math.max(-48, Math.min(48, peak * 0.96 + wobble));
      const peakT = seg.start + (seg.loudness_max_time || 0);
      if (peakT > t0 && peakT < t1) push(peakT, [peak, peakR]);
      const segEnd = seg.start + seg.duration;
      const next = segments[i + 1];
      end = [dbToAngle(next ? next.loudness_start : -60), dbToAngle(next ? next.loudness_start : -60)];
      if (segEnd > t0 && segEnd < t1) push(segEnd, end);
    }
    sets.forEach((set, ch) => {
      const last = set[set.length - 1];
      if (last.offset < 1) set.push({ offset: 1, transform: last.transform });
      needleAngle[ch] = parseFloat(last.transform.slice(7));
    });
    moveNeedles(sets, VU_WINDOW * 1000);
    vuTimer = setTimeout(scheduleVu, VU_WINDOW * 1000 - 40);
  }

  // ---------- Mount overlays ----------

  document.body.append(deck, cine, vu);

  const place = (el, rect) => {
    const left = rect.left + "px", top = rect.top + "px";
    if (el.style.left !== left) el.style.left = left;
    if (el.style.top !== top) el.style.top = top;
    if (rect.width != null && el.style.width !== rect.width + "px") el.style.width = rect.width + "px";
  };

  const cinemaOpen = () => root.classList.contains("fullscreen") || !!document.querySelector(".Root__cinema-view");

  let posterTimer = 0;
  let closeAnim = null;
  function setCinema(open) {
    if (cineOpen === open) return;
    cineOpen = open;
    clearInterval(posterTimer);
    closeAnim?.cancel();
    root.classList.toggle("nd-cine-open", open);
    if (!open) {
      // Exit: quick fade, then hide
      closeAnim = cine.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 1 : 220, easing: "ease-in" });
      closeAnim.onfinish = () => {
        if (cineOpen) return;
        cine.classList.remove("is-open");
        spins[1].pause();
      };
      return;
    }
    // Enter: everything is precomputed (duotone, title size), so only choreography is left:
    // color block sweeps in → sleeve rises → title lifts → record slides out.
    fitPosterTitle();
    tickPoster();
    posterTimer = setInterval(tickPoster, 250);
    spins[1].play();
    cine.classList.add("is-cueing", "is-open");
    if (reduced) {
      cine.classList.remove("is-cueing");
      return;
    }
    // Poster backdrop is solid immediately (no see-through UI); only its contents move
    c$(".nd-cine-controls").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: 450, easing: "ease-out", fill: "backwards" });
    c$(".nd-cine-time").animate([{ opacity: 0, transform: "translateY(3vh)" }, { opacity: 1, transform: "none" }], { duration: 700, delay: 300, easing: EASE, fill: "backwards" });
    c$(".nd-cine-block").animate([{ transform: "translateX(-101%)" }, { transform: "none" }], { duration: 700, easing: EASE });
    c$(".nd-cine-duo").animate([{ opacity: 0, transform: "scale(1.18)" }, { opacity: 0.42, transform: "scale(1.08)" }], { duration: 1100, easing: EASE });
    c$(".nd-cine-sleeve").animate(
      [{ transform: "translateY(7vh) rotate(-2.5deg)", opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 850, delay: 140, easing: EASE, fill: "backwards" }
    );
    setTimeout(() => cine.classList.remove("is-cueing"), 420);
  }

  function layoutAll() {
    const cinema = cinemaOpen();
    setCinema(cinema);
    if (cinema) {
      // Full screen: hide deck & VU without reading geometry (no forced layout while Spotify
      // is rebuilding its view)
      document.body.classList.remove("nd-has-deck");
      if (!deck.hidden) deck.hidden = true;
      if (!vu.hidden) {
        vu.hidden = true;
        scheduleVu();
      }
      return;
    }

    const pr = anchors.panel?.getBoundingClientRect();
    const r = anchors.header?.getBoundingClientRect();
    const deckVisible = !cinema && r && pr && pr.width > 200;
    document.body.classList.toggle("nd-has-deck", !!deckVisible);
    if (deck.hidden === !!deckVisible) {
      deck.hidden = !deckVisible;
      if (deckVisible) trackArm();
    }
    if (deckVisible) {
      place(deck, { left: pr.left + 1, top: r.bottom, width: pr.width - 1 });
      const h = deck.offsetHeight + "px";
      if (root.style.getPropertyValue("--nd-deck-h") !== h) root.style.setProperty("--nd-deck-h", h);
    }

    const first = anchors.slot?.firstElementChild?.getBoundingClientRect();
    const vuHidden = cinema || !first || first.width === 0;
    if (vu.hidden !== vuHidden) {
      vu.hidden = vuHidden;
      scheduleVu();
    }
    if (!vuHidden) place(vu, { left: first.left - 148, top: first.top + first.height / 2 - 19 });
  }

  // Anchors = Spotify elements the overlays are positioned against. React may replace them at any
  // time, so identity is checked (cheap, no layout) and the ResizeObserver re-attached when it changes.
  const anchors = { panel: null, header: null, slot: null, main: null };
  const ro = new ResizeObserver(() => layoutAll());

  function refreshAnchors() {
    const found = {
      panel: document.querySelector(".Root__right-sidebar"),
      header: document.querySelector(".main-nowPlayingView-headerContainer"),
      slot: document.querySelector(".main-nowPlayingBar-right > div"),
      main: document.querySelector(".Root__main-view"),
    };
    let changed = cinemaOpen() !== cineOpen;
    for (const k in found) {
      if (found[k] === anchors[k]) continue;
      if (anchors[k]) ro.unobserve(anchors[k]);
      if (found[k]) ro.observe(found[k]);
      anchors[k] = found[k];
      changed = true;
    }
    if (!changed) return;
    // Open/close the poster immediately (no geometry reads); overlay positions are computed next
    // frame so Spotify's layout is never forced mid-script.
    setCinema(cinemaOpen());
    queueLayout();
  }

  let layoutQueued = false;
  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layoutAll();
    });
  }

  // ---------- Content for the current track ----------

  function renderTrack(item, data) {
    const meta = item.metadata || {};
    const title = item.name || meta.title || "";
    const artist = (item.artists || []).map((a) => a.name).join(", ") || meta.artist_name || "";
    const trackNo = meta.album_track_number ? String(meta.album_track_number).padStart(2, "0") : null;
    const side = trackNo ? `side a / ${trackNo}` : "side a";
    const cat = catalogNo(item.uri);
    const t = data?.analysis?.track || {};
    const key = t.key >= 0 ? KEYS[t.key] + (t.mode === 1 ? " maj" : " min") : "—";

    setText($(".nd-title"), title);
    setText($(".nd-artist"), artist);
    setText($(".nd-len"), fmtTime(duration() || +meta.duration || 0));
    setText($(".nd-cat"), cat);
    setText($(".nd-side"), side);
    setText($(".nd-bpm"), t.tempo ? Math.round(t.tempo) : "—");
    setText($(".nd-key"), key);
    setText($(".nd-meter"), t.time_signature ? t.time_signature + "/4" : "—");
    setText(c$(".nd-cine-artist"), artist);
    setText(c$(".c-cat"), cat);
    setText(c$(".c-side"), side);
    setText(c$(".c-bpm"), t.tempo ? `${Math.round(t.tempo)} bpm` : "");
    setText(c$(".c-key"), key !== "—" ? `in ${key}` : "");
    setPosterTitle(title);

    if (data?.src) {
      const url = `url("${data.src}")`;
      for (const el of [deck.querySelector(".nd-label"), c$(".nd-cine-disc .nd-label"), c$(".nd-cine-cover")]) {
        if (el.style.backgroundImage !== url) el.style.backgroundImage = url;
      }
    }

    segments = data?.analysis?.segments || [];
    current = data;
    applyAccent();
    scheduleVu();
  }

  // Render the current track atomically: wait for the cache (max 450 ms) so text, cover, color and
  // numbers change together — no "—" flicker, no late-arriving images.
  let renderSeq = 0;
  async function showCurrent() {
    const item = S.Player.data?.item;
    if (!item) {
      setTimeout(showCurrent, 500); // player not ready yet
      return;
    }
    const seq = ++renderSeq;
    const job = prepare(item);
    const timeout = new Promise((r) => setTimeout(() => r("timeout"), 450));
    const first = await Promise.race([job, timeout]);
    if (seq !== renderSeq) return;
    if (first === "timeout") {
      renderTrack(item, null);
      const data = await job;
      if (seq === renderSeq) renderTrack(item, data);
    } else {
      renderTrack(item, first);
    }
    prefetchNext();
  }

  function tickPoster() {
    if (!cineOpen) return;
    setText(c$(".nd-cine-now"), fmtTime(progress()));
    setText(c$(".nd-cine-total"), `of ${fmtTime(duration())}`);
    const bar = `scaleX(${progressPct().toFixed(4)})`;
    const barEl = c$(".nd-cine-bar i");
    if (barEl.style.transform !== bar) barEl.style.transform = bar;
    setText(c$(".nd-play"), isPlaying() ? "pause" : "play");
  }

  function syncPlaying() {
    const playing = isPlaying();
    document.body.classList.toggle("nd-playing", playing);
    spinTarget = playing && !reduced ? 1 : 0;
    rampSpin();
    tickPoster();
    scheduleVu();
    trackArm();
  }

  // Track change: on the poster the record slides into the sleeve & the title drops, content swaps, then back out
  let cueTimer = 0;
  S.Player.addEventListener("songchange", () => {
    cueArm();
    clearTimeout(cueTimer);
    if (!cineOpen || reduced) {
      showCurrent();
      return;
    }
    cine.classList.add("is-cueing");
    cueTimer = setTimeout(async () => {
      await showCurrent();
      requestAnimationFrame(() => cine.classList.remove("is-cueing"));
    }, 520);
  });
  S.Player.addEventListener("onplaypause", syncPlaying);
  // Seeking moves the position without a songchange → resync VU/tonearm from onprogress jumps
  let lastProgress = 0;
  S.Player.addEventListener("onprogress", () => {
    const p = progress();
    if (Math.abs(p - lastProgress) > 2500) {
      scheduleVu();
      trackArm();
    }
    lastProgress = p;
  });

  // ---------- Wallpaper polling ----------

  setInterval(pollWallpaper, 4000);
  addEventListener("focus", pollWallpaper);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    pollWallpaper();
    scheduleVu();
  });

  // Topbar button: ink source = wallpaper color (matches your terminal/compositor) or cover art
  if (S.Topbar?.Button) {
    const ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1.5c2.6 3.1 4.5 5.6 4.5 8a4.5 4.5 0 0 1-9 0c0-2.4 1.9-4.9 4.5-8Zm0 2.4C6.1 6.3 5 8 5 9.5a3 3 0 0 0 6 0C11 8 9.9 6.3 8 3.9Z"/></svg>`;
    const label = () => (inkSource === "wallpaper" ? "Ink: wallpaper" : "Ink: cover art");
    const btn = new S.Topbar.Button(label(), ICON, () => {
      inkSource = inkSource === "wallpaper" ? "cover" : "wallpaper";
      safe(() => localStorage.setItem(INK_KEY, inkSource));
      btn.label = label();
      applyAccent();
    });
  }

  // ---------- Page transitions ----------

  const wipe = document.createElement("div");
  wipe.id = "nd-wipe";
  S.Platform.History.listen(() => {
    const mainView = anchors.main || document.querySelector(".Root__main-view");
    if (!mainView || reduced) return;
    if (wipe.parentElement !== mainView) mainView.append(wipe);
    wipe.animate(
      [
        { transform: "scaleX(0)", opacity: 1 },
        { transform: "scaleX(1)", opacity: 1, offset: 0.55 },
        { transform: "scaleX(1)", opacity: 0 },
      ],
      { duration: 650, easing: EASE }
    );
    requestAnimationFrame(() => {
      document
        .querySelector(".main-view-container__scroll-node-child, .main-view-container__scroll-node > div")
        ?.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], {
          duration: 420,
          easing: EASE,
        });
    });
  });

  // ---------- Section numbering & card stagger ----------

  const numberSections = () => {
    const home = document.querySelector('[data-testid="home-page"]');
    if (!home) return;
    home.querySelectorAll("section h2").forEach((h, i) => {
      const n = String(i + 1).padStart(2, "0");
      if (h.dataset.ndN !== n) h.dataset.ndN = n;
    });
  };

  const indexCard = (card) => {
    const slot = card.parentElement;
    const i = slot?.parentElement ? [...slot.parentElement.children].indexOf(slot) : 0;
    card.dataset.ndI = i;
    card.style.setProperty("--nd-i", Math.max(0, Math.min(i, 10)));
    // Replaces a CSS :has() (expensive as card contents change): artist card = round photo
    if (card.querySelector(".main-cardImage-circular")) card.dataset.ndRound = "";
  };

  // Spotify DOM mutations are batched and processed once per frame
  const pendingNodes = new Set();
  let queued = false;
  function flushMutations() {
    queued = false;
    for (const n of pendingNodes) {
      if (!n.isConnected) continue;
      if (n.matches?.(".main-card-cardContainer:not([data-nd-i])")) indexCard(n);
      n.querySelectorAll?.(".main-card-cardContainer:not([data-nd-i])").forEach(indexCard);
      // Round photos can mount after their card → mark the parent card later
      const round = n.matches?.(".main-cardImage-circular") ? [n] : n.querySelectorAll?.(".main-cardImage-circular") || [];
      for (const r of round) {
        const card = r.closest(".main-card-cardContainer");
        if (card && !("ndRound" in card.dataset)) card.dataset.ndRound = "";
      }
    }
    pendingNodes.clear();
    refreshAnchors();
    numberSections();
  }

  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && !n.closest?.("#nd-deck, #nd-cine, #nd-vu")) pendingNodes.add(n);
    if (!queued && pendingNodes.size) {
      queued = true;
      requestAnimationFrame(flushMutations);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Spotify's full-screen mode is signalled by a class on <html>
  new MutationObserver(refreshAnchors).observe(root, { attributes: true, attributeFilter: ["class"] });

  addEventListener("resize", () => {
    layoutAll();
    fitPosterTitle();
  });
  document.fonts?.ready.then(fitPosterTitle);

  refreshAnchors();
  document.querySelectorAll(".main-card-cardContainer:not([data-nd-i])").forEach(indexCard);
  numberSections();
  pollWallpaper();
  showCurrent();
  syncPlaying();
  cueArm();
})();
