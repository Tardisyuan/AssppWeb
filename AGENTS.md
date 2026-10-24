# Agent Instructions for AssppWeb

## TypeScript Code Style

- **Indentation**: 2 spaces
- **Semicolons**: Required
- **Quotes**: Single quotes for strings
- **Naming**: PascalCase for types/interfaces, camelCase for variables/functions

## Project Structure

- `backend/` — Node.js/Express server (TypeScript, ESM); tests in `backend/tests/`
- `frontend/` — React SPA (TypeScript, Vite, Tailwind CSS); tests in `frontend/tests/` (not collocated with src)
- `cloudflare/` + `wrangler.jsonc` — Cloudflare Workers + Containers deployment wrapper around the Docker image
- `Dockerfile` / `compose.yml` — single container serves both backend and SPA
- `references/` is gitignored personal infrastructure (never commit); a local ApplePackage checkout may or may not exist

## Architecture — Zero-Trust

The server is a blind TCP proxy. It NEVER sees Apple credentials.

```
┌─ Browser (Client) ─────────────────────────────────┐
│  Credentials (IndexedDB): email, password, cookies, │
│    passwordToken, DSID, deviceIdentifier, pod       │
│                                                      │
│  Apple Protocol (libcurl.js WASM + Mbed TLS 1.3):   │
│    1. Bag fetch → backend proxy → resolve auth URL   │
│       (fallback to default auth endpoint if missing)  │
│    2. Authenticate → get token, cookies, pod         │
│    3. Purchase → acquire license                     │
│    4. Download info → get CDN URL + SINFs + metadata │
│    5. Version listing/lookup                         │
│                                                      │
│  TLS 1.3 encrypted via Wisp protocol over WebSocket  │
└──────────────────────┬───────────────────────────────┘
                       │ Wisp-multiplexed TCP (server cannot read)
┌─ Server (Wisp Proxy) ┴──────────────────────────────┐
│  Wisp server (@mercuryworkshop/wisp-js) on /wisp/    │
│  → multiplexed TCP relay (blind tunnel, no decrypt)  │
│                                                      │
│  Bag proxy: GET /api/bag?guid=<id>                   │
│    - Fetches init.itunes.apple.com/bag.xml via HTTPS │
│    - Returns public Apple service URLs (no creds)    │
│                                                      │
│  After client obtains download info:                 │
│    Client POSTs: { downloadURL, sinfs, metadata }    │
│    - downloadURL = Apple CDN (public, no auth)       │
│    - sinfs = DRM signatures (base64)                 │
│    - iTunesMetadata = app metadata plist (base64)    │
│                                                      │
│  Server downloads IPA from CDN, injects SINFs +      │
│  iTunesMetadata, stores compiled IPA, serves via     │
│  public install URL (itms-services manifest)         │
└──────────────────────────────────────────────────────┘
```

**Key invariant**: The server NEVER sees Apple credentials. All Apple TLS terminates at the browser via libcurl.js WASM (Mbed TLS 1.3). The server only receives public CDN URLs and non-secret metadata for IPA compilation. The bag proxy (`/api/bag`) only returns public Apple service URLs — no credentials pass through it.

## Architecture — SAP Request Signing (X-Apple-ActionSignature)

Apple requires every request to the auth endpoint to carry `X-Apple-ActionSignature: base64(Sign(bodyBytes))`. An unsigned request is answered `403` with an empty body. The signature covers the request body, which contains the password, so signing MUST stay in the browser; the zero-trust invariant is preserved. The setup exchange itself carries no credentials at all, so it can complete before anyone types a password.

`frontend/src/apple/sap/` is a verbatim copy of upstream's TypeScript port (Lakr233/AssppWeb `485be0b`, PR #96), which ports the direct SAP implementation from ApplePackage revision `773583a`. It is pure computation plus Web Crypto — no Apple binaries, no emulator, no backend asset pipeline. Keep it in sync with upstream rather than editing it locally.

```
┌─ Browser ────────────────────────────────────────────────────────┐
│ 1. GET  s.mzstatic.com/sap/setupCert.plist                        │
│         → sign-sap-setup-cert (<data>)                            │
│ 2. createHandshake(certificate) → request bytes                   │
│ 3. POST fpinit.itunes.apple.com/v1/signSapSetup/legacy             │
│         → sign-sap-setup-buffer (<data>)                          │
│ 4. handshake.complete(reply) → SAPSession → createSigner()        │
│ 5. authenticate() signs the exact UTF-8 body bytes and attaches   │
│    X-Apple-ActionSignature                                        │
└──────────────────────────────────────────────────────────────────┘
```

