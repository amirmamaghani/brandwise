# @brandwise/email-engine

Optional engine of the BrandWise e-mail templates: compiles [MJML](https://mjml.io) (MIT) to responsive, inlined HTML. The core never imports it; it starts `mjml.mjs` as a child process (the `Renderer` port in `packages/core/src/email/templates`).

```
npm install            # in this folder
echo '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>' | node mjml.mjs
```

The plugin finds it through the setting `emailEnginePath` (set by `provision.sh apply` when `node_modules` exists here).
