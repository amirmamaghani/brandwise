/* brandwise.sh: copy chips, menus, reveals, the calendar demo and the band loops. No dependencies. */
(function () {
  "use strict";
  var d = document;
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var hasIO = "IntersectionObserver" in window;
  function $(s, c) { return (c || d).querySelector(s); }
  function $$(s, c) { return Array.prototype.slice.call((c || d).querySelectorAll(s)); }

  /* copy chips: clipboard with a textarea fallback, toast plus a status for screen readers */
  var copyStatus = $("#copy-status");
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, fail) {
      var ta = d.createElement("textarea");
      ta.value = text; ta.readOnly = true; ta.style.cssText = "position:fixed;top:0;opacity:0";
      d.body.appendChild(ta); ta.select();
      try { d.execCommand("copy") ? ok() : fail(); } catch (e) { fail(); }
      ta.remove();
    });
  }
  $$("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var text = b.getAttribute("data-copy");
      function show(ok) {
        $(".toast", b).textContent = ok ? "Copied" : "Copy failed";
        copyStatus.textContent = ok ? "Copied: " + text : "Copy failed";
        b.classList.add("copied");
        clearTimeout(b._t);
        b._t = setTimeout(function () { b.classList.remove("copied"); }, 1500);
      }
      copyText(text).then(function () { show(true); }, function () { show(false); });
    });
  });

  /* nav menus: one open at a time, close on outside press, Escape, focus leaving or a link click */
  var menus = $$("details.menu");
  d.addEventListener("pointerdown", function (e) {
    menus.forEach(function (m) { if (m.open && !m.contains(e.target)) m.open = false; });
  });
  d.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    menus.forEach(function (m) { if (m.open) { m.open = false; $("summary", m).focus(); } });
  });
  menus.forEach(function (m) {
    m.addEventListener("toggle", function () {
      if (m.open) menus.forEach(function (o) { if (o !== m) o.open = false; });
    });
    m.addEventListener("focusout", function (e) {
      if (e.relatedTarget && !m.contains(e.relatedTarget)) m.open = false;
    });
    $$("a", m).forEach(function (a) { a.addEventListener("click", function () { m.open = false; }); });
  });

  /* section reveals: only sections that start below the fold are hidden first */
  if (!reduce && hasIO) {
    var rio = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.remove("pending"); rio.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -12% 0px" });
    $$(".reveal").forEach(function (el) {
      if (el.getBoundingClientRect().top > innerHeight * 0.9) { el.classList.add("pending"); rio.observe(el); }
    });
  }

  /* band loops: the markup is the final frame; each cycle re-renders it so the CSS delays replay */
  $$(".loop").forEach(function (el) {
    if (reduce || !hasIO) return;
    var parts = el.getAttribute("data-loop").split(","), show = +parts[0], fade = +parts[1];
    var html = el.innerHTML, timer = 0, on = false;
    function cycle() {
      el.innerHTML = html;
      el.classList.remove("leaving");
      el.classList.add("playing");
      timer = setTimeout(function () {
        el.classList.add("leaving");
        timer = setTimeout(cycle, fade);
      }, show);
    }
    function start() { if (!on && !d.hidden) { on = true; cycle(); } }
    function stop() { on = false; clearTimeout(timer); el.classList.remove("playing", "leaving"); }
    var visible = false;
    new IntersectionObserver(function (es) {
      visible = es[0].isIntersecting;
      visible ? start() : stop();
    }, { threshold: 0.3 }).observe(el);
    d.addEventListener("visibilitychange", function () { d.hidden ? stop() : visible && start(); });
  });

  /* the calendar demo */
  var demo = $("#demo");
  if (!demo) return;
  var approveBox = $("#approve", demo), faces = $$(".face", demo);
  var statusEl = $("#demo-status");

  function set(k, v) { demo.setAttribute("data-" + k, v); }
  function get(k) { return demo.getAttribute("data-" + k); }
  function face(name) {
    faces.forEach(function (f) {
      var on = f.getAttribute("data-f") === name;
      f.classList.toggle("on", on);
      on ? f.removeAttribute("inert") : f.setAttribute("inert", "");
    });
    approveBox.classList.toggle("attn", name === "news");
  }
  function step(n) { set("step", n); }
  function say(text) { statusEl.textContent = text; }
  /* on narrow screens the week scrolls sideways: bring the day the story is about into view */
  var week = $(".week", demo);
  function showDay(cls) {
    if (week.scrollWidth <= week.clientWidth + 1) return;
    var day = $(".day." + cls, demo);
    var left = day.getBoundingClientRect().left - week.getBoundingClientRect().left + week.scrollLeft - 14;
    week.scrollTo({ left: left, behavior: reduce ? "auto" : "smooth" });
  }
  function currentFace() { var f = $(".face.on", demo); return f ? f.getAttribute("data-f") : ""; }

  /* a tiny clock that only advances while the demo is playing and on screen */
  var queue = [], clock = 0, last = 0, raf = 0, running = false;
  var inView = false, started = false, manual = false;
  function after(ms, fn) { queue.push({ t: clock + ms, fn: fn }); queue.sort(function (a, b) { return a.t - b.t; }); }
  function tick(now) {
    if (!running) return;
    clock += Math.min(now - last, 100); last = now;
    while (queue.length && queue[0].t <= clock) queue.shift().fn();
    raf = requestAnimationFrame(tick);
  }
  function sync() {
    var go = started && inView && !d.hidden;
    demo.classList.toggle("halt", started && !go);
    if (go && !running) { running = true; last = performance.now(); raf = requestAnimationFrame(tick); }
    if (!go && running) { running = false; cancelAnimationFrame(raf); }
  }
  function press(btn) { btn.classList.remove("press"); void btn.offsetWidth; btn.classList.add("press"); }
  function hint(on) { $$('[data-f="news"] .b.p', demo).forEach(function (b) { b.classList.toggle("hint", on); }); }

  function story() {
    queue = []; manual = false; hint(false);
    demo.classList.remove("leaving");
    set("news", "none"); set("teaser", "pend"); face("teaser"); step(1);
    showDay("d2");
    after(600, function () { set("news", "draft"); showDay("d4"); });
    after(2400, function () { set("news", "pend"); step(2); });
    after(3300, function () { face("news"); waitForPerson(); });
  }
  function waitForPerson() {
    if (manual) { hint(true); return; }
    after(4200, function () {
      if (manual || currentFace() !== "news") return;
      var b = $('[data-f="news"] .b.p', demo); press(b); after(300, approveNews);
    });
  }
  function approveNews() {
    hint(false);
    set("news", "ok"); face("ok"); step(3);
    after(1800, function () { face("run"); step(4); });
    after(3300, function () { set("news", "pub"); });
    after(4800, function () { showDay("d2"); face(get("teaser") === "pend" ? "teaser" : get("teaser") === "ok" ? "t-ok" : "t-back"); });
    after(11600, function () { demo.classList.add("leaving"); });
    after(12200, story);
  }
  function sendBackNews() {
    hint(false);
    set("news", "back"); face("back"); step(2);
    after(1800, function () { set("news", "revise"); });
    after(3400, function () { set("news", "pend"); face("news"); waitForPerson(); });
  }
  function teaser(act) {
    if (act === "approve") { set("teaser", "ok"); face("t-ok"); say("Launch teaser reel approved. Instagram has no connector, so it waits as Publish by hand."); }
    else {
      set("teaser", "back"); face("t-back"); say("Launch teaser reel sent back with a change request.");
      if (!reduce) after(2600, function () { if (get("teaser") === "back") { set("teaser", "pend"); if (currentFace() === "t-back") face("teaser"); } });
    }
  }

  demo.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var f = b.closest(".face").getAttribute("data-f"), act = b.getAttribute("data-act");
    if (f === "teaser") { teaser(act); return; }
    manual = true; queue = []; press(b);
    if (act === "approve") { say("November newsletter approved. The scheduler publishes it when it is due."); approveNews(); }
    else { say("November newsletter sent back with a change request."); sendBackNews(); }
    sync();
  });

  if (reduce || !hasIO) { demo.classList.add("built"); return; }

  /* construct the window once it scrolls in, then start the story; pause it off screen */
  var built = false;
  new IntersectionObserver(function (es) {
    inView = es[0].isIntersecting;
    if (inView && !built) {
      built = true;
      story();
      demo.classList.add("building");
      setTimeout(function () { demo.classList.replace("building", "built"); }, 1800);
      setTimeout(function () { started = true; sync(); }, 900);
    }
    sync();
  }, { rootMargin: "0px 0px -20% 0px" }).observe(demo);
  d.addEventListener("visibilitychange", sync);
})();
