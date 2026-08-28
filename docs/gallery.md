---
layout: page
title: Gallery
permalink: /gallery.html
nav_order: 5
---

# Gallery

18 rendering scenarios captured from the real `sub-ernie` SimNIBS dataset, one per major feature —
volumes, meshes, clipping, isosurfaces, vector glyphs, atlas labels, scenes, and the app's own dialogs.
Generated from [`docs/reports/2026-08-28-visualization-scenarios/`](https://github.com/idossha/tetravox/tree/main/docs/reports/2026-08-28-visualization-scenarios).

<div class="gallery-grid">
{%- for s in site.data.scenarios %}
  <div class="gallery-card">
    <a href="{{ site.baseurl }}/reports/2026-08-28-visualization-scenarios/{{ s.file }}">
      <img src="{{ site.baseurl }}/reports/2026-08-28-visualization-scenarios/{{ s.file }}" alt="{{ s.title | escape }}" loading="lazy">
    </a>
    <div class="gallery-card__body">
      <p class="gallery-card__title">{{ s.title }}</p>
      <p class="gallery-card__text">{{ s.what_it_shows | truncatewords: 42 }}</p>
    </div>
  </div>
{%- endfor %}
</div>
