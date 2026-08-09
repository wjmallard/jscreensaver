# Third-party notices

The [MIT license](LICENSE) covers the original work in this repository: the
host application, the tooling, and the JavaScript expression of every port.
The material below is by other authors and keeps its own terms.

## XScreenSaver

The hacks in this collection are adaptations of
[XScreenSaver](https://www.jwz.org/xscreensaver/) hacks, Copyright © 1991-2026
Jamie Zawinski <jwz@jwz.org> and the per-hack authors named in each source
header. The original C and XML sources ship alongside the ports as reference
copies in `hacks/`, notices intact, and the images in `hacks/images/` come
from the XScreenSaver distribution. XScreenSaver's license, from its source
headers:

> Permission to use, copy, modify, distribute, and sell this software and its
> documentation for any purpose is hereby granted without fee, provided that
> the above copyright notice appear in all copies and that both that
> copyright notice and this permission notice appear in supporting
> documentation. No representations are made about the suitability of this
> software for any purpose. It is provided "as is" without express or
> implied warranty.

## Shadertoy shaders

XScreenSaver 6.x bundles a pool of [Shadertoy](https://www.shadertoy.com/)
shaders for its `xshadertoy` driver; the WebGL hacks here port that pool, and
each port keeps the original shader verbatim in an adjacent `.glsl` file whose
header names the title, author, date, and Shadertoy URL. Licenses as declared
by the shader authors:

- **CC0 / public domain** — alienbeacon, batteredplanet, elementalring,
  fluxcore, gimbalharmonics, goldenapollian, logarithmiccircles, neongravity,
  neontriangulator, protophore, selfreflect, skyline, stardome, stripeytorus,
  topologica, trainmandala, truchetzoom
- **MIT** — bestill, darktransit, downfall, hexplasma, noxfire, prococean,
  rigrekt, starnest, trizm, universeball
- **CC BY 3.0** — synthwavecity ("Synthwave City" by 3w36zj6, a reworking of
  "Synthwave" by Jan Mroz, whose license carries to the derivative)
- **driftclouds** ("2D Clouds" by drift) — released by the author's 2024 note
  on the shader's page: usable "in any way that you choose. Credit would be
  nice but I won't insist on it."
- **bubblecolors** ("Bubble Colors" by Matt Vianueva) — the shader header
  states no license; it is reproduced verbatim, with attribution, as bundled
  in XScreenSaver's shader pool.

## three.js

`vendor/three@0.160.0/` — Copyright 2010-2023 Three.js Authors, MIT license.
https://github.com/mrdoob/three.js

## Fonts

The fonts in `hacks/fonts/` are bundled from the XScreenSaver distribution;
provenance follows its `hacks/fonts/Makefile` and each font's embedded
metadata.

- `clacon.ttf` — "Classic Console" by Deejayy (Webdraft Ltd.), a reproduction
  of the MS-DOS VGA console font. Freely redistributable; the embedded
  license record says GPL. http://webdraft.hu/fonts/classic-console/
- `gallant12x22.ttf` — "Gallant", the Solaris console font, converted from
  NetBSD's `gallant12x22.h`, Copyright (c) 1992, 1993 The Regents of the
  University of California. All rights reserved. BSD license:

  > Redistribution and use in source and binary forms, with or without
  > modification, are permitted provided that the following conditions are
  > met:
  > 1. Redistributions of source code must retain the above copyright notice,
  >    this list of conditions and the following disclaimer.
  > 2. Redistributions in binary form must reproduce the above copyright
  >    notice, this list of conditions and the following disclaimer in the
  >    documentation and/or other materials provided with the distribution.
  > 3. Neither the name of the University nor the names of its contributors
  >    may be used to endorse or promote products derived from this software
  >    without specific prior written permission.
  >
  > THIS SOFTWARE IS PROVIDED BY THE REGENTS AND CONTRIBUTORS "AS IS" AND ANY
  > EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
  > WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
  > DISCLAIMED. IN NO EVENT SHALL THE REGENTS OR CONTRIBUTORS BE LIABLE FOR
  > ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
  > DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
  > OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
  > HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
  > STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
  > ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
  > POSSIBILITY OF SUCH DAMAGE.

- `luximr.ttf` — "Luxi Mono", Copyright (c) 2001 Bigelow & Holmes Inc.,
  instructions Copyright (c) 2001 URW++. Distributed under the Luxi font
  license (use and redistribution permitted; the font files themselves may
  not be modified).
- `OCRA.ttf` — OCR-A, the ANSI X3.17 optical-character-recognition font; the
  design is public domain. TTF by Matthew Skala, freely redistributable,
  based on METAFONT code by Richard B. Wales and Tor Lillqvist.
- `SpecialElite.ttf` — "Special Elite" by Brian J. Bonislawsky, Astigmatic
  (AOETI). Apache License 2.0. https://www.apache.org/licenses/LICENSE-2.0
