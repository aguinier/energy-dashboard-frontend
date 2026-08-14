# Published API reference

`v1/openapi.json` is the OpenAPI 3.1 document for the public `/v1` API. It is the
source for reference documentation and for generated clients.

## It is generated, not edited

```
npm run openapi:generate -w server
```

The document is built by `server/src/v1/openapi/spec.ts`, which **imports the
constants it documents** — the 21 production types, the eight forecast types,
the two models, the row cap, the window bound, the horizon ceiling, the
authentication error codes and both source/attribution constants all come from
the modules that implement them. There is no second copy to fall out of date.

Editing `v1/openapi.json` by hand will be reverted by the next generation, and
the drift check will fail in the meantime.

## The drift check

`server/src/v1/openapi/drift.test.ts` runs with the normal test suite
(`npm test -w server`) and fails on four kinds of divergence:

| drift | how it is caught |
|---|---|
| this file is stale — the code changed and nobody regenerated | fresh build compared byte for byte |
| a route exists that the document does not describe | the Express route table vs. the document's `paths` |
| a promised field stopped arriving | `required`, validated against real response bodies |
| a field arrives that nobody documented | `additionalProperties: false`, same bodies |

A fifth is enforced by `tsc`: `spec.ts` carries exhaustiveness assertions, so
adding a value to the `Coverage` or `FreshnessStatus` unions without adding it to
the published enum fails the build.

Two directions are deliberately **not** covered, and the test file says so rather
than implying otherwise: a query parameter the implementation accepts but the
document omits (there is no way to enumerate what a handler reads off
`req.query`), and semantics — that a field means what its description says is not
a shape, and `server/src/v1/routes/v1Contract.test.ts` is what covers that.

## Terms of Service §7.3

Every data series and every catalogue entry carries a `source` block naming the
origin, the licence and the exact attribution line to render. It is **required**
in the schema, not optional, because the promise in §7.3 is that a subscriber can
render CC-BY 4.0 attribution programmatically — and a field that exists in a
response but not in the published contract is a field integrators will not know
to read. The drift check has a block dedicated to it, including a negative
control that deletes the field from a real response and asserts validation
rejects it.

## Three `info` fields are deliberately unset

`info.termsOfService`, `info.license` and `info.contact` are absent while the
ABL-349 gate is open, and the drift check fails if any of them appears —
including via a URL in any other field pointing at one of our draft documents.
Filling `termsOfService` publishes the Terms by reference; `license` asserts
licence terms to every consumer of the document; `contact` publishes an address.
A spec template fills all three in as a matter of course, which is exactly the
failure mode: not a decision to publish, but a default that publishes.

Generating this document, committing it and checking it against the code are all
permitted. Serving it over HTTP or putting it on a docs site is not, and nothing
in `server/src/v1/publicApp.ts` has a route for it.

No absolute server URL is published either. The deployment address is not
settled, and a URL in a published document is one a client hardcodes.
