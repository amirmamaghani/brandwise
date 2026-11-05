# Channels: connecting the accounts the BrandWise posts to

How a person connects a platform so that approved calendar entries publish themselves there. The design is the connector contract of
`roadmap.md` §2: one connector per network in `packages/core/src/connector-<name>.ts`, one line in `connectorsFrom` (`publish.ts`), the
platform's token as a plugin setting a person enters (agents never see it), and **where** to post as a channel target of the campaign
(`bb brandwise campaign channel set <channel> key=value`, inherited by child campaigns). An entry on a channel whose connector is off,
or whose campaign has no target, waits in the calendar as "Publish by hand" with the command to fix it; a person then posts it in the
app and records where with `bb brandwise calendar published <id> --external <id>`.

Every connected platform has a check command that tells a person what the token can do. Nothing here is asked of an agent: tokens are
entered in Settings or `.env`, targets by the operator.

| Channel | Connector | Token (Settings section) | Target of the campaign | Check |
|---|---|---|---|---|
| `telegram` | `connector-telegram.ts` | Telegram bot token (Telegram) | `telegram chatId=@channel` | post once |
| `email` | `email/` | Resend API key (Telegram section) | `email provider=resend from=... segmentId=...` | `email send-test` |
| `facebook` | `connector-meta.ts` | Meta publish token (Social channels) | `facebook pageId=<page id>` | `meta test` |
| `instagram` | `connector-meta.ts` | the same token | `instagram accountId=<ig user id>` | `meta test` |
| `tiktok` | `connector-tiktok.ts` | TikTok client key and secret (Social channels); the account itself by signing in | set by `tiktok connect` (`openId`, `username`; optional `privacy=`) | `tiktok status` |
| `youtube` | `connector-youtube.ts` | Google OAuth client id and secret (Social channels); the channel by signing in | set by `youtube connect` (`channelId`, `title`; optional `privacy=unlisted`) | `youtube status` |
| `threads` | `connector-threads.ts` | Threads app id and secret (Social channels); the account by signing in | set by `threads connect` (`userId`, `username`) | `threads status` |
| `linkedin` | `connector-linkedin.ts` | LinkedIn client id and secret (Social channels); the member by signing in | set by `linkedin connect` (`personId`, `name`; optional `organizationId`) | `linkedin status` |

Channels without a connector (`web`, `meta_ads`, anything else) wait as "Publish by hand".

Two ways a platform is connected:

- **A token a person pastes** (Telegram, Resend, Meta). The platform issues a long-lived token in its own console; nothing runs on the
  BrandWise.
- **Signing in** (TikTok, YouTube, Threads, LinkedIn). These platforms only hand out tokens through OAuth: `bb brandwise <platform>
  connect --campaign <c>` prints an address, the owner of the account opens it, signs in and allows access, and the platform sends the
  browser back to this plugin's route `/api/v1/plugins/brandwise/http/oauth/<platform>`. The connection (a refresh token, or a 60-day
  token with its dates) is stored encrypted as a setting of that campaign (`<platform>.refreshToken` or `.accessToken`; child campaigns
  inherit it, agents never read it), and the account becomes the campaign's channel target. The return address must be registered in the
  platform's app: Google accepts `http://localhost:<port>/...`, so YouTube needs no public address; TikTok, Threads and LinkedIn accept
  https only, so their return goes through the public address of the short links (`tools/public-test.sh up --links` for a test, a proxy or
  tunnel in production; both forward `/l` and `/oauth/<platform>` to the plugin). The sign-in link is good for ten minutes and for one use.

## Meta: Facebook Page and Instagram

One token covers both channels. It is a **system-user token** of the client's business: it does not expire, it is scoped to the Pages
and Instagram accounts a person assigns to it, and no login flow runs on the BrandWise instance (which stays on loopback).

### What the client needs first

1. A Facebook **Page** of the brand, owned by a Meta **business portfolio** (business.facebook.com; create one if the Page is personal).
2. An Instagram **professional account** (Business or Creator) **linked to that Page**: Instagram app > Settings > Business tools and
   controls > Connect a Facebook Page. Without the link, the Instagram API cannot see the account.
3. Someone with admin rights on the business portfolio, to do the steps below (about 20 minutes).

### Set-up

1. **Create an app** at developers.facebook.com > My Apps > Create app. Type: *Business*; connect it to the business portfolio. Add the
   products *Facebook Login for Business* and *Instagram* (Instagram API with Facebook Login). The app can stay in *Development* mode,
   see "App review" below.
