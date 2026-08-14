# Payment webhooks: the design, and why there is no code

Companion to the code in this directory. It exists because of a Board ruling
rather than a technical preference:

> **BOARD DECISION 2026-08-12 (LAN-only):** confirmed as PROPOSAL-ONLY for any
> part that needs public reachability — payment webhooks in particular cannot be
> exercised from a LAN-only deployment. Build and test what works locally […];
> write up the webhook/callback path as a design with its assumptions stated, and
> do not attempt to make anything reachable to satisfy it.

So this is a design. **No endpoint is mounted, no route is registered, and
nothing in this repository listens for a provider callback.** The one piece of
the provider seam that exists in code is `provider.ts`, which names the four
operations a real integration would need and implements them locally, in-process,
with no network client.

Source of truth for the constraints is ABL-307 and the ABL-291 §3 infrastructure
gap statement. Where this file and those disagree, those win.

---

## 1. Why a webhook is needed at all

Three facts originate at the payment provider and cannot be derived from anything
we hold:

| Fact | Why we cannot know it otherwise |
|---|---|
| A payment succeeded | We never see the card transaction. The provider's hosted flow does, which is what keeps this system out of PCI scope entirely. |
| A payment failed, or a card expired | Same. The customer's bank told the provider, not us. |
| The customer changed or cancelled a subscription in the provider's portal | The change happens in their UI, not ours. |

The consequence in our model is narrow and specific: these are the events that
should move `billing_subscription_change.status` between `active` and `past_due`,
and they are the only inputs to that column we do not control. Everything else
this system needs — what was metered, what is billable, what a month costs — is
computed from `usage_rollup` and the price book and needs no callback.

## 2. What works today without one, and precisely what it cannot do

`PaymentProvider.fetchSubscription` is a **pull**. A reconciliation run, or a
scheduled job, asks the provider for its current view and compares it with ours.
That is a complete substitute for the *state* half of the problem and no
substitute at all for the *timing* half:

- **What the pull gets right.** Eventual agreement. Every divergence between the
  provider's subscription status and ours is found on the next run, and it is
  found by comparing two authoritative records rather than by trusting a message.
- **What it gets wrong.** Latency, bounded by the polling interval rather than by
  seconds. A failed payment on the 3rd is acted on at the next poll.
- **What it cannot do at all.** Nothing. There is no event in §1 that is
  unobservable by polling — providers expose current subscription state on their
  read API. This matters, because it means the webhook is a **latency
  optimisation and a load reduction**, not a capability we lack.

That conclusion is the single most useful thing in this document, so it is worth
stating flatly: **the LAN-only constraint does not block billing correctness.** It
blocks knowing about a failed payment within seconds instead of within a polling
interval. Given ABL-297 §6.5 — *suspension is never fully automated* — a failed
payment already waits on a human, and a human does not act within seconds.

## 3. The endpoint, if it is ever built

### 3.1 Shape

`POST /billing/webhook`, on the **public app** (`publicApp.ts`), unauthenticated
by API key and authenticated by signature instead.

It must not be mounted on the internal app. ABL-304 made the public surface
structurally separate — `publicAppGraph.test.ts` pins the module graph — and a
callback endpoint is exactly the kind of thing that gets added to "the server"
without noticing which one.

### 3.2 The five properties it must have

1. **Signature verification before anything else.** The provider signs the raw
   body with a shared secret. Verify against the **raw bytes**, before any JSON
   parsing, and reject with `400` on failure. Express's `express.json()` consumes
   the stream, so this endpoint needs `express.raw({ type: 'application/json' })`
   mounted ahead of it — the single most common way this control is silently
   disabled is a body parser registered globally.

2. **A replay window.** The signature header carries a timestamp. Reject anything
   older than five minutes. A signature is valid forever without this, so a
   captured `payment_failed` can be replayed indefinitely.

3. **Idempotency on the provider's event id.** Providers retry on any non-2xx and
   deliver at least once, so the same event arrives twice as a matter of routine.
   The pattern is already in this codebase and should be copied rather than
   reinvented: `usage_events.request_id` is `UNIQUE` and inserts use
   `ON CONFLICT … DO NOTHING`. A `billing_provider_event` table with the provider's
   event id as its primary key, written in the same transaction as the state
   change it causes, gives the same guarantee.

4. **Acknowledge fast, process after.** Return `200` as soon as the event is
   durably recorded; do the state change on the maintenance timer. A provider
   times out in seconds and retries, and a handler that does its work before
   acknowledging turns one slow write into a retry storm.

