// Preloaded (node --import) into Remotion Studio: Studio has no host option and listens on every interface, but it
// can write project files, so force every listener it opens onto 127.0.0.1.
import net from "node:net";
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  if (first !== null && typeof first === "object") args[0] = { ...first, host: "127.0.0.1" };
  else if (typeof first === "number") args = [first, "127.0.0.1", ...args.slice(1).filter((a) => typeof a !== "string")];
  return listen.apply(this, args);
};
