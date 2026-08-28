---
title: Showcase
---

# Showcase

A 108.7-second tour of the interface and the rendering engine, over the real `sub-ernie` SimNIBS
dataset. Neither the video nor the GIF is hand-edited: [`examples/capture/showcase.py`](https://github.com/idossha/tetravox/blob/main/examples/capture/showcase.py)
writes six job documents, the app renders every frame offscreen through the same `Engine` calls a
user makes with the mouse (see [Automation & Python](/automation)), and ffmpeg joins them and burns
the captions. The full storyboard — shot list, timings and the reasoning behind each — is in
[`docs/media/SHOWCASE.md`](https://github.com/idossha/tetravox/blob/main/docs/media/SHOWCASE.md).

<video controls preload="metadata" poster="/shots/layout-1plus3.png">
  <source src="/media/showcase.mp4" type="video/mp4">
  Your browser does not support the video tag — see the GIF below instead.
</video>

## GIF

For anywhere a `<video>` tag doesn't reach:

![Tetravox showcase — a tour of the interface and rendering features](/media/showcase-preview.gif)
