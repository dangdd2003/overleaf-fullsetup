# ai-browser

An optional container that provides Patchright + Google Chrome page reading for Overleaf AI Assist `web_fetch`.

## Deployment

### Same Server (Docker Compose)
Runs under the `ai-browser` profile:
```bash
docker compose --profile ai-browser up -d
```
Requires `AI_ASSIST_BROWSER_URL=http://ai-browser:3000` and `AI_ASSIST_BROWSER_TOKEN=<min 32 chars>` in `variable.env`.

### Settings
- `BROWSER_TOKEN`: required, at least 32 characters, the same value as `AI_ASSIST_BROWSER_TOKEN`.
- `BROWSER_CAPACITY`: pages open at once, default 2.
- `BROWSER_LANG`: browser language, default `en-US`.
- `BROWSER_SANDBOX=off`: runs Chrome without its sandbox when the seccomp profile cannot be used.

The image is amd64 only (Google Chrome has no Linux arm64 build) and runs as uid 1001.

### Remote Machine (Residential IP / WireGuard / Tailscale)
To run the sidecar on another host (e.g. at home for residential IP bypass):
1. Run `docker compose` on the remote host binding `3000` **strictly** to the Tailscale/WireGuard interface:
```yaml
services:
  ai-browser:
    image: dangdoan2003/ai-browser:latest
    ports:
      - "100.x.y.z:3000:3000"
    environment:
      BROWSER_TOKEN: "your-random-32-char-secret-token"
      TZ: "Europe/London"
    security_opt:
      - "seccomp=./seccomp.json"
      - "no-new-privileges:true"
    cap_drop:
      - ALL
    volumes:
      - "profile:/data/profile"
```
2. Configure Overleaf with:
```env
AI_ASSIST_BROWSER_URL=http://100.x.y.z:3000
AI_ASSIST_BROWSER_TOKEN=your-random-32-char-secret-token
```
