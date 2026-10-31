// The template a new folder starts from: a responsive single-column e-mail with a headline, a rich-text body, one button, an optional
// hero image and a compliant footer. Kept as strings (not files) so it survives bundling into the plugin.
import type { Brand, TemplateConfig } from "./domain/types.ts";

export const SEED_MJML = `<mjml>
  <mj-head>
    <mj-title>{{subject}}</mj-title>
    <mj-preview>{{preheader}}</mj-preview>
    <mj-attributes>
      <mj-all font-family="{{brand.fonts.body}}" />
      <mj-text font-size="16px" line-height="1.55" color="{{brand.colors.text}}" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="{{brand.colors.background}}">
    <mj-section padding="24px 0 8px">
      <mj-column>
        <mj-text align="center" font-size="20px" font-weight="700">{{brand.name}}</mj-text>
      </mj-column>
    </mj-section>
    {{#hero}}
    <mj-section background-color="#ffffff" padding="0">
      <mj-column>
        <mj-image src="{{src}}" alt="{{alt}}" padding="0" />
      </mj-column>
    </mj-section>
    {{/hero}}
    <mj-section background-color="#ffffff" padding="32px 24px">
      <mj-column>
        <mj-text font-size="28px" font-weight="700" line-height="1.2">{{headline}}</mj-text>
        <mj-text>{{{body}}}</mj-text>
        <mj-button href="{{cta_url}}" background-color="{{brand.colors.primary}}" color="#ffffff" border-radius="6px" font-size="16px" font-weight="700" padding="16px 25px 0" align="left">{{cta_label}}</mj-button>
      </mj-column>
    </mj-section>
    <mj-section padding="24px">
      <mj-column>
        <mj-text align="center" font-size="12px" line-height="1.5" color="#6b7280">
          {{brand.footer.company}}<br />{{brand.footer.address}}<br />
          You get this because you subscribed. <a href="[[unsubscribe_url]]" style="color:#6b7280">Unsubscribe</a>
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
`;

export const SEED_CONFIG: TemplateConfig = {
  name: "Announcement",
  slots: {
    subject: { type: "text", required: true, max: 70 },
    preheader: { type: "text", required: true, max: 110 },
    hero: { type: "image" },
    headline: { type: "text", required: true, max: 80 },
    body: { type: "richtext-lite", required: true, max: 2000 },
    cta_label: { type: "text", required: true, max: 30 },
    cta_url: { type: "link", required: true },
  },
};

export const SEED_BRAND: Brand = {
  name: "Your Brand",
  colors: { primary: "#0b57d0", text: "#1f2937", background: "#f3f4f6" },
  fonts: { body: "Helvetica, Arial, sans-serif" },
  footer: { company: "Your Company s.r.o.", address: "Main Street 1, 811 01 Bratislava, Slovakia" },
  allowedLinkDomains: [],
};

export const SEED_SAMPLE = {
  subject: "Three ideas for your October",
  preheader: "Short, concrete and ready to use.",
  headline: "Three ideas for your October",
  body: "<p>Hello [[first_name|there]],</p><p>We picked <b>three ideas</b> you can use this month. Each takes less than an hour.</p><ul><li>Plan one small thing</li><li>Measure the result</li><li>Repeat what worked</li></ul>",
  cta_label: "See the ideas",
  cta_url: "https://example.com/ideas",
};
