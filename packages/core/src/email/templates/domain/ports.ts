// Ports of the template module. Adapters implement them; the domain never knows how.
import type { ResolvedImage } from "./types.ts";

/** Compiles MJML to HTML. */
export interface Renderer {
  compile(mjml: string): Promise<{ html: string; errors: { line: number; message: string }[] }>;
}

/** Turns an image reference into something a rendered e-mail can point at. */
export interface AssetHost {
  /**
   * `asset` is an asset id or an http(s) URL. For a preview an image may be inlined; for a send it must be on a public URL
   * (`hosted` tells which it is, so lint can refuse an e-mail whose images would not load).
   */
  resolve(asset: string, forPreview: boolean): Promise<ResolvedImage & { hosted: boolean }>;
}

/** Takes a picture of an HTML e-mail, so an agent (or a person) can look at it. */
export interface PreviewService {
  /** The whole e-mail from top to bottom at the given width. */
  screenshot(html: string, opts: { width: number }): Promise<Uint8Array>;
}