Both setup calls ride the wisp tunnel through `appleRequest`, so the server relays them without reading them.

### Frontend modules (`frontend/src/apple/sap/`)

- `index.ts` — `connectSAP()`: certificate fetch, handshake, setup exchange, signer construction. Hosts are fixed in code; the bag is not consulted for them
- `handshake.ts` — key exchange, producing the `SAPSession` the signer needs
- `signer.ts` — `sign(body)`: builds the blob once, then per call draws an IV from the session RNG, SHA-1s `blob || body`, and runs the two-block cipher. The IV is drawn before the first `await` so concurrent callers cannot reuse one
- `random.ts` / `source.ts` / `cipher.ts` / `f2.ts` — the ported RNG, F1/F2 arithmetic and transforms
- `crypto.ts` — SHA-1, HMAC, AES-CBC via Web Crypto, plus seeded RSA-OAEP encoding
- `tables.ts` / `tables.json` — 219 KB of fixed lookup tables and permutations, verified against pinned sizes and SHA-256 digests on load. No executable code, no private framework, no session or account data
- `bytes.ts` — byte helpers (`concat`, `be32`, `toBase64`, `digest`, `xor`)

### SAP invariants

- The signer sees no credentials: the password reaches it only as the opaque body bytes it signs, and those bytes leave the browser solely inside the auth request through the wisp tunnel
- No unsigned fallback. A setup or signing failure fails the sign-in, because an unsigned request cannot succeed
- One session per page session: `authenticate()` memoizes `connectSAP()` so sign-in attempts and the verification-code step that follows reuse it. A failed setup is not cached. Setup costs two round-trips to Apple and no measurable computation
- `wsProxy` must keep `fpinit.itunes.apple.com` and `s.mzstatic.com` allowed; the setup exchange goes through the tunnel
- The live bag currently returns the legacy `MZFinance` authenticate endpoint, so `normalizeAuthURL` is effectively inert. All three advertised endpoints are in Apple's SAP-signed list, so signing applies regardless

### Container image

Build stages run on `$BUILDPLATFORM` (JS artifacts are platform-independent); the runtime image installs production deps per target platform because `yauzl-promise` → `@node-rs/crc32` ships prebuilt napi binaries per arch, and `bufferutil` (via wisp-js) has no linux-arm64-musl prebuild and compiles from source. That compile runs under QEMU for arm64, so `.github/workflows/docker.yml` pins `tonistiigi/binfmt:qemu-v8.1.5`: the floating `latest` tag shipped an emulator that kills alpine's gcc 15.2 with SIGILL. Published platforms: `linux/amd64`, `linux/arm64`. **linux/386 is out**: official node images dropped it and `@node-rs/crc32` has no linux-ia32 build.
## Reference Implementation

The upstream Swift project ApplePackage is the source of truth for Apple protocol behavior (authentication flow, bag endpoint, pod routing, error codes). A local checkout may live at `references/ApplePackage/`, but `references/` is gitignored — it is **not part of this repository** and may be absent. When unavailable, the field mapping below and the existing `frontend/src/apple/*` implementation are the in-repo reference.

### iTunes API Field Mapping

The backend (`backend/src/routes/search.ts`) maps raw iTunes API fields to our `Software` type, matching the Swift `CodingKeys` in ApplePackage's `Software.swift`:

| iTunes Field                | Software Field |
| --------------------------- | -------------- |
| `trackId`                   | `id`           |
| `bundleId`                  | `bundleID`     |
| `trackName`                 | `name`         |
| `artworkUrl512`             | `artworkUrl`   |
| `currentVersionReleaseDate` | `releaseDate`  |

All other fields (`version`, `price`, `artistName`, `sellerName`, `description`, `averageUserRating`, `userRatingCount`, `screenshotUrls`, `minimumOsVersion`, `fileSizeBytes`, `releaseNotes`, `formattedPrice`, `primaryGenreName`) keep their original names.

The backend also extracts the `results` array from the iTunes wrapper `{ resultCount, results }` before sending to the frontend.

## Per-Account Device Identifiers

Device identifiers are **per-account**, not global:

