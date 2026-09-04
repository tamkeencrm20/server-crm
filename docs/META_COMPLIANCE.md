# Meta Lead Ads — data handling

This note records how the Tamkeen CRM handles data received from Meta Lead
Ads, for the Meta App Review submission and for internal reference.

## What is received

When a person submits one of Tamkeen Training Center's own Lead Ad forms on
Facebook or Instagram, Meta sends a `leadgen` webhook carrying a `leadgen_id`.
The CRM then reads that single lead from the Graph API. The fields read are the
ones the person filled in themselves:

- full name
- phone number
- email address
- requested course
- preferred branch

Everything Meta returns is also stored verbatim in `lead.meta.rawFields` so the
record can be audited against what the person actually submitted.

## What it is used for

Only these four purposes:

1. Contacting the person about the enquiry they submitted.
2. Giving them information about the training courses they asked about.
3. Following up on their enrolment.
4. Improving the quality of Tamkeen's own customer service.

## What it is never used for

- The data is **not sold**.
- The data is **not shared with, transferred to, or made available to any third
  party**, including other training providers, advertisers, or data brokers.
- The data is **not** used to build advertising audiences outside Tamkeen's own
  Meta Business account.
- The data is **not** enriched from, or cross-referenced against, any external
  data source.

## Where it lives

A single MongoDB database owned and operated by Tamkeen Training Center. No
lead record leaves that database except to the CRM's own authenticated
frontend, over HTTPS.

## Who can see it

Access is enforced server-side on every request (`src/middleware/scope.js`):

| Role | Can read |
|---|---|
| Sales agent | only the leads assigned to them |
| Team leader | only the leads of their own branch |
| Admin | all leads |

There is no endpoint that exports leads in bulk to an external destination.

## Security controls

- Webhook deliveries are authenticated with the `X-Hub-Signature-256` HMAC
  computed from the app secret. Unsigned or mis-signed deliveries are rejected
  with 401 (`src/services/meta.service.js`).
- The subscription handshake checks a private verify token.
- Passwords are stored as bcrypt hashes (cost 12), never in plain text.
- Sessions use short-lived access tokens plus rotating, revocable refresh
  tokens stored only as SHA-256 digests.
- Every read of a lead passes through a role scope filter; every write is
  recorded in an append-only activity log.

## Retention and deletion

Lead records are retained while the sales opportunity is active and afterwards
for business record-keeping. To honour a deletion request from a person whose
data was captured, delete their `Lead` document and its `Activity` and
`Assignment` rows; nothing else references them.

Read notifications are deleted automatically after 60 days by a TTL index.

## Applicable law

Processing follows UAE Federal Decree-Law No. 45 of 2021 on the Protection of
Personal Data, and the Meta Platform Terms and Developer Policies.