2. **Create a system user**: business.facebook.com > Settings > Users > System users > Add. Role *Employee* is enough; *Admin* if the
   same user will later manage ads.
3. **Assign assets** to the system user: the Page (task *Create content*, or full control) and the Instagram account (*Content*). An
   Instagram account appears here only when it is linked to a Page of the portfolio and added under Accounts > Instagram accounts.
4. **Generate the token**: on the system user, *Generate token* > choose the app > expiry *Never* > permissions
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`. Copy it: Meta
   shows it once.
5. **Give it to the BrandWise**: Settings > Social channels > *Meta publish token*; or `META_PUBLISH_TOKEN=...` in `.env` and
   `infra/bb-instance/provision.sh apply`. The value is stored as a secret; `bb plugin config brandwise` shows `[set]`, never the token.
6. **Check and copy the ids**:

   ```
   bb brandwise meta test
   Token of BrandWise publisher (1234): 1 Page it can post to
     facebook pageId=1098...  Demo Shop   instagram accountId=1784...  @demoshop
   ```

7. **Point the campaign at them** (the brand's always-on campaign; child campaigns inherit):

   ```
   bb brandwise campaign channel set facebook pageId=1098... --campaign "Demo Shop"
   bb brandwise campaign channel set instagram accountId=1784... --campaign "Demo Shop"
   bb brandwise meta test --campaign "Demo Shop"       # ends with "facebook target ...: ok" and "instagram target ...: ok"
   ```

From now on an approved entry on `facebook` or `instagram` is posted when its time comes (the scheduler runs every minute).

### What is published, and how

- **Facebook**: the entry's body as the post text, every link tagged with UTM (`utm_content=<entry id>`) and shortened when short links
  are on; the entry's link is added as the post's link preview. A creative is uploaded from storage: an image as a Page photo (10 MB),
  a video as a Page video (1 GB). The post's own token is fetched from the Page per post, so a token without a role on that Page fails
  with a clear message.
- **Instagram**: a post needs a creative. A **JPEG** image (PNG is refused by Instagram; the error names the file) or a video, published
  as a **Reel** (the only video kind the API still publishes; 3 s to 15 min, MP4 or MOV, 1 GB). The caption is the body with the tagged,
  shortened link appended as text (links in captions are not clickable). Meta fetches the file from the asset's **signed storage URL**,
  so the storage must be reachable from the internet: production S3 or R2 works, the local emulator of `pnpm infra:up` does not
  (Instagram entries fail there with Meta's download error).
- The calendar records the post id and address (`https://www.facebook.com/<post id>`, the Instagram permalink). Metrics of these posts
  are the next step of `analytics.md` (step 6); until then they have no numbers.
- A failed post is retried twice, then shown as Failed with Meta's message, as with every connector.

### App review, limits, revocation

- **No App Review is needed** while the app is in Development mode and the token posts only to assets of the business that owns the
  app: the system user is a member of that business. **Serving other businesses' Pages** needs Advanced Access through App Review and
  Business Verification (screencast, privacy policy, a verified legal entity; typically one to four weeks).
- Instagram allows **100 published posts per 24 hours** per account; Facebook states no fixed number. The connector does not throttle;
  the calendar's limits (`roadmap.md` §3) are the place for a cap.
- System-user tokens do not expire. To revoke: delete the token or the system user in Business Settings, then clear the setting.
- The token travels in a header, never in a URL, and is not written to the calendar or logs.

### Known gaps

- Facebook **Reels** and Instagram **carousels** and **Stories** are not published (a carousel needs several creatives per entry, which the
  calendar does not have yet). Instagram **Trial Reels** (`trial_params`) are possible later for A/B tests.
- Like Telegram, the Graph API has no idempotency key for posts: a crash between "posted" and "recorded" can post twice.

## YouTube

A post is one **video** (any video type, up to 256 GB): the entry's title becomes the video's title (100 characters), the body with its
tagged link the description (5,000 bytes). Privacy is `public` unless the campaign's target says `privacy=unlisted` or `private`. A vertical
video of up to three minutes is shown as a Short by YouTube itself; there is no flag. Google counts uploads in their own quota: **100 a
day** per Google Cloud project, whatever the file size.

### Set-up (once per installation, about 15 minutes)