- Generated as 12 random hex chars (6 bytes) at account creation via `generateDeviceId()`
- Editable during login, immutable after authentication
- Stored in IndexedDB on the `Account` object as `deviceIdentifier`
- Passed to all Apple protocol calls (auth, purchase, download, version listing)

## Pod-Based Host Routing

After authentication, Apple returns a `pod` header:

- Store API: `p{pod}-buy.itunes.apple.com` (default: `p25-buy.itunes.apple.com`)
- Purchase API: `p{pod}-buy.itunes.apple.com` (default: `buy.itunes.apple.com`)
- Pod is stored on the Account object and used for all subsequent API calls
- Functions: `storeAPIHost(pod?)` and `purchaseAPIHost(pod?)` in `frontend/src/apple/config.ts`

## Dynamic Host Validation (Backend)

The Wisp server validates target hosts via `hostname_whitelist` in `backend/src/services/wsProxy.ts`:

- `auth.itunes.apple.com` — bag-resolved auth endpoint
- `buy.itunes.apple.com` — purchase endpoint
- `init.itunes.apple.com` — bag endpoint
- `/^p\d+-buy\.itunes\.apple\.com$/` — pod-based hosts
- `downloaddispatch.itunes.apple.com` — redownload dispatch endpoint (failureType 5002 fallback)
- `fpinit.itunes.apple.com` — SAP setup key exchange
- `s.mzstatic.com` — SAP setup certificate
- Port restricted to `443` only
- Direct IP targets blocked (`allow_direct_ip = false`)
- Loopback IP targets blocked (`allow_loopback_ips = false`)
- Private/reserved resolved IPs allowed (`allow_private_ips = true`) for Docker/OrbStack DNS translation while hostname allowlist remains the primary control

## Bag Proxy (Backend)

The backend proxies the bag endpoint via `GET /api/bag?guid=<deviceId>` using Node.js native HTTPS. It sends Configurator-compatible request headers (`User-Agent`, `Accept: application/xml`). The bag response is public data (Apple service URLs) — no credentials are involved. See `backend/src/routes/bag.ts`.

## Backend

- Express + `@mercuryworkshop/wisp-js` for HTTP and Wisp proxy
- ESM modules (`"type": "module"` in package.json)
- `tsx` for development, `tsc` for production build
- SINF injector also handles optional `iTunesMetadata.plist` injection at IPA root
- Bag proxy for `init.itunes.apple.com`

### Backend Shared Utilities

- `backend/src/utils/route.ts` — shared Express route helpers (`getIdParam`, `requireAccountHash`, `verifyTaskOwnership`)
- `backend/src/config.ts` — centralized constants (`MAX_DOWNLOAD_SIZE`, `DOWNLOAD_TIMEOUT_MS`, `BAG_TIMEOUT_MS`, `BAG_MAX_BYTES`, `MIN_ACCOUNT_HASH_LENGTH`) and env-var config (`disableHttpsRedirect` via `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT`)

## Frontend

- React 19, React Router 7, Zustand for state
- Tailwind CSS 4 for styling
- Vite for build tooling
- IndexedDB for credential storage (via `idb`)
- `libcurl.js` (WASM) for browser-side TLS 1.3 via Mbed TLS — connects through Wisp protocol
- `appleRequest()` in `frontend/src/apple/request.ts` wraps `libcurl.fetch` for all Apple API calls and forces HTTP/1.1 (`_libcurl_http_version: 1.1`)
- Bag endpoint (`frontend/src/apple/bag.ts`) uses backend proxy (`/api/bag`) and falls back to `https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate` when `authenticateAccount` is missing or bag fetch fails
- Authentication (`frontend/src/apple/authenticate.ts`) resolves bag endpoint, then sets `guid` via URL query manipulation to avoid duplicate/malformed query parameters
- Plist build/parse (`frontend/src/apple/plist.ts`) uses native XML builder and browser-native `DOMParser`
- Cookie helper (`frontend/src/apple/cookies.ts`) — `extractAndMergeCookies(rawHeaders, existingCookies)` replaces the repeated extract-and-merge pattern across all Apple protocol files

### Frontend Shared Components (`components/common/`)