5. **Order independence.** Webhooks arrive out of order. Every event carries the
   provider's own timestamp, and the handler must apply it as a
   `SubscriptionChange` with `effectiveAt` set from that timestamp — never from
   arrival time. `subscription.ts` already resolves same-instant changes by
   `recordedAt` and derives state by replay, so an out-of-order arrival is
   already correct in the model. This is the one property the current code
   already has.

### 3.3 What it must NOT do

- **Never trust the event body for anything we can compute.** A
  `invoice.payment_succeeded` says an amount was paid; it does not say what the
  amount should have been. The billable figure is ours, from `usage_rollup`, and
  a webhook that overwrote it would make the provider the source of truth for the
  number this whole metering chain exists to protect.
- **Never suspend an account.** ABL-297 §6.5: suspension is never fully
  automated. A `payment_failed` moves the status to `past_due`, which by design
  keeps serving (`subscription.servesTraffic`). Stopping service is `paused`, and
  a person sets that.
- **Never accept an unsigned event, even in test mode.** The test-mode secret is
  a different secret, not an absent one.

## 4. Reachability — the part that is blocked, and its assumptions

Production is LAN-only on QuietlyConfident (192.168.86.36:3001). A webhook needs
a stable public HTTPS URL. The options are ABL-291 §3's and are a Board decision,
not an engineering one; what follows is only what each would mean *for this
endpoint*.

| Option | What it assumes | What it costs this design |
|---|---|---|
| Cloud-deployed read-only replica (ABL-306, parked) | The replica can write subscription state back, or the webhook lands somewhere that can | Splits the write path: the endpoint would need to reach the key-store database, which the replica by definition does not own. Largest change of the three. |
| Edge proxy / tunnel to the LAN host | The tunnel is stable enough that a missed window is not a missed payment event; the provider's retry schedule covers its outages | Smallest change — the endpoint is mounted on the existing public app and the tunnel terminates TLS. Requires the tunnel's ingress IP to be the only thing that can reach the port. |
| Managed hosting of the whole public API | Migrating the API off the LAN entirely | Makes this a non-question, and is far beyond the scope of a webhook. |

**The assumptions this design rests on, stated so they can be challenged:**

1. **Provider retries cover our downtime.** Major providers retry a failed
   delivery for up to three days on a backoff. A LAN host with a tunnel that
   drops for an hour loses nothing. If a provider is chosen whose retry window is
   shorter than our worst plausible outage, the pull in §2 stops being a fallback
   and becomes the primary mechanism.
2. **No customer data crosses the boundary before ABL-349 closes.** A webhook
   payload contains customer identifiers and payment metadata. Mounting this
   endpoint is therefore gated on the same approval as launch, not merely on
   reachability being solved.
3. **The polling fallback is retained even after webhooks work.** Not as
   redundancy for its own sake: a webhook that was never delivered is
   indistinguishable from a customer who did not change anything, and the only
   thing that detects the difference is a periodic comparison against the
   provider's own record.
4. **TLS terminates outside this process.** The public app speaks HTTP and
   assumes something in front of it does TLS. A signature check over a plaintext
   body on a public network verifies integrity but not confidentiality.

## 5. What would change in this directory

For an implementer picking this up later, the seam is deliberately small:

- `provider.ts` — `PaymentProvider` gains nothing. The four operations there are
  already the whole of what we need; a webhook is an inbound path, not a fifth
  method.
- **New:** `webhookEvents.ts` (pure — signature verification, replay window,
  event → `RecordChangeInput` mapping) and a route mounted from `publicApp.ts`.
  The split is the same one the rest of `v1/` uses: the pure half is testable
  without a server, and the composition names the shape.
- **New table:** `billing_provider_event (event_id PRIMARY KEY, received_at,
  type, payload, applied_at)`. Written in the same transaction as the
  `billing_subscription_change` it produces.
- `publicAppGraph.test.ts` — the assertion added by ABL-307, *"reaches no billing
  module at all"*, **would have to be narrowed**, and that is the right place for
  this decision to surface. It should become a named exception for the webhook
  route and the pure event module, and must continue to exclude
  `sqliteBillingStore.ts`, `invoice.ts` and the price book. The public app should
  never be able to price anything.

---

## 6. Status

Design only. Nothing above is implemented, and nothing should be until:

1. The Board approves public exposure under a separate explicit issue
   (ABL-291 §3 hard constraint), **and**
2. ABL-349 closes — subscriber terms published, legal review complete, and live
   payments approved.

Until then the pull in §2 is the whole mechanism, and it is sufficient for
everything except latency.
