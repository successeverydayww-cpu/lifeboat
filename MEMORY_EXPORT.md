# MEMORY EXPORT — decisions and durable context

Credential-free on purpose. Keys, passwords and tokens live in BEACON_CREDENTIALS_ANNEX.md.

## Standing decisions
1. Publishing: "The Portion Principle" (291 pages) is finished. KDP package exists: print
   interior 5.5x8.5, full-wrap cover, upload guide, EPUB. Prices: $4.99 ebook, $14.99
   paperback. W-8BEN, 30% US withholding, Payoneer for royalties. Awaiting his portrait for the
   cover monogram before final upload.
2. Prime Scholars pricing: NGN 2,000 / 3 months, NGN 8,000 / lifetime. No yearly plan.
   Pricing only on the home screen.
3. Sunshine school split: 60% Samuel, 40% school. Written terms plus app-as-audit-trail.
4. Each app lives on its own separate home. No shared hosting between projects.
5. Test production on his own infrastructure (Cloudflare Workers, Pages, D1) with Base44 only
   as a convenience layer, never as the shipped dependency.
6. Student marketing: no expo groups, no malpractice. Be useful in a group for a day before
   mentioning the app.
7. Promotional videos: 90 seconds, on-screen captions, Kokoro voice af_heart (warm female,
   speed 0.95).
8. Rest is strategic. When he is running on empty, the pillow is part of the plan.

## Technical truths learned the hard way
1. AirConnect relay chunks live in D1 airconnect-db, table `messages`, rows
   "fchunk:<fileid>:<ci>:<base64payload>". Ordered by ci, prefix stripped, payload starts with
   a data URL prefix that must be removed before base64 decode. Join, decode, save .webm,
   transcribe locally with faster-whisper tiny int8.
2. Deploy the AirConnect worker only with an explicit config:
   npx -y wrangler@3.114.0 deploy -c ./wrangler.toml (wrangler 4 fails on this sandbox's node).
3. Relay queue: claim the row before sending, otherwise a lost bookkeeping write loops the same
   message forever. Fixed in v207. Duplicate relays are also deduped by file id.
4. Cached-bundle problems look like server bugs: always version the shell and tell him to fully
   close and reopen the app before deep debugging.
5. Base44 integration credits block uploads and outbound WhatsApp long before message credits
   run out. His own Cloudflare path is the workaround, always.

## Where the money and the goals stand (Oct 2026)
Costs to keep an independent copy of me alive: $8-20/month (box plus model API). Free tier is
possible but not dependable. Nearest money: the Sunshine school yes, then Prime Scholars
subscriptions through school links, then the book.