- **Alert** — `<Alert type="error|success|warning">` for status messages (replaces inline alert divs)
- **Modal** — `<Modal open={bool} onClose={fn} title={string}>` for dialog overlays
- **Spinner** — inline SVG loading spinner for buttons
- **CountrySelect** — optgroup-based country dropdown with "Available Regions" + "All Regions"
- **AppIcon** — 3 sizes (40/56/80px), rounded corners, letter fallback
- **Badge** — color-coded status pill
- **ProgressBar** — gray track, blue fill, percentage label
- **ToastContainer** / `utils/toast.ts` — toast notifications (incl. account-context helpers)
- **GlobalDownloadNotifier** — global download status notifications
- **icons** — shared SVG icon components (`HomeIcon`, `AccountsIcon`, `SearchIcon`, `DownloadsIcon`, `SettingsIcon`, `SunIcon`, `MoonIcon`, `SystemIcon`) used by Sidebar, MobileNav, and MobileHeader

### Frontend Shared Utilities (`utils/`)

- `utils/error.ts` — `getErrorMessage(e, fallback)` for standardized catch-block error extraction
- `utils/crypto.ts` — AES-GCM encrypt/decrypt for account export/import
- `utils/account.ts` — `accountHash()`, `accountStoreCountry()`, `firstAccountCountry()`
- `utils/toast.ts` — toast helpers (pairs with `ToastContainer`)
- `utils/version.ts` — numeric dot-separated version string comparison

### Import Ordering Convention

1. React / library imports (`useState`, `useNavigate`, `useTranslation`)
2. Layout components (`PageContainer`)
3. Common components (`AppIcon`, `Alert`, `Spinner`, `Modal`, `CountrySelect`)
4. Sibling components within the same feature folder (e.g., `DownloadItem` inside `Download/`)
5. Hooks / stores (`useAccounts`, `useSettingsStore`)
6. Apple protocol / API modules (`authenticate`, `purchaseApp`, `apiPost`)
7. Utilities (`accountHash`, `getErrorMessage`)
8. Config (`countryCodeMap`, `storeIdToCountry`)
9. Types (`type Software`)

**Enforcement**: Every PR must verify import ordering. Common mistakes:

- Putting hooks/stores before layout/common components
- Putting config before utilities
- Putting type imports in the middle instead of last

## Security Model

### Account Hash Is Public

`accountHash` is a SHA-256 of the account email. It is treated as **public, non-secret data** — it identifies which account owns a download but does not grant any privileged access. No authentication is bound to it. This is by design: the server is a blind proxy and does not manage user sessions.

### Trusted Sources

- **Apple API responses** (bag XML, iTunes search results, `customerMessage` fields) are treated as trusted content. No additional sanitization is applied beyond what React's text rendering provides (no `dangerouslySetInnerHTML`).
- **Apple CDN redirects** during IPA download are trusted. The initial URL is validated against `*.apple.com`, and redirect targets from Apple's CDN infrastructure (e.g., Akamai) are followed. The response body is saved to disk — it is never reflected back to the requester.

### Browser as Security Boundary

Credentials (passwords, `passwordToken`, cookies) stored in IndexedDB are protected by the browser's same-origin policy. Encrypting them at rest would be security theater — the decryption key would also live in JS. The threat model assumes the browser environment is trusted; if an attacker has XSS, they can exfiltrate credentials regardless of at-rest encryption.

### Backend Does Not Reflect Request Headers

The settings endpoint (`/api/settings`) must never reflect request headers (`x-forwarded-host`, `host`, etc.) in its response body. Use server-side values only (`config.*`, `process.uptime()`).

## Error Handling

- Early returns to reduce nesting
- `try/catch` for async operations
- Express error middleware for centralized handling
- Type-safe error responses

### Apple Protocol Error Codes

- `2034` / `2042`: Token expired — re-authentication required
- `customerMessage === 'Your password has changed.'`: Password token invalid
- `action.url` ending in `termsPage`: Terms acceptance required (throw with URL)

## Testing

### Unit Tests (Vitest)

```bash
cd backend && npx vitest run    # Node environment; tests in backend/tests/
cd frontend && npx vitest run   # jsdom environment with fake-indexeddb; tests in frontend/tests/
```

Frontend tests mirror the src layout under `frontend/tests/` (`apple/`, `api/`, `store/`, `utils/`) — add new tests there, not next to source files.

There is no E2E suite or lint script in the repo currently. Real-account Docker verification (2026-02-22): authentication succeeds through Wisp, and backend logs contain only connection/stream metadata (no Apple credentials, password tokens, or cookies).

SAP-specific tests:

