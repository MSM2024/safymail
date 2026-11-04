# Security setup checklist

Before exposing this Worker publicly:

1. Create a Cloudflare Access self-hosted application for the Worker hostname.
2. Configure an allow policy for explicitly invited identities only. Do not use an unrestricted "Everyone" policy.
3. Require a second factor / MFA in the Access policy or the connected identity provider, especially for the superadministrator.
4. Copy the Access application Audience (AUD) tag and team domain into Worker secrets:
   - `ACCESS_TEAM_DOMAIN`
   - `ACCESS_AUD`
5. Apply the D1 migrations, then run `scripts/bootstrap-superadmin.sql` after replacing the UUID and email.
6. Verify that an unlisted identity receives HTTP 403 and a request without a valid Access JWT receives HTTP 401.
7. Keep D1, R2, Resend and Cloudflare API credentials out of the browser and source control.

The application currently maps an Access JWT to a pre-provisioned D1 user by immutable Access subject when configured, otherwise by verified email. Prefer setting `access_subject` once the user's Access identity subject is known. Never provision users automatically from arbitrary requests.

## Data isolation

- Normal users require both a company membership and an explicit account permission.
- API routes must resolve identity from the verified Access assertion, not request-supplied user/company identifiers.
- Attachment download routes must repeat account authorization before reading an R2 object.
- Superadministrator operations must be audited.
- Account suspension is soft suspension; records and messages are retained.

This checklist documents required Cloudflare dashboard policy configuration. It does not claim that MFA or Access application policies are automatically created by the Worker.
