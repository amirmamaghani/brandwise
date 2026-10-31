import { Composition } from "remotion";
import PostReel from "./PostReel";

// One <Composition> per video format. defaultProps must hold a default for every prop: renders reject unknown props.
// Put images, audio and video you need in ./public and load them with staticFile("name.png").
export const Root = () => (
  <Composition
    id="post-reel"
    component={PostReel}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={240}
    defaultProps={{
      headline: "YOUR HEADLINE HERE",
      subline: "One supporting sentence that says why it matters.",
      cta: "LEARN MORE",
      imageUrl: "",
      paper: "#FFFFFF",
      ink: "#0A0A0A",
      signal: "#2F5BFF",
    }}
  />
);