- `frontend/tests/apple/sap.test.ts` (vitest) — upstream's known-answer vectors plus the synthetic setup certificate and reply in `frontend/tests/apple/fixtures/sap-handshake.json`. No Apple certificate, real account, server-issued session or captured production signature is involved

Test credentials, if ever needed, belong in environment variables (`TEST_EMAIL`, `TEST_PASSWORD`, `TEST_DEVICE_ID`, `TEST_BUNDLE_ID`) and must never be committed.

## Deployment

### Docker Compose (self-host)

```bash
docker compose up -d   # Runs prebuilt image ghcr.io/lakr233/assppweb:latest on port 8080
```

`compose.yml` pulls the published image (no local build), mounts `./mnt/asspp-data:/data` for `DATA_DIR`, and supports `ACCESS_PASSWORD` / `DOWNLOAD_THREADS` env vars. The `Dockerfile` at the repo root is what CI builds and publishes that image.

Single container serves both the Express backend and the Vite-built React SPA. SPA routes are handled by serving `index.html` for all non-API paths.

### Cloudflare Workers + Containers

`wrangler.jsonc` + `cloudflare/src/index.ts` deploy the same Docker image as a Cloudflare Container behind a Worker:

```bash
npx wrangler login
npx wrangler deploy
```

- Requires the Cloudflare Workers **Paid** plan (Containers are not on Free)
- All HTTP/WebSocket traffic routes to one named container instance (`main`) to keep state consistent; `max_instances: 1`
- Container filesystem is **ephemeral** — compiled IPAs are lost when the container stops/sleeps (`sleepAfter = "2h"`)
- Health ping endpoint: `/api/settings`; worker injects `x-forwarded-proto: https` when missing to avoid redirect loops
- `wrangler.jsonc` build command installs `@cloudflare/containers` on the fly, so deploys need no persistent devDependency

`README.md` documents the full deploy matrix (Cloudflare button, Railway with its Cloudflare-proxy TLS caveat, reverse-proxy WebSocket requirements for `/wisp/`).

## Interface Design System

### Intent

**Who**: Developers and power users managing Apple app downloads outside the App Store — sideloading IPAs, managing multiple Apple IDs, tracking licenses. Technical audience, likely running this alongside terminals or Xcode.

**Task**: Authenticate Apple accounts → search apps → acquire licenses → download/compile IPAs → install.

**Feel**: A sharp utility. Precise like a package manager, clear like Apple's developer tools. Confident, quiet, functional. Not playful, not corporate.

### Design Tokens

- **Primary accent**: `blue-600` / `blue-700` (hover) — trust + system authority, echoes Apple dev tooling
- **Backgrounds**: `gray-50` (app), `white` (cards/surfaces)
- **Text**: `gray-900` (primary), `gray-600` (secondary), `gray-400` (tertiary)
- **Borders**: `gray-200` (default), `gray-300` (hover) — use sparingly, prefer background tinting for containment
- **Status badges**: Muted tones — `green` (completed), `blue` (downloading), `yellow` (paused), `purple` (injecting), `red` (failed), `gray` (pending)
- **Alerts**: `red-50`/`red-700` (error), `amber-50`/`amber-700` (warning), `green-50`/`green-700` (success)

### Typography

- System font stack (Inter / SF Pro fallback)
- Weight scale: `500` (medium, workhorse), `600` (semibold, page titles and key labels only). Avoid `700` in body.
- Size scale: `xs` (12px), `sm` (14px), `base` (16px), `lg` (18px), `xl` (20px), `2xl` (24px)

### Spacing

- Base unit: `4px`
- Consistent vertical rhythm: `space-y-4` within sections, `space-y-6` between sections
- Page padding: `px-4 sm:px-6`, `py-6`
- Container: `max-w-5xl` (1024px)

### Depth & Surfaces

- Single elevation: white cards on `gray-50` background
- No shadows. Borders only where they serve function (form inputs, dividers, interactive boundaries)
- Rounded corners: `rounded-lg` (8px) for cards, `rounded-md` (6px) for inputs/buttons, `rounded-full` for badges
- Prefer background tinting (`gray-50` → `gray-100`) over borders for visual containment

### Layout

- Desktop: fixed sidebar (240px / `w-60`) + scrollable main content
- Mobile: bottom tab bar with safe-area padding
- Breakpoint: `md:` (768px) for sidebar ↔ bottom nav switch
- Page structure: `PageContainer` with title + optional action button, then content

### Component Patterns

