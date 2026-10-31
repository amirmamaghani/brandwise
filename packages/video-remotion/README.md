# @brandwise/video-remotion

Optional video engine of the BrandWise: renders Remotion projects (a normal Remotion project folder per campaign) to MP4 or PNG, and runs Remotion Studio for them on 127.0.0.1. The plugin calls `render.mjs`; agents and humans use `bb brandwise video ...` (see the plugin skill, section Video).

```
npm install            # in this folder (Chrome Headless Shell, ~170 MB, downloads on the first render)
node render.mjs seed --dir /tmp/my-project
```

**Licence:** Remotion is not open source. It is free for individuals and companies of up to 3 people; larger companies need a Remotion company licence (https://www.remotion.dev/license). H.264 output is not covered by Remotion's patent licence either. That is why this package is separate, private and optional: the rest of the BrandWise works without it.
