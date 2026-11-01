// BrandWise site snippet (optional, MIT): keeps the first and the last campaign touch of a visitor and puts them into hidden form fields,
// so a lead sent to a BrandWise conversion source can be traced to the calendar entry it came from (utm_content, or bw).
// Add it to the pages with forms: <script src="bw-snippet.js" defer></script>. Fields filled when the form has them:
// bw (the entry id), bw_utm_last and bw_utm_first (JSON). It stores nothing about the person and sends nothing anywhere.
(function () {
  var KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content"];
  var q = new URLSearchParams(location.search), touch = {}, any = false;
  KEYS.forEach(function (k) { var v = q.get(k); if (v) { touch[k] = v.slice(0, 120); any = true; } });
  if (q.get("bw")) { touch.bw = q.get("bw").slice(0, 16); any = true; }
  try {
    if (any) {
      touch.at = new Date().toISOString();
      if (!localStorage.getItem("bw_first")) localStorage.setItem("bw_first", JSON.stringify(touch));
      localStorage.setItem("bw_last", JSON.stringify(touch));
    }
  } catch (e) { /* storage blocked: only this page's parameters are used */ }
  function read(key) { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; } }
  function fill() {
    var last = read("bw_last") || (any ? touch : null), first = read("bw_first") || last;
    var set = function (name, value) { document.querySelectorAll('input[name="' + name + '"]').forEach(function (el) { el.value = value; }); };
    if (last) { set("bw", last.bw || last.utm_content || ""); set("bw_utm_last", JSON.stringify(last)); }
    if (first) set("bw_utm_first", JSON.stringify(first));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fill); else fill();
})();