1. **Google Cloud project**: console.cloud.google.com > New project (any name). APIs & Services > Library > enable **YouTube Data API v3**.
2. **OAuth consent screen** (APIs & Services > OAuth consent screen): user type *External*, app name, support e-mail. Add the scopes
   `youtube.upload` and `youtube.readonly`. Then set the **publishing status to "In production"**: while it is "Testing", Google expires
   every refresh token after seven days and the connection dies weekly. The app stays *unverified*: at sign-in Google shows a warning page
   ("Google hasn't verified this app" > Advanced > Go to ...); that is expected for an app used by one brand. Verification is only needed to
   serve many Google accounts.
3. **Credentials** > Create credentials > OAuth client ID > type **Web application**. Authorised redirect URI, exactly:
   `http://localhost:38896/api/v1/plugins/brandwise/http/oauth/youtube` (38896 is this bb's port, `BW_SERVER_PORT` in
   `infra/bb-instance/profile.env`). Copy the client id and secret into Settings > Social channels (or `YOUTUBE_CLIENT_ID` and
   `YOUTUBE_CLIENT_SECRET` in `.env`, then `provision.sh apply`).

### Connect a channel (per brand)

```
bb brandwise youtube connect --campaign "Demo Shop"
```

Open the printed address **in a browser on the same Mac** (the return address is localhost), sign in with the Google account that owns the
channel, allow access. The page then says the channel is connected; `bb brandwise youtube status --campaign "Demo Shop"` shows it and the
`youtube` target (`channelId`, `title`). To upload unlisted: `bb brandwise campaign channel set youtube channelId=<id> title=<t> privacy=unlisted`.
If the browser is not on the Mac, pass `--redirect <https address of the plugin's /oauth/youtube route>` and register that address too.

Google hands out a refresh token at the first consent only. If `connect` ends with "Google returned no refresh token", remove the app at
myaccount.google.com/permissions and connect again. To disconnect: clear the setting "YouTube channel" on the campaign page (or revoke
the app in the Google account).

## TikTok

A post is one **video** (MP4, MOV or WebM; up to 4 GB and 10 minutes), uploaded in chunks through the **Content Posting API, Direct Post**.
The caption is the body with the tagged, shortened link as text (links in captions are not clickable). Photos need a domain verified with
TikTok (`PULL_FROM_URL`) and are not published yet. TikTok hands out a new refresh token on every refresh; the connector saves it, so the
connection holds as long as the account posts at least once in 180 days.

**The audit.** Until TikTok audits the app (developers.tiktok.com > your app > Content Posting API > audit; takes weeks), **every post
is visible to the account only** (`SELF_ONLY`), and posts made before the audit stay private. `tiktok status` says so when it applies.
The privacy of a post is the target's `privacy=` when the account allows it (`tiktok status` lists what it allows), else the most public
level TikTok offers that account; a `privacy=PUBLIC_TO_EVERYONE` the account cannot have is refused with the reason, nothing is posted.

### Set-up (once per installation, about 15 minutes plus TikTok's review)

1. **App** at developers.tiktok.com > Manage apps > Connect an app. Fill in the basics (name, icon, category, description, terms and
   privacy policy URLs; TikTok reviews these before the app can be used by others).
2. Add the products **Login Kit** and **Content Posting API**; under Content Posting API turn on **Direct Post**. Scopes: `user.info.basic`,
   `video.publish`.
3. **Login Kit > Redirect URI**: `<public address>/oauth/tiktok`, where the public address is the one short links use without its `/l`,
   e.g. `https://deposits-classics-otherwise-receipt.trycloudflare.com/oauth/tiktok` for the test tunnel (it changes at every start of
   the tunnel; a production proxy has a fixed one). TikTok takes https addresses only, up to ten of them.
4. Copy the **client key** and **client secret** into Settings > Social channels (or `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` in
   `.env`, then `provision.sh apply`).
5. While the app is in **sandbox** or unreviewed, TikTok lets only the accounts you add as test users sign in; add the brand's account there.

### Connect an account (per brand)

```
tools/public-test.sh up --links                 # or any public address that forwards /oauth/tiktok to the plugin
bb brandwise tiktok connect --campaign "Demo Shop"
```

The owner of the account opens the printed address (any device), signs in to TikTok, allows access; the page then says the account is
connected. `bb brandwise tiktok status --campaign "Demo Shop"` shows the account, the privacy levels TikTok allows it, the longest video
it may post and the `tiktok` target (`openId`, `username`). To disconnect: clear the setting "TikTok account" on the campaign page.

### Known gaps

- Photo posts, drafts to the inbox (`video.upload`) and the brand-content toggles are not implemented.
- A post TikTok is still processing after two minutes is recorded by its publish id without an address; the address comes with the
  metrics step once the post is public.

