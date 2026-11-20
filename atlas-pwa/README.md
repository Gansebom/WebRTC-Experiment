# Tanium Atlas PWA

A progressive web app for chatting with **Tanium Atlas** from an iPhone. It works on a
regular iPhone and on a foldable iPhone, on either the outer or the inner screen.

- **Chat** with Atlas. Answers stream in live, and the tools Atlas calls in your
  Tanium environment show as chips under each reply.
- **New pages** (chats) from the ✎ button (outer screen) or **+ New Page** in the sidebar.
- **Previous pages** are listed by date, can be searched, and can be renamed
  or deleted from the **•••** menu.
- **Looks like Atlas**: the same dark navy palette, periwinkle accent, icon rail,
  "Pages" sidebar, slate message bubbles and black composer. Colors are CSS
  variables at the top of `public/styles.css`.
- **Installable**: in Safari, tap Share, then **Add to Home Screen**. It opens full screen
  with its own icon.

## How it works

```
iPhone (PWA)  ──HTTPS──▶  Node server (this repo)  ──▶  Claude API ──MCP──▶  Tanium Atlas MCP server
              passcode    keeps all secrets              MCP connector        https://<domain>-api.cloud.tanium.com/mcp
```

The phone never holds your Tanium or Anthropic credentials. The server keeps them and
uses Claude with the Messages API **MCP connector**, so Claude calls the Atlas MCP
server's tools for live endpoint data. Conversations are stored on the server as JSON
files in `data/conversations/`.

Before any action that would change endpoints, Atlas is told to describe it and ask you
to confirm in the chat. Atlas's own approval guardrails still apply.

## Screen layouts

| Where | Layout |
| --- | --- |
| Regular iPhone, or the outer screen of a foldable | A single chat pane. ☰ (or a swipe from the left edge) opens Pages as a drawer. |
| Inner screen of a foldable, or landscape | Icon rail, Pages sidebar and chat side by side, like Atlas on the desktop |
| A window spanning a fold (Viewport Segments API) | Rail and Pages on one half and the chat on the other, with nothing under the hinge |

The layout switches automatically when you fold or unfold. The composer stays above the
keyboard, and safe areas (notch, Dynamic Island, home indicator) are respected.

## Run it

Requires Node 20.12+.

```bash
cd atlas-pwa
npm install
cp .env.example .env     # fill in APP_PASSCODE, ANTHROPIC_API_KEY, TANIUM_MCP_URL + auth
npm start                # http://localhost:8787
```

**Demo mode** (no keys needed, the replies are simulated): `npm run mock`, passcode `demo`.

### Tanium setup

1. In the Tanium Cloud console, open **Atlas** and copy the **MCP endpoint URL** into `TANIUM_MCP_URL`.
2. For authentication, either
   - put a token in `TANIUM_MCP_TOKEN`, or
   - register an **OAuth client** in Tanium Atlas and set `TANIUM_OAUTH_TOKEN_URL`,
     `TANIUM_OAUTH_CLIENT_ID` and `TANIUM_OAUTH_CLIENT_SECRET`. The server fetches and
     refreshes tokens itself.
3. Give that token or client the **least privilege** you're comfortable with Atlas using
   from a phone. Read-only is a good start.

The MCP connector reaches the Atlas MCP server from Anthropic's cloud, so the endpoint
must be reachable from the internet. Tanium Cloud endpoints are.

### Put it on your phone

iOS only installs PWAs, and only runs service workers, over **HTTPS**. Host the server
behind TLS. Any of these works:

- a reverse proxy (Caddy, nginx) with a certificate, on a host you control
- Tailscale Serve or a Cloudflare Tunnel to a machine running `npm start`

Then open the URL in Safari, enter your passcode, and tap Share, then **Add to Home Screen**.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `APP_PASSCODE` | (required) | Gate for the app and API |
| `ANTHROPIC_API_KEY` | | Claude API key |
| `TANIUM_MCP_URL` | | Atlas MCP endpoint |
| `TANIUM_MCP_TOKEN` or `TANIUM_OAUTH_*` | | MCP auth |
| `ATLAS_MODEL` | `claude-opus-5-5` | Claude model |
| `ATLAS_EFFORT` | `medium` | Thinking depth: `low` is faster and cheaper, `high` is more thorough |
| `PORT` | `8787` | |
| `DATA_DIR` | `./data/conversations` | Where chats are saved |

If Claude declines a request on safety grounds, the server-side **fallback** (`fallbacks: "default"`)
re-runs it on a fallback model, and the reply is marked "Answered by a fallback model".

## Files

```
server/index.js        HTTP API, passcode auth, SSE streaming, static hosting
server/atlas.js        Claude + Tanium Atlas MCP connector (one chat turn)
server/tanium-auth.js  Static token or OAuth client-credentials for the MCP server
server/store.js        JSON-file conversation storage
server/mock.js         Demo mode
public/                The PWA: index.html, styles.css, app.js, md.js, sw.js, manifest, icons
scripts/make-icons.mjs Re-renders the PNG icons from icons/icon.svg (needs Playwright)
```
