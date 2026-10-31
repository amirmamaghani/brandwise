// AssetHost adapter. An image reference is an http(s) URL (taken as hosted) or an asset id. Assets are inlined for previews; for a real
// send they need a public address, which comes from `publish` once a public bucket or CDN exists (see docs/email-templates.md, section 7).
import type { AssetHost } from "../domain/ports.ts";

export function assetHost(deps: {
  /** Bytes and type of a stored asset, or null when it does not exist. */
  read: (assetId: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;
  /** Copies the asset to the public host and returns its permanent address. Not set until a public bucket exists. */
  publish?: (assetId: string) => Promise<string>;
}): AssetHost {
  return {
    async resolve(asset, forPreview) {
      if (/^https?:\/\//i.test(asset)) return { src: asset, alt: "", hosted: /^https:\/\//i.test(asset) };
      if (deps.publish && !forPreview) return { src: await deps.publish(asset), alt: "", hosted: true };
      const a = await deps.read(asset);
      if (!a) throw new Error(`asset ${asset} does not exist`);
      if (!forPreview) throw new Error(`asset ${asset} has no public address yet: a public bucket or CDN is needed before an e-mail with stored images can be sent (use an https:// address for now)`);
      if (a.bytes.length > 2_000_000) throw new Error(`asset ${asset} is ${Math.round(a.bytes.length / 1e6)} MB: too large for a preview`);
      return { src: `data:${a.mime};base64,${Buffer.from(a.bytes).toString("base64")}`, alt: "", hosted: false };
    },
  };
}
