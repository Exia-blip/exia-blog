---
title: How OAuth Device Flow works when your app has no callback URL
published: true
description: Device Flow swaps the browser redirect for a short code the user types. Here is the whole flow, the five error codes that mean different things, and what it actually costs you in security.
tags: oauth, security, webdev, javascript
canonical_url: https://exia.de5.net/p/oauth-device-flow
cover_image:
---

If you have ever run `gh auth login`, you have seen it: the terminal prints `WDJB-MJHT` and asks you to open a URL and type it in. No localhost server, no port forwarding, no `client_secret`. That is the Device Authorization Grant (RFC 8628), usually just called Device Flow.

## What it actually swaps out

Device Flow replaces "the browser redirects back to you" with "the user copies a short code".

The client therefore needs **no publicly reachable callback URL** and **no client_secret**. The authorization result is not pushed back by redirect — the client polls for it with a `device_code`.

That single difference is why it works in CLIs, TVs, router admin panels, and desktop apps with no local HTTP server: in those places a callback URL simply does not exist.

## The three flows, side by side

| Flow | Who receives the result | Callback URL | client_secret | Typical case |
|---|---|---|---|---|
| Authorization Code | Browser redirects to `redirect_uri` | Required, publicly reachable | Required | Normal web login |
| Authorization Code + PKCE | Same, `code_verifier` replaces the secret | Required, custom schemes OK | Not required | Mobile apps, SPAs |
| Device Flow | Client polls | **Not required** | Not required | CLIs, TVs, headless devices |

The first two both assume the authorization server can *push* the result to the client. Device Flow flips the direction: the client *pulls*.

## Five steps, using GitHub's real endpoints

**1. Request a device code**

```bash
curl -X POST https://github.com/login/device/code \
  -H "Accept: application/json" \
  -d "client_id=Iv1.xxxxxxxxxxxx" \
  -d "scope=read:user"
```

```json
{
  "device_code": "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900,
  "interval": 5
}
```

Note that `verification_uri` is the **authorization server's own** address, not your callback. That is the whole trick: the user never leaves the identity provider's site.

**2. Show `user_code` and `verification_uri` to the user**

**3. The user opens the URL on any device and approves**

Your program just sits there. Nothing about this step touches your client.

**4. Poll at `interval`**

```bash
curl -X POST https://github.com/login/oauth/access_token \
  -H "Accept: application/json" \
  -d "client_id=Iv1.xxxxxxxxxxxx" \
  -d "device_code=3584d83530557fdd1f46af8289938c8ef79f9dc5" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:device_code"
```

While the user has not approved yet, you get HTTP **200** with an error field:

```json
{ "error": "authorization_pending" }
```

**5. Get the token**

```json
{ "access_token": "gho_xxxxxxxx", "token_type": "bearer", "scope": "read:user" }
```

## The polling errors do not mean the same thing

| error | Meaning | What to do |
|---|---|---|
| `authorization_pending` | User has not acted yet | Keep polling at `interval` |
| `slow_down` | You are polling too fast | Add 5 seconds to the interval — do **not** retry at the old rate |
| `expired_token` | Device code expired (900s on GitHub) | Restart from step 1 |
| `access_denied` | User declined | Stop, tell the user |
| `incorrect_device_code` | Wrong or already used | Restart from step 1 |

`authorization_pending` returning 200 is the trap: if you branch on `res.ok`, you will treat "still waiting" as success and crash on the missing token.

## How `user_code` and `device_code` find each other

This is the part most articles skip.

- `device_code`: long, random, only ever travels between you and the authorization server. **Never shown to a human.**
- `user_code`: short, readable, typed by the human into a browser.

The authorization server keeps a mapping `user_code → pending device_code`. The user approves the *short* code in their browser; the server writes the approval onto the corresponding *long* code. The next time your client polls with the long code, it picks up its token.

The two sides therefore meet in a table on the server. The client and the browser never talk to each other — which is also why this survives NAT and corporate firewalls.

## A minimal client

```js
async function deviceLogin({ clientId, scope }) {
  const start = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, scope }),
  }).then((r) => r.json());

  console.log(`Open ${start.verification_uri} and enter ${start.user_code}`);

  let interval = start.interval || 5;
  const deadline = Date.now() + (start.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: start.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    }).then((r) => r.json());

    if (res.access_token) return res.access_token;
    if (res.error === 'authorization_pending') continue;
    if (res.error === 'slow_down') { interval += 5; continue; }
    throw new Error(res.error || 'device flow failed');
  }
  throw new Error('expired_token');
}
```

Three things people get wrong: the `grant_type` URN cannot be shortened to `device_code`; `slow_down` means lengthen the interval, not retry; and the loop needs the `expires_in` deadline or it runs forever when the user walks away.

## What it costs you

Device Flow is not "the safer OAuth". It is a **redistribution of risk** for the no-callback case:

1. **The short code is phishable.** An attacker requests a `device_code`, sends the `user_code` to a victim, and talks them into approving it. The victim thinks they are logging in; they are authorizing the attacker's device. The only defense is the consent screen always showing which app wants what — plus the user actually reading it. This is why Device Flow is normally limited to low-risk scopes.
2. **Polling is a natural DoS surface.** The authorization server has to rate-limit it; `slow_down` *is* that rate limit speaking.
3. **The token lands on the client.** No backend to hold it. Fine on a user's own machine, bad anywhere else.
4. **No `client_secret`.** Public clients have no secret; the entire security argument rests on "the user really did approve it in their own browser".

## When to use it

CLIs (`gh auth login` is the canonical example), TVs, car head units, IoT devices, desktop apps that do not want per-platform custom URL schemes, and one-off scripts that should not require a registered redirect URI.

Everything else: if you have a browser and a domain you can configure, use Authorization Code. Making web users copy a code between two tabs is self-inflicted pain.

---

*Originally published at [exia.de5.net](https://exia.de5.net/p/oauth-device-flow?utm_source=devto&utm_medium=post), part 3 of a four-part series on OAuth flows.*
