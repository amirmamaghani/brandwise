import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadArchivo } from "@remotion/google-fonts/Archivo";
import { loadFont as loadNewsreader } from "@remotion/google-fonts/Newsreader";
import { loadFont as loadMono } from "@remotion/google-fonts/GeistMono";

// latin-ext carries the Czech/Slovak diacritics (see docs/brand-system.md)
const archivo = loadArchivo("normal", { weights: ["900"], subsets: ["latin", "latin-ext"] });
const newsreader = loadNewsreader("italic", { weights: ["400"], subsets: ["latin", "latin-ext"] });
const mono = loadMono("normal", { weights: ["500"], subsets: ["latin", "latin-ext"] });

type Props = { headline: string; subline: string; cta: string; imageUrl?: string; paper: string; ink: string; signal: string };

export default function PostReel({ headline, subline, cta, imageUrl, paper, ink, signal }: Props) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const pop = (delay: number) => spring({ frame: frame - delay, fps, config: { damping: 200 } });
  const push = interpolate(frame, [0, durationInFrames], [1, 1.08]);
  const fadeOut = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const lines = headline.toUpperCase().split(" ").reduce<string[]>((acc, w) => {
    const last = acc[acc.length - 1];
    if (last !== undefined && (last + " " + w).length <= 10) acc[acc.length - 1] = last + " " + w;
    else acc.push(w);
    return acc;
  }, []);
  return (
    <AbsoluteFill style={{ backgroundColor: paper, opacity: fadeOut }}>
      {imageUrl ? (
        <AbsoluteFill style={{ transform: `scale(${push})`, top: "46%" }}>
          <Img src={imageUrl} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "right center" }} />
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill style={{ padding: "96px 72px", justifyContent: "flex-start", gap: 28 }}>
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              fontFamily: archivo.fontFamily, fontWeight: 900, fontSize: 190, lineHeight: 0.9, letterSpacing: "-0.04em",
              color: i === 0 ? ink : signal, opacity: pop(i * 6), transform: `translateY(${(1 - pop(i * 6)) * 60}px)`,
            }}
          >
            {line}
          </div>
        ))}
        {subline ? (
          <div style={{ fontFamily: newsreader.fontFamily, fontStyle: "italic", fontSize: 54, lineHeight: 1.15, color: ink, maxWidth: 820, opacity: pop(24), marginTop: 12 }}>
            {subline}
          </div>
        ) : null}
      </AbsoluteFill>
      <div
        style={{
          position: "absolute", left: 72, bottom: 96, backgroundColor: ink, color: paper, borderRadius: 999, padding: "26px 52px",
          fontFamily: mono.fontFamily, fontWeight: 500, fontSize: 40, letterSpacing: "0.06em", opacity: pop(48), transform: `scale(${0.9 + 0.1 * pop(48)})`,
        }}
      >
        {cta}
      </div>
    </AbsoluteFill>
  );
}
