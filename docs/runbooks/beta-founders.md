# The founders' runbook for the invite-only beta

What the two founders do by hand on a hosted beta: let a tester in, approve their verification, and approve a market.
On the local stack (`docs/runbooks/beta-link.md`) the stack's TEST operators do the last two by themselves; on a host
there are no TEST operators, so the founders do them in the founder console. Every step needs both founders, each
signed in to the console with their own second factor: one asks, the other approves, and the first one runs it. Nobody
approves their own request, and identity refuses a founder deciding their own verification.

Each step names the journey test that drives the same command or clicks against the local stack on every change, so a
step that stops working turns that journey red.

## 1. Let a tester in (issue an invite)

Sign-up on the beta is closed to everyone except an invited list of email addresses.

1. In the beta host's settings for svc-identity, keep `REGISTRATION_OPEN=false` and add the tester's address to
   `REGISTRATION_EMAIL_ALLOWLIST` (comma-separated, any letter case). A value that is not an email address stops identity
   from starting, so a typo never reads as a shut door.
2. Restart svc-identity so it reads the list (`docker compose -f docker-compose.apps.yml up -d svc-identity` on a compose
   host).
3. Send the tester the app's link. They sign up with exactly that address; any other address is refused
   `identity.registration_closed` with "Sign-up is closed right now. Nothing was created."

On the local stack the same restart is
`LOCAL_STACK_IDENTITY_REGISTRATION=closed LOCAL_STACK_IDENTITY_INVITED=<email> node tooling/scripts/local-test-stack.mjs restart identity`.

**Exercised by:** J-identity-01 #1 (`apps/customer/tests/real-app/J-identity-01.pw.mjs`): with sign-up closed and one
address invited, the invited address goes on to the code step and another is refused.

## 2. Approve a tester's verification

The tester asks for a level on **Verification** in the app. Then:

1. Founder A opens the tester's record in the founder console (`/accounts/<user id>`, found by **Search**), the
   **Documents** tab, and opens the case under **Verification cases** (`/accounts/<user id>/kyc/<case id>`).
2. On the case's row, **Open**, type `APPROVE VERIFICATION <first 8 characters of the verification id>` and press
   **Ask a second founder to approve this verification**. Copy the request packet to founder B.
3. Founder B opens the same case row, pastes the packet, checks the summary names the same verification, types the same
   phrase and presses **Approve this request**.
4. Founder A types the phrase again and presses **Run the approved request**. The reply reads "Identity approved
   verification <id> at level <level>". The capabilities the owner maps to that level turn on at once; with no mapping
   set, the approval grants none and the tester's Verification page says so.

**Exercised by:** J-identity-20 #6 (`apps/customer/tests/real-app/J-identity-20.pw.mjs`), with and without a mapping.

## 3. Approve a market

On a host no venue market is listed until two founders list it (the local stack's `TRADE_USER_VENUE_TEST_LISTINGS` seed
is refused outside dev and test).

1. Founder A opens **Markets** (`/trade-ops/markets`), the **Venue markets** section, and in **List a venue market**
   chooses the market and its opening time, writes a reason (12 to 500 characters) and presses **Ask a second founder to
   approve**. The form shows the approval id and the payload hash.
2. Founder B opens **Freezes & approvals** (`/trade-ops/approvals`), enters that approval id and payload hash, presses
   **Approve request** and confirms **Approve**.
3. Founder A, back in the same form, enters the approved request id, presses **Apply the approved change** and confirms
   **Write change**. The market shows from its opening time. A blank opening time is refused by name.

Routing state, our routed-order limits and a scheduled delisting are set the same way, from their own forms in that
section.

**Exercised by:** J-cex-spot-16 #1 (`apps/customer/tests/real-app/J-cex-spot-16.pw.mjs`), and #2, #3, #6 and #8 for the
other forms.