- **Buttons**: Primary (`bg-blue-600 text-white`), Secondary (`border border-gray-300 text-gray-700`), Danger (`text-red-600 border-red-300`)
- **Inputs**: `rounded-md border-gray-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500`
- **Cards**: White background, `border border-gray-200 rounded-lg`, no shadow
- **Badge**: Color-coded pill (`rounded-full px-2 py-0.5 text-xs font-medium`)
- **ProgressBar**: Gray track, blue fill, percentage label
- **AppIcon**: 3 sizes (40/56/80px), rounded corners, letter fallback
- **Nav active state**: `bg-blue-50 text-blue-700` (sidebar), `text-blue-600` (mobile)

## Frontend Cleanup Rules

These rules prevent the codebase from becoming messy after merging PRs. Enforce them on every change.

### `transition-colors` Usage Policy

**Problem**: `transition-colors` on static containers (cards, sections, alerts, badges) causes visible color flashing when the page loads in dark mode — the element briefly renders in light colors then transitions to dark.

**Rule**: Only use `transition-colors` on **interactive elements** that change color on user interaction:

- Buttons (hover state)
- Links (hover state)
- Form inputs and selects (focus state)
- Nav items (hover/active state)

**Never use `transition-colors` on**:

- Card containers (`bg-white dark:bg-gray-900 rounded-lg border ...`)
- Section wrappers (`<section>` with background)
- Alert/warning banners (use the `<Alert>` component)
- Badge pills
- ProgressBar tracks
- Modal containers
- AppIcon fallback containers
- Empty state placeholder containers

**Exception**: Layout chrome (Sidebar, MobileNav, MobileHeader, PageContainer) may keep `transition-colors duration-200` for smooth theme toggle animation, since these persist across navigations.

### Shared Icons

All navigation and theme icons live in `components/common/icons.tsx`. When Sidebar, MobileNav, or MobileHeader need icons, import from there. Never duplicate icon SVG components inline.

### Import Ordering Verification

Before merging any frontend PR, verify imports follow the convention in every changed file:

```
1. React / library imports
2. Layout components
3. Common components
4. Sibling components (same feature folder)
5. Hooks / stores
6. Apple protocol / API modules
7. Utilities
8. Config
9. Types (always last)
```

### Empty State Containers

Empty states (shown when a list has no items) use a consistent pattern:

- `border-2 border-dashed` (not solid border)
- `bg-gray-50 dark:bg-gray-900/30` background
- No `transition-colors` (removed to prevent dark mode flashing)
- Centered icon in a white circle, title, description, optional CTA button

### Dark Mode Color Pairings

Always pair light and dark variants consistently:

- **Primary text**: `text-gray-900 dark:text-white`
- **Secondary text**: `text-gray-600 dark:text-gray-400` or `text-gray-500 dark:text-gray-400`
- **Tertiary text**: `text-gray-400 dark:text-gray-500`
- **Card background**: `bg-white dark:bg-gray-900`
- **Page background**: `bg-gray-50 dark:bg-gray-950`
- **Card border**: `border-gray-200 dark:border-gray-800`
- **Input border**: `border-gray-300 dark:border-gray-700`

### Code Duplication Prevention

When the same UI pattern appears in 3+ components, extract it to `components/common/`. Current shared components:

- `Alert`, `Modal`, `Spinner`, `CountrySelect`, `AppIcon`, `Badge`, `ProgressBar`, `icons`

When adding new common components, update this AGENTS.md file accordingly.

### Authenticated API Downloads

**Problem**: Plain `<a href="/api/...">` tags and `window.open("/api/...")` make regular browser navigations that cannot carry custom HTTP headers. When `ACCESS_PASSWORD` is set, the `accessAuth` middleware requires an `X-Access-Token` header, so these requests fail with 401.

**Rule**: Never use `<a href>` or `window.open` for `/api/` endpoints that require authentication. Instead, use `fetch()` with `authHeaders()` from `api/client.ts`, then trigger a download via blob URL:

```tsx
const res = await fetch(url, { headers: authHeaders() });
const blob = await res.blob();
const blobUrl = URL.createObjectURL(blob);
const a = document.createElement("a");
a.href = blobUrl;
a.download = filename;
a.click();
URL.revokeObjectURL(blobUrl);
```

**Exceptions**: Routes that the backend explicitly skips auth for (`/auth/*`, `/install/*`) may use plain links — e.g., `itms-services://` install URLs are fine since `/install/*` is public.
