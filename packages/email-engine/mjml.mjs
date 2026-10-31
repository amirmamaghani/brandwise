#!/usr/bin/env node
// Compiles MJML to HTML. Reads the MJML source from stdin, writes {"html": "...", "errors": [{"line", "message"}]} to stdout.
// A process of its own keeps MJML (and its dependency tree) out of the plugin bundle; the core talks to it through the Renderer port.
import mjml2html from "mjml";

let source = "";
for await (const chunk of process.stdin) source += chunk;
try {
  const result = await mjml2html(source, { validationLevel: "soft", keepComments: false });
  process.stdout.write(JSON.stringify({ html: result.html, errors: (result.errors ?? []).map((e) => ({ line: e.line, message: e.formattedMessage ?? e.message })) }));
} catch (cause) {
  process.stdout.write(JSON.stringify({ html: "", errors: [{ line: 0, message: cause instanceof Error ? cause.message : String(cause) }] }));
  process.exitCode = 1;
}
