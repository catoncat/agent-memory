// Catty static prototype — showroom navigation only.
// No product logic; this just flips between the three macOS surfaces
// and their states so the static high-fidelity screens can be viewed.

(function () {
  "use strict";

  const surfaces = document.querySelectorAll(".surface");
  const tabs = document.querySelectorAll(".tab");
  const stateGroups = document.querySelectorAll(".states");

  function showSurface(name) {
    surfaces.forEach((s) => s.classList.toggle("active", s.dataset.surface === name));
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.surface === name));
    // contextual state controls: show only the one for this surface
    stateGroups.forEach((g) => g.classList.toggle("show", g.dataset.for === name));
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => showSurface(tab.dataset.surface));
  });

  // state pills (menubar: default/spark/voice, pet: idle/listening/speaking/spark)
  stateGroups.forEach((group) => {
    const surfaceName = group.dataset.for;
    const surface = document.querySelector(`.surface[data-surface="${surfaceName}"]`);
    if (!surface) return;
    const stateClass = surfaceName === "menubar" ? "mb-state" : "pet-state";
    const pills = group.querySelectorAll(".state-pill");
    const blocks = surface.querySelectorAll("." + stateClass);

    pills.forEach((pill) => {
      pill.addEventListener("click", () => {
        pills.forEach((p) => p.classList.toggle("active", p === pill));
        blocks.forEach((b) => {
          b.style.display = b.dataset.state === pill.dataset.state ? "block" : "none";
        });
      });
    });
  });

  // waveform bars — heights lifted verbatim from the design
  document.querySelectorAll("[data-wave]").forEach((el) => {
    const heights = [16, 22, 14, 26, 20, 28, 12, 24, 18, 30, 16, 22, 14, 20, 10, 18];
    heights.forEach((h, i) => {
      const bar = document.createElement("div");
      bar.className = "b";
      bar.style.height = h + "px";
      bar.style.animation = `bar 0.9s ${(i % 6) * 0.08}s var(--ease) infinite`;
      el.appendChild(bar);
    });
  });
})();