## Threads

A post is **text** (500 characters) with the entry's link as a link card, or **one image** (JPEG or PNG, 8 MB) or **one video** (MP4 or
MOV, 1 GB, 5 minutes) with the text as caption. Threads fetches the file from the asset's **signed storage URL**, so, as for Instagram,
the storage must be reachable from the internet (production S3 or R2; not the local emulator). Threads allows 250 posts per account per
24 hours. Threads has no refresh tokens: the connection is a **60-day token** that the connector renews whenever it is at least a day old,
so an account that posts at least once in 60 days stays connected; one that does not is connected again by a person.

### Set-up (once per installation, about 15 minutes)

1. **App** at developers.facebook.com > Create app > use case **Threads API** (a Meta app; it gets its own *Threads app id* and *secret*
   under App settings > Basic, different from the Meta app id).
2. **Redirect Callback URL** (Threads use case > Settings): `<public address>/oauth/threads`, e.g.
   `https://deposits-classics-otherwise-receipt.trycloudflare.com/oauth/threads` for the test tunnel (https only).
3. **Threads tester**: App roles > Roles > Add people > *Threads Tester*: the brand's Threads account. The owner accepts the invitation
   in the Threads app, Settings > Account > **Website permissions**. Without this, sign-in fails while the app is unreviewed.
4. Copy the Threads app id and secret into Settings > Social channels (or `THREADS_APP_ID` and `THREADS_APP_SECRET` in `.env`, then
   `provision.sh apply`).
5. **App Review** is needed only to post for accounts that are not testers of the app (permission `threads_content_publish`, Advanced Access).

### Connect an account (per brand)

```
tools/public-test.sh up --links                  # or any public address that forwards /oauth/threads to the plugin
bb brandwise threads connect --campaign "Demo Shop"
```

The owner opens the printed address, signs in to Threads, allows access; the page then says the account is connected.
`bb brandwise threads status --campaign "Demo Shop"` shows the account, how long the token still has, and the `threads` target
(`userId`, `username`). To disconnect: clear the setting "Threads account" on the campaign page.

## LinkedIn

A post is **text** (3,000 characters) with the entry's link as an article card, or text with **one image** (JPEG, PNG or GIF) or **one
video** (MP4, 75 KB to 500 MB; uploaded in 4 MB parts and processed before posting). Files are uploaded as bytes, so the local storage is
fine. The author is the **member** who signed in. A **company Page** as author (`organizationId` in the target, `w_organization_social`)
needs LinkedIn's Community Management API, which LinkedIn grants per application to registered companies; not covered here yet.
LinkedIn's text has formatting characters (`( ) [ ] { } < > @ | ~ _ *`); the connector escapes them so the text comes out as written.

**Tokens.** LinkedIn access tokens live **60 days**, and refresh tokens are given to approved Marketing Developer Platform partners only.
For an ordinary app the person connects again before the 60 days end; `linkedin status` shows the days left. Every call names the API
month (`Linkedin-Version`, Settings > Social channels, default `202610`); LinkedIn retires a version about a year after its release, so
raise the setting once a year (a retired version answers every call with an error).

### Set-up (once per installation, about 10 minutes)

1. **App** at developer.linkedin.com > Create app: name, the brand's LinkedIn Page (an app must be tied to a Page), logo. Verify the
   Page from the Settings tab (the Page admin confirms).
2. **Products**: request **Share on LinkedIn** (scope `w_member_social`) and **Sign In with LinkedIn using OpenID Connect** (`openid`,
   `profile`). Both are self-serve and granted at once.
3. **Auth > Redirect URLs**: `<public address>/oauth/linkedin` (https only), e.g. the test tunnel's address.
4. Copy the client id and secret into Settings > Social channels (or `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` in `.env`, then
   `provision.sh apply`).

### Connect a member (per brand)

```
bb brandwise linkedin connect --campaign "Demo Shop"
```

The member opens the printed address, signs in, allows access; the page then says the member is connected.
`bb brandwise linkedin status --campaign "Demo Shop"` shows the member, the days the token has left and the `linkedin` target
(`personId`, `name`). To post as a company Page instead, once the app has the Community Management API:
`bb brandwise campaign channel set linkedin personId=<id> organizationId=<page id>`.

### Known gaps

- Company Page authorship (needs the Community Management API), documents and polls, several images per post.
- The member id comes from OpenID Connect's `sub`; the first live post confirms LinkedIn accepts it as `urn:li:person:<sub>`.
