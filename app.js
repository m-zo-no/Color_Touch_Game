(() => {
  "use strict";

  function init() {
    const $ = (id) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`index.html に id="${id}" がありません。`);
      return el;
    };

    const video = $("video");
    const view = $("view");
    const ctx = view.getContext("2d");
    const title = $("title");
    const message = $("message");
    const hint = $("hint");
    const counter = $("counter");
    const targetsEl = $("targets");
    const progress = $("progress");
    const enable = $("enable");
    const next = $("next");
    const reset = $("reset");

    const W = view.width;
    const H = view.height;
    const SW = 300;
    const SH = 360;
    const MIRROR = true;
    const TOTAL = 6;
    const DOUBLE = new Set([3, 6]);

    const COLORS = {
      red: ["赤", "あか", "#d33338", 160, 14],
      blue: ["青", "あお", "#2863c7", 87, 145],
      green: ["緑", "みどり", "#218146", 36, 94],
      yellow: ["黄", "きいろ", "#916400", 15, 42],
    };
    const keys = Object.keys(COLORS);

    function makeCanvas(width, height) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }

    const cameraFrame = makeCanvas(W, H);
    const cameraCtx = cameraFrame.getContext("2d");
    const scan = makeCanvas(SW, SH);
    const scanCtx = scan.getContext("2d", { willReadFrequently: true });

    const gallery = document.createElement("div");
    gallery.hidden = true;
    gallery.style.cssText =
      "width:100%;display:grid;gap:12px;" +
      "grid-template-columns:repeat(auto-fit,minmax(140px,1fr));";
    targetsEl.insertAdjacentElement("afterend", gallery);

    let state = "BOOT";
    let stream = null;
    let raf = 0;
    let pose = null;
    let poseStatus = "idle";
    let audio = null;
    let holdStart = null;
    let lastScan = -Infinity;
    let lastVideoTime = -1;
    let stableBoxes = null;
    let refs = {};
    let question = 0;
    let targets = [];
    let previous = null;
    let correctAt = 0;
    let photoTaken = false;
    let shots = [];
    let particles = [];

    function screen(mode, heading, text, button = "", meter = false) {
      state = mode;
      title.textContent = heading;
      message.textContent = text;
      hint.textContent = "";
      counter.textContent = "";
      targetsEl.replaceChildren();
      targetsEl.hidden = true;
      gallery.hidden = mode !== "FINISH";
      next.textContent = button;
      next.hidden = !button;
      enable.hidden = mode !== "BOOT";
      reset.hidden = mode !== "REGISTER" && mode !== "PLAY";
      progress.hidden = !meter;
      holdStart = null;
      progress.value = 0;
    }

    function held(ok, now, ms) {
      if (!ok) holdStart = null;
      else if (holdStart === null) holdStart = now;

      progress.value = holdStart === null
        ? 0
        : Math.min(1, (now - holdStart) / ms);

      return progress.value >= 1;
    }

    function boot() {
      screen("BOOT", "色をタッチしよう！", "はじめに カメラを オンにしてね");
    }

    function startScreen() {
      screen(
        "START",
        "色をタッチしよう！",
        "ふたりで 肩より上で 手をあわせて 1びょうキープ！",
        "タップして はじめる",
        true
      );
    }

    function register() {
      stableBoxes = null;
      refs = {};
      targets = [];
      previous = null;
      question = 0;
      shots = [];
      gallery.replaceChildren();
      lastScan = -Infinity;
      screen("REGISTER", "マーカーの じどうとうろく",
        "4色のマーカーから 手をはなしてね", "", true);
    }

    function choose(items) {
      return items[Math.floor(Math.random() * items.length)];
    }

    function showQuestion(n) {
      question = n;
      const first = choose(keys.filter((key) => key !== previous));
      previous = first;
      targets = DOUBLE.has(n)
        ? [first, choose(keys.filter((key) => key !== first))]
        : [first];

      screen("PLAY", "色をタッチしよう！",
        targets.length === 2
          ? "ふたりで 1まいずつ。記号を かくしてね！"
          : "プレイヤーに 色をつたえて、記号を かくしてね！",
        "", true);

      counter.textContent = `${n} / ${TOTAL} もん`;
      targetsEl.hidden = false;

      targets.forEach((key, i) => {
        if (i) {
          const and = document.createElement("span");
          and.className = "and";
          and.textContent = "と";
          targetsEl.append(and);
        }
        const [name, reading, color] = COLORS[key];
        const ruby = document.createElement("ruby");
        const rt = document.createElement("rt");
        ruby.textContent = name;
        ruby.style.color = color;
        rt.textContent = reading;
        ruby.append(rt);
        targetsEl.append(ruby);
      });
    }

    function drawCamera() {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const cw = Math.min(vw, vh * W / H);
      const ch = Math.min(vh, vw * H / W);

      cameraCtx.save();
      if (MIRROR) {
        cameraCtx.translate(W, 0);
        cameraCtx.scale(-1, 1);
      }
      cameraCtx.drawImage(
        video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, W, H
      );
      cameraCtx.restore();
      ctx.drawImage(cameraFrame, 0, 0);
    }

    function sample() {
      scanCtx.drawImage(cameraFrame, 0, 0, SW, SH);
      const rgba = scanCtx.getImageData(0, 0, SW, SH).data;
      const gray = new Uint8Array(SW * SH);
      for (let i = 0; i < gray.length; i++) {
        const j = i * 4;
        gray[i] = Math.round(
          0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]
        );
      }
      return { rgba, gray };
    }

    function share(rect, test) {
      const [x, y, r, b] = rect;
      let count = 0;
      for (let yy = y; yy < b; yy++) {
        for (let xx = x; xx < r; xx++) {
          if (test(yy * SW + xx)) count++;
        }
      }
      return count / ((r - x) * (b - y));
    }

    function overlap(a, b) {
      const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
      const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
      const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
      return w * h / Math.min(area(a), area(b));
    }

    function findMarkers({ rgba, gray }) {
      const sat = new Uint8Array(gray.length);
      const hue = new Int16Array(gray.length).fill(-1);
      const options = Object.fromEntries(keys.map((key) => [key, []]));
      const queue = new Int32Array(gray.length);

      for (let i = 0; i < gray.length; i++) {
        const j = i * 4;
        const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
        const max = Math.max(r, g, b);
        const delta = max - Math.min(r, g, b);
        sat[i] = max ? Math.round(255 * delta / max) : 0;
        if (max < 42 || sat[i] < 45) continue;
        const h = max === r ? (g - b) / delta
          : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
        hue[i] = Math.floor((h * 30 + 180) % 180);
      }

      for (const threshold of [65, 90, 115]) {
        const isDark = (i) => gray[i] <= threshold && sat[i] <= 135;
        const todo = Uint8Array.from(gray, (_, i) => Number(isDark(i)));

        for (let seed = 0; seed < todo.length; seed++) {
          if (!todo[seed]) continue;

          let x = SW, y = SH, r = 0, b = 0;
          let head = 0, tail = 1;
          queue[0] = seed;
          todo[seed] = 0;

          function add(i) {
            if (!todo[i]) return;
            todo[i] = 0;
            queue[tail++] = i;
          }

          while (head < tail) {
            const i = queue[head++];
            const px = i % SW;
            const py = Math.floor(i / SW);
            x = Math.min(x, px);
            y = Math.min(y, py);
            r = Math.max(r, px + 1);
            b = Math.max(b, py + 1);
            if (px > 0) add(i - 1);
            if (px + 1 < SW) add(i + 1);
            if (py > 0) add(i - SW);
            if (py + 1 < SH) add(i + SW);
          }

          const w = r - x, h = b - y;
          if (Math.min(w, h) < 8 || w / h < 0.65 || w / h > 1.55 ||
              w * h > 0.10 * gray.length || tail < 0.20 * w * h) continue;

          const rect = [x, y, r, b];
          const white = share(rect, (i) => gray[i] >= threshold + 30 && sat[i] <= 115);
          if (white < 0.10 || white > 0.65) continue;

          const bx = Math.max(1, Math.round(w * 0.12));
          const by = Math.max(1, Math.round(h * 0.12));
          const edges = [
            [x, y, r, y + by], [x, b - by, r, b],
            [x, y, x + bx, b], [r - bx, y, r, b],
          ];
          if (edges.some((edge) => share(edge, isDark) < 0.55)) continue;

          const dx = Math.max(3, Math.round(w * 0.32));
          const dy = Math.max(3, Math.round(h * 0.32));
          if (x < dx || y < dy || r + dx > SW || b + dy > SH) continue;

          const a = Math.floor(w / 5), c = Math.floor(h / 5);
          const strips = [
            [x + a, y - dy, r - a, y - 1],
            [x + a, b + 1, r - a, b + dy],
            [x - dx, y + c, x - 1, b - c],
            [r + 1, y + c, r + dx, b - c],
          ];

          const votes = [];
          for (const key of keys) {
            const [, , , lo, hi] = COLORS[key];
            const parts = strips.map((strip) => share(strip, (i) =>
              hue[i] >= 0 && (lo <= hi
                ? hue[i] >= lo && hue[i] <= hi
                : hue[i] >= lo || hue[i] <= hi)
            ));
            const score = parts.reduce((sum, n) => sum + n, 0) / 4;
            if (Math.min(...parts) >= 0.40 && score >= 0.60) {
              votes.push({ key, score });
            }
          }

          votes.sort((a, b) => b.score - a.score);
          if (votes.length && (votes.length === 1 || votes[0].score - votes[1].score >= 0.12)) {
            options[votes[0].key].push({ rect, score: votes[0].score });
          }
        }
      }

      const result = {};
      for (const key of keys) {
        const unique = [];
        options[key].sort((a, b) => b.score - a.score);
        for (const { rect } of options[key]) {
          if (!unique.some((other) => overlap(rect, other) >= 0.65)) unique.push(rect);
        }
        if (unique.length === 1) result[key] = unique[0];
      }

      return Object.fromEntries(Object.entries(result).filter(([key, rect]) =>
        !Object.entries(result).some(([other, box]) =>
          other !== key && overlap(rect, box) >= 0.65
        )
      ));
    }

    function drawBoxes(boxes) {
      ctx.lineWidth = 4;
      for (const [key, [x, y, r, b]] of Object.entries(boxes)) {
        ctx.strokeStyle = COLORS[key][2];
        ctx.strokeRect(x * W / SW, y * H / SH,
          (r - x) * W / SW, (b - y) * H / SH);
      }
    }

    function calibrate(now) {
      const frame = sample();
      const boxes = findMarkers(frame);
      drawBoxes(boxes);

      const missing = keys.filter((key) => !boxes[key]);
      counter.textContent = `${keys.length - missing.length} / 4 まい`;
      if (missing.length) {
        stableBoxes = null;
        held(false, now, 1000);
        hint.textContent = "さがしている色：" +
          missing.map((key) => COLORS[key][0]).join("・");
        return;
      }

      const nextRefs = {};
      for (const key of keys) {
        const rect = boxes[key];
        const [x, y, r, b] = rect;
        const samples = [];
        for (let yy = y; yy < b; yy++) {
          for (let xx = x; xx < r; xx++) {
            const i = yy * SW + xx;
            samples.push([i, frame.gray[i]]);
          }
        }

        const values = samples.map(([, value]) => value).sort((a, b) => a - b);
        const lo = values[Math.floor(values.length * 0.15)];
        const hi = values[Math.floor(values.length * 0.85)];
        if (hi - lo < 30) {
          stableBoxes = null;
          held(false, now, 1000);
          hint.textContent = "白黒のもようを カメラに見せてね";
          return;
        }
        nextRefs[key] = {
          rect,
          dark: samples.filter(([, value]) => value <= (lo + hi) / 2 - 10),
        };
      }

      const moved = !stableBoxes || keys.some((key) => {
        const old = stableBoxes[key];
        const tol = Math.max(2, 0.15 * Math.min(old[2] - old[0], old[3] - old[1]));
        return boxes[key].some((value, i) => Math.abs(value - old[i]) > tol);
      });

      if (moved) {
        stableBoxes = boxes;
        held(false, now, 1000);
      }
      hint.textContent = "4まい みつけたよ！ そのまま まってね";
      if (held(true, now, 1000)) {
        refs = nextRefs;
        showQuestion(1);
      }
    }

    function covered(gray, key) {
      const { dark } = refs[key];
      let changed = 0;
      for (const [i, old] of dark) {
        if (gray[i] - old >= 30) changed++;
      }
      return dark.length > 0 && changed / dark.length >= 0.50;
    }

    async function loadPose() {
      if (poseStatus !== "idle") return;
      poseStatus = "loading";

      try {
        const base = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304";
        const { FilesetResolver, PoseLandmarker } = await import(`${base}/vision_bundle.mjs`);
        const files = await FilesetResolver.forVisionTasks(`${base}/wasm`);
        pose = await PoseLandmarker.createFromOptions(files, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/" +
              "pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
          },
          runningMode: "VIDEO",
          numPoses: 2,
          minPoseDetectionConfidence: 0.35,
          minPosePresenceConfidence: 0.35,
        });
        poseStatus = "ready";
      } catch (error) {
        poseStatus = "failed";
        console.warn("姿勢推定を読み込めませんでした。", error);
      }
    }

    function playersAt(now) {
      if (!pose) return [];
      try {
        return pose.detectForVideo(cameraFrame, now).landmarks.flatMap((points) => {
          function point(i, threshold) {
            const p = points[i];
            if (!p || p.x < 0 || p.x >= 1 || p.y < 0 || p.y >= 1 ||
                (p.visibility ?? 1) < threshold || (p.presence ?? 1) < threshold) {
              return null;
            }
            return [p.x * W, p.y * H];
          }

          const a = point(11, 0.30), b = point(12, 0.30);
          if (!a || !b) return [];
          return [{
            center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
            hands: [15, 16, 17, 18, 19, 20, 21, 22]
              .map((i) => point(i, 0.25)).filter(Boolean),
          }];
        }).sort((a, b) => a.center[0] - b.center[0]);
      } catch (error) {
        console.warn("姿勢推定を続けられませんでした。", error);
        pose?.close?.();
        pose = null;
        poseStatus = "failed";
        held(false, now, 700);
        return [];
      }
    }

    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const twoPlayers = (p) => p.length === 2 && distance(p[0].center, p[1].center) >= 55;

    function highFive(players) {
      if (!twoPlayers(players)) return false;
      const left = players[0].center[0];
      const right = players[1].center[0];
      const gap = right - left;
      const raised = (p) => p.hands.filter(([x, y]) =>
        x >= left + gap * 0.15 && x <= right - gap * 0.15 &&
        y <= p.center[1] - Math.max(18, gap * 0.08)
      );
      return raised(players[0]).some((a) =>
        raised(players[1]).some((b) => distance(a, b) <= 30)
      );
    }

    function handDistance([px, py], key) {
      const [x, y, r, b] = refs[key].rect;
      return Math.hypot(
        Math.max(x * W / SW - px, 0, px - r * W / SW),
        Math.max(y * H / SH - py, 0, py - b * H / SH)
      );
    }

    function near(players, key) {
      const [x, y, r, b] = refs[key].rect;
      const size = Math.min((r - x) * W / SW, (b - y) * H / SH);
      const margin = Math.max(18, Math.min(32, size * 0.30));
      return players.flatMap((p, i) =>
        p.hands.some((hand) => {
          const d = handDistance(hand, key);
          return d <= margin &&
            keys.every((other) => other === key || handDistance(hand, other) > d);
        }) ? [i] : []
      );
    }

    function play(now) {
      const { gray } = sample();
      const hidden = targets.every((key) => covered(gray, key));
      const players = pose ? playersAt(now) : [];
      const fallback = poseStatus !== "ready";
      let handsOK = true;

      if (!fallback) {
        const candidates = targets.map((key) => near(players, key));
        handsOK = targets.length === 1 ? candidates[0].length > 0
          : twoPlayers(players) &&
            candidates[0].some((a) => candidates[1].some((b) => a !== b));
      }

      const mode = poseStatus === "loading" ? "（姿勢モデルを読み込み中）"
        : fallback ? "（マーカーだけで判定中）" : "";
      hint.textContent = (!hidden ? "白黒のもようを かくしてね"
        : !handsOK ? (targets.length === 2
          ? "ふたりが うつるように、ひとり1まいずつ"
          : "記号に 手を近づけてね")
        : "そのまま キープ！") + mode;

      if (held(hidden && handsOK, now, 700)) correct(now);
    }

    function chime() {
      if (!audio || audio.state !== "running") return;
      [1047, 784, 1047, 784].forEach((frequency, i) => {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const time = audio.currentTime + i * 0.15;
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.001, time);
        gain.gain.exponentialRampToValueAtTime(0.13, time + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.19);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start(time);
        oscillator.stop(time + 0.20);
      });
    }

    function correct(now) {
      correctAt = now;
      photoTaken = false;
      particles = Array.from({ length: 85 }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        speed: 100 + Math.random() * 130,
        size: 6 + Math.random() * 8,
        color: choose(["#ff6487", "#ffc400", "#46bfe9", "#6bcd69", "#b17ce5"]),
      }));
      screen("CORRECT", "せいかい！", "できたね！");
      counter.textContent = `${question} / ${TOTAL} もん`;
      chime();
    }

    function confetti(out, elapsed) {
      for (const bit of particles) {
        out.fillStyle = bit.color;
        out.fillRect(
          bit.x + Math.sin(elapsed * 3 + bit.y) * 15,
          (bit.y + elapsed * bit.speed) % H,
          bit.size, bit.size * 0.7
        );
      }
    }

    function showCorrect(now) {
      const elapsed = (now - correctAt) / 1000;
      confetti(ctx, elapsed);

      if (elapsed >= 0.8 && !photoTaken && DOUBLE.has(question)) {
        const photo = makeCanvas(W, H);
        const out = photo.getContext("2d");
        out.drawImage(cameraFrame, 0, 0);
        confetti(out, elapsed);
        shots.push({ number: question, url: photo.toDataURL("image/png") });
        photoTaken = true;
      }

      if (elapsed >= 2.5) {
        next.textContent = question === TOTAL ? "しゃしんを みる"
          : question === 3 ? "こうたいへ" : "つぎの もんだいへ";
        next.hidden = false;
      }
    }

    function finish() {
      screen("FINISH", "全問正解！", "しゃしんを タップして ほぞんできるよ",
        "もういちど あそぶ");
      gallery.replaceChildren();

      for (const { number, url } of shots) {
        const link = document.createElement("a");
        link.href = url;
        link.download = `color-touch-${number}.png`;
        const img = document.createElement("img");
        img.src = url;
        img.alt = `${number}もんめの きねんしゃしん`;
        img.style.cssText = "width:100%;display:block;border-radius:12px;";
        link.append(img);
        gallery.append(link);
      }

      stopCamera();
    }

    function tick(now) {
      raf = 0;
      if (!stream) return;
      try {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          drawCamera();

          if (state === "CORRECT") {
            showCorrect(now);
          } else if (
            video.currentTime !== lastVideoTime &&
            now - lastScan >= (state === "REGISTER" ? 200 : 90)
          ) {
            lastVideoTime = video.currentTime;
            lastScan = now;

            if (state === "START") {
              if (poseStatus === "ready") {
                hint.textContent = "";
                if (held(highFive(playersAt(now)), now, 1000)) register();
              } else {
                hint.textContent = poseStatus === "loading"
                  ? "姿勢モデルを読み込み中。タップでも はじめられるよ"
                  : "姿勢モデルを使えないため、ボタンで はじめてね";
              }
            } else if (state === "REGISTER") {
              calibrate(now);
            } else if (state === "PLAY") {
              play(now);
            }
          }

          if (state === "REGISTER" && stableBoxes) drawBoxes(stableBoxes);
        }
        if (stream) raf = requestAnimationFrame(tick);
      } catch (error) {
        reportCameraError(error);
      }
    }

    function stopCamera() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      video.srcObject = null;
      ctx.clearRect(0, 0, W, H);
    }

    function reportCameraError(error) {
      stopCamera();
      boot();
      const reason = {
        NotAllowedError: "ブラウザと端末の設定で カメラを許可してね。",
        NotFoundError: "カメラが見つかりません。接続を確認してね。",
        NotReadableError: "カメラを使えません。他のアプリを閉じてから試してね。",
        SecurityError: "localhost または HTTPS で開いてね。",
      }[error.name];

      hint.textContent = reason || `カメラ処理を開始できません：${error.message}`;
      console.error(error);
    }

    async function startCamera() {
      if (enable.disabled || stream) return;
      enable.disabled = true;
      hint.textContent = "カメラを じゅんびしています…";

      try {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (Audio) {
          try {
            audio ??= new Audio();
            audio.resume().catch(() => {});
          } catch (error) {
            console.warn("正解音を準備できませんでした。", error);
          }
        }

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new DOMException("カメラ API を利用できません", "SecurityError");
        }

        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "user" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        const track = stream.getVideoTracks()[0];
        track?.addEventListener("ended", () => {
          if (stream?.getTracks().includes(track)) {
            reportCameraError(new Error("カメラの接続が切れました"));
          }
        }, { once: true });

        video.srcObject = stream;
        await video.play();
        lastVideoTime = -1;
        lastScan = -Infinity;
        startScreen();
        raf = requestAnimationFrame(tick);
        void loadPose();
      } catch (error) {
        reportCameraError(error);
      } finally {
        enable.disabled = false;
      }
    }

    enable.addEventListener("click", startCamera);

    next.addEventListener("click", () => {
      if (state === "START") {
        register();
      } else if (state === "CORRECT" && !next.hidden) {
        if (question === TOTAL) {
          finish();
        } else if (question === 3) {
          screen("SWAP", "こうたい！", "プレイヤー①と②を こうたいしてね",
            "4もんめを はじめる");
        } else {
          showQuestion(question + 1);
        }
      } else if (state === "SWAP") {
        showQuestion(4);
      } else if (state === "FINISH") {
        shots = [];
        gallery.replaceChildren();
        boot();
        void startCamera();
      }
    });

    reset.addEventListener("click", register);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        holdStart = null;
        progress.value = 0;
      }
    });

    window.addEventListener("pagehide", () => {
      stopCamera();
      boot();
    });

    boot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
